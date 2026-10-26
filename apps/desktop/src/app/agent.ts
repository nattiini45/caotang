/**
 * The agent controller: one per open project. It runs a turn on the harness's agent session, folds the turn's events into
 * views (agent-model.ts), holds the decision the loop is waiting for, and carries each drafted scene to its editor's ghost
 * preview (agent-harness §8).
 *
 * ## The decision is the user's, and the loop waits for it
 *
 * `createAgentSession` asks `decide` for every card and does nothing until it is answered. `decide` parks the card here
 * and resolves when the panel or the ghost calls `answer`. Approval first saves the writer's typing, so the agent applies
 * to the text the writer sees (the revision backstop still guards the rest, command-bus §6).
 *
 * ## Approval needs each draft on screen
 *
 * Prose is never applied without a preview (agent-harness §8). A pending card that drafts a scene can be approved only once
 * the draft has been on screen in its scene while the card was shown. The ghost region belongs to one open document, so a
 * plan that drafts several scenes is approved once each has been shown in turn; a draft not yet shown is written out in the
 * card (`draftCheckOf`). A scene is on screen only while its editor is shown, so the corkboard does not count.
 *
 * ## The ghost
 *
 * A drafted scene reaches the editor as a `ghost` event that names the scene as the model wrote it. `documentIdFor` resolves
 * the name the way the harness does, so the draft goes to the editor of the scene it will land in. Each open document has one
 * ghost region (editor-engine §8): the text is handed to the region of the draft's document when it is mounted, and that
 * document is opened first if it is not. Apply, Retry and Discard are the ghost's own callbacks, and they answer the decision
 * the loop is waiting on.
 *
 * ## Stop, steer and the queue
 *
 * Each turn has an `AbortController` of its own, and its signal rides in the turn's options. `stop` aborts it and answers a parked
 * card with Cancel, so a stopped turn ends exactly as a cancelled one does (agent-harness §2, "Stop and steer"). `steer` hands a note
 * to the running turn, which the model reads at its next request; a note the turn ends without delivering becomes the first queued
 * message. The queue holds messages typed while a turn ran: each is a future turn, started once the one before has settled, so no
 * two turns ever run at once (decisions.md: "An approved turn stays busy until it settles"). The queue is view state of this
 * controller: it is not project state, it is not undoable, and it never reaches the bus or the activity log.
 *
 * ## Background tasks
 *
 * A planner's plan that needs five or more model calls is offered to the background before any call is made (`beforeStage`): the
 * offer is parked here like a card, and the writer's answer is Run now, Run in background or Cancel. A plan sent to the background
 * becomes a task in the project's queue (task-queue.ts), the turn ends with a report that says so, and the writer can send the next
 * intent at once. The queue only stages. A ready task is reviewed from the Tasks list as a turn of its own (`reviewTask`): the
 * card, the ghost previews and the apply are the ordinary path, and no model call is made for a draft already held.
 *
 * ## Permission modes
 *
 * The mode (agent-harness §4) is the app's `agent.defaultMode` setting until the writer picks another for this panel; that pick is
 * the session override, held here and never saved. The loop reads it at each card, so a switch in the middle of a turn applies from
 * the next card. A card the mode approves never reaches `decide`: the loop applies it, and `beforeAutoApply` saves the writer's typing
 * first, as an approval here does. Plan-only keeps the writes it refused, and "Switch to Ask and run this plan" sends them as a plan.
 *
 * ## Interrupted runs
 *
 * Every turn is logged ahead of its work in the runtime database (agent-harness §5.1). A run a reload, a crash or a closed tab left
 * unfinished is found marked interrupted when the project opens (lifecycle.ts), and the panel offers it as a card: Resume and Discard log.
 * Resume is the writer's click and nothing else: it can re-issue a paid model call. The log is checked against the project first, and a
 * write that did not land or a document that moved on is said by name instead of resuming. Discard log deletes the log and keeps the writes.
 *
 * ## Restore
 *
 * "Restore to before this turn" is the session's `restoreBefore`. It takes back every change made after the turn as well, so
 * the document ends where it was before the turn, and the confirmation says so.
 */

import type { GhostPreview } from '@caotang/editor/tiptap';
import type { ProfileView } from '@caotang/gateway';
import {
  createAgentSession,
  createBudgetMeter,
  createContextPort,
  preloadFor,
  RUN_LOG_VERSION,
  structureDigest,
  summarizeRun,
  DEFAULT_ACTIVE_MS,
  PERMISSION_MODES,
  type BudgetMeter,
  type ContextConfig,
  type AgentEvent,
  type AgentSession,
  type BudgetSpend,
  type Decision,
  type OfferAnswer,
  type PendingCard,
  type PermissionMode,
  type PlanCardView,
  type PlanOffer,
  type RunLimits,
  type RunLogPort,
  type TurnOptions,
  type TurnReport,
} from '@caotang/harness';
import { newId } from '@caotang/ids';
import { createRunLogPort, nodeById } from '@caotang/store';

import { documentIdFor, draftCheckOf, newTurnView, reduceTurn, spendLine, type DraftCheck, type GhostView, type TurnView } from './agent-model.js';
import { fixPlanFor } from './findings-model.js';
import { DEFAULT_AGENT_SETTINGS, type AgentSettings } from './settings.js';
import { requestInkCompilerFor } from './ink-compiler.js';
import type { ProviderService } from './providers.js';
import type { ProjectSession, RestoreResult } from './session.js';
import { TaskQueue, type TaskAgent } from './task-queue.js';
import { announcementFor, viewOf, type TaskView } from './task-model.js';
import { TaskStore, type TaskRecord } from './task-store.js';

/** Where a turn runs. The demo intents run on the built-in demo profile, whatever is active (context-assembly §6). */
export interface SubmitOptions {
  readonly demo?: boolean;
  /** The spend an interrupted run had when it stopped: a resumed turn's meter starts from it, so the run's limits count what it already used. */
  readonly restoredSpend?: BudgetSpend;
}

/** A run the project was left with, as the panel's interrupted-run card shows it (agent-harness §5.1). */
export interface InterruptedRunView {
  readonly runId: string;
  /** What the writer asked for. */
  readonly intent: string;
  /** Steps applied, and the steps of the plan the run was on. */
  readonly applied: number;
  readonly total: number;
  /** The run's spend in the words the panel's spend line uses, or `null` when the log holds none. */
  readonly spend: string | null;
  /** Whether Resume is offered. */
  readonly resumable: boolean;
  /** Why it is not, or what to know before resuming, as a sentence. */
  readonly note: string | null;
}

