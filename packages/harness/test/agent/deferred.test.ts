/**
 * Search-then-load for the registry's own deferred rows (agent-harness §3, extensibility §5): the planner declares the core rows
 * and the rows the turn has loaded, `tool.search` and a preload load a deferred row, and a deferred row the turn has not
 * loaded is still preflighted, because deferral is about context and not trust.
 *
 * The sessions are real, on the real bus, answered by the mock provider; the native wire is the real gateway with `modelCaps`
 * reporting `tools`, as `native.test.ts` has it.
 */

import { describe, expect, it } from 'vitest';

import type { ChatRequest, Gateway } from '@caotang/gateway';
import { userTextOf, type MockScript } from '@caotang/gateway/mock';
import { getBody } from '@caotang/store';

import {
  MORE_TOOLS_LINE,
  PLANNER_SYSTEM_PREFIX,
  PRELOAD_BY_CONTEXT,
  createAgentPorts,
  createAgentSession,
  createContextPort,
  plannerSystem,
  plannerSystemNative,
  plannerToolDefs,
  plannerTools,
  preloadFor,
  type AgentSession,
  type Harness,
} from '../../src/index.js';
import { evaluate, type Scenario } from '../../src/agent/eval.js';
import { FRIEND, makeHarness, makeState, run, valueOf } from '../fixtures.js';
import { mockGateway } from './gateway.js';
import { answer, steps, transcript } from './scripts.js';

const COHERENCE_SCAN = { scope: { mode: 'full' } };

const wiredHarness = (): Harness => makeHarness({ ports: createAgentPorts() });
const namesOf = (request: ChatRequest | undefined): string[] => (request?.tools ?? []).map((tool) => tool.name);
const textOf = (request: ChatRequest | undefined): string => (request?.messages ?? []).map((message) => message.content).join('\n');
const systemOf = (request: ChatRequest | undefined): string => request?.messages[0]?.content ?? '';

/* ------------------------------------------------------------------ *
 * The declared surface: core rows up front, and the size that buys.
 * ------------------------------------------------------------------ */

describe('the planner declares the core rows, and the deferred ones once the turn has loaded them', () => {
  const harness = wiredHarness();
  const tools = harness.tools();
  const core = plannerToolDefs(tools, [], []);

  it('declares at most 14 tools for the fixture, none of them deferred, and the same rows in the system message', () => {
    expect(core.length).toBeLessThanOrEqual(14);
    const deferred = new Set(tools.filter((tool) => tool.load === 'deferred').map((tool) => tool.name as string));
    expect(core.filter((def) => deferred.has(def.name))).toEqual([]);
    expect(core.map((def) => def.name)).toContain('tool.search');
    const system = plannerSystem(tools);
    for (const def of core) expect(system, def.name).toContain(`- ${def.name} [`);
    for (const name of deferred) expect(system, name).not.toContain(`- ${name} [`);
    expect(plannerSystemNative(tools)).not.toContain('"steps"');
  });

  it('pins the declaration size for the fixture before a search, and shows it larger only after a search or a preload', () => {
    // 18040 characters at the time of writing; the ceiling leaves room for a description edit, not for a row.
    const before = JSON.stringify(core).length;
    expect(before).toBeLessThanOrEqual(18_500);

    const turnId = 'turn-size';
    valueOf(run(harness, 'tool.search', { query: 'coherence' }, { turnId }));
    const afterSearch = plannerToolDefs(tools, harness.loadedNativeTools(), []);
    expect(afterSearch.length).toBeGreaterThan(core.length);
    expect(JSON.stringify(afterSearch).length).toBeGreaterThan(before);
    expect(afterSearch.map((def) => def.name)).toEqual(expect.arrayContaining(['coherence.scan', 'coherence.setFindingStatus']));
    harness.endTurn(turnId);
    expect(harness.loadedNativeTools()).toEqual([]);

    harness.preload('turn-size-2', ['dialogue.table']);
    expect(plannerToolDefs(tools, harness.loadedNativeTools(), []).map((def) => def.name)).toContain('dialogue.table');
    harness.endTurn('turn-size-2');
  });

  it('restores today’s full declaration set when every tool is asked for', () => {
    const all = plannerToolDefs(tools, [], [], true);
    expect(all.length).toBeGreaterThan(core.length);
    expect(all.map((def) => def.name)).toEqual(plannerTools(tools, { all: true }).map((tool) => tool.name));
    expect(plannerSystem(tools, true)).toContain('- coherence.scan [');
  });

  it('keeps the continuity.scan hide rule, which is not deferral', () => {
    const reviewed = makeHarness({ ports: createAgentPorts(), coherence: { model: () => ({ model: 'x', complete: async () => ({ content: '{}' }) }) } });
    expect(plannerTools(reviewed.tools(), { all: true }).map((tool) => tool.name)).not.toContain('continuity.scan');
    expect(plannerTools(reviewed.tools()).length).toBe(13);
  });

  it('ends the system message with one fixed line that more tools exist, whatever a turn loads', () => {
    expect(plannerSystem(tools).endsWith(MORE_TOOLS_LINE)).toBe(true);
    expect(MORE_TOOLS_LINE).toContain('tool.search');
    // The system message takes no argument a load could change.
    expect(plannerSystem(tools)).toBe(plannerSystem(tools));
  });
});

