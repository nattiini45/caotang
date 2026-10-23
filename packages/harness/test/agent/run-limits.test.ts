/**
 * Run limits (agent-harness §7.1) on the real session, the real bus and the mock provider: a call's worst case is reserved before it
 * is sent, so a limit is never crossed; a time limit aborts a call in flight by the path the writer's Stop uses and ends the turn on
 * the limit, not on a provider error or a stop; a step limit refuses a plan before it is drafted. Time is a manual clock.
 */

import { describe, expect, it } from 'vitest';

import type { CoherenceModel, ModelRequest } from '@caotang/coherence';
import {
  createGateway,
  createKeyStore,
  createManualClock,
  createMemoryVaultPort,
  createProfileStore,
  usageFor,
  type ChatChunk,
  type Gateway,
} from '@caotang/gateway';
import { createMockProvider, isPlannerCall, userTextOf, type MockScript } from '@caotang/gateway/mock';
import { createMcpClient, createMockWire, qualifiedNameOf, WireError, type McpServerConfig, type McpWire, type WireTool } from '@caotang/mcp-client';
import type { ProjectState } from '@caotang/store';

import {
  createAgentPorts,
  createAgentSession,
  createBudgetMeter,
  createContextPort,
  createHarness,
  type AgentEvent,
  type BudgetMeter,
  type Decision,
  type RunLimits,
  type TurnReport,
} from '../../src/index.js';
import { FRIEND, STORM, clock, makeState, snapshotOf, type makeHarness } from '../fixtures.js';
import { answer, steps, transcript } from './scripts.js';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface ProfileFields {
  readonly maxOutputTokens?: number;
  readonly pricePer1k?: { readonly prompt: number; readonly completion: number };
}

/** A real gateway with one active mock profile. The profile's output cap is what each call reserves on top of its prompt. */
async function gatewayFor(scripts: readonly MockScript[], profile: ProfileFields = {}): Promise<Gateway> {
  const keys = createKeyStore(createMemoryVaultPort());
  const profiles = createProfileStore({ keys });
  await profiles.create({ name: 'Mock', kind: 'mock', isActive: true, ...profile });
  return createGateway({ profiles, keys, clock: createManualClock(0), mock: createMockProvider({ scripts: [...scripts] }) });
}

interface Fixture {
  readonly session: ReturnType<typeof createAgentSession>;
  readonly state: ProjectState;
  readonly events: AgentEvent[];
  readonly gateway: Gateway;
  readonly time: ReturnType<typeof createManualClock>;
  readonly meter: BudgetMeter;
}

interface FixtureOptions {
  readonly limits?: RunLimits;
  readonly profile?: ProfileFields;
  readonly decide?: (time: ReturnType<typeof createManualClock>) => Promise<Decision> | Decision;
  readonly coherence?: { readonly model: () => CoherenceModel };
  readonly mcp?: NonNullable<Parameters<typeof makeHarness>[0]>['mcp'];
  readonly price?: () => { readonly prompt: number; readonly completion: number } | undefined;
}

async function fixture(scripts: readonly MockScript[], options: FixtureOptions = {}): Promise<Fixture> {
  const state = makeState();
  const gateway = await gatewayFor(scripts, options.profile);
  const time = createManualClock(1_000_000);
  const meter = createBudgetMeter(options.limits ?? {}, { clock: time });
  const harness = createHarness({
    state,
    ports: createAgentPorts(),
    clock: clock.now,
    ...(options.coherence === undefined ? {} : { coherence: options.coherence }),
    ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
  });
  const events: AgentEvent[] = [];
  const session = createAgentSession({
    harness,
    gateway,
    context: createContextPort({ state }),
    decide: async () => (options.decide === undefined ? { action: 'approve' } : options.decide(time)),
    emit: (event) => events.push(event),
    meter,
    ...(options.price === undefined ? {} : { price: options.price }),
    sessionId: 'rl',
  });
  return { session, state, events, gateway, time, meter };
}

