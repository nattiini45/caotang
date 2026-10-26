/**
 * The eval runner and the scenario format — agent-harness.md §9, with the trajectory discipline of
 * its note.
 *
 * A scenario is a fixed input and a fixed expectation. The input is an intent, a project, a gateway
 * whose mock scripts answer deterministically, and the decisions the user makes on cards. The
 * expectation has five parts, each optional but at least one present:
 *
 * - **response shape**: the turn's status, its ask-back code, and words its summary must carry;
 * - **cards**: the decisions the turn asked for, in order, with the tools each card ran;
 * - **trace**: the tool calls, in order, with the outcome of each and the params it named;
 * - **state**: a function over the final project, returning the failures it found;
 * - **budgets**: a token ceiling and a model-call ceiling for the turn, and the context drops it made.
 *
 * Matchers: `strict` requires the same items in the same order. `unordered` requires the same items
 * in any order, each matched once. A single-op turn is strict, and a plan whose steps commute is
 * unordered. The matcher's choice is part of the scenario, so a reader can see what was allowed to vary.
 *
 * The runner builds everything from the scenario and nothing else: a fresh project, a fresh harness
 * with the agent ports, a fresh session. Two runs of one scenario see the same bytes, so an eval is
 * a regression test and not a sample. This module has no runtime dependency on the gateway: the
 * caller builds the gateway, and the runner only reads it.
 */

import type { CoherenceModel, ModelReply, ModelRequest } from '@caotang/coherence';
import type { ChatRequest, Gateway } from '@caotang/gateway';
import { agentFileTexts, type ProjectState } from '@caotang/store';

import { metadataFor, type ToolName } from '../metadata.js';
import { createHarness } from '../runtime.js';
import type { SkillsOption } from '../tools/skills.js';
import type { AskBackCode } from '../plan.js';
import { canonicalJson } from '../util.js';
import { createAgentSession, type AgentSession, type AgentSessionOptions } from './loop.js';
import { createAgentPorts } from './ports.js';
import { createContextPort, type ContextPortOptions } from './context.js';
import { emptyTaskList, reduceTaskList, type TaskState } from './progress.js';
import { createProjectCommandRegistry } from '@caotang/store';

import type { AgentEvent, CardRecord, Decision, PendingCard, TraceEntry, TurnPhase, TurnReport, TurnStatus } from './events.js';

export type ScenarioCategory =
  | 'single-op'
  | 'multi-step'
  | 'plan-edit'
  | 'verify-recovery'
  | 'permission'
  | 'undo'
  | 'streaming'
  | 'anchor'
  | 'codex'
  | 'demo'
  | 'stop-steer';

export type Matcher = 'strict' | 'unordered';

/**
 * How a scenario's turn reached a deferred row (agent-harness §3): the planner searched for it, the scenario preloaded it, or
 * it named the row directly and the preflight checked it as it checks any step.
 */
export type ReachedBy = 'search' | 'preload' | 'preflight';

export interface CardExpect {
  readonly kind: 'plan' | 'confirm' | 'auto';
  readonly tools: readonly string[];
  readonly decision: 'approved' | 'cancelled' | 'auto';
}

export interface CallExpect {
  readonly tool: string;
  readonly outcome: 'ok' | 'refused' | 'not-run';
  /** A subset of the params the call named. Keys not listed are not checked. */
  readonly params?: Readonly<Record<string, unknown>>;
  /** The delegated agent that made the call (agent-harness §2). `null` is the turn's own call; absent, the path is not checked. */
  readonly agentPath?: string | null;
}

/**
 * One model request the scenario expects: its system message's opening, the text its messages carry, and
 * the text its system message carries. `includes` and `excludes` read every message of the request.
 */
export interface RequestExpect {
  readonly system?: string;
  readonly includes?: readonly string[];
  readonly excludes?: readonly string[];
  readonly systemIncludes?: readonly string[];
  readonly systemExcludes?: readonly string[];
}

