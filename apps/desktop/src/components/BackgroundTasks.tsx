import { Trans } from '@lingui/react/macro';
import { plural, t } from '@lingui/core/macro';
import { isolate } from '@caotang/i18n';
import { useEffect, useRef, type ReactNode } from 'react';
import { Button } from '@ui-sdk/react/button';

import type { AgentController } from '../app/agent.js';
import type { TaskView } from '../app/task-model.js';
import { formatCount } from '../i18n/locale.js';
import { UserText } from '../i18n/UserText.js';

/* lingui-set comment="Background task and Inbox status. Counts describe drafts, calls, tokens or findings; titles and model labels are supplied text." */

interface TaskSectionProps {
  readonly agent: AgentController;
  readonly tasks: readonly TaskView[];
  readonly headingLevel?: 3 | 4;
  readonly onOpenFindings?: (taskId: string, runId: string) => void | Promise<void>;
  readonly focusTask?: { readonly taskId: string; readonly serial: number } | null;
  readonly onTaskFocused?: () => void;
}

function TaskList({ agent, tasks, onAction, onOpenFindings }: TaskSectionProps & { readonly onAction: (button: HTMLElement, id: string) => void }): ReactNode {
  return (
    <ul className="agent-task-list">
      {tasks.map((task) => {
        const findingCount = task.report?.findingsCount ?? 0;
        return (
        <li key={task.id} className="agent-task" data-task={task.id} data-status={task.status} data-state={task.status} data-review-phase={task.reviewPhase ?? undefined} data-review-done={task.reviewProgress?.done} data-review-total={task.reviewProgress?.total}>
          <q className="agent-task-intent"><UserText value={task.intent} /></q>
          <p className="agent-task-status" data-testid="task-status" tabIndex={-1}>{task.statusText}</p>
          <p className="agent-task-meta muted">
            {task.kind !== 'draft'
              ? task.total === 0
                ? t`Call allowance: ${{ used: formatCount(task.used) }} of ${{ cap: formatCount(task.cap) }} reserved or used.`
                : t`${{ done: formatCount(task.done) }} / ${{ total: formatCount(task.total) }} drafted · Call allowance: ${{ used: formatCount(task.used) }} of ${{ cap: formatCount(task.cap) }} reserved or used.`
              : t`${{ done: formatCount(task.done) }} / ${{ total: formatCount(task.total) }} drafted · ${{ used: formatCount(task.used) }} of ${{ cap: formatCount(task.cap) }} model calls · ${{ tokens: formatCount(task.promptTokens + task.completionTokens) }} tokens`}
          </p>
          {task.kind !== 'draft' && task.report === null ? <p className="agent-task-meta muted"><Trans>No review report has been published. Recorded usage may be incomplete.</Trans></p> : null}
          {task.report !== null ? (
            <div className="agent-task-report" data-testid="task-review-report">
              {task.kind === 'review' && task.status === 'completed' ? null : <p className="agent-task-status">{task.report.outcome === 'partial'
                ? t`Partial review: ${plural(findingCount, { one: '# finding recorded.', other: '# findings recorded.' })}`
                : t`Review complete: ${plural(findingCount, { one: '# finding recorded.', other: '# findings recorded.' })}`}</p>}
              <p className="agent-task-meta">{t`Reviewed: ${{ titles: task.report.scopeTitles.map(isolate).join(', ') }}.`}</p>
              <p className="agent-task-meta"><Trans>Background model:</Trans> <UserText value={task.report.routeLabel} /></p>
              <p className="agent-task-meta">{task.report.usage.source === 'unknown'
                ? t`Review calls recorded: ${{ calls: formatCount(task.report.usage.modelCalls) }}. Token usage is incomplete.`
                : t`Review usage: ${{ calls: formatCount(task.report.usage.modelCalls) }} model calls · ${{ prompt: formatCount(task.report.usage.promptTokens) }} tokens in, ${{ completion: formatCount(task.report.usage.completionTokens) }} out.`}</p>
              <p className="agent-task-meta muted">{task.report.usage.source === 'reported'
                ? t`The review’s token counts were reported by the provider.`
                : task.report.usage.source === 'estimated'
                  ? t`The review’s token counts include estimates.`
                  : t`Review usage is incomplete: some request outcomes or token counts are unknown.`}</p>
              <p className="agent-task-meta"><Trans>This review did not change manuscript text.</Trans></p>
              {task.report.outcome === 'partial' ? <p className="agent-task-meta"><Trans>Some review work did not finish. See the findings report before deciding whether to start a new review.</Trans></p> : null}
              {task.needsForegroundReview ? <p className="agent-task-meta"><Trans>The other steps still wait for your approval.</Trans></p> : null}
              {task.kind === 'mixed' && !task.needsForegroundReview && task.status !== 'applied' ? <p className="agent-task-meta"><Trans>The other steps have not been applied.</Trans></p> : null}
              <p className="agent-task-meta muted">{task.unread ? t`Unread review report` : t`Review report opened`}</p>
            </div>
          ) : null}
          {task.omitted > 0 ? (
            <p className="agent-task-meta">
              {task.omitted === 1
                ? t`A document could not be drafted and is left out of the review.`
                : t`${{ count: formatCount(task.omitted) }} documents could not be drafted and are left out of the review.`}
            </p>
          ) : null}
          {task.errors.length > 0 ? (
            <ul className="agent-task-errors" aria-label={task.kind === 'draft' ? t`Why drafting failed` : t`Why the task stopped`}>
              {task.errors.map((error) => <li key={error}><UserText value={error} /></li>)}
            </ul>
          ) : null}
          <div className="agent-task-actions">
            {task.report !== null ? (
              <Button className="button" disabled={onOpenFindings === undefined} data-open-findings="" onClick={(event) => {
                onAction(event.currentTarget, task.id);
                return task.report === null ? undefined : onOpenFindings?.(task.id, task.report.runId);
              }}>
                <Trans>See findings</Trans><span className="visually-hidden"> <UserText value={task.intent} /></span>
              </Button>
            ) : null}
            {task.canReview ? (
              <Button className="button is-primary" pendingAnnouncement="" onClick={(event) => {
                onAction(event.currentTarget, task.id);
                return agent.reviewTask(task.id);
              }}>
                <Trans>Review</Trans><span className="visually-hidden"> <UserText value={task.intent} /></span>
              </Button>
            ) : null}
            {task.canResume ? (
              <Button className="button" onClick={(event) => {
                onAction(event.currentTarget, task.id);
                return agent.resumeTask(task.id);
              }}>
                <Trans>Resume</Trans><span className="visually-hidden"> <UserText value={task.intent} /></span>
              </Button>
            ) : null}
            {task.canCancel ? (
              <Button className="button" onClick={(event) => {
                onAction(event.currentTarget, task.id);
                return agent.cancelTask(task.id);
              }}>
                <Trans>Cancel</Trans><span className="visually-hidden"> <UserText value={task.intent} /></span>
              </Button>
            ) : null}
            {task.canDismiss ? (
              <Button className="button is-quiet" data-agent-confirm={t`Removes this task from the queue and Inbox. Published findings stay.`} onClick={(event) => {
                onAction(event.currentTarget, task.id);
                return agent.dismissTask(task.id);
              }}>
                <Trans>Dismiss</Trans><span className="visually-hidden"> <UserText value={task.intent} /></span>
              </Button>
            ) : null}
          </div>
        </li>
        );
      })}
    </ul>
  );
}

