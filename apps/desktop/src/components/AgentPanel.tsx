/**
 * The agent panel (agent-harness §8, ui-modules §1): a drawer under the editor, where the writer states an intent and reads
 * what the agent did. Every turn is a block in order: the provider it ran on, its status cards, its plan or confirm card, any
 * ask-back, its findings, its checkpoint row and its report. The ghost draft is not here; it is shown in the editor, where it
 * will land.
 *
 * The Intent box stays open while a turn runs (agent-harness §8, "Stop and steer"): Enter queues what is typed as the next turn,
 * Ctrl+Enter sends it to the running turn as a note, and Stop (or Escape, with the box empty) stops the turn.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import {
  CHECKPOINT_LABEL,
  MODE_LABELS,
  groupCards,
  headerLineOf,
  phraseFor,
  type AskBack,
  type Decision,
  type Finding,
  type PermissionMode,
  type StatusCard,
  type TurnReport,
} from '@caotang/harness';
import type { ProjectState } from '@caotang/store';

import { DEMO_CHOICES } from '../app/demo.js';
import { askBackOptions, delegationViewOf, elapsedOf, formatElapsed, isSettled, MODE_HINTS, phaseLabel, spendLine, type DelegationCardView, type TurnView } from '../app/agent-model.js';
import { formatUsd, turnCostOf } from '../app/plan-preview.js';
import { resolveKey, shortcutLabel } from '../app/keymap.js';
import { providerLabel } from '../app/provider-label.js';
import type { AgentController, AgentSnapshot } from '../app/agent.js';
import type { RecurringTasks } from '../app/recurring-tasks.js';
import type { StartIntent } from '../App.js';
import type { ProjectSession } from '../app/session.js';
import { useAssetRecords } from '../media/hooks.js';
import { ConfirmDialog, EmptyState, useReport, useSession } from './shared.js';
import { AgentQueue, type HeldNote } from './AgentQueue.js';
import { openDialog } from './dialog-requests.js';
import { PlanCard, planHeading } from './PlanCard.js';
import { PlanOfferCard } from './PlanOfferCard.js';
import { BackgroundTasks } from './BackgroundTasks.js';
import { RecurringTasksPanel } from './RecurringTasks.js';
import { TaskOffers } from './TaskOffers.js';
import { InterruptedRuns } from './InterruptedRuns.js';
import { TaskChecklist } from './TaskChecklist.js';

export interface AgentPanelProps {
  readonly session: ProjectSession;
  readonly agent: AgentController;
  /** The project's recurring tasks (agent-harness.md §12). */
  readonly recurring: RecurringTasks;
  readonly startIntent: StartIntent | null;
  readonly open: boolean;
  readonly onToggle: () => void;
  /** The project is a sample the first-run card made, so the demo intents are offered here. */
  readonly sample: boolean;
}

/** A restore the writer is asked to confirm: the turn, what it did, and the later changes the restore would also take back. */
interface PendingRestore {
  readonly turnId: string;
  readonly summary: string;
  readonly later: readonly string[];
}

