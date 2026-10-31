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

import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import {
  createTiptapEditorApi,
  type FootnoteOrphan,
  type GhostPreview,
  type LoadResult,
  type TiptapEditorInstance,
} from '@caotang/editor/tiptap';
import { countBody, getBody, getRevision } from '@caotang/store';

import { activeAppDb } from '../app/app-db.js';
import { nodeById } from '../app/binder-model.js';
import type { AgentController } from '../app/agent.js';
import type { GhostView } from '../app/agent-model.js';
import { describeLossGroup, reStyleSentence } from '../app/load-banner.js';
import { isOwnWrite } from '../app/integrity-model.js';
import { takePending } from '../app/review-notice.js';
import { pendingNotice } from '../app/review-text.js';
import type { ProjectSession } from '../app/session.js';
import { createHistorySaver, loadHistoryJournal } from '../app/history-store.js';
import type { AgentEditMode } from '../app/settings.js';
import { registerSelectionReader } from '../app/test-hook.js';
import type { TargetProgress } from '../app/session-progress.js';
import { EmptyState, useReport, useSession, wordsLabel } from './shared.js';
import { TargetQuickSet } from './TargetQuickSet.js';

/** The review bar and the hold on the marks are fetched only by an editor in review mode (Settings > Writing), so the default path does not carry them. */
const ReviewSide = lazy(() => import('./ReviewSide.js').then((module) => ({ default: module.ReviewSide })));

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
      agentEditMode={agentEditMode}
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
  agent: AgentController;
  target: TargetProgress;
  onSetTarget: (words: number) => void;
  agentEditMode: AgentEditMode;
}): ReactNode {
  useSession(session);
  const report = useReport();
  // The mode this editor was opened with. The mount effect reads it once, so a change in Settings applies to the next document.
  const [modeAtOpen] = useState(agentEditMode);
  const snapshot = useSyncExternalStore(agent.subscribe, agent.snapshot);
  const host = useRef<HTMLDivElement>(null);
  // The ghost bar's own element, brought into view when a draft lands (the effect below).
  const barRef = useRef<HTMLElement>(null);
  const [editor, setEditor] = useState<TiptapEditorInstance | null>(null);
  const [load, setLoad] = useState<LoadResult | null>(null);
  const [bannerOpen, setBannerOpen] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  // The note whose last marker the writer just deleted (editor-engine §3.4): the editor keeps it, and this asks whether it goes too.
  const [orphan, setOrphan] = useState<FootnoteOrphan | null>(null);
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
          agentEditMode: modeAtOpen,
          onFootnoteOrphaned: (orphans) => {
            if (alive) setOrphan(orphans[orphans.length - 1] ?? null);
          },
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
  }, [session, docId, agent, modeAtOpen]);

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
    const apply = agent.consumeApply(docId, revision);
    const landing =
      apply !== null && modeAtOpen === 'suggestions'
        ? editor.showAgentEdit(stored, { toolCallId: apply.toolCallId, revision }).then((outcome) => import('./ReviewSide.js').then((module) => module.reportLanding(outcome, report)))
        : editor.setContent(stored, { historyExcluded: true, discardUnsaved: true });
    landing
      .then(() => {
        editor.setRevision(revision);
        // The body was replaced from outside (an undo, a restore, an agent apply): a question about a note in the old body is stale.
        setOrphan(null);
      })
      .catch((error: unknown) => {
        report({
          text: `The text could not be brought up to date: ${error instanceof Error ? error.message : String(error)}`,
          tone: 'error',
        });
      });
  }, [editor, stored, revision, session, docId, report, agent, modeAtOpen]);

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

        {editor !== null && orphan !== null ? (
          <FootnoteQuestion
            orphan={orphan}
            onDelete={() => {
              // The note is the one the question named, followed by the editor since; a refusal changes nothing and is said.
              const outcome = editor.deleteFootnoteNote(orphan);
              setOrphan(null);
              if (outcome !== 'deleted') report({ text: footnoteKeptNotice(outcome), tone: 'info' });
              editor.focus();
            }}
            onKeep={() => {
              setOrphan(null);
              editor.focus();
            }}
          />
        ) : null}

        {editor !== null && modeAtOpen === 'suggestions' ? (
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

        <footer className="editor-status" aria-label="Document status">
          <span className="editor-count">{wordsLabel(counts.words)}</span>
          {editor !== null ? (
            <button
              type="button"
              className="button is-quiet editor-footnote"
              aria-keyshortcuts="Control+Shift+6 Meta+Shift+6"
              title="Add a footnote at the caret (Ctrl+Shift+6). The same keys in a note go back to the text."
              onClick={() => editor.insertFootnote()}
            >
              Add footnote
            </button>
          ) : null}
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

/** What the writer is told when answering "Delete the note" changed nothing. */
function footnoteKeptNotice(outcome: 'referenced' | 'gone'): string {
  return outcome === 'referenced'
    ? 'The note was kept: a marker refers to it again.'
    : 'The note was kept: it was changed or is no longer there.';
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
  const preview = orphan.text.length > 0 ? ` (“${orphan.text.length > 80 ? `${orphan.text.slice(0, 79)}…` : orphan.text}”)` : '';
  return (
    <aside className="footnote-question" role="status" aria-label="Footnote without a marker" data-testid="footnote-question">
      <p>
        You deleted the marker of footnote {orphan.label}
        {preview}. Its note is still at the end of the scene. Delete the note too?
      </p>
      <button type="button" className="button" onClick={onDelete}>
        Delete the note
      </button>
      <button type="button" className="button is-quiet" onClick={onKeep}>
        Keep the note
      </button>
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