/** A planner script that streams its reply and ends on the usage it names, whatever the prompt was. */
function plannerUsing(intent: string, replies: readonly string[], usage: { promptTokens: number; completionTokens: number }, prompts?: number[]): MockScript {
  return {
    match: (req) => isPlannerCall(req) && userTextOf(req).includes(`Request: ${intent}`),
    respond: (req): AsyncIterable<ChatChunk> => {
      prompts?.push(usageFor(req.messages, '').promptTokens);
      const calls = req.messages.filter((message) => message.role === 'assistant').length;
      const reply = replies[Math.min(calls, replies.length - 1)] ?? '';
      return (async function* (): AsyncGenerator<ChatChunk> {
        yield { delta: reply };
        yield { finishReason: 'stop', usage };
      })();
    },
  };
}

/** Two writes, so the reply makes a card for the writer to decide. */
const TWO_STEPS = steps(
  { tool: 'meta.set', params: { targets: [STORM], keywords_add: ['storm'] }, expect: 'The Storm is tagged' },
  { tool: 'meta.set', params: { targets: [FRIEND], label: 'act-2' }, expect: 'The Friend is labelled' },
);

const READ = steps({ tool: 'binder.read_tree', params: { root: 'manuscript' }, expect: 'the binder is read' });

describe('a limit is never crossed', () => {
  it('stops before sending the call whose worst case would pass the token limit, and the ledger stays under it', async () => {
    const intent = 'Read the binder three times.';
    const usage = { promptTokens: 300, completionTokens: 200 };
    const replies = [READ, READ, READ, answer('done')];
    const profile = { maxOutputTokens: 200 };

    // A first run, with no limit, learns how large each call's prompt is (it grows as the conversation does).
    const prompts: number[] = [];
    const calibration = await fixture([plannerUsing(intent, replies, usage, prompts)], { profile });
    await calibration.session.submit(intent);
    const third = prompts[2] as number;

    // The cap lets two calls settle at 500 each and refuses the third by one token: 1,000 spent + the third's prompt + 200 to write.
    const cap = 2 * 500 + third + 200 - 1;
    const f = await fixture([plannerUsing(intent, replies, usage)], { limits: { maxTokens: cap }, profile });
    const report = await f.session.submit(intent);

    expect(report.status).toBe('failed');
    expect(report.stop).toBeUndefined();
    expect(report.modelCalls).toBe(2);
    expect(report.tokens.requests).toBe(2);
    expect(report.budgetStop).toEqual({ dimension: 'tokens', limit: cap, spent: 1_000, needed: cap + 1 });
    expect(report.askBack?.code).toBe('budget_exhausted');
    expect(report.askBack?.reason).toContain('so it was not sent');
    expect(report.spend).toMatchObject({ modelCalls: 2, promptTokens: 600, completionTokens: 400, estimatedTokens: 0 });
    const ledger = f.gateway.ledger.turnTotals(report.turnId);
    expect(ledger.promptTokens + ledger.completionTokens).toBe(1_000);
    expect(ledger.promptTokens + ledger.completionTokens).toBeLessThanOrEqual(cap);
  });

  it('reports the run’s spend after each call, so a panel can show it live', async () => {
    const intent = 'Read the binder.';
    const f = await fixture([transcript(intent, [READ, answer('Read.')])], { limits: { maxTokens: 1_000_000 } });
    const report = await f.session.submit(intent);
    expect(report.status).toBe('replied');
    const budgets = f.events.flatMap((event) => (event.type === 'budget' ? [event.spend.modelCalls] : []));
    // Each call is announced once it is allowed and once it has settled.
    expect(budgets).toEqual([1, 1, 2, 2]);
    expect(report.spend?.modelCalls).toBe(2);
  });

});

