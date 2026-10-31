/**
 * The shapes a tool is built from, and the shapes a caller gets back.
 *
 * A **native** tool is written as *prepare, then finish*:
 *
 * - `prepare(params, context)` is pure. It resolves references, validates every
 *   command the call would dispatch against the bus's own `validate`, and returns
 *   the ordered list of commands. Nothing is written. A batch refused here leaves
 *   zero partial effects, which is the property the spec asks of a batch
 *   (agent-harness §3: "validated as a whole first").
 * - the runtime dispatches those commands through `execute()` in order, then
 *   `finish(done)` builds the value the caller sees from what the bus reported.
 *
 * A **port** tool has no commands of its own. Its implementation is injected, and
 * until one is supplied the call is refused with the not-wired error. The four
 * port tools need their host features (codex, the provider loop), and their
 * metadata and schemas are real even though their behaviour is not.
 */

import type {
  ActivityAffected,
  ActivityEntry,
  AgentRisk,
  CommandError,
  CommandName,
  CommandProvenance,
  CommandRegistry,
  ExecutionOutcome,
  PermissionContext,
  Result,
  ToolValue,
} from '@caotang/bus';
import type { ProjectState } from '@caotang/store';

import type { ToolMetadata } from './metadata.js';
import type { JsonSchema, ObjectSpec } from './schema.js';

/** Where a call came from. `ActivityEntry.source` is reserved for this (command-bus §8). */
export type ActivitySource = ActivityEntry['source'];

/** One node a row names, with its human title (command-bus §8). The bus names it too, so it is named here and not read off the row type. */
export type { ActivityAffected };

/** A tool call's params, as the caller sent them, after the closed-set check. */
export type CallParams = Readonly<Record<string, unknown>>;

/** What a successful tool call returns to the caller. Declared in the bus (tool-value.ts), where a media module's tools can name it. */
export type { ToolValue } from '@caotang/bus';

/** One command the runtime has dispatched, and what the bus answered. */
export interface CommandDone {
  readonly name: CommandName;
  readonly outcome: ExecutionOutcome;
}

/**
 * A command a call will dispatch. Its params are either fixed by `prepare`, or a
 * function of the commands already done — which is how `doc.import` writes a body
 * into a document whose id only exists once `binder.create` has run.
 */
export interface PreparedCommand {
  readonly name: CommandName;
  readonly params: CallParams | ((done: readonly CommandDone[]) => CallParams);
  /**
   * The provenance the tool gives the command (codex.md §2): `'import'` for codex.import's
   * `codex.upsert`. It is set by the tool's own code and carried on the bus envelope, never read from
   * the caller's params, so a model cannot name the origin it is stamped with.
   */
  readonly provenance?: CommandProvenance;
  /**
   * The grant the tool gives the command, for a `never`-class primitive the tool composes (command-bus §4): `pictures.place`
   * runs `editor.insert` under it. Like `provenance` it is the tool's own code and never a caller's param, and the tool's own gate
   * (a plan's approval or a confirm card) has already answered before the command is dispatched.
   */
  readonly inherit?: AgentRisk;
}

export interface PreparedCall {
  readonly commands: readonly PreparedCommand[];
  readonly finish: (done: readonly CommandDone[]) => Result<ToolValue, CommandError>;
  /** What the plan card shows before anything runs (old→new diffs, tree lines). */
  readonly preview?: unknown;
}

/**
 * Today's writing progress against the session target (goals-progress.md §2.1).
 *
 * The target is app settings and the progress reads `sessions.jsonl`, and neither
 * lives in the project state. So the app supplies this through a seam, and the
 * overview reports `session: null` when it does not.
 */
export interface SessionSnapshot {
  readonly todayWords: number;
  readonly target?: number;
}

