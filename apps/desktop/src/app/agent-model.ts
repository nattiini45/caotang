/**
 * The agent panel's view of a turn, as data (agent-harness §8). The harness emits one ordered stream of events per turn;
 * `reduceTurn` folds each event into the turn's view, so the panel renders a value and two readers of one turn cannot
 * disagree about it. Nothing here touches the DOM, the store or the gateway.
 */

import {
  CHECKPOINT_LABEL,
  emptyTaskList,
  phraseFor,
  reduceTaskList,
  type AgentEvent,
  type AskBack,
  type BudgetSpend,
  type PreviewLayer,
  type Finding,
  type NameOf,
  type PermissionMode,
  type PlanCardView,
  type PlanStepView,
  type RunLimits,
  type SteeringNote,
  type StatusCard,
  type TaskList,
  type TurnPhase,
  type TurnReport,
} from '@caotang/harness';
import type { TreeNode } from '@caotang/store';

/** How much of the streamed model text the panel keeps to show that work is happening. */
export const STREAM_TAIL_CHARS = 240;

/** A draft the loop staged for a scene, as its `ghost` event carries it (agent-harness §8). */
export interface DraftEvent {
  readonly callId: string;
  /** The scene reference the step names, as the model wrote it. */
  readonly docTitle: string;
  readonly text: string;
  readonly words: number;
  readonly cut: boolean;
}

/** A draft as the controller holds it: the event, and the document its reference names (`null` when it names none). */
export interface GhostView extends DraftEvent {
  readonly docId: string | null;
}

export interface LadderView {
  readonly callId: string;
  readonly attempt: number;
  readonly askBack: AskBack;
}

export interface ContextView {
  readonly layers: readonly Pick<PreviewLayer, 'id' | 'tokens'>[];
  readonly dropped: readonly string[];
}

export interface TurnView {
  readonly turnId: string;
  readonly intent: string;
  /** The slash command that started the turn (`draft`), or `null`. It is known when the turn starts; the report names it too. */
  readonly command: string | null;
  /** The name of the provider the turn runs on, or `null` before the turn has started. */
  readonly provider: string | null;
  /** The price per 1,000 tokens of the profile the turn runs on, when it has one (provider-gateway §2). The report prices its tokens with it. */
  readonly price: { readonly prompt: number; readonly completion: number } | null;
  /** The latest phase the turn reported (`started`, `planning`, `awaiting-approval`, …). */
  readonly phase: TurnPhase | 'idle';
  /** One status card per tool call, in the order the calls first appeared, each at its latest state. */
  readonly cards: readonly StatusCard[];
  /** The latest plan or one-step confirm card. It is the card the user is deciding while a decision is pending. */
  readonly plan: PlanCardView | null;
  /** Counts the plan cards the loop has shown in this turn. A card is re-read from the start each time it is shown. */
  readonly planSeq: number;
  /** The card above was approved by the mode's policy, not the writer (agent-harness §4): it is shown collapsed with an auto-approved badge. */
  readonly planAuto: boolean;
  /** The permission mode the turn is in: the mode it started in, and the one it ended in once it has reported. `null` before it has started. */
  readonly mode: PermissionMode | null;
  readonly ghost: DraftEvent | null;
  readonly ladder: readonly LadderView[];
  readonly findings: readonly Finding[];
  /** The checkpoint row, with its scope note when the turn called an external tool (extensibility §6). */
  readonly checkpoint: { readonly undoGroupId: string; readonly label: string; readonly mode: PermissionMode; readonly note?: string } | null;
  readonly report: TurnReport | null;
  /** The tail of the text the model is writing right now. */
  readonly streamed: string;
  /** The reasoning the model has streamed this turn, in full — the collapsed "Thinking" block's text. */
  readonly reasoning: string;
  readonly context: ContextView | null;
  /** The checklist of the turn, folded from the same events (agent-harness §8). Never sent to the model. */
  readonly tasks: TaskList;
  /** The notes the writer sent that the model has read, in order (agent-harness §2, "Stop and steer"). */
  readonly steering: readonly SteeringNote[];
  /** The run's spend and its limits after the last model call, for the live spend line (agent-harness §7.1). `null` before the first call. */
  readonly run: { readonly spend: BudgetSpend; readonly limits: RunLimits } | null;
  /** The writer rewound the conversation past this turn: the model is not sent it (context-assembly §2, L6). It stays in the panel, collapsed. */
  readonly rewound: boolean;
  /** When the writer took this turn's project changes back while keeping the conversation (epoch ms), or `null`. L6 says so too. */
  readonly restoredAt: number | null;
}