describe('a cost limit needs prices', () => {
  it('is refused before any request when the profile has no prices, in the issue’s words', async () => {
    const intent = 'Read the binder.';
    const f = await fixture([transcript(intent, [answer('Hello.')])], { limits: { maxCostUsd: 1 } });
    const report = await f.session.submit(intent);
    expect(report.status).toBe('failed');
    expect(report.modelCalls).toBe(0);
    expect(report.tokens.requests).toBe(0);
    expect(report.askBack?.code).toBe('budget_exhausted');
    expect(report.askBack?.reason).toBe(
      'This run has a cost limit, and the profile “Mock” has no prices, so its cost cannot be counted. Add its prices in Settings › Providers, or use a token limit.',
    );
    expect(report.budgetStop).toMatchObject({ dimension: 'cost', unpriced: true });
  });

  it('holds a priced profile to the limit: the first call fits, the next does not', async () => {
    const intent = 'Read the binder twice.';
    const prices = { prompt: 1, completion: 1 };
    const prompts: number[] = [];
    const usage = { promptTokens: 300, completionTokens: 200 };
    const profile = { maxOutputTokens: 100, pricePer1k: prices };
    await (await fixture([plannerUsing(intent, [READ, READ, answer('done')], usage, prompts)], { profile })).session.submit(intent);
    const second = prompts[1] as number;
    // $1 per 1k tokens each way: one settled call is $0.5. The second needs $0.5 + (prompt + 100) / 1000.
    const limit = 0.5 + (second + 100) / 1_000 - 0.0001;
    const f = await fixture([plannerUsing(intent, [READ, READ, answer('done')], usage)], { limits: { maxCostUsd: limit }, profile });
    const report = await f.session.submit(intent);
    expect(report.modelCalls).toBe(1);
    expect(report.budgetStop).toMatchObject({ dimension: 'cost', limit });
    expect(report.budgetStop?.needed).toBeGreaterThan(limit);
    expect(report.spend?.costUsd).toBeCloseTo(0.5, 9);
  });
});

