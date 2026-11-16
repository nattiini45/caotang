/**
 * A durable goal's recovery card (agent-harness §7.2): the run a reload, a crash or a closed tab left behind, with what it was for,
 * the iteration it was on, and the writer's two choices. Nothing here starts a turn: Resume and Discard are both explicit, so a goal
 * never spends a writer's key on its own after a reload.
 */
import { useState, type ReactNode } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';

import type { AgentController, GoalRecoveryView } from '../app/agent.js';

const goalStateWords = (goal: GoalRecoveryView): string =>
  goal.unreadable
    ? t`This goal’s saved progress cannot be read by this version of Caotang.`
    : goal.status === 'interrupted'
      ? t`It was on iteration ${{ iteration: goal.nextIteration }} when the tab closed, and it has not continued on its own.`
      : goal.status === 'settled'
        ? goal.reason ?? t`It has finished.`
        : t`It was running.`;

export function GoalRecovery({ agent, goals }: { agent: AgentController; goals: readonly GoalRecoveryView[] }): ReactNode {
  const [busy, setBusy] = useState<string | null>(null);
  const visible = goals.filter((goal) => goal.status !== 'running');
  if (visible.length === 0) return null;
  return (
    <div className="agent-interrupted" data-testid="goal-recovery">
      {visible.map((goal) => (
        <section key={goal.goalId} className="plan-card is-live interrupted-run" data-testid="goal-recovery-card" data-goal-id={goal.goalId} data-status={goal.status}>
          <header className="plan-head">
            <h3>{goal.status === 'interrupted' ? t`A goal run was interrupted` : t`Goal run finished`}</h3>
          </header>
          <div className="plan-body">
            <p className="goal-intent">{goal.intent === '' ? t`A goal of this project.` : goal.intent}</p>
            <p className="muted">{goalStateWords(goal)}</p>
            <div className="confirm-actions">
              {goal.resumable ? (
                <button
                  type="button"
                  className="button is-primary"
                  disabled={busy !== null}
                  onClick={() => {
                    setBusy(goal.goalId);
                    void agent.resumeGoal(goal.goalId).finally(() => setBusy(null));
                  }}
                >
                  {busy === goal.goalId ? t`Resuming…` : t`Resume the goal`}
                </button>
              ) : null}
              <button
                type="button"
                className="button"
                disabled={busy !== null}
                onClick={() => {
                  setBusy(goal.goalId);
                  void agent.discardGoal(goal.goalId).finally(() => setBusy(null));
                }}
              >
                <Trans>Discard the goal record</Trans>
              </button>
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}