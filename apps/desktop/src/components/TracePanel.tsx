/**
 * The Trace tab (agent-harness §5.2), beside Activity in the left rail: what each agent turn sent, got back, ran and spent, from the
 * tab's own memory. A turn is a timeline: one row per model call (expandable to the messages it was sent, the reply, the reasoning
 * and the tool calls it asked for), one per tool call with its risk and outcome, and the card decisions between them.
 *
 * Every text on this panel is rendered as text, never as markup: a prompt, a reply or a tool result is whatever the model or the
 * manuscript said. The trace is kept in memory only, so the panel says so, and the only way out is Export trace.
 */

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import { TRACE_REVIEWS, type TraceTurn } from '@caotang/harness';

import { downloadBytes } from '../app/download.js';
import type { AppServices } from '../app/services.js';
import { barSentence, turnTimeline, type TraceCallRow, type TraceMessageView, type TraceRow, type TraceTimeline, type TraceToolRow } from '../app/trace-model.js';
import { traceFileName } from '../app/trace-store.js';
import { EmptyState, formatCount, useReport } from './shared.js';

/** The sentence the export dialog carries: what the file holds, and how far its scrubbing goes. */
export const EXPORT_WARNING =
  'The file contains the prompts and the manuscript text that were sent to the model, and keys are scrubbed on a best-effort basis, so read it before you share it.';

/** A native disclosure whose body is built only while it is open, so a closed prompt of 60 KB costs nothing. */
function Disclosure({ summary, children, open = false, className }: { summary: ReactNode; children: ReactNode; open?: boolean; className?: string }): ReactNode {
  const [shown, setShown] = useState(open);
  return (
    <details className={className} open={shown} onToggle={(event) => setShown(event.currentTarget.open)}>
      <summary>{summary}</summary>
      {shown ? children : null}
    </details>
  );
}

/** The waterfall bar of a row: its place in the turn drawn on a track, with the same thing said in words. */
function Bar({ startMs, durationMs, spanMs }: { startMs: number; durationMs: number | undefined; spanMs: number }): ReactNode {
  const left = Math.min(100, Math.max(0, (startMs / spanMs) * 100));
  const width = Math.min(100 - left, Math.max(1.5, ((durationMs ?? spanMs - startMs) / spanMs) * 100));
  return (
    <>
      <span className="trace-track" aria-hidden="true">
        <span className="trace-bar" style={{ left: `${left}%`, width: `${width}%` }} />
      </span>
      <span className="visually-hidden">{barSentence(startMs, durationMs)}</span>
    </>
  );
}

function ms(value: number | undefined): string {
  return value === undefined ? '…' : `${formatCount(value)} ms`;
}

function MessageView({ message }: { message: TraceMessageView }): ReactNode {
  return (
    <Disclosure
      className="trace-message"
      // The system prompt is the longest and the same on every call, so it starts closed.
      open={message.role !== 'system'}
      summary={
        <>
          <span className="trace-role">{message.role}</span> <span className="trace-faint">{formatCount(message.chars)} characters</span>
        </>
      }
    >
      <pre className="trace-text">{message.text}</pre>
      {message.calls.map((call, index) => (
        <pre key={index} className="trace-text">
          {call}
        </pre>
      ))}
      {message.cut === undefined ? null : <p className="trace-faint">{formatCount(message.cut)} characters of this message were cut to keep the record small.</p>}
    </Disclosure>
  );
}

function CallRow({ row, spanMs }: { row: TraceCallRow; spanMs: number }): ReactNode {
  const tokens =
    row.promptTokens === undefined ? null : `${formatCount(row.promptTokens)} in, ${formatCount(row.completionTokens ?? 0)} out${row.usageSource === 'estimate' ? ' (estimated)' : ''}`;
  return (
    <li className="trace-row is-call" data-testid="trace-call">
      <Disclosure
        summary={
          <>
            <span className="trace-title">
              Model call{row.callIndex === undefined ? '' : ` ${row.callIndex}`}
              {row.agentPath === undefined ? '' : ` · ${row.agentPath}`}
            </span>
            <span className="trace-facts">
              {row.model}
              {row.role === undefined ? '' : ` · ${row.role}`} · {ms(row.durationMs)}
              {row.firstTokenMs === undefined ? '' : ` · first token ${ms(row.firstTokenMs)}`}
              {tokens === null ? '' : ` · ${tokens}`}
              {row.finishReason === undefined ? '' : ` · ${row.finishReason}`}
              {row.attempts !== undefined && row.attempts > 1 ? ` · ${row.attempts} attempts` : ''}
            </span>
            <Bar startMs={row.startMs} durationMs={row.durationMs} spanMs={spanMs} />
          </>
        }
      >
        <div className="trace-detail">
          {row.note === undefined ? null : <p className="trace-faint">{row.note}</p>}
          <h4>Sent: {row.messages.length} messages{row.tools.length === 0 ? '' : `, ${row.tools.length} tools declared`}</h4>
          {row.messages.map((message) => (
            <MessageView key={message.id} message={message} />
          ))}
          {row.tries.length > 1 ? (
            <p className="trace-faint">
              Attempts: {row.tries.map((entry) => `${entry.attempt + 1} ${entry.outcome}${entry.status === undefined ? '' : ` (${entry.status})`}`).join(', ')}
            </p>
          ) : null}
          <h4>Reply</h4>
          {row.error === undefined ? null : <p className="trace-error">{row.error}</p>}
          {row.reply === undefined ? <p className="trace-faint">No reply yet.</p> : <pre className="trace-text">{row.reply === '' ? '(no text)' : row.reply}</pre>}
          {row.replyCalls.map((call, index) => (
            <pre key={index} className="trace-text">
              asked for {call}
            </pre>
          ))}
          {row.reasoning === undefined ? null : (
            <Disclosure className="trace-message" summary="Reasoning">
              <pre className="trace-text">{row.reasoning}</pre>
            </Disclosure>
          )}
          {row.cut === undefined ? null : <p className="trace-faint">{formatCount(row.cut)} characters of this reply were cut to keep the record small.</p>}
        </div>
      </Disclosure>
    </li>
  );
}