/** One item of the turn's final task list (agent-harness §8): its line, its state and, for a failed item, words its reason carries. */
export interface TaskExpect {
  readonly content: string;
  readonly state: TaskState;
  readonly reason?: string;
}

/** When the writer acts during a turn (agent-harness §2, "Stop and steer"). Every moment is an event the turn emits, so a run is the same bytes twice. */
export type WriterMoment =
  /** As the nth model request of the turn is sent. */
  | { readonly modelCall: number }
  /** As the text of the nth model request starts to stream in. */
  | { readonly streaming: number }
  /** As the nth card is shown. */
  | { readonly card: number }
  /** As the nth bus command begins to apply. */
  | { readonly apply: number };

/** The writer stops the turn, or sends it a note, at a moment of the turn. */
export type WriterAction = { readonly at: WriterMoment; readonly do: 'stop' } | { readonly at: WriterMoment; readonly do: 'steer'; readonly text: string };

export interface Expectation {
  readonly status: TurnStatus;
  /** The turn was stopped by the writer, in this phase. Absent, the report is not read for a stop. */
  readonly stop?: { readonly during: TurnPhase };
  /** The notes the report carries, in order, with the model call each reached (absent: undelivered). */
  readonly steering?: readonly { readonly text: string; readonly deliveredAtCall?: number }[];
  /** The requests the gateway's ledger recorded for the turn: a stopped request still counts. */
  readonly ledgerRequests?: number;
  readonly askBack?: AskBackCode;
  /** The ask-back's candidates, by count (agent-harness §2: anchor drift names up to three). */
  readonly candidates?: number;
  /** The ask-back's revision drift: apply-time revision minus the captured one. */
  readonly revisionDrift?: number;
  readonly summaryIncludes?: readonly string[];
  readonly cards?: { readonly matcher: Matcher; readonly items: readonly CardExpect[] };
  readonly trace?: { readonly matcher: Matcher; readonly calls: readonly CallExpect[] };
  /** The task list the turn's events fold to, in strict order, planner row included. Every run is also held to the list's invariants. */
  readonly tasks?: readonly TaskExpect[];
  /** Each request expected must be matched, in order, by a request the gateway received. */
  readonly requests?: readonly RequestExpect[];
  /** Each string must appear in some reason the context assembly recorded. */
  readonly dropped?: readonly string[];
  /**
   * For each deferred extension row the turn called, how it was reached. A scenario that calls one must say so, and the run is
   * held to it: a `search` needs an earlier `tool.search` that loaded the row, a `preload` needs the scenario to preload it, and a
   * `preflight` needs neither.
   */
  readonly reached?: Readonly<Record<string, ReachedBy>>;
  /** The turn's prompt and completion tokens together, at most this many. */
  readonly maxTokens?: number;
  readonly maxModelCalls?: number;
  /**
   * The turn's undo group is reversed after the turn, and the project must be byte-equal to what it was
   * before the turn (command-bus §10's undo-replay invariant). `state` then reads the restored project.
   */
  readonly restores?: boolean;
  /** Returns the failures found in the final project. An empty list passes. */
  readonly state?: (state: ProjectState, report: TurnReport) => readonly string[];
}

/** A decision the scenario makes on a card, or a function that makes it from the card it is shown. */
export type ScenarioDecision = Decision | ((pending: PendingCard) => Decision);

