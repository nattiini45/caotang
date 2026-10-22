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

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import {
  createTiptapEditorApi,
  type GhostPreview,
  type LoadResult,
  type TiptapEditorInstance,
} from '@caotang/editor/tiptap';
import { countBody, getBody, getRevision } from '@caotang/store';

import { nodeById } from '../app/binder-model.js';
import type { AgentController } from '../app/agent.js';
import type { GhostView } from '../app/agent-model.js';
import { describeLossGroup, reStyleSentence } from '../app/load-banner.js';
import { isOwnWrite } from '../app/integrity-model.js';
import type { ProjectSession } from '../app/session.js';
import { createHistorySaver, loadHistoryJournal } from '../app/history-store.js';
import { registerSelectionReader } from '../app/test-hook.js';
import type { TargetProgress } from '../app/session-progress.js';
import { EmptyState, useReport, useSession, wordsLabel } from './shared.js';
import { TargetQuickSet } from './TargetQuickSet.js';

/** One API for every mount: it holds no state of its own (the instance does). */
const editorApi = createTiptapEditorApi();

const PLACEHOLDER = 'Start the scene. Your words are saved in this browser as you go.';

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
  readonly agent: AgentController;
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
  useSession(session);
  const node = docId === null ? undefined : nodeById(session.state, docId);

  if (docId === null || node === undefined || node.type !== 'document') {
    return (
      <div className="editor-pane is-empty" hidden={!visible}>
        <EmptyState
          title="No document open"
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
          Select a document in the binder, then press Ctrl+Enter or choose Open in editor. Scenes are written here.
          {onNewChapter === undefined ? null : ' A scene goes in a chapter, so make the chapter first.'}
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
  agent: AgentController;
  target: TargetProgress;
  onSetTarget: (words: number) => void;
}): ReactNode {
  useSession(session);
  const report = useReport();
  const snapshot = useSyncExternalStore(agent.subscribe, agent.snapshot);
  const host = useRef<HTMLDivElement>(null);
  // The ghost bar's own element, brought into view when a draft lands (the effect below).
  const barRef = useRef<HTMLElement>(null);
  const [editor, setEditor] = useState<TiptapEditorInstance | null>(null);
  const [load, setLoad] = useState<LoadResult | null>(null);
  const [bannerOpen, setBannerOpen] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  // What the editor agrees with: the body and revision it was last made to hold. A store change that is not this one is the
  // only thing that makes the editor take a new body.
  const synced = useRef<{ body: string; revision: number } | null>(null);

  const stored = getBody(session.state, docId);
  const revision = getRevision(session.state, docId);
  const save = session.autosave.status(docId);
  const counts = countBody(editor === null ? stored : editor.getContent());

  // Mount once per document (the component is keyed by it). The editor opens its document on the session's autosave at the
  // revision the store holds, so the first flush is compared with what was loaded. The ghost's Apply, Retry and Discard
  // answer the agent's decision, through the same controller that owns the turn.
  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    let alive = true;
    let mounted: TiptapEditorInstance | null = null;
    // The undo the writer's last visit left (history-store.ts) is read first, and the body and revision after it, so the editor opens on
    // what the store holds at the moment it mounts. The editor rebuilds the undo only if it replays to that body.
    const saver = createHistorySaver(session.projectId, docId);
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
          placeholder: PLACEHOLDER,
          history: { journal, onChange: saver.onChange },
          ghost: {
            onApply: () => agent.answer({ action: 'approve' }),
            onRetry: () => agent.answer({ action: 'retry' }),
            onDiscard: () => agent.answer({ action: 'cancel' }),
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
          agent.attachGhost(docId, instance.ghost);
          setEditor(instance);
        },
        (error: unknown) => {
          if (alive) setFailure(error instanceof Error ? error.message : String(error));
        },
      );
    return () => {
      alive = false;
      // Teardown flushes the document's pending edit through the autosave (editor-engine §9).
      if (mounted !== null) agent.detachGhost(docId, mounted.ghost);
      mounted?.destroy();
      // The undo journal is written one last time, from what the editor held.
      void saver.dispose();
    };
  }, [session, docId, agent]);

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
          text: `The text could not be brought up to date: ${error instanceof Error ? error.message : String(error)}`,
          tone: 'error',
        });
      });
  }, [editor, stored, revision, session, docId, report]);

  // The scene's ghost region is on screen while this editor is shown. The controller counts a draft as shown only then.
  useEffect(() => {
    agent.setEditorVisible(docId, visible);
    return () => agent.setEditorVisible(docId, false);
  }, [agent, docId, visible]);

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
          <h2 className="editor-title">{title}</h2>
        </header>

        {load !== null && bannerOpen && (load.groups.length > 0 || load.dialect.length > 0) ? (
          <LoadBanner load={load} onDismiss={() => setBannerOpen(false)} />
        ) : null}

        {failure !== null ? (
          <EmptyState title="The editor could not open this document">{failure}</EmptyState>
        ) : null}

        <div ref={host} className="editor-host" />

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

        <footer className="editor-status" aria-label="Document status">
          <span className="editor-count">{wordsLabel(counts.words)}</span>
          <TargetQuickSet progress={target} onSetTarget={onSetTarget} />
          <span className="editor-save" aria-live="polite">
            {save.lastError !== null
              ? 'Not saved yet. Your words are in this tab; they will be written again on the next change.'
              : save.dirty
                ? 'Saving…'
                : 'Saved'}
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
  return (
    <aside ref={barRef} className="ghost-bar" aria-label="Draft preview" data-testid="ghost-bar">
      <p>
        Draft for “{title}”: {wordsLabel(draft.words)}
        {draft.cut ? ', cut off at the model’s output limit' : ''}. Apply writes it into the scene. Retry drafts it again. Discard leaves the
        scene as it is.
      </p>
      <div className="ghost-actions">
        <button type="button" className="button is-primary" disabled={!live || !approvable || !ghost.canApply()} onClick={() => ghost.apply()}>
          Apply
        </button>
        <button type="button" className="button" disabled={!live} onClick={() => ghost.retry()}>
          Retry
        </button>
        <button type="button" className="button is-quiet" disabled={!live} onClick={() => ghost.discard()}>
          Discard
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
  const blocks = load.dialect.length;
  return (
    <aside className="load-banner" role="status" aria-label="About this document's format">
      <div className="load-banner-text">
        {blocks > 0 ? <p>{reStyleSentence(blocks)}</p> : null}
        {load.groups.length > 0 ? (
          <>
            <p>Saving will not keep these constructs exactly:</p>
            <ul>
              {load.groups.map((group) => (
                <li key={`${group.code}:${group.mdastType}:${group.line ?? 'none'}`}>{describeLossGroup(group)}</li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
      <button type="button" className="button is-quiet" onClick={onDismiss}>
        Dismiss
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
  surface.setAttribute('aria-label', 'Document text');
  surface.setAttribute('aria-multiline', 'true');
}
