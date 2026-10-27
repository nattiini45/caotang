/**
 * The editor pane's side of apply-then-review (editor-engine §15), kept out of the pane so a writer who never turns the mode on does not
 * load it. The pane imports this module on use: when a document opens in review mode, and when an agent edit could not be marked.
 */

import type { TiptapEditorInstance } from '@caotang/editor/tiptap';

import type { AgentController } from '../app/agent.js';
import { activeAppDb } from '../app/app-db.js';
import { recordPending, takePending } from '../app/review-notice.js';
import { pendingNotice } from '../app/review-text.js';
import type { Report } from './shared.js';

/**
 * Hands the open editor's review calls to the agent controller, so a turn's card can show and resolve its suggestions, and notes what is
 * left marked in this document. The marks live only in the editor and the store holds the accepted text, so what is left when the editor
 * goes is noted per document and the next open says so once (review-notice.ts). Returns the function that ends both.
 */
export function startReview(projectId: string, docId: string, agent: AgentController, editor: TiptapEditorInstance, report: Report): () => void {
  let live = true;
  // What was left marked when this document was last closed is said once.
  void takePending(projectId, docId, activeAppDb()).then((left) => {
    if (left !== null && live) report({ text: pendingNotice(left.count), tone: 'info' });
  });
  const note = (): void => {
    const state = editor.review.state();
    const last = state.byToolCall[state.byToolCall.length - 1];
    void recordPending(projectId, docId, state.pending, last === undefined ? null : agent.turnOf(last.toolCallId), activeAppDb());
  };
  const stop = editor.review.subscribe(note);
  agent.attachReview(docId, editor.review);
  return () => {
    live = false;
    stop();
    agent.detachReview(docId, editor.review);
  };
}

/** Why an agent edit replaced the text and was not marked, for the notice that says so. */
export function replacedNotice(reason: 'unsaved' | 'diff' | 'mismatch'): string {
  return reason === 'unsaved'
    ? 'The agent’s edit replaced the text instead of marking it, because this scene had typing that was not saved yet.'
    : 'The agent’s edit could not be marked for review, so it replaced the text. Nothing was lost: ‘restore to before this turn’ is in the activity log.';
}
