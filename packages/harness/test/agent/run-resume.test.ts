/**
 * Resume (agent-harness §5.1), end to end on the mock provider: a run dropped after two of four steps, a new session on the same project
 * that resumes it, and the claims the log makes good. Nothing here needs a provider key.
 */

import { describe, expect, it } from 'vitest';

import type { ChatRequest } from '@caotang/gateway';
import { createKeyStore, createManualClock, createMemoryVaultPort, createGateway, createProfileStore } from '@caotang/gateway';
import { createMockProvider } from '@caotang/gateway/mock';
import { addDocument, getBody, type ProjectState } from '@caotang/store';

import {
  createAgentPorts,
  createAgentSession,
  createContextPort,
  createHarness,
  createMemoryRunLog,
  newRunRecord,
  planResume,
  type AgentSession,
  type Decision,
  type MemoryRunLog,
  type PendingCard,
  type RunEvent,
  type RuleSet,
  type RunLogPort,
} from '../../src/index.js';
import { FRIEND, LANDING, STORM, clock, makeState } from '../fixtures.js';
import { mockGateway } from './gateway.js';
import { answer, prose, steps, transcript } from './scripts.js';

const INTENT = 'Label the friend, extend the landing, tag the storm and open the friend.';
const PROJECT = 'p_RESUMETEST';

const PLAN = steps(
  { tool: 'meta.set', params: { targets: [FRIEND], label: 'act-2' }, expect: 'The Friend is labelled' },
  { tool: 'scene.draft', params: { doc: 'The Landing', instruction: 'Add a line.', mode: 'continue' }, expect: 'The Landing is longer' },
  { tool: 'meta.set', params: { targets: [STORM], keywords_add: ['storm'] }, expect: 'The Storm is tagged' },
  { tool: 'scene.draft', params: { doc: 'The Friend', instruction: 'Open the friend.', mode: 'draft' }, expect: 'The Friend has an opening' },
);

const scripts = () => [transcript(INTENT, [PLAN, answer('All four are done.')]), prose('Brief: Add a line.', 'She added a line.'), prose('Brief: Open the friend.', 'The friend arrived.')];

/** The port with an append that never settles once it is asked to write the intent of step `index`: the tab is gone at that moment. */
function dropsAtIntent(port: MemoryRunLog, index: number): { readonly port: RunLogPort; readonly dropped: Promise<void> } {
  let drop = (): void => {};
  const dropped = new Promise<void>((resolve) => {
    drop = resolve;
  });
  return {
    dropped,
    port: {
      ...port,
      append: (runId: string, events: readonly RunEvent[], patch) => {
        if (events.some((event) => event.t === 'step.intent' && event.index === index)) {
          drop();
          return new Promise<void>(() => {});
        }
        return port.append(runId, events, patch);
      },
    },
  };
}

interface Built {
  readonly session: AgentSession;
  readonly harness: ReturnType<typeof createHarness>;
  readonly cards: PendingCard[];
  readonly requests: () => number;
}

async function build(state: ProjectState, port: RunLogPort, sessionId: string, decision: Decision = { action: 'approve' }, withScripts = true): Promise<Built> {
  const gateway = await mockGateway(withScripts ? scripts() : []);
  const harness = createHarness({ state, ports: createAgentPorts(), clock: clock.now });
  const cards: PendingCard[] = [];
  const session = createAgentSession({
    harness,
    gateway,
    context: createContextPort({ state }),
    decide: async (card) => {
      cards.push(card);
      return decision;
    },
    sessionId,
    runLog: { port, projectId: PROJECT },
  });
  return { session, harness, cards, requests: () => gateway.ledger.turnTotals(`${sessionId}.turn-1`).requests };
}

let seen: ChatRequest[] = [];

const tree = (state: ProjectState, id: string) => state.manifest.tree.find((node) => node.id === id);

/** What a finished project holds that the plan touched. */
const outcomeOf = (state: ProjectState) => ({
  landing: getBody(state, LANDING),
  friend: getBody(state, FRIEND),
  label: tree(state, FRIEND)?.label,
  keywords: tree(state, STORM)?.keywords,
});