export interface Scenario {
  readonly name: string;
  readonly category: ScenarioCategory;
  readonly intent: string;
  readonly project: () => ProjectState;
  /** Builds the gateway for this scenario. The mock scripts it answers with are the scenario's model. */
  readonly gateway: (state: ProjectState) => Promise<Gateway>;
  readonly contextOptions?: Partial<Omit<ContextPortOptions, 'state'>>;
  /** Used in order, one per card. A card with no decision left is approved. */
  readonly decisions?: readonly ScenarioDecision[];
  readonly maxRetries?: number;
  /** The session's model-call bound (agent-harness §2). Absent, the session's default applies. */
  readonly modelCallBound?: number;
  /** The permission mode, its budgets and the other options that belong to it (agent-harness §4). Absent, `ask`. */
  readonly modeOptions?: Pick<AgentSessionOptions, 'mode' | 'lockAuto' | 'taint' | 'noHuman' | 'budget' | 'sessionBudget' | 'price' | 'beforeAutoApply'>;
  /**
   * Wires the coherence review through the scenario's gateway, as the app wires it, so a scenario that asks for a review runs one.
   * Off by default: a wired review adds its schema to every planner call, which other scenarios' token ceilings do not count.
   */
  readonly coherence?: boolean;
  /** Deferred rows loaded before the planner's first request, as `submit(intent, { preload })` does. */
  readonly preload?: readonly ToolName[];
  /**
   * The app's lookup of the writer's reviews, as `HarnessOptions.skills` takes it. Given, the harness offers the project's skills as the
   * app does, and a turn that has a skill on offer preloads `skill.load` itself. Absent, the harness has no skills, as the outward server has none.
   */
  readonly skills?: SkillsOption;
  /** What the writer does during the turn, at fixed moments: the turn's signal is aborted, or a note is sent to it. */
  readonly writer?: readonly WriterAction[];
  readonly expect: Expectation;
}

/** The review's model, through the scenario's gateway: the adapter the app builds from its active profile (coherence.md §5.3). */
function reviewModelOf(gateway: Gateway): CoherenceModel {
  return {
    model: 'scenario',
    async complete(request: ModelRequest): Promise<ModelReply> {
      const message = await gateway.completeOnce(
        {
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
          responseFormat: { jsonSchemaHint: request.jsonSchemaHint },
          temperature: 0,
        },
        request.signal,
      );
      return { content: message.content };
    },
  };
}

export interface ScenarioRun {
  readonly report: TurnReport;
  readonly events: readonly AgentEvent[];
  readonly requests: readonly ChatRequest[];
  readonly pending: readonly PendingCard[];
  readonly state: ProjectState;
  /** The project's bytes before the turn, for the undo-replay check. */
  readonly before: string;
  /** Present when the scenario asked for a restore: whether it ran, and the project's bytes after it. */
  readonly restored?: { readonly ok: boolean; readonly message: string; readonly after: string };
}

export interface Evaluation {
  readonly run: ScenarioRun;
  readonly failures: readonly string[];
}

/** A gateway that records every request it is asked to send, and otherwise behaves as the gateway it wraps. */
function recording(base: Gateway, into: ChatRequest[]): Gateway {
  return {
    ...base,
    complete: (request, signal) => {
      into.push(request);
      return base.complete(request, signal);
    },
  };
}

/**
 * The bytes of everything an undo has to restore: the manifest, every body, and the decline record. Two projects with
 * the same bytes are the same project to the bus (command-bus §10). The agent's files are in it (CAOTANG.md and the memory notes), so a
 * restore that leaves a note behind is a failure. A document's revision is left out: it is runtime
 * bookkeeping that is never serialized, and an undo is a write that raises it.
 */
export function projectBytes(state: ProjectState): string {
  const documents = [...state.documents.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, record]) => [id, { id: record.id, body: record.body }] as const);
  return canonicalJson({ manifest: state.manifest, documents, declinedCodexFiles: [...state.declinedCodexFiles].sort(), agentFiles: agentFileTexts(state.agentFiles) });
}

