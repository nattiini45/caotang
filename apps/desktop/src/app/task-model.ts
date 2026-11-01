/**
 * What the agent panel shows of a background task (agent-harness §8, "Background tasks"): a view built from the task's record and the
 * project as it stands, with the status in words. Pure, so the words are tested without a browser.
 */

import { t } from '@lingui/core/macro';
import { staleSteps } from '@caotang/harness';
import { isolate } from '@caotang/i18n';
import type { ProjectState } from '@caotang/store';

import { reviewOf, type TaskRecord, type TaskStatus } from './task-store.js';

/* lingui-set comment="Interpolated values: done, intent, outdated, staged, total" */

export interface TaskView {
  readonly id: string;
  readonly intent: string;
  readonly status: TaskStatus;
  /** The status in a sentence, so it never rests on colour. */
  readonly statusText: string;
  /** Items finished (drafted or failed), of all. */
  readonly done: number;
  readonly total: number;
  readonly used: number;
  readonly cap: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** Why items failed, in the provider's words, without repeats. */
  readonly errors: readonly string[];
  /** Steps of a ready task whose drafts are out of date now: the review marks them and cannot approve them. */
  readonly outdated: number;
  /** Documents of a synopsis step that could not be drafted and are left out of the review. */
  readonly omitted: number;
  readonly canReview: boolean;
  readonly canCancel: boolean;
  readonly canResume: boolean;
  readonly canDismiss: boolean;
}

function statusText(task: TaskRecord, done: number, total: number, outdated: number): string {
  switch (task.status) {
    case 'queued':
      return t`Waiting to start`;
    case 'running':
      return t`Drafting: ${{ done }} of ${{ total }} done`;
    case 'ready': {
      const staged = task.items.filter((item) => item.state === 'staged').length;
      return outdated > 0
        ? t`Ready to review: ${{ staged }} of ${{ total }} drafted, ${{ outdated }} out of date`
        : t`Ready to review: ${{ staged }} of ${{ total }} drafted`;
    }
    case 'failed':
      return t`Failed: nothing could be drafted`;
    case 'cancelled':
      return t`Cancelled`;
    case 'interrupted':
      return t`Stopped when the project was closed: ${{ done }} of ${{ total }} done. Resume to finish it`;
    case 'applied':
      return t`Applied`;
  }
}

/** The view of one task. The out-of-date count reads the project now, so it is current whenever the panel is redrawn. */
export function viewOf(task: TaskRecord, state: ProjectState): TaskView {
  const total = task.items.length;
  const done = task.items.filter((item) => item.state !== 'pending').length;
  let outdated = 0;
  let omitted = 0;
  if (task.status === 'ready') {
    const review = reviewOf(task);
    omitted = review.omitted;
    outdated = staleSteps(state, review.steps, review.proposals, review.revisions).filter(Boolean).length;
  }
  const errors = [...new Set(task.items.flatMap((item) => (item.error === undefined ? [] : [item.error])))].slice(0, 3);
  return {
    id: task.id,
    intent: task.intent,
    status: task.status,
    statusText: statusText(task, done, total, outdated),
    done,
    total,
    used: task.used,
    cap: task.cap,
    promptTokens: task.promptTokens,
    completionTokens: task.completionTokens,
    errors,
    outdated,
    omitted,
    canReview: task.status === 'ready',
    canCancel: task.status === 'queued' || task.status === 'running',
    canResume: task.status === 'interrupted',
    canDismiss: task.status !== 'queued' && task.status !== 'running',
  };
}

/** What a screen reader hears when a task changes status, or an empty string when the change needs no words. */
export function announcementFor(task: TaskRecord): string {
  switch (task.status) {
    case 'ready':
      return t`A background task is ready to review: ${{ intent: isolate(task.intent) }}`;
    case 'failed':
      return t`A background task failed: ${{ intent: isolate(task.intent) }}`;
    case 'interrupted':
      return t`A background task was stopped: ${{ intent: isolate(task.intent) }}`;
    default:
      return '';
  }
}
