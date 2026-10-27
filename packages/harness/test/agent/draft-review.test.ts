/**
 * The draft review on the real session, the real bus and the mock provider (agent-harness §8, "Draft review"): it reads and never writes, it
 * counts against the turn's calls and run limits, a read rule keeps a withheld document out of the critic's prompt, a draft is the writer's
 * to read whatever the review did, and the writer's Skip review reaches the review's own call and not the turn.
 */

import { describe, expect, it } from 'vitest';

import { createGateway, createKeyStore, createManualClock, createMemoryVaultPort, createProfileStore, type ChatRequest, type Gateway } from '@caotang/gateway';
import { createMockProvider, criticScript, userTextOf, type MockScript } from '@caotang/gateway/mock';
import type { DeterministicCheckId } from '@caotang/coherence';
import { getBody, getRevision, type ProjectState } from '@caotang/store';

import {
  createAgentPorts,
  createAgentSession,
  createBudgetMeter,
  createContextPort,
  createHarness,
  REVIEW_CALL_NOTE,
  type AgentEvent,
  type AgentSession,
  type Decision,
  type Harness,
  type HookSpec,
  type RuleSet,
  type SourcedRule,
  type TurnReport,
} from '../../src/index.js';
import { CHAPTER_ONE, ENTRY_TWO, FRIEND, clock, makeState } from '../fixtures.js';
import { mockGateway } from './gateway.js';
import { prose, steps, transcript } from './scripts.js';

const INTENT = 'Draft the opening of The Friend.';
const DRAFT = 'The ferry came in on the evening tide. Elena was not on it.';
const NOTE = { category: 'brief', severity: 'medium', quote: 'Elena was not on it.', note: 'The brief says the friend brings news of Elena.' };
const CRITIQUE = JSON.stringify({ notes: [NOTE] });

const planner = transcript(INTENT, [steps({ tool: 'scene.draft', params: { doc: 'The Friend', instruction: 'Open the friend.', mode: 'draft' }, expect: 'The Friend is drafted' })]);
const drafter = prose('Brief: Open the friend.', DRAFT);
const critic = (reply: string): MockScript => criticScript((req) => (userTextOf(req).includes(DRAFT) ? reply : undefined));

function project(): ProjectState {
  const state = makeState();
  state.coherence = { formatVersion: 1, findings: [], runs: [], sceneMeta: { [FRIEND]: { expectedPresent: [ENTRY_TWO] } }, worldRules: [], knowledge: [], reviewState: {} };
  return state;
}

interface Fixture {
  readonly session: AgentSession;
  readonly harness: Harness;
  readonly state: ProjectState;
  readonly events: AgentEvent[];
  readonly requests: ChatRequest[];
}

/** A gateway whose active profile caps a reply at 300 tokens, so a call reserves its prompt and 300 and a run limit can be set between calls. */
async function cappedGateway(scripts: readonly MockScript[]): Promise<Gateway> {
  const keys = createKeyStore(createMemoryVaultPort());
  const profiles = createProfileStore({ keys });
  await profiles.create({ name: 'Mock', kind: 'mock', isActive: true, maxOutputTokens: 300 });
  return createGateway({ profiles, keys, clock: createManualClock(0), mock: createMockProvider({ scripts: [...scripts] }) });
}

interface FixtureOptions {
  readonly capped?: boolean;
  readonly hooks?: readonly HookSpec[];
  readonly review?: boolean;
  readonly reviewChecks?: () => readonly DeterministicCheckId[] | undefined;
  readonly rules?: readonly SourcedRule[];
  readonly decide?: (events: readonly AgentEvent[]) => Decision;
  readonly onEvent?: (event: AgentEvent, session: AgentSession | undefined) => void;
  readonly meter?: ReturnType<typeof createBudgetMeter>;
  readonly maxModelCalls?: number;
  readonly signal?: AbortSignal;
}