describe('resuming a run dropped after step 2 of 4', () => {
  it('applies steps 3 and 4 only, hands the bus no call id twice, and ends where an uninterrupted run ends', async () => {
    // The uninterrupted run, for comparison.
    const whole = makeState();
    const one = await build(whole, createMemoryRunLog(), 'whole');
    expect((await one.session.submit(INTENT)).status).toBe('applied');
    expect(one.cards).toHaveLength(1);

    // The run that is dropped: the tab goes as step 3 is about to begin.
    const state = makeState();
    const log = createMemoryRunLog();
    const dropping = dropsAtIntent(log, 2);
    const first = await build(state, dropping.port, 'first');
    void first.session.submit(INTENT);
    await dropping.dropped;
    expect(tree(state, FRIEND)?.label).toBe('act-2');
    expect(tree(state, STORM)?.keywords).not.toContain('storm');
    const [run] = await log.open(PROJECT);
    expect(run?.status).toBe('running');
    // The lease says nobody runs it any more.
    await log.update(run?.runId ?? '', { status: 'interrupted' });

    // A new session on the project as it stands, with no scripts: resuming a card makes no model call.
    const second = await build(state, log, 'second', { action: 'approve' }, false);
    const report = await second.session.resume(run?.runId ?? '');

    expect(report.status).toBe('applied');
    expect(report.tokens.requests).toBe(0);
    expect(second.requests()).toBe(0);
    // The card came back with the two applied steps done and the other two to run.
    expect(second.cards).toHaveLength(1);
    expect(second.cards[0]?.card.steps.map((step) => step.status)).toEqual(['done', 'done', 'ready', 'ready']);
    expect(second.cards[0]?.card.approvable).toBe(true);
    // The four steps are in the project once each, and the project is what an uninterrupted run left.
    expect(getBody(state, LANDING).split('She added a line.')).toHaveLength(2);
    expect(outcomeOf(state)).toEqual(outcomeOf(whole));
    // The resumed turn's trace names the two steps it applied and the two the log carried; no bus call id repeats across the two sessions.
    const ids = [...first.harness.log.entries(), ...second.harness.log.entries()].flatMap((entry) => (entry.callId === undefined ? [] : [entry.callId]));
    expect(new Set(ids).size).toBe(ids.length);
    expect(second.harness.log.entries().filter((entry) => entry.issuedBy === 'agent')).toHaveLength(2);
    // The log says how it ended.
    expect((await log.open(PROJECT)).length).toBe(0);
    const events = (await log.events(run?.runId ?? '')) as RunEvent[];
    expect(events.at(-1)).toMatchObject({ t: 'turn.end', status: 'applied' });
    expect(events.filter((event) => event.t === 'turn.start')).toHaveLength(2);
  });

  it('shows the card with the draft marked out of date when the writer changed the scene while the run was down, and applies nothing until it is retried', async () => {
    const state = makeState();
    const log = createMemoryRunLog();
    const dropping = dropsAtIntent(log, 2);
    const first = await build(state, dropping.port, 'first');
    void first.session.submit(INTENT);
    await dropping.dropped;
    const [run] = await log.open(PROJECT);
    // The writer edits The Friend, whose draft is still to run.
    const record = state.documents.get(FRIEND);
    if (record === undefined) throw new Error('fixture');
    record.body = 'The writer got there first.';
    record.revision += 1;

    const second = await build(state, log, 'second', { action: 'cancel' }, false);
    const report = await second.session.resume(run?.runId ?? '');
    expect(second.cards[0]?.card.approvable).toBe(false);
    expect(second.cards[0]?.card.steps[3]?.stale).toBe(true);
    expect(second.cards[0]?.card.notice).toContain('out of date');
    expect(report.status).toBe('cancelled');
    expect(getBody(state, FRIEND)).toBe('The writer got there first.');
    expect(tree(state, STORM)?.keywords).not.toContain('storm');
  });

  it('is held to the rules in force when it resumes, not the rules it began under', async () => {
    const state = makeState();
    const log = createMemoryRunLog();
    const dropping = dropsAtIntent(log, 2);
    const first = await build(state, dropping.port, 'first');
    void first.session.submit(INTENT);
    await dropping.dropped;
    const [run] = await log.open(PROJECT);

    const gateway = await mockGateway([]);
    const harness = createHarness({
      state,
      ports: createAgentPorts(),
      clock: clock.now,
      rules: () => ({ rules: [{ effect: 'deny', tool: 'meta.set', source: 'project' }] }),
    });
    const cards: PendingCard[] = [];
    const session = createAgentSession({
      harness,
      gateway,
      context: createContextPort({ state }),
      decide: async (card) => {
        cards.push(card);
        return { action: 'approve' };
      },
      sessionId: 'rules',
      runLog: { port: log, projectId: PROJECT },
    });
    const report = await session.resume(run?.runId ?? '');
    // The denied step is refused on the card, so the card cannot be approved, and the project keeps its two applied steps and gains nothing.
    expect(cards[0]?.card.approvable).toBe(false);
    expect(report.status).not.toBe('applied');
    expect(tree(state, STORM)?.keywords).not.toContain('storm');
  });
  it.each(['cancelled', 'refused'] as const)('ends without a step or a model call when the log records the card as %s before the run stopped', async (decision) => {
    const state = makeState();
    const log = createMemoryRunLog();
    const dropping = dropsAtIntent(log, 2);
    const first = await build(state, dropping.port, 'first');
    void first.session.submit(INTENT);
    await dropping.dropped;
    const [run] = await log.open(PROJECT);
    const runId = run?.runId ?? '';
    // The writer decided the card, and the tab went before the turn closed: the log's last word on the card is the decision.
    const rows = (await log.events(runId)) as RunEvent[];
    await log.append(runId, [{ t: 'card.decided', turnId: 'x', decision, seq: (rows.at(-1)?.seq ?? 0) + 1, at: 9_999 } as unknown as RunEvent]);
    const before = outcomeOf(state);

    const second = await build(state, log, 'second', { action: 'approve' }, false);
    const report = await second.session.resume(runId);

    expect(report.status).toBe('cancelled');
    // The card is not shown again, no model is asked, and the two steps applied before the stop are all the project holds.
    expect(second.cards).toHaveLength(0);
    expect(second.requests()).toBe(0);
    expect(report.tokens.requests).toBe(0);
    expect(outcomeOf(state)).toEqual(before);
    expect(tree(state, FRIEND)?.label).toBe('act-2');
    expect(tree(state, STORM)?.keywords).not.toContain('storm');
    expect(second.harness.log.entries().filter((entry) => entry.issuedBy === 'agent')).toHaveLength(0);
  });
});