/** Runs a scenario once, end to end, and returns what it did. Nothing is asserted here. */
export async function runScenario(scenario: Scenario): Promise<ScenarioRun> {
  const state = scenario.project();
  const requests: ChatRequest[] = [];
  const gateway = recording(await scenario.gateway(state), requests);
  const writer = scenario.writer ?? [];
  const stop = new AbortController();
  const held: { session?: AgentSession; turnId?: string } = {};
  const counts = { modelCall: 0, streaming: 0, card: 0, apply: 0 };
  const streamed = new Set<string>();
  /** The writer's actions for a moment that has just come: a stop aborts the signal, a note goes to the turn. */
  const happen = (moment: keyof typeof counts): void => {
    counts[moment] += 1;
    for (const action of writer) {
      if (!(moment in action.at) || (action.at as Record<string, number>)[moment] !== counts[moment]) continue;
      if (action.do === 'stop') stop.abort();
      else if (held.session !== undefined && held.turnId !== undefined) held.session.steer(held.turnId, action.text);
    }
  };
  // A scenario that acts when a command begins to apply needs the registry wrapped; the others keep the default one.
  const registry = writer.some((action) => 'apply' in action.at)
    ? (() => {
        const base = createProjectCommandRegistry({ clock: { now: Date.now } });
        return Object.fromEntries(
          Object.entries(base).map(([name, entry]) => [
            name,
            entry.apply === undefined
              ? entry
              : {
                  ...entry,
                  apply: (...args: unknown[]) => {
                    happen('apply');
                    return (entry.apply as (...inner: unknown[]) => unknown)(...args);
                  },
                },
          ]),
        ) as typeof base;
      })()
    : undefined;
  const harness = createHarness({
    state,
    ports: createAgentPorts(),
    ...(registry === undefined ? {} : { registry }),
    ...(scenario.coherence === true ? { coherence: { model: () => reviewModelOf(gateway) } } : {}),
    ...(scenario.skills === undefined ? {} : { skills: scenario.skills }),
  });
  const before = projectBytes(state);

  const events: AgentEvent[] = [];
  const pending: PendingCard[] = [];
  const queue = [...(scenario.decisions ?? [])];
  const decide = async (card: PendingCard): Promise<Decision> => {
    pending.push(card);
    const next = queue.shift();
    if (next === undefined) return { action: 'approve' };
    return typeof next === 'function' ? next(card) : next;
  };

  const session = createAgentSession({
    harness,
    gateway,
    context: createContextPort({ state, ...(scenario.contextOptions ?? {}) }),
    decide,
    emit: (event) => {
      events.push(event);
      held.turnId ??= event.turnId;
      if (event.type === 'model.call') happen('modelCall');
      else if (event.type === 'model.delta' && !streamed.has(String(counts.modelCall))) {
        streamed.add(String(counts.modelCall));
        happen('streaming');
      } else if (event.type === 'plan') happen('card');
    },
    // A fixed session name, so two runs of one scenario name the same turns and see the same bytes.
    sessionId: 'eval',
    ...(scenario.maxRetries === undefined ? {} : { maxRetries: scenario.maxRetries }),
    ...(scenario.modelCallBound === undefined ? {} : { maxModelCalls: scenario.modelCallBound }),
    ...(scenario.modeOptions ?? {}),
  });
  held.session = session;
  const report = await session.submit(scenario.intent, {
    ...(scenario.preload === undefined ? {} : { preload: scenario.preload }),
    ...(writer.length === 0 ? {} : { signal: stop.signal }),
  });
  if (scenario.expect.restores !== true) return { report, events, requests, pending, state, before };
  const outcome = session.restore(report.turnId);
  const restored = {
    ok: outcome.ok,
    message: outcome.ok ? '' : outcome.error.message,
    after: projectBytes(state),
  };
  return { report, events, requests, pending, state, before, restored };
}

/** A card item matches when its kind, decision and tools agree. Tools are compared as a multiset when unordered. */
function cardMatches(expected: CardExpect, actual: CardRecord, matcher: Matcher): boolean {
  if (expected.kind !== actual.kind || expected.decision !== actual.decision) return false;
  if (matcher === 'strict') return expected.tools.length === actual.tools.length && expected.tools.every((tool, index) => tool === actual.tools[index]);
  return [...expected.tools].sort().join('\u0000') === [...actual.tools].sort().join('\u0000');
}

