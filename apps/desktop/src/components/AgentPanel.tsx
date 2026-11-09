/**
 * The agent panel (agent-harness §8, ui-modules §1): a drawer under the editor, where the writer states an intent and reads
 * what the agent did. Every turn is a block in order: the provider it ran on, its status cards, its plan or confirm card, any
 * ask-back, its findings, its checkpoint row and its report. The ghost draft is not here; it is shown in the editor, where it
 * will land.
 *
 * The Intent box stays open while a turn runs (agent-harness §8, "Stop and steer"): Enter queues what is typed as the next turn,
 * Ctrl+Enter sends it to the running turn as a note, and Stop (or Escape, with the box empty) stops the turn.
 */

import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { plural, t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { isolate } from '@caotang/i18n';
import {
  groupCards,
  headerLineOf,
  headerRefOf,
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
import { askBackOptions, delegationViewOf, elapsedOf, formatElapsed, isSettled, MODE_HINTS, phaseLabel, progressViewOf, promptCacheLines, savesAsMacro, spendLine, stepMenuOf, type DelegationCardView, type TurnView } from '../app/agent-model.js';
import { formatUsd, turnCostOf } from '../app/plan-preview.js';
import { isImeEnter, keyFacts, keyboardLayoutStore, resolveKey, shortcutLabel } from '../app/keymap.js';
import { providerLabel } from '../app/provider-label.js';
import { UNRESOLVED_NOTICE } from '../app/review-text.js';
import type { AgentController, AgentSnapshot } from '../app/agent.js';
import type { CommandNote } from '../app/slash-model.js';
import type { RecurringTasks } from '../app/recurring-tasks.js';
import type { StartIntent } from '../App.js';
import type { ProjectSession } from '../app/session.js';
import { useAssetRecords } from '../media/hooks.js';
import { TranscriptionReviewDialog } from '../media/TranscriptionReviewDialog.js';
import { ConfirmDialog, EmptyState, useComposingEnter, useReport, useSession } from './shared.js';
import { AgentQueue, type HeldNote } from './AgentQueue.js';
import { CommandComposer } from './CommandComposer.js';
import { openDialog } from './dialog-requests.js';
import { PlanCard, planHeading, type TranscriptionRouteChoice } from './PlanCard.js';
import { SaveAsMacro } from './SaveAsMacro.js';
import { PlanOfferCard } from './PlanOfferCard.js';
import { BackgroundTasks } from './BackgroundTasks.js';
import { RecurringTasksPanel } from './RecurringTasks.js';
import { TaskOffers } from './TaskOffers.js';
import { InterruptedRuns } from './InterruptedRuns.js';
import { TaskChecklist } from './TaskChecklist.js';
import { renderRef, WRITER_VALUE_KEYS } from '../i18n/render-ref.js';
import { accessibleText } from '../i18n/accessible-text.js';
import { UserText } from '../i18n/UserText.js';

import { TurnMenu } from './TurnMenu.js';
import { SaveCommand } from './SaveCommand.js';

/** Fetched when a turn has suggestions pending, which only an editor in review mode makes. */
const TurnReview = lazy(() => import('./TurnReview.js').then((module) => ({ default: module.TurnReview })));

/* lingui-set comment="Agent controls and activity. Counts are steps, calls or tokens; time and money are formatted values. Titles, provider names, summaries and notes are untranslatable supplied content." */

const MODE_LABELS: Readonly<Record<PermissionMode, string>> = {
  get 'plan-only'() { return t`Plan only`; },
  get ask() { return t`Ask`; },
  get 'accept-edits'() { return t`Accept edits`; },
  get auto() { return t`Auto`; },
};

export interface AgentPanelProps {
  readonly session: ProjectSession;
  readonly agent: AgentController;
  /** The project's recurring tasks (agent-harness.md §12). */
  readonly recurring: RecurringTasks;
  readonly startIntent: StartIntent | null;
  /**
   * Text put in the Intent box from elsewhere (Modern's palette with no match, modern-interface.md §8.9), never sent: the writer
   * reads it and sends it. The serial makes a repeat of the same text count. A draft already in the box is kept, with the text after it.
   */
  readonly draft?: { readonly text: string; readonly serial: number } | null;
  readonly open: boolean;
  readonly onToggle: () => void;
  /** The project is a sample the first-run card made, so the demo intents are offered here. */
  readonly sample: boolean;
  /**
   * Where the panel sits (modern-interface.md §7.4, §8.10). `'drawer'` (the default) is Classic's drawer under the centre, with its
   * toggle. `'window'` is Modern's companion window, which names itself: always open, no toggle, **Agent** as the header's title, the
   * Intent box in a footer under the turns, and **Close** in the header. Escape there keeps the drawer's meaning first (it stops a
   * stoppable turn while the Intent box is empty) and otherwise closes the window.
   */
  readonly placement?: 'drawer' | 'window';
  /** Closes the window. Only the window placement draws **Close** and calls it. */
  readonly onClose?: () => void;
  /** Opens Settings › Providers. Only the window gets it, and offers it under the demo's refusal (#363). */
  readonly onAddProvider?: () => void;
}

/**
 * A restore the writer is asked to confirm: the turn, what it did, and the later changes the restore would also take back.
 * `both` also rewinds the conversation once the project is back. `note` is the scope note of a turn that called an external tool.
 */
interface PendingRestore {
  readonly turnId: string;
  readonly summary: string;
  readonly later: readonly string[];
  readonly both: boolean;
  readonly note?: string;
  /** The step (status-card id) the restore begins at; absent for the whole turn. */
  readonly stepId?: string;
  /** The planner proved this restore can leave the later changes standing: the dialog then offers to keep them. */
  readonly exact?: boolean;
}

/**
 * What outlives one panel instance, by agent: switching Classic and Modern remounts the panel (drawer or window), and the new one must
 * neither replay a start intent or palette draft the old one took nor lose the unsent Intent text.
 */
interface PanelMemory {
  intent: string;
  started: number;
  drafted: number;
}
const panelMemory = new WeakMap<AgentController, PanelMemory>();
function memoryFor(agent: AgentController): PanelMemory {
  let memory = panelMemory.get(agent);
  if (memory === undefined) panelMemory.set(agent, (memory = { intent: '', started: 0, drafted: 0 }));
  return memory;
}

export function AgentPanel({
  session,
  agent,
  recurring,
  startIntent,
  draft = null,
  open: drawerOpen,
  onToggle,
  sample,
  placement = 'drawer',
  onClose,
  onAddProvider,
}: AgentPanelProps): ReactNode {
  const inWindow = placement === 'window';
  const sectionHeading = inWindow ? 3 : 4;
  // A window is always open: only the drawer folds.
  const open = inWindow || drawerOpen;
  useLingui();
  useSession(session);
  const snapshot = useSyncExternalStore(agent.subscribe, agent.snapshot);
  const keyboardLayout = useSyncExternalStore(keyboardLayoutStore.subscribe, keyboardLayoutStore.snapshot);
  const report = useReport();
  // The pictures' file names, by id: a codex step's visual references are shown by name on its card (plan-preview.ts).
  // The images are listed when they can have changed, not on every change of the session (media/hooks.ts).
  const pictures = useAssetRecords(session.assets.artifactFs(), session.assetsVersion());
  const pictureNames = useMemo(() => new Map([...pictures.values()].map((picture) => [picture.id, picture.fileName] as const)), [pictures]);
  const transcriptionRoutes = agent.transcriptionRoutes();
  const waitingSkills = session.skills().waiting;
  const [, refreshCommands] = useState(0);
  useEffect(() => {
    const client = session.commandClient();
    const refresh = (): void => refreshCommands((value) => value + 1);
    const offHealth = client?.onHealthChange(refresh);
    const offTools = client?.onToolListChanged(refresh);
    return () => { offHealth?.(); offTools?.(); };
  }, [session]);
  const [intent, setIntent] = useState(() => memoryFor(agent).intent);
  useEffect(() => {
    memoryFor(agent).intent = intent;
  }, [agent, intent]);
  const [restoring, setRestoring] = useState<PendingRestore | null>(null);
  // The instruction of a turn the writer rewound, offered when the Intent box already holds a draft: that draft is never replaced unasked.
  const [oldInstruction, setOldInstruction] = useState<string | null>(null);
  // A note the writer wrote while a card waits, until they choose what happens to it and the card.
  const [held, setHeld] = useState<HeldNote | null>(null);
  const handled = useRef(memoryFor(agent).started);
  const intentRef = useRef<HTMLInputElement>(null);
  // The form's own Enter path: its implicit submit does not pass through resolveKey (ui-modules §2.5).
  const intentIme = useComposingEnter();

  // A demo run that the first-run card started: the shell submits its intent once, when the panel is there. Every start is a
  // demo intent, so it runs on the built-in demo profile.
  useEffect(() => {
    if (startIntent === null || startIntent.serial === handled.current) return;
    handled.current = memoryFor(agent).started = startIntent.serial;
    void agent.submit(startIntent.intent, { demo: true });
  }, [agent, startIntent]);

  // Text from the palette: into the Intent box, after any draft already there, with the caret at its end. Nothing is sent.
  const drafted = useRef(memoryFor(agent).drafted);
  useEffect(() => {
    if (draft === null || draft.serial === drafted.current) return;
    drafted.current = memoryFor(agent).drafted = draft.serial;
    setIntent((current) => (current.trim() === '' ? draft.text : `${current.trimEnd()} ${draft.text}`));
    requestAnimationFrame(() => {
      const field = intentRef.current;
      if (field === null) return;
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    });
  }, [agent, draft]);

  useEffect(() => {
    if (snapshot.message !== null) report({ text: snapshot.message, tone: 'error' });
  }, [snapshot.message, report]);

  // The note is held for one showing of one card: when that card is decided or shown again, the choice goes with it.
  const cardKey = snapshot.pending === null ? null : `${snapshot.pending.turnId}:${snapshot.pending.card.id}:${snapshot.pending.card.revision}`;
  const heldNow = held !== null && held.cardKey === cardKey ? held : null;

  // Enter: send when no turn runs, queue as the next turn when one does. A line that starts with a slash is read as a command first
  // (agent-harness §2): it may start a turn of its own, answer under the box, or ask to restore. A line the command could not use stays in
  // the box for the writer to correct.
  const send = (line: string, values?: Readonly<Record<string, string>>, promptSelection?: string): void => {
    const text = line.trim();
    if (text === '') return;
    const outcome = agent.sendLine(text, values, promptSelection);
    if (outcome.kind === 'kept') return;
    setIntent('');
    setOldInstruction(null);
    if (outcome.kind === 'restore') openRestore(restoreOf(agent, outcome.turnId, outcome.summary, false));
  };
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    // A form's Enter submission does not reach resolveKey, so it is guarded again here. A SubmitEvent carries no composition
    // fact of its own, so the mark the form's keydown left is the only fact this guard can read.
    if (intentIme.takesSubmit()) return;
    send(intent);
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
      // keyFacts reads AltGraph from the modifier state (Windows reports it as Ctrl+Alt); isImeEnter reads the native event's composition.
      { ...keyFacts(event), composing: isImeEnter(event) },
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
    } else if (inWindow && (action === 'escape' || action === 'agent-stop')) {
      // The window's Escape rule (modern-interface.md §8.10): with nothing to stop, or words in the Intent box, Escape closes the window.
      // A turn keeps running while it is closed.
      event.preventDefault();
      onClose?.();
    }
  };

  // The old instruction goes back into the Intent box when the box is empty, and is offered as a button when it is not.
  const refill = (text: string): void => {
    if (text === '') return;
    if (intent.trim() === '') {
      setIntent(text);
      setOldInstruction(null);
      intentRef.current?.focus();
    } else setOldInstruction(text);
  };

  const rewind = (turnId: string): void => {
    const result = agent.rewindConversation(turnId);
    if (result === null) {
      // The menu is enabled from the last render; a turn may have started, or the turn may already be rewound, since.
      report({
        text: agent.snapshot().busy ? 'The conversation could not be rewound: a turn is running.' : 'The conversation could not be rewound: that turn is no longer available to rewind.',
        tone: 'error',
      });
      return;
    }
    report({ text: 'Rewound the conversation to before that turn. The project was not changed.', tone: 'info' });
    refill(result.intent);
  };

  // The dialog opens at once with the full restore; the planner is asked after pending typing is saved, and the dialog gains "keep your
  // later edits" only when it proves the later changes are elsewhere. A newer dialog is never changed by an older answer.
  const openRestore = (next: PendingRestore): void => {
    setRestoring(next);
    if (next.both || next.later.length === 0) return;
    void agent.restorePlan(next.turnId, next.stepId).then((plan) => {
      // Saving the typing may have added a change to the list the dialog shows, so the list is read again with the answer.
      setRestoring((now) =>
        now !== null && now.turnId === next.turnId && now.stepId === next.stepId && !now.both
          ? { ...now, later: agent.laterChanges(now.turnId), exact: plan?.kind === 'exact' }
          : now,
      );
    });
  };

  const confirmOnly = (): void => {
    if (restoring === null) return;
    const { turnId, stepId } = restoring;
    setRestoring(null);
    void agent.restoreOnly(turnId, stepId).then((outcome) => {
      if (!outcome.ok) report({ text: outcome.message, tone: 'error' });
      else report({ text: onlyLine(stepId !== undefined, outcome.kept), tone: 'info' });
    });
  };

  const confirmRestore = (): void => {
    if (restoring === null) return;
    const { turnId, both, stepId } = restoring;
    setRestoring(null);
    if (stepId !== undefined) {
      void agent.restoreStep(turnId, stepId).then((outcome) => {
        if (!outcome.ok) report({ text: outcome.message, tone: 'error' });
        else report({ text: restoredStepLine(outcome.later), tone: 'info' });
      });
      return;
    }
    if (!both) {
      void agent.restore(turnId).then((outcome) => {
        if (!outcome.ok) report({ text: outcome.message, tone: 'error' });
        else report({ text: restoredLine(outcome.later), tone: 'info' });
      });
      return;
    }
    void agent.restoreBoth(turnId).then((outcome) => {
      if (!outcome.ok) report({ text: outcome.projectRestored ? outcome.message : `${outcome.message} The conversation was not rewound.`, tone: 'error' });
      else {
        report({ text: `${restoredLine(outcome.later)} The conversation was rewound too.`, tone: 'info' });
        refill(outcome.intent);
      }
    });
  };

  const provider = snapshot.providerName;
  const running = snapshot.turns[snapshot.turns.length - 1];
  const stepRef = running === undefined || isSettled(running) ? null : headerRefOf(running.tasks, (ref) => renderRef(ref, { userValues: WRITER_VALUE_KEYS }));
  const stepLine = stepRef !== null ? renderRef(stepRef) : running === undefined || isSettled(running) ? null : headerLineOf(running.tasks);
  const spend = running === undefined || isSettled(running) ? undefined : spendLine(running.run);
  // The Intent box: at the top of the drawer's body, and in the window's footer under the turns (modern-interface.md §7.4).
  const intentForm = (
    <form className="agent-intent" onKeyDown={intentIme.noteKey} onSubmit={submit}>
      <CommandComposer
        commands={agent.commands()}
        inputRef={intentRef}
        value={intent}
        onChange={setIntent}
        onRun={send}
        disabled={snapshot.providerName === null}
        placeholder={
          snapshot.busy
            ? t`${{ send: shortcutLabel('agent-send', keyboardLayout) }} queues it for the next turn, ${{ steer: shortcutLabel('agent-steer', keyboardLayout) }} sends it to this one`
            : t`Ask the agent to draft, fill, or check something, or type / for commands`
        }
      />
      <button type="submit" className="button is-primary" disabled={intent.trim() === '' || snapshot.providerName === null}>
        {snapshot.busy ? t`Queue` : t`Send`}
      </button>
      {snapshot.busy ? (
        <button type="button" className="button" disabled={intent.trim() === '' || snapshot.providerName === null} onClick={steer}>
          <Trans>Steer</Trans>
        </button>
      ) : null}
    </form>
  );
  // The drawer is a named region of its own; the window is inside Modern's `aside` "Agent", which names it.
  const Root = inWindow ? 'div' : 'section';
  return (
    <Root
      className={`agent${open ? ' is-open' : ''}${inWindow ? ' is-window' : ''}`}
      aria-label={inWindow ? undefined : t`Agent`}
      data-testid="agent-panel"
      onKeyDown={onPanelKey}
    >
      <header className="agent-head">
        {inWindow ? (
          <h2 className="agent-title">{t`Agent`}</h2>
        ) : (
          // aria-controls names the body only while the body is rendered: a closed drawer has no element with that id.
          <button type="button" className="button is-quiet agent-toggle" aria-expanded={open} aria-controls={open ? 'agent-body' : undefined} onClick={onToggle}>
            {open ? t`Hide the agent` : t`Agent`}
          </button>
        )}
        <span className="agent-provider" data-testid="agent-provider">
          {provider === null ? t`No provider` : t`Provider: ${{ provider: isolate(providerLabel(provider, snapshot.providerIsDemo)) }}`}
        </span>
        {/* The permission mode (agent-harness §4): a radio group named by its visible label, in the header so it shows with the drawer closed too. */}
        <fieldset className="agent-mode" data-testid="agent-mode">
          <legend><Trans>Mode</Trans></legend>
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
            {stepLine ?? (snapshot.pending !== null ? t`Waiting for you` : t`Working…`)}
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
            title={t`Stop the turn (${{ shortcut: shortcutLabel('agent-stop', keyboardLayout) }} with the Intent box empty)`}
            onClick={() => agent.stop()}
          >
            {snapshot.stopping ? t`Stopping…` : t`Stop`}
          </button>
        ) : null}
        {/* What Stop, a note or the queue just did, for a screen reader: a status the header's step line does not carry. */}
        <p className="visually-hidden" role="status" aria-live="polite" data-testid="agent-announcement">
          {snapshot.announcement}
        </p>
        {inWindow ? (
          // Drawn as the ornaments' close stroke in companion.css (#363); the word stays its name.
          <button
            type="button"
            className="button agent-close"
            data-testid="agent-close"
            title={t`Close the agent (${{ shortcut: shortcutLabel('agent-toggle', keyboardLayout) }}). A running turn keeps working.`}
            onClick={onClose}
          >
            {t({ message: 'Close', context: 'agent window' })}
          </button>
        ) : null}
      </header>

      {/* An unfinished run is shown with the drawer closed too: it is the first thing the writer has to decide after a reload. */}
      <InterruptedRuns agent={agent} runs={snapshot.interrupted} busy={snapshot.busy} onResume={() => (open ? undefined : onToggle())} />

      {/* A task that is due waits for the writer's answer, so its offer is shown with the drawer closed too. */}
      <TaskOffers recurring={recurring} />

      {open ? (
        <div id="agent-body" className="agent-body">
          {inWindow ? null : intentForm}

          {oldInstruction !== null ? (
            <p className="agent-old-instruction" data-testid="agent-old-instruction">
              <span className="muted">The Intent box holds your draft. The rewound instruction was:</span> <q>{oldInstruction}</q>{' '}
              <button
                type="button"
                className="button is-quiet"
                onClick={() => {
                  setIntent(oldInstruction);
                  setOldInstruction(null);
                  intentRef.current?.focus();
                }}
              >
                Use the old instruction
              </button>
              <button type="button" className="button is-quiet" onClick={() => setOldInstruction(null)}>
                Dismiss
              </button>
            </p>
          ) : null}

          {snapshot.command !== null ? <CommandNoteView note={snapshot.command} onRun={send} onDismiss={() => agent.dismissCommandNote()} /> : null}

          {/* Skills the writer has not read and approved are not offered to the agent (extensibility.md §10). The panel says how many wait. */}
          {waitingSkills > 0 ? (
            <p className="agent-skills-note" data-testid="agent-skills-note">
              {plural(waitingSkills, { one: '# skill is waiting for you to approve it, so the agent cannot use it yet.', other: '# skills are waiting for you to approve them, so the agent cannot use them yet.' })}{' '}
              <button type="button" className="status-link" onClick={() => openDialog({ kind: 'skills' })}>
                <Trans>Review skills</Trans>
              </button>
            </p>
          ) : null}

          {/* In the window the panel's title is the h2 and its sections are h3; in the drawer they stay h4 (Classic's DOM unchanged). */}
          <AgentQueue
            agent={agent}
            snapshot={snapshot}
            held={heldNow}
            cardKey={cardKey}
            onHold={setHeld}
            onRelease={() => setHeld(null)}
            headingLevel={sectionHeading}
          />

          <BackgroundTasks agent={agent} tasks={agent.taskViews()} headingLevel={sectionHeading} />

          {/* In the window it is one line under the turns, its explanation shown with a task's form (#363, companion.css). */}
          <RecurringTasksPanel recurring={recurring} headingLevel={sectionHeading} />

          {snapshot.offer !== null ? <PlanOfferCard agent={agent} view={snapshot.offer} /> : null}

          {sample && snapshot.turns.length === 0 ? (
            <div className="agent-demos" role="group" aria-label={t`Demo intents`}>
              {DEMO_CHOICES.map((choice) => (
                <button key={choice.intent} type="button" className="button" disabled={snapshot.busy} onClick={() => void agent.submit(choice.intent, { demo: true })}>
                  {choice.label}
                </button>
              ))}
            </div>
          ) : null}

          {snapshot.turns.length === 0 ? (
            <EmptyState title={t`The agent has not run yet`}>
              <Trans>Ask it to draft a scene, fill the synopses of a chapter, or check the manuscript for continuity. It proposes each
              change first, and nothing is written until you approve it.</Trans>
            </EmptyState>
          ) : (
            <ol className="agent-turns" aria-label={t`Turns`}>
              {runsOf(snapshot.turns).map((run) => {
                const blocks = run.turns.map((turn) => (
                  <TurnBlock
                    key={turn.turnId}
                    turn={turn}
                    snapshot={snapshot}
                    project={session.state}
                    session={session}
                    transcriptionRoutes={transcriptionRoutes}
                    pictureNames={pictureNames}
                    stands={turn.checkpoint !== null && session.undo.group(turn.checkpoint.undoGroupId) !== undefined}
                    canRewind={agent.canRewind(turn.turnId)}
                    onDecide={(decision) => agent.answer(decision)}
                    restorable={agent.restorableSteps(turn.turnId)}
                    onRestore={(turnId, summary, both) => openRestore(restoreOf(agent, turnId, summary, both))}
                    onRestoreStep={(turnId, summary, stepId) => openRestore(restoreOf(agent, turnId, summary, false, stepId))}
                    onRewind={rewind}
                    onRunHeld={(turnId) => void agent.runHeldPlan(turnId)}
                    onResolveReview={(turnId, mode) => {
                      // The card offers this only while it shows a pending count, so nothing settled means the marks are still there.
                      if (agent.resolveReview(turnId, mode) === 0) report({ text: UNRESOLVED_NOTICE, tone: 'info' });
                    }}
                  />
                ));
                const turnCount = run.turns.length;
                return run.rewound ? (
                  // Rewound turns are kept, not deleted: the writer can read them and take their project changes back.
                  <li key={run.turns[0]!.turnId} className="agent-rewound">
                    <details data-testid="agent-rewound">
                      <summary>
                        {plural(turnCount, { one: 'Rewound - not sent to the model (# turn)', other: 'Rewound - not sent to the model (# turns)' })}
                      </summary>
                      <ol className="agent-turns" aria-label={t`Rewound turns`}>
                        {blocks}
                      </ol>
                    </details>
                  </li>
                ) : (
                  blocks
                );
              })}
            </ol>
          )}
          {/* The demo answers its three intents with a tool call or a plan; a last turn with neither is its refusal (#363). */}
          {onAddProvider && snapshot.providerIsDemo && running?.report && !running.cards.length ? (
            <button type="button" className="button" onClick={onAddProvider}>
              <Trans>Add a provider</Trans>
            </button>
          ) : null}
        </div>
      ) : null}
      {inWindow ? <footer className="agent-foot">{intentForm}</footer> : null}

      <TranscriptionReviewDialog session={session} broker={session.transcriptionReviews} />
      <ConfirmDialog
        open={restoring !== null}
        title={
          restoring?.stepId !== undefined
            ? t`Restore to before this step?`
            : restoring?.both === true
              ? t`Restore the project and rewind the conversation?`
              : t`Restore to before this turn?`
        }
        confirmLabel={restoring?.both === true ? t`Restore both` : t`Restore`}
        alternate={
          restoring?.exact === true && restoring.later.length > 0
            ? {
                label: restoring.stepId !== undefined ? t`Restore only this step (keep your later edits)` : t`Restore only this turn (keep your later edits)`,
                onSelect: confirmOnly,
              }
            : undefined
        }
        onCancel={() => setRestoring(null)}
        onConfirm={confirmRestore}
      >
        {restoring?.stepId !== undefined ? (
          <p>
            {restoring.summary
              ? <Trans>This restores the project to its state before this step of the turn: <UserText value={restoring.summary} />. The steps after it, and your edits since then, are included in the restore. The steps before it stay.</Trans>
              : <Trans>This restores the project to its state before this step of the turn. The steps after it, and your edits since then, are included in the restore. The steps before it stay.</Trans>}
          </p>
        ) : (
          <p>
            {restoring?.summary
              ? <Trans>This restores the project to its state before this turn: <UserText value={restoring.summary} />. Your edits since then are included in the restore.</Trans>
              : <Trans>This restores the project to its state before this turn. Your edits since then are included in the restore.</Trans>}
            {restoring?.both === true ? <> {t`The agent then forgets this turn and the ones after it.`}</> : null}
          </p>
        )}
        {restoring?.note === undefined ? null : <p className="muted">{restoring.note}</p>}
        {restoring?.exact === true && restoring.later.length > 0 ? (
          <p data-testid="restore-exact">
            <Trans>Your later changes are in other parts of the project, so this can be taken back on its own and they stay. Restore takes them back too.</Trans>
          </p>
        ) : null}
        {restoring !== null && restoring.later.length > 0 ? (
          <>
            <p>{restoring.exact === true ? t`Restore would also take back these later changes, oldest first:` : t`It also takes back these later changes, oldest first:`}</p>
            <ul aria-label={t`Later changes`}>
              {restoring.later.map((line, index) => (
                <li key={`${index}:${line}`}>{line}</li>
              ))}
            </ul>
          </>
        ) : null}
      </ConfirmDialog>
    </Root>
  );
}