describe('resuming refuses what it cannot make safe', () => {
  it('names the document and applies nothing when a write the log records did not reach the project', async () => {
    const state = makeState();
    const log = createMemoryRunLog();
    const dropping = dropsAtIntent(log, 2);
    const first = await build(state, dropping.port, 'first');
    void first.session.submit(INTENT);
    await dropping.dropped;
    const [run] = await log.open(PROJECT);
    // The project as the store held it when the tab went: the scene's save never landed.
    const reloaded = makeState();
    const second = await build(reloaded, log, 'second', { action: 'approve' }, false);
    const report = await second.session.resume(run?.runId ?? '');
    expect(report.status).toBe('failed');
    expect(report.askBack?.reason).toContain('The Landing');
    expect(report.askBack?.code).toBe('conflict');
    expect(second.cards).toHaveLength(0);
    // The run is left as it was, for the writer to discard.
    expect((await log.open(PROJECT)).map((entry) => entry.runId)).toEqual([run?.runId]);
  });

  it('re-issues the planner call of a run cut off while the model was being asked, from the logged conversation, and counts the lost call as spent', async () => {
    const state = makeState();
    const log = createMemoryRunLog();
    // The tab goes while the first planner request is out: the request and its reservation are on record, the reply never comes.
    let hang = (): void => {};
    const hung = new Promise<void>((resolve) => {
      hang = resolve;
    });
    const base = await mockGateway([]);
    const stuck = {
      ...base,
      complete: () => {
        hang();
        return { [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }) } as never;
      },
    };
    const firstHarness = createHarness({ state, ports: createAgentPorts(), clock: clock.now });
    const firstSession = createAgentSession({ harness: firstHarness, gateway: stuck, context: createContextPort({ state }), decide: async () => ({ action: 'approve' }), sessionId: 'first', runLog: { port: log, projectId: PROJECT } });
    void firstSession.submit(INTENT);
    await hung;
    const [run] = await log.open(PROJECT);
    expect(planResume(await log.events(run?.runId ?? ''), () => 0)).toMatchObject({ ok: true, kind: 'clean' });

    const seen: ChatRequest[] = [];
    const gateway = await mockGateway([transcript(INTENT, [answer('Nothing had been done yet, so here is where things stand.')], seen)]);
    const harness = createHarness({ state, ports: createAgentPorts(), clock: clock.now });
    const session = createAgentSession({ harness, gateway, context: createContextPort({ state }), decide: async () => ({ action: 'cancel' }), sessionId: 'between', runLog: { port: log, projectId: PROJECT } });
    const report = await session.resume(run?.runId ?? '');
    expect(report.status).toBe('replied');
    // The conversation the model is sent is the one the log holds: the first request, then nothing else.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.messages.at(-1)?.content).toContain(INTENT);
    // The call the first session lost counts as spent beside the one this resume made, so a run's model-call bound stays honest.
    expect(report.modelCalls).toBe(2);
    expect((await log.open(PROJECT)).length).toBe(0);
  });

  it('tells the model, on a resume between cards, that its last reply was never acted on', async () => {
    const state = makeState();
    const log = createMemoryRunLog();
    // The tab goes as the first card is about to be written: the planner has replied with the plan, and no card was shown.
    let hang = (): void => {};
    const hung = new Promise<void>((resolve) => {
      hang = resolve;
    });
    const port: RunLogPort = {
      ...log,
      append: (runId, events, patch) => {
        if (events.some((event) => event.t === 'card.pending')) {
          hang();
          return new Promise<void>(() => {});
        }
        return log.append(runId, events, patch);
      },
    };
    const first = await build(state, port, 'first');
    void first.session.submit(INTENT);
    await hung;
    const [run] = await log.open(PROJECT);
    // The card was never written, so the log's last message is the plan the model sent.
    const gateway = await mockGateway([transcript(INTENT, [PLAN, answer('Understood, nothing has been applied.')], (seen = []))]);
    const harness = createHarness({ state, ports: createAgentPorts(), clock: clock.now });
    const session = createAgentSession({ harness, gateway, context: createContextPort({ state }), decide: async () => ({ action: 'cancel' }), sessionId: 'between-cards', runLog: { port: log, projectId: PROJECT } });
    await session.resume(run?.runId ?? '');
    const last = seen.at(-1)?.messages.at(-1);
    expect(last?.role).toBe('user');
    expect(last?.content).toContain('nothing in it ran');
    expect(seen.at(-1)?.messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
  });
});