/** A call item matches when its tool and outcome agree, and the params it names are a subset of the call's. */
function callMatches(expected: CallExpect, actual: TraceEntry): boolean {
  if (expected.tool !== actual.tool || expected.outcome !== actual.outcome) return false;
  if (expected.agentPath !== undefined && expected.agentPath !== (actual.agentPath ?? null)) return false;
  for (const [key, value] of Object.entries(expected.params ?? {})) {
    if (JSON.stringify(actual.params[key]) !== JSON.stringify(value)) return false;
  }
  return true;
}

/** Strict: the same items in the same order. Unordered: the same items in any order, each matched once. */
function matchList<E, A>(expected: readonly E[], actual: readonly A[], matches: (e: E, a: A) => boolean, matcher: Matcher, describe: (e: E) => string): string[] {
  if (matcher === 'strict') {
    const failures: string[] = [];
    if (expected.length !== actual.length) failures.push(`expected ${expected.length} items, got ${actual.length}`);
    for (const [index, item] of expected.entries()) {
      if (index < actual.length && !matches(item, actual[index] as A)) failures.push(`item ${index + 1}: expected ${describe(item)}`);
    }
    return failures;
  }
  const failures: string[] = [];
  if (expected.length !== actual.length) failures.push(`expected ${expected.length} items, got ${actual.length}`);
  const used = new Set<number>();
  for (const item of expected) {
    const found = actual.findIndex((candidate, index) => !used.has(index) && matches(item, candidate));
    if (found === -1) failures.push(`no item matches ${describe(item)}`);
    else used.add(found);
  }
  return failures;
}

export function matchCards(expected: readonly CardExpect[], actual: readonly CardRecord[], matcher: Matcher): string[] {
  return matchList(expected, actual, (e, a) => cardMatches(e, a, matcher), matcher, (e) => `card ${JSON.stringify(e)}`);
}

export function matchTrace(expected: readonly CallExpect[], actual: readonly TraceEntry[], matcher: Matcher): string[] {
  return matchList(expected, actual, callMatches, matcher, (e) => `call ${JSON.stringify(e)}`);
}

/** Each expected request must be matched by a request the gateway received, and the matches must come in order. */
function matchRequests(expected: readonly RequestExpect[], actual: readonly ChatRequest[]): string[] {
  const failures: string[] = [];
  let cursor = 0;
  for (const [index, want] of expected.entries()) {
    let found = -1;
    for (let at = cursor; at < actual.length; at += 1) {
      const request = actual[at] as ChatRequest;
      const text = request.messages.map((message) => message.content).join('\n');
      const system = request.messages[0]?.content ?? '';
      if (want.system !== undefined && !system.startsWith(want.system)) continue;
      if (!(want.includes ?? []).every((part) => text.includes(part))) continue;
      if ((want.excludes ?? []).some((part) => text.includes(part))) continue;
      if (!(want.systemIncludes ?? []).every((part) => system.includes(part))) continue;
      if ((want.systemExcludes ?? []).some((part) => system.includes(part))) continue;
      found = at;
      break;
    }
    if (found === -1) {
      const wanted = [...(want.includes ?? []), ...(want.systemIncludes ?? []).map((part) => `system: ${part}`)];
      failures.push(`request ${index + 1}: no model request carries ${JSON.stringify(wanted)}`);
    } else {
      cursor = found + 1;
    }
  }
  return failures;
}

/**
 * The task list of a run, checked: never two items in progress, one in progress while the model is asked or a step runs, and
 * nothing left unfinished once the turn has reported. With `expected`, the final list must be those items, in that order.
 */