describe('a time limit aborts a call in flight', () => {
  it('ends a streaming draft on the deadline: no ghost, nothing written, and not a provider error or a user stop', async () => {
    const intent = 'Draft the friend.';
    const holder: { time?: ReturnType<typeof createManualClock> } = {};
    const draft: MockScript = {
      match: (req) => req.responseFormat === 'text' && userTextOf(req).includes('Open the friend.'),
      respond: () =>
        (async function* (): AsyncGenerator<ChatChunk> {
          for (const [index, piece] of ['The friend ', 'came in from ', 'the rain.'].entries()) {
            yield { delta: piece };
            // The deadline passes while the draft is streaming.
            if (index === 1) holder.time?.advance(5_000);
            await tick();
          }
          yield { finishReason: 'stop' };
        })(),
    };
    const plan = steps({ tool: 'scene.draft', params: { doc: 'The Friend', instruction: 'Open the friend.', mode: 'draft' }, expect: 'a draft' });
    const f = await fixture([transcript(intent, [plan]), draft], { limits: { deadline: 1_000_000 + 3_000 } });
    holder.time = f.time;
    const before = snapshotOf(f.state);
    const report = await f.session.submit(intent);

    expect(report.status).toBe('failed');
    expect(report.stop).toBeUndefined();
    expect(report.budgetStop?.dimension).toBe('deadline');
    expect(report.askBack?.code).toBe('budget_exhausted');
    expect(report.askBack?.reason).toContain('deadline');
    expect(report.summary).not.toContain('model call failed');
    expect(f.state.documents.get(FRIEND)?.body).toBe('');
    expect(snapshotOf(f.state)).toBe(before);
    // The draft streamed (its ghost region was emptied and fed), and none was staged: no ghost, no plan card.
    expect(f.events.filter((event) => event.type === 'draft.delta')[0]).toMatchObject({ start: true });
    expect(f.events.some((event) => event.type === 'ghost' || event.type === 'plan')).toBe(false);
    expect(f.events.flatMap((event) => (event.type === 'turn' ? [event.phase] : [])).at(-1)).toBe('failed');
    expect(f.meter.signal.aborted).toBe(true);
  });

  it('cancels an awaited coherence review when active time is used up, and the step applied before it stays restorable', async () => {
    const intent = 'Tag The Storm, then review it.';
    let sawAbort = false;
    const model: CoherenceModel = {
      model: 'limit-test',
      complete: async (request: ModelRequest) => {
        holder.time?.advance(10_000);
        sawAbort = request.signal?.aborted === true;
        throw new Error('the call was aborted');
      },
    };
    const holder: { time?: ReturnType<typeof createManualClock> } = {};
    const plan = steps(
      { tool: 'meta.set', params: { targets: [STORM], keywords_add: ['storm'] }, expect: 'The Storm is tagged' },
      { tool: 'coherence.review', params: { scope: { mode: 'doc', docIds: [STORM] } }, expect: 'the storm is reviewed' },
    );
    const f = await fixture([transcript(intent, [plan])], { limits: { maxActiveMs: 10_000 }, coherence: { model: () => model } });
    holder.time = f.time;
    const before = snapshotOf(f.state);
    const report = await f.session.submit(intent);

    expect(sawAbort).toBe(true);
    // The review absorbs the cut, as it does the writer's Stop: it reports what it had with a note. The limit is still the turn's end.
    expect(report.stop).toBeUndefined();
    expect(report.budgetStop).toEqual({ dimension: 'active-time', limit: 10_000, spent: 10_000 });
    expect(report.trace[0]).toMatchObject({ tool: 'meta.set', outcome: 'ok' });
    expect(f.state.manifest.tree.find((node) => node.id === STORM)?.keywords).toContain('storm');
    expect(report.undoGroupId).toBeDefined();
    expect(f.events.some((event) => event.type === 'checkpoint')).toBe(true);
    expect(f.session.restore(report.turnId).ok).toBe(true);
    expect(snapshotOf(f.state)).toBe(before);
  });

  it('cancels an external tool call in flight, and the server sees the cancellation', async () => {
    const key = 's_STORYB0002';
    const tool = qualifiedNameOf(key, 'search_lore');
    const server: McpServerConfig = {
      key,
      name: 'Story Bible',
      transport: 'http',
      url: 'https://s-storyb0002.fixture.test/mcp',
      auth: { kind: 'none' },
      enabled: true,
      trustReads: true,
      pinnedTools: {},
      addedAt: '2026-10-08T09:00:00.000Z',
    };
    const listed: WireTool[] = [
      {
        name: 'search_lore',
        description: 'Search the story bible for an entry.',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
        annotations: { readOnlyHint: true },
      },
    ];
    const seen: { cancelled: boolean; called: number } = { cancelled: false, called: 0 };
    const holder: { time?: ReturnType<typeof createManualClock> } = {};
    const wire: McpWire = {
      ...createMockWire({ listTools: listed, respond: () => ({ content: [], isError: false }) }),
      callTool: (_name, _args, options) =>
        new Promise((_resolve, reject) => {
          seen.called += 1;
          const cancel = (): void => {
            seen.cancelled = true;
            reject(new WireError('abort', 'the call was aborted'));
          };
          if (options.signal?.aborted === true) return cancel();
          options.signal?.addEventListener('abort', cancel, { once: true });
          // The call is slow: active time runs out while the server is still working.
          holder.time?.advance(10_000);
        }),
    };
    const client = createMcpClient({
      settings: { enabled: true, servers: [server] },
      wire: () => wire,
      probe: async () => false,
      now: () => '2026-10-08T09:00:00.000Z',
      listTimeoutMs: 2_000,
      callTimeoutMs: 60_000,
    });
    await client.connect(key);
    const card = client.review(key);
    if (card !== undefined) client.approveReview(key, card.fingerprint);

    const intent = 'Search the lore.';
    const find = steps({ tool: 'tool.search', params: { query: 'search' }, expect: 'the search tool is loaded' });
    const call = steps({ tool, params: { query: 'storm' }, expect: 'the entry is found' });
    const f = await fixture([transcript(intent, [find, call])], { limits: { maxActiveMs: 10_000 }, mcp: { client } });
    holder.time = f.time;
    const report = await f.session.submit(intent);

    expect(seen).toEqual({ cancelled: true, called: 1 });
    expect(report.status).toBe('failed');
    expect(report.budgetStop?.dimension).toBe('active-time');
    expect(report.stop).toBeUndefined();
  });

  it('does not count the time a card waits for the writer', async () => {
    const intent = 'Tag The Storm.';
    const f = await fixture(
      [transcript(intent, [TWO_STEPS])],
      // The writer takes a day to decide; the limit is ten seconds of work.
      { limits: { maxActiveMs: 10_000 }, decide: (time) => (time.advance(86_400_000), { action: 'approve' }) },
    );
    const report = await f.session.submit(intent);
    expect(report.status).toBe('applied');
    expect(report.budgetStop).toBeUndefined();
    expect(report.spend?.activeMs ?? 0).toBeLessThan(10_000);
  });

  it('lets the deadline end a turn that is waiting on a card, as a cancelled card with the limit as the reason', async () => {
    const intent = 'Tag The Storm.';
    const f = await fixture(
      [transcript(intent, [TWO_STEPS])],
      { limits: { deadline: 1_000_000 + 60_000 }, decide: (time) => new Promise<Decision>(() => time.advance(60_000)) },
    );
    const before = snapshotOf(f.state);
    const report = await f.session.submit(intent);
    expect(report.status).toBe('failed');
    expect(report.budgetStop?.dimension).toBe('deadline');
    expect(snapshotOf(f.state)).toBe(before);
  });

  it('ends a turn that starts after its deadline without making a model call', async () => {
    const intent = 'Say hello.';
    const f = await fixture([transcript(intent, [answer('Hello.')])], { limits: { deadline: 1_000_000 } });
    const report = await f.session.submit(intent);
    expect(report.status).toBe('failed');
    expect(report.budgetStop?.dimension).toBe('deadline');
    expect(report.modelCalls).toBe(0);
  });

  it('leaves the writer’s Stop as a stop, even with a meter', async () => {
    const intent = 'Say hello.';
    const f = await fixture([transcript(intent, [answer('Hello.')])], { limits: { maxActiveMs: 10_000 } });
    const stop = new AbortController();
    stop.abort();
    const report = await f.session.submit(intent, { signal: stop.signal });
    expect(report.status).toBe('cancelled');
    expect(report.stop?.by).toBe('user');
    expect(report.budgetStop).toBeUndefined();
  });
});