describe('a run resumed between cards is held to the read rules in force when it resumes', () => {
  // A document the plan does not touch, so the run still reaches its card with the rule in force.
  const SECRET = 'n_SECRETDOC1';
  const HIDE_SECRET: RuleSet = { rules: [{ effect: 'deny', tool: '*', scope: { subtree: SECRET }, access: 'read', source: 'project' }] };
  const stateWithSecret = (): ProjectState => {
    const state = makeState();
    addDocument(state, { parentId: 'manuscript', title: 'Secret Draft', now: new Date('2026-10-08T09:00:00.000Z'), id: SECRET, synopsis: 'Who really owns the lamp.' });
    return state;
  };

  /** A run dropped as its first card is about to be written, under `rules`: the logged conversation is the planner's prompt and its plan. */
  async function droppedBetweenCards(state: ProjectState, log: MemoryRunLog, rules: RuleSet) {
    let hang = (): void => {};
    const hung = new Promise<void>((resolve) => {
      hang = resolve;
    });
    const port: RunLogPort = {
      ...log,
      append: (runId, events, patch) => {
        if (events.some((event) => event.t === 'card.pending')) {
          hang();
          return new Promise<void>(() => {});
        }
        return log.append(runId, events, patch);
      },
    };
    const gateway = await mockGateway(scripts());
    const harness = createHarness({ state, ports: createAgentPorts(), clock: clock.now, rules: () => rules });
    const session = createAgentSession({ harness, gateway, decide: async () => ({ action: 'approve' }), sessionId: 'dropped', runLog: { port, projectId: PROJECT } });
    void session.submit(INTENT);
    await hung;
    const [run] = await log.open(PROJECT);
    return run?.runId ?? '';
  }

  async function resumeUnder(state: ProjectState, log: MemoryRunLog, runId: string, rules: RuleSet) {
    const requests: ChatRequest[] = [];
    const gateway = await mockGateway([transcript(INTENT, [answer('Understood, nothing has been applied.')], requests)]);
    const harness = createHarness({ state, ports: createAgentPorts(), clock: clock.now, rules: () => rules });
    const session = createAgentSession({ harness, gateway, decide: async () => ({ action: 'cancel' }), sessionId: 'resumed', runLog: { port: log, projectId: PROJECT } });
    return { report: await session.resume(runId), requests };
  }

  it('sends nothing to the provider, and names nothing it withholds, when a rule was added after the run began', async () => {
    const state = stateWithSecret();
    const log = createMemoryRunLog();
    const runId = await droppedBetweenCards(state, log, { rules: [] });
    // The logged first request holds the project as it was shown then, the secret document among it.
    expect(JSON.stringify(await log.events(runId))).toContain('Secret Draft');

    const { report, requests } = await resumeUnder(state, log, runId, HIDE_SECRET);
    expect(report.status).toBe('failed');
    expect(report.askBack?.reason).toContain('a rule now keeps part of the project from the agent');
    expect(JSON.stringify(report)).not.toContain('Secret Draft');
    expect(requests).toHaveLength(0);
    // The run stays on the list, for the writer to discard or to resume once the rule is gone.
    expect((await log.open(PROJECT)).map((entry) => entry.runId)).toEqual([runId]);
  });

  it('resumes when the rule was already in force, and the request carries none of what it withholds', async () => {
    const state = stateWithSecret();
    const log = createMemoryRunLog();
    const runId = await droppedBetweenCards(state, log, HIDE_SECRET);
    const dump = JSON.stringify(await log.events(runId));
    expect(dump).not.toContain('Secret Draft');

    const { report, requests } = await resumeUnder(state, log, runId, HIDE_SECRET);
    expect(report.status).toBe('replied');
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests)).not.toContain('Secret Draft');
  });

  it('resumes when the rule was lifted since the run began', async () => {
    const state = stateWithSecret();
    const log = createMemoryRunLog();
    const runId = await droppedBetweenCards(state, log, HIDE_SECRET);
    const { report } = await resumeUnder(state, log, runId, { rules: [] });
    expect(report.status).toBe('replied');
  });
});