/** A turn that has been submitted and has not yet reported its id. */
export function newTurnView(
  turnId: string,
  intent: string,
  provider: string | null = null,
  price: { readonly prompt: number; readonly completion: number } | null = null,
  command: string | null = null,
): TurnView {
  return {
    turnId,
    intent,
    command,
    provider,
    price,
    phase: 'idle',
    cards: [],
    plan: null,
    planSeq: 0,
    planAuto: false,
    mode: null,
    ghost: null,
    ladder: [],
    findings: [],
    checkpoint: null,
    report: null,
    streamed: '',
    reasoning: '',
    context: null,
    tasks: emptyTaskList(turnId),
    steering: [],
    run: null,
    rewound: false,
    restoredAt: null,
  };
}

/**
 * Folds one event into a turn, and into the turn's task list beside it. An event for another turn is returned unchanged, so a
 * caller may pass every event through every turn it holds. `nameOf` shows a document reference by its title in the task list.
 */
export function reduceTurn(turn: TurnView, event: AgentEvent, nameOf?: NameOf): TurnView {
  if (event.turnId !== turn.turnId) return turn;
  const tasks = reduceTaskList(turn.tasks, event, nameOf);
  const next = reduceView(turn, event);
  return tasks === next.tasks ? next : { ...next, tasks };
}

function reduceView(turn: TurnView, event: AgentEvent): TurnView {
  switch (event.type) {
    case 'turn':
      return { ...turn, phase: event.phase, mode: event.mode ?? turn.mode };
    case 'model.delta':
      return { ...turn, streamed: `${turn.streamed}${event.delta}`.slice(-STREAM_TAIL_CHARS) };
    case 'model.reasoning':
      return { ...turn, reasoning: `${turn.reasoning}${event.delta}` };
    case 'context':
      return { ...turn, context: { layers: event.layers, dropped: event.dropped } };
    case 'steer':
      return { ...turn, steering: [...turn.steering, event.note] };
    case 'budget':
      return { ...turn, run: { spend: event.spend, limits: event.limits } };
    case 'card': {
      const index = turn.cards.findIndex((card) => card.id === event.card.id);
      const cards = index === -1 ? [...turn.cards, event.card] : turn.cards.map((card, at) => (at === index ? event.card : card));
      return { ...turn, cards };
    }
    case 'plan':
      return { ...turn, plan: event.card, planSeq: turn.planSeq + 1, planAuto: event.auto === true, streamed: '' };
    case 'ghost':
      return {
        ...turn,
        ghost: {
          callId: event.callId,
          docTitle: event.docTitle,
          text: event.text,
          words: event.words,
          cut: event.cut === true,
        },
      };
    case 'findings':
      return { ...turn, findings: event.findings };
    case 'ladder':
      return { ...turn, ladder: [...turn.ladder, { callId: event.callId, attempt: event.attempt, askBack: event.askBack }] };
    case 'checkpoint':
      return {
        ...turn,
        checkpoint: { undoGroupId: event.undoGroupId, label: event.label, mode: event.mode, ...(event.note === undefined ? {} : { note: event.note }) },
      };
    case 'report':
      return { ...turn, report: event.report, mode: event.report.mode, ghost: null, plan: turn.plan, streamed: '' };
    default:
      return turn;
  }
}

