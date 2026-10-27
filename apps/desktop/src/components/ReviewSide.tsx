/**
 * The editor pane's side of apply-then-review (editor-engine §15), kept out of the pane so a writer who never turns the mode on does not
 * load it. The pane renders it only for a document opened in review mode, and imports `reportLanding` when an agent edit lands there.
 */

import { useEffect, type ReactNode } from 'react';
import type { AgentEditOutcome } from '@caotang/editor';
import type { TiptapEditorInstance } from '@caotang/editor/tiptap';

import type { AgentController } from '../app/agent.js';
import { activeAppDb } from '../app/app-db.js';
import { recordPending, takePending } from '../app/review-notice.js';
import { pendingNotice } from '../app/review-text.js';
import { ReviewBar } from './ReviewBar.js';
import type { Report } from './shared.js';

/**
 * Hands the open editor's review calls to the agent controller, so a turn's card can show and resolve its suggestions, and notes what is
 * left marked in this document. The marks live only in the editor and the store holds the accepted text, so what is left when the editor
 * goes is noted per document and the next open says so once (review-notice.ts). Returns the function that ends both.
 */
function startReview(projectId: string, docId: string, agent: AgentController, editor: TiptapEditorInstance, report: Report): () => void {
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
  const { review } = editor;
  const hold = (): void => {
    const entries = review.state().byToolCall.map((entry) => ({ turnId: agent.turnOf(entry.toolCallId), toolCallId: entry.toolCallId, pending: entry.pending }));
    const pending = new Map<string, number>();
    for (const { turnId, pending: count } of entries) if (turnId !== null) pending.set(turnId, (pending.get(turnId) ?? 0) + count);
    agent.setReview(docId, {
      views: [...pending].map(([turnId, count]) => ({ turnId, pending: count })),
      resolve: (turnId, mode) =>
        entries.reduce((sum, entry) => (entry.turnId !== turnId ? sum : sum + (mode === 'accept' ? review.acceptToolCall(entry.toolCallId) : review.rejectToolCall(entry.toolCallId))), 0),
    });
  };
  const stop = review.subscribe(() => {
    note();
    hold();
  });
  hold();
  return () => {
    live = false;
    stop();
    agent.setReview(docId, null);
  };
}

/** The review bar and the hold on the open editor's marks, for as long as the editor is open. */
export function ReviewSide({
  projectId,
  docId,
  agent,
  editor,
  report,
}: {
  projectId: string;
  docId: string;
  agent: AgentController;
  editor: TiptapEditorInstance;
  report: Report;
}): ReactNode {
  useEffect(() => startReview(projectId, docId, agent, editor, report), [projectId, docId, agent, editor, report]);
  return <ReviewBar review={editor.review} />;
}

/** Says why an agent edit replaced the text instead of being marked, when it did for a reason the writer should hear. */
export function reportLanding(outcome: AgentEditOutcome, report: Report): void {
  if (outcome.landed !== 'replaced' || outcome.reason === 'off' || outcome.reason === 'superseded') return;
  report({
    text:
      outcome.reason === 'unsaved'
        ? 'The agent’s edit replaced the text instead of marking it, because this scene had typing that was not saved yet.'
        : 'The agent’s edit could not be marked for review, so it replaced the text. Nothing was lost: ‘restore to before this turn’ is in the activity log.',
    tone: 'info',
  });
}
