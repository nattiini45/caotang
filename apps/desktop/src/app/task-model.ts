/**
 * What the agent panel shows of a background task (agent-harness §8, "Background tasks"): a view built from the task's record and the
 * project as it stands, with the status in words. Pure, so the words are tested without a browser.
 */

import { plural, t } from '@lingui/core/macro';
import { staleSteps } from '@caotang/harness';
import { isolate } from '@caotang/i18n';
import type { ProjectState } from '@caotang/store';

import { reviewOf, type TaskRecord, type TaskQueueStatus, type TaskKind, type TaskReviewPhase, type TaskReviewReport } from './task-store.js';

/* lingui-set comment="Interpolated values: done, intent, outdated, staged, total" */

export interface TaskView {
  readonly id: string;
  readonly intent: string;
  readonly status: TaskQueueStatus;
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
  readonly kind: TaskKind;
  readonly needsForegroundReview: boolean;
  readonly reviewPhase: TaskReviewPhase | null;
  readonly reviewProgress: { readonly done: number; readonly total: number } | null;
  readonly report: TaskReviewReport | null;
  readonly unread: boolean;
  readonly acknowledged: boolean;
}

function statusText(task: TaskRecord, phase: TaskQueueStatus, done: number, total: number, outdated: number): string {
  const kind = task.kind ?? 'draft';
  const isReview = kind === 'review';
  switch (phase) {
    case 'queued':
    case 'starting':
      return t`Waiting to start`;
    case 'cancelling':
      return t`Cancelling…`;
    case 'running':
      if (task.reviewPhase !== undefined) {
        if (task.reviewPhase === 'publishing') return t`Publishing the review…`;
        const doneCalls = task.reviewProgress?.done ?? 0;
        const totalCalls = task.reviewProgress?.total ?? 0;
        return task.reviewPhase === 'extracting'
          ? t`Reviewing: extracting ${{ doneCalls }} of ${{ totalCalls }}`
          : t`Reviewing: verifying ${{ doneCalls }} of ${{ totalCalls }}`;
      }
      if (isReview) return t`Preparing the review.`;
      return task.used === 0 ? t`Preparing the next draft.` : t`Drafting: ${{ done }} of ${{ total }} done`;
    case 'ready': {
      const draftItems = task.items.filter((item) => task.steps[item.step]?.tool !== 'coherence.review');
      const draftTotal = draftItems.length;
      const staged = draftItems.filter((item) => item.state === 'staged').length;
      if (kind === 'mixed' && draftTotal === 0) {
        return (task.report ?? null) === null
          ? t`The review did not publish. Its other steps are ready for review.`
          : t`The review is published. Its other steps are ready for review.`;
      }
      return outdated > 0
        ? t`Ready to review: ${{ staged }} of ${{ draftTotal }} drafted, ${{ outdated }} out of date`
        : t`Ready to review: ${{ staged }} of ${{ draftTotal }} drafted`;
    }
    case 'failed':
      return isReview ? t`Failed: the review could not run` : t`Failed: nothing could be drafted`;
    case 'cancelled':
      return t`Cancelled`;
    case 'interrupted':
      return isReview
        ? t`Stopped when the project was closed. Resume to finish the review`
        : t`Stopped when the project was closed: ${{ done }} of ${{ total }} done. Resume to finish it`;
    case 'applied':
      return t`Applied`;
    case 'completed': {
      const count = task.report?.findingsCount ?? 0;
      return task.report?.outcome === 'partial'
        ? t`Review partial: ${plural(count, { one: '# finding', other: '# findings' })} published`
        : t`Review complete: ${plural(count, { one: '# finding', other: '# findings' })} published`;
    }
  }
}

/** The view of one task. The out-of-date count reads the project now, so it is current whenever the panel is redrawn. */
export function viewOf(task: TaskRecord & { readonly phase?: TaskQueueStatus }, state: ProjectState): TaskView {
  const phase = task.phase ?? task.status;
  const draftItems = task.items.filter((item) => task.steps[item.step]?.tool !== 'coherence.review');
  const total = draftItems.length;
  const done = draftItems.filter((item) => item.state !== 'pending').length;
  let outdated = 0;
  let omitted = 0;
  if (task.status === 'ready') {
    const review = reviewOf(task);
    omitted = review.omitted;
    outdated = staleSteps(state, review.steps, review.proposals, review.revisions).filter(Boolean).length;
  }
  const errors = [...new Set(task.items.flatMap((item) => (item.error === undefined ? [] : [item.error])))].slice(0, 3);
  const kind = task.kind ?? 'draft';
  const report = task.report ?? null;
  const acknowledged = task.acknowledged ?? false;
  return {
    id: task.id,
    intent: task.intent,
    status: phase,
    statusText: statusText(task, phase, done, total, outdated),
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
    canCancel: phase === 'queued' || phase === 'starting' || phase === 'running',
    canResume: phase === 'interrupted',
    canDismiss: phase !== 'queued' && phase !== 'starting' && phase !== 'running' && phase !== 'cancelling',
    kind,
    needsForegroundReview: kind !== 'review' && task.status === 'ready',
    reviewPhase: phase === 'running' ? (task.reviewPhase ?? null) : null,
    reviewProgress: task.reviewProgress ?? null,
    report,
    unread: report !== null && !acknowledged,
    acknowledged,
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
    case 'cancelled':
      return t`A background task was cancelled: ${{ intent: isolate(task.intent) }}`;
    case 'completed':
      return t`A background review is complete: ${{ intent: isolate(task.intent) }}`;
    default:
      return '';
  }
}