/** What the last slash command said: help, a missing or ambiguous argument, the context, or why a line was kept. It is the panel's, not a turn's. */
function CommandNoteView({ note, onDismiss, onRun }: { note: CommandNote; onDismiss: () => void; onRun: (line: string, values?: Readonly<Record<string, string>>, promptSelection?: string) => void }): ReactNode {
  return (
    <section className={`agent-command-note is-${note.kind}`} role="status" aria-label="Command result" data-testid="agent-command-note">
      <p className="agent-command-title">{note.title}</p>
      {note.argument === undefined ? null : <CommandArgument key={`${note.argument.promptSelection ?? ''}:${note.argument.line}:${note.argument.name}`} argument={note.argument} onRun={onRun} />}
      {note.lines.length === 0 ? null : (
        <ul>
          {note.lines.map((line, index) => (
            <li key={`${index}:${line}`}>{line}</li>
          ))}
        </ul>
      )}
      <button type="button" className="button is-quiet" onClick={onDismiss}>
        Dismiss
      </button>
    </section>
  );
}

function CommandArgument({ argument, onRun }: { readonly argument: NonNullable<CommandNote['argument']>; readonly onRun: (line: string, values?: Readonly<Record<string, string>>, promptSelection?: string) => void }): ReactNode {
  const [value, setValue] = useState('');
  return <form className="settings-form" onSubmit={(event) => {
    event.preventDefault();
    if (argument.values !== undefined) {
      onRun(argument.line, { ...argument.values, [argument.name]: value }, argument.promptSelection);
      return;
    }
    const word = JSON.stringify(value);
    onRun(`${argument.line} ${/^[1-9]$/u.test(argument.name) ? word : `${argument.name}=${word}`}`);
  }}>
    <label>{t`Argument`}: <bdi>{argument.name}</bdi><input value={value} onChange={(event) => setValue(event.target.value)} required /></label>
    <button type="submit" className="button" disabled={value.trim() === ''}>{t`Run command`}</button>
  </form>;
}