async function fixture(scripts: readonly MockScript[], options: FixtureOptions = {}): Promise<Fixture & { readonly submit: () => Promise<TurnReport> }> {
  const state = project();
  const set: RuleSet = { rules: options.rules ?? [] };
  const harness = createHarness({ state, ports: createAgentPorts(), clock: clock.now, rules: () => set, ...(options.hooks === undefined ? {} : { hooks: options.hooks }) });
  const base = options.capped === true ? await cappedGateway(scripts) : await mockGateway(scripts);
  const requests: ChatRequest[] = [];
  const gateway = {
    ...base,
    complete: (request: Parameters<typeof base.complete>[0], signal?: AbortSignal) => {
      requests.push(request as ChatRequest);
      return base.complete(request, signal);
    },
  };
  const events: AgentEvent[] = [];
  const held: { session?: AgentSession } = {};
  const session = createAgentSession({
    harness,
    gateway,
    context: createContextPort({ state, withheld: (tool) => harness.withheld(tool) }),
    decide: async () => options.decide?.(events) ?? { action: 'approve' },
    emit: (event) => {
      events.push(event);
      options.onEvent?.(event, held.session);
    },
    sessionId: 'review',
    ...(options.review === undefined ? {} : { review: options.review }),
    ...(options.reviewChecks === undefined ? {} : { reviewChecks: options.reviewChecks }),
    ...(options.meter === undefined ? {} : { meter: options.meter }),
    ...(options.maxModelCalls === undefined ? {} : { maxModelCalls: options.maxModelCalls }),
  });
  held.session = session;
  return { session, harness, state, events, requests, submit: () => session.submit(INTENT, options.signal === undefined ? {} : { signal: options.signal }) };
}

const reviews = (events: readonly AgentEvent[]) => events.flatMap((event) => (event.type === 'review' ? [event] : []));

describe('a review reads and never writes', () => {
  it('leaves every revision, the coherence file, the activity log and the bytes of the project as they were when the writer cancels the card', async () => {
    const run = await fixture([planner, drafter, critic(CRITIQUE)], { review: true, decide: () => ({ action: 'cancel' }) });
    const before = {
      revisions: [...run.state.documents.keys()].map((id) => [id, getRevision(run.state, id), getBody(run.state, id)]),
      file: JSON.stringify(run.state.coherence),
      log: JSON.stringify(run.harness.log.entries()),
      manifest: JSON.stringify(run.state.manifest),
    };
    const report = await run.submit();
    expect(report.status).toBe('cancelled');
    expect(reviews(run.events)).toHaveLength(1);
    expect(reviews(run.events)[0]?.critique?.notes).toHaveLength(1);
    expect(reviews(run.events)[0]?.continuity?.introduced).toHaveLength(1);
    expect({
      revisions: [...run.state.documents.keys()].map((id) => [id, getRevision(run.state, id), getBody(run.state, id)]),
      file: JSON.stringify(run.state.coherence),
      log: JSON.stringify(run.harness.log.entries()),
      manifest: JSON.stringify(run.state.manifest),
    }).toEqual(before);
    expect(run.harness.log.entries()).toEqual([]);
  });

  it('dispatches nothing of its own: the one write of the turn is the draft’s apply, in one undo group', async () => {
    const run = await fixture([planner, drafter, critic(CRITIQUE)], { review: true });
    const report = await run.submit();
    expect(report.status).toBe('applied');
    expect(run.harness.log.entries()).toHaveLength(1);
    expect(getBody(run.state, FRIEND)).toBe(DRAFT);
    expect(report.undoGroupId).toBeDefined();
  });
});

describe('a review counts', () => {
  it('against the turn’s model-call bound: the critic is a call, and a draft retried is reviewed again', async () => {
    let retried = false;
    const run = await fixture([planner, drafter, critic(CRITIQUE)], {
      review: true,
      decide: () => {
        if (retried) return { action: 'approve' };
        retried = true;
        return { action: 'retry' };
      },
    });
    const report = await run.submit();
    // planner, draft, critic, draft again, critic again
    expect(report.modelCalls).toBe(5);
    expect(reviews(run.events)).toHaveLength(2);
    expect(run.requests.filter((request) => request.role === 'background')).toHaveLength(2);
  });

  it('and says so on the plan card: "plus up to 1 review call" on a scene draft with the review on, and nothing with it off', async () => {
    const stepOf = (events: readonly AgentEvent[]) => events.flatMap((event) => (event.type === 'plan' ? event.card.steps : []))[0];
    const on = await fixture([planner, drafter, critic(CRITIQUE)], { review: true });
    await on.submit();
    expect(stepOf(on.events)?.review).toBe(REVIEW_CALL_NOTE);
    expect(REVIEW_CALL_NOTE).toBe('plus up to 1 review call');
    const off = await fixture([planner, drafter, critic(CRITIQUE)], { review: false });
    await off.submit();
    expect(stepOf(off.events)).not.toHaveProperty('review');
  });

  it('against a run limit: a critic call the meter would refuse is skipped with a notice, and the draft is shown', async () => {
    // The planner and the draft spend 5,197 tokens on this fixture; the critic's reservation (its prompt and 300) would pass 5,600.
    const run = await fixture([planner, drafter, critic(CRITIQUE)], { review: true, capped: true, meter: createBudgetMeter({ maxTokens: 5_600 }) });
    const report = await run.submit();
    expect(report.status).toBe('applied');
    expect(run.requests.filter((request) => request.role === 'background')).toEqual([]);
    const [review] = reviews(run.events);
    expect(review?.notices).toEqual([{ key: 'critic.budget', message: 'The review was skipped: its call would have passed a limit of this run.' }]);
    expect(getBody(run.state, FRIEND)).toBe(DRAFT);
  });

  it('as a call the meter allows: the same turn with room for it reviews', async () => {
    const run = await fixture([planner, drafter, critic(CRITIQUE)], { review: true, capped: true, meter: createBudgetMeter({ maxTokens: 20_000 }) });
    await run.submit();
    expect(reviews(run.events)[0]?.critique?.notes).toHaveLength(1);
    expect(run.events.filter((event) => event.type === 'budget').length).toBeGreaterThan(0);
  });
});