/* ------------------------------------------------------------------ *
 * The harness: search and preload load native rows for the turn.
 * ------------------------------------------------------------------ */

describe('tool.search over the registry’s deferred rows', () => {
  it('returns native matches by registry name, with a risk badge and a short excerpt, and loads them for the turn', () => {
    const harness = wiredHarness();
    const found = valueOf(run(harness, 'tool.search', { query: 'coherence', limit: 20 }, { turnId: 'turn-a' }));
    const matches = found.data['matches'] as { source: string; name: string; risk: string; excerpt: string }[];
    expect(matches.map((match) => match.name)).toEqual(['coherence.scan', 'coherence.setFindingStatus']);
    expect(matches.every((match) => match.source === 'native' && !match.name.startsWith('mcp__'))).toBe(true);
    expect(matches.map((match) => match.risk)).toEqual(['read', 'write']);
    expect(matches.every((match) => match.excerpt.length <= 200)).toBe(true);
    expect(harness.loadedNativeTools().map((tool) => tool.name)).toEqual(['coherence.scan', 'coherence.setFindingStatus']);
    expect(harness.loadedAddendum()).toBe('Tools loaded this turn, callable by name: coherence.scan, coherence.setFindingStatus.');
  });

  it('lists native rows in registry order, and finds a row by a keyword its description does not carry', () => {
    const harness = wiredHarness();
    const all = valueOf(run(harness, 'tool.search', { query: '', limit: 20 }, { turnId: 'turn-order' })).data['surfaced'] as string[];
    const registry = harness.tools().map((tool) => tool.name as string);
    expect(all).toEqual([...all].sort((a, b) => registry.indexOf(a) - registry.indexOf(b)));
    const byKeyword = valueOf(run(harness, 'tool.search', { query: 'cutscene' }, { turnId: 'turn-keyword' })).data['surfaced'] as string[];
    expect(byKeyword).toContain('dialogue.table');
  });

  it('offers only rows that are callable and wired, so a loaded row is never one the bus would refuse as not wired', () => {
    const surfaced = valueOf(run(makeHarness(), 'tool.search', { query: '', limit: 20 }, { turnId: 'turn-bare' })).data['surfaced'] as string[];
    // A bare harness wires neither the model-backed kinds nor the review.
    expect(surfaced).not.toContain('shots.derive');
    expect(surfaced).not.toContain('coherence.review');
    expect(surfaced).toContain('coherence.scan');
  });

  it('never offers a core row, which is declared already', () => {
    const surfaced = valueOf(run(wiredHarness(), 'tool.search', { query: 'doc', limit: 20 }, { turnId: 'turn-core' })).data['surfaced'] as string[];
    expect(surfaced).not.toContain('doc.read');
    expect(surfaced).toContain('doc.import');
  });

  it('loads a preloaded row for the turn only, ignores a name that is not deferred, and drops the load with the turn', () => {
    const harness = wiredHarness();
    harness.preload('turn-p', ['dialogue.table', 'doc.read', 'nope']);
    expect(harness.loadedNativeTools().map((tool) => tool.name)).toEqual(['dialogue.table']);
    harness.endTurn('turn-p');
    expect(harness.loadedNativeTools()).toEqual([]);
    expect(harness.loadedAddendum()).toBeUndefined();
  });
});

