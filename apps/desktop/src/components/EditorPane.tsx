/**
 * The editor pane — ui-modules §1's "editor pane (focus doc)". It mounts the live editor (`@caotang/editor/tiptap`, editor-engine
 * §4) on the open document, and the writer's words reach the store only through the session's autosave (editor-engine §9).
 *
 * ## Who writes what
 *
 * The editor is handed the session's autosave at mount. Each user edit is noted there, its 800 ms window is the autosave's,
 * and its write is the session's `doc.write`. The pane never writes the store. What the pane owns is what only a view can own:
 * the host element, the load banner (editor-engine §3.3 and §5, once per load), the status line, the word count, the session
 * target, and the ghost bar that answers an agent draft (editor-engine §8).
 *
 * The note the editor makes carries the body as a **producer** (editor-engine §9): §9's pipeline puts the
 * body in the write, not in the keystroke, so the editor's text is read when the window flushes rather than
 * on every keystroke. The editor offers that producer itself, so the pane hands it the session's autosave
 * as it is.
 *
 * ## Store to editor
 *
 * The store moves a document in two ways. A write from this session moves it to the revision the editor already holds, so
 * there is nothing to do but tell the editor its revision (`setRevision`). Anything else (an undo, a restore, an agent apply)
 * replaces the body, and the editor takes it with `setContent`, outside the user's undo history (editor-engine §7, lane 2).
 */

import { isolate } from '@caotang/i18n';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { t } from '@lingui/core/macro';
import { keyboardLayoutStore, shortcutLabel } from '../app/keymap.js';
import {
  createTiptapEditorApi,
  type GhostPreview,
  type InsertedPicture,
  type LoadResult,
  type PicturesPort,
  type TiptapEditorInstance,
} from '@caotang/editor/tiptap';
import { countBody, getBody, getRevision } from '@caotang/store';

import { nodeById } from '../app/binder-model.js';
import { publishEditorCaret, type EditorCaret } from '../app/editor-selection.js';
import type { AgentController, AgentSnapshot } from '../app/agent.js';
import type { GhostView } from '../app/agent-model.js';
import { describeLossGroup, reStyleSentence } from '../app/load-banner.js';
import { isOwnWrite } from '../app/integrity-model.js';
import type { ProjectSession } from '../app/session.js';
import { createHistorySaver, loadHistoryJournal } from '../app/history-store.js';
import { registerSelectionReader } from '../app/test-hook.js';
import type { TargetProgress } from '../app/session-progress.js';
import { listAssets } from '../media/engines.js';
import { ImportNotice, IMPORT_SOURCE, PASTE_SOURCE, usePictureImporter } from '../media/picture-hooks.js';
import type { ImportReport } from '../media/picture-board-model.js';
import { IMAGE_ACCEPT } from '../media/shot-image-model.js';
import { EmptyState, useReport, useSession, wordsLabel } from './shared.js';
import { TargetQuickSet } from './TargetQuickSet.js';

/* lingui-set comment="Interpolated values: reason is a failure message; title is the writer’s own title; words is a word count" */

/** One API for every mount: it holds no state of its own (the instance does). */
const editorApi = createTiptapEditorApi();

/** A passage the shell asked the editor to show: the document, and the body-projection range to scroll to and select. */
export interface RevealRequest {
  readonly docId: string;
  readonly from: number;
  readonly to: number;
}

export interface EditorPaneProps {
  readonly session: ProjectSession;
  readonly docId: string | null;
  readonly onNewDocument: () => void;
  /**
   * Set when New document would be refused here, because nothing chapter-shaped is selected: the empty editor then
   * offers a new chapter as its action, so the first button on a fresh project makes something instead of an error.
   */
  readonly onNewChapter?: (() => void) | undefined;
  /** The document the shell asked the editor to take focus for, once it is mounted. */
  readonly focusDocId: string | null;
  readonly onFocusHandled: () => void;
  /** A passage a finding quotes, to show once its document is mounted (coherence.md §8). */
  readonly reveal?: RevealRequest | null;
  readonly onRevealHandled?: () => void;
  /** Whether the editor is the centre view. A hidden editor keeps its state, including its undo history. */
  readonly visible: boolean;
  /** The project's agent controller, or `null` until its download has finished: the scene is editable meanwhile, and no draft is waiting. */
  readonly agent: AgentController | null;
  /** Today's words toward the writer's target, as the status line shows them (goals-progress §2.1). */
  readonly target: TargetProgress;
  /** Saves the writer's daily target from the status bar's quick-set (goals-progress §4). */
  readonly onSetTarget: (words: number) => void;
}

