/**
 * The projects screen — shown when no project is open. It creates a project, opens one
 * from the browser's store, brings a bundle or a folder in, and removes a project from
 * this browser. Nothing here is a project edit: each action is a lifecycle operation.
 */
/* lingui-set comment="Interpolated values: action, documents, error, file, folder, name, project, title, words" */

import { select, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { isolate } from '@caotang/i18n';
import type { RuntimeStore } from '@caotang/store';

import { accessibleText } from '../i18n/accessible-text.js';

import { downloadBytes } from '../app/download.js';
import { folderAccessSupported, pickDirectory, type DirectoryHandleLike } from '../app/fs-access.js';
import { folderWithPermission, rememberedFolder } from '../app/folder-memory.js';
import type { FolderDiffersAnswer } from '../app/integrity-model.js';
import { dropHistoryOf } from '../app/history-store.js';
import { clearPending } from '../app/pending-journal.js';
import { browserStorage, clearUnsentCopy } from '../app/unsent-copy.js';
import { encodingAskerFor, type EncodingDecision } from '../app/encoding-review.js';
import {
  answerFolderDiffers,
  completeEncodingReview,
  completeRecovery,
  createProject,
  exportStoredBundle,
  imageDropNotice,
  importBundle,
  listProjects,
  openFolder,
  openElsewhere,
  openProject,
  peekLeaveSuggestion,
  removeProject,
  takeLeaveSuggestion,
  type FolderDiffers,
  type FolderFileChange,
  type OpenOutcome,
  type Opened,
  type PendingEncoding,
  type PendingRecovery,
  type ProjectSummary,
  type RecoveryAnswers,
  type RecoveryOutcome,
  type RecoveryRefusal,
} from '../app/lifecycle.js';
import type { AppServices } from '../app/services.js';
import { ChoiceDialog, ConfirmDialog, EmptyState, documentsLabel, useComposingEnter, wordsLabel } from './shared.js';
import { EncodingDialog } from './EncodingDialog.js';
import { FirstRun } from './FirstRun.js';
import { RecoveryDialog } from './RecoveryDialog.js';
import { Settings, type SettingsSection } from './LazySettings.js';
import './project-rename.css';

/** One lifecycle action, as a token: its busy line and its failure sentence are each one catalogue message. */
type HomeAction =
  | 'creating'
  | 'openingProject'
  | 'makingBundle'
  | 'renamingProject'
  | 'openingFolder'
  | 'importingBundle'
  | 'recovering'
  | 'removing';

/** What the writer reads while an action runs. */
function busyText(action: HomeAction): string {
  switch (action) {
    case 'creating':
      return t`Creating the project`;
    case 'openingProject':
      return t`Opening the project`;
    case 'makingBundle':
      return t`Making the bundle`;
    case 'renamingProject':
      return t`Renaming the project`;
    case 'openingFolder':
      return t`Opening the folder`;
    case 'importingBundle':
      return t`Importing the bundle`;
    case 'recovering':
      return t`Recovering the project`;
    case 'removing':
      return t`Removing the project`;
  }
}

/** What the writer reads when an action fails: the action's own name is inside the sentence, not glued to it. */
function failedText(action: HomeAction, error: string): string {
  return t`${select(action, {
    creating: 'Creating the project',
    openingProject: 'Opening the project',
    makingBundle: 'Making the bundle',
    renamingProject: 'Renaming the project',
    openingFolder: 'Opening the folder',
    importingBundle: 'Importing the bundle',
    recovering: 'Recovering the project',
    removing: 'Removing the project',
    other: 'That action',
  })} did not finish: ${{ error }}`;
}

export interface HomeProps {
  readonly store: RuntimeStore;
  readonly services: AppServices;
  readonly onOpened: (opened: Opened) => void;
  /** Starts a demo run: a sample project, with the intent submitted in its agent panel. */
  readonly onRunDemo: (intent: string) => void;
  /** What the start-up or the last action could not do, for the writer to read. */
  readonly notices: readonly string[];
}

export function Home({ store, services, onOpened, onRunDemo, notices }: HomeProps): ReactNode {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<HomeAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ProjectSummary | null>(null);
  // The project whose name is being changed from this list, and the name as typed so far. Nothing is written until Save.
  const [renaming, setRenaming] = useState<{ readonly id: string; readonly text: string } | null>(null);
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  // Both forms here submit on Enter (ui-modules §2.5): the mark from the keydown keeps a composing Enter from creating or renaming.
  const newProjectIme = useComposingEnter();
  const renameIme = useComposingEnter();
  // A folder or bundle whose project file will not load, offered its recovery: nothing is written until the writer says yes.
  const [recovery, setRecovery] = useState<PendingRecovery | null>(null);
  // Why the writer's last accept of that recovery was refused, with nothing written, and the files named when a file was the reason: the
  // dialog stays open and says so.
  const [recoveryRefusal, setRecoveryRefusal] = useState<{ readonly reason: RecoveryRefusal; readonly files: readonly FolderFileChange[] } | null>(
    null,
  );
  // A project left with changes the writer has no copy of: suggested once, here, as a bundle (project-format §8). The suggestion is
  // read in the render and taken once it is on screen, so the render itself has no side effect.
  const [suggestion, setSuggestion] = useState(peekLeaveSuggestion);
  useEffect(() => {
    takeLeaveSuggestion();
  }, []);
  // A folder whose project this browser keeps in another version: the writer chooses which to keep before anything opens.
  const [differs, setDiffers] = useState<FolderDiffers | null>(null);
  // A folder, bundle or accepted recovery holding files that are not UTF-8 text: the writer previews and answers for each
  // before the open finishes (`completeEncodingReview`).
  const [encoding, setEncoding] = useState<PendingEncoding | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const folderSupported = folderAccessSupported();
  // The folder each project remembers (folder-memory.ts), read with the list, so a reopen asks for permission straight from its click.
  const [folders, setFolders] = useState<ReadonlyMap<string, DirectoryHandleLike>>(new Map());
  useEffect(() => {
    if (!folderSupported || projects === null) return;
    let alive = true;
    void Promise.all(projects.map(async (project) => [project.id, await rememberedFolder(project.id)] as const)).then((pairs) => {
      if (!alive) return;
      const found = new Map<string, DirectoryHandleLike>();
      for (const [id, folder] of pairs) if (folder !== null) found.set(id, folder);
      setFolders(found);
    });
    return () => {
      alive = false;
    };
  }, [folderSupported, projects]);
  const current = useSyncExternalStore(services.settings.subscribe, services.settings.current);
  const showFirstRun = !current.firstRun.dismissed;

  // Reload after a change, from an event handler.
  const refresh = useCallback(async (): Promise<void> => {
    try {
      setProjects(await listProjects(store));
    } catch (failure) {
      setError(t`Your projects could not be listed: ${{ error: errorText(failure) }}`);
      setProjects([]);
    }
  }, [store]);

  // The first load is a subscription: it reports back only when the store answers, and a
  // store that unmounts first is ignored.
  useEffect(() => {
    let alive = true;
    listProjects(store).then(
      (list) => {
        if (alive) setProjects(list);
      },
      (failure: unknown) => {
        if (!alive) return;
        setError(t`Your projects could not be listed: ${{ error: errorText(failure) }}`);
        setProjects([]);
      },
    );
    return () => {
      alive = false;
    };
  }, [store]);

  /** Run one lifecycle action with the busy and error state every button shares. */
  const run = async (action: HomeAction, work: () => Promise<void>): Promise<void> => {
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (failure) {
      setError(failedText(action, errorText(failure)));
    } finally {
      setBusy(null);
    }
  };

  const create = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (newProjectIme.takesSubmit()) return;
    void run('creating', async () => {
      const session = await createProject(store, name);
      setName('');
      onOpened({ session, notices: [], droppedFields: [], copiedFrom: null });
    });
  };

  const open = (projectId: string): void => {
    void run('openingProject', async () => {
      const session = await openProject(store, projectId);
      onOpened({ session, notices: imageDropNotice(session), droppedFields: [], copiedFrom: null });
    });
  };

  const exportOne = (projectId: string, title: string): void => {
    void run('makingBundle', async () => {
      const bundle = await exportStoredBundle(store, projectId);
      downloadBytes(bundle.bytes, bundle.filename);
      setNotice([t`Exported “${{ title: isolate(title) }}” as ${{ file: bundle.filename }}.`, ...bundle.notices].join(' '));
    });
  };

  /**
   * Renames a project from this list. The project is opened for the one command, so the rename is the bus's own `project.rename`
   * (validated, logged and saved as the toolbar's rename is), and the project is closed again before the list is read. The
   * session's undo history goes with it, so the list offers no Undo; renaming again does the same job.
   */
  const renameProject = (projectId: string, title: string): void => {
    void run('renamingProject', async () => {
      const session = await openProject(store, projectId);
      try {
        const result = session.dispatch('project.rename', { title });
        if (!result.ok) throw new Error(result.error.message);
        await session.settle();
      } finally {
        await session.close();
      }
      setRenaming(null);
      setNotice(t`Renamed the project to “${{ title: isolate(title.trim()) }}”.`);
      await refresh();
    });
  };

  /** A folder or bundle either opens, is offered its recovery first, asks which version to keep, or pauses on non-UTF-8 files (`OpenOutcome`). */
  const settleOpen = (outcome: OpenOutcome): void => {
    if (outcome.kind === 'recover') setRecovery(outcome.recovery);
    else if (outcome.kind === 'differs') setDiffers(outcome.differs);
    else if (outcome.kind === 'encoding') setEncoding(outcome.encoding);
    else onOpened(outcome.opened);
  };

  /**
   * The writer answered for each non-UTF-8 file: the answers are applied and the open continues (`completeEncodingReview`
   * can itself come back with a recovery to offer, or a version question to ask, so it settles the same way).
   */
  const answerEncoding = (decisions: readonly EncodingDecision[]): void => {
    if (encoding === null) return;
    const target = encoding;
    setEncoding(null);
    void run('openingProject', async () => {
      settleOpen(await completeEncodingReview(store, target, decisions));
    });
  };

  const cancelEncoding = (): void => {
    if (encoding === null) return;
    // An accepted recovery has already written by the time it pauses; its own note says so. Anything else changed nothing.
    const note = encoding.cancelNote;
    setEncoding(null);
    setNotice(note === '' ? t`Nothing was opened or changed.` : note);
  };

  /**
   * "Reopen folder": one click opens the folder the project remembers. The browser is asked for permission from the click itself, which is
   * the gesture it needs. When the writer says no, or the folder is gone, the folder picker opens instead, so the writer can find it.
   */
  const reopenFolder = (remembered: DirectoryHandleLike): void => {
    void run('openingFolder', async () => {
      let folder = await folderWithPermission(remembered);
      if (folder === null) {
        try {
          folder = await pickDirectory('readwrite');
        } catch {
          // The browser opens its picker only straight from a click, and the permission prompt may have used that click up.
          setNotice(t`Caotang could not reach the folder it remembers. Choose Open a folder… to find it.`);
          return;
        }
      }
      if (folder === null) return;
      settleOpen(await openFolder(store, folder));
    });
  };

  /** The writer's answer to the question a differing folder asks. */
  const answerDiffers = (answer: FolderDiffersAnswer): void => {
    if (differs === null) return;
    const target = differs;
    setDiffers(null);
    void run('openingFolder', async () => {
      onOpened(await answerFolderDiffers(store, target, answer));
    });
  };

  const importFile = (file: File): void => {
    void run('importingBundle', async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      settleOpen(await importBundle(store, bytes, file.name));
    });
  };

  const openFolderAction = (): void => {
    void run('openingFolder', async () => {
      const folder = await pickDirectory('readwrite');
      if (folder === null) return;
      settleOpen(await openFolder(store, folder));
    });
  };

  /**
   * The writer accepted the recovery: the recovered project is written as the new manifest, then opened. A folder the check refuses
   * writes nothing, and the dialog stays open with the reason; a lock the writer has now answered is passed on as answered.
   */
  const acceptRecovery = (): void => {
    if (recovery === null) return;
    const target = recovery;
    const answers: RecoveryAnswers = recoveryRefusal?.reason === 'locked' ? { lockConfirmed: true } : {};
    void run('recovering', async () => {
      let outcome: RecoveryOutcome;
      try {
        outcome = await completeRecovery(store, target, answers);
      } catch (failure) {
        setRecovery(null);
        setRecoveryRefusal(null);
        throw failure;
      }
      if (outcome.kind === 'refused') {
        setRecoveryRefusal({ reason: outcome.reason, files: outcome.files });
        return;
      }
      setRecovery(null);
      setRecoveryRefusal(null);
      // The recovered copy still holds non-UTF-8 files: the writer answers for them before it opens.
      if (outcome.kind === 'encoding') {
        setEncoding(outcome.encoding);
        return;
      }
      onOpened(outcome.opened);
    });
  };

  const cancelRecovery = (): void => {
    setRecovery(null);
    setRecoveryRefusal(null);
    setNotice(t`Nothing was opened or changed.`);
  };

  /**
   * Asks the writer to confirm a removal. A project another tab has open is not offered for removal: the list says where it is, and the
   * removal would be refused anyway (`removeProject` takes the project's lease).
   */
  const askRemove = (project: ProjectSummary): void => {
    void openElsewhere(project.id).then((elsewhere) => {
      if (elsewhere) {
        setNotice(t`“${{ name: isolate(project.name) }}” is open in another tab. Close it there, then remove it here.`);
        return;
      }
      setRemoving(project);
    });
  };

  const confirmRemove = (): void => {
    if (removing === null) return;
    const target = removing;
    setRemoving(null);
    void run('removing', async () => {
      await removeProject(store, target.id);
      // The words a stopped tab kept for this project go with it: nothing can open the project again to offer them back (unsent-copy.ts).
      clearUnsentCopy(browserStorage(), target.id);
      clearPending(browserStorage(), target.id);
      await dropHistoryOf(target.id, null);
      setNotice(t`Removed “${{ name: isolate(target.name) }}” from this browser. A bundle you exported still opens anywhere.`);
      await refresh();
    });
  };

  return (
    <div className="home">
      <header className="home-head">
        <div className="home-title">
          <h1><Trans>Caotang</Trans></h1>
          <button type="button" className="button" onClick={() => setSettings('providers')} data-testid="open-settings">
            <Trans>Settings</Trans>
          </button>
        </div>
        <p className="lede"><Trans>A writing studio that keeps your work on this device.</Trans></p>
      </header>

      {showFirstRun ? (
        <FirstRun
          busy={busy !== null}
          onRun={(intent) => onRunDemo(intent)}
          onDismiss={() => void services.settings.update({ firstRun: { dismissed: true } })}
          onAddKey={() => setSettings('providers')}
        />
      ) : null}

      <section className="home-section" aria-labelledby="home-new">
        <h2 id="home-new"><Trans>New project</Trans></h2>
        <form className="new-project" onKeyDown={newProjectIme.noteKey} onSubmit={create}>
          <label>
            <span><Trans>Project name</Trans></span>
            <input
              type="text"
              value={name}
              maxLength={120}
              placeholder={t`Untitled project`}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <button type="submit" className="button is-primary" disabled={busy !== null}>
            <Trans>Create project</Trans>
          </button>
        </form>
      </section>

      {suggestion !== null ? (
        <aside className="storage-banner" role="status" aria-label={t`Changes that are not in a bundle yet`} data-testid="leave-suggestion">
          <p>{t`“${{ name: isolate(suggestion.name) }}” has changes that are not in a bundle yet. A bundle is the copy that does not depend on this browser.`}</p>
          <div className="storage-banner-actions">
            <button
              type="button"
              className="button"
              disabled={busy !== null}
              onClick={() => {
                const target = suggestion;
                setSuggestion(null);
                exportOne(target.projectId, target.name);
              }}
            >
              <Trans>Export a bundle</Trans>
            </button>
            <button type="button" className="button is-quiet" onClick={() => setSuggestion(null)}>
              <Trans>Dismiss</Trans>
            </button>
          </div>
        </aside>
      ) : null}

      <section className="home-section" aria-labelledby="home-projects">
        <h2 id="home-projects"><Trans>Projects in this browser</Trans></h2>
        {projects === null ? (
          <p className="muted"><Trans>Looking for your projects…</Trans></p>
        ) : projects.length === 0 ? (
          <EmptyState title={t`No projects here yet`}>
            <Trans>Create one above, or bring in a bundle you exported before. Projects stay in this browser until you remove them.</Trans>
          </EmptyState>
        ) : (
          <ul className="project-list">
            {projects.map((project) =>
              renaming !== null && renaming.id === project.id ? (
                <li key={project.id} className="project-row is-renaming">
                  <form
                    className="project-rename"
                    aria-label={t`New name for ${{ name: accessibleText(project.name) }}`}
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (renameIme.takesSubmit()) return;
                      renameProject(project.id, renaming.text);
                    }}
                    onKeyDown={(event) => {
                      renameIme.noteKey(event);
                      if (event.key === 'Escape') setRenaming(null);
                    }}
                  >
                    <label>
                      <span><Trans>New name</Trans></span>
                      <input
                        type="text"
                        value={renaming.text}
                        maxLength={200}
                        autoFocus
                        onChange={(event) => setRenaming({ id: project.id, text: event.target.value })}
                      />
                    </label>
                    <div className="project-actions">
                      <button type="submit" className="button is-primary" disabled={busy !== null || renaming.text.trim() === ''}>
                        <Trans>Save the name</Trans>
                      </button>
                      <button type="button" className="button is-quiet" onClick={() => setRenaming(null)}>
                        <Trans>Cancel</Trans>
                      </button>
                    </div>
                  </form>
                </li>
              ) : (
                <li key={project.id} className="project-row">
                  <div className="project-meta">
                    <span className="project-name">{project.name}</span>
                    <span className="muted">
                      {t`${{ documents: documentsLabel(project.documents) }} · ${{ words: wordsLabel(project.words) }}`}
                    </span>
                  </div>
                  <div className="project-actions">
                    <button type="button" className="button is-primary" disabled={busy !== null} onClick={() => open(project.id)}>
                      <Trans>Open</Trans>
                    </button>
                    {folders.get(project.id) !== undefined ? (
                      <button
                        type="button"
                        className="button"
                        disabled={busy !== null}
                        aria-label={t`Reopen folder of ${{ name: accessibleText(project.name) }}`}
                        onClick={() => {
                          const remembered = folders.get(project.id);
                          if (remembered !== undefined) reopenFolder(remembered);
                        }}
                      >
                        <Trans>Reopen folder</Trans>
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="button"
                      disabled={busy !== null}
                      aria-label={t`Rename ${{ name: accessibleText(project.name) }}`}
                      onClick={() => setRenaming({ id: project.id, text: project.name })}
                    >
                      <Trans>Rename</Trans>
                    </button>
                    <button
                      type="button"
                      className="button"
                      disabled={busy !== null}
                      aria-label={t`Export ${{ name: accessibleText(project.name) }} as a bundle`}
                      onClick={() => exportOne(project.id, project.name)}
                    >
                      <Trans>Export</Trans>
                    </button>
                    <button
                      type="button"
                      className="button is-quiet is-danger"
                      disabled={busy !== null}
                      aria-label={t`Remove ${{ name: accessibleText(project.name) }} from this browser`}
                      onClick={() => askRemove(project)}
                    >
                      <Trans>Remove</Trans>
                    </button>
                  </div>
                </li>
              ),
            )}
          </ul>
        )}
      </section>

      <section className="home-section" aria-labelledby="home-bring">
        <h2 id="home-bring"><Trans>Bring a project in</Trans></h2>
        <div className="bring-row">
          <button
            type="button"
            className="button"
            disabled={busy !== null}
            onClick={() => importInput.current?.click()}
          >
            <Trans>Import bundle (.caotang)</Trans>
          </button>
          <input
            ref={importInput}
            type="file"
            accept=".caotang,.zip,application/zip"
            className="visually-hidden"
            aria-label={t`Bundle file`}
            data-testid="bundle-input"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) importFile(file);
            }}
          />
          {folderSupported ? (
            <button type="button" className="button" disabled={busy !== null} onClick={openFolderAction}>
              <Trans>Open a folder…</Trans>
            </button>
          ) : (
            <p className="muted">
              <Trans>Opening and saving a project folder needs a Chromium-based browser. Bundles work everywhere.</Trans>
            </p>
          )}
        </div>
      </section>

      {busy ? (
        <p className="status-line is-info" role="status">
          {busyText(busy)}…
        </p>
      ) : null}
      {error ? (
        <p className="status-line is-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice && !busy ? (
        <p className="status-line is-info" role="status">
          {notice}
        </p>
      ) : null}
      {notices.map((text) => (
        <p key={text} className="status-line is-info" role="status">
          {text}
        </p>
      ))}

      {settings !== null ? (
        <Settings services={services} session={null} store={store} initialSection={settings} onClose={() => setSettings(null)} />
      ) : null}

      {recovery !== null ? (
        <RecoveryDialog
          recovery={recovery}
          busy={busy !== null}
          refusal={recoveryRefusal?.reason ?? null}
          files={recoveryRefusal?.files ?? []}
          onConfirm={acceptRecovery}
          onCancel={cancelRecovery}
        />
      ) : null}

      {encoding !== null ? (
        <EncodingDialog
          pending={encoding}
          asker={encodingAskerFor(services.providers)}
          busy={busy !== null}
          onDone={answerEncoding}
          onCancel={cancelEncoding}
        />
      ) : null}

      <ChoiceDialog
        open={differs !== null}
        title={
          differs
            ? t`The folder holds a different version of “${{ name: isolate(differs.projectName) }}”`
            : t`The folder holds a different version`
        }
        choices={[
          { label: t`Use the folder’s version`, onChoose: () => answerDiffers('use-folder'), danger: true },
          { label: t`Keep this browser’s version and save it to the folder`, onChoose: () => answerDiffers('keep-browser') },
          { label: t`Open as a separate copy`, onChoose: () => answerDiffers('separate-copy') },
        ]}
        onCancel={() => {
          setDiffers(null);
          setNotice(t`Nothing was opened or changed.`);
        }}
      >
        <p>
          {t`This browser keeps “${{ project: isolate(differs?.projectName ?? '') }}”, and the folder “${{ folder: isolate(differs?.folderName ?? '') }}” holds a version of it that is not the same. Another program may have changed the folder, or the project changed here after it was last saved there.`}
        </p>
        <p>
          <Trans>
            Using the folder’s version replaces this browser’s copy with it. This browser’s copy is not kept, so export it first if you may
            want it. Keeping this browser’s version saves it to the folder, and asks first about any document it would write over. A
            separate copy leaves both as they are, and cannot be saved into that folder.
          </Trans>
        </p>
      </ChoiceDialog>

      <ConfirmDialog
        open={removing !== null}
        title={removing ? t`Remove “${{ name: isolate(removing.name) }}” from this browser?` : t`Remove?`}
        confirmLabel={t`Remove`}
        onCancel={() => setRemoving(null)}
        onConfirm={confirmRemove}
      >
        <p>
          <Trans>
            The project and its history are deleted from this browser. Export a bundle first if you may want it again. This does not touch
            any folder you saved it to.
          </Trans>
        </p>
      </ConfirmDialog>
    </div>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
