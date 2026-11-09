/**
 * Resume (agent-harness §5.1), end to end on the mock provider: a run dropped after two of four steps, a new session on the same project
 * that resumes it, and the claims the log makes good. Nothing here needs a provider key.
 */

import { describe, expect, it } from 'vitest';

import type { ChatChunk, ChatRequest, Clock } from '@caotang/gateway';
import { createKeyStore, createManualClock, createMemoryVaultPort, createGateway, createProfileStore } from '@caotang/gateway';
import { createMockProvider, isPlannerCall, userTextOf, type MockScript } from '@caotang/gateway/mock';
import { addDocument, getBody, type ProjectState } from '@caotang/store';
import { parseSkillFolder, type SkillFile } from '@caotang/skills';

import {
  createAgentPorts,
  createAgentSession,
  createBudgetMeter,
  createContextPort,
  createHarness,
  createMemoryRunLog,
  newRunRecord,
  RUN_LOG_VERSION,
  parseRunEvents,
  planResume,
  type AgentSession,
  type Decision,
  type MemoryRunLog,
  type PendingCard,
  type PermissionMode,
  type RunEvent,
  type RunEventDraft,
  type RuleSet,
  type RunLogPort,
  type HookSpec,
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
    // Nothing from outside the project was read, though the logged conversation holds the system prompt's words about the markers.
    expect(second.cards[0]?.card.caution).toBeUndefined();
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

it('refuses a stored draft behind a pending skill load before displaying or approving its card', async () => {
  const state = makeState();
  const log = createMemoryRunLog();
  const runId = 'run_PENDING_SKILL';
  await log.create({ ...newRunRecord(runId, { projectId: PROJECT, intent: INTENT, now: 1_000 }), status: 'interrupted' });
  const drafts: RunEventDraft[] = [
    { t: 'turn.start', v: RUN_LOG_VERSION, turnId: 'old', intent: INTENT, wire: 'planner', native: false },
    { t: 'skills.loaded', turnId: 'old', skills: [] },
    { t: 'messages', turnId: 'old', appended: [{ role: 'user', content: INTENT }] },
    { t: 'card.pending', turnId: 'old', kind: 'plan', steps: [
      { tool: 'skill.load', params: { name: 'style' }, expect: 'Load the style.' },
      { tool: 'scene.draft', params: { doc: 'The Friend', instruction: 'Open.', mode: 'draft' }, expect: 'Draft the scene.' },
    ], proposals: [null, { text: 'Already drafted.', words: 2, revision: state.documents.get(FRIEND)?.revision }], revisions: [null, null], done: [] },
  ];
  await log.append(runId, drafts.map((event, seq) => ({ ...event, seq, at: 1_000 + seq }) as RunEvent));
  const resumed = await build(state, log, 'barrier', { action: 'approve' }, false);
  const report = await resumed.session.resume(runId);
  expect(report.status).toBe('failed');
  expect(report.askBack?.reason).toContain('skill.load and skill.read must finish');
  expect(resumed.cards).toEqual([]);
  expect(resumed.requests()).toBe(0);
  expect(getBody(state, FRIEND)).toBe('');
});

describe('loaded skill restrictions survive a reload', () => {
  const request = 'Load the style skill, then label the scenes.';
  const load = { tool: 'skill.load', params: { name: 'style' }, expect: 'The style is loaded.' };
  const writes = [
    { tool: 'meta.set', params: { targets: [LANDING], label: 'act-2' }, expect: 'The Landing is labelled.' },
    { tool: 'meta.set', params: { targets: [FRIEND], label: 'act-2' }, expect: 'The Friend is labelled.' },
  ];
  const files = (body = 'Read only.'): SkillFile[] => [{
    path: 'SKILL.md',
    bytes: new TextEncoder().encode(`---\nname: style\ndescription: Read-only style.\nallowed-tools: doc.read\n---\n${body}\n`),
  }];

  async function interrupted(at: 'card' | 'confirm' | 'conversation' | 'read', failure?: 'snapshot' | 'snapshot-and-marker' | 'intent') {
    const state = makeState();
    const skill = files();
    state.skills.set('style', skill);
    const pin = parseSkillFolder('style', skill).skill?.pin ?? '';
    const log = createMemoryRunLog();
    let hang = (): void => {};
    const hung = new Promise<void>((resolve) => { hang = resolve; });
    const base = await mockGateway([transcript(request, [steps(load)])]);
    let calls = 0;
    let published = false;
    const harness = createHarness({ state, ports: createAgentPorts(), skills: { reviewedPin: () => pin } });
    let loads = 0;
    const call = harness.call;
    harness.call = (tool, context) => { if (tool.name === 'skill.load') loads += 1; return call(tool, context); };
    const session = createAgentSession({
      harness,
      gateway: {
        ...base,
        complete: (req, signal) => {
          if (at === 'conversation' && calls++ === 1) {
            hang();
            return { [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }) } as never;
          }
          return base.complete(req, signal);
        },
      },
      context: createContextPort({ state }),
      decide: async () => ({ action: 'approve' }),
      emit: (event) => {
        if (event.type === 'card' && event.card.tool === 'skill.load' && event.card.status === 'done') {
          published = true;
          if (at === 'read') hang();
        }
      },
      runLog: {
        projectId: PROJECT,
        port: {
          ...log,
          append: async (runId, events, patch) => {
            if (at === 'read' && published && failure === undefined) return new Promise<void>(() => {});
            if (failure === 'intent' && events.some((event) => event.t === 'skills.loading')) throw new Error('the skill intent could not be saved');
            if (failure !== undefined && events.some((event) => event.t === 'skills.loaded' && event.skills.length > 0)) throw new Error('the skill snapshot could not be saved');
            await log.append(runId, events, patch);
            if (at === 'card' && events.some((event) => event.t === 'step.applied' && event.tool === 'skill.load')) {
              hang();
              return new Promise<void>(() => {});
            }
          },
          update: (runId, patch) => failure === 'snapshot-and-marker' && patch.cannotResume === true ? Promise.reject(new Error('the marker could not be saved')) : log.update(runId, patch),
        },
      },
    });
    const running = at === 'card' ? session.submitPlan(request, { steps: [load, ...writes] }) : at === 'confirm' ? session.submitPlan(request, { steps: [load] }) : session.submit(request);
    if (failure === undefined) await hung;
    else {
      expect((await running).status).toBe('failed');
      expect(published).toBe(false);
    }
    const [run] = await log.open(PROJECT);
    const runId = run?.runId ?? '';
    const rows = await log.events(runId) as RunEvent[];
    const replay = planResume(rows, (id) => state.documents.get(id)?.revision);
    const snapshot = [{ name: 'style', body: 'Read only.', pin, allowedTools: ['doc.read'] }];
    if (failure === 'snapshot-and-marker') {
      expect(run?.cannotResume).not.toBe(true);
      expect(replay).toMatchObject({ ok: false, reason: 'schema', detail: expect.stringContaining('no committed snapshot') });
    } else if (failure !== undefined) expect(run?.cannotResume).toBe(true);
    else expect(replay.ok && replay.replay.skills).toEqual(snapshot);
    if (failure !== undefined) expect(rows.some((event) => event.t === 'step.applied' && event.tool === 'skill.load')).toBe(false);
    if (at === 'card' && failure === undefined) {
      const appliedAt = rows.findIndex((event) => event.t === 'step.applied' && event.tool === 'skill.load');
      expect(appliedAt).toBeGreaterThan(0);
      expect(rows.slice(0, appliedAt)).toContainEqual(expect.objectContaining({ t: 'skills.loaded', skills: snapshot }));
      expect(replay.ok && replay.replay.card?.completed).toEqual([0]);
    }
    await log.update(runId, { status: 'interrupted' });
    return { state, log, runId, pin, loads };
  }

  async function resume(fixture: Awaited<ReturnType<typeof interrupted>>, mode: PermissionMode = 'auto', reviewedPin: () => string | undefined = () => fixture.pin, port: RunLogPort = fixture.log, hooks: readonly HookSpec[] = []) {
    const { state, runId } = fixture;
    const requests: ChatRequest[] = [];
    const cards: PendingCard[] = [];
    const base = await mockGateway([transcript(request, [steps(load), steps(...writes), answer('Done.')])]);
    const harness = createHarness({ state, ports: createAgentPorts(), skills: { reviewedPin }, hooks });
    const session = createAgentSession({
      harness,
      gateway: { ...base, complete: (req, signal) => { requests.push(req); return base.complete(req, signal); } },
      context: createContextPort({ state }),
      mode,
      decide: async (card) => {
        cards.push(card);
        if (cards.length === 1) return { action: 'edit', edits: [{ op: 'set', index: card.card.steps.findIndex((step) => step.status !== 'done'), path: ['params', 'targets'], value: [STORM] }] };
        return cards.length === 2 ? { action: 'approve' } : { action: 'cancel' };
      },
      runLog: { port, projectId: PROJECT },
    });
    return { report: await session.resume(runId), cards, requests, harness };
  }

  it.each(['ask', 'auto'] as const)('keeps a pending card restricted in %s mode despite edits and approval', async (mode) => {
    const fixture = await interrupted('card');
    const before = outcomeOf(fixture.state);
    const { report, cards, requests, harness } = await resume(fixture, mode);
    expect(cards).toHaveLength(3);
    expect(cards.every((card) => !card.card.approvable && card.card.steps.filter((step) => step.status !== 'done').every((step) => step.status === 'refused'))).toBe(true);
    expect(report.status).toBe('cancelled');
    expect(requests).toHaveLength(0);
    expect(harness.log.entries()).toHaveLength(0);
    expect(outcomeOf(fixture.state)).toEqual(before);
    expect(tree(fixture.state, STORM)?.label).toBeNull();
    const finished = planResume(await fixture.log.events(fixture.runId), (id) => fixture.state.documents.get(id)?.revision);
    expect(finished.replay?.skills).toEqual([{ name: 'style', body: 'Read only.', pin: fixture.pin, allowedTools: ['doc.read'] }]);
  });

  it.each(['conversation', 'read'] as const)('restores restrictions when interrupted at the %s boundary before the next request', async (at) => {
    const fixture = await interrupted(at);
    const before = outcomeOf(fixture.state);
    const { report, cards, requests, harness } = await resume(fixture);
    expect(requests).toHaveLength(at === 'read' ? 3 : 2);
    if (at === 'read') expect(report.trace[0]).toMatchObject({ tool: 'skill.load', outcome: 'refused', code: 'permission-denied' });
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain('limits this turn to: doc.read');
    expect(cards).toHaveLength(0);
    expect(report.status).toBe('replied');
    expect(harness.log.entries()).toHaveLength(0);
    expect(outcomeOf(fixture.state)).toEqual(before);
    expect(tree(fixture.state, STORM)?.label).toBeNull();
  });

  it.each([
    ['read', 'snapshot'], ['read', 'snapshot-and-marker'], ['read', 'intent'],
    ['card', 'snapshot'], ['card', 'snapshot-and-marker'], ['card', 'intent'],
    ['confirm', 'snapshot'], ['confirm', 'snapshot-and-marker'], ['confirm', 'intent'],
  ] as const)('refuses successful publication and resume on the %s path after a failed %s write', async (at, failure) => {
    const fixture = await interrupted(at, failure);
    if (at !== 'card') expect(fixture.loads).toBe(failure === 'intent' ? 0 : 1);
    const before = outcomeOf(fixture.state);
    const { report, cards, requests } = await resume(fixture);
    expect(report.status).toBe('failed');
    expect(report.askBack?.reason).toContain(failure === 'snapshot-and-marker' ? 'no committed snapshot' : 'not logged completely');
    expect(cards).toEqual([]);
    expect(requests).toEqual([]);
    expect(outcomeOf(fixture.state)).toEqual(before);
  });

  it('validates restored skills before running a turn.submit hook', async () => {
    const fixture = await interrupted('conversation');
    const hooks: HookSpec[] = [{ id: 'h_0000000001', name: 'Block submission', event: 'turn.submit', onBlock: 'block', enabled: true,
      handler: { kind: 'check', check: { kind: 'pattern', patterns: [{ match: 'Load the style skill', message: 'Do not start.' }] } } }];
    const { report, requests } = await resume(fixture, 'auto', () => undefined, fixture.log, hooks);
    expect(report.status).toBe('failed');
    expect(report.askBack?.reason).toContain('skill');
    expect(report.hooks ?? []).toEqual([]);
    expect(requests).toEqual([]);
  });

  it.each(['review', 'pin', 'missing snapshot'] as const)('refuses a changed %s without a model call or a write', async (changed) => {
    const fixture = await interrupted('conversation');
    let reviewed: string | undefined = fixture.pin;
    if (changed === 'review') reviewed = undefined;
    if (changed === 'pin') {
      const edited = files('A newly reviewed body.');
      fixture.state.skills.set('style', edited);
      reviewed = parseSkillFolder('style', edited).skill?.pin;
    }
    const port = changed === 'missing snapshot' ? {
      ...fixture.log,
      events: async (runId: string) => (await fixture.log.events(runId) as RunEvent[]).filter((event) => event.t !== 'skills.loaded'),
    } : fixture.log;
    const before = outcomeOf(fixture.state);
    const logged = await fixture.log.events(fixture.runId);
    const { report, cards, requests, harness } = await resume(fixture, 'auto', () => reviewed, port);
    expect(report.status).toBe('failed');
    expect(report.askBack?.reason).toMatch(/skill|snapshot/u);
    expect(cards).toHaveLength(0);
    expect(requests).toHaveLength(0);
    expect(harness.log.entries()).toHaveLength(0);
    expect(outcomeOf(fixture.state)).toEqual(before);
    expect(await fixture.log.events(fixture.runId)).toEqual(logged);
  });
});

