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
 *
 * An agent apply the controller recorded (`consumeApply`) is the one replacement that can take another road: with Settings > Writing set to
 * mark the changes for review, the editor shows it as marks over the saved text (`showAgentEdit`, editor-engine §15) and the review bar
 * resolves them. The store already holds the text when the marks appear.
 */

import { isolate } from '@caotang/i18n';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { t } from '@lingui/core/macro';
import { isModern } from '../app/interface.js';
import { documentSaveState, saveConflictWords } from '../app/save-conflict.js';
import { keyboardLayoutStore, shortcutLabel } from '../app/keymap.js';
import {
  createTiptapEditorApi,
  LoadSupersededError,
  type FootnoteOrphan,
  type GhostPreview,
  type InsertedPicture,
  type LoadResult,
  type PicturesPort,
  type TiptapEditorInstance,
} from '@caotang/editor/tiptap';
import { countBody, getBody, getRevision } from '@caotang/store';

import { activeAppDb } from '../app/app-db.js';
import { nodeById } from '../app/binder-model.js';
import { publishEditorCaret, type EditorCaret } from '../app/editor-selection.js';
import { publishEditorReady } from '../app/editor-ready.js';
import type { StoredMark } from '../app/store-rebase.js';
import type { AgentController, AgentSnapshot } from '../app/agent.js';
import type { GhostView } from '../app/agent-model.js';
import { describeLossGroup, dialectSentences } from '../app/load-banner.js';
import { takePending } from '../app/review-notice.js';
import { pendingNotice } from '../app/review-text.js';
import type { ProjectSession } from '../app/session.js';
import { createHistorySaver, loadHistoryJournal } from '../app/history-store.js';
import type { AgentEditMode } from '../app/settings.js';
import { registerSelectionReader } from '../app/test-hook.js';
import type { TargetProgress } from '../app/session-progress.js';
import { listAssets } from '../media/engines.js';
import { ImportNotice, IMPORT_SOURCE, PASTE_SOURCE, usePictureImporter } from '../media/picture-hooks.js';
import type { ImportReport } from '../media/picture-board-model.js';
import { IMAGE_ACCEPT } from '../media/shot-image-model.js';
import { EmptyState, useReport, useSession, wordsLabel } from './shared.js';
import { TargetQuickSet } from './TargetQuickSet.js';
import { editorLabels } from './editor-labels.js';
import { useNarrow } from './narrow.js';
import { useStoreRebase } from './use-store-rebase.js';

/** The review bar and the hold on the marks are fetched only by an editor in review mode (Settings > Writing), so the default path does not carry them. */
const ReviewSide = lazy(() => import('./ReviewSide.js').then((module) => ({ default: module.ReviewSide })));