/** The restore dialog's state for a turn: the later changes it would also take back are read now, from the undo stack. */
function restoreOf(agent: AgentController, turnId: string, summary: string, both: boolean, stepId?: string): PendingRestore {
  const note = agent.snapshot().turns.find((turn) => turn.turnId === turnId)?.checkpoint?.note;
  return { turnId, summary, later: agent.laterChanges(turnId), both, ...(note === undefined ? {} : { note }), ...(stepId === undefined ? {} : { stepId }) };
}

/**
 * The turns in panel order, as runs: consecutive rewound turns share one collapsed block, and the others stand alone. The order is
 * the order the turns happened in, so a turn the writer sent after a rewind comes after the rewound block.
 */
function runsOf(turns: readonly TurnView[]): readonly { readonly rewound: boolean; readonly turns: readonly TurnView[] }[] {
  const runs: { rewound: boolean; turns: TurnView[] }[] = [];
  for (const turn of turns) {
    const last = runs[runs.length - 1];
    if (turn.rewound && last?.rewound === true) last.turns.push(turn);
    else runs.push({ rewound: turn.rewound, turns: [turn] });
  }
  return runs;
}

/** What a restore that kept the later edits says. */
function onlyLine(step: boolean, kept: number): string {
  const what = step ? 'that step' : 'that turn';
  return `Restored to before ${what}. Your ${kept} later ${kept === 1 ? 'change was' : 'changes were'} kept.`;
}