function ToolRowView({ row, spanMs }: { row: TraceToolRow; spanMs: number }): ReactNode {
  return (
    <li className="trace-row is-tool" data-testid="trace-tool">
      <Disclosure
        summary={
          <>
            <span className="trace-title">{row.tool}</span>
            <span className="trace-facts">
              <span className={`badge is-risk-${row.risk}`}>{row.risk}</span> {row.outcome ?? 'running'}
              {row.code === undefined ? '' : ` (${row.code})`} · {ms(row.durationMs)}
              {row.agentPath === undefined ? '' : ` · ${row.agentPath}`}
            </span>
            <Bar startMs={row.startMs} durationMs={row.durationMs} spanMs={spanMs} />
          </>
        }
      >
        <div className="trace-detail">
          <h4>Parameters</h4>
          <pre className="trace-text">{row.params}</pre>
          {row.paramsCut === undefined ? null : <p className="trace-faint">{formatCount(row.paramsCut)} characters of these parameters were cut to keep the record small.</p>}
          <h4>Result handed back to the model</h4>
          {row.result === undefined ? <p className="trace-faint">None recorded.</p> : <pre className="trace-text">{row.result}</pre>}
          {row.cut === undefined ? null : <p className="trace-faint">{formatCount(row.cut)} characters of this result were cut to keep the record small.</p>}
        </div>
      </Disclosure>
    </li>
  );
}

function Rows({ rows, spanMs }: { rows: readonly TraceRow[]; spanMs: number }): ReactNode {
  return (
    <ol className="trace-rows">
      {rows.map((row) =>
        row.kind === 'call' ? (
          <CallRow key={row.key} row={row} spanMs={spanMs} />
        ) : row.kind === 'tool' ? (
          <ToolRowView key={row.key} row={row} spanMs={spanMs} />
        ) : (
          <li key={row.key} className={`trace-row is-${row.kind}`}>
            <span className="trace-note-row">{row.text}</span>
          </li>
        ),
      )}
    </ol>
  );
}

const turnName = (turn: TraceTurn): string => (turn.turnId === TRACE_REVIEWS ? 'Reviews' : turn.intent === '' ? turn.turnId : turn.intent);

/** A turn of the trace: its head always, and its timeline while it is open (only one turn is built at a time). */
function TurnBlock({ turn, timeline, onToggle }: { turn: TraceTurn; timeline: TraceTimeline | null; onToggle: () => void }): ReactNode {
  const bodyId = useId();
  const open = timeline !== null;
  return (
    <li className="trace-turn" data-testid="trace-turn">
      <button type="button" className="trace-turn-head" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
        <span className="trace-title">{turnName(turn)}</span>
        <span className="trace-facts">
          {turn.turnId === TRACE_REVIEWS ? 'calls made outside a turn · ' : ''}
          {timeline === null
            ? `${turn.records} records`
            : `${timeline.calls} model ${timeline.calls === 1 ? 'call' : 'calls'} · ${formatCount(timeline.promptTokens + timeline.completionTokens)} tokens${timeline.status === undefined ? '' : ` · ${timeline.status}`}`}
        </span>
      </button>
      <div id={bodyId} hidden={!open}>
        {timeline === null ? null : <Rows rows={timeline.rows} spanMs={timeline.spanMs} />}
      </div>
    </li>
  );
}

/** What the export dialog was asked to export: the selected turn, or everything the tab holds. */
type Scope = 'turn' | 'all';