export function AgentPanel({ session, agent, recurring, startIntent, open, onToggle, sample }: AgentPanelProps): ReactNode {
  useSession(session);
  const snapshot = useSyncExternalStore(agent.subscribe, agent.snapshot);
  const report = useReport();
  // The pictures' file names, by id: a codex step's visual references are shown by name on its card (plan-preview.ts).
  // The images are listed when they can have changed, not on every change of the session (media/hooks.ts).
  const pictures = useAssetRecords(session.assets.artifactFs(), session.assetsVersion());
  const pictureNames = useMemo(() => new Map([...pictures.values()].map((picture) => [picture.id, picture.fileName] as const)), [pictures]);
  const waitingSkills = session.skills().waiting;
  const [intent, setIntent] = useState('');
  const [restoring, setRestoring] = useState<PendingRestore | null>(null);
  // A note the writer wrote while a card waits, until they choose what happens to it and the card.
  const [held, setHeld] = useState<HeldNote | null>(null);
  const handled = useRef(0);
  const intentRef = useRef<HTMLInputElement>(null);

  // A demo run that the first-run card started: the shell submits its intent once, when the panel is there. Every start is a
  // demo intent, so it runs on the built-in demo profile.
  useEffect(() => {
    if (startIntent === null || startIntent.serial === handled.current) return;
    handled.current = startIntent.serial;
    void agent.submit(startIntent.intent, { demo: true });
  }, [agent, startIntent]);

  useEffect(() => {
    if (snapshot.message !== null) report({ text: snapshot.message, tone: 'error' });
  }, [snapshot.message, report]);

  // The note is held for one showing of one card: when that card is decided or shown again, the choice goes with it.
  const cardKey = snapshot.pending === null ? null : `${snapshot.pending.turnId}:${snapshot.pending.card.id}:${snapshot.pending.card.revision}`;
  const heldNow = held !== null && held.cardKey === cardKey ? held : null;

  // Enter: send when no turn runs, queue as the next turn when one does.
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const text = intent.trim();
    if (text === '') return;
    setIntent('');
    if (snapshot.busy) agent.enqueue(text);
    else void agent.submit(text);
  };

  // Ctrl+Enter: send the text to the running turn as a note. While a card waits, the writer chooses what happens to the card first.
  const steer = (): void => {
    const text = intent.trim();
    if (text === '') return;
    const result = agent.steer(text);
    if (result === 'sent') setIntent('');
    else if (result === 'card-waiting' && cardKey !== null) {
      setHeld({ text, cardKey });
      setIntent('');
    } else if (result === 'idle') {
      setIntent('');
      void agent.submit(text);
    }
  };

  const onPanelKey = (event: ReactKeyboardEvent<HTMLElement>): void => {
    // A dialog inside the panel (the restore confirmation) has Escape for itself.
    const target = event.target;
    if (event.defaultPrevented || (target instanceof HTMLElement && target.closest('dialog') !== null)) return;
    const action = resolveKey(
      { key: event.key, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey, alt: event.altKey },
      {
        inTextField: target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement,
        inBinder: false,
        inAgent: true,
        agentIntentEmpty: intent.trim() === '',
        inAgentIntent: target === intentRef.current,
      },
    );
    if (action === 'agent-stop' && snapshot.stoppable) {
      event.preventDefault();
      agent.stop();
    } else if (action === 'agent-steer') {
      event.preventDefault();
      steer();
    }
  };

  const confirmRestore = (): void => {
    if (restoring === null) return;
    const target = restoring.turnId;
    setRestoring(null);
    void agent.restore(target).then((outcome) => {
      if (!outcome.ok) report({ text: outcome.message, tone: 'error' });
      else report({ text: restoredLine(outcome.later), tone: 'info' });
    });
  };

  const provider = snapshot.providerName;
  const running = snapshot.turns[snapshot.turns.length - 1];
  const stepLine = running === undefined || isSettled(running) ? null : headerLineOf(running.tasks);
  const spend = running === undefined || isSettled(running) ? undefined : spendLine(running.run);
  return (
    <section className={`agent${open ? ' is-open' : ''}`} aria-label="Agent" data-testid="agent-panel" onKeyDown={onPanelKey}>
      <header className="agent-head">
        {/* aria-controls names the body only while the body is rendered: a closed drawer has no element with that id. */}
        <button type="button" className="button is-quiet agent-toggle" aria-expanded={open} aria-controls={open ? 'agent-body' : undefined} onClick={onToggle}>
          {open ? 'Hide the agent' : 'Agent'}
        </button>
        <span className="agent-provider" data-testid="agent-provider">
          {provider === null ? 'No provider' : `Provider: ${providerLabel(provider, snapshot.providerIsDemo)}`}
        </span>
        {/* The permission mode (agent-harness §4): a radio group named by its visible label, in the header so it shows with the drawer closed too. */}
        <fieldset className="agent-mode" data-testid="agent-mode">
          <legend>Mode</legend>
          {snapshot.modes.map((mode) => (
            <label key={mode} className={`agent-mode-option${snapshot.mode === mode ? ' is-on' : ''}`} title={MODE_HINTS[mode]}>
              <input type="radio" name="agent-mode" value={mode} checked={snapshot.mode === mode} onChange={() => agent.setMode(mode)} />
              <span>{MODE_LABELS[mode]}</span>
            </label>
          ))}
        </fieldset>
        {/* A card that waits for the writer is the turn's state, not work: the turn is still open, so Send stays off, but the header says so. */}
        {/* The step line names where the turn is, with the drawer open or closed. It is a live region that polite-announces a change
            of step, not each streamed word: the line is derived from the task list and only moves when the step does. */}
        {snapshot.pending !== null || snapshot.busy ? (
          <span className="agent-busy" role="status" aria-live="polite" data-testid="agent-step">
            {stepLine ?? (snapshot.pending !== null ? 'Waiting for you' : 'Working…')}
          </span>
        ) : null}
        {/* What the run has used of the limits the writer set: tokens, cost, steps and time worked, after each model call. */}
        {spend === undefined || (!snapshot.busy && snapshot.pending === null) ? null : (
          <span className="agent-spend" data-testid="agent-spend">
            {spend}
          </span>
        )}
        {snapshot.stoppable ? (
          <button
            type="button"
            className="button is-danger agent-stop"
            data-testid="agent-stop"
            disabled={snapshot.stopping}
            title={`Stop the turn (${shortcutLabel('agent-stop')} with the Intent box empty)`}
            onClick={() => agent.stop()}
          >
            {snapshot.stopping ? 'Stopping…' : 'Stop'}
          </button>
        ) : null}
        {/* What Stop, a note or the queue just did, for a screen reader: a status the header's step line does not carry. */}
        <p className="visually-hidden" role="status" aria-live="polite" data-testid="agent-announcement">
          {snapshot.announcement}
        </p>
      </header>

      {/* An unfinished run is shown with the drawer closed too: it is the first thing the writer has to decide after a reload. */}
      <InterruptedRuns agent={agent} runs={snapshot.interrupted} busy={snapshot.busy} onResume={() => (open ? undefined : onToggle())} />

      {/* A task that is due waits for the writer's answer, so its offer is shown with the drawer closed too. */}
      <TaskOffers recurring={recurring} />

      {open ? (
        <div id="agent-body" className="agent-body">
          <form className="agent-intent" onSubmit={submit}>
            <label>
              <span className="visually-hidden">Intent</span>
              <input
                ref={intentRef}
                type="text"
                aria-label="Intent"
                placeholder={
                  snapshot.busy
                    ? `${shortcutLabel('agent-send')} queues it for the next turn, ${shortcutLabel('agent-steer')} sends it to this one`
                    : 'Ask the agent to draft, fill, or check something'
                }
                value={intent}
                disabled={snapshot.providerName === null}
                onChange={(event) => setIntent(event.target.value)}
              />
            </label>
            <button type="submit" className="button is-primary" disabled={intent.trim() === '' || snapshot.providerName === null}>
              {snapshot.busy ? 'Queue' : 'Send'}
            </button>
            {snapshot.busy ? (
              <button type="button" className="button" disabled={intent.trim() === '' || snapshot.providerName === null} onClick={steer}>
                Steer
              </button>
            ) : null}
          </form>

          {/* Skills the writer has not read and approved are not offered to the agent (extensibility.md §10). The panel says how many wait. */}
          {waitingSkills > 0 ? (
            <p className="agent-skills-note" data-testid="agent-skills-note">
              {waitingSkills === 1 ? '1 skill is waiting for you to approve it, so the agent cannot use it yet. ' : `${waitingSkills} skills are waiting for you to approve them, so the agent cannot use them yet. `}
              <button type="button" className="status-link" onClick={() => openDialog({ kind: 'skills' })}>
                Review skills
              </button>
            </p>
          ) : null}

          <AgentQueue agent={agent} snapshot={snapshot} held={heldNow} cardKey={cardKey} onHold={setHeld} onRelease={() => setHeld(null)} />

          <BackgroundTasks agent={agent} tasks={agent.taskViews()} />

          <RecurringTasksPanel recurring={recurring} />

          {snapshot.offer !== null ? <PlanOfferCard agent={agent} view={snapshot.offer} /> : null}

          {sample && snapshot.turns.length === 0 ? (
            <div className="agent-demos" role="group" aria-label="Demo intents">
              {DEMO_CHOICES.map((choice) => (
                <button key={choice.intent} type="button" className="button" disabled={snapshot.busy} onClick={() => void agent.submit(choice.intent, { demo: true })}>
                  {choice.label}
                </button>
              ))}
            </div>
          ) : null}

          {snapshot.turns.length === 0 ? (
            <EmptyState title="The agent has not run yet">
              Ask it to draft a scene, fill the synopses of a chapter, or check the manuscript for continuity. It proposes each
              change first, and nothing is written until you approve it.
            </EmptyState>
          ) : (
            <ol className="agent-turns" aria-label="Turns">
              {snapshot.turns.map((turn) => (
                <TurnBlock
                  key={turn.turnId}
                  turn={turn}
                  snapshot={snapshot}
                  project={session.state}
                  pictureNames={pictureNames}
                  stands={turn.checkpoint !== null && session.undo.group(turn.checkpoint.undoGroupId) !== undefined}
                  onDecide={(decision) => agent.answer(decision)}
                  onRestore={(turnId, summary) => setRestoring({ turnId, summary, later: agent.laterChanges(turnId) })}
                  onRunHeld={(turnId) => void agent.runHeldPlan(turnId)}
                />
              ))}
            </ol>
          )}
        </div>
      ) : null}

      <ConfirmDialog
        open={restoring !== null}
        title="Restore to before this turn?"
        confirmLabel="Restore"
        onCancel={() => setRestoring(null)}
        onConfirm={confirmRestore}
      >
        <p>
          This restores the project to its state before this turn{restoring?.summary ? `: ${restoring.summary}` : ''}. Your edits since then
          are included in the restore.
        </p>
        {restoring !== null && restoring.later.length > 0 ? (
          <>
            <p>It also takes back these later changes, oldest first:</p>
            <ul aria-label="Later changes">
              {restoring.later.map((line, index) => (
                <li key={`${index}:${line}`}>{line}</li>
              ))}
            </ul>
          </>
        ) : null}
      </ConfirmDialog>
    </section>
  );
}