/** What a finished step restore says: how many later changes went back with it, if any. */
function restoredStepLine(later: number): string {
  if (later === 0) return 'Restored to before that step.';
  return `Restored to before that step. ${later} later ${later === 1 ? 'change was' : 'changes were'} taken back with it.`;
}

/** What a finished restore says: how many later changes went back with the turn, if any. */
function restoredLine(later: number): string {
  if (later === 0) return t`Restored to before that turn.`;
  return plural(later, { one: 'Restored to before that turn. # later change was taken back with it.', other: 'Restored to before that turn. # later changes were taken back with it.' });
}

/** An intent short enough to name a button for a screen reader. */
function clipIntent(intent: string): string {
  return intent.length <= 60 ? intent : `${intent.slice(0, 59)}…`;
}

function TurnBlock({
  turn,
  snapshot,
  project,
  session,
  transcriptionRoutes,
  pictureNames,
  stands,
  canRewind,
  restorable,
  onDecide,
  onRestore,
  onRestoreStep,
  onRewind,
  onRunHeld,
  onResolveReview,
}: {
  turn: TurnView;
  snapshot: AgentSnapshot;
  /** The open project, which a plan card reads its previews against. */
  project: ProjectState;
  /** The open project, which "Save as macro…" saves into. */
  session: ProjectSession;
  transcriptionRoutes: readonly TranscriptionRouteChoice[];
  /** The project's pictures by asset id, as their file names (a codex step names its visual references by these). */
  pictureNames: ReadonlyMap<string, string>;
  /** The turn's checkpoint is still on the undo stack, so it can be restored. */
  stands: boolean;
  /** The conversation can be rewound to before this turn: nothing runs and the turn is still sent to the model. */
  canRewind: boolean;
  /** The steps of the turn a restore to before that step would take something back, by status-card id. */
  restorable: ReadonlySet<string>;
  onDecide: (decision: Decision) => void;
  onRestore: (turnId: string, summary: string, both: boolean) => void;
  onRestoreStep: (turnId: string, summary: string, stepId: string) => void;
  onRewind: (turnId: string) => void;
  /** Switches to Ask and runs the writes Plan only refused in the turn. */
  onRunHeld: (turnId: string) => void;
  /** Keeps or puts back the suggestions this turn's edits still have marked in the editor (editor-engine §15). */
  onResolveReview: (turnId: string, mode: 'accept' | 'reject') => void;
}): ReactNode {
  useLingui();
  const live = snapshot.pending !== null && snapshot.pending.turnId === turn.turnId;
  const settled = isSettled(turn);
  const dropped = turn.context?.dropped.length ?? 0;
  return (
    <li className={`agent-turn is-${turn.phase}`} data-turn={turn.turnId}>
      <header className="agent-turn-head">
        {turn.command === null ? null : (
          <span className="agent-turn-command muted" data-testid="turn-command">
            /{turn.command}
          </span>
        )}
        <q className="agent-intent-text">{turn.intent}</q>
        {turn.mode === null ? null : (
          <span className="agent-turn-mode muted" data-testid="turn-mode">
            {MODE_LABELS[turn.mode]}
          </span>
        )}
        {settled ? (
          <TurnMenu
            label={`Rewind options for “${clipIntent(turn.intent)}”`}
            testId="turn-menu"
            note={turn.checkpoint?.note}
            items={[
              {
                label: 'Restore project to before this turn',
                hint: 'Keeps the conversation; the agent is told the changes are gone.',
                disabled: snapshot.busy || !stands,
                onSelect: () => onRestore(turn.turnId, turn.report?.summary ?? '', false),
              },
              {
                label: 'Rewind conversation to before this turn',
                hint: 'The agent forgets this turn and the ones after it. The project is not changed.',
                disabled: !canRewind,
                onSelect: () => onRewind(turn.turnId),
              },
              {
                label: 'Restore both',
                hint: 'Project first; the conversation is rewound only if that works.',
                disabled: snapshot.busy || !stands || !canRewind,
                onSelect: () => onRestore(turn.turnId, turn.report?.summary ?? '', true),
              },
            ]}
          />
        ) : null}
        <span className="agent-phase" aria-live="polite">
          {settled
            ? turn.report?.stop !== undefined
              ? t`Stopped by you`
              : turn.report?.status === 'applied'
                ? t`Applied`
                : turn.report?.status === 'replied'
                  ? t`Answered`
                  : phaseLabel(turn.phase)
            : phaseLabel(turn.phase)}
        </span>
      </header>
      {settled && !turn.command?.startsWith('mcp-') && !turn.command?.startsWith('macro-') ? <SaveCommand session={session} intent={turn.intent} /> : null}
      <TaskChecklist list={turn.tasks} settled={settled} />
      {turn.provider !== null ? <p className="agent-on muted"><Trans>Ran on <UserText value={turn.provider} /></Trans></p> : null}

      {!settled && turn.streamed !== '' ? <p className="agent-stream">{turn.streamed}</p> : null}

      {/* The model's thinking channel, kept collapsed and muted (provider-gateway §6/D12): it is the turn's record,
          so it stays after the turn settles — never in the editor, never inline-expanded. */}
      {turn.reasoning !== '' ? (
        <details className="agent-reasoning" data-testid="agent-thinking">
          <summary><Trans>Thinking</Trans></summary>
          <p className="agent-reasoning-text">{turn.reasoning}</p>
        </details>
      ) : null}

      {turn.context !== null && turn.context.dropped.length > 0 ? (
        <details className="agent-context">
          <summary>{plural(dropped, { one: '# context item left out', other: '# context items left out' })}</summary>
          <ul>
            {turn.context.dropped.map((reason, index) => (
              <li key={`${index}:${reason}`}>{reason}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {turn.cards.length > 0 ? (
        <StatusCards
          cards={turn.cards}
          steps={
            settled
              ? { restorable, disabled: snapshot.busy || !stands, onRestore: (stepId) => onRestoreStep(turn.turnId, turn.report?.summary ?? '', stepId) }
              : undefined
          }
        />
      ) : null}

      {snapshot.reviews.length > 0 ? (
        <Suspense fallback={null}>
          <TurnReview turnId={turn.turnId} reviews={snapshot.reviews} onResolve={onResolveReview} />
        </Suspense>
      ) : null}

      {turn.steering.length > 0 ? (
        <ul className="agent-notes" aria-label={t`Notes you sent during this turn`}>
          {turn.steering.map((note) => (
            <li key={note.noteId}>
              <span className="muted"><Trans>You added:</Trans></span> <UserText value={note.text} />
            </li>
          ))}
        </ul>
      ) : null}

      {turn.plan !== null && turn.planAuto ? (
        // A card the mode approved is collapsed, with its badge: the writer was not asked, and can open it to read what ran.
        <details className="plan-auto" data-testid="plan-auto">
          <summary>
            {planHeading(turn.plan)} <span className="badge is-auto"><Trans>Auto-approved</Trans></span>
          </summary>
          <PlanCard key={turn.planSeq} card={turn.plan} live={false} drafts={null} project={project} session={session} transcriptionRoutes={transcriptionRoutes} pictureNames={pictureNames} onDecide={onDecide} auto />
        </details>
      ) : turn.plan !== null ? (
        // Keyed on the showing, so every field of the card is read again from the card the loop holds (agent-harness §2).
        <PlanCard key={turn.planSeq} card={turn.plan} live={live} drafts={live ? snapshot.drafts : null} project={project} session={session} transcriptionRoutes={transcriptionRoutes} pictureNames={pictureNames} onDecide={onDecide} />
      ) : null}

      {turn.plan !== null && savesAsMacro(turn) ? <SaveAsMacro session={session} steps={turn.plan.steps} intent={turn.intent} /> : null}

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
          onRestore={() => onRestore(turn.turnId, turn.report?.summary ?? '', false)}
          disabled={snapshot.busy}
        />
      ) : null}

      {turn.restoredFromStep !== null && stands ? (
        <p className="muted agent-partial-restore" data-testid="partial-restore">
          Restored from step {turn.restoredFromStep}: the steps before it are still in the project.
        </p>
      ) : null}

      {turn.report !== null ? <ReportLine report={turn.report} price={turn.price} /> : null}
    </li>
  );
}

/** The status cards of one turn, consecutive calls grouped (agent-harness §8). */
export function StatusCards({ cards, steps }: { cards: readonly StatusCard[]; steps?: StepRestore }): ReactNode {
  useLingui();
  const items = groupCards(cards);
  return (
    <ol className="status-cards" aria-label={t`Tool calls`}>
      {items.map((item) =>
        item.kind === 'card' ? (
          <li key={item.card.id}>
            <StatusCardRow card={item.card} steps={steps} />
          </li>
        ) : (
          <li key={item.cards[0]?.id ?? item.turnId}>
            <details className="status-group" open={item.expanded}>
              <summary>
                {item.expanded
                  ? t`${{ count: item.cards.length }} calls · running`
                  : t`${{ count: item.cards.length }} calls · done`}
              </summary>
              {item.cards.map((card) => (
                <StatusCardRow key={card.id} card={card} steps={steps} />
              ))}
            </details>
          </li>
        ),
      )}
    </ol>
  );
}

/** What a finished turn lets the writer do with its steps: which can be restored to before, and how. */
interface StepRestore {
  readonly restorable: ReadonlySet<string>;
  readonly disabled: boolean;
  readonly onRestore: (stepId: string) => void;
}

const STATUS_WORDS: Readonly<Record<StatusCard['status'], string>> = {
  get 'pending-approval'() { return t`Waiting for approval`; },
  get running() { return t`Running`; },
  get done() { return t`Done`; },
  get cancelled() { return t`Cancelled`; },
  get failed() { return t`Failed`; },
};

function StatusCardRow({ card, steps }: { card: StatusCard; steps?: StepRestore }): ReactNode {
  const delegation = delegationViewOf(card);
  // A step of a finished turn, up to the last one that changed the project, can be restored to before it (a step that changed nothing starts the restore at the next one that did); a step that called an outside tool says its effects stay.
  const restorable = steps?.restorable.has(card.id) === true;
  const menu = stepMenuOf(card, restorable);
  const progress = progressViewOf(card);
  return (
    <article className={`status-card is-${card.status}`} data-tool={card.tool} data-status={card.status}>
      <header className="status-card-head">
        <code>{card.tool}</code>
        <span className={`badge is-risk-${card.risk.replace(/[^a-z]+/g, '-')}`}>{card.risk}</span>
        <span className={`status-pill is-${card.status}`}>{STATUS_WORDS[card.status]}</span>
        <ElapsedTime card={card} />
        {steps !== undefined && menu.show ? (
          <TurnMenu
            label={`Rewind options for step ${card.tool}`}
            testId="step-menu"
            note={menu.note}
            items={[
              {
                label: 'Restore project to before this step',
                hint: 'Takes back this step and the ones after it. The steps before it stay.',
                disabled: steps.disabled || !restorable,
                onSelect: () => steps.onRestore(card.id),
              },
            ]}
          />
        ) : null}
      </header>
      {delegation === undefined ? null : <DelegationBlock view={delegation} />}
      {progress === undefined ? null : (
        // The server's report on a call that is still running. The message is its own text, shown as text and labelled as the server's.
        <div className="status-card-progress" data-testid="call-progress">
          {progress.fraction === undefined ? null : <progress max={1} value={progress.fraction} aria-label={`Progress of ${card.tool}`} />}
          <span className="status-card-progress-count">{progress.label}</span>
          {progress.message === undefined ? null : (
            <p className="status-card-text status-card-progress-message">
              <span className="muted">The server says: </span>
              {progress.message}
            </p>
          )}
        </div>
      )}
      {card.summary !== undefined || card.error !== undefined ? (
        // The result is collapsed once the call is done, and open when it failed, so the reason is in front of the writer.
        <details className="status-card-result" open={card.error !== undefined}>
          <summary>{card.error === undefined ? t`Result` : card.mayHaveActed === true ? t`Why it did not finish` : t`Why it did not run`}</summary>
          <p className={card.error === undefined ? 'status-card-text' : 'status-card-text is-error'}>{card.error ?? card.summary}</p>
        </details>
      ) : null}
      <details className="status-card-args">
        <summary><Trans>Arguments</Trans></summary>
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
    <section className="delegation" aria-label={accessibleText(view.title)}>
      <p className="delegation-line">
        <strong>{view.title}</strong>
        <span className="muted">{view.reserved}</span>
        <span className="delegation-standing">{view.standing}</span>
      </p>
      <details className="delegation-brief">
        <summary><Trans>Brief</Trans></summary>
        <p className="status-card-text">{view.brief}</p>
        {view.scope.length > 0 ? <p className="status-card-text muted"><Trans>Starts from: <UserText value={view.scope.join(', ')} /></Trans></p> : null}
      </details>
      {view.result === undefined ? null : (
        <details className="delegation-result">
          <summary><Trans>Notes</Trans></summary>
          <p className="status-card-text">{view.result === '' ? t`The agent gave no notes.` : view.result}</p>
        </details>
      )}
      {view.proposed === undefined ? null : <p className="status-card-text delegation-proposed">{view.proposed}</p>}
      {view.trace.length === 0 ? null : (
        <details className="delegation-trace">
          <summary>{t`Transcript (${{ count: view.trace.length }})`}</summary>
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
  get needs_input() { return t`Needs your input`; },
  get conflict() { return t`The text changed under this draft`; },
  get verify_failed() { return t`The change did not check out`; },
  get anchor_unresolvable() { return t`The selected text could not be found`; },
  get budget_exhausted() { return t`The run reached a limit`; },
  get hook_blocked() { return t`A hook stopped the step`; },
};

/** The ask-back envelope (agent-harness §2): why the turn stopped and the next actions it offers, as a card. */
export function AskBackCard({ askBack }: { askBack: AskBack }): ReactNode {
  useLingui();
  const options = askBackOptions(askBack);
  return (
    <aside className={`askback is-${askBack.code}`} aria-label={ASKBACK_TITLES[askBack.code]}>
      <h4>{ASKBACK_TITLES[askBack.code]}</h4>
      <p>{askBack.reason}</p>
      {askBack.candidates !== undefined && askBack.candidates.length > 0 ? (
        <ul className="askback-candidates">
          {askBack.candidates.map((candidate) => (
            <li key={`${candidate.from}:${candidate.to}`}>
              {t`characters ${{ from: candidate.from }}–${{ to: candidate.to }}, ${{ similarity: Math.round(candidate.similarity * 100) }}% alike`}
            </li>
          ))}
        </ul>
      ) : null}
      {options.length > 0 ? (
        <ul className="askback-options" aria-label={t`Next steps`}>
          {options.map((option) => (
            <li key={option}>{option}</li>
          ))}
        </ul>
      ) : null}
    </aside>
  );
}

function FindingsList({ findings }: { findings: readonly Finding[] }): ReactNode {
  const count = findings.length;
  return (
    <section className="findings" aria-label={t`Findings`}>
      <h4>{plural(count, { one: '# finding', other: '# findings' })}</h4>
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
  useLingui();
  return (
    <div className="checkpoint-row" data-testid="checkpoint" data-undo-group={undoGroupId}>
      <span className="checkpoint-label">
        <Trans>Checkpoint · restore to before this turn</Trans> · {MODE_LABELS[mode]}
      </span>
      {taken ? (
        <span className="muted"><Trans>Taken back</Trans></span>
      ) : (
        <button type="button" className="button is-quiet" disabled={disabled} onClick={onRestore}>
          <Trans>Restore to before this turn</Trans>
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
  const count = held.length;
  return (
    <section className="held-plan" aria-label={t`Plan, not run`} data-testid="held-plan">
      <h3>{plural(count, { one: 'Plan only: # step not run', other: 'Plan only: # steps not run' })}</h3>
      <ol>
        {held.map((step, index) => {
          const phrase = phraseFor(step.tool, step.params);
          return <li key={`${index}:${step.tool}`}>{phrase.contentRef === undefined ? phrase.content : renderRef(phrase.contentRef, { userValues: WRITER_VALUE_KEYS })}</li>;
        })}
      </ol>
      {report.heldRequiresRestart === true ? <p role="status"><Trans>This plan used skill instructions or outside text. Switch to Ask and start the original command or request again so its restrictions and warnings are kept.</Trans></p> : <button type="button" className="button" disabled={disabled} onClick={onRun}>
        <Trans>Switch to Ask and run this plan</Trans>
      </button>}
    </section>
  );
}

function ReportLine({ report, price }: { report: TurnReport; price: TurnView['price'] }): ReactNode {
  const tokens = report.tokens;
  const calls = report.modelCalls;
  const prompt = tokens.promptTokens;
  const completion = tokens.completionTokens;
  // The cost is shown only when the profile the turn ran on has a price (provider-gateway §6): an unpriced turn shows its tokens alone.
  const cost = turnCostOf(tokens, price);
  return (
    <div className="agent-report" aria-label={t`Report`}>
      <p className="agent-report-text">{report.summary}</p>
      <p className="muted agent-report-meta">
        {plural(calls, { one: `# model call · about ${prompt} tokens in, ${completion} out`, other: `# model calls · about ${prompt} tokens in, ${completion} out` })}
      </p>
      {cost !== undefined ? <p className="muted agent-report-meta">{t`About ${{ cost: formatUsd(cost) }} for this turn, at this profile’s prices.`}</p> : null}
      {promptCacheLines(report).map((line) => (
        <p key={line} className="muted agent-report-meta" data-testid="agent-report-cache">
          {line}
        </p>
      ))}
      {report.dropped.length > 0 ? (
        <details className="agent-context">
          <summary><Trans>What the prompt left out</Trans></summary>
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
