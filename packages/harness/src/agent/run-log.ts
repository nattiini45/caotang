/**
 * The run log — agent-harness.md §5.1, "Durable runs and resume".
 *
 * A run is one agent turn. Its log is a list of events appended ahead of the work they describe, so a reload, a crashed renderer or a
 * laptop that slept leaves a record of how far the turn got. The log is advisory, never authority: a resumed turn goes back through
 * the same preflight, gate and bus as any turn, and `planResume` only decides whether resuming is safe to offer and what it would
 * do. Everything it reads from storage is untrusted, so every event is validated here and a row this build does not know is refused.
 *
 * This file holds the pieces that need no model: the event shapes, the port the store implements, an in-memory port, the writer
 * that serialises appends, and the pure `planResume`. `loop.ts` writes the events and rebuilds a turn from them.
 *
 * ## What an event may hold
 *
 * The chat messages the harness built (the writer's own text, the model's replies verbatim with their tool calls and reasoning
 * blocks), the plan a card shows with its drafts and the revisions they were drafted against, and the revisions a step started from
 * and left behind. Never a key, a header or a request body: the profile is an id.
 */

import type { ChatMessage } from '@caotang/gateway';
import type { RunPatch, RunRow, RunStatus } from '@caotang/store';

import { isCommandName } from '../commands/slash.js';
import type { PlanStep } from '../plan.js';
import { canonicalJson } from '../util.js';
import type { BudgetSpend } from './budget.js';
import type { StepRevisions } from './background.js';
import type { TurnStatus } from './events.js';

/** The version of the event shapes below. A `turn.start` of another version is refused, not guessed at. */
export const RUN_LOG_VERSION = 1;

/** One run's record, as the store keeps it. */
export type RunRecord = RunRow;

type Stamp = { readonly seq: number; readonly at: number };

/** A document revision by document id. */
export type Revisions = Readonly<Record<string, number>>;

export type RunEvent =
  | (Stamp & {
      readonly t: 'turn.start';
      readonly v: typeof RUN_LOG_VERSION;
      readonly turnId: string;
      readonly intent: string;
      /** `planner` converses with the model; `plan` is a plan the app built or a background task staged, which has no conversation to re-issue. */
      readonly wire: 'planner' | 'plan';
      /** Whether the planner spoke native tool calls, so a resume on a provider that does not is refused rather than sent a malformed history. */
      readonly native: boolean;
      /** The turn this one continues, when it is a resume. */
      readonly resumedFrom?: string;
      /** The nodes a read-deny kept from every tool when the turn began: what the conversation it holds was filtered by (absent: not recorded, read as none). */
      readonly withheld?: readonly string[];
      /** The slash command that started the turn, by name (`TurnReport.command`). Absent for any other turn. */
      readonly command?: string;
    })
  | (Stamp & { readonly t: 'messages'; readonly turnId: string; readonly appended: readonly ChatMessage[] })
  | (Stamp & {
      readonly t: 'card.pending';
      readonly turnId: string;
      readonly kind: 'plan' | 'confirm';
      readonly steps: readonly PlanStep[];
      /** One entry per step, `null` for a step with no draft. */
      readonly proposals: readonly unknown[];
      /** The documents each step's draft read, with their revisions when it was staged: `null` for a step that read none. */
      readonly revisions: readonly (StepRevisions | null)[];
      /** The positions of the steps that have already run, so a resumed card shows them done. */
      readonly done: readonly number[];
    })
  | (Stamp & { readonly t: 'card.decided'; readonly turnId: string; readonly decision: 'approved' | 'auto' | 'cancelled' | 'refused' })
  | (Stamp & {
      readonly t: 'step.intent';
      readonly turnId: string;
      readonly callId: string;
      readonly index: number;
      readonly tool: string;
      /** The revision of every document when the step was about to run. */
      readonly expect: Revisions;
      /** A digest of the project's structure (its manifest) then: a step that moves a node or sets a label changes no document's revision. */
      readonly structure: string;
    })
  | (Stamp & {
      readonly t: 'step.applied';
      readonly turnId: string;
      readonly callId: string;
      readonly index: number;
      readonly tool: string;
      readonly summary?: string;
      /** The revision of each document the step changed, after it. The autosave had flushed when this was written. */
      readonly after: Revisions;
    })
  | (Stamp & { readonly t: 'step.failed'; readonly turnId: string; readonly callId: string; readonly index: number; readonly tool: string; readonly error: string })
  | (Stamp & {
      readonly t: 'spend';
      readonly turnId: string;
      readonly spend: BudgetSpend;
      /** Model calls started and not settled when this was written: a crash loses them, and a resume counts them as spent. */
      readonly reservedCalls: number;
    })
  | (Stamp & { readonly t: 'turn.end'; readonly turnId: string; readonly status: TurnStatus; readonly summary: string });

