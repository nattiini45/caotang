/**
 * The draft review's eval scenarios (agent-harness §8, §9): the review off is the path a draft always took, the review shown puts one
 * `review` event before the `ghost`, a malformed critique is a keyed notice with the draft still shown, and a turn with no call left
 * skips the critic. Each is a complete turn against scripted replies, so the pipeline's trace and shapes are asserted and never a
 * model's judgment (the critic is a product feature, not a CI judge, §9).
 */

import { describe, expect, it } from 'vitest';

import { criticScript, userTextOf, type MockScript } from '@caotang/gateway/mock';
import { getBody, type ProjectState } from '@caotang/store';

import { createTraceStore, evaluate, parseTrace, runScenario, type AgentEvent, type Scenario, type ScenarioRun } from '../../src/index.js';
import { ENTRY_TWO, FRIEND, makeState } from '../fixtures.js';
import { mockGateway } from '../agent/gateway.js';
import { prose, steps, transcript } from '../agent/scripts.js';

const INTENT = 'Draft the opening of The Friend.';
const DRAFT = 'The ferry came in on the evening tide. Elena was not on it.';
const NOTE = { category: 'brief', severity: 'high', quote: 'Elena was not on it.', note: 'The brief says the friend brings news of Elena.', suggestion: 'Say what the news is.' };

/** The Friend owes the kestrel a mention; the draft above never names it, so applying the draft would introduce a finding. */
function project(): ProjectState {
  const state = makeState();
  state.coherence = { formatVersion: 1, findings: [], runs: [], sceneMeta: { [FRIEND]: { expectedPresent: [ENTRY_TWO] } }, worldRules: [], knowledge: [], reviewState: {} };
  return state;
}

const planner = transcript(INTENT, [
  steps({ tool: 'scene.draft', params: { doc: 'The Friend', instruction: 'Open the friend.', mode: 'draft' }, expect: 'The Friend is drafted' }),
]);

function scenario(name: string, scripts: readonly MockScript[], extra: Partial<Scenario> = {}): Scenario {
  return {
    name,
    category: 'single-op',
    intent: INTENT,
    project,
    gateway: (_state, hooks) => mockGateway([planner, prose('Brief: Open the friend.', DRAFT), ...scripts], hooks),
    expect: { status: 'applied' },
    ...extra,
  };
}

/** A critic that answers with `reply`. The draft it reads is in its user text. */
const critic = (reply: string): MockScript => criticScript((req) => (userTextOf(req).includes(DRAFT) ? reply : undefined));

const typesOf = (events: readonly AgentEvent[]): string[] => events.map((event) => event.type);
const reviewEvents = (run: ScenarioRun): Extract<AgentEvent, { type: 'review' }>[] => run.events.filter((event): event is Extract<AgentEvent, { type: 'review' }> => event.type === 'review');

describe('draft review: off is the path a draft always took', () => {
  const off = scenario('draft review: off', [critic(JSON.stringify({ notes: [NOTE] }))], {
    expect: { status: 'applied', reviews: 0, maxModelCalls: 2, ledgerRequests: 2, state: (state) => (getBody(state, FRIEND) === DRAFT ? [] : ['The Friend does not hold the draft']) },
  });

  it('makes the planner and the drafter call and nothing else, and emits no review event', async () => {
    const { run, failures } = await evaluate(off);
    expect(failures).toEqual([]);
    expect(run.report.modelCalls).toBe(2);
    expect(typesOf(run.events)).not.toContain('review');
    expect(typesOf(run.events)).not.toContain('review.start');
    expect(run.requests.some((request) => request.role === 'background')).toBe(false);
  });

  it('writes byte-identical traces with the option absent and with it false', async () => {
    const traced = async (review: boolean | undefined): Promise<string> => {
      const store = createTraceStore({ sessionId: 'eval' });
      await runScenario({ ...off, ...(review === undefined ? {} : { review }) }, { trace: store });
      const jsonl = store.toJsonl();
      expect(parseTrace(jsonl).ok).toBe(true);
      return jsonl;
    };
    const [absent, falsy] = [await traced(undefined), await traced(false)];
    expect(absent.length).toBeGreaterThan(1_000);
    expect(falsy).toBe(absent);
  });
});