export interface PrepareContext {
  readonly state: ProjectState;
  readonly registry: CommandRegistry;
  readonly session?: () => SessionSnapshot | undefined;
  /**
   * The clock, for a stamp a tool writes into what it prepares (codex.import's citation time). The
   * runtime always supplies it; a bare call may leave it out, and a tool that needs one then reads
   * the system clock, which only a test that does not check the stamp should rely on.
   */
  readonly clock?: () => number;
  /**
   * Whether the caller may change the project through a write tool. An external caller of a harness that has not opened
   * external writes may not, so a note or a description the tool writes must not name one (project.overview). Absent, the
   * caller is the agent in the app, which may.
   */
  readonly writes?: boolean;
  /**
   * What the agent loop staged for this call before its card was shown (the same value a port finds in `PortContext.proposal`). A tool
   * whose guards are read when it is proposed, and must be held to at the approval, finds them here instead of reading the project again.
   * Never a caller's param: an external caller's proposal is dropped before it reaches a tool.
   */
  readonly proposal?: unknown;
}

export type PrepareFn =(params: CallParams, context: PrepareContext) => Result<PreparedCall, CommandError>;

export interface PortContext {
  readonly state: ProjectState;
  /** The turn this call belongs to. A port that keeps something for one turn (the skills a turn has loaded) keys it by this. */
  readonly turnId: string;
  /** Dispatches one command through the bus, under the same turn and permission as the call. */
  readonly dispatch: (name: CommandName, params: CallParams) => Result<ExecutionOutcome, CommandError>;
  /**
   * Dispatches one `never`-class primitive under the port's own grant (command-bus §4, grant
   * inheritance). The gate reads `inheritedGrant`, so only a port can reach this path: a primitive
   * the model emitted directly never carries the grant.
   */
  readonly dispatchInherited: (name: CommandName, params: CallParams) => Result<ExecutionOutcome, CommandError>;
  /**
   * Dispatches one command whose apply awaits the host (`asyncApply`: `asset.import` writes a file), under the same turn and permission
   * as the call. An async port is the one caller that may wait for it; a synchronous port has nothing to await.
   */
  readonly dispatchAsync: (name: CommandName, params: CallParams) => Promise<Result<ExecutionOutcome, CommandError>>;
  /**
   * What the agent loop staged for this call before it ran: a generated draft, a set of synopses.
   * Absent for a call that staged nothing. It is data the loop built, never something the model
   * wrote into the tool's params (agent-harness §2: the card shows exactly what will be applied).
   */
  readonly proposal?: unknown;
  /**
   * The approvals the turn carries (command-bus §4): `approvedPlan` when the writer approved the plan this
   * call is a step of, `confirmed` when the writer confirmed this call in a one-step card. Absent for an
   * external caller, which holds none, so an approval claimed on the wire never reaches a port. A port that
   * refuses a scope until the writer agrees reads it here (coherence.md §7 tool 15).
   */
  readonly permission?: PermissionContext;
  /** The turn's stop (`TurnContext.signal`). An async port that awaits a model or a server ends its wait when it fires. */
  readonly signal?: AbortSignal;
  /**
   * Records that the port changed held state outside the bus (an appender side-effect, coherence.md §7). A
   * port that did so reports it, and the runtime then caches its answer by callId, so a replay of the same
   * call is answered from the cache and does not run the port again (command-bus §6).
   */
  readonly recordEffect: () => void;
  /**
   * Writes one activity row for this call under its turn, with no affected nodes. It is the turn report's
   * row for a read that changed nothing in the manuscript (coherence.md §9), and its source is the caller's.
   */
  readonly logRow: (summary: string) => void;
}

export type ToolPort = (params: CallParams, context: PortContext) => Result<ToolValue, CommandError>;

/**
 * A port whose work awaits something a synchronous port cannot wait for: a model call (`coherence.review`, coherence.md §5.3).
 * It takes the same context as a port and answers the same way, but it is run by `Harness.callAsync`, after the caller holds the
 * approval the tool's risk needs. The agent loop is the caller that awaits it, once its plan card is approved.
 */
export type AsyncToolPort = (params: CallParams, context: PortContext) => Promise<Result<ToolValue, CommandError>>;