/** An event as the writer is handed it: the writer numbers and stamps it. */
export type RunEventDraft = RunEvent extends infer E ? (E extends unknown ? Omit<E, 'seq' | 'at'> : never) : never;

/** What the store (or a test double) offers the writer. Rows come back untyped: `planResume` validates them. */
export interface RunLogPort {
  create(run: RunRecord): Promise<void>;
  /** Appends the events and applies `patch` to the record in one transaction. */
  append(runId: string, events: readonly RunEvent[], patch?: RunPatch): Promise<void>;
  update(runId: string, patch: RunPatch): Promise<void>;
  /** The project's runs that have not settled, oldest first. */
  open(projectId: string): Promise<readonly RunRecord[]>;
  events(runId: string): Promise<readonly unknown[]>;
  /** Deletes the run and its events. The writes it made stay in the project. */
  discard(runId: string): Promise<void>;
  prune(projectId: string, keep: { readonly days: number; readonly count: number }): Promise<number>;
}

/** What `createAgentSession` is given to log its turns (`AgentSessionOptions.runLog`). */
export interface RunLogOptions {
  readonly port: RunLogPort;
  readonly projectId: string;
  /**
   * Resolves when everything the project holds in memory has reached the store. Awaited after each step and before its `step.applied`
   * is written, so an `applied` event means the write is on disk. A rejection means it could not be saved, and the run stops being
   * resumable. Absent, `applied` is written when the step has run.
   */
  readonly flush?: () => Promise<void>;
  /** Told once when a write to the log fails: the run goes on, and it can no longer be resumed. */
  readonly onNotice?: (message: string) => void;
  /** Mints a run id. Default `run_` followed by a random Crockford id. */
  readonly newRunId?: () => string;
}

export const NOT_LOGGED_NOTICE =
  'The agent could not write its run log, so if this tab closes before the turn ends the run cannot be resumed. The turn itself carries on.';

// ---------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------

/** Appends a run's events one after another. A failed write stops the log and says so once; nothing else about the run changes. */
export interface RunWriter {
  readonly runId: string;
  /** Whether a write failed, so the log no longer describes the run. */
  readonly broken: boolean;
  /** Numbers, stamps and stores one event, with the status change that goes with it. Never rejects. */
  append(event: RunEventDraft, patch?: RunPatch): Promise<void>;
  /** Marks the log as no longer describing the run, for a failure that is not an append (the flush, the first write). The notice carries the cause when there is one. */
  fail(cause?: unknown): void;
}

export interface RunWriterOptions {
  readonly port: RunLogPort;
  readonly runId: string;
  /** The first sequence number: 0 for a new run, the next free one for a run that is resumed. */
  readonly nextSeq: number;
  readonly clock?: () => number;
  readonly onNotice?: (message: string) => void;
}

export function createRunWriter(options: RunWriterOptions): RunWriter {
  const clock = options.clock ?? Date.now;
  let seq = options.nextSeq;
  let broken = false;
  let queue: Promise<void> = Promise.resolve();

  const fail = (cause?: unknown): void => {
    if (broken) return;
    broken = true;
    const reason = cause === undefined ? '' : cause instanceof Error ? cause.message : String(cause);
    options.onNotice?.(reason === '' ? NOT_LOGGED_NOTICE : `${NOT_LOGGED_NOTICE} (${reason})`);
    // Best effort: a store that refused the append may take this, and the record then says why the run is not offered.
    queue = queue.then(() => options.port.update(options.runId, { cannotResume: true, updatedAt: clock() }).catch(() => undefined));
  };

  return {
    runId: options.runId,
    get broken() {
      return broken;
    },
    append(event, patch) {
      const run = queue.then(async () => {
        if (broken) return;
        const stamped = { ...event, seq, at: clock() } as RunEvent;
        seq += 1;
        try {
          await options.port.append(options.runId, [stamped], { ...patch, updatedAt: stamped.at });
        } catch (error) {
          fail(error);
        }
      });
      queue = run;
      return run;
    },
    fail,
  };
}