describe('a log that cannot be written', () => {
  it('says why when the run cannot be logged from its first write', async () => {
    const state = makeState();
    const log = createMemoryRunLog();
    const notices: string[] = [];
    const gateway = await mockGateway(scripts());
    const harness = createHarness({ state, ports: createAgentPorts(), clock: clock.now });
    const session = createAgentSession({
      harness,
      gateway,
      context: createContextPort({ state }),
      decide: async () => ({ action: 'approve' }),
      sessionId: 'never-opened',
      runLog: {
        port: {
          ...log,
          create: async () => {
            throw new Error('the quota is full');
          },
        },
        projectId: PROJECT,
        onNotice: (message) => notices.push(message),
      },
    });
    const report = await session.submit(INTENT);
    expect(report.status).toBe('applied');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('the quota is full');
  });

  it('does not stop the turn: the writer is told once, and the run is not offered for resume', async () => {
    const state = makeState();
    const log = createMemoryRunLog();
    const notices: string[] = [];
    const gateway = await mockGateway(scripts());
    const harness = createHarness({ state, ports: createAgentPorts(), clock: clock.now });
    const session = createAgentSession({
      harness,
      gateway,
      context: createContextPort({ state }),
      decide: async () => ({ action: 'approve' }),
      sessionId: 'broken',
      runLog: { port: log, projectId: PROJECT, onNotice: (message) => notices.push(message) },
    });
    // The turn.start append is the first; the next one fails as a full store would.
    const pending = session.submit(INTENT);
    log.failNextAppend();
    const report = await pending;
    expect(report.status).toBe('applied');
    expect(getBody(state, FRIEND)).toBe('The friend arrived.');
    expect(notices).toHaveLength(1);
    const [run] = await log.open(PROJECT);
    expect(run).toMatchObject({ cannotResume: true });
    expect(await log.events(run?.runId ?? '')).toEqual([]);
  });
});

describe('the log holds no secret', () => {
  it('stores no key and no header value for a profile that has them', async () => {
    const MARKER_KEY = 'sk-MARKERKEYMARKERKEYMARKER0123456789';
    const MARKER_HEADER = 'x-marker-header-value-0123456789';
    const keys = createKeyStore(createMemoryVaultPort());
    const profiles = createProfileStore({ keys });
    await profiles.create({ name: 'Mock', kind: 'mock', isActive: true });
    await profiles.create({
      name: 'Keyed',
      kind: 'endpoint',
      preset: 'generic',
      baseUrl: 'https://models.example.test/v1',
      apiKey: MARKER_KEY,
      defaultModel: 'marker-model',
      customHeaders: { 'X-Marker': MARKER_HEADER },
    });
    const gateway = createGateway({ profiles, keys, clock: createManualClock(0), mock: createMockProvider({ scripts: scripts() }) });
    const state = makeState();
    const log = createMemoryRunLog();
    const harness = createHarness({ state, ports: createAgentPorts(), clock: clock.now });
    const session = createAgentSession({ harness, gateway, context: createContextPort({ state }), decide: async () => ({ action: 'approve' }), sessionId: 'secret', runLog: { port: log, projectId: PROJECT } });
    await session.submit(INTENT);
    const stored = log.dump();
    expect(stored.length).toBeGreaterThan(500);
    for (const secret of [MARKER_KEY, MARKER_HEADER, 'X-Marker', 'authorization', 'Bearer ']) expect(stored.toLowerCase()).not.toContain(secret.toLowerCase());
    void newRunRecord;
  });
});