/** The line that names a phase, for the panel's status. The turn is in one of these at any moment. */
export function phaseLabel(phase: TurnPhase | 'idle'): string {
  switch (phase) {
    case 'started':
      return 'Reading the project';
    case 'planning':
      return 'Planning';
    case 'awaiting-approval':
      return 'Waiting for your decision';
    case 'running':
      return 'Applying';
    case 'retrying':
      return 'Trying again';
    case 'done':
      return 'Done';
    case 'failed':
      return 'Stopped';
    case 'cancelled':
      return 'Cancelled';
    default:
      return 'Idle';
  }
}

/** A turn that has settled: its report is in, and nothing more will arrive for it. */
export function isSettled(turn: TurnView): boolean {
  return turn.report !== null;
}

/** What each permission mode does, in the words the mode control carries as its hint (agent-harness §4). */
export const MODE_HINTS: Readonly<Record<PermissionMode, string>> = Object.freeze({
  'plan-only': 'Reads run. Every write is refused and kept as a plan you can run later.',
  ask: 'Every plan and confirm card waits for your decision.',
  'accept-edits': 'Cards that edit text and fields are approved as shown. Everything else asks.',
  auto: 'Every card of the agent’s own tools is approved as shown, inside the turn’s budgets.',
});

/** The checkpoint row's label, which says what one click does (agent-harness §5). */
export const CHECKPOINT_LABEL_TEXT = CHECKPOINT_LABEL;

/** The options an ask-back offers, as the words the card shows. An empty list is shown as the reason alone. */
export function askBackOptions(askBack: AskBack): readonly string[] {
  return askBack.options.filter((option) => option.trim() !== '');
}