export function taskListFailures(events: readonly AgentEvent[], report: TurnReport, expected?: readonly TaskExpect[]): string[] {
  const failures: string[] = [];
  let list = emptyTaskList(report.turnId);
  for (const [index, event] of events.entries()) {
    list = reduceTaskList(list, event);
    const active = list.items.filter((item) => item.state === 'in_progress').length;
    const where = `after event ${index + 1} (${event.type}${event.type === 'turn' ? ` ${event.phase}` : ''})`;
    if (active > 1) failures.push(`tasks: ${active} items in progress ${where}`);
    const asking = list.phase === 'planning' || list.phase === 'retrying';
    if (asking && event.type === 'turn' && active !== 1) failures.push(`tasks: ${active} items in progress ${where}, and the model is being asked`);
    if (event.type === 'turn' && list.phase === 'running' && list.items.some((item) => item.state === 'waiting')) failures.push(`tasks: an item still waits for a decision ${where}`);
  }
  const open = list.items.filter((item) => item.state === 'in_progress' || item.state === 'pending' || item.state === 'waiting');
  if (open.length > 0) failures.push(`tasks: ${open.map((item) => `${item.content} is ${item.state}`).join('; ')} after the report`);
  if (expected === undefined) return failures;
  const actual = list.items;
  if (actual.length !== expected.length) failures.push(`tasks: expected ${expected.length} items, got ${actual.length} (${actual.map((item) => `${item.content}: ${item.state}`).join('; ')})`);
  for (const [index, want] of expected.entries()) {
    const item = actual[index];
    if (item === undefined) continue;
    if (item.content !== want.content || item.state !== want.state) {
      failures.push(`tasks: item ${index + 1} should be ${want.content} (${want.state}), got ${item.content} (${item.state})`);
    } else if (want.reason !== undefined && !(item.reason ?? '').includes(want.reason)) {
      failures.push(`tasks: item ${index + 1} should fail with ${JSON.stringify(want.reason)}, got ${JSON.stringify(item.reason ?? '')}`);
    }
  }
  return failures;
}

/** The restore, checked: it ran, and the project after it is the project before the turn, byte for byte. */
function restoreFailures(run: ScenarioRun): string[] {
  if (run.restored === undefined) return ['restore: the scenario asked for a restore, and none ran'];
  if (!run.restored.ok) return [`restore: ${run.restored.message}`];
  return run.restored.after === run.before ? [] : ['restore: the project after the restore is not the project before the turn'];
}

/** The deferred rows the turn called, each held to the way the scenario says it was reached (Expectation.reached). */
function reachedFailures(scenario: Scenario, run: ScenarioRun): string[] {
  const failures: string[] = [];
  const reached = scenario.expect.reached ?? {};
  const called = [...new Set(run.report.trace.map((entry) => entry.tool))].filter((tool) => metadataFor(tool)?.load === 'deferred');
  for (const tool of called) {
    const how = reached[tool];
    if (how === undefined) {
      failures.push(`reached: ${tool} is a deferred row, so the scenario must say how the turn reached it`);
      continue;
    }
    const first = run.report.steps.findIndex((step) => step.tool === tool);
    const searched = run.report.steps.some((step, index) => {
      const surfaced = (step.data as { surfaced?: unknown } | undefined)?.surfaced;
      return index < first && step.tool === 'tool.search' && Array.isArray(surfaced) && surfaced.includes(tool);
    });
    // `skill.load` is preloaded by the harness whenever the project has a skill on offer (loop.ts `plannedTurn`).
    const preloaded = (scenario.preload ?? []).includes(tool as ToolName) || (tool === 'skill.load' && scenario.skills !== undefined);
    const actual: ReachedBy = preloaded ? 'preload' : searched ? 'search' : 'preflight';
    if (actual !== how) failures.push(`reached: ${tool} was expected by ${how}, and was reached by ${actual}`);
  }
  for (const tool of Object.keys(reached)) {
    if (!called.includes(tool)) failures.push(`reached: ${tool} is listed but the turn did not call it`);
  }
  return failures;
}