export function EditorPane({
  session,
  docId,
  onNewDocument,
  onNewChapter,
  focusDocId,
  onFocusHandled,
  reveal = null,
  onRevealHandled = noop,
  visible,
  agent,
  target,
  onSetTarget,
}: EditorPaneProps): ReactNode {
  useLingui();
  useSession(session);
  const keyboardLayout = useSyncExternalStore(keyboardLayoutStore.subscribe, keyboardLayoutStore.snapshot);
  const node = docId === null ? undefined : nodeById(session.state, docId);

  if (docId === null || node === undefined || node.type !== 'document') {
    return (
      <div className="editor-pane is-empty" hidden={!visible}>
        <EmptyState
          title={t`No document open`}
          actions={
            onNewChapter === undefined ? (
              <button type="button" className="button is-primary" onClick={onNewDocument}>
                New document
              </button>
            ) : (
              <button type="button" className="button is-primary" onClick={onNewChapter}>
                New chapter
              </button>
            )
          }
        >
          {onNewChapter === undefined
            ? t`Select a document in the binder, then press ${{ shortcut: shortcutLabel('open-in-editor', keyboardLayout) }} or choose Open in editor. Scenes are written here.`
            : t`Select a document in the binder, then press ${{ shortcut: shortcutLabel('open-in-editor', keyboardLayout) }} or choose Open in editor. Scenes are written here. A scene goes in a chapter, so make the chapter first.`}
        </EmptyState>
      </div>
    );
  }

  return (
    <DocumentEditor
      key={`${session.projectId}:${docId}`}
      session={session}
      docId={docId}
      title={node.title}
      visible={visible}
      focusRequested={focusDocId === docId}
      onFocusHandled={onFocusHandled}
      reveal={reveal !== null && reveal.docId === docId ? reveal : null}
      onRevealHandled={onRevealHandled}
      agent={agent}
      target={target}
      onSetTarget={onSetTarget}
    />
  );
}

function noop(): void {}

/** The part of the agent's snapshot this pane reads, and what it reads before the controller has loaded: no draft waits. */
type AgentDraftView = Pick<AgentSnapshot, 'ghosts' | 'pending' | 'approvable'>;
const NO_DRAFTS: AgentDraftView = { ghosts: [], pending: null, approvable: false };
function noAgentSubscribe(): () => void {
  return noop;
}
function noAgentSnapshot(): AgentDraftView {
  return NO_DRAFTS;
}

const PICTURE_MIME: Readonly<Record<string, string>> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

/** The file name inside `assets/` that a body source names, or null for any other path. A scene sits in `docs/`, so the source is `../assets/<file>`. */
function assetFileOf(src: string): string | null {
  let path = src;
  try {
    path = decodeURIComponent(src);
  } catch {
    // An undecodable escape is read as written.
  }
  const match = /^(?:\.\.\/)?assets\/([^/\\]+)$/.exec(path);
  return match?.[1] ?? null;
}

interface PictureImporterHandle {
  readonly importFiles: ReturnType<typeof usePictureImporter>['importFiles'];
}

/**
 * The editor's picture port over the session: bytes come from the project's `assets/` store, and a chosen, dropped or pasted file goes
 * through the same import the picture board uses (`asset.importBatch`), so the large-photo question and the refusals are the same.
 * The importer is read through `importer()` because the editor mounts once per document while the importer's hook lives on.
 */
