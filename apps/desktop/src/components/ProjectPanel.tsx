/**
 * The project panel — epub-metadata.md's fields, in a writer's terms: the title, the author, the language, the ISBN and
 * the cover. It opens from the project's name in the toolbar.
 *
 * Each field saves through its own command when the writer leaves it (or presses Enter), so each change is one row in the
 * activity log and one undo. A value the command refuses is said beside its field, and nothing is written. The cover is
 * chosen from an image file and imported as `project.importAsset` (session.importCover): the bytes are staged, and the
 * command writes them into the project's assets and sets the reference in one undo group.
 */

import { select, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import type { ExecutionOutcome, Result, CommandError } from '@caotang/bus';

import { isImeEnter } from '../app/keymap.js';
import { explain, renameProject, setProjectDetails } from './actions.js';
import { useReturnFocus } from './dialog-focus.js';
import { closeDialog, useDialogRequest } from './dialog-requests.js';
import { useReport } from './shared.js';
import type { ProjectSession } from '../app/session.js';
import './project-dialogs.css';


/* lingui-set comment="Project settings. Interpolated values: message and reason are refusal or failure messages; field names the setting that was not saved." */
type Field = 'title' | 'author' | 'language' | 'isbn' | 'cover';

/** The fields a writer types into, with the names a refusal gives them in the status line. */
const TEXT_FIELDS: readonly Field[] = ['title', 'author', 'language', 'isbn'];

/**
 * What the cover line says: whether one is set, whether its image is held, and what keeps the image. An image held only in this
 * browser is kept there across a reload (the browser's asset store, storyboard.md §2.2), and the line says it is kept in this
 * browser, so the writer knows a project folder would keep it with the project.
 */
function coverHelp(coverAssetId: string | null | undefined, held: boolean | null, inFolder: boolean): string {
  if (!coverAssetId) return t`No cover image. An EPUB without one is still valid.`;
  if (held === false) return t`A cover is set, but its image is not in this browser any more, so EPUB files have no cover. Choose it again.`;
  return inFolder
    ? t`A cover image is set. It is kept in the project folder and goes into EPUB files.`
    : t`A cover image is set and goes into EPUB files. It is kept in this browser, so save the project to a folder to keep it with the project.`;
}

/** The success line after a cover is chosen: the same two cases as {@link coverHelp}. */
function coverSavedNotice(inFolder: boolean): string {
  return inFolder
    ? t`The cover is set. It is kept in the project folder and goes into EPUB files.`
    : t`The cover is set and goes into EPUB files. It is kept in this browser, so save the project to a folder to keep it with the project.`;
}

/** The project panel, rendered only while its request is open. It is a modal, so it is mounted on open and dropped on close. */
export function ProjectPanel({ session }: { session: ProjectSession }): ReactNode {
  const request = useDialogRequest();
  if (request === null || request.kind !== 'project') return null;
  return <ProjectPanelDialog session={session} />;
}

function ProjectPanelDialog({ session }: { session: ProjectSession }): ReactNode {
  useLingui();
  const report = useReport();
  const dialog = useRef<HTMLDialogElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const returnFocus = useReturnFocus();
  const project = session.state.manifest.project;

  // Each field starts from what the project holds. The ISBN is shown as its digits, not as the URN it is stored in.
  const [title, setTitle] = useState(project.name);
  const [author, setAuthor] = useState(project.author ?? '');
  const [language, setLanguage] = useState(project.language ?? '');
  const [isbn, setIsbn] = useState((project.identifier?.isbn ?? '').replace(/^urn:isbn:/, ''));
  const [refused, setRefused] = useState<Partial<Record<Field, string>>>({});
  // The same refusals, read at once: a field's blur runs its save, and Done or Escape reads the result in the same tick.
  const refusedNow = useRef<Partial<Record<Field, string>>>({});
  const [choosing, setChoosing] = useState(false);
  // Whether the image the cover names is held. A reload clears a page's images, so a cover can name a file that is gone.
  const [coverHeld, setCoverHeld] = useState<boolean | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element !== null && !element.open) element.showModal();
  }, []);

  useEffect(() => {
    let current = true;
    void session.coverFileHeld().then((held) => {
      if (current) setCoverHeld(held);
    });
    return () => {
      current = false;
    };
  }, [session, project.coverAssetId]);

  /** Keeps a field's refusal beside it, or clears it (`null`). The ref is what Done and Escape read; the state is what is shown. */
  const note = (field: Field, message: string | null): void => {
    const next = { ...refusedNow.current };
    if (message === null) delete next[field];
    else next[field] = message;
    refusedNow.current = next;
    setRefused(next);
  };

  /** Records a field's outcome: its refusal is kept beside the field, and a success clears it. */
  const settle = (field: Field, outcome: Result<ExecutionOutcome, CommandError>): void => {
    note(field, outcome.ok ? null : explain(outcome.error));
  };

  const saveTitle = (): void => {
    const next = title.trim();
    if (next === '' || next === project.name) {
      setTitle(project.name);
      note('title', null);
      return;
    }
    settle('title', renameProject(session, next));
  };

  const saveAuthor = (): void => {
    const next = author.trim();
    if (next === (project.author ?? '')) {
      note('author', null);
      return;
    }
    settle('author', setProjectDetails(session, { author: next === '' ? null : next }));
  };

  const saveLanguage = (): void => {
    const next = language.trim();
    if (next === (project.language ?? '')) {
      note('language', null);
      return;
    }
    settle('language', setProjectDetails(session, { language: next }));
  };

  const saveIsbn = (): void => {
    const next = isbn.trim();
    if (next === (project.identifier?.isbn ?? '').replace(/^urn:isbn:/, '')) {
      note('isbn', null);
      return;
    }
    settle('isbn', setProjectDetails(session, { isbn: next === '' ? null : next }));
  };

  const chooseCover = async (file: File): Promise<void> => {
    setChoosing(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const outcome = await session.importCover(bytes);
      settle('cover', outcome);
      if (outcome.ok) {
        setCoverHeld(true);
        report({ text: coverSavedNotice(session.assetsInFolder()), tone: 'info' });
      }
    } catch (error) {
      note('cover', t`The cover could not be read: ${{ reason: error instanceof Error ? error.message : String(error) }}`);
    } finally {
      setChoosing(false);
      if (picker.current !== null) picker.current.value = '';
    }
  };

  const removeCover = (): void => {
    settle('cover', setProjectDetails(session, { coverAssetId: null }));
  };

  /** Closes the panel, and hands focus back to the control it opened from. */
  const close = (): void => {
    returnFocus();
    closeDialog();
  };

  /**
   * Done and Escape. A text field whose value the command refused is not saved, and the panel closes, as the writer asked. The
   * refusal is not dropped with it: the status line says which field was not saved and why, and the field keeps its old value.
   * The panel does not stay open for a refused value, because a writer who cannot save it could never leave the panel.
   */
  const finish = (): void => {
    // Leaving the focused field runs its own save here, so a value typed and not yet saved is judged before the panel closes.
    const active = document.activeElement;
    if (active instanceof HTMLElement && dialog.current?.contains(active)) active.blur();
    for (const field of TEXT_FIELDS) {
      const message = refusedNow.current[field];
      if (message !== undefined) {
        report({ text: t`${select(field, { title: 'Title', author: 'Author', language: 'Language', other: 'ISBN' })} was not saved. ${{ message }}`, tone: 'error' });
        break;
      }
    }
    close();
  };

  return (
    <dialog
      ref={dialog}
      className="project-dialog"
      aria-labelledby="project-dialog-title"
      onCancel={(event) => {
        // Escape saves what the writer typed, then closes (ui-modules §5.5): finish leaves the focused field, which runs its save.
        event.preventDefault();
        finish();
      }}
    >
      <div className="project-dialog-body">
        <h2 id="project-dialog-title"><Trans>Project</Trans></h2>

        <label className="project-dialog-field">
          <span className="field-label"><Trans>Title</Trans></span>
          <input
            type="text"
            value={title}
            maxLength={200}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={saveTitle}
            onKeyDown={(event) => {
              // The Enter that commits an IME candidate saves nothing; the candidate's text is still being composed.
              if (event.key === 'Enter' && !isImeEnter(event.nativeEvent)) saveTitle();
            }}
          />
          {refused.title !== undefined ? <span className="project-dialog-error" role="alert">{refused.title}</span> : null}
        </label>

        <label className="project-dialog-field">
          <span className="field-label"><Trans>Author</Trans></span>
          <input
            type="text"
            value={author}
            maxLength={200}
            onChange={(event) => setAuthor(event.target.value)}
            onBlur={saveAuthor}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !isImeEnter(event.nativeEvent)) saveAuthor();
            }}
          />
          <span className="project-dialog-help"><Trans>Shown on the title page and in the EPUB and Word files. Leave it empty for none.</Trans></span>
          {refused.author !== undefined ? <span className="project-dialog-error" role="alert">{refused.author}</span> : null}
        </label>

        <label className="project-dialog-field">
          <span className="field-label"><Trans>Language</Trans></span>
          <input
            type="text"
            value={language}
            maxLength={35}
            onChange={(event) => setLanguage(event.target.value)}
            onBlur={saveLanguage}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !isImeEnter(event.nativeEvent)) saveLanguage();
            }}
          />
          <span className="project-dialog-help"><Trans>A language code such as en, de or en-GB. EPUB files declare it.</Trans></span>
          {refused.language !== undefined ? <span className="project-dialog-error" role="alert">{refused.language}</span> : null}
        </label>

        <label className="project-dialog-field">
          <span className="field-label"><Trans>ISBN</Trans></span>
          <input
            type="text"
            value={isbn}
            maxLength={24}
            onChange={(event) => setIsbn(event.target.value)}
            onBlur={saveIsbn}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !isImeEnter(event.nativeEvent)) saveIsbn();
            }}
          />
          <span className="project-dialog-help"><Trans>Optional. ISBN-10 or ISBN-13, with or without hyphens. It goes into EPUB files.</Trans></span>
          {refused.isbn !== undefined ? <span className="project-dialog-error" role="alert">{refused.isbn}</span> : null}
        </label>

        <div className="project-dialog-field">
          <span className="field-label"><Trans>Cover</Trans></span>
          <span className="project-dialog-help">{coverHelp(project.coverAssetId, coverHeld, session.assetsInFolder())}</span>
          <div className="project-dialog-row">
            <button type="button" className="button" disabled={choosing} onClick={() => picker.current?.click()}>
              {choosing ? t`Importing…` : project.coverAssetId ? t`Replace cover…` : t`Choose cover…`}
            </button>
            {project.coverAssetId ? (
              <button type="button" className="button is-quiet" disabled={choosing} onClick={removeCover}>
                <Trans>Remove cover</Trans>
              </button>
            ) : null}
          </div>
          <input
            ref={picker}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            aria-label={t`Cover image file`}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) void chooseCover(file);
            }}
          />
          {refused.cover !== undefined ? <span className="project-dialog-error" role="alert">{refused.cover}</span> : null}
        </div>

        <div className="confirm-actions">
          {/* Focus stays where it is on the press, so the field's save runs in finish, after the click; a refusal's message would
              otherwise move this button under the pointer before the click lands. */}
          <button type="button" className="button is-primary" onMouseDown={(event) => event.preventDefault()} onClick={finish}>
            <Trans>Done</Trans>
          </button>
        </div>
      </div>
    </dialog>
  );
}
