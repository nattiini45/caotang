/**
 * The runs a reload, a crash or a closed tab left unfinished (agent-harness §5.1, "Durable runs and resume"). Each is a region with real
 * buttons and a polite status line, never a modal, so it does not take focus from what the writer was doing.
 *
 * Resume is the writer's click: it can ask a paid model again, and it never starts by itself. A card the run was showing comes back
 * needing its own Approve. Discard log deletes the log and keeps what the run wrote. Whatever stops a resume is said in words, not only
 * by a disabled button.
 */
/* lingui-set comment="Interpolated values: applied is the applied step count; total is the planned step count; steps is localized progress; spend is localized recorded usage; action is the pending run-log operation." */

import { useId, useState, type ReactNode } from 'react';
import { plural, select, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { dateTimeFormat } from '@caotang/i18n';
import { formatterLocale } from '../i18n/format-locale.js';

import type { AgentController, InterruptedRunView } from '../app/agent.js';
import { spendLine } from '../app/agent-model.js';
import { ConfirmDialog } from './shared.js';

export function InterruptedRuns({
  agent,
  runs,
  busy,
  onResume,
  history = false,
}: {
  agent: AgentController;
  runs: readonly InterruptedRunView[];
  busy: boolean;
  /** Called as Resume is pressed, so the panel can open its drawer: the card the run was showing comes back there. */
  onResume: () => void;
  history?: boolean;
}): ReactNode {
  const visible = history ? runs : runs.filter((run) => run.status === undefined || run.status === 'interrupted');
  if (visible.length === 0) return null;
  return (
    <div className="agent-interrupted" data-testid="interrupted-runs">
      {visible.map((run) => (
        <InterruptedRunCard key={run.runId} agent={agent} run={run} busy={busy} onResume={onResume} history={history} />
      ))}
    </div>
  );
}

/** "2 of 4 steps applied", with the run's spend when the log holds one. */
export function progressLine(run: InterruptedRunView): string {
  const total = run.total;
  const steps = total === 0 ? t`No steps had been applied yet` : t`${{ applied: run.applied }} of ${total} ${plural(total, { one: 'step', other: 'steps' })} applied`;
  const spend = typeof run.spend === 'string' || run.spend === null ? run.spend : spendLine(run.spend) ?? null;
  return spend === null ? `${steps}.` : t`${{ steps }}, ${spend}.`;
}

function InterruptedRunCard({ agent, run, busy, onResume, history }: { agent: AgentController; run: InterruptedRunView; busy: boolean; onResume: () => void; history: boolean }): ReactNode {
  useLingui();
  const [prepared, setPrepared] = useState<Awaited<ReturnType<AgentController['prepareRunRestore']>>>(null);
  const [discarding, setDiscarding] = useState(false);
  const titleId = useId();
  const interrupted = run.status === undefined || run.status === 'interrupted';
  const action = run.pending ?? 'other';
  const title = run.outcome === 'stopped' ? t`Agent run stopped` : interrupted ? t`An agent run was interrupted` : run.status === 'failed' ? t`Agent run failed` : run.outcome === 'cancelled' ? t`Agent run cancelled` : t`Agent run finished`;
  return (
    <section className="plan-card is-live interrupted-run" aria-labelledby={titleId} data-testid={history ? 'run-log-card' : 'interrupted-run'} data-run-id={run.runId}>
      <header className="plan-head">
        <h3 id={titleId}>{title}</h3>
      </header>
      {run.createdAt === undefined || Number.isNaN(new Date(run.createdAt).getTime()) ? null : <p className="muted"><time dateTime={new Date(run.createdAt).toISOString()}>{dateTimeFormat(formatterLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(run.createdAt)}</time></p>}
      <p className="interrupted-run-status" role="status" aria-live="polite" data-testid="interrupted-progress">
        “<bdi>{run.intent}</bdi>”: {progressLine(run)}
      </p>
      {run.pending === null || run.pending === undefined ? null : <p className="field-note" role="status">{select(action, { resume: 'Reading the run before resuming…', prepare: 'Saving your edits and checking the restore point…', restore: 'Restoring and saving the project…', export: 'Preparing the run log export…', discard: 'Discarding the local run log…', other: 'Working with the run log…' })}</p>}
      {run.note === null ? null : (
        <p className="plan-notice is-warn" data-testid="interrupted-note">
          {run.resumable ? t`Check first: ` : interrupted ? t`Cannot resume: ` : ''}
          {run.note}
        </p>
      )}
      {interrupted ? <p className="interrupted-run-lost muted">
        <Trans>
        The model call that was in flight when the page closed was lost, and its cost counts as spent. A plan card comes back needing your
        approval again, and the undo for steps already applied did not survive the reload.
        </Trans>
      </p> : null}
      {run.feedback === null || run.feedback === undefined ? null : <p role={run.feedback.tone === 'error' ? 'alert' : 'status'} className={run.feedback.tone === 'error' ? 'form-message is-error' : 'field-note'}>{run.feedback.text}</p>}
      <p className="muted"><Trans>Discard log keeps what the run already wrote. Its restore point is deleted.</Trans></p>
      <div className="plan-actions">
        {interrupted ? (
        <button
          type="button"
          className="button is-primary"
          disabled={!run.resumable || busy}
          onClick={() => {
            onResume();
            void agent.resumeRun(run.runId);
          }}
        >
          <Trans>Resume</Trans>
        </button>
        ) : null}
        {run.restorable === true ? <button type="button" className="button" disabled={busy} onClick={() => { void agent.prepareRunRestore(run.runId).then(setPrepared); }}><Trans>Restore to before this run…</Trans></button> : null}
        <button type="button" className="button" disabled={busy} onClick={() => { if (run.restorable === true) setDiscarding(true); else void agent.discardRun(run.runId); }}><Trans>Discard log</Trans></button>
      </div>
      <details>
        <summary><Trans>Run log and details</Trans></summary>
        <p className="muted"><Trans>The log can contain manuscript and conversation text. Export it only where you want to share that text.</Trans></p>
        <div className="plan-actions">
        <button type="button" className="button" disabled={busy} onClick={() => void agent.exportRun(run.runId, 'jsonl')}><Trans>Export run log as JSONL</Trans></button>
        <button type="button" className="button" disabled={busy} onClick={() => void agent.exportRun(run.runId, 'markdown')}><Trans>Export run log as Markdown</Trans></button>
        </div>
      </details>
      <ConfirmDialog open={discarding} title={t`Discard this run log?`} confirmLabel={t`Discard log`} onCancel={() => setDiscarding(false)} onConfirm={() => { setDiscarding(false); void agent.discardRun(run.runId); }}>
        <p><Trans>Discard log keeps what the run already wrote. Its restore point is deleted.</Trans></p>
      </ConfirmDialog>
      <ConfirmDialog open={prepared !== null} title={t`Restore to before this run?`} confirmLabel={t`Restore project`} onCancel={() => setPrepared(null)} onConfirm={() => { if (prepared !== null) { const held = prepared; setPrepared(null); void agent.restoreRun(run.runId, held); } }}>
        <p><Trans>This restores the project’s content, structure, agent files and findings from before this run. Later edits will be taken back too.</Trans></p>
        <p><Trans>Conversation, recorded spend, exports, picture files and external side effects stay as they are. You can undo this restore while this tab stays open.</Trans></p>
      </ConfirmDialog>
    </section>
  );
}