/** Checks a run against its expectation. Returns every failure, so one bad field does not hide another. */
export function checkRun(scenario: Scenario, run: ScenarioRun): string[] {
  const { expect } = scenario;
  const { report } = run;
  const failures: string[] = [];
  if (report.status !== expect.status) failures.push(`status: expected ${expect.status}, got ${report.status} (${report.summary})`);
  if (expect.askBack !== undefined && report.askBack?.code !== expect.askBack) {
    failures.push(`ask-back: expected ${expect.askBack}, got ${report.askBack?.code ?? 'none'}`);
  }
  if (expect.candidates !== undefined) {
    const found = report.askBack?.candidates?.length ?? 0;
    if (found !== expect.candidates) failures.push(`ask-back: expected ${expect.candidates} candidates, got ${found}`);
  }
  if (expect.revisionDrift !== undefined && report.askBack?.revisionDrift !== expect.revisionDrift) {
    failures.push(`ask-back: expected revision drift ${expect.revisionDrift}, got ${report.askBack?.revisionDrift ?? 'none'}`);
  }
  if (expect.restores === true) failures.push(...restoreFailures(run));
  if (expect.stop !== undefined && (report.stop?.by !== 'user' || report.stop.during !== expect.stop.during)) {
    failures.push(`stop: expected the writer to stop the turn during ${expect.stop.during}, got ${JSON.stringify(report.stop ?? null)}`);
  }
  if (expect.steering !== undefined) {
    const sent = (report.steering ?? []).map((note) => ({ text: note.text, ...(note.deliveredAtCall === undefined ? {} : { deliveredAtCall: note.deliveredAtCall }) }));
    if (JSON.stringify(sent) !== JSON.stringify(expect.steering)) failures.push(`steering: expected ${JSON.stringify(expect.steering)}, got ${JSON.stringify(sent)}`);
  }
  if (expect.ledgerRequests !== undefined && report.tokens.requests !== expect.ledgerRequests) {
    failures.push(`ledger: expected ${expect.ledgerRequests} recorded requests, got ${report.tokens.requests}`);
  }
  for (const part of expect.summaryIncludes ?? []) {
    if (!report.summary.includes(part)) failures.push(`summary: expected it to include ${JSON.stringify(part)}, got ${JSON.stringify(report.summary)}`);
  }
  if (expect.cards !== undefined) failures.push(...matchCards(expect.cards.items, report.cards, expect.cards.matcher));
  if (expect.trace !== undefined) failures.push(...matchTrace(expect.trace.calls, report.trace, expect.trace.matcher));
  failures.push(...taskListFailures(run.events, report, expect.tasks));
  if (expect.requests !== undefined) failures.push(...matchRequests(expect.requests, run.requests));
  for (const reason of expect.dropped ?? []) {
    if (!report.dropped.some((entry) => entry.includes(reason))) failures.push(`dropped: no reason includes ${JSON.stringify(reason)}`);
  }
  if (expect.maxTokens !== undefined) {
    const spent = report.tokens.promptTokens + report.tokens.completionTokens;
    if (spent > expect.maxTokens) failures.push(`tokens: ${spent} spent, the ceiling is ${expect.maxTokens}`);
  }
  if (expect.maxModelCalls !== undefined && report.modelCalls > expect.maxModelCalls) {
    failures.push(`model calls: ${report.modelCalls} made, the ceiling is ${expect.maxModelCalls}`);
  }
  failures.push(...reachedFailures(scenario, run));
  if (expect.state !== undefined) failures.push(...expect.state(run.state, report));
  return failures;
}

/** Runs a scenario and checks it. The one call a test needs. */
export async function evaluate(scenario: Scenario): Promise<Evaluation> {
  const run = await runScenario(scenario);
  return { run, failures: checkRun(scenario, run) };
}