/** A message the writer typed while a turn ran. It is a future turn: it starts once the turn before it has settled. */
export interface QueuedMessage {
  readonly id: string;
  readonly intent: string;
  readonly options: SubmitOptions;
  /** A steering note the running turn ended before delivering, moved here so it is not lost. */
  readonly fromUndeliveredNote?: boolean;
}

/** A note sent to the running turn that has not reached the model yet. */
export interface PendingNote {
  readonly noteId: string;
  readonly text: string;
  /** Where it lands: the next model call, or after the decision of the card that waits. */
  readonly lands: 'next-model-call' | 'after-decision';
}

/** What `steer` did with a note. */
export type SteerResult = 'sent' | 'card-waiting' | 'idle' | 'refused';

/** The plan the writer is asked about before it is staged, and what the Run in background button may do. */
export interface OfferView {
  readonly offer: PlanOffer;
  /** Why the plan cannot go to the background in this browser, in a sentence, or `null` when it can. */
  readonly unavailable: string | null;
  /** Why the last Run in background was refused, in a sentence, or `null`. */
  readonly error: string | null;
}

/** What the controller needs of the background queue beyond the project: a test stands in for the store and the clock. */
export interface BackgroundOptions {
  readonly store?: TaskStore;
  readonly locksAvailable?: () => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface AgentSnapshot {
  /** Every turn this project has run in this visit, oldest first. */
  readonly turns: readonly TurnView[];
  /** The decision the loop is waiting for, or `null`. */
  readonly pending: PendingCard | null;
  /** A turn is running. The panel queues what the writer types meanwhile instead of starting another. */
  readonly busy: boolean;
  /** Stop is offered: a turn runs, or a card waits. */
  readonly stoppable: boolean;
  /** Stop was pressed and the turn has not settled yet. */
  readonly stopping: boolean;
  /** The runs this project was left with unfinished, oldest first. */
  readonly interrupted: readonly InterruptedRunView[];
  /** The messages typed while a turn ran, in the order they will run. */
  readonly queue: readonly QueuedMessage[];
  /** The queue waits instead of running, after a turn that stopped on a question or never ran. */
  readonly queuePaused: boolean;
  /** Notes sent to the running turn that it has not read yet. */
  readonly notes: readonly PendingNote[];
  /** A line for a screen reader's status region: what Stop, a note or the queue just did. Empty when there is nothing to say. */
  readonly announcement: string;
  /** The turns whose held plan has been sent, so it is offered once. */
  readonly heldRun: readonly string[];
  /** The permission mode in force (agent-harness §4). */
  readonly mode: PermissionMode;
  /** The modes the panel offers: `auto` is left out while Settings › Agent has it off. */
  readonly modes: readonly PermissionMode[];
  /** The name of the active provider, or `null` when none is active. */
  readonly providerName: string | null;
  /** Whether the active provider is the demo one, which answers only the demo intents. */
  readonly providerIsDemo: boolean;
  /** The drafts of the card the loop is showing: one for each drafted scene. */
  readonly ghosts: readonly GhostView[];
  /** What the pending card's drafts need before it can be approved, or `null` when no card waits. */
  readonly drafts: DraftCheck | null;
  /** Whether the pending card may be approved now: it is approvable, and every draft has been on screen. */
  readonly approvable: boolean;
  /** Why the last action did not go through, for the panel. `null` when there is nothing to say. */
  readonly message: string | null;
  /** The plan that waits for the writer to choose how it runs, or `null`. */
  readonly offer: OfferView | null;
  /** The project's background tasks, oldest first, as the project stood when the snapshot was made (`taskViews` reads it now). */
  readonly tasks: readonly TaskView[];
}

/** What the panel says when the queue waits after a turn that stopped on a question. */
export const QUEUE_PAUSED = 'The last turn stopped on a question. Answer it or choose Run the queue.';

// Said without a pointer to the first-run card, which the writer can dismiss for good (settings firstRun), so it may not be on screen.
const NO_PROVIDER = 'No provider is active. Add one in Settings > Providers to use the agent.';

/** The controller each open project's session has, so a panel outside the agent panel (the findings tab) can start a turn in it. */
const controllers = new WeakMap<ProjectSession, AgentController>();

/** The agent controller of an open project, or `undefined` when its panel has not been made. */
export function agentFor(session: ProjectSession): AgentController | undefined {
  return controllers.get(session);
}

export class AgentController {
  private turns: TurnView[] = [];
  private pending: PendingCard | null = null;
  private resolveDecision: ((decision: Decision) => void) | null = null;
  /** A turn is running, from its start until the loop has settled it: an approved card runs under it, so it is not clear at the approval. */
  private busy = false;
  /** The turn that set the per-turn fields below, so only that turn clears them. */
  private turnOwner = 0;
  private turnsStarted = 0;
  /** The running turn's own abort controller: its signal rides in the turn's options. */
  private turnAbort: AbortController | null = null;
  /** The running turn's run limits (agent-harness §7.1): made from Settings when the turn starts, disposed when it settles. */
  private meter: BudgetMeter | null = null;
  private runningAgent: AgentSession | null = null;
  private runningTurnId: string | null = null;
  private stopping = false;
  private queue: QueuedMessage[] = [];
  private queuePaused = false;
  private queueSeq = 0;
  private pendingNotes: PendingNote[] = [];
  private announcement = '';
  /** The runs found interrupted, read from the run log when the panel attaches and after each turn. */
  private interrupted: InterruptedRunView[] = [];
  private readonly runLog: RunLogPort;
  private intentForNextTurn: string | null = null;
  private providerForNextTurn: string | null = null;
  private priceForNextTurn: { readonly prompt: number; readonly completion: number } | null = null;
  /**
   * The agent session one open panel keeps across turns (context-assembly §2, L6): the loop's
   * `started` RecentTurn array lives in this session's closure, so two turns through one controller
   * share the prior turns and the next turn's assembled prompt carries them as L6. It is created on the
   * first turn and never rebuilt: the profile, model and thinking level are the turn's own
   * (`TurnOptions`), so a provider switch keeps the conversation. The conversation ends with the
   * controller itself, a project switch or a reload, and the app has no other affordance that clears it
   * within a visit. Per-turn state is cleared by `harness.endTurn` on every settlement, so a
   * cancelled/refused/failed turn never leaves its per-turn state behind. The conversation is in memory
   * only: a reload starts it over.
   */
  private session_: AgentSession | null = null;
  /** Names the session's turns `<id>.turn-<n>`; fixed for the controller's life, and unique among the controllers of one harness. */
  private readonly sessionId = newId('cmd').slice('cmd_'.length);
  /** The mode the writer picked for this panel over the setting's default. Not saved: a reload starts from the setting again. */
  private modeOverride: PermissionMode | null = null;
  private readonly heldRun = new Set<string>();
  /** The drafts of the card the loop is showing. Each is a value of its own, so a draft shown for an earlier card is never this one. */
  private ghosts: GhostView[] = [];
  /** The drafts that have been on screen in their scene while their card is shown. */
  private readonly previewed = new Set<GhostView>();
  /** The documents whose editor is on screen now. A draft is on screen only in one of these. */
  private readonly visibleDocs = new Set<string>();
  private readonly editors = new Map<string, GhostPreview>();
  /** The text a scene's draft has streamed so far, by document, while the model writes it (agent-harness §8). */
  private readonly streams = new Map<string, string>();
  private message: string | null = null;
  private readonly listeners = new Set<() => void>();
  private snapshotValue: AgentSnapshot;
  /** Whether the panel that shows this controller has gone. A detached controller refuses to park a decision. */
  private detached = false;
  /** The offer the loop is waiting on, with the way to answer it. */
  private offer: { view: OfferView; resolve: (answer: OfferAnswer) => void } | null = null;
  private readonly tasks: TaskQueue;
  /** The status each task had when the panel last heard of it, so only a change is announced. */
  private readonly taskStatus = new Map<string, TaskRecord['status']>();
  /** Opening and closing the queue run one after the other, so a panel that attaches twice reads the tasks once at a time. */
  private queueWork: Promise<void> = Promise.resolve();