function createPicturesPort(session: ProjectSession, importer: () => PictureImporterHandle, onReport: (report: ImportReport) => void): PicturesPort & { readonly dispose: () => void } {
  const urls = new Set<string>();
  return {
    accept: IMAGE_ACCEPT,
    async resolve(src) {
      const file = assetFileOf(src);
      if (file === null) return null;
      const bytes = await session.assets.readBytes(`assets/${file}`);
      if (bytes === null) return null;
      const type = PICTURE_MIME[file.slice(file.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type }));
      urls.add(url);
      return url;
    },
    release(url) {
      if (urls.delete(url)) URL.revokeObjectURL(url);
    },
    async importFiles(files, origin) {
      const done = await importer().importFiles(files, { source: origin === 'paste' ? PASTE_SOURCE : IMPORT_SOURCE });
      onReport(done);
      if (done.assetIds.length === 0) return [];
      const listed = await listAssets(session.assets.artifactFs());
      const names = new Map(listed.map((asset) => [asset.assetId, asset.fileName]));
      const inserted: InsertedPicture[] = [];
      done.assetIds.forEach((assetId, index) => {
        const fileName = names.get(assetId);
        if (fileName === undefined) return;
        // The report lists assets in the order of the files that were kept, so the names line up only when none were left out.
        const label = done.skipped.length === 0 ? files[index]?.name.replace(/\.[^.]*$/, '') : undefined;
        inserted.push({ src: `../assets/${fileName}`, ...(label === undefined || label === '' ? {} : { alt: label }) });
      });
      return inserted;
    },
    dispose() {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    },
  };
}