/**
 * The tools whose behaviour is injected rather than built in this package: the four v0.1 port tools,
 * and the three coherence tools, which the coherence module's engine answers. A port left out of
 * the injected map is refused as not wired. `coherence.review` is an async port (`AsyncToolPort`), because its
 * model call is asynchronous and a port is not, and it is run by `callAsync` (see tools/coherence.ts).
 */
export type PortToolName =
  | 'codex.read'
  | 'scene.draft'
  | 'synopsis.fill'
  | 'continuity.scan'
  | 'coherence.scan'
  | 'coherence.review'
  | 'coherence.setFindingStatus'
  // The Tier-2 gateway (extensibility §5), and the storyboard and prompt-pack modules' tools. The
  // two model-backed kinds stay unwired until an app supplies their ports (see runtime.ts).
  | 'tool.search'
  | 'shots.derive'
  | 'shots.annotate'
  | 'prompt.draft'
  | 'prompt.variant'
  // The dialogue module's two tools (dialogue-narrative.md §7). `dialogue.table` is a read and is wired
  // by default; `dialogue.draft` takes the loop's staged Ink, and is wired by the agent ports (`createAgentPorts`).
  | 'dialogue.draft'
  | 'dialogue.table'
  // The project's skills (extensibility.md §10). Wired only where the app supplies `HarnessOptions.skills`, so the outward MCP server, which does not, never lists it.
  | 'skill.load'
  // Delegation (agent-harness §2): answered by the agent loop; the port (tools/delegate.ts) is what a caller outside a turn gets.
  | 'agent.delegate'
  // The picture tools that need the host (pictures.md §8.1): `pictures.view` reads stored bytes and asks the host whether the model
  // sees images, and `pictures.import` consumes a staging id and awaits the file write. Both are async ports, wired where the host supplies them.
  | 'pictures.view'
  | 'pictures.import'
  // Model-backed handwriting transcription (pictures.md §8.4): the loop supplies the generated proposal, the host reviews it.
  | 'pictures.transcribe';

interface EntryBase {
  readonly meta: ToolMetadata;
  readonly params: ObjectSpec;
  /** Derived from `params` by `toJsonSchema`. Never written by hand. */
  readonly schema: JsonSchema;
  /** Cross-field rules the closed-set shape cannot express. Pure. */
  readonly refine?: (params: CallParams) => CommandError | undefined;
}

export interface NativeEntry extends EntryBase {
  readonly kind: 'native';
  readonly prepare: PrepareFn;
}

export interface PortEntry extends EntryBase {
  readonly kind: 'port';
  readonly port: PortToolName;
}

/**
 * `agent.plan`: an entry for the table and its schema, and no way to call it. A
 * plan is submitted to `executePlan`, not dispatched as a tool, so a direct call
 * is refused with the corrective path.
 */
export interface ProtocolEntry extends EntryBase {
  readonly kind: 'protocol';
}

export type ToolEntry = NativeEntry | PortEntry | ProtocolEntry;

/** How the caller names a turn: its id, where it came from, and what the user has approved. */
export interface TurnContext {
  readonly turnId: string;
  readonly source?: ActivitySource;
  /** `approvedPlan` or `confirmed` — the flow facts the gate reads (command-bus §4). */
  readonly permission?: PermissionContext;
  /** The writer's stop. Awaited calls (an async port, an external read) end their wait when it fires; a started bus command is never interrupted. */
  readonly signal?: AbortSignal;
  /**
   * Set for a call made by a delegated agent (agent-harness §2, "Delegate"): `turn-3/reader#1`. The harness refuses every tool that is not a
   * read while it is present, behind the runner's own filter. Display and attribution otherwise; it grants nothing.
   */
  readonly agentPath?: string;
}

/** One tool call. `callId` is required: it is the idempotency key for a replay (command-bus §6). */
export interface ToolCall {
  readonly name: string;
  readonly callId: string;
  readonly params: unknown;
  /**
   * The output the agent loop staged for a model-backed tool (see `PortContext.proposal`). Set by
   * the loop only: an external caller's call has it removed before it reaches a port.
   */
  readonly proposal?: unknown;
}

export type ToolOutcome = Result<ToolValue, CommandError>;