describe('a review does not go around a hook', () => {
  const blocking: HookSpec = {
    id: 'h_0000000001',
    name: 'No ferries',
    event: 'tool.before',
    matcher: { tools: ['scene.draft'] },
    handler: { kind: 'check', check: { kind: 'pattern', patterns: [{ match: 'ferry', message: 'Not the ferry again.' }] } },
    enabled: true,
    onBlock: 'block',
  };

  it('still blocks the step its words match: the review is shown, the card cannot be approved, and nothing is written', async () => {
    const run = await fixture([planner, drafter, critic(CRITIQUE)], { review: true, hooks: [blocking], decide: () => ({ action: 'cancel' }) });
    const report = await run.submit();
    const [review] = reviews(run.events);
    expect(review?.critique?.notes).toHaveLength(1);
    const step = run.events.flatMap((event) => (event.type === 'plan' ? event.card.steps : []))[0];
    expect(step?.status).toBe('refused');
    expect(step?.error?.details?.['askBackCode']).toBe('hook_blocked');
    expect(report.trace.some((entry) => entry.tool === 'scene.draft' && entry.outcome === 'ok')).toBe(false);
    expect(getBody(run.state, FRIEND)).toBe('');
    expect(run.harness.log.entries()).toEqual([]);
  });
});

describe('a read rule', () => {
  const rules: SourcedRule[] = [{ effect: 'deny', tool: '*', source: 'project', scope: { subtree: CHAPTER_ONE }, access: 'read' }];

  it('keeps a withheld document out of the critic’s prompt, as it does out of the draft’s', async () => {
    const withheld = await fixture([planner, drafter, critic(CRITIQUE)], { review: true, rules });
    await withheld.submit();
    const open = await fixture([planner, drafter, critic(CRITIQUE)], { review: true });
    await open.submit();
    const criticText = (run: { readonly requests: readonly ChatRequest[] }): string => run.requests.filter((request) => request.role === 'background').map((request) => request.messages.map((message) => message.content).join('\n')).join('\n');
    const draftText = (run: { readonly requests: readonly ChatRequest[] }): string => run.requests.filter((request) => request.responseFormat === 'text').map((request) => request.messages.map((message) => message.content).join('\n')).join('\n');
    // The project layer counts the documents the model may read: Chapter 1's two are withheld from the critic, as from the draft.
    expect(criticText(open)).toContain('Documents: 3.');
    expect(criticText(withheld)).toContain('Documents: 1.');
    expect(draftText(withheld)).toContain('Documents: 1.');
    expect(criticText(withheld)).not.toContain('Documents: 3.');
  });
});