/** The record of a run that is starting. */
export function newRunRecord(runId: string, input: { readonly projectId: string; readonly intent: string; readonly now: number; readonly profileId?: string; readonly model?: string }): RunRecord {
  return {
    schema: RUN_LOG_VERSION,
    runId,
    projectId: input.projectId,
    kind: 'turn',
    intent: input.intent,
    createdAt: input.now,
    updatedAt: input.now,
    status: 'running',
    ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
    ...(input.model === undefined ? {} : { model: input.model }),
  };
}

// ---------------------------------------------------------------------------
// An in-memory port
// ---------------------------------------------------------------------------

/** A port over maps, for a test or an eval: the same contract the store keeps, with the same all-or-nothing append. */
export interface MemoryRunLog extends RunLogPort {
  /** Every stored event of every run, as JSON text, for a test that greps the log for a secret. */
  dump(): string;
  /** The next `append` rejects, as a full or failing store does. */
  failNextAppend(): void;
}

export function createMemoryRunLog(): MemoryRunLog {
  const runs = new Map<string, RunRecord>();
  const events = new Map<string, RunEvent[]>();
  let failing = false;
  return {
    async create(run) {
      if (runs.has(run.runId)) throw new Error(`run ${run.runId} exists`);
      runs.set(run.runId, structuredClone(run));
      events.set(run.runId, []);
    },
    async append(runId, batch, patch = {}) {
      if (failing) {
        failing = false;
        throw new Error('the store refused the append');
      }
      const run = runs.get(runId);
      const held = events.get(runId);
      if (run === undefined || held === undefined) throw new Error(`no run ${runId}`);
      const taken = new Set(held.map((event) => event.seq));
      if (batch.some((event) => taken.has(event.seq))) throw new Error('a sequence number is taken');
      held.push(...structuredClone([...batch]));
      runs.set(runId, { ...run, ...patch });
    },
    async update(runId, patch) {
      const run = runs.get(runId);
      if (run === undefined) throw new Error(`no run ${runId}`);
      runs.set(runId, { ...run, ...patch });
    },
    async open(projectId) {
      return [...runs.values()].filter((run) => run.projectId === projectId && (run.status === 'running' || run.status === 'awaiting-approval' || run.status === 'interrupted'));
    },
    async events(runId) {
      return structuredClone([...(events.get(runId) ?? [])].sort((a, b) => a.seq - b.seq));
    },
    async discard(runId) {
      runs.delete(runId);
      events.delete(runId);
    },
    async prune() {
      return 0;
    },
    dump: () => JSON.stringify([...events.values()]),
    failNextAppend() {
      failing = true;
    },
  };
}

// ---------------------------------------------------------------------------
// Reading a log back
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

function revisionsOk(value: unknown): value is Revisions {
  return isRecord(value) && Object.values(value).every((revision) => isCount(revision));
}

function stepsOk(value: unknown): value is readonly PlanStep[] {
  return Array.isArray(value) && value.every((step) => isRecord(step) && isString(step['tool']) && isRecord(step['params']) && isString(step['expect']));
}

function messagesOk(value: unknown): value is readonly ChatMessage[] {
  return (
    Array.isArray(value) &&
    value.every((message) => isRecord(message) && ['system', 'user', 'assistant', 'tool'].includes(message['role'] as string) && isString(message['content']))
  );
}

/** A spend figure: finite and not below zero. It may be fractional: milliseconds and dollars are, and token counts are the provider's, so they are not held to whole numbers. */
const isAmount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function spendOk(value: unknown): value is BudgetSpend {
  if (!isRecord(value)) return false;
  // The meter counts calls and steps one at a time, so those two are whole numbers.
  return isCount(value['modelCalls']) && isCount(value['steps']) && ['promptTokens', 'completionTokens', 'estimatedTokens', 'activeMs'].every((key) => isAmount(value[key])) && (value['costUsd'] === undefined || isAmount(value['costUsd']));
}