/* lingui-set comment="Interpolated values: reason is a failure message; title is the writer’s own title; words is a word count; label is a footnote’s label (a number or a name); text is the start of the footnote’s note" */

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
  /** Where an approved agent edit lands (Settings > Writing). Read when a document is opened: a change applies to the next one. */
  readonly agentEditMode?: AgentEditMode;
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
  agentEditMode = 'ghost',
}: EditorPaneProps): ReactNode {
  useLingui();
  useSession(session);
  const keyboardLayout = useSyncExternalStore(keyboardLayoutStore.subscribe, keyboardLayoutStore.snapshot);
  const narrow = useNarrow();
  const node = docId === null ? undefined : nodeById(session.state, docId);

  if (docId === null || node === undefined || node.type !== 'document') {
    return (
      <div className="editor-pane is-empty" hidden={!visible}>
        <EmptyState
          title={t`No document open`}
          actions={
            onNewChapter === undefined ? (
              <button type="button" className="button is-primary" onClick={onNewDocument}>
                {t`New document`}
              </button>
            ) : (
              <button type="button" className="button is-primary" onClick={onNewChapter}>
                {t`New chapter`}
              </button>
            )
          }
        >
          {narrow
            ? onNewChapter === undefined
              ? t`Open the binder and choose a document. Scenes are written here.`
              : t`Open the binder and choose a document. Scenes are written here. A scene goes in a chapter, so make the chapter first.`
            : onNewChapter === undefined
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
      agentEditMode={agentEditMode}
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
  agentEditMode,
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
  agentEditMode: AgentEditMode;
}): ReactNode {
  const { i18n } = useLingui();
  useSession(session);
  const report = useReport();
  // The mode this editor was opened with. The mount effect reads it once, so a change in Settings applies to the next document.
  const [modeAtOpen] = useState(agentEditMode);
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
  // The notes whose last marker the writer deleted (editor-engine §3.4), oldest first: the editor keeps them, and the question asks
  // about the first, then the next. One edit can orphan several notes, and each is asked about.
  const [orphans, setOrphans] = useState<readonly FootnoteOrphan[]>([]);
  const orphan = orphans[0] ?? null;
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

  // The editor's own words follow the switch too (the footnote markers' and notes' names at once), without a remount.
  useEffect(() => {
    editor?.setLabels(editorLabels());
  }, [i18n.locale, editor]);

  const stored = getBody(session.state, docId);
  const revision = getRevision(session.state, docId);
  const save = session.autosave.status(docId);
  const counts = countBody(editor === null ? stored : editor.getContent());
  const { ready: editorReady, state: rebaseState, seed: seedRebase } = useStoreRebase({
    session, docId, enabled: editor !== null,
    matches: (mark) => editor?.getContent() === mark.body,
    acknowledge: (mark) => editor?.setRevision(mark.revision),
    apply: async (mark, current) => {
      if (editor === null) return false;
      const apply = agent?.consumeApply(docId, mark.revision) ?? null;
      try {
        if (apply !== null && modeAtOpen === 'suggestions') {
          const outcome = await editor.showAgentEdit(mark.body, { toolCallId: apply.toolCallId, revision: mark.revision });
          if (!current() || outcome.landed === 'replaced' && outcome.reason === 'superseded') return false;
          const module = await import('./ReviewSide.js');
          if (!current()) return false;
          module.reportLanding(outcome, report);
        } else {
          await editor.setContent(mark.body, { historyExcluded: true, discardUnsaved: true, revision: mark.revision });
        }
      } catch (error: unknown) {
        if (error instanceof LoadSupersededError) return false;
        throw error;
      }
      if (current()) setOrphans([]);
    },
    failed: (error) => report({
      text: t`The text could not be brought up to date: ${{ reason: error instanceof Error ? error.message : String(error) }}`,
      tone: 'error',
    }),
  });

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
    let opened: StoredMark | null = null;
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
        opened = { body, revision: at };
        return editorApi.mount(element, {
          docId,
          initialBody: body,
          revision: at,
          autosave: session.autosave,
          injectCSS: false,
          placeholder: t`Start the scene. Your words are saved in this browser as you go.`,
          labels: editorLabels(),
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
          agentEditMode: modeAtOpen,
          onFootnoteOrphaned: (found) => {
            if (alive) setOrphans((queued) => [...queued, ...found]);
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
          if (opened !== null) seedRebase(opened);
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
  }, [session, docId, modeAtOpen, seedRebase]);

  // What an earlier visit left marked is said once, whichever mode this visit opened in: the row is taken on every open, so it cannot
  // outlive the mode and be said later about a scene the writer has since edited another way (editor-engine §15).
  useEffect(() => {
    let live = true;
    void takePending(session.projectId, docId, activeAppDb()).then((left) => {
      if (left !== null && live) report({ text: pendingNotice(left.count), tone: 'info' });
    });
    return () => {
      live = false;
    };
  }, [session.projectId, docId, report]);

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
    if (editor === null || !editorReady || !focusRequested) return;
    editor.focus();
    onFocusHandled();
  }, [editor, editorReady, focusRequested, onFocusHandled]);

  // A finding's quoted passage: scroll to it and select it, once this document's editor exists (coherence.md §8).
  useEffect(() => {
    if (editor === null || !editorReady || reveal === null) return;
    editor.revealRange({ from: reveal.from, to: reveal.to });
    onRevealHandled();
  }, [editor, editorReady, reveal, onRevealHandled]);

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

  useEffect(() => {
    if (visible && (editorReady || failure !== null || rebaseState === 'failed') && host.current !== null) publishEditorReady(host.current);
  }, [visible, editorReady, failure, rebaseState]);

  return (
    <article className="editor-pane" hidden={!visible} data-editor-state={failure !== null ? 'failed' : rebaseState}>
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

        {editor !== null && orphan !== null ? (
          <FootnoteQuestion
            orphan={orphan}
            onDelete={() => {
              // The note is the one the question named, followed by the editor since; a refusal changes nothing and is said.
              const outcome = editor.deleteFootnoteNote(orphan);
              setOrphans((queued) => queued.filter((entry) => entry.id !== orphan.id));
              if (outcome !== 'deleted') report({ text: footnoteKeptNotice(outcome), tone: 'info' });
              editor.focus();
            }}
            onKeep={() => {
              setOrphans((queued) => queued.filter((entry) => entry.id !== orphan.id));
              editor.focus();
            }}
          />
        ) : null}

        {editor !== null && agent !== null && modeAtOpen === 'suggestions' ? (
          <Suspense fallback={null}>
            <ReviewSide projectId={session.projectId} docId={docId} agent={agent} editor={editor} report={report} />
          </Suspense>
        ) : null}

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
          {editor !== null ? (
            <button
              type="button"
              className="button is-quiet editor-footnote"
              aria-keyshortcuts="Control+Shift+6 Meta+Shift+6"
              title={t`Add a footnote at the caret (Ctrl+Shift+6). The same keys in a note go back to the text.`}
              onClick={() => {
                // The command refuses where a footnote cannot go (inside a note, or where the block takes no marker); say so.
                if (!editor.insertFootnote()) {
                  report({ text: t`A footnote can’t be added here. Put the caret in the text, outside a note, and try again.`, tone: 'info' });
                }
                editor.focus();
              }}
            >
              <Trans>Add footnote</Trans>
            </button>
          ) : null}
          <TargetQuickSet progress={target} onSetTarget={onSetTarget} />
          <span className={`editor-save${documentSaveState(save) === 'conflict' ? ' load-banner' : ''}`} aria-live="polite" data-testid="document-save-state" data-state={documentSaveState(save)}>
            {documentSaveState(save) === 'conflict'
              ? saveConflictWords()
              : save.lastError !== null
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
  const modern = isModern();
  const rest = (
    <>
      <button type="button" className="button" disabled={!live} onClick={() => ghost.retry()}>
        <Trans>Retry</Trans>
      </button>
      <button type="button" className="button is-quiet" disabled={!live} onClick={() => ghost.discard()}>
        <Trans>Discard</Trans>
      </button>
    </>
  );
  return (
    <aside ref={barRef} className="ghost-bar" aria-label={t`Draft preview`} data-testid="ghost-bar">
      <p>
        {draft.cut
          ? t`Draft for “${{ title: isolate(title) }}”: ${{ words: wordsLabel(draft.words) }}, cut off at the model’s output limit.`
          : t`Draft for “${{ title: isolate(title) }}”: ${{ words: wordsLabel(draft.words) }}.`}
        {/* Modern says it once: the buttons name what they do (#361). */}
        {modern ? null : ` ${t`Apply writes it into the scene. Retry drafts it again. Discard leaves the scene as it is.`}`}
      </p>
      <div className="ghost-actions">
        <button type="button" className="button is-primary" disabled={!live || !approvable || !ghost.canApply()} onClick={() => ghost.apply()}>
          <Trans>Apply</Trans>
        </button>
        {/* Modern keeps one primary in view and the rest in a disclosure (#361); Classic shows all three. */}
        {modern ? (
          <details className="k-more">
            <summary>{t`More`}</summary>
            {rest}
          </details>
        ) : (
          rest
        )}
      </div>
    </aside>
  );
}

/** What the writer is told when answering "Delete the note" changed nothing. */
function footnoteKeptNotice(outcome: 'referenced' | 'gone'): string {
  return outcome === 'referenced'
    ? t`The note was kept: a marker refers to it again.`
    : t`The note was kept: it was changed or is no longer there.`;
}

/**
 * The question after the writer deletes a footnote's marker (editor-engine §3.4). The note is kept until the writer says otherwise, so
 * ignoring the question loses nothing; it is a status region, so a screen reader hears it without the focus moving.
 */
function FootnoteQuestion({
  orphan,
  onDelete,
  onKeep,
}: {
  orphan: FootnoteOrphan;
  onDelete: () => void;
  onKeep: () => void;
}): ReactNode {
  useLingui();
  const label = orphan.label;
  const text = orphan.text.length > 80 ? `${orphan.text.slice(0, 79)}…` : orphan.text;
  return (
    <aside className="footnote-question" role="status" aria-label={t`Footnote without a marker`} data-testid="footnote-question">
      <p>
        {orphan.text.length > 0
          ? t`You deleted the marker of footnote ${{ label }} (“${{ text }}”). Its note is still at the end of the scene. Delete the note too?`
          : t`You deleted the marker of footnote ${{ label }}. Its note is still at the end of the scene. Delete the note too?`}
      </p>
      <button type="button" className="button" onClick={onDelete}>
        <Trans>Delete the note</Trans>
      </button>
      <button type="button" className="button is-quiet" onClick={onKeep}>
        <Trans>Keep the note</Trans>
      </button>
    </aside>
  );
}

/**
 * The load banner (editor-engine §3.3 and §5). A block the save will re-style is counted once, and each construct the schema
 * cannot keep is named with its line. Nothing here is an error: the text is kept.
 */
function LoadBanner({ load, onDismiss }: { load: LoadResult; onDismiss: () => void }): ReactNode {
  useLingui();
  const sentences = dialectSentences(load.dialect);
  return (
    <aside className="load-banner" role="status" aria-label={t`About this document's format`}>
      <div className="load-banner-text">
        {sentences.map((sentence) => (
          <p key={sentence}>{sentence}</p>
        ))}
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