describe('a draft is the writer’s to read whatever the review did', () => {
  it('shows the draft with a notice when the critic’s call fails', async () => {
    const failing: MockScript = criticScript(() => undefined);
    const broken: MockScript = { match: (req) => req.messages[0]?.content.startsWith('You are a critic') === true, respond: () => ({ content: '', error: { kind: 'provider', status: 500, message: 'the provider is down' } }) };
    const run = await fixture([planner, drafter, failing, broken], { review: true });
    const report = await run.submit();
    expect(report.status).toBe('applied');
    const [review] = reviews(run.events);
    expect(review?.critique).toBeUndefined();
    expect(review?.notices).toHaveLength(1);
    expect(review?.notices[0]?.key).toBe('critic.call');
    expect(review?.notices[0]?.message).toContain('the provider is down');
    expect(getBody(run.state, FRIEND)).toBe(DRAFT);
  });

  it('says nothing was checked, not that nothing was found, when no continuity check is turned on or runnable', async () => {
    for (const checks of [[], ['medium.speaker-parity', 'codex.never-mentioned']] as const) {
      const run = await fixture([planner, drafter, critic(CRITIQUE)], { review: true, reviewChecks: () => checks });
      expect((await run.submit()).status).toBe('applied');
      const [review] = reviews(run.events);
      expect(review?.continuity).toBeUndefined();
      expect(review?.notices.map((notice) => notice.key)).toEqual(['continuity.skipped']);
      expect(review?.critique?.notes).toHaveLength(1);
    }
  });

  it('reports a clean continuity pass when a runnable check ran and found nothing', async () => {
    const run = await fixture([planner, drafter, critic(CRITIQUE)], { review: true, reviewChecks: () => ['pov.coverage'] });
    await run.submit();
    const [review] = reviews(run.events);
    expect(review?.continuity).toEqual({ introduced: [], omitted: 0 });
    expect(review?.notices).toEqual([]);
  });

  it('never reviews a draft staged for the background', async () => {
    const run = await fixture([planner, drafter, critic(CRITIQUE)], { review: true });
    const staged = await run.session.stageOnly([{ tool: 'scene.draft', params: { doc: 'The Friend', instruction: 'Open the friend.', mode: 'draft' }, expect: 'drafted' }]);
    expect(staged.refusals).toEqual([]);
    expect(staged.modelCalls).toBe(1);
    expect(run.requests.filter((request) => request.role === 'background')).toEqual([]);
    expect(run.events.some((event) => event.type === 'review.start' || event.type === 'review')).toBe(false);
  });

  it('reads the setting at the start of each turn', async () => {
    let on = false;
    const state = project();
    const harness = createHarness({ state, ports: createAgentPorts(), clock: clock.now });
    const events: AgentEvent[] = [];
    const session = createAgentSession({
      harness,
      gateway: await mockGateway([planner, drafter, critic(CRITIQUE)]),
      context: createContextPort({ state }),
      decide: () => Promise.resolve({ action: 'cancel' }),
      emit: (event) => events.push(event),
      sessionId: 'review',
      review: () => on,
    });
    await session.submit(INTENT);
    expect(reviews(events)).toHaveLength(0);
    on = true;
    await session.submit(INTENT);
    expect(reviews(events)).toHaveLength(1);
  });
});

describe('Skip review', () => {
  it('aborts the critic’s call and not the turn: the draft is shown with a notice, and no critic request is sent', async () => {
    let skipped: boolean | undefined;
    const run = await fixture([planner, drafter, critic(CRITIQUE)], {
      review: true,
      onEvent: (event, session) => {
        if (event.type === 'review.start') skipped = session?.skipReview(event.turnId);
      },
    });
    const report = await run.submit();
    expect(skipped).toBe(true);
    expect(report.status).toBe('applied');
    const [review] = reviews(run.events);
    expect(review?.notices).toEqual([{ key: 'critic.skipped', message: 'The review was skipped.' }]);
    expect(review?.continuity).toBeDefined();
    expect(run.requests.filter((request) => request.role === 'background')).toEqual([]);
    expect(getBody(run.state, FRIEND)).toBe(DRAFT);
  });

  it('is refused for a turn that is not reviewing a draft', async () => {
    const run = await fixture([planner, drafter, critic(CRITIQUE)], { review: true });
    expect(run.session.skipReview('review.turn-1')).toBe(false);
    await run.submit();
    expect(run.session.skipReview('review.turn-1')).toBe(false);
  });

  it('is not the writer’s Stop: Stop during the review ends the turn as cancelled, with no review event', async () => {
    const stop = new AbortController();
    const run = await fixture([planner, drafter, critic(CRITIQUE)], {
      review: true,
      signal: stop.signal,
      onEvent: (event) => {
        if (event.type === 'review.start') stop.abort();
      },
    });
    const report = await run.submit();
    expect(report.status).toBe('cancelled');
    expect(reviews(run.events)).toEqual([]);
    expect(getBody(run.state, FRIEND)).toBe('');
  });
});
