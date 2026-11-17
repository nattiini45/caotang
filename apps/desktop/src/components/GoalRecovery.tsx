/**
 * A durable goal's recovery card (agent-harness §7.2): the run a reload, a crash or a closed tab left behind, with what it was for,
 * the iteration it was on, and the writer's two choices. Nothing here starts a turn: Resume and Discard are both explicit, so a goal
 * never spends a writer's key on its own after a reload.
 */
import { useId, useState, type ReactNode } from 'react';
import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Button } from '@ui-sdk/react/button';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@ui-sdk/react/collapsible';
import { isolate } from '@caotang/i18n';

import type { AgentController, GoalRecoveryView } from '../app/agent.js';
import type { GoalWatchCheck, GoalWatchView } from '../app/goal-watch.js';
import { formatCount } from '../i18n/locale.js';
import { formatUsd } from '../app/plan-preview.js';
import { UserText } from '../i18n/UserText.js';
import './goal-watch.css';

const goalStateWords = (goal: GoalRecoveryView): string =>
  goal.unreadable
    ? t`This goal’s saved progress cannot be read by this version of Caotang.`
    : goal.status === 'interrupted'
      ? t({ message: `It was on iteration ${{ iteration: goal.nextIteration }} when the tab closed, and it has not continued on its own.`, comment: 'iteration is the number of the next iteration in the interrupted goal run.' })
      : goal.status === 'settled'
        ? goal.reason ?? t`It has finished.`
        : t`It may still be running in another tab.`;