describe('a log of a run whose clock and provider gave figures that are not counts', () => {
  it('still reads back: the clock stepped back and the provider reported a negative count', async () => {
    const state = makeState();
    const log = createMemoryRunLog();
    // A clock that is set back by more than the run has been going, as a corrected system time does.
    let now = 1_000_000;
    const stepped: Clock = { now: () => now, setTimeout: () => 0, clearTimeout: () => undefined };
    const meter = createBudgetMeter({}, { clock: stepped });
    now -= 5_000;
    const reporting: MockScript = {
      match: (req) => isPlannerCall(req) && userTextOf(req).includes(`Request: ${INTENT}`),
      respond: (req): AsyncIterable<ChatChunk> =>
        (async function* (): AsyncGenerator<ChatChunk> {
          const first = req.messages.filter((message) => message.role === 'assistant').length === 0;
          yield { delta: first ? steps({ tool: 'meta.set', params: { targets: [FRIEND], label: 'act-2' }, expect: 'The Friend is labelled' }) : answer('Done.') };
          yield { finishReason: 'stop', usage: { promptTokens: -5, completionTokens: Number.POSITIVE_INFINITY } };
        })(),
    };
    const dropping = dropsAtIntent(log, 0);
    const gateway = await mockGateway([reporting]);
    const harness = createHarness({ state, ports: createAgentPorts(), clock: clock.now });
    const session = createAgentSession({
      harness,
      gateway,
      context: createContextPort({ state }),
      decide: async () => ({ action: 'approve' }),
      sessionId: 'odd-figures',
      meter,
      runLog: { port: dropping.port, projectId: PROJECT },
    });
    // The tab goes as the first step is about to begin, so the log holds the card and the spend.
    void session.submit(INTENT);
    await dropping.dropped;
    const [run] = await log.open(PROJECT);
    const rows = await log.events(run?.runId ?? '');
    expect(rows.some((event) => (event as RunEvent).t === 'spend')).toBe(true);
    expect(parseRunEvents(rows)).toMatchObject({ ok: true });
    expect(run?.cannotResume).toBeUndefined();
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