const SHAPES: Readonly<Record<RunEvent['t'], (event: Record<string, unknown>) => boolean>> = {
  'turn.start': (e) => e['v'] === RUN_LOG_VERSION && isString(e['turnId']) && isString(e['intent']) && (e['wire'] === 'planner' || e['wire'] === 'plan') && typeof e['native'] === 'boolean' && (e['withheld'] === undefined || (Array.isArray(e['withheld']) && e['withheld'].every(isString))) && (e['command'] === undefined || isCommandName(e['command'])),
  messages: (e) => isString(e['turnId']) && messagesOk(e['appended']),
  'card.pending': (e) =>
    isString(e['turnId']) &&
    (e['kind'] === 'plan' || e['kind'] === 'confirm') &&
    stepsOk(e['steps']) &&
    Array.isArray(e['proposals']) &&
    e['proposals'].length === e['steps'].length &&
    Array.isArray(e['revisions']) &&
    e['revisions'].length === e['steps'].length &&
    e['revisions'].every((revisions) => revisions === null || revisionsOk(revisions)) &&
    Array.isArray(e['done']) &&
    e['done'].every((index) => isCount(index) && index < (e['steps'] as readonly unknown[]).length),
  'card.decided': (e) => isString(e['turnId']) && ['approved', 'auto', 'cancelled', 'refused'].includes(e['decision'] as string),
  'step.intent': (e) => isString(e['turnId']) && isString(e['callId']) && isCount(e['index']) && isString(e['tool']) && revisionsOk(e['expect']) && isString(e['structure']),
  'step.applied': (e) => isString(e['turnId']) && isString(e['callId']) && isCount(e['index']) && isString(e['tool']) && revisionsOk(e['after']) && (e['summary'] === undefined || isString(e['summary'])),
  'step.failed': (e) => isString(e['turnId']) && isString(e['callId']) && isCount(e['index']) && isString(e['tool']) && isString(e['error']),
  spend: (e) => isString(e['turnId']) && spendOk(e['spend']) && isCount(e['reservedCalls']),
  'turn.end': (e) => isString(e['turnId']) && ['replied', 'applied', 'failed', 'cancelled'].includes(e['status'] as string) && isString(e['summary']),
};

/** The events of a stored log, checked, or the reason one was refused. A row of a type or a shape this build does not know refuses the whole log. */
export function parseRunEvents(rows: readonly unknown[]): { readonly ok: true; readonly events: readonly RunEvent[] } | { readonly ok: false; readonly detail: string } {
  const events: RunEvent[] = [];
  let last = -1;
  for (const row of rows) {
    if (!isRecord(row) || !isCount(row['seq']) || !isString(row['t'])) return { ok: false, detail: 'the run log has a row this version of Caotang does not understand' };
    const check = (SHAPES as Record<string, ((event: Record<string, unknown>) => boolean) | undefined>)[row['t']];
    if (check === undefined) return { ok: false, detail: `the run log has an event of a kind (${row['t']}) this version of Caotang does not know` };
    if (!check(row)) return { ok: false, detail: `the run log has a ${row['t']} event that is damaged or from another version of Caotang` };
    if (row['seq'] <= last) return { ok: false, detail: 'the run log is out of order' };
    last = row['seq'];
    events.push(row as unknown as RunEvent);
  }
  return { ok: true, events };
}

/** A step a log records as applied. */
export interface AppliedStep {
  readonly callId: string;
  readonly index: number;
  readonly tool: string;
  readonly summary?: string;
}

/** The card a run was showing, or running, when the log stopped. */
export interface ReplayCard {
  readonly kind: 'plan' | 'confirm';
  readonly steps: readonly PlanStep[];
  readonly proposals: readonly unknown[];
  readonly revisions: readonly (StepRevisions | undefined)[];
  /** Positions of the steps that have run, the card's own and those applied since it was shown. */
  readonly completed: readonly number[];
  readonly decision?: 'approved' | 'auto' | 'cancelled' | 'refused';
}

/** What a log says about its run: the state a resumed turn starts from. */
export interface RunReplay {
  readonly turnId: string;
  readonly intent: string;
  readonly wire: 'planner' | 'plan';
  readonly native: boolean;
  /** The nodes a read-deny kept from the agent when the conversation was last built on: what the messages below were filtered by. */
  readonly withheld: readonly string[];
  /** The slash command that started the run, when one did. */
  readonly command?: string;
  /** The conversation as it was last written down, every message verbatim. */
  readonly messages: readonly ChatMessage[];
  /** The card still open: shown and not answered, or answered and not yet fully run. Absent when the run was between cards. */
  readonly card?: ReplayCard;
  readonly applied: readonly AppliedStep[];
  readonly ended?: { readonly status: TurnStatus; readonly summary: string };
  /** The spend when last written, with the model calls a crash lost added: what the resumed turn starts from. */
  readonly spend?: BudgetSpend;
  readonly reservedCalls: number;
  /** The first free sequence number. */
  readonly nextSeq: number;
}