  constructor(
    private readonly session: ProjectSession,
    private readonly providers: ProviderService,
    /** The assembler's budgets, read at each turn so a change in Settings applies to the next one (context-assembly §3). */
    private readonly contextConfig: () => ContextConfig = () => ({}),
    /** Whether every tool is declared on every request, read at each request so Settings › Agent applies to the next one (agent-harness §3). */
    private readonly loadEveryTool: () => boolean = () => false,
    background: BackgroundOptions = {},
    /** The Agent settings, read at each card and turn so a change in Settings applies to the next one (agent-harness §4). */
    private readonly agentSettings: () => AgentSettings = () => DEFAULT_AGENT_SETTINGS,
  ) {
    this.tasks = new TaskQueue({
      projectId: session.projectId,
      store: background.store ?? new TaskStore(),
      agentFor: (_task, sessionId, maxModelCalls) => this.agentForTask(sessionId, maxModelCalls),
      foregroundBusy: () => this.busy,
      ...(background.locksAvailable === undefined ? {} : { locksAvailable: background.locksAvailable }),
      ...(background.sleep === undefined ? {} : { sleep: background.sleep }),
    });
    this.runLog = createRunLogPort(session.runtimeStore());
    this.tasks.subscribe(() => this.onTasksChanged());
    this.snapshotValue = this.buildSnapshot();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The current snapshot. It changes identity only when something the panel shows has changed. */
  snapshot = (): AgentSnapshot => this.snapshotValue;

  /** Tells the subscribers the provider or another input changed, so the snapshot is read again. */
  refresh(): void {
    this.bump();
  }

  private bump(): void {
    this.snapshotValue = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  private buildSnapshot(): AgentSnapshot {
    const active = this.providers.active();
    const drafts = this.draftCheck();
    return {
      turns: this.turns,
      pending: this.pending,
      busy: this.busy,
      stoppable: this.busy || this.pending !== null,
      stopping: this.stopping,
      interrupted: this.interrupted,
      queue: this.queue,
      queuePaused: this.queuePaused,
      notes: this.pendingNotes,
      announcement: this.announcement,
      heldRun: [...this.heldRun],
      mode: this.mode(),
      modes: PERMISSION_MODES.filter((mode) => mode !== 'auto' || !this.agentSettings().lockAuto),
      providerName: active?.name ?? null,
      providerIsDemo: active?.kind === 'mock',
      ghosts: this.ghosts,
      drafts,
      approvable: this.pending !== null && this.pending.card.approvable && (drafts === null || drafts.blocked === null),
      message: this.message,
      offer: this.offer?.view ?? null,
      tasks: this.tasks.snapshot().map((task) => viewOf(task, this.session.state)),
    };
  }

  /* ------------------------------------------------------------------ *
   * Turns
   * ------------------------------------------------------------------ */

  /**
   * Runs one turn for `intent`. One turn runs at a time. A turn with no provider to run on is refused with a message, and no
   * model call is made. A demo turn runs on the built-in demo profile, whichever profile is active.
   */
  async submit(intent: string, options: SubmitOptions = {}): Promise<TurnReport | null> {
    const trimmed = intent.trim();
    if (trimmed === '') return null;
    // A turn about a dialogue container or a storyboard starts with that module's tools loaded (PRELOAD_BY_CONTEXT), so it
    // costs no search. The node is the one the writer has selected, which is the document the centre pane shows.
    const preload = preloadFor(this.activeNode());
    return this.turnWith(trimmed, options, (agent, turn) => agent.submit(trimmed, { preload, ...turn }));
  }

  /**
   * The run limits a turn is held to, from Settings › Agent (agent-harness §7.1): the limits the writer set on tokens, cost and steps,
   * and the time a turn may work (ten minutes unless the writer chose another). A limit left empty is not a run limit.
   */
  private runLimits(): RunLimits {
    const budget = this.agentSettings().budget;
    return {
      ...(budget.maxTokens === undefined ? {} : { maxTokens: budget.maxTokens }),
      ...(budget.maxCostUsd === undefined ? {} : { maxCostUsd: budget.maxCostUsd }),
      ...(budget.maxSteps === undefined ? {} : { maxSteps: budget.maxSteps }),
      maxActiveMs: budget.maxActiveMinutes === undefined ? DEFAULT_ACTIVE_MS : budget.maxActiveMinutes * 60_000,
    };
  }

  /** The permission mode in force: the writer's pick for this panel, else the setting's default. A locked `auto` reads as Ask. */
  mode(): PermissionMode {
    const settings = this.agentSettings();
    const mode = this.modeOverride ?? settings.defaultMode;
    return mode === 'auto' && settings.lockAuto ? 'ask' : mode;
  }

  /** Picks the mode for this panel. It applies from the next card, also in a turn that is running. Auto is refused while Settings has it off. */
  setMode(mode: PermissionMode): void {
    if (mode === 'auto' && this.agentSettings().lockAuto) {
      this.message = 'Auto is turned off in Settings › Agent.';
      this.bump();
      return;
    }
    this.modeOverride = mode;
    this.announcement = `Mode: ${mode}. It applies from the next card.`;
    this.bump();
  }

  /**
   * "Switch to Ask and run this plan": the writes Plan only refused in a turn, sent as the plan of a turn of their own, in Ask. The plan is
   * checked and drafted as a planner's is, and its card is the writer's.
   */
  async runHeldPlan(turnId: string): Promise<TurnReport | null> {
    const turn = this.turns.find((entry) => entry.turnId === turnId);
    const held = turn?.report?.heldSteps;
    if (turn === undefined || held === undefined || held.length === 0 || this.busy || this.heldRun.has(turnId)) return null;
    this.heldRun.add(turnId);
    this.modeOverride = 'ask';
    this.bump();
    return this.turnWith(turn.intent, {}, (agent, options) => agent.submitPlan(turn.intent, { steps: held }, options));
  }

  /** Saves the writer's typing before a card the mode approved applies, and lists the images again before a compile, as an approval does. */
  private async beforeAutoApply(card: PlanCardView): Promise<void> {
    await this.session.autosave.flush().catch(() => undefined);
    if (card.steps.some((step) => step.tool.startsWith('export.compile'))) await this.session.exportsReady().catch(() => undefined);
  }

  /** How many turns this controller has started. A queued message counts once it starts, never while it waits. */
  turnCount(): number {
    return this.turnsStarted;
  }

  /** The first selected node that still exists, or undefined: a deleted node may linger in view state. */
  private activeNode() {
    for (const id of this.session.view.selection) {
      const node = nodeById(this.session.state, id);
      if (node !== undefined) return node;
    }
    return undefined;
  }

  /**
   * "Fix with agent" on a finding (coherence.md §6.3): a turn whose plan is the finding's passage, rewritten. The plan is built
   * here, from the text as it stands, and the turn's card is decided like any other. Nothing is written until the writer approves.
   */
  async fixFinding(findingId: string): Promise<TurnReport | null> {
    const fix = fixPlanFor(this.session.state, this.session.coherenceFile(), findingId);
    if (typeof fix === 'string') {
      this.message = fix;
      this.bump();
      return null;
    }
    return this.turnWith(fix.intent, {}, (agent, turn) => agent.submitPlan(fix.intent, fix.plan, turn));
  }

  /** Runs one turn on the active provider (or the demo's), with `start` as the turn's entry point. One turn runs at a time. */
  private async turnWith(
    intent: string,
    options: SubmitOptions,
    start: (agent: AgentSession, turn: TurnOptions) => Promise<TurnReport>,
  ): Promise<TurnReport | null> {
    if (this.busy) return null;
    this.message = null;
    this.announcement = '';
    this.busy = true;
    this.turnsStarted += 1;
    const owner = this.turnsStarted;
    const abort = new AbortController();
    this.turnAbort = abort;
    this.bump();
    let report: TurnReport | null = null;
    try {
      // The demo intents run on the built-in demo profile, whichever profile is active (context-assembly §6).
      // Every other turn runs under the 'chat' role (provider-gateway §6). The role's profile, model and thinking
      // resolve once here and pin the session: a turn cannot change provider mid-flight, and the pinned id is what
      // the loop's capability reads (modelCaps/modelLimits) must see.
      const resolved = options.demo === true ? undefined : this.providers.resolveForRole?.('chat');
      const profile: ProfileView | undefined =
        options.demo === true ? await this.providers.demoProfile() : (resolved?.profile ?? this.providers.active());
      if (profile === undefined) {
        this.message = NO_PROVIDER;
        return null;
      }
      // The dialogue tools compile Ink synchronously, so the compiler is loaded before the turn plans (ink-compiler.ts).
      await requestInkCompilerFor(this.session.state);
      this.turnOwner = owner;
      this.intentForNextTurn = intent;
      this.providerForNextTurn = profile.name;
      this.priceForNextTurn = profile.pricePer1k ?? null;
      // One agent session per controller keeps `started` RecentTurn list across turns (context-assembly §2, L6).
      // The turn carries its own pins, so a provider switch between turns keeps the session; the per-turn state
      // (call cache, plan cache, undo group, loaded tools) is cleared by `harness.endTurn` after every
      // settlement, so a cancelled/refused/failed turn cannot leave its state behind in the shared session.
      const model = resolved?.model;
      const thinking = resolved?.thinking;
      const agent: AgentSession =
        this.session_ ??
        (this.session_ = createAgentSession({
          harness: this.session.harness,
          gateway: this.providers.gateway,
          context: createContextPort({ state: this.session.state, config: this.contextConfig, withheld: (tool) => this.session.harness.withheld(tool) }),
          decide: (pending) => this.decide(pending),
          emit: (event) => this.onEvent(event),
          role: 'chat',
          sessionId: this.sessionId,
          loadEveryTool: this.loadEveryTool,
          beforeStage: (offer) => this.askOffer(offer),
          mode: () => this.mode(),
          lockAuto: () => this.agentSettings().lockAuto,
          budget: () => {
            // The model-call bound is read at each turn; the time limit is the meter's, not a turn budget.
            const { maxActiveMinutes: _minutes, ...budget } = this.agentSettings().budget;
            return budget;
          },
          meter: () => this.meter ?? undefined,
          price: () => this.priceForNextTurn ?? undefined,
          beforeAutoApply: (card) => this.beforeAutoApply(card),
          runLog: {
            port: this.runLog,
            projectId: this.session.projectId,
            // A step's record is written only once the project holds the step, so "applied" in the log means saved.
            flush: () => this.session.saved(),
            onNotice: (message) => {
              this.message = message;
              this.bump();
            },
          },
        }));
      this.runningAgent = agent;
      this.meter = createBudgetMeter(this.runLimits(), options.restoredSpend === undefined ? {} : { restored: options.restoredSpend });
      report = await start(agent, {
        signal: abort.signal,
        profileId: profile.id,
        ...(model === undefined ? {} : { model }),
        ...(thinking === undefined ? {} : { thinking }),
      });
      return report;
    } catch (error) {
      this.message = `The turn stopped unexpectedly: ${error instanceof Error ? error.message : String(error)}`;
      return null;
    } finally {
      // The turn has settled, so the next one may start. Only the turn that set the per-turn fields clears them.
      this.busy = false;
      this.stopping = false;
      this.turnAbort = null;
      this.meter?.dispose();
      this.meter = null;
      this.runningAgent = null;
      this.runningTurnId = null;
      if (this.turnOwner === owner) {
        this.turnOwner = 0;
        this.intentForNextTurn = null;
        this.providerForNextTurn = null;
        this.priceForNextTurn = null;
      }
      // The findings a turn's coherence tools wrote are saved with the turn, since no bus command reports them (coherence.md §3).
      this.session.coherenceChanged();
      // Usage and the request log are kept after every turn, so a closed tab loses at most the turn in flight.
      void this.providers.persist();
      this.afterTurn(report);
      void this.loadInterrupted();
      this.bump();
    }
  }

  /**
   * What follows a settled turn (decisions.md: queued messages run one turn at a time). A note the turn ended without delivering
   * goes to the front of the queue as a message of its own. The queue then pauses after a turn that stopped on a question, or that
   * never ran, so it never piles writes on an unresolved failure; otherwise the next entry starts on a microtask, once `busy` is clear.
   */
  private afterTurn(report: TurnReport | null): void {
    const stopped = report?.stop !== undefined;
    if (this.pendingNotes.length > 0) {
      const undelivered = this.pendingNotes.map(
        (note): QueuedMessage => ({ id: this.nextQueueId(), intent: note.text, options: {}, fromUndeliveredNote: true }),
      );
      this.queue = [...undelivered, ...this.queue];
      this.pendingNotes = [];
    }
    // A turn that stopped on a question, or never ran, holds the queue; a turn that went through (the answer to that question, say) lets it go.
    this.queuePaused = (report === null || (report.status === 'failed' && report.askBack !== undefined)) && this.queue.length > 0;
    if (stopped) this.announcement = this.queue.length > 0 && !this.queuePaused ? 'Stopped by you. The next queued message runs now.' : 'Stopped by you.';
    else if (this.queuePaused) this.announcement = QUEUE_PAUSED;
    if (this.queue.length > 0 && !this.queuePaused && !this.detached) queueMicrotask(() => void this.runNext());
  }

  private nextQueueId(): string {
    this.queueSeq += 1;
    return `queued-${this.queueSeq}`;
  }

  /* ------------------------------------------------------------------ *
   * Interrupted runs
   * ------------------------------------------------------------------ */

  /**
   * Reads the project's unfinished runs from the run log and checks each against the project as it stands. A run whose log could not be
   * written is not offered: it does not describe the run. A log this build cannot read is offered for discarding only.
   */
  async loadInterrupted(): Promise<void> {
    if (this.busy) return;
    let rows: Awaited<ReturnType<RunLogPort['open']>>;
    try {
      rows = await this.runLog.open(this.session.projectId);
    } catch {
      return;
    }
    const views: InterruptedRunView[] = [];
    const tree = this.session.state.manifest.tree;
    for (const run of rows) {
      if (run.status !== 'interrupted' || run.cannotResume === true) continue;
      let summary: ReturnType<typeof summarizeRun>;
      try {
        summary = summarizeRun(
          await this.runLog.events(run.runId),
          (id) => this.session.state.documents.get(id)?.revision,
          { nameOf: (id) => tree.find((node) => node.id === id)?.title ?? id, structure: () => structureDigest(this.session.state.manifest) },
        );
      } catch {
        continue;
      }
      if (run.schema !== RUN_LOG_VERSION || summary === undefined) {
        views.push({ runId: run.runId, intent: run.intent, applied: 0, total: 0, spend: null, resumable: false, note: 'This run’s log is damaged or was written by another version of Caotang, so it cannot be resumed.' });
        continue;
      }
      views.push({
        runId: run.runId,
        intent: summary.intent,
        applied: summary.applied,
        total: summary.total,
        spend: summary.spend === undefined ? null : (spendLine({ spend: summary.spend, limits: this.runLimits() }) ?? null),
        resumable: summary.resumable,
        note: summary.note ?? null,
      });
    }
    if (this.detached) return;
    const same = JSON.stringify(views) === JSON.stringify(this.interrupted);
    this.interrupted = views;
    if (!same) this.bump();
  }

  /**
   * Resumes an interrupted run. The writer's click calls it, and nothing else does. A card the run was showing comes back needing its own
   * Approve; a run that was waiting on the model asks it again, and the call the stop lost counts as spent against the run's limits.
   */
  async resumeRun(runId: string): Promise<TurnReport | null> {
    if (this.busy) {
      this.message = 'The agent is working on another turn. Resume the run when it has finished.';
      this.bump();
      return null;
    }
    const view = this.interrupted.find((entry) => entry.runId === runId);
    if (view === undefined || !view.resumable) {
      this.message = 'That run can no longer be resumed.';
      this.bump();
      return null;
    }
    // The resumed meter starts from the logged spend. A log that cannot be read gives no spend to start from, so the run is not resumed.
    let restoredSpend: BudgetSpend | undefined;
    try {
      const tree = this.session.state.manifest.tree;
      restoredSpend = summarizeRun(await this.runLog.events(runId), (id) => this.session.state.documents.get(id)?.revision, {
        nameOf: (id) => tree.find((node) => node.id === id)?.title ?? id,
      })?.restoredSpend;
    } catch {
      restoredSpend = undefined;
    }
    if (restoredSpend === undefined) {
      this.message = 'The run log could not be read, so the run was not resumed. Try again, or discard the log.';
      this.bump();
      return null;
    }
    this.announcement = 'Resuming the run.';
    return this.turnWith(view.intent, { restoredSpend }, (agent, turn) => agent.resume(runId, turn));
  }

  /** "Discard log": deletes the run's log and nothing else. What the run wrote stays in the project. */
  async discardRun(runId: string): Promise<void> {
    try {
      await this.runLog.discard(runId);
    } catch (error) {
      this.message = `The run log could not be discarded: ${error instanceof Error ? error.message : String(error)}`;
      this.bump();
      return;
    }
    this.announcement = 'Run log discarded. What the agent wrote stays in the project.';
    await this.loadInterrupted();
    this.bump();
  }

  /* ------------------------------------------------------------------ *
   * Stop, steer and the queue
   * ------------------------------------------------------------------ */

  /**
   * Stops the running turn (agent-harness §2). The turn ends at its next boundary as cancelled by the writer: what it applied stays,
   * and a bus command that has started is not interrupted. A card that waits is cancelled, exactly as its Cancel does.
   */
  stop(): void {
    if (this.turnAbort === null || this.stopping) return;
    this.stopping = true;
    this.announcement = 'Stopping the turn.';
    this.turnAbort.abort();
    const resolve = this.resolveDecision;
    this.resolveDecision = null;
    this.pending = null;
    this.dropOffer();
    this.clearGhosts();
    resolve?.({ action: 'cancel' });
    this.bump();
  }

  /**
   * Sends the running turn a note, which the model reads at its next request. While a card waits the note is not sent: the panel
   * offers Send with Cancel and Queue as next turn, and neither approves or drops the card behind the writer's back.
   */
  steer(text: string): SteerResult {
    const note = text.trim();
    if (note === '') return 'refused';
    if (!this.busy || this.runningAgent === null || this.runningTurnId === null) return 'idle';
    if (this.pending !== null) return 'card-waiting';
    return this.sendNote(note);
  }

  /** Cancels the waiting card, and sends the note with the Cancel: the turn goes back to the model with it (agent-harness §2). */
  sendWithCancel(text: string): void {
    const note = text.trim();
    if (note === '' || this.pending === null) return;
    if (this.sendNote(note) === 'sent') this.answer({ action: 'cancel' });
  }

  private sendNote(note: string): SteerResult {
    if (this.runningAgent === null || this.runningTurnId === null) return 'idle';
    const receipt = this.runningAgent.steer(this.runningTurnId, note);
    if (!receipt.ok) {
      this.message = receipt.error.message;
      this.bump();
      return 'refused';
    }
    this.pendingNotes = [...this.pendingNotes, { noteId: receipt.value.noteId, text: note, lands: receipt.value.lands }];
    this.announcement = 'Note sent. The agent reads it at its next step.';
    this.bump();
    return 'sent';
  }

  /** Adds a message to the queue. With no turn running (and the queue not paused) it starts at once. */
  enqueue(intent: string, options: SubmitOptions = {}): void {
    const text = intent.trim();
    if (text === '') return;
    this.queue = [...this.queue, { id: this.nextQueueId(), intent: text, options }];
    this.announcement = this.busy ? `Queued. ${this.queue.length} ${this.queue.length === 1 ? 'message' : 'messages'} waiting.` : '';
    this.bump();
    if (!this.busy && !this.queuePaused) queueMicrotask(() => void this.runNext());
  }

  editQueued(id: string, intent: string): void {
    const text = intent.trim();
    if (text === '') return;
    this.queue = this.queue.map((entry) => (entry.id === id ? { ...entry, intent: text } : entry));
    this.bump();
  }

  /** Moves a queued message to a place in the queue (0 is next). A place past either end is the end. */
  moveQueued(id: string, to: number): void {
    const from = this.queue.findIndex((entry) => entry.id === id);
    if (from === -1) return;
    const entry = this.queue[from] as QueuedMessage;
    const rest = this.queue.filter((candidate) => candidate.id !== id);
    const at = Math.max(0, Math.min(rest.length, to));
    this.queue = [...rest.slice(0, at), entry, ...rest.slice(at)];
    this.bump();
  }

  removeQueued(id: string): void {
    this.queue = this.queue.filter((entry) => entry.id !== id);
    if (this.queue.length === 0) this.queuePaused = false;
    this.bump();
  }

  /** Promotes a queued message to a steering note for the running turn. Not while a card waits: that is the writer's decision to make. */
  steerQueued(id: string): SteerResult {
    const entry = this.queue.find((candidate) => candidate.id === id);
    if (entry === undefined) return 'idle';
    const result = this.steer(entry.intent);
    if (result === 'sent') this.removeQueued(id);
    return result;
  }

  /** Resumes a paused queue. */
  runQueue(): void {
    this.queuePaused = false;
    this.announcement = '';
    this.bump();
    if (!this.busy) queueMicrotask(() => void this.runNext());
  }

  /** Starts the first queued message, when nothing runs and the queue is not paused. */
  private async runNext(): Promise<void> {
    if (this.busy || this.queuePaused || this.detached) return;
    const next = this.queue[0];
    if (next === undefined) return;
    this.queue = this.queue.slice(1);
    this.bump();
    // The entry is submitted as the writer typed it, so anything the intent box parses (a slash command) is read now, when it runs.
    await this.submit(next.intent, next.options);
  }

  /** The loop's decision request. The card is parked here until the panel or the ghost answers it. */
  private decide(pending: PendingCard): Promise<Decision> {
    return new Promise<Decision>((resolve) => {
      if (this.detached) {
        resolve({ action: 'cancel' });
        return;
      }
      // A card that arrives while an older one still waits settles the older one first, so no decision is left parked.
      this.resolveDecision?.({ action: 'cancel' });
      this.pending = pending;
      this.resolveDecision = resolve;
      this.bump();
    });
  }

  /**
   * The user's answer to the card the loop is waiting on. An approval first saves the writer's typing, so the agent applies
   * to the text on the screen; an approval whose drafts are not yet on screen is refused, and the card stays. A retry or a
   * cancel retires the drafts; an edit keeps them until the card is shown again.
   */
  answer(decision: Decision): void {
    const resolve = this.resolveDecision;
    if (resolve === null) {
      this.message = 'That card is no longer waiting for a decision, so nothing was sent.';
      this.bump();
      return;
    }
    if (decision.action === 'approve') {
      const held = this.draftCheck()?.blocked ?? null;
      if (held !== null) {
        this.message = held;
        this.bump();
        return;
      }
    }
    // The card the decision answers, read before it leaves the screen: an approved compile needs its images listed again first.
    const card = this.pending?.card ?? null;
    this.resolveDecision = null;
    this.pending = null;
    if (decision.action !== 'edit') this.clearGhosts();
    this.message = null;
    this.bump();
    if (decision.action === 'approve') {
      // The turn is still running: the loop applies the approved steps under it, and an adjust call may follow. `busy` stays set
      // until the turn settles (turnWith), so the panel shows Working and no second turn starts meanwhile.
      const compiles = card?.steps.some((step) => step.tool.startsWith('export.compile')) ?? false;
      void this.session.autosave
        .flush()
        .catch(() => undefined)
        // An approved compile lists the project's images again, as the export dialog's compile does (session.exportsReady): the
        // compile reads the listing it last made, and an image added since would be missing from the shot list.
        .then(() => (compiles ? this.session.exportsReady().catch(() => undefined) : undefined))
        .then(() => {
          resolve(decision);
          this.bump();
        });
      return;
    }
    resolve(decision);
  }

  /**
   * Restores the project to before a turn: its checkpoint, through the session's `restoreBefore`. The result says how many
   * later changes went back with it, or why the restore stopped.
   */
  async restore(turnId: string): Promise<RestoreResult> {
    const group = this.checkpointOf(turnId);
    if (group === undefined) return { ok: false, message: 'That turn wrote nothing, so there is nothing to restore.' };
    const outcome = await this.session.restoreBefore(group);
    this.bump();
    return outcome;
  }

  /** The changes a restore to before this turn would also take back, oldest first, as the activity log words them. */
  laterChanges(turnId: string): readonly string[] {
    const group = this.checkpointOf(turnId);
    return group === undefined ? [] : this.session.laterChangesAfter(group);
  }

  private checkpointOf(turnId: string): string | undefined {
    const turn = this.turns.find((entry) => entry.turnId === turnId);
    return turn?.checkpoint?.undoGroupId ?? turn?.report?.undoGroupId;
  }

  /* ------------------------------------------------------------------ *
   * Events
   * ------------------------------------------------------------------ */

  private onEvent(event: AgentEvent): void {
    if (event.type === 'turn' && event.phase === 'started' && this.intentForNextTurn !== null) {
      this.runningTurnId = event.turnId;
      this.turns = [...this.turns, newTurnView(event.turnId, this.intentForNextTurn, this.providerForNextTurn, this.priceForNextTurn)];
    }
    // A note has reached the model: it is no longer waiting.
    if (event.type === 'steer') this.pendingNotes = this.pendingNotes.filter((note) => note.noteId !== event.note.noteId);
    // A card is shown again after every edit and redraft, and each showing brings its own drafts, which follow its steps.
    if (event.type === 'plan') this.clearGhosts();
    const tree = this.session.state.manifest.tree;
    const nameOf = (ref: string): string => tree.find((node) => node.id === ref)?.title ?? ref;
    this.turns = this.turns.map((turn) => reduceTurn(turn, event, nameOf));
    if (event.type === 'ghost') this.addGhost(event);
    if (event.type === 'draft.delta') this.streamDraft(event);
    if (event.type === 'report') this.clearGhosts();
    this.bump();
  }

  /* ------------------------------------------------------------------ *
   * The ghost preview
   * ------------------------------------------------------------------ */

  private addGhost(event: Extract<AgentEvent, { type: 'ghost' }>): void {
    const docId = documentIdFor(this.session.state.manifest.tree, event.docTitle);
    const view: GhostView = {
      callId: event.callId,
      docTitle: event.docTitle,
      docId,
      text: event.text,
      words: event.words,
      cut: event.cut === true,
    };
    this.ghosts = [...this.ghosts, view];
    if (docId === null) return;
    // Open the draft's scene, so its ghost region is on screen to receive the text. A view change, never persisted.
    if (this.session.view.activeDocId !== docId) this.session.dispatch('view.setActiveDoc', { docId });
    this.deliverGhost(docId);
  }

  /**
   * A scene draft's text as the model writes it (agent-harness §8): it streams into the scene's ghost region, the first delta
   * empties the region, and the completed draft replaces the stream when its `ghost` event arrives. The scene is opened first,
   * as a completed draft opens it, so the region is on screen to receive the text. The stream is not the panel's text.
   */
  private streamDraft(event: Extract<AgentEvent, { type: 'draft.delta' }>): void {
    const docId = documentIdFor(this.session.state.manifest.tree, event.docTitle);
    if (docId === null) return;
    if (this.session.view.activeDocId !== docId) this.session.dispatch('view.setActiveDoc', { docId });
    const ghost = this.editors.get(docId);
    if (event.start === true) {
      this.streams.set(docId, '');
      ghost?.clear();
    }
    if (event.delta === '') return;
    this.streams.set(docId, `${this.streams.get(docId) ?? ''}${event.delta}`);
    ghost?.append(event.delta);
  }

  /** Writes the streamed text of `docId` into its editor's ghost region, for a stream that started before the editor was mounted. */
  private deliverStream(docId: string): void {
    const ghost = this.editors.get(docId);
    const text = this.streams.get(docId);
    if (ghost === undefined || text === undefined || text === '') return;
    ghost.clear();
    ghost.append(text);
  }

  /** Writes the draft of `docId` into its editor's ghost region, when that editor is mounted. */
  private deliverGhost(docId: string): void {
    const ghost = this.editors.get(docId);
    const view = this.latestGhost(docId);
    if (ghost === undefined || view === undefined) return;
    ghost.clear();
    ghost.append(view.text);
    if (this.visibleDocs.has(docId)) this.previewed.add(view);
  }

  private latestGhost(docId: string): GhostView | undefined {
    return this.ghosts.findLast((view) => view.docId === docId);
  }

  /** The ghost of the document the editor shows has been mounted or re-mounted: hand it the current draft. */
  attachGhost(docId: string, ghost: GhostPreview): void {
    this.editors.set(docId, ghost);
    // A completed draft is shown in full; a draft still streaming shows what it has written so far.
    if (this.latestGhost(docId) === undefined) this.deliverStream(docId);
    else this.deliverGhost(docId);
    this.bump();
  }

  /** The editor for a document has gone. Its ghost is no longer reachable from here. */
  detachGhost(docId: string, ghost: GhostPreview): void {
    if (this.editors.get(docId) === ghost) this.editors.delete(docId);
    this.bump();
  }

  /**
   * The editor of `docId` is on screen, or is hidden (the corkboard is shown, or another scene is). A draft counts as on screen
   * only while its scene's editor is shown, and a draft that has been on screen while its card is shown counts as previewed.
   */
  setEditorVisible(docId: string, visible: boolean): void {
    if (visible) this.visibleDocs.add(docId);
    else this.visibleDocs.delete(docId);
    const view = this.latestGhost(docId);
    if (visible && view !== undefined && this.editors.has(docId)) this.previewed.add(view);
    this.bump();
  }

  /** Retires every draft: the ghost regions that hold one are emptied, and the drafts are forgotten. */
  private clearGhosts(): void {
    for (const view of this.ghosts) {
      if (view.docId !== null) this.editors.get(view.docId)?.clear();
    }
    // A draft that streamed and was never staged (refused, or cut short by a stopped turn) leaves nothing behind.
    for (const docId of this.streams.keys()) this.editors.get(docId)?.clear();
    this.streams.clear();
    this.ghosts = [];
    this.previewed.clear();
  }

  /** What the pending card's drafts need before approval, or `null` when no card waits. */
  private draftCheck(): DraftCheck | null {
    if (this.pending === null) return null;
    const tree = this.session.state.manifest.tree;
    return draftCheckOf({
      card: this.pending.card,
      ghosts: this.ghosts,
      sceneOf: (ref) => {
        const docId = documentIdFor(tree, ref);
        if (docId === null) return null;
        const node = tree.find((candidate) => candidate.id === docId);
        return { docId, title: node?.title ?? ref, ...(node?.kind === undefined ? {} : { kind: node.kind }) };
      },
      onScreen: (docId) => this.visibleDocs.has(docId) && this.editors.has(docId),
      previewed: (view) => this.previewed.has(view),
    });
  }

  /* ------------------------------------------------------------------ *
   * Background tasks
   * ------------------------------------------------------------------ */

  /** The loop's offer. It is parked here until the panel answers it, or the turn is stopped. */
  private askOffer(offer: PlanOffer): Promise<OfferAnswer> {
    return new Promise<OfferAnswer>((resolve) => {
      if (this.detached) {
        resolve('cancel');
        return;
      }
      this.dropOffer();
      this.offer = { view: { offer, unavailable: this.tasks.unavailable(), error: null }, resolve };
      this.announcement = `This plan needs ${offer.estimatedCalls} model calls. Choose how it runs.`;
      this.bump();
    });
  }

  /** Cancels an offer that waits, so no answer is left parked. */
  private dropOffer(): void {
    const held = this.offer;
    this.offer = null;
    held?.resolve('cancel');
  }

  /**
   * The writer's answer to the offer. Run in background queues the plan first, and the turn is told only once it is queued; a plan the
   * queue refuses stays on offer with the reason, and the writer can still run it now or cancel it.
   */
  async answerOffer(choice: OfferAnswer): Promise<void> {
    const held = this.offer;
    if (held === null) return;
    if (choice === 'background') {
      if (held.view.unavailable !== null) return;
      const queued = await this.tasks.enqueue(this.intentForNextTurn ?? '', held.view.offer.steps);
      if (this.offer !== held) return;
      if (!queued.ok) {
        this.offer = { ...held, view: { ...held.view, error: queued.reason } };
        this.bump();
        return;
      }
    }
    this.offer = null;
    this.bump();
    held.resolve(choice);
  }

  /**
   * Opens a ready task for review: a turn of its own on the usual card, with the drafts the background staged. Approving applies them
   * as one undo group; cancelling leaves the task ready to open again. A turn that is running is not interrupted for it.
   */
  async reviewTask(id: string): Promise<TurnReport | null> {
    if (this.busy) {
      this.message = 'The agent is working on another turn. Open this task when it has finished.';
      this.bump();
      return null;
    }
    const found = this.tasks.review(id);
    if (found === undefined) {
      this.message = 'That task is no longer ready to review.';
      this.bump();
      return null;
    }
    const { task, review } = found;
    const report = await this.turnWith(task.intent, {}, (agent, turn) =>
      agent.submitStaged(task.intent, { steps: review.steps }, review.proposals, review.revisions, turn),
    );
    if (report?.status === 'applied') await this.tasks.markApplied(id);
    return report;
  }

  /** The background tasks as the project stands now: a draft is out of date the moment its scene changes, not at the next event. */
  taskViews(): readonly TaskView[] {
    return this.tasks.snapshot().map((task) => viewOf(task, this.session.state));
  }

  cancelTask(id: string): void {
    void this.tasks.cancel(id);
  }

  resumeTask(id: string): void {
    void this.tasks.resume(id);
  }

  dismissTask(id: string): void {
    void this.tasks.dismiss(id);
  }

  /** Whether a task is being drafted or waits to be: the leave prompt warns about it. */
  tasksWorking(): boolean {
    return this.tasks.working();
  }

  /** Resolves when the queue has nothing left to run. A test waits on it. */
  tasksIdle(): Promise<void> {
    return this.tasks.idle();
  }

  /** The session a task is staged with: the Background role's profile, the task's id as its name, and no way to decide a card. */
  private agentForTask(sessionId: string, maxModelCalls: number): TaskAgent | string {
    const resolved = this.providers.resolveForRole?.('background');
    const profile = resolved?.profile ?? this.providers.active();
    if (profile === undefined) return NO_PROVIDER;
    return createAgentSession({
      harness: this.session.harness,
      gateway: this.providers.gateway,
      context: createContextPort({ state: this.session.state, config: this.contextConfig, withheld: (tool) => this.session.harness.withheld(tool) }),
      // Staging shows no card. A card that did arrive would be cancelled, so nothing here waits on a writer who is not looking.
      decide: async () => ({ action: 'cancel' }),
      role: 'background',
      sessionId,
      maxModelCalls,
      loadEveryTool: this.loadEveryTool,
      profileId: profile.id,
      ...(resolved?.model === undefined ? {} : { model: resolved.model }),
      ...(resolved?.thinking === undefined ? {} : { thinking: resolved.thinking }),
    });
  }

  /** The queue changed: the panel redraws, and a task that reached a state the writer should hear about is announced. */
  private onTasksChanged(): void {
    for (const task of this.tasks.snapshot()) {
      if (this.taskStatus.get(task.id) === task.status) continue;
      const known = this.taskStatus.has(task.id);
      this.taskStatus.set(task.id, task.status);
      // The statuses a project opens with are not news; a change after that is.
      if (known || task.status === 'ready') this.announcement = announcementFor(task) || this.announcement;
    }
    this.bump();
  }

  /* ------------------------------------------------------------------ *
   * Lifecycle
   * ------------------------------------------------------------------ */

  /** Ends the controller. A decision still waiting is cancelled, so the turn ends and nothing is left parked. */
  detach(): void {
    this.detached = true;
    const resolve = this.resolveDecision;
    this.resolveDecision = null;
    this.pending = null;
    this.dropOffer();
    this.clearGhosts();
    resolve?.({ action: 'cancel' });
    // The queue stops with the panel: a task in flight is interrupted and can be resumed when the project is open again.
    this.queueWork = this.queueWork.then(() => this.tasks.close());
    this.bump();
  }

  /**
   * The panel that shows this controller is (again) on screen. React runs effects twice in development, so a controller is
   * detached and attached again before the first screen is drawn; a detach is therefore not the end of the controller.
   */
  attach(): void {
    this.detached = false;
    void this.loadInterrupted();
    this.queueWork = this.queueWork.then(() => this.tasks.open());
    // Registered here, where the panel that shows the controller attaches it, so a controller React discarded (StrictMode builds
    // one twice) is never the one a findings panel reaches.
    controllers.set(this.session, this);
  }
}