/** Active time as m:ss, the way the spend line and the limit read. */
export function formatClock(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * The live spend line (agent-harness §7.1): what the run has used of each limit the writer set, and the time worked. A figure with no
 * limit is shown on its own. `undefined` before the first model call, and for a turn that reported no spend.
 */
export function spendLine(run: TurnView['run']): string | undefined {
  if (run === null) return undefined;
  const { spend, limits } = run;
  const of = (used: string, limit: string | undefined): string => (limit === undefined ? used : `${used} of ${limit}`);
  const tokens = spend.promptTokens + spend.completionTokens;
  const parts = [`${of(tokens.toLocaleString('en-US'), limits.maxTokens?.toLocaleString('en-US'))} tokens`];
  if (spend.costUsd !== undefined || limits.maxCostUsd !== undefined) {
    parts.push(of(`$${(spend.costUsd ?? 0).toFixed(4)}`, limits.maxCostUsd === undefined ? undefined : `$${limits.maxCostUsd.toFixed(4)}`));
  }
  if (limits.maxSteps !== undefined) parts.push(`${spend.steps} of ${limits.maxSteps} steps`);
  parts.push(`${of(formatClock(spend.activeMs), limits.maxActiveMs === undefined ? undefined : formatClock(limits.maxActiveMs))} worked`);
  return parts.join(' · ');
}

/** A card's one-line name: the tool, and the step it is in a plan. */
export function cardTitle(card: StatusCard): string {
  return card.tool;
}

/**
 * The elapsed time of a call, in the words the panel's timer shows: tenths of a second under a minute, then minutes and
 * seconds. A call that has not started has no elapsed time to show (agent-harness §8).
 */
export function formatElapsed(milliseconds: number): string {
  const safe = Math.max(0, milliseconds);
  if (safe < 60_000) return `${(safe / 1000).toFixed(1)} s`;
  const seconds = Math.floor(safe / 1000);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/**
 * The time a status card has run for: its start to its finish, or to `now` while it still runs. Undefined for a card that has
 * not started, which includes one still waiting for its approval.
 */
export function elapsedOf(card: StatusCard, now: number): number | undefined {
  if (card.startedAt === undefined) return undefined;
  return (card.finishedAt ?? now) - card.startedAt;
}

/**
 * A delegated agent's call as the panel words it (agent-harness §8): no new card kind, the `agent.delegate` call's own card with the
 * agent's name, the calls reserved for it, how it stands in words (never colour alone), its brief and notes to open, and its own trace
 * rows. `undefined` for any other call.
 */
export interface DelegationCardView {
  readonly title: string;
  readonly reserved: string;
  /** How the agent stands, in words: the status pill says the call's state, and this says what the agent did. */
  readonly standing: string;
  readonly brief: string;
  readonly scope: readonly string[];
  readonly result: string | undefined;
  readonly proposed: string | undefined;
  readonly trace: readonly { readonly key: string; readonly text: string }[];
}

const TRACE_OUTCOME: Readonly<Record<'ok' | 'refused' | 'not-run', string>> = { ok: 'done', refused: 'refused', 'not-run': 'proposed, not run' };

export function delegationViewOf(card: StatusCard): DelegationCardView | undefined {
  const { delegation } = card;
  if (delegation === undefined) return undefined;
  const calls = delegation.reserved;
  const standing =
    delegation.outcome === 'running'
      ? 'Working'
      : delegation.outcome === 'done'
        ? 'Finished'
        : delegation.outcome === 'partial'
          ? 'Stopped before it finished'
          : 'Failed';
  const proposed = delegation.proposed ?? 0;
  const scope = card.args['scope'];
  return {
    title: `${delegation.agent.charAt(0).toUpperCase()}${delegation.agent.slice(1)} agent`,
    reserved: `${calls} model ${calls === 1 ? 'call' : 'calls'} reserved`,
    standing,
    brief: typeof card.args['brief'] === 'string' ? card.args['brief'] : '',
    scope: Array.isArray(scope) ? scope.filter((entry): entry is string => typeof entry === 'string') : [],
    result: delegation.result,
    proposed:
      proposed === 0 ? undefined : `${proposed} ${proposed === 1 ? 'step' : 'steps'} proposed. None has run: a step only runs if it is in a plan you approve.`,
    trace: delegation.trace.map((row, index) => ({
      key: `${row.callId}:${index}`,
      text: `${phraseFor(row.tool, row.params).content} — ${TRACE_OUTCOME[row.outcome]}`,
    })),
  };
}

/** The words a plan step carries when a delegated agent proposed it, or `undefined` for a step the agent did not propose (or the writer edited). */
export function proposedByWords(step: PlanStepView): string | undefined {
  return step.proposedBy === undefined ? undefined : `Proposed by the ${step.proposedBy} agent`;
}

/** Whether a status card is still moving: waiting for a decision, or running. Grouping opens while any card is. */
export function isOpenCard(card: StatusCard): boolean {
  return card.status === 'pending-approval' || card.status === 'running';
}

/**
 * The document a scene reference names, resolved the way the harness resolves a node reference (`resolveNode`, agent-harness
 * §3): an exact id first; otherwise the one document whose title equals the reference, ignoring case and surrounding space,
 * or, when no title is equal, the one whose title starts with it. A reference that names a node of another kind is not a
 * document, and several candidates name none, so both give `null`. The harness's own resolver is not exported from its
 * package, so the rule is held here and tested against it (e2e/unit/agent-model.spec.ts).
 */
export function documentIdFor(tree: readonly TreeNode[], ref: string): string | null {
  const wanted = ref.trim().toLowerCase();
  if (wanted === '') return null;
  const documents = tree.filter((node) => node.type === 'document');
  const byId = documents.find((node) => node.id === ref);
  if (byId !== undefined) return byId.id;
  if (tree.some((node) => node.id === ref)) return null;
  const exact = documents.filter((node) => node.title.trim().toLowerCase() === wanted);
  const matches = exact.length > 0 ? exact : documents.filter((node) => node.title.trim().toLowerCase().startsWith(wanted));
  return matches.length === 1 ? (matches[0]?.id ?? null) : null;
}

/** A scene a reference names: its id, its title as the binder shows it, and its kind (`screenplay` for a Fountain scene). */
export interface SceneRef {
  readonly docId: string;
  readonly title: string;
  readonly kind?: string;
}

/**
 * One scene step of a pending card, and what the writer can see of its draft (agent-harness §8). `onScreen` is the draft's
 * scene on the screen now; `previewed` is the draft having been on screen in its scene while this card was shown.
 */
export interface DraftedStep {
  readonly index: number;
  /** The reference the step names. */
  readonly ref: string;
  /** The scene the reference names, or `null` when it names none. */
  readonly docId: string | null;
  /** The scene's title, or the reference itself when it names none. */
  readonly title: string;
  /** The draft the loop staged for this step, or `null` when there is none. */
  readonly draft: GhostView | null;
  readonly onScreen: boolean;
  readonly previewed: boolean;
}

/**
 * What must hold before a pending card that drafts a scene can be approved. `blocked` names the first thing that does not,
 * in words for the writer, and is `null` when every drafted scene has been on screen.
 */
export interface DraftCheck {
  readonly steps: readonly DraftedStep[];
  readonly blocked: string | null;
}

/**
 * The draft check of a pending card. Approval waits for each drafted scene to have been on screen with its draft: the ghost
 * region belongs to one open document at a time, so a plan that drafts several scenes is approved once each has been shown.
 * A step the preflight refused is not checked here; the card already holds it back.
 */
export function draftCheckOf(args: {
  readonly card: PlanCardView;
  readonly ghosts: readonly GhostView[];
  readonly sceneOf: (ref: string) => SceneRef | null;
  readonly onScreen: (docId: string) => boolean;
  readonly previewed: (draft: GhostView) => boolean;
}): DraftCheck {
  const steps: DraftedStep[] = args.card.steps
    .filter((step) => step.status !== 'done' && step.tool === 'scene.draft')
    .map((step): DraftedStep => {
      const ref = typeof step.params['doc'] === 'string' ? step.params['doc'] : '';
      const scene = args.sceneOf(ref);
      const draft = args.ghosts.find((ghost) => ghost.docTitle === ref) ?? null;
      const docId = scene?.docId ?? null;
      // A screenplay scene has no prose editor, so no ghost region can show its draft. The card shows the draft in full instead
      // (PlanCard, "shown here"), and that is where it has been read, so it counts as previewed there.
      const shownInCard = scene?.kind === 'screenplay';
      return {
        index: step.index,
        ref,
        docId,
        title: scene?.title ?? ref,
        draft,
        onScreen: docId !== null && args.onScreen(docId),
        previewed: draft !== null && (shownInCard || args.previewed(draft)),
      };
    });
  return { steps, blocked: blockedBy(steps, args.card) };
}

function blockedBy(steps: readonly DraftedStep[], card: PlanCardView): string | null {
  const scenes = new Map<string, DraftedStep>();
  for (const step of steps) {
    const status = card.steps[step.index]?.status;
    if (status !== 'ready' && status !== 'deferred') continue;
    const number = step.index + 1;
    if (step.draft === null) return `Step ${number} has no draft to show yet. Retry the draft, or cancel the card.`;
    if (step.docId === null) {
      return `Step ${number} names “${step.ref}”, which is not a scene in this project. Edit the step to name a scene, or cancel the card.`;
    }
    const earlier = scenes.get(step.docId);
    if (earlier !== undefined) return `Steps ${earlier.index + 1} and ${number} both draft “${step.title}”. Drop one of them.`;
    scenes.set(step.docId, step);
    if (!step.previewed) return `Open “${step.title}” to read the draft for step ${number} before you approve it.`;
  }
  return null;
}