/** A step started and not recorded as applied or failed. */
export interface PendingStep {
  readonly callId: string;
  readonly index: number;
  readonly tool: string;
}

interface Replayed {
  readonly replay: RunReplay;
  readonly events: readonly RunEvent[];
  /** The step the log ends inside, if it does. */
  readonly pending?: PendingStep & { readonly expect: Revisions; readonly structure: string };
  /** Revisions each applied step left, latest per document, over the whole run. */
  readonly owned: Map<string, number>;
  /** The same, over the steps applied since the last write of the conversation: what the open card was planned against. */
  readonly ownedOpen: Map<string, number>;
}

function replayOf(events: readonly RunEvent[]): Replayed {
  let turnId = '';
  let intent = '';
  let wire: 'planner' | 'plan' = 'planner';
  let native = false;
  let withheld: readonly string[] = [];
  let command: string | undefined;
  const messages: ChatMessage[] = [];
  let card: { -readonly [K in keyof ReplayCard]: ReplayCard[K] } | undefined;
  let cardSeq = -1;
  let lastMessages = -1;
  const applied: AppliedStep[] = [];
  let ended: RunReplay['ended'];
  let spend: BudgetSpend | undefined;
  let reservedCalls = 0;
  const intents = new Map<string, PendingStep & { expect: Revisions; structure: string }>();
  const owned = new Map<string, number>();
  const ownedOpen = new Map<string, number>();
  let started = false;

  for (const event of events) {
    switch (event.t) {
      case 'turn.start':
        turnId = event.turnId;
        native = event.native;
        withheld = event.withheld ?? [];
        if (!started) {
          intent = event.intent;
          command = event.command;
          wire = event.wire;
          started = true;
        }
        break;
      case 'messages':
        messages.push(...event.appended);
        lastMessages = event.seq;
        ownedOpen.clear();
        break;
      case 'card.pending':
        cardSeq = event.seq;
        card = {
          kind: event.kind,
          steps: event.steps,
          proposals: event.proposals.map((proposal) => (proposal === null ? undefined : proposal)),
          revisions: event.revisions.map((revisions) => revisions ?? undefined),
          completed: [...event.done],
        };
        break;
      case 'card.decided':
        if (card !== undefined) card.decision = event.decision;
        break;
      case 'step.intent':
        intents.set(event.callId, { callId: event.callId, index: event.index, tool: event.tool, expect: event.expect, structure: event.structure });
        break;
      case 'step.applied':
        applied.push({ callId: event.callId, index: event.index, tool: event.tool, ...(event.summary === undefined ? {} : { summary: event.summary }) });
        intents.delete(event.callId);
        for (const [id, revision] of Object.entries(event.after)) {
          owned.set(id, revision);
          ownedOpen.set(id, revision);
        }
        if (card !== undefined && event.seq > cardSeq && !card.completed.includes(event.index)) card.completed = [...card.completed, event.index];
        break;
      case 'step.failed':
        intents.delete(event.callId);
        break;
      case 'spend':
        spend = event.spend;
        reservedCalls = event.reservedCalls;
        break;
      case 'turn.end':
        ended = { status: event.status, summary: event.summary };
        break;
    }
  }

  const open = card !== undefined && cardSeq > lastMessages && ended === undefined;
  const pending = [...intents.values()].at(-1);
  const replay: RunReplay = {
    turnId,
    intent,
    wire,
    native,
    withheld,
    ...(command === undefined ? {} : { command }),
    messages,
    ...(open && card !== undefined ? { card } : {}),
    applied,
    ...(ended === undefined ? {} : { ended }),
    ...(spend === undefined ? {} : { spend }),
    reservedCalls,
    nextSeq: (events.at(-1)?.seq ?? -1) + 1,
  };
  return { replay, events, ...(pending === undefined ? {} : { pending }), owned, ownedOpen };
}

// ---------------------------------------------------------------------------
// planResume
// ---------------------------------------------------------------------------

