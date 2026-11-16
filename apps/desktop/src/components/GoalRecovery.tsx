/**
 * A durable goal's recovery card (agent-harness §7.2): the run a reload, a crash or a closed tab left behind, with what it was for,
 * the iteration it was on, and the writer's two choices. Nothing here starts a turn: Resume and Discard are both explicit, so a goal
 * never spends a writer's key on its own after a reload.
 */
import { useId, useState, type ReactNode } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Button } from '@ui-sdk/react/button';

import type { AgentController, GoalRecoveryView } from '../app/agent.js';
import { UserText } from '../i18n/UserText.js';

const goalStateWords = (goal: GoalRecoveryView): string =>
  goal.unreadable
    ? t`This goal’s saved progress cannot be read by this version of Caotang.`
    : goal.status === 'interrupted'
      ? t({ message: `It was on iteration ${{ iteration: goal.nextIteration }} when the tab closed, and it has not continued on its own.`, comment: 'iteration is the number of the next iteration in the interrupted goal run.' })
      : goal.status === 'settled'
        ? goal.reason ?? t`It has finished.`
        : t`It may still be running in another tab.`;

export function GoalRecovery({ agent, goals, unavailable }: { agent: AgentController; goals: readonly GoalRecoveryView[]; unavailable: string | null }): ReactNode {
  const [busy, setBusy] = useState<string | null>(null);
  const descriptionId = useId();
  const visible = goals.filter((goal) => goal.status !== 'running' || unavailable !== null || goal.note !== null);
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
          <section key={goal.goalId} className="plan-card is-live interrupted-run" data-testid="goal-recovery-card" data-goal-id={goal.goalId} data-status={goal.status}>
            <header className="plan-head">
              <h3>{goal.unreadable ? t`This goal cannot be resumed` : goal.status === 'running' ? t`A goal run is still marked as running` : goal.status === 'interrupted' ? t`A goal run was interrupted` : t`Goal run finished`}</h3>
            </header>
            <div className="plan-body">
              <p className="goal-intent">{goal.intent === '' ? t`A goal of this project.` : <UserText value={goal.intent} />}</p>
              <p className="muted">{goalStateWords(goal)}</p>
              {goal.note === null ? null : <p className="plan-notice is-warn" id={noteId}>{goal.note}</p>}
              <div className="confirm-actions">
                {offersResume(goal) ? (
                  <Button
                    type="button"
                    className="button is-primary"
                    disabled={busy !== null || unavailable !== null || !goal.resumable}
                    focusableWhenDisabled
                    aria-describedby={describedBy}
                    onClick={() => {
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
                  disabled={busy !== null}
                  focusableWhenDisabled
                  pendingAnnouncement={t`Discarding the goal…`}
                  onClick={() => {
                    setBusy(goal.goalId);
                    return agent.discardGoal(goal.goalId).finally(() => setBusy(null));
                  }}
                >
                  <Trans>Discard the goal record</Trans>
                </Button>
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}