function DocumentEditor({
  session,
  docId,
  title,
  visible,
  focusRequested,
  onFocusHandled,
  reveal,
  onRevealHandled,
  agent,
  target,
  onSetTarget,
}: {
  session: ProjectSession;
  docId: string;
  title: string;
  visible: boolean;
  focusRequested: boolean;
  onFocusHandled: () => void;
  reveal: RevealRequest | null;
  onRevealHandled: () => void;
  agent: AgentController | null;
  target: TargetProgress;
  onSetTarget: (words: number) => void;
}): ReactNode {
  const { i18n } = useLingui();
  useSession(session);
  const report = useReport();
  const snapshot: AgentDraftView = useSyncExternalStore(agent?.subscribe ?? noAgentSubscribe, agent?.snapshot ?? noAgentSnapshot);
  // The editor is made once per document, so it reaches the controller through a ref: the controller arriving later does not rebuild it.
  const agentRef = useRef(agent);
  useEffect(() => {
    agentRef.current = agent;
  }, [agent]);
  const host = useRef<HTMLDivElement>(null);
  // The manuscript reads in the project's language and direction, whatever the interface language is
  // (i18n.md §3.1, §5.4).
  const contentLang = session.state.manifest.project.language;
  // The ghost bar's own element, brought into view when a draft lands (the effect below).
  const barRef = useRef<HTMLElement>(null);
  const [editor, setEditor] = useState<TiptapEditorInstance | null>(null);
  const [load, setLoad] = useState<LoadResult | null>(null);
  const [bannerOpen, setBannerOpen] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  // What the editor agrees with: the body and revision it was last made to hold. A store change that is not this one is the
  // only thing that makes the editor take a new body.
  const synced = useRef<{ body: string; revision: number } | null>(null);
  const importer = usePictureImporter(session);
  const latestImporter = useRef(importer);
  const [notice, setNotice] = useState<ImportReport | null>(null);
  // The selection the editor last reported, republished when a save lands so the strip's attach control sees a fresh dirty
  // flag. The visibility is read through a ref because the mount effect runs once per document.
  const lastSelection = useRef<EditorCaret | null>(null);
  const visibleRef = useRef(visible);

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  useEffect(() => {
    latestImporter.current = importer;
  }, [importer]);

  // The editor stays mounted across a language switch; its accessible name still follows the catalogue.
  useEffect(() => {
    if (host.current !== null) labelSurface(host.current);
  }, [i18n.locale, editor]);

  const stored = getBody(session.state, docId);
  const revision = getRevision(session.state, docId);
  const save = session.autosave.status(docId);
  const counts = countBody(editor === null ? stored : editor.getContent());

  // The draft's ghost region belongs to the controller while both exist. Declared before the mount effect, so on teardown the ghost is let go of before the editor is destroyed.
  useEffect(() => {
    if (agent === null || editor === null) return;
    agent.attachGhost(docId, editor.ghost);
    return () => agent.detachGhost(docId, editor.ghost);
  }, [agent, editor, docId]);

  // Mount once per document (the component is keyed by it). The editor opens its document on the session's autosave at the
  // revision the store holds, so the first flush is compared with what was loaded. The ghost's Apply, Retry and Discard
  // answer the agent's decision, through the same controller that owns the turn.
  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    let alive = true;
    let mounted: TiptapEditorInstance | null = null;
    const pictures = createPicturesPort(session, () => latestImporter.current, (done) => {
      // A retry would store the pictures but not place them in the scene, so the notice offers none; the writer inserts again.
      const { retry: _retry, ...shown } = done;
      if (alive) setNotice(shown);
    });
    // The undo the writer's last visit left (history-store.ts) is read first, and the body and revision after it, so the editor opens on
    // what the store holds at the moment it mounts. The editor rebuilds the undo only if it replays to that body.
    const saver = createHistorySaver(session.projectId, docId);
    /** Publishes one selection, or `null` while the editor is hidden or gone (a hidden editor publishes nothing). */
    const publishSelection = (instance: TiptapEditorInstance | null, selection: EditorCaret | null): void => {
      if (!alive || !visibleRef.current || instance === null || selection === null) {
        publishEditorCaret(null);
        return;
      }
      publishEditorCaret({ docId, from: selection.from, to: selection.to, dirty: instance.hasUnsavedEdits() });
    };
    loadHistoryJournal(session.projectId, docId)
      .then((journal) => {
        if (!alive) return null;
        const body = getBody(session.state, docId);
        const at = getRevision(session.state, docId);
        synced.current = { body, revision: at };
        return editorApi.mount(element, {
          docId,
          initialBody: body,
          revision: at,
          autosave: session.autosave,
          injectCSS: false,
          placeholder: t`Start the scene. Your words are saved in this browser as you go.`,
          labels: {
            ghostRegion: t`Agent preview`,
            ghostStopped: (reason) => t`The stream stopped before it finished (${{ reason }}). The text above is partial; Retry or Discard.`,
            image: t`Image`,
            insertPicture: t`Insert picture`,
            slashMenu: t`Insert`,
            slashPictureHint: t`Choose a picture from your computer`,
            imageMissing: (name) => t`Picture not found: ${{ name }}. Add the file back to the project's assets folder, or delete the picture.`,
            imageRemote: t`Picture on the web. It is not loaded, so opening this scene never contacts the network.`,
            imageLoading: t`Loading picture…`,
            pictureSettings: t`Picture settings`,
            pictureAlt: t`Alt text`,
            pictureCaption: t`Caption`,
            pictureDecorative: t`Decorative picture (screen readers skip it)`,
            pictureSize: t`Size`,
            sizeFull: t`Full width`,
            sizeHalf: t`Half width`,
            sizeInline: t`In line with the text`,
            pictureApply: t`Apply`,
            pictureCancel: t`Cancel`,
          },
          pictures,
          history: { journal, onChange: saver.onChange },
          // The Inspector's picture strip attaches a picture to the paragraph the caret is in, so the selection is published
          // for the shell (editor-selection.ts). The dirty flag rides along because an anchor is captured against the store's
          // body, which is the body the next write diffs against.
          onSelectionChange: (selection) => {
            // The seam's `EditorSelection` is the offsets alone; the caret adds which document they belong to.
            const caret: EditorCaret | null = selection === null ? null : { docId, from: selection.from, to: selection.to, dirty: mounted?.hasUnsavedEdits() ?? false };
            lastSelection.current = caret;
            publishSelection(mounted, caret);
          },
          ghost: {
            onApply: () => agentRef.current?.answer({ action: 'approve' }),
            onRetry: () => agentRef.current?.answer({ action: 'retry' }),
            onDiscard: () => agentRef.current?.answer({ action: 'cancel' }),
          },
        });
      })
      .then(
        (instance) => {
          if (instance === null) return;
          if (!alive) {
            instance.destroy();
            return;
          }
          mounted = instance;
          labelSurface(element);
          // Once per load: the diagnostics of this parse. A later `setContent` does not bring the banner back.
          setLoad(instance.loadResult());
          setEditor(instance);
        },
        (error: unknown) => {
          if (alive) setFailure(error instanceof Error ? error.message : String(error));
        },
      );
    return () => {
      alive = false;
      // Teardown flushes the document's pending edit through the autosave (editor-engine §9).
      mounted?.destroy();
      pictures.dispose();
      publishEditorCaret(null);
      // The undo journal is written one last time, from what the editor held.
      void saver.dispose();
    };
  // The editor's own words are set when it mounts; a language switch keeps the live editor and its unsaved text.
  }, [session, docId]);

  // The store moved this document. Its own write is acknowledged to the editor; anything else replaces the body.
  useEffect(() => {
    if (editor === null) return;
    const seen = synced.current;
    if (seen !== null && seen.body === stored && seen.revision === revision) return;
    synced.current = { body: stored, revision };
    const own = session.lastWritten(docId);
    if (isOwnWrite(own, stored, revision) || editor.getContent() === stored) {
      editor.setRevision(revision);
      return;
    }
    // The store's body is the truth: this replacement is an undo, a restore or an agent apply. An undo and a restore save the
    // writer's typing first (`undoLast` flushes); an agent apply waits for the writer's typing to be saved too (`answer`
    // flushes before an approval), so the discard only ever drops text the store already holds.
    editor
      .setContent(stored, { historyExcluded: true, discardUnsaved: true })
      .then(() => editor.setRevision(revision))
      .catch((error: unknown) => {
        report({
          text: t`The text could not be brought up to date: ${{ reason: error instanceof Error ? error.message : String(error) }}`,
          tone: 'error',
        });
      });
  }, [editor, stored, revision, session, docId, report]);

  // The scene's ghost region is on screen while this editor is shown. The controller counts a draft as shown only then.
  useEffect(() => {
    if (agent === null) return;
    agent.setEditorVisible(docId, visible);
    return () => agent.setEditorVisible(docId, false);
  }, [agent, docId, visible]);

  // A save landed: the strip's attach control asks whether the store holds the text the caret is in, so the last selection is
  // republished with a fresh answer. A hidden editor publishes nothing either way.
  useEffect(() => {
    if (editor === null) return;
    publishEditorCaret(
      !visible || lastSelection.current === null
        ? null
        : { docId, from: lastSelection.current.from, to: lastSelection.current.to, dirty: editor.hasUnsavedEdits() },
    );
  }, [editor, visible, docId, revision, save.state]);

  // Ctrl+Enter and Open in editor ask for focus once the editor exists. A click in the binder does not.
  useEffect(() => {
    if (editor === null || !focusRequested) return;
    editor.focus();
    onFocusHandled();
  }, [editor, focusRequested, onFocusHandled]);

  // A finding's quoted passage: scroll to it and select it, once this document's editor exists (coherence.md §8).
  useEffect(() => {
    if (editor === null || reveal === null) return;
    editor.revealRange({ from: reveal.from, to: reveal.to });
    onRevealHandled();
  }, [editor, reveal, onRevealHandled]);

  // The test hook reads the selection of the shown editor (test-hook.ts). A hidden editor reports none.
  useEffect(() => {
    if (editor === null) return undefined;
    return registerSelectionReader(docId, () => (visible ? editor.getSelection() : null));
  }, [editor, docId, visible]);

  // The draft this editor's scene will receive, if the loop has staged one for it. Its ghost region is this editor's own.
  const ghostFor = snapshot.ghosts.findLast((draft) => draft.docId === docId);
  const ghostHere = ghostFor !== undefined && editor !== null ? editor.ghost : null;

  // A draft that lands is brought into view with its Apply bar, so the writer does not scroll the editor to find it.
  const landed = ghostFor?.callId;
  useEffect(() => {
    if (landed === undefined || ghostHere === null) return;
    barRef.current?.scrollIntoView({ block: 'nearest' });
  }, [landed, ghostHere]);

  return (
    <article className="editor-pane" hidden={!visible}>
      <div className="editor-column">
        <header className="editor-head">
          <h2 className="editor-title" lang={contentLang} dir="auto">{title}</h2>
        </header>

        {load !== null && bannerOpen && (load.groups.length > 0 || load.dialect.length > 0) ? (
          <LoadBanner load={load} onDismiss={() => setBannerOpen(false)} />
        ) : null}

        {failure !== null ? (
          <EmptyState title={t`The editor could not open this document`}>{failure}</EmptyState>
        ) : null}

        <div className="editor-toolbar" role="toolbar" aria-label={t`Insert into the scene`}>
          <button
            type="button"
            className="button is-quiet"
            disabled={editor === null || importer.busy}
            onClick={() => {
              void editor?.choosePictures();
            }}
          >
            <Trans>Insert picture</Trans>
          </button>
        </div>

        {notice !== null ? <ImportNotice report={notice} onDismiss={() => setNotice(null)} onRetry={noop} /> : null}
        {importer.dialog}

        <div ref={host} className="editor-host" lang={contentLang} dir="auto" />

        {ghostHere !== null && ghostFor !== undefined ? (
          <GhostBar
            ghost={ghostHere}
            draft={ghostFor}
            title={title}
            live={snapshot.pending !== null}
            approvable={snapshot.approvable}
            barRef={barRef}
          />
        ) : null}

        <footer className="editor-status" aria-label={t`Document status`}>
          <span className="editor-count">{wordsLabel(counts.words)}</span>
          <TargetQuickSet progress={target} onSetTarget={onSetTarget} />
          <span className="editor-save" aria-live="polite">
            {save.lastError !== null
              ? t`Not saved yet. Your words are in this tab; they will be written again on the next change.`
              : save.dirty
                ? t`Saving…`
                : t`Saved`}
          </span>
        </footer>
      </div>
    </article>
  );
}