/** What a finished restore says: how many later changes went back with the turn, if any. */
function restoredLine(later: number): string {
  if (later === 0) return 'Restored to before that turn.';
  return `Restored to before that turn. ${later} later ${later === 1 ? 'change was' : 'changes were'} taken back with it.`;
}

function TurnBlock({
  turn,
  snapshot,
  project,
  pictureNames,
  stands,
  onDecide,
  onRestore,
  onRunHeld,
}: {
  turn: TurnView;
  snapshot: AgentSnapshot;
  /** The open project, which a plan card reads its previews against. */
  project: ProjectState;
  /** The project's pictures by asset id, as their file names (a codex step names its visual references by these). */
  pictureNames: ReadonlyMap<string, string>;
  /** The turn's checkpoint is still on the undo stack, so it can be restored. */
  stands: boolean;
  onDecide: (decision: Decision) => void;
  onRestore: (turnId: string, summary: string) => void;
  /** Switches to Ask and runs the writes Plan only refused in the turn. */
  onRunHeld: (turnId: string) => void;
}): ReactNode {
  const live = snapshot.pending !== null && snapshot.pending.turnId === turn.turnId;
  const settled = isSettled(turn);
  return (
    <li className={`agent-turn is-${turn.phase}`} data-turn={turn.turnId}>
      <header className="agent-turn-head">
        <q className="agent-intent-text">{turn.intent}</q>
        {turn.mode === null ? null : (
          <span className="agent-turn-mode muted" data-testid="turn-mode">
            {MODE_LABELS[turn.mode]}
          </span>
        )}
        <span className="agent-phase" aria-live="polite">
          {settled
            ? turn.report?.stop !== undefined
              ? 'Stopped by you'
              : turn.report?.status === 'applied'
                ? 'Applied'
                : turn.report?.status === 'replied'
                  ? 'Answered'
                  : phaseLabel(turn.phase)
            : phaseLabel(turn.phase)}
        </span>
      </header>
      <TaskChecklist list={turn.tasks} settled={settled} />
      {turn.provider !== null ? <p className="agent-on muted">Ran on {turn.provider}</p> : null}

      {!settled && turn.streamed !== '' ? <p className="agent-stream">{turn.streamed}</p> : null}

      {/* The model's thinking channel, kept collapsed and muted (provider-gateway §6/D12): it is the turn's record,
          so it stays after the turn settles — never in the editor, never inline-expanded. */}
      {turn.reasoning !== '' ? (
        <details className="agent-reasoning" data-testid="agent-thinking">
          <summary>Thinking</summary>
          <p className="agent-reasoning-text">{turn.reasoning}</p>
        </details>
      ) : null}

      {turn.context !== null && turn.context.dropped.length > 0 ? (
        <details className="agent-context">
          <summary>{turn.context.dropped.length} context {turn.context.dropped.length === 1 ? 'item' : 'items'} left out</summary>
          <ul>
            {turn.context.dropped.map((reason, index) => (
              <li key={`${index}:${reason}`}>{reason}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {turn.cards.length > 0 ? <StatusCards cards={turn.cards} /> : null}

      {turn.steering.length > 0 ? (
        <ul className="agent-notes" aria-label="Notes you sent during this turn">
          {turn.steering.map((note) => (
            <li key={note.noteId}>
              <span className="muted">You added:</span> {note.text}
            </li>
          ))}
        </ul>
      ) : null}

      {turn.plan !== null && turn.planAuto ? (
        // A card the mode approved is collapsed, with its badge: the writer was not asked, and can open it to read what ran.
        <details className="plan-auto" data-testid="plan-auto">
          <summary>
            {planHeading(turn.plan)} <span className="badge is-auto">Auto-approved</span>
          </summary>
          <PlanCard key={turn.planSeq} card={turn.plan} live={false} drafts={null} project={project} pictureNames={pictureNames} onDecide={onDecide} auto />
        </details>
      ) : turn.plan !== null ? (
        // Keyed on the showing, so every field of the card is read again from the card the loop holds (agent-harness §2).
        <PlanCard key={turn.planSeq} card={turn.plan} live={live} drafts={live ? snapshot.drafts : null} project={project} pictureNames={pictureNames} onDecide={onDecide} />
      ) : null}

      {turn.report?.heldSteps !== undefined && !snapshot.heldRun.includes(turn.turnId) ? (
        <HeldPlan report={turn.report} disabled={snapshot.busy} onRun={() => onRunHeld(turn.turnId)} />
      ) : null}

      {turn.ladder.map((entry) => (
        <AskBackCard key={`${entry.callId}:${entry.attempt}`} askBack={entry.askBack} />
      ))}

      {turn.findings.length > 0 ? <FindingsList findings={turn.findings} /> : null}

      {turn.report?.askBack !== undefined ? <AskBackCard askBack={turn.report.askBack} /> : null}

      {turn.checkpoint !== null ? (
        <CheckpointRow
          undoGroupId={turn.checkpoint.undoGroupId}
          mode={turn.checkpoint.mode}
          note={turn.checkpoint.note}
          taken={!stands}
          onRestore={() => onRestore(turn.turnId, turn.report?.summary ?? '')}
          disabled={snapshot.busy}
        />
      ) : null}

      {turn.report !== null ? <ReportLine report={turn.report} price={turn.price} /> : null}
    </li>
  );
}

/** The status cards of one turn, consecutive calls grouped (agent-harness §8). */
export function StatusCards({ cards }: { cards: readonly StatusCard[] }): ReactNode {
  const items = groupCards(cards);
  return (
    <ol className="status-cards" aria-label="Tool calls">
      {items.map((item) =>
        item.kind === 'card' ? (
          <li key={item.card.id}>
            <StatusCardRow card={item.card} />
          </li>
        ) : (
          <li key={item.cards[0]?.id ?? item.turnId}>
            <details className="status-group" open={item.expanded}>
              <summary>
                {item.cards.length} calls · {item.expanded ? 'running' : 'done'}
              </summary>
              {item.cards.map((card) => (
                <StatusCardRow key={card.id} card={card} />
              ))}
            </details>
          </li>
        ),
      )}
    </ol>
  );
}

const STATUS_WORDS: Readonly<Record<StatusCard['status'], string>> = {
  'pending-approval': 'Waiting for approval',
  running: 'Running',
  done: 'Done',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

function StatusCardRow({ card }: { card: StatusCard }): ReactNode {
  const delegation = delegationViewOf(card);
  return (
    <article className={`status-card is-${card.status}`} data-tool={card.tool} data-status={card.status}>
      <header className="status-card-head">
        <code>{card.tool}</code>
        <span className={`badge is-risk-${card.risk.replace(/[^a-z]+/g, '-')}`}>{card.risk}</span>
        <span className={`status-pill is-${card.status}`}>{STATUS_WORDS[card.status]}</span>
        <ElapsedTime card={card} />
      </header>
      {delegation === undefined ? null : <DelegationBlock view={delegation} />}
      {card.summary !== undefined || card.error !== undefined ? (
        // The result is collapsed once the call is done, and open when it failed, so the reason is in front of the writer.
        <details className="status-card-result" open={card.error !== undefined}>
          <summary>{card.error === undefined ? 'Result' : 'Why it did not run'}</summary>
          <p className={card.error === undefined ? 'status-card-text' : 'status-card-text is-error'}>{card.error ?? card.summary}</p>
        </details>
      ) : null}
      <details className="status-card-args">
        <summary>Arguments</summary>
        <pre>{JSON.stringify(card.args, null, 2)}</pre>
      </details>
    </article>
  );
}

/**
 * A delegated agent's part of its call's card (agent-harness §8): its name and reserved calls beside a word for how it stands, then
 * three disclosures, each a native `<details>` so the keyboard and a screen reader reach them: the brief it was given, its notes,
 * and its own trace rows. The call's summary and arguments stay below, as on every card.
 */
function DelegationBlock({ view }: { view: DelegationCardView }): ReactNode {
  return (
    <section className="delegation" aria-label={view.title}>
      <p className="delegation-line">
        <strong>{view.title}</strong>
        <span className="muted">{view.reserved}</span>
        <span className="delegation-standing">{view.standing}</span>
      </p>
      <details className="delegation-brief">
        <summary>Brief</summary>
        <p className="status-card-text">{view.brief}</p>
        {view.scope.length > 0 ? <p className="status-card-text muted">Starts from: {view.scope.join(', ')}</p> : null}
      </details>
      {view.result === undefined ? null : (
        <details className="delegation-result">
          <summary>Notes</summary>
          <p className="status-card-text">{view.result === '' ? 'The agent gave no notes.' : view.result}</p>
        </details>
      )}
      {view.proposed === undefined ? null : <p className="status-card-text delegation-proposed">{view.proposed}</p>}
      {view.trace.length === 0 ? null : (
        <details className="delegation-trace">
          <summary>Transcript ({view.trace.length})</summary>
          <ol>
            {view.trace.map((row) => (
              <li key={row.key}>{row.text}</li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

/** A call's elapsed time: live while it runs, fixed once it finishes, and absent until it starts (agent-harness §8). */
function ElapsedTime({ card }: { card: StatusCard }): ReactNode {
  const running = card.startedAt !== undefined && card.finishedAt === undefined;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  const elapsed = elapsedOf(card, now);
  if (elapsed === undefined) return null;
  return <span className="status-card-elapsed">{formatElapsed(elapsed)}</span>;
}

const ASKBACK_TITLES: Readonly<Record<AskBack['code'], string>> = {
  needs_input: 'Needs your input',
  conflict: 'The text changed under this draft',
  verify_failed: 'The change did not check out',
  anchor_unresolvable: 'The selected text could not be found',
  budget_exhausted: 'The run reached a limit',
};

/** The ask-back envelope (agent-harness §2): why the turn stopped and the next actions it offers, as a card. */
export function AskBackCard({ askBack }: { askBack: AskBack }): ReactNode {
  const options = askBackOptions(askBack);
  return (
    <aside className={`askback is-${askBack.code}`} aria-label={ASKBACK_TITLES[askBack.code]}>
      <h4>{ASKBACK_TITLES[askBack.code]}</h4>
      <p>{askBack.reason}</p>
      {askBack.candidates !== undefined && askBack.candidates.length > 0 ? (
        <ul className="askback-candidates">
          {askBack.candidates.map((candidate) => (
            <li key={`${candidate.from}:${candidate.to}`}>
              characters {candidate.from}–{candidate.to}, {Math.round(candidate.similarity * 100)}% alike
            </li>
          ))}
        </ul>
      ) : null}
      {options.length > 0 ? (
        <ul className="askback-options" aria-label="Next steps">
          {options.map((option) => (
            <li key={option}>{option}</li>
          ))}
        </ul>
      ) : null}
    </aside>
  );
}

function FindingsList({ findings }: { findings: readonly Finding[] }): ReactNode {
  return (
    <section className="findings" aria-label="Findings">
      <h4>
        {findings.length} {findings.length === 1 ? 'finding' : 'findings'}
      </h4>
      <ul>
        {findings.map((finding, index) => (
          <li key={index}>
            <strong>{finding.aspect}</strong>, {finding.severity}: {finding.note}{' '}
            <q>{finding.quote}</q> <span className="muted">({finding.docs.join(', ')})</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The checkpoint row (agent-harness §5): one click puts the project back to before this turn, unless it has been taken back already. */
export function CheckpointRow({
  undoGroupId,
  mode,
  note,
  taken,
  onRestore,
  disabled,
}: {
  undoGroupId: string;
  /** The permission mode the turn ended in. */
  mode: PermissionMode;
  /** The scope note of a turn that called an external tool, which restoring cannot reverse (extensibility §6). */
  note?: string;
  taken: boolean;
  onRestore: () => void;
  disabled: boolean;
}): ReactNode {
  return (
    <div className="checkpoint-row" data-testid="checkpoint" data-undo-group={undoGroupId}>
      <span className="checkpoint-label">
        Checkpoint · {CHECKPOINT_LABEL} · {MODE_LABELS[mode]}
      </span>
      {taken ? (
        <span className="muted">Taken back</span>
      ) : (
        <button type="button" className="button is-quiet" disabled={disabled} onClick={onRestore}>
          Restore to before this turn
        </button>
      )}
      {note === undefined ? null : <span className="muted checkpoint-note">{note}</span>}
    </div>
  );
}

/**
 * What Plan only kept (agent-harness §4): the writes the turn wanted to make, none of them run, with the way to run them. The steps are
 * listed in the words the task list uses; there is no Approve here, because nothing in this card can run until the writer is in Ask.
 */
function HeldPlan({ report, disabled, onRun }: { report: TurnReport; disabled: boolean; onRun: () => void }): ReactNode {
  const held = report.heldSteps ?? [];
  return (
    <section className="held-plan" aria-label="Plan, not run" data-testid="held-plan">
      <h3>Plan only: {held.length === 1 ? '1 step' : `${held.length} steps`} not run</h3>
      <ol>
        {held.map((step, index) => (
          <li key={`${index}:${step.tool}`}>{phraseFor(step.tool, step.params).content}</li>
        ))}
      </ol>
      <button type="button" className="button" disabled={disabled} onClick={onRun}>
        Switch to Ask and run this plan
      </button>
    </section>
  );
}

function ReportLine({ report, price }: { report: TurnReport; price: TurnView['price'] }): ReactNode {
  const tokens = report.tokens;
  // The cost is shown only when the profile the turn ran on has a price (provider-gateway §6): an unpriced turn shows its tokens alone.
  const cost = turnCostOf(tokens, price);
  return (
    <div className="agent-report" aria-label="Report">
      <p className="agent-report-text">{report.summary}</p>
      <p className="muted agent-report-meta">
        {report.modelCalls === 1 ? '1 model call' : `${report.modelCalls} model calls`} · about {tokens.promptTokens} tokens in,{' '}
        {tokens.completionTokens} out
      </p>
      {cost !== undefined ? <p className="muted agent-report-meta">About {formatUsd(cost)} for this turn, at this profile’s prices.</p> : null}
      {report.dropped.length > 0 ? (
        <details className="agent-context">
          <summary>What the prompt left out</summary>
          <ul>
            {report.dropped.map((reason, index) => (
              <li key={`${index}:${reason}`}>{reason}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