export type ResumeVerdict =
  /** `clean`: every write the log records is in the project, and the run continues after it. `re-run`: the log ends inside a step that provably did not apply, and that step runs again. */
  | { readonly ok: true; readonly kind: 'clean' | 're-run'; readonly replay: RunReplay; readonly rerun?: PendingStep }
  | {
      readonly ok: false;
      /**
       * `write-lost`: a write the log records is not in the project. `revision-drift`: a document the run depends on has changed since.
       * `ask-back`: the run cannot go on without the writer (an external step may have run, or there is nothing to continue).
       * `schema`: the log is damaged or from another version.
       */
      readonly reason: 'write-lost' | 'revision-drift' | 'ask-back' | 'schema';
      readonly detail: string;
      /** The documents the verdict names, by id. */
      readonly docs: readonly string[];
      readonly replay?: RunReplay;
    };

/** What a resume check may ask of the project besides document revisions. */
export interface ResumeView {
  /** A document's title for a sentence; its id when absent. */
  readonly nameOf?: (docId: string) => string;
  /** The digest of the project's structure as loaded (`structureDigest`). Absent, a step that began and never finished is judged by revisions alone. */
  readonly structure?: () => string;
}

/**
 * A digest of a project's manifest apart from what a save moves without the structure changing: `project.modifiedAt`, each node's
 * `updatedAt` (a text write stamps it) and `derived` (the word-count cache, rebuilt on a text write or on open). Equal digests mean no node,
 * label, setting or codex entry changed; a title, a parent, an order, a status, a synopsis or the vocabulary moves it.
 */
export function structureDigest(manifest: unknown): string {
  const { project, derived: _derived, tree, ...rest } = manifest as { project?: Record<string, unknown>; derived?: unknown; tree?: unknown } & Record<string, unknown>;
  const nodes = Array.isArray(tree) ? tree.map((node: unknown) => (typeof node === 'object' && node !== null ? { ...(node as Record<string, unknown>), updatedAt: '' } : node)) : tree;
  return digestOf(canonicalJson({ ...rest, tree: nodes, project: { ...project, modifiedAt: '' } }));
}