/**
 * The ghost bar (editor-engine §8, agent-harness §8): the draft the agent wrote for this scene, with Apply, Retry and Discard.
 * The buttons are the ghost's own, and each one answers the decision the loop is waiting for. Apply is live only while there is
 * a decision to answer, the card may be approved (every draft is on screen, agent-harness §2), and the draft is whole.
 */
function GhostBar({
  ghost,
  draft,
  title,
  live,
  approvable,
  barRef,
}: {
  ghost: GhostPreview;
  draft: GhostView;
  title: string;
  live: boolean;
  approvable: boolean;
  barRef: RefObject<HTMLElement | null>;
}): ReactNode {
  useLingui();
  return (
    <aside ref={barRef} className="ghost-bar" aria-label={t`Draft preview`} data-testid="ghost-bar">
      <p>
        {draft.cut
          ? t`Draft for “${{ title: isolate(title) }}”: ${{ words: wordsLabel(draft.words) }}, cut off at the model’s output limit. Apply writes it into the scene. Retry drafts it again. Discard leaves the scene as it is.`
          : t`Draft for “${{ title: isolate(title) }}”: ${{ words: wordsLabel(draft.words) }}. Apply writes it into the scene. Retry drafts it again. Discard leaves the scene as it is.`}
      </p>
      <div className="ghost-actions">
        <button type="button" className="button is-primary" disabled={!live || !approvable || !ghost.canApply()} onClick={() => ghost.apply()}>
          <Trans>Apply</Trans>
        </button>
        <button type="button" className="button" disabled={!live} onClick={() => ghost.retry()}>
          <Trans>Retry</Trans>
        </button>
        <button type="button" className="button is-quiet" disabled={!live} onClick={() => ghost.discard()}>
          <Trans>Discard</Trans>
        </button>
      </div>
    </aside>
  );
}