function ExportDialog({
  open,
  turnLabel,
  onCancel,
  onExport,
}: {
  open: boolean;
  /** The turn "this turn" means, or `null` when none is selected. */
  turnLabel: string | null;
  onCancel: () => void;
  onExport: (scope: Scope, omitText: boolean) => void;
}): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [scope, setScope] = useState<Scope>('turn');
  const [omit, setOmit] = useState(false);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  const chosen: Scope = turnLabel === null ? 'all' : scope;
  return (
    <dialog
      ref={ref}
      className="confirm"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <form method="dialog" className="confirm-body" onSubmit={(event) => event.preventDefault()}>
        <h2 id={titleId}>Export trace</h2>
        <div className="confirm-text">
          <p>{EXPORT_WARNING}</p>
        </div>
        <fieldset className="trace-scope">
          <legend>What to export</legend>
          <label className="check">
            <input type="radio" name="trace-scope" checked={chosen === 'turn'} disabled={turnLabel === null} onChange={() => setScope('turn')} />
            {turnLabel === null ? 'This turn' : `This turn: ${turnLabel}`}
          </label>
          <label className="check">
            <input type="radio" name="trace-scope" checked={chosen === 'all'} onChange={() => setScope('all')} />
            All turns in this tab
          </label>
        </fieldset>
        <label className="check">
          <input type="checkbox" checked={omit} onChange={(event) => setOmit(event.target.checked)} />
          Leave out manuscript text
        </label>
        <p className="trace-faint">
          With this on, every prompt, reply, parameter and result is replaced by its length. Timing, tool names, outcomes and token counts stay.
        </p>
        <div className="confirm-actions">
          <button type="button" className="button" autoFocus onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="button is-primary" onClick={() => onExport(chosen, omit)}>
            Export
          </button>
        </div>
      </form>
    </dialog>
  );
}

export function TracePanel({ services, projectName }: { services: AppServices; projectName: string }): ReactNode {
  const { trace } = services.providers;
  const version = useSyncExternalStore(trace.subscribe, trace.snapshot);
  const settings = useSyncExternalStore(services.settings.subscribe, services.settings.current);
  const report = useReport();
  const kept = settings.agent.keepTraces;
  // `undefined` is the writer's silence: the newest turn is open. `null` is every turn closed.
  const [opened, setOpened] = useState<string | null | undefined>(undefined);
  const [exporting, setExporting] = useState(false);

  const turns = trace.store.turns();
  // Newest first, with the reviews group (always last in the store) at the bottom.
  const ordered = useMemo(() => {
    const own = turns.filter((turn) => turn.turnId !== TRACE_REVIEWS).reverse();
    return [...own, ...turns.filter((turn) => turn.turnId === TRACE_REVIEWS)];
    // `version` changes when the store does; `turns` is read from the store above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  const current = opened === undefined ? (ordered[0]?.turnId ?? null) : ordered.some((turn) => turn.turnId === opened) ? opened : null;

  const timeline = useMemo(
    () => (current === null ? null : turnTimeline(trace.store, current)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, current],
  );

  const doExport = (scope: Scope, omitText: boolean): void => {
    trace.setProject(projectName);
    const turnId = scope === 'turn' ? (current ?? undefined) : undefined;
    const text = trace.export({ ...(turnId === undefined ? {} : { turnId }), omitText });
    const name = traceFileName(projectName, turnId);
    downloadBytes(new TextEncoder().encode(text), name, 'application/x-ndjson');
    setExporting(false);
    report({ text: `Exported the trace as ${name}.`, tone: 'info' });
  };

  const currentTurn = ordered.find((turn) => turn.turnId === current);
  const turnLabel = currentTurn === undefined ? null : turnName(currentTurn);

  return (
    <div className="trace" data-testid="trace-panel">
      <div className="trace-toolbar">
        <label className="check">
          <input type="checkbox" checked={kept} data-testid="trace-keep" onChange={(event) => void services.settings.update({ agent: { keepTraces: event.target.checked } })} />
          Keep agent traces for this tab
        </label>
        <div className="trace-actions">
          <button type="button" className="button is-quiet" disabled={ordered.length === 0} onClick={() => setExporting(true)}>
            Export trace…
          </button>
          <button type="button" className="button is-quiet" disabled={ordered.length === 0} onClick={() => trace.clear()}>
            Clear trace
          </button>
        </div>
      </div>
      <p className="trace-faint">
        The trace holds the prompts and manuscript text sent to the model. It stays in this tab’s memory: a reload or closing the tab loses it, and nothing
        is saved or sent anywhere unless you export it.
      </p>

      {!kept ? (
        <EmptyState title="Traces are off">Turn on “Keep agent traces for this tab” to see what each turn sent and got back. Nothing is recorded while it is off.</EmptyState>
      ) : ordered.length === 0 ? (
        <EmptyState title="No turns traced yet">
          Each agent turn appears here with its prompts, replies, tool calls and timings. Next step: send the agent a request.
        </EmptyState>
      ) : (
        <ol className="trace-turns" aria-label="Traced turns">
          {ordered.map((turn) => (
            <TurnBlock
              key={turn.turnId}
              turn={turn}
              timeline={turn.turnId === current ? timeline : null}
              onToggle={() => setOpened(turn.turnId === current ? null : turn.turnId)}
            />
          ))}
        </ol>
      )}

      <ExportDialog open={exporting} turnLabel={turnLabel} onCancel={() => setExporting(false)} onExport={doExport} />
    </div>
  );
}