export function GoalRecovery({ agent, goals, unavailable, activeGoalId, onResume, compact = false }: { agent: AgentController; goals: readonly GoalRecoveryView[]; unavailable: string | null; activeGoalId: string | null; onResume?: () => void; compact?: boolean }): ReactNode {
  const [busy, setBusy] = useState<string | null>(null);
  const descriptionId = useId();
  const visible = goals.filter((goal) => goal.goalId === activeGoalId || goal.status !== 'running' || unavailable !== null || goal.note !== null);
  const offersResume = (goal: GoalRecoveryView): boolean => goal.resumable || (unavailable !== null && goal.status === 'running' && !goal.unreadable);
  const showUnavailable = unavailable !== null && visible.some(offersResume);
  if (visible.length === 0) return null;
  return (
    <div className="agent-interrupted goal-recovery" data-testid="goal-recovery">
      {showUnavailable ? <p className="muted" id={descriptionId}>{unavailable}</p> : null}
      {visible.map((goal) => {
        const noteId = `${descriptionId}-${encodeURIComponent(goal.goalId)}`;
        const describedBy = [showUnavailable ? descriptionId : null, goal.note === null ? null : noteId].filter(Boolean).join(' ') || undefined;
        return (
          <section key={goal.goalId} className="plan-card is-live interrupted-run" data-testid="goal-recovery-card" data-goal-id={goal.goalId} data-status={goal.status} data-owned={goal.goalId === activeGoalId} data-unreadable={goal.unreadable}>
            <header className="plan-head">
              <h3>{goal.unreadable ? t`This goal cannot be resumed` : goal.goalId === activeGoalId ? t`Goal run in progress` : goal.status === 'running' ? t`A goal run is still marked as running` : goal.status === 'interrupted' ? t`A goal run was interrupted` : t`Goal run finished`}</h3>
            </header>
            <div className="plan-body">
              <p className="goal-intent">{goal.intent === '' ? t`A goal of this project.` : <UserText value={goal.intent} />}</p>
              {goal.goalId === activeGoalId ? null : <p className="muted">{goalStateWords(goal)}</p>}
              {goal.watch === null ? null : <GoalWatch watch={goal.watch} status={goal.outcome ?? goal.status} intent={goal.intent} compact={compact} />}
              {goal.note === null ? null : <p className="plan-notice is-warn" id={noteId}>{goal.note}</p>}
              {goal.goalId === activeGoalId ? null : <div className="confirm-actions">
                {offersResume(goal) ? (
                  <Button
                    type="button"
                    className="button is-primary"
                    disabled={busy !== null || activeGoalId !== null || unavailable !== null || !goal.resumable}
                    focusableWhenDisabled
                    aria-describedby={describedBy}
                    onClick={() => {
                      onResume?.();
                      setBusy(goal.goalId);
                      return agent.resumeGoal(goal.goalId).finally(() => setBusy(null));
                    }}
                    pendingAnnouncement={t`Resuming…`}
                  >
                    <Trans>Resume the goal</Trans>
                  </Button>
                ) : null}
                <Button
                  type="button"
                  className="button"
                  disabled={busy !== null || activeGoalId !== null}
                  focusableWhenDisabled
                  pendingAnnouncement={t`Discarding the goal…`}
                  onClick={() => {
                    setBusy(goal.goalId);
                    return agent.discardGoal(goal.goalId).finally(() => setBusy(null));
                  }}
                >
                  <Trans>Discard the goal record</Trans>
                </Button>
              </div>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function checkLabel(check: GoalWatchCheck): string {
  switch (check.kind) {
    case 'coherence.clean': return t`The selected coherence checks pass`;
    case 'words.between': return t`Every document meets its word bounds`;
    case 'status.all': return t`Every document has the target status`;
    case 'synopsis.filled': return t`Every synopsis is filled`;
    default: return t`This check cannot be read`;
  }
}

function GoalWatch({ watch, status, intent, compact }: { watch: GoalWatchView; status: string; intent: string; compact: boolean }): ReactNode {
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const { spend, limits } = watch;
  const tokens = spend.promptTokens + spend.completionTokens;
  const passed = watch.checks.filter((check) => check.pass === true).length;
  return <section className="goal-watch" aria-label={t({ message: `Goal progress: ${{ intent: isolate(intent) }}`, comment: "intent is the writer’s goal instruction, isolated for bidirectional text." })} data-status={status}>
    <p className="goal-watch-iteration">{watch.maxIterations === null ? t({ message: `Completed iterations: ${{ iterations: formatCount(watch.completedIterations) }}`, comment: "iterations is the number of completed goal iterations." }) : t({ message: `Completed iterations: ${{ iterations: formatCount(watch.completedIterations) }} of ${{ maximum: formatCount(watch.maxIterations) }}`, comment: "iterations is the completed count; maximum is the goal’s iteration limit." })}</p>
    <p>{t({ message: `Passing checks: ${{ passed: formatCount(passed) }} of ${{ total: formatCount(watch.checks.length) }}`, comment: "passed and total count the saved goal check results." })}</p>
    <p className="muted">{t({ message: `Saved model calls: ${{ calls: formatCount(spend.modelCalls) }}`, comment: "calls is the total model-call count saved for this goal." })}{limits.maxModelCalls === undefined ? null : <> / {formatCount(limits.maxModelCalls)}</>}</p>
    <Collapsible open={expanded ?? (!compact && status !== 'running' && status !== 'interrupted')} onOpenChange={setExpanded}>
    <CollapsibleTrigger className="button is-quiet"><Trans>Saved checks and spend</Trans></CollapsibleTrigger>
    <CollapsiblePanel>
    <p className="muted"><Trans>Saved totals for the whole goal</Trans></p>
    <dl className="goal-watch-spend">
      <div><dt><Trans>Model calls</Trans></dt><dd>{limits.maxModelCalls === undefined ? formatCount(spend.modelCalls) : t({ message: `${{ used: formatCount(spend.modelCalls) }} of ${{ limit: formatCount(limits.maxModelCalls) }}`, comment: "used and limit are the recorded amount and its bound; the adjacent label names the unit." })}</dd></div>
      <div><dt><Trans>Tokens</Trans></dt><dd>{limits.maxTokens === undefined ? formatCount(tokens) : t({ message: `${{ used: formatCount(tokens) }} of ${{ limit: formatCount(limits.maxTokens) }}`, comment: "used and limit are the recorded amount and its bound; the adjacent label names the unit." })}</dd></div>
      <div><dt><Trans>Cost</Trans></dt><dd>{spend.costUsd === undefined ? limits.maxCostUsd === undefined ? t`Not priced` : t({ message: `Not priced; limit ${{ limit: formatUsd(limits.maxCostUsd) }}`, comment: "limit is the formatted US-dollar cost bound; recorded usage has no known price." }) : limits.maxCostUsd === undefined ? formatUsd(spend.costUsd) : t({ message: `${{ used: formatUsd(spend.costUsd) }} of ${{ limit: formatUsd(limits.maxCostUsd) }}`, comment: "used and limit are the recorded amount and its bound; the adjacent label names the unit." })}</dd></div>
      <div><dt><Trans>Steps</Trans></dt><dd>{limits.maxSteps === undefined ? formatCount(spend.steps) : t({ message: `${{ used: formatCount(spend.steps) }} of ${{ limit: formatCount(limits.maxSteps) }}`, comment: "used and limit are the recorded amount and its bound; the adjacent label names the unit." })}</dd></div>
      <div><dt><Trans>Active seconds</Trans></dt><dd>{limits.maxActiveMs === undefined ? formatCount(spend.activeMs / 1000) : t({ message: `${{ used: formatCount(spend.activeMs / 1000) }} of ${{ limit: formatCount(limits.maxActiveMs / 1000) }}`, comment: "used and limit are the recorded amount and its bound; the adjacent label names the unit." })}</dd></div>
    </dl>
    {spend.estimatedTokens === 0 ? null : <p className="muted">{t({ message: `Includes ${{ tokens: formatCount(spend.estimatedTokens) }} locally estimated tokens.`, comment: "tokens is the portion of saved token usage estimated locally." })}</p>}
    <div className="goal-watch-table" tabIndex={0} role="region" aria-label={t`Saved goal checks`}>
      <table>
        <caption><Trans>Saved check results. Zero distance passes.</Trans></caption>
        <thead><tr><th scope="col"><Trans>Check</Trans></th><th scope="col"><Trans>Result and distance</Trans></th><th scope="col"><Trans>Recent distances</Trans></th></tr></thead>
        <tbody>{watch.checks.map((check) => {
          const count = check.skipped;
          return <tr key={check.key}>
          <th scope="row">{checkLabel(check)}
            {check.status === undefined ? null : <small><UserText value={check.status} /></small>}
            {check.min === undefined ? null : <small>{t({ message: `At least ${{ words: formatCount(check.min) }} words.`, comment: "words is the minimum word count for each document in this check." })}</small>}
            {check.max === undefined ? null : <small>{t({ message: `At most ${{ words: formatCount(check.max) }} words.`, comment: "words is the maximum word count for each document in this check." })}</small>}
            {check.maxWords === undefined ? null : <small>{t({ message: `At most ${{ words: formatCount(check.maxWords) }} words per synopsis.`, comment: "words is the maximum word count per synopsis in this check." })}</small>}
          </th>
          <td>{check.pass === null ? t`Not measured` : check.pass ? t`Passed` : t`Needs work`}{check.distance === null ? null : <> · {formatCount(check.distance)}</>}
            {count === 0 ? null : <p>{t({ message: `${plural(count, { one: '# check or document was skipped. It is not evidence of a pass.', other: '# checks or documents were skipped. They are not evidence of a pass.' })}`, comment: 'count is the number of skipped checks or documents in the saved result.' })}</p>}
          </td>
          <td>{check.history.length === 0 ? '—' : <bdi dir="ltr">{check.history.length > 4 ? '… ' : ''}{check.history.slice(-4).map((distance) => formatCount(distance)).join(' → ')}</bdi>}</td>
        </tr>;
        })}</tbody>
      </table>
    </div>
    {watch.checks.filter((check) => check.failures.length > 0 || check.history.length > 4).map((check) => <Collapsible key={check.key} className="goal-watch-details">
      <CollapsibleTrigger className="button is-quiet">{t({ message: `Details: ${{ check: checkLabel(check) }}`, comment: "check is the translated name of a deterministic goal check." })}</CollapsibleTrigger>
      <CollapsiblePanel>
        {check.history.length <= 4 ? null : <p><Trans>All saved distances:</Trans> <bdi dir="ltr">{check.history.map((distance) => formatCount(distance)).join(' → ')}</bdi></p>}
        <ul>{check.failures.map((failure, index) => <li key={index}><UserText value={failure.title} />: <UserText value={failure.detail} /></li>)}</ul>
      </CollapsiblePanel>
    </Collapsible>)}
    </CollapsiblePanel>
    </Collapsible>
  </section>;
}