/**
 * The load banner (editor-engine §3.3 and §5). A block the save will re-style is counted once, and each construct the schema
 * cannot keep is named with its line. Nothing here is an error: the text is kept.
 */
function LoadBanner({ load, onDismiss }: { load: LoadResult; onDismiss: () => void }): ReactNode {
  useLingui();
  const blocks = load.dialect.length;
  return (
    <aside className="load-banner" role="status" aria-label={t`About this document's format`}>
      <div className="load-banner-text">
        {blocks > 0 ? <p>{reStyleSentence(blocks)}</p> : null}
        {load.groups.length > 0 ? (
          <>
            <p><Trans>Saving will not keep these constructs exactly:</Trans></p>
            <ul>
              {load.groups.map((group) => (
                <li key={`${group.code}:${group.mdastType}:${group.line ?? 'none'}`}>{describeLossGroup(group)}</li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
      <button type="button" className="button is-quiet" onClick={onDismiss}>
        <Trans>Dismiss</Trans>
      </button>
    </aside>
  );
}

/**
 * The editor's own surface is the element the user types into. It gets the name the tests and assistive technology use for
 * it, which the editor cannot set itself.
 */
function labelSurface(host: HTMLElement): void {
  const surface = host.querySelector<HTMLElement>('.ProseMirror');
  if (surface === null) return;
  surface.setAttribute('aria-label', t`Document text`);
  surface.setAttribute('aria-multiline', 'true');
}