describe('the context-preload table', () => {
  it('preloads dialogue.* for a dialogue container and shots.* for a storyboard, a shot or a screenplay scene, and nothing for prose', () => {
    expect(preloadFor({ type: 'dialogue' })).toEqual(PRELOAD_BY_CONTEXT.dialogue);
    expect(PRELOAD_BY_CONTEXT.dialogue.every((name) => name.startsWith('dialogue.'))).toBe(true);
    for (const node of [{ type: 'folder', kind: 'storyboard' }, { type: 'shot' }, { type: 'document', kind: 'screenplay' }] as const) {
      expect(preloadFor(node)).toEqual(PRELOAD_BY_CONTEXT.storyboard);
    }
    expect(PRELOAD_BY_CONTEXT.storyboard.every((name) => name.startsWith('shots.'))).toBe(true);
    expect(preloadFor({ type: 'document' })).toEqual([]);
    expect(preloadFor(undefined)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * The loop, on the JSON wire.
 * ------------------------------------------------------------------ */

const SEARCH_INTENT = 'Check the manuscript for continuity problems.';

const searchLoadCall: Scenario = {
  name: 'search, load, call: the planner searches for a deferred row, is told its parameters, and calls it',
  category: 'multi-step',
  intent: SEARCH_INTENT,
  project: makeState,
  gateway: () =>
    mockGateway([
      transcript(SEARCH_INTENT, [
        steps({ tool: 'tool.search', params: { query: 'coherence scan' }, expect: 'the coherence tools are loaded' }),
        steps({ tool: 'coherence.scan', params: COHERENCE_SCAN, expect: 'the manuscript is scanned' }),
        answer('The scan is done.'),
      ]),
    ]),
  expect: {
    status: 'replied',
    cards: { matcher: 'strict', items: [] },
    trace: {
      matcher: 'strict',
      calls: [
        { tool: 'tool.search', outcome: 'ok' },
        { tool: 'coherence.scan', outcome: 'ok' },
      ],
    },
    reached: { 'coherence.scan': 'search' },
    maxModelCalls: 3,
  },
};

describe('search, load, call on the JSON wire', () => {
  it('runs the deferred row after the search, and sends its descriptor after the system prompt, leaving the system message as it was', async () => {
    const result = await evaluate(searchLoadCall);
    expect(result.failures).toEqual([]);
    const [first, second] = result.run.requests;
    // The system message is the cached prefix: a mid-turn load does not touch a byte of it.
    expect(systemOf(second)).toBe(systemOf(first));
    expect(systemOf(first)).not.toContain('coherence.scan');
    expect(second?.messages.findIndex((message) => message.content.includes('- coherence.scan [read]'))).toBeGreaterThan(0);
    expect(textOf(second)).toContain('Tools loaded for this turn.');
    expect(textOf(first)).not.toContain('Tools loaded for this turn.');
  });

  it('preflights a deferred row the turn has not loaded rather than refusing it, and runs a valid call', async () => {
    const result = await evaluate({
      ...searchLoadCall,
      name: 'direct preflight: a deferred row named without a search runs',
      gateway: () =>
        mockGateway([
          transcript(SEARCH_INTENT, [steps({ tool: 'coherence.scan', params: COHERENCE_SCAN, expect: 'the manuscript is scanned' }), answer('Done.')]),
        ]),
      expect: {
        status: 'replied',
        trace: { matcher: 'strict', calls: [{ tool: 'coherence.scan', outcome: 'ok' }] },
        reached: { 'coherence.scan': 'preflight' },
      },
    });
    expect(result.failures).toEqual([]);
  });

  it('adds the search to the refusal when an unloaded deferred row’s params fail, and not once the row is loaded', async () => {
    const bad = steps({ tool: 'coherence.scan', params: { scope: 'everything' }, expect: 'the manuscript is scanned' });
    const unloaded = await evaluate({
      ...searchLoadCall,
      name: 'bad params on an unloaded deferred row',
      gateway: () => mockGateway([transcript(SEARCH_INTENT, [bad, answer('I could not scan it.')])]),
      expect: { status: 'replied', trace: { matcher: 'strict', calls: [{ tool: 'coherence.scan', outcome: 'refused' }] }, reached: { 'coherence.scan': 'preflight' } },
    });
    expect(unloaded.failures).toEqual([]);
    expect(textOf(unloaded.run.requests[1])).toContain("Call tool.search with 'coherence.scan' to load its parameters.");

    const loaded = await evaluate({
      ...searchLoadCall,
      name: 'bad params on a loaded deferred row',
      gateway: () =>
        mockGateway([
          transcript(SEARCH_INTENT, [steps({ tool: 'tool.search', params: { query: 'coherence scan' }, expect: 'loaded' }), bad, answer('I could not scan it.')]),
        ]),
      expect: {
        status: 'replied',
        trace: {
          matcher: 'strict',
          calls: [
            { tool: 'tool.search', outcome: 'ok' },
            { tool: 'coherence.scan', outcome: 'refused' },
          ],
        },
        reached: { 'coherence.scan': 'search' },
      },
    });
    expect(loaded.failures).toEqual([]);
    const last = loaded.run.requests.at(-1);
    expect(textOf(last)).toContain('"scope"');
    expect(textOf(last)).not.toContain("Call tool.search with 'coherence.scan' to load its parameters.");
  });

  it('states a preload’s descriptors after the request, and the system message does not name the row', async () => {
    const result = await evaluate({
      ...searchLoadCall,
      name: 'preload: a deferred row is loaded before the first request',
      preload: ['coherence.scan'],
      gateway: () => mockGateway([transcript(SEARCH_INTENT, [steps({ tool: 'coherence.scan', params: COHERENCE_SCAN, expect: 'scanned' }), answer('Done.')])]),
      expect: {
        status: 'replied',
        trace: { matcher: 'strict', calls: [{ tool: 'coherence.scan', outcome: 'ok' }] },
        reached: { 'coherence.scan': 'preload' },
      },
    });
    expect(result.failures).toEqual([]);
    const [first, second] = result.run.requests;
    expect(systemOf(first)).not.toContain('coherence.scan');
    expect(textOf(first)).toContain('- coherence.scan [read]');
    // The names are not announced a second time in the one-line addendum.
    expect(textOf(first)).not.toContain('Tools loaded this turn, callable by name');
    expect(systemOf(second)).toBe(systemOf(first));
  });

  it('holds a scenario to how it says it reached a deferred row', async () => {
    const wrong = await evaluate({ ...searchLoadCall, expect: { ...searchLoadCall.expect, reached: { 'coherence.scan': 'preflight' } } });
    expect(wrong.failures).toEqual(['reached: coherence.scan was expected by preflight, and was reached by search']);
    const missing = await evaluate({ ...searchLoadCall, expect: { ...searchLoadCall.expect, reached: {} } });
    expect(missing.failures).toEqual(['reached: coherence.scan is a deferred row, so the scenario must say how the turn reached it']);
  });
});

/* ------------------------------------------------------------------ *
 * The loop, on the native wire.
 * ------------------------------------------------------------------ */

function isNativePlanner(req: ChatRequest): boolean {
  const first = req.messages[0];
  return (req.tools?.length ?? 0) > 0 && first?.role === 'system' && first.content.startsWith(PLANNER_SYSTEM_PREFIX);
}

const repliesSoFar = (req: ChatRequest): number => req.messages.filter((message) => message.role === 'assistant').length;

interface NativeCall {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
}

/** A native planner for one intent: reply n answers the nth planner request, and the last repeats. */
function nativeScripts(intent: string, replies: readonly { readonly content?: string; readonly calls?: readonly NativeCall[] }[]): MockScript[] {
  return [
    {
      match: (req) => isNativePlanner(req) && userTextOf(req).includes(`Request: ${intent}`),
      respond: (req) => {
        const reply = replies[Math.min(repliesSoFar(req), replies.length - 1)];
        return {
          content: reply?.content ?? '',
          ...(reply?.calls === undefined ? {} : { toolCalls: reply.calls.map((call) => ({ id: call.id, name: call.name, argumentsJson: JSON.stringify(call.args) })) }),
        };
      },
    },
  ];
}

async function nativeSession(scripts: readonly MockScript[], harness: Harness, extra: { readonly loadEveryTool?: () => boolean } = {}) {
  const seen: ChatRequest[] = [];
  const base = await mockGateway(scripts);
  const gateway: Gateway = {
    ...base,
    modelCaps: () => ({ tools: true }),
    complete: (req, signal) => {
      seen.push(req);
      return base.complete(req, signal);
    },
  };
  const session: AgentSession = createAgentSession({
    harness,
    gateway,
    context: createContextPort({ state: () => harness.state }),
    decide: async () => ({ action: 'approve' }),
    sessionId: 'deferred',
    ...extra,
  });
  return { session, seen };
}

describe('search, load, call on the native wire', () => {
  const intent = 'Scan the manuscript for continuity problems.';
  const replies = [
    { calls: [{ id: 'call_s', name: 'tool.search', args: { query: 'coherence scan' } }] },
    { calls: [{ id: 'call_c', name: 'coherence.scan', args: COHERENCE_SCAN }] },
    { content: 'The scan is done.' },
  ];

  it('declares the core rows first, declares the loaded row on the next request, and never changes the system message', async () => {
    const { session, seen } = await nativeSession(nativeScripts(intent, replies), wiredHarness());
    const report = await session.submit(intent);
    expect(report.status).toBe('replied');
    expect(report.trace.map((row) => [row.tool, row.outcome])).toEqual([
      ['tool.search', 'ok'],
      ['coherence.scan', 'ok'],
    ]);
    const [first, second, third] = seen.filter(isNativePlanner);
    expect(namesOf(first)).not.toContain('coherence.scan');
    expect(namesOf(first).length).toBeLessThanOrEqual(14);
    expect(namesOf(second)).toContain('coherence.scan');
    expect(namesOf(third)).toContain('coherence.scan');
    // The cached prefix is byte-identical, and the descriptor rides a user message after the search's tool message.
    expect(systemOf(second)).toBe(systemOf(first));
    expect(systemOf(third)).toBe(systemOf(first));
    const answered = second?.messages.findIndex((message) => message.role === 'tool' && message.toolCallId === 'call_s') ?? -1;
    const described = second?.messages.findIndex((message) => message.role === 'user' && message.content.includes('- coherence.scan [read]')) ?? -1;
    expect(answered).toBeGreaterThan(0);
    expect(described).toBeGreaterThan(answered);
  });

  it('declares a preloaded row on the first request, with its descriptor after the system prompt', async () => {
    const { session, seen } = await nativeSession(nativeScripts(intent, [{ calls: [{ id: 'call_c', name: 'coherence.scan', args: COHERENCE_SCAN }] }, { content: 'Done.' }]), wiredHarness());
    await session.submit(intent, { preload: ['coherence.scan'] });
    const [first] = seen.filter(isNativePlanner);
    expect(namesOf(first)).toContain('coherence.scan');
    expect(systemOf(first)).not.toContain('- coherence.scan [');
    expect(textOf(first)).toContain('- coherence.scan [read]');
  });

  it('declares every callable row from the first request when every tool is asked for', async () => {
    const harness = wiredHarness();
    const { session, seen } = await nativeSession(nativeScripts(intent, [{ content: 'Nothing to do.' }]), harness, { loadEveryTool: () => true });
    await session.submit(intent, { preload: ['coherence.scan'] });
    const [first] = seen.filter(isNativePlanner);
    expect(namesOf(first)).toEqual(plannerTools(harness.tools(), { all: true }).map((tool) => tool.name));
    expect(systemOf(first)).toContain('- coherence.scan [');
    // Everything is declared already, so a preload sends no descriptor of its own.
    expect(textOf(first)).not.toContain('Tools loaded for this turn.');
  });
});

/* ------------------------------------------------------------------ *
 * Plans the app built run deferred rows without a load.
 * ------------------------------------------------------------------ */

describe('submitPlan and executePlan run a deferred row with no load', () => {
  it('runs a plan of deferred rows through executePlan, and an app-built turn through submitPlan', async () => {
    const harness = wiredHarness();
    const plan = { steps: [{ tool: 'coherence.scan', params: COHERENCE_SCAN, expect: 'scanned' }] };
    const executed = harness.executePlan(plan, { turnId: 'turn-exec', callId: 'plan-1' });
    expect(executed.ok).toBe(true);
    expect(harness.loadedNativeTools()).toEqual([]);

    const gateway = await mockGateway([]);
    const session = createAgentSession({ harness, gateway, decide: async () => ({ action: 'approve' }), sessionId: 'given' });
    const report = await session.submitPlan('Scan the manuscript.', plan);
    expect(report.status).toBe('applied');
    expect(report.trace.map((row) => row.tool)).toEqual(['coherence.scan']);
    expect(getBody(harness.state, FRIEND)).toBeDefined();
  });
});