export function BackgroundTasks({ agent, tasks, headingLevel = 4, onOpenFindings, focusTask = null, onTaskFocused }: TaskSectionProps): ReactNode {
  const panelsRef = useRef<HTMLDivElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const recoveryRef = useRef<{ readonly element: HTMLElement; readonly id: string; readonly next?: string; readonly previous?: string } | null>(null);
  useEffect(() => {
    const recovery = recoveryRef.current;
    if (recovery === null || recovery.element === document.activeElement) return;
    recoveryRef.current = null;
    if (recovery.element.isConnected || !document.hasFocus() || (document.activeElement !== document.body && document.activeElement !== null)) return;
    const rows = [...(panelsRef.current?.querySelectorAll<HTMLElement>('[data-task]') ?? [])];
    const row = [recovery.id, recovery.next, recovery.previous].flatMap((id) => rows.filter((element) => element.dataset.task === id))[0];
    (row?.querySelector<HTMLElement>('button:not(:disabled)') ?? row?.querySelector<HTMLElement>('[data-testid="task-status"]') ?? headingRef.current)?.focus();
  }, [tasks]);
  useEffect(() => {
    if (focusTask === null) return;
    const row = [...(panelsRef.current?.querySelectorAll<HTMLElement>('[data-task]') ?? [])].find((element) => element.dataset.task === focusTask.taskId);
    const target = row?.querySelector<HTMLElement>('[data-open-findings]') ?? row?.querySelector<HTMLElement>('button') ?? headingRef.current;
    target?.scrollIntoView({ block: 'nearest' });
    target?.focus();
    onTaskFocused?.();
  }, [focusTask, onTaskFocused]);
  const rememberFocus = (button: HTMLElement, id: string): void => {
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement) || button.closest('[data-task]')?.contains(focused) !== true) return;
    const rows = [...(panelsRef.current?.querySelectorAll<HTMLElement>('[data-task]') ?? [])];
    const index = rows.findIndex((row) => row.dataset.task === id);
    const next = rows[index + 1]?.dataset.task;
    const previous = rows[index - 1]?.dataset.task;
    recoveryRef.current = { element: focused, id, ...(next === undefined ? {} : { next }), ...(previous === undefined ? {} : { previous }) };
  };
  const ready = tasks.filter((task) => task.canReview);
  const drafts = ready.filter((task) => task.total > 0);
  const deferred = ready.filter((task) => task.total === 0);
  const reports = tasks.filter((task) => !task.canReview && task.report !== null);
  const active = tasks.filter((task) => !task.canReview && task.report === null);
  const Heading = headingLevel === 3 ? 'h3' : 'h4';
  const GroupHeading = headingLevel === 3 ? 'h4' : 'h5';
  return (
    <div ref={panelsRef} className="agent-task-panels" data-testid={tasks.length === 0 ? undefined : 'background-tasks'} data-empty={ready.length + reports.length === 0 && active.length === 0 ? '' : undefined}>
      <section className="agent-tasks agent-review-inbox" aria-label={t`Review Inbox`} data-testid="review-inbox">
        <Heading ref={headingRef} tabIndex={-1}><Trans>Review Inbox</Trans></Heading>
        <p className="agent-tasks-note muted">{ready.length + reports.length === 0
          ? t`No drafts or review reports are waiting.`
          : t`Drafts wait for your approval. Review reports show findings already recorded; dismissing a report keeps its findings.`}</p>
        {drafts.length === 0 ? null : <>
          <GroupHeading className="agent-inbox-group-title">{t`Drafts ready for approval (${{ count: formatCount(drafts.length) }})`}</GroupHeading>
          <TaskList agent={agent} tasks={drafts} onAction={rememberFocus} onOpenFindings={onOpenFindings} />
        </>}
        {deferred.length === 0 ? null : <>
          <GroupHeading className="agent-inbox-group-title">{t`Other steps ready for review (${{ count: formatCount(deferred.length) }})`}</GroupHeading>
          <TaskList agent={agent} tasks={deferred} onAction={rememberFocus} onOpenFindings={onOpenFindings} />
        </>}
        {reports.length === 0 ? null : <>
          <GroupHeading className="agent-inbox-group-title">{t`Review reports (${{ count: formatCount(reports.length) }})`}</GroupHeading>
          <TaskList agent={agent} tasks={reports} onAction={rememberFocus} onOpenFindings={onOpenFindings} />
        </>}
      </section>
      {active.length === 0 ? null : (
        <section className="agent-tasks" aria-label={t`Background tasks`} data-testid="active-background-tasks">
          <Heading><Trans>Background tasks</Trans></Heading>
          <p className="agent-tasks-note muted"><Trans>Background work runs only while this project is open in this tab.</Trans></p>
          <TaskList agent={agent} tasks={active} onAction={rememberFocus} onOpenFindings={onOpenFindings} />
        </section>
      )}
    </div>
  );
}
