/**
 * The runs a reload, a crash or a closed tab left unfinished (agent-harness §5.1, "Durable runs and resume"). Each is a region with real
 * buttons and a polite status line, never a modal, so it does not take focus from what the writer was doing.
 *
 * Resume is the writer's click: it can ask a paid model again, and it never starts by itself. A card the run was showing comes back
 * needing its own Approve. Discard log deletes the log and keeps what the run wrote. Whatever stops a resume is said in words, not only
 * by a disabled button.
 */

import type { ReactNode } from 'react';

import type { AgentController, InterruptedRunView } from '../app/agent.js';

export function InterruptedRuns({
  agent,
  runs,
  busy,
  onResume,
}: {
  agent: AgentController;
  runs: readonly InterruptedRunView[];
  busy: boolean;
  /** Called as Resume is pressed, so the panel can open its drawer: the card the run was showing comes back there. */
  onResume: () => void;
}): ReactNode {
  if (runs.length === 0) return null;
  return (
    <div className="agent-interrupted" data-testid="interrupted-runs">
      {runs.map((run) => (
        <InterruptedRunCard key={run.runId} agent={agent} run={run} busy={busy} onResume={onResume} />
      ))}
    </div>
  );
}

/** "2 of 4 steps applied", with the run's spend when the log holds one. */
export function progressLine(run: InterruptedRunView): string {
  const steps = run.total === 0 ? 'No steps had been applied yet' : `${run.applied} of ${run.total} ${run.total === 1 ? 'step' : 'steps'} applied`;
  return run.spend === null ? `${steps}.` : `${steps}, ${run.spend}.`;
}

function InterruptedRunCard({ agent, run, busy, onResume }: { agent: AgentController; run: InterruptedRunView; busy: boolean; onResume: () => void }): ReactNode {
  const titleId = `interrupted-${run.runId}`;
  return (
    <section className="plan-card is-live interrupted-run" aria-labelledby={titleId} data-testid="interrupted-run" data-run-id={run.runId}>
      <header className="plan-head">
        <h3 id={titleId}>An agent run was interrupted</h3>
      </header>
      <p className="interrupted-run-status" role="status" aria-live="polite" data-testid="interrupted-progress">
        “{run.intent}”: {progressLine(run)}
      </p>
      {run.note === null ? null : (
        <p className="plan-notice is-warn" data-testid="interrupted-note">
          {run.resumable ? 'Check first: ' : 'Cannot resume: '}
          {run.note}
        </p>
      )}
      <p className="interrupted-run-lost muted">
        The model call that was in flight when the page closed was lost, and its cost counts as spent. A plan card comes back needing your
        approval again, and the undo for steps already applied did not survive the reload.
      </p>
      <div className="plan-actions">
        <button
          type="button"
          className="button is-primary"
          disabled={!run.resumable || busy}
          onClick={() => {
            onResume();
            void agent.resumeRun(run.runId);
          }}
        >
          Resume
        </button>
        <button type="button" className="button" disabled={busy} onClick={() => void agent.discardRun(run.runId)}>
          Discard log
        </button>
      </div>
      <p className="muted">Discard log keeps what the run already wrote.</p>
    </section>
  );
}
