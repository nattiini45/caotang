/**
 * The Background tasks section of the agent panel (agent-harness §8): the plans the writer sent to the background, the ones ready to
 * review first (the Inbox). Each row says its status in words, how far it is, what it has used against its cap, and why anything
 * failed. Review opens the staged drafts as a turn on the usual card; nothing is applied from here.
 */

import type { ReactNode } from 'react';

import type { AgentController } from '../app/agent.js';
import type { TaskView } from '../app/task-model.js';

/** Ready rows first, so what waits for the writer is at the top; the rest keep their order. */
function inboxFirst(tasks: readonly TaskView[]): TaskView[] {
  return [...tasks.filter((task) => task.canReview), ...tasks.filter((task) => !task.canReview)];
}

export function BackgroundTasks({ agent, tasks }: { agent: AgentController; tasks: readonly TaskView[] }): ReactNode {
  if (tasks.length === 0) return null;
  return (
    <section className="agent-tasks" aria-label="Background tasks" data-testid="background-tasks">
      <h4>Background tasks</h4>
      <p className="agent-tasks-note muted">A task is drafted only while this project is open in this tab. Nothing is applied until you review it.</p>
      <ul className="agent-task-list">
        {inboxFirst(tasks).map((task) => (
          <li key={task.id} className="agent-task" data-task={task.id} data-status={task.status}>
            <q className="agent-task-intent">{task.intent}</q>
            <p className="agent-task-status" data-testid="task-status">
              {task.statusText}
            </p>
            <p className="agent-task-meta muted">
              {task.done} / {task.total} drafted · {task.used} of {task.cap} model calls · {task.promptTokens + task.completionTokens} tokens
            </p>
            {task.omitted > 0 ? (
              <p className="agent-task-meta">
                {task.omitted === 1 ? '1 document could not be drafted and is left out of the review.' : `${task.omitted} documents could not be drafted and are left out of the review.`}
              </p>
            ) : null}
            {task.errors.length > 0 ? (
              <ul className="agent-task-errors" aria-label="Why drafting failed">
                {task.errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            ) : null}
            <div className="agent-task-actions">
              {task.canReview ? (
                <button type="button" className="button is-primary" onClick={() => void agent.reviewTask(task.id)}>
                  Review
                  <span className="visually-hidden"> {task.intent}</span>
                </button>
              ) : null}
              {task.canResume ? (
                <button type="button" className="button" onClick={() => agent.resumeTask(task.id)}>
                  Resume
                  <span className="visually-hidden"> {task.intent}</span>
                </button>
              ) : null}
              {task.canCancel ? (
                <button type="button" className="button" onClick={() => agent.cancelTask(task.id)}>
                  Cancel
                  <span className="visually-hidden"> {task.intent}</span>
                </button>
              ) : null}
              {task.canDismiss ? (
                <button type="button" className="button is-quiet" onClick={() => agent.dismissTask(task.id)}>
                  Dismiss
                  <span className="visually-hidden"> {task.intent}</span>
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