/** A 53-bit string hash (cyrb53), enough to tell two manifests apart; it guards nothing against an adversary. */
function digestOf(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

const listOf = (docs: readonly string[], nameOf: (id: string) => string): string => docs.map((id) => `“${nameOf(id)}”`).join(', ');

/**
 * Decides whether a run may be resumed, from its log and the project as loaded. Pure: it reads `revisions` and nothing else.
 *
 * - A write the log records as applied that the project does not hold (its document is missing, or older than the revision the step
 *   left) is `write-lost`: the save did not land before the tab went.
 * - A document that has moved past what the run's open step or card was planned against is `revision-drift`: the writer's text
 *   outranks the agent's, so the run stops and names it.
 * - A log that ends inside a step is `re-run` only when no document moved since the step began; if one did, the step may have
 *   landed, so it is `revision-drift` and never applied twice. An external (`mcp__`) step in that state is `ask-back`: the server
 *   may already have acted.
 */
export function planResume(rows: readonly unknown[], revisions: (docId: string) => number | undefined, view: ResumeView = {}): ResumeVerdict {
  const nameOf = view.nameOf ?? ((id: string): string => id);
  const parsed = parseRunEvents(rows);
  if (!parsed.ok) return { ok: false, reason: 'schema', detail: parsed.detail, docs: [] };
  if (parsed.events.length === 0) return { ok: false, reason: 'schema', detail: 'the run log is empty', docs: [] };
  const first = parsed.events[0] as RunEvent;
  if (first.t !== 'turn.start') return { ok: false, reason: 'schema', detail: 'the run log does not begin with the start of a turn', docs: [] };

  const { replay, pending, owned, ownedOpen } = replayOf(parsed.events);
  if (replay.ended !== undefined) return { ok: true, kind: 'clean', replay };

  const lost = [...owned].filter(([id, revision]) => (revisions(id) ?? -1) < revision).map(([id]) => id);
  if (lost.length > 0) {
    return {
      ok: false,
      reason: 'write-lost',
      detail: `${listOf(lost, nameOf)} ${lost.length === 1 ? 'does' : 'do'} not hold a change the agent applied before the tab closed, so the save did not land`,
      docs: lost,
      replay,
    };
  }
  const moved = [...ownedOpen].filter(([id, revision]) => (revisions(id) ?? -1) > revision).map(([id]) => id);
  if (moved.length > 0) {
    return { ok: false, reason: 'revision-drift', detail: `${listOf(moved, nameOf)} changed after the agent last wrote ${moved.length === 1 ? 'it' : 'them'}`, docs: moved, replay };
  }

  if (pending !== undefined) {
    if (pending.tool.startsWith('mcp__')) {
      return {
        ok: false,
        reason: 'ask-back',
        detail: `the run stopped while ${pending.tool} was being called, and that server may already have acted, so it is not called again`,
        docs: [],
        replay,
      };
    }
    const behind = Object.entries(pending.expect).filter(([id, revision]) => (revisions(id) ?? -1) < revision).map(([id]) => id);
    if (behind.length > 0) {
      return { ok: false, reason: 'write-lost', detail: `${listOf(behind, nameOf)} ${behind.length === 1 ? 'is' : 'are'} older than the run left ${behind.length === 1 ? 'it' : 'them'}`, docs: behind, replay };
    }
    const ahead = Object.entries(pending.expect).filter(([id, revision]) => (revisions(id) ?? -1) > revision).map(([id]) => id);
    if (ahead.length > 0) {
      return {
        ok: false,
        reason: 'revision-drift',
        detail: `${listOf(ahead, nameOf)} changed since step ${pending.index + 1} (${pending.tool}) began, and the step may already have applied, so it is not run again`,
        docs: ahead,
        replay,
      };
    }
    if (view.structure !== undefined && view.structure() !== pending.structure) {
      return {
        ok: false,
        reason: 'revision-drift',
        detail: `the project’s structure changed since step ${pending.index + 1} (${pending.tool}) began, and the step may already have applied, so it is not run again`,
        docs: [],
        replay,
      };
    }
    return { ok: true, kind: 're-run', replay, rerun: { callId: pending.callId, index: pending.index, tool: pending.tool } };
  }

  if (replay.card === undefined && replay.wire === 'plan') {
    return { ok: false, reason: 'ask-back', detail: 'the run stopped before its plan reached a card, and there is no conversation to continue', docs: [], replay };
  }
  return { ok: true, kind: 'clean', replay };
}

// ---------------------------------------------------------------------------
// What a card about an interrupted run shows
// ---------------------------------------------------------------------------

const NO_SPEND: BudgetSpend = { modelCalls: 0, promptTokens: 0, completionTokens: 0, estimatedTokens: 0, steps: 0, activeMs: 0 };

export interface RunSummary {
  readonly intent: string;
  /** Steps applied so far, and the steps of the card the run was on (the applied count when it had none). */
  readonly applied: number;
  readonly total: number;
  readonly spend?: BudgetSpend;
  /** The spend a resumed turn's meter starts from: what was spent, and the model calls the stop lost counted as spent. */
  readonly restoredSpend: BudgetSpend;
  /** Whether Resume is offered. */
  readonly resumable: boolean;
  /** Why not, or what to know first, in a sentence. */
  readonly note?: string;
}

/** The numbers and the verdict the interrupted-run card shows, from the stored log. */
export function summarizeRun(rows: readonly unknown[], revisions: (docId: string) => number | undefined, view?: ResumeView): RunSummary | undefined {
  const verdict = planResume(rows, revisions, view);
  const replay = verdict.replay;
  if (replay === undefined) return undefined;
  const base = {
    intent: replay.intent,
    applied: replay.applied.length,
    total: Math.max(replay.card?.steps.length ?? 0, replay.applied.length),
    ...(replay.spend === undefined ? {} : { spend: replay.spend }),
    restoredSpend: { ...(replay.spend ?? NO_SPEND), modelCalls: (replay.spend?.modelCalls ?? 0) + replay.reservedCalls },
  };
  if (!verdict.ok) return { ...base, resumable: false, note: `${verdict.detail}.` };
  const stale = replay.card === undefined ? 0 : replay.card.revisions.filter((read, index) => read !== undefined && !(replay.card?.completed ?? []).includes(index) && Object.entries(read).some(([id, revision]) => revisions(id) !== revision)).length;
  return { ...base, resumable: true, ...(stale === 0 ? {} : { note: `${stale === 1 ? 'A draft is' : `${stale} drafts are`} out of date, and the card will say so.` }) };
}

/** The status a run record takes when its turn ends. A turn the writer cancelled or stopped is finished; one that stopped on a question is failed. */
export function statusOfTurn(status: TurnStatus): RunStatus {
  return status === 'failed' ? 'failed' : 'finished';
}