describe('draft review: shown', () => {
  const shown = scenario('draft review: shown', [critic(JSON.stringify({ notes: [NOTE] }))], {
    review: true,
    expect: { status: 'applied', reviews: 1, maxModelCalls: 3, ledgerRequests: 3, state: (state) => (getBody(state, FRIEND) === DRAFT ? [] : ['The Friend does not hold the draft']) },
  });

  it('makes the critic call after the draft and emits one review event before the ghost', async () => {
    const { run, failures } = await evaluate(shown);
    expect(failures).toEqual([]);
    const kinds = typesOf(run.events).filter((type) => ['review.start', 'review', 'ghost', 'plan'].includes(type));
    expect(kinds).toEqual(['review.start', 'plan', 'review', 'ghost']);
    const [review] = reviewEvents(run);
    expect(review?.notices).toEqual([]);
    expect(review?.critique?.notes).toEqual([{ id: 'eval.turn-1/critic/n0', ...NOTE }]);
    expect(review?.continuity?.introduced.map((finding) => finding.checkId)).toEqual(['presence.expected']);
    expect(review?.docTitle).toBe('The Friend');
  });

  it('sends the critic as the Background role at temperature 0, with no tools, and counts it against the turn', async () => {
    const { run } = await evaluate(shown);
    const request = run.requests[2];
    expect(request?.role).toBe('background');
    expect(request?.temperature).toBe(0);
    expect(request?.tools).toBeUndefined();
    expect(request?.messages[0]?.content.startsWith('You are a critic reading a draft for Caotang.')).toBe(true);
    expect(run.requests.filter((entry) => entry.role === 'background')).toHaveLength(1);
    expect(run.report.modelCalls).toBe(3);
    expect(run.report.tokens.requests).toBe(3);
  });

  it('applies the draft exactly as without the review: one write, one undo group, and the same bytes', async () => {
    const reviewed = await runScenario(shown);
    const plain = await runScenario({ ...shown, review: false });
    expect(getBody(reviewed.state, FRIEND)).toBe(getBody(plain.state, FRIEND));
    expect(reviewed.report.trace).toEqual(plain.report.trace);
    expect(reviewed.report.undoGroupId).toBeDefined();
    expect(reviewed.report.cards).toEqual(plain.report.cards);
  });

  it('traces the critic’s request in the Background role, between the draft and the end of the turn', async () => {
    const store = createTraceStore({ sessionId: 'eval' });
    await runScenario(shown, { trace: store });
    const parsed = parseTrace(store.toJsonl());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const requests = parsed.value.filter((record) => record.kind === 'model.request') as readonly { callIndex?: number; role?: string }[];
    // The eval session names no role of its own, so the planner and the drafter carry none; the critic’s is Background.
    expect(requests.map((record) => record.role)).toEqual([undefined, undefined, 'background']);
    expect(requests.map((record) => record.callIndex)).toEqual([1, 2, 3]);
  });
});

describe('draft review: a malformed critique', () => {
  const malformed = scenario('draft review: malformed critique', [critic(JSON.stringify({ notes: [{ ...NOTE, category: 'plot' }] }))], {
    review: true,
    expect: { status: 'applied', reviews: 1, state: (state) => (getBody(state, FRIEND) === DRAFT ? [] : ['The Friend does not hold the draft']) },
  });

  it('is a keyed notice beside the draft, which is still shown and applied', async () => {
    const { run, failures } = await evaluate(malformed);
    expect(failures).toEqual([]);
    const [review] = reviewEvents(run);
    expect(review?.critique).toBeUndefined();
    expect(review?.notices.map((notice) => notice.key)).toEqual(['critique.notes[0].category']);
    expect(review?.continuity).toBeDefined();
    expect(run.events.some((event) => event.type === 'ghost' && event.text === DRAFT)).toBe(true);
  });

  it('is the same for a reply that is not JSON', async () => {
    const run = await runScenario({ ...malformed, gateway: (_state, hooks) => mockGateway([planner, prose('Brief: Open the friend.', DRAFT), critic('The scene is fine.')], hooks) });
    expect(reviewEvents(run)[0]?.notices.map((notice) => notice.key)).toEqual(['critique']);
    expect(run.report.status).toBe('applied');
  });
});

describe('draft review: a turn with no call left', () => {
  const short = scenario('draft review: budget-short skip', [critic(JSON.stringify({ notes: [NOTE] }))], {
    review: true,
    // The planner and the drafter use both calls, so the critic has none: the review says so and the draft is shown.
    modelCallBound: 2,
    expect: { status: 'applied', reviews: 1, maxModelCalls: 2, ledgerRequests: 2, state: (state) => (getBody(state, FRIEND) === DRAFT ? [] : ['The Friend does not hold the draft']) },
  });

  it('skips the critic with a one-line notice, still runs the continuity pass, and shows the draft', async () => {
    const { run, failures } = await evaluate(short);
    expect(failures).toEqual([]);
    const [review] = reviewEvents(run);
    expect(review?.critique).toBeUndefined();
    expect(review?.notices).toEqual([{ key: 'critic.budget', message: 'The review was skipped: this turn has no model call left for it.' }]);
    expect(review?.continuity?.introduced).toHaveLength(1);
    expect(run.requests.some((request) => request.role === 'background')).toBe(false);
  });
});