describe('a step limit', () => {
  it('refuses the step that would pass it before it is drafted, with a failed card and the same words to the planner', async () => {
    const intent = 'Tag and label two things.';
    const two = steps(
      { tool: 'meta.set', params: { targets: [STORM], keywords_add: ['storm'] }, expect: 'The Storm is tagged' },
      { tool: 'meta.set', params: { targets: [FRIEND], label: 'act-2' }, expect: 'The Friend is labelled' },
    );
    const one = steps({ tool: 'meta.set', params: { targets: [STORM], keywords_add: ['storm'] }, expect: 'The Storm is tagged' });
    const seen: Parameters<typeof transcript>[2] = [];
    const f = await fixture([transcript(intent, [two, one], seen)], { limits: { maxSteps: 1 } });
    const report = await f.session.submit(intent);

    const words = 'the run’s limit is 1 applied steps and 0 are used, so a plan may have 1 more write step: send a plan within that, or tell the writer the run needs a larger step limit';
    const failed = f.events.flatMap((event) => (event.type === 'card' && event.card.status === 'failed' ? [event.card] : []));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ tool: 'meta.set', error: words });
    // The planner is told the same words on its next request, and sends a plan that fits.
    const told = seen[1]?.messages.at(-1)?.content ?? '';
    expect(told).toContain(`Step 2 (meta.set) was refused: ${words}`);
    expect(report.status).toBe('applied');
    expect(f.meter.spend().steps).toBe(1);
    expect(f.meter.stepsLeft()).toBe(0);
  });

  it('refuses a later turn’s write when the run has used its steps', async () => {
    const intent = 'Tag The Storm.';
    const tag = steps({ tool: 'meta.set', params: { targets: [STORM], keywords_add: ['storm'] }, expect: 'tagged' });
    const f = await fixture([transcript(intent, [tag, answer('I cannot write any more steps.')])], { limits: { maxSteps: 1 } });
    expect((await f.session.submit(intent)).status).toBe('applied');
    const second = await f.session.submit(intent);
    expect(second.steps).toEqual([]);
    expect(f.meter.spend().steps).toBe(1);
    expect(f.events.some((event) => event.type === 'card' && event.card.status === 'failed')).toBe(true);
  });
});

describe('a session with no meter', () => {
  it('reports no spend and no limit, and keeps the model-call bound of a turn read at each turn', async () => {
    const intent = 'Read forever.';
    const state = makeState();
    const gateway = await gatewayFor([transcript(intent, [READ])]);
    let bound = 3;
    const session = createAgentSession({
      harness: createHarness({ state, ports: createAgentPorts(), clock: clock.now }),
      gateway,
      context: createContextPort({ state }),
      decide: async () => ({ action: 'approve' }),
      budget: () => ({ maxModelCalls: bound }),
      sessionId: 'nm',
    });
    const first: TurnReport = await session.submit(intent);
    expect(first.modelCalls).toBe(3);
    expect(first.spend).toBeUndefined();
    expect(first.budgetStop).toBeUndefined();
    bound = 2;
    expect((await session.submit(intent)).modelCalls).toBe(2);
  });
});
