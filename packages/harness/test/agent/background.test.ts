/**
 * Background runs (agent-harness §2, "Background runs"): what the offer asks about before a big plan is staged, staging with no card
 * (`stageOnly`), and the review of what was staged (`submitStaged`). Each test drives the real session on the real bus and the mock
 * provider; nothing here needs a key.
 */

import { describe, expect, it } from 'vitest';

import { addDocument, getRevision, setBody, type ProjectState } from '@caotang/store';
import type { MockScript } from '@caotang/gateway/mock';

import {
  BACKGROUND_OFFER_MIN_CALLS,
  backgroundEligibility,
  createAgentPorts,
  createAgentSession,
  createContextPort,
  createHarness,
  estimatedModelCalls,
  proposalShapeOk,
  staleSteps,
  type AgentSession,
  type Decision,
  type OfferAnswer,
  type PendingCard,
  type PlanOffer,
  type PlanStep,
} from '../../src/index.js';
import { CHAPTER_TWO, LANDING, OPENED, STORM, FRIEND, makeState } from '../fixtures.js';
import { mockGateway } from './gateway.js';
import { prose, steps, transcript } from './scripts.js';

const INTENT = 'Synopsize the whole act.';

/** A project with `count` more documents in Chapter 2, titled "Scene 1" onward. */
function withScenes(count: number): ProjectState {
  const state = makeState();
  for (let index = 1; index <= count; index += 1) addDocument(state, { parentId: CHAPTER_TWO, title: `Scene ${index}`, body: `Scene ${index} text.`, now: OPENED });
  return state;
}

const TITLES = ['The Landing', 'The Storm', 'The Friend', 'Scene 1', 'Scene 2'];

const synopses = (docs: readonly string[] = TITLES): PlanStep => ({
  tool: 'synopsis.fill',
  params: { docs, source: 'text', max_words: 20 },
  expect: 'every document has a synopsis',
});

/** A session over `state`, with the answers the test gives to the offer and to each card. */
async function sessionOver(
  state: ProjectState,
  options: {
    readonly scripts?: readonly MockScript[];
    readonly offer?: (offer: PlanOffer) => OfferAnswer | Promise<OfferAnswer>;
    readonly decision?: Decision;
    readonly sessionId?: string;
  } = {},
) {
  const harness = createHarness({ state, ports: createAgentPorts() });
  const gateway = await mockGateway(options.scripts ?? [prose('Document "', 'A quiet synopsis.')]);
  const cards: PendingCard[] = [];
  const offers: PlanOffer[] = [];
  const session: AgentSession = createAgentSession({
    harness,
    gateway,
    context: createContextPort({ state: harness.state }),
    decide: async (pending) => {
      cards.push(pending);
      return options.decision ?? { action: 'approve' };
    },
    ...(options.offer === undefined
      ? {}
      : {
          beforeStage: async (offer: PlanOffer) => {
            offers.push(offer);
            return options.offer?.(offer) ?? 'now';
          },
        }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    maxModelCalls: 12,
  });
  return { session, harness, gateway, cards, offers };
}

describe('what a plan costs and whether it may run unattended', () => {
  it('counts a model call for each draft a plan makes, and none for a step that drafts nothing', () => {
    const plan: PlanStep[] = [
      synopses(),
      { tool: 'scene.draft', params: { doc: 'The Friend', instruction: 'Open.' }, expect: 'a draft' },
      { tool: 'prompt.draft', params: { shots: ['a', 'b', 'c'], vendor: 'runway-gen4' }, expect: 'prompts' },
      { tool: 'shots.derive', params: { doc: 'x' }, expect: 'shots' },
      { tool: 'meta.set', params: { targets: [FRIEND], label: 'act-2' }, expect: 'a label' },
    ];
    expect(estimatedModelCalls(plan)).toBe(5 + 1 + 3 + 1);
    expect(BACKGROUND_OFFER_MIN_CALLS).toBe(5);
  });

  it('refuses an external tool, a coherence review and a plan with no drafting step', () => {
    expect(backgroundEligibility([synopses()])).toEqual({ eligible: true });
    expect(backgroundEligibility([synopses(), { tool: 'mcp__srv__write', params: {}, expect: 'x' }]).eligible).toBe(false);
    expect(backgroundEligibility([synopses(), { tool: 'coherence.review', params: {}, expect: 'x' }]).eligible).toBe(false);
    expect(backgroundEligibility([{ tool: 'meta.set', params: {}, expect: 'x' }]).eligible).toBe(false);
  });
});

describe('the offer before a big plan is staged', () => {
  const plan = (docs: readonly string[]) => transcript(INTENT, [steps({ tool: 'synopsis.fill', params: { docs, source: 'text', max_words: 20 }, expect: 'synopses' })]);

  it('asks about a plan of five calls, with the steps, the estimate and the turn cap, before any draft is made', async () => {
    const seen: PlanOffer[] = [];
    const { session, gateway } = await sessionOver(withScenes(2), {
      scripts: [plan(TITLES), prose('Document "', 'A quiet synopsis.')],
      offer: (offer) => {
        seen.push(offer);
        // Only the planner's call has been made when the writer is asked.
        expect(gateway.ledger.turnTotals(offer.turnId).requests).toBe(1);
        return 'cancel';
      },
    });
    const report = await session.submit(INTENT);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ estimatedCalls: 5, turnCap: 12 });
    expect(seen[0]?.steps[0]?.tool).toBe('synopsis.fill');
    expect(report.status).toBe('cancelled');
    expect(report.summary).toBe('Cancelled. Nothing was written.');
    expect(gateway.ledger.turnTotals(report.turnId).requests).toBe(1);
  });

  it('does not ask about a plan under the threshold', async () => {
    const { session, offers, cards } = await sessionOver(withScenes(2), {
      scripts: [plan(TITLES.slice(0, 4)), prose('Document "', 'A quiet synopsis.')],
      offer: () => 'cancel',
    });
    const report = await session.submit(INTENT);
    expect(offers).toHaveLength(0);
    expect(cards).toHaveLength(1);
    expect(report.status).toBe('applied');
  });

  it('does not ask about a plan that cannot run unattended', async () => {
    const mixed = transcript(INTENT, [
      steps(
        { tool: 'synopsis.fill', params: { docs: TITLES, source: 'text', max_words: 20 }, expect: 'synopses' },
        { tool: 'coherence.review', params: { scope: { mode: 'full' } }, expect: 'a review' },
      ),
    ]);
    const { session, offers } = await sessionOver(withScenes(2), { scripts: [mixed, prose('Document "', 'A quiet synopsis.')], offer: () => 'cancel' });
    await session.submit(INTENT);
    expect(offers).toHaveLength(0);
  });

  it('stages and shows the usual card when the writer answers now', async () => {
    const { session, cards, harness } = await sessionOver(withScenes(2), { scripts: [plan(TITLES), prose('Document "', 'A quiet synopsis.')], offer: () => 'now' });
    const report = await session.submit(INTENT);
    expect(report.status).toBe('applied');
    expect(cards).toHaveLength(1);
    expect(harness.state.manifest.tree.find((node) => node.id === STORM)?.synopsis).toBe('A quiet synopsis.');
  });

  it('ends the turn with a queued report and makes no draft when the writer answers background', async () => {
    const { session, cards, gateway } = await sessionOver(withScenes(2), { scripts: [plan(TITLES), prose('Document "', 'A quiet synopsis.')], offer: () => 'background' });
    const report = await session.submit(INTENT);
    expect(report.status).toBe('replied');
    expect(report.text).toBe('Queued in the background: 5 model calls. Results appear in Tasks when ready.');
    expect(cards).toHaveLength(0);
    expect(gateway.ledger.turnTotals(report.turnId).requests).toBe(1);
  });

  it('ends the wait with a cancel when the writer stops the turn', async () => {
    const abort = new AbortController();
    const { session } = await sessionOver(withScenes(2), {
      scripts: [plan(TITLES)],
      offer: () => new Promise<OfferAnswer>(() => abort.abort()),
    });
    const report = await session.submit(INTENT, { signal: abort.signal });
    expect(report.status).toBe('cancelled');
    expect(report.stop).toMatchObject({ by: 'user' });
  });

  it('never asks about a plan the app built', async () => {
    const { session, offers } = await sessionOver(withScenes(2), { offer: () => 'cancel' });
    await session.submitPlan('Synopsize', { steps: [synopses()] });
    expect(offers).toHaveLength(0);
  });
});

describe('staging with no card (stageOnly)', () => {
  it('drafts each step, records what it read, and shows no card, writes nothing and keeps no turn', async () => {
    const state = withScenes(2);
    const { session, harness, gateway, cards } = await sessionOver(state, { sessionId: 'task_x' });
    const logged = harness.log.entries().length;
    const before = JSON.stringify(state.manifest.tree);

    const result = await session.stageOnly([synopses(['The Storm']), synopses(['The Friend'])]);

    expect(cards).toHaveLength(0);
    expect(result.stopped).toBe(false);
    expect(result.refusals).toEqual([]);
    expect(result.proposals).toHaveLength(2);
    expect(result.proposals[0]).toMatchObject({ items: [{ docId: STORM, synopsis: 'A quiet synopsis.' }] });
    expect(result.revisions[0]).toEqual({ [STORM]: getRevision(state, STORM) });
    expect(result.revisions[1]).toEqual({ [FRIEND]: getRevision(state, FRIEND) });
    expect(result.modelCalls).toBe(2);
    expect(result.tokens.requests).toBe(2);
    expect(JSON.stringify(state.manifest.tree)).toBe(before);
    expect(harness.log.entries()).toHaveLength(logged);
    expect(session.reports()).toHaveLength(0);
    // The calls are the task's: its session id names the turn the ledger counts them under, and the result carries the same totals.
    expect(gateway.ledger.turnTotals('task_x.turn-1').requests).toBe(2);
    expect(result.tokens.promptTokens).toBe(gateway.ledger.turnTotals('task_x.turn-1').promptTokens);
  });

  it('names a step the model could not draft, and goes on with the next', async () => {
    const { session } = await sessionOver(withScenes(2));
    const result = await session.stageOnly([synopses(['No Such Scene']), synopses(['The Storm'])]);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]).toMatchObject({ index: 0, tool: 'synopsis.fill' });
    expect(result.proposals[0]).toBeUndefined();
    expect(result.proposals[1]).toBeDefined();
  });

  it('stops where the signal says and reports it', async () => {
    const abort = new AbortController();
    abort.abort();
    const { session } = await sessionOver(withScenes(2));
    const result = await session.stageOnly([synopses(['The Storm'])], { signal: abort.signal });
    expect(result.stopped).toBe(true);
    expect(result.proposals[0]).toBeUndefined();
    expect(result.modelCalls).toBe(0);
  });

  it('refuses a step that is not a plan step, without a model call', async () => {
    const { session } = await sessionOver(withScenes(2));
    const result = await session.stageOnly([{ tool: 'synopsis.fill', params: {}, expect: '' }]);
    expect(result.refusals).toHaveLength(1);
    expect(result.modelCalls).toBe(0);
  });
});

describe('the review of a plan staged earlier (submitStaged)', () => {
  const plan = { steps: [synopses(['The Storm', 'The Friend'])] };

  /** Stages the plan in one session and returns what a task would hold, plus a second session over the same project for the review. */
  async function staged(state: ProjectState, scripts?: readonly MockScript[]) {
    const stager = await sessionOver(state, { ...(scripts === undefined ? {} : { scripts }), sessionId: 'task_a' });
    const result = await stager.session.stageOnly(plan.steps);
    return { result, stager };
  }

  it('shows the usual card, applies the held drafts with no new model call, and leaves one undo group and a checkpoint', async () => {
    const state = withScenes(2);
    const { result } = await staged(state);
    expect(result.proposals[0]).toBeDefined();
    const reviewer = await sessionOver(state, { scripts: [] });

    const report = await reviewer.session.submitStaged(INTENT, plan, result.proposals, result.revisions);

    expect(report.status).toBe('applied');
    expect(report.modelCalls).toBe(0);
    expect(reviewer.cards).toHaveLength(1);
    expect(reviewer.cards[0]?.card.approvable).toBe(true);
    expect(reviewer.cards[0]?.card.steps[0]?.stale).toBe(false);
    expect(state.manifest.tree.find((node) => node.id === STORM)?.synopsis).toBe('A quiet synopsis.');
    expect(state.manifest.tree.find((node) => node.id === FRIEND)?.synopsis).toBe('A quiet synopsis.');
    expect(report.undoGroupId).toBeDefined();
    expect(reviewer.session.restore(report.turnId).ok).toBe(true);
    expect(state.manifest.tree.find((node) => node.id === STORM)?.synopsis).toBe('');
    expect(reviewer.gateway.ledger.turnTotals(report.turnId).requests).toBe(0);
  });

  it('marks a step stale when a document it read has changed since, so the card cannot be approved', async () => {
    const state = withScenes(2);
    const { result } = await staged(state);
    setBody(state, STORM, 'The storm is new text.');
    const reviewer = await sessionOver(state, { scripts: [], decision: { action: 'cancel' } });

    const report = await reviewer.session.submitStaged(INTENT, plan, result.proposals, result.revisions);

    expect(report.status).toBe('cancelled');
    const card = reviewer.cards[0]?.card;
    expect(card?.steps[0]?.stale).toBe(true);
    expect(card?.approvable).toBe(false);
    expect(card?.notice).toContain('1 of 1 step is out of date');
    expect(state.manifest.tree.find((node) => node.id === STORM)?.synopsis).toBe('');
  });

  it('treats a stored proposal with the wrong shape as a step that was not drafted, and never shows it', async () => {
    const state = withScenes(2);
    const { result } = await staged(state);
    const reviewer = await sessionOver(state, { scripts: [], decision: { action: 'cancel' } });

    await reviewer.session.submitStaged(INTENT, plan, [{ items: 'not a list' }], result.revisions);

    expect(reviewer.cards[0]?.card.steps[0]?.stale).toBe(true);
    expect(reviewer.cards[0]?.card.steps[0]?.preview).toBeUndefined();
    expect(reviewer.cards[0]?.card.approvable).toBe(false);
  });

  it('treats a step that was refused in the background as stale, and a Retry drafts it again in the foreground', async () => {
    const state = withScenes(2);
    const reviewer = await sessionOver(state, { scripts: [prose('Document "', 'A fresh synopsis.')] });
    const decisions: Decision[] = [{ action: 'retry' }, { action: 'approve' }];
    const pending: PendingCard[] = [];
    const session = createAgentSession({
      harness: reviewer.harness,
      gateway: reviewer.gateway,
      context: createContextPort({ state: reviewer.harness.state }),
      decide: async (card) => {
        pending.push(card);
        return decisions.shift() ?? { action: 'cancel' };
      },
      maxModelCalls: 12,
    });

    const report = await session.submitStaged(INTENT, plan, [undefined], [{}]);

    expect(pending[0]?.card.steps[0]?.stale).toBe(true);
    expect(report.status).toBe('applied');
    expect(state.manifest.tree.find((node) => node.id === STORM)?.synopsis).toBe('A fresh synopsis.');
  });

  it('refuses a stored plan that could not have been queued', async () => {
    const state = withScenes(2);
    const reviewer = await sessionOver(state, { scripts: [] });
    const report = await reviewer.session.submitStaged(INTENT, { steps: [{ tool: 'mcp__srv__write', params: {}, expect: 'x' }] }, [undefined], [{}]);
    expect(report.status).toBe('failed');
    expect(reviewer.cards).toHaveLength(0);
  });

  it('refuses a stored plan that does not parse', async () => {
    const reviewer = await sessionOver(withScenes(2), { scripts: [] });
    const report = await reviewer.session.submitStaged(INTENT, { steps: 'nope' }, [], []);
    expect(report.status).toBe('failed');
    expect(reviewer.cards).toHaveLength(0);
  });

  it('runs a staged plan of reads without a card', async () => {
    const state = withScenes(2);
    const readPlan = { steps: [{ tool: 'continuity.scan', params: { scope: ['The Landing'] }, expect: 'a scan' }] };
    const found = { findings: [] };
    const reviewer = await sessionOver(state, { scripts: [] });
    const report = await reviewer.session.submitStaged(INTENT, readPlan, [found], [{ [LANDING]: getRevision(state, LANDING) }]);
    expect(report.status).toBe('replied');
    expect(reviewer.cards).toHaveLength(0);
  });
});

describe('which staged steps are out of date', () => {
  it('flags a missing proposal, a damaged one, a changed document and a removed one, and leaves a step with no draft alone', () => {
    const state = withScenes(1);
    const plan: PlanStep[] = [synopses(['The Storm']), synopses(['The Storm']), synopses(['The Storm']), { tool: 'meta.set', params: { targets: [FRIEND], label: 'act-2' }, expect: 'x' }];
    const good = { items: [{ docId: STORM, synopsis: 'Rain.' }] };
    const revision = { [STORM]: getRevision(state, STORM) };
    expect(staleSteps(state, plan, [good, good, good, undefined], [revision, revision, revision, {}])).toEqual([false, false, false, false]);
    expect(staleSteps(state, plan, [undefined, { items: 3 }, good, undefined], [revision, revision, { n_GONE000001: 0 }, {}])).toEqual([true, true, true, false]);
    setBody(state, STORM, 'Changed.');
    expect(staleSteps(state, plan.slice(0, 1), [good], [revision])).toEqual([true]);
  });

  it('accepts only the shape each tool’s port reads', () => {
    expect(proposalShapeOk('scene.draft', { text: 'x', words: 1, revision: 2 })).toBe(true);
    expect(proposalShapeOk('scene.draft', { text: 'x' })).toBe(false);
    expect(proposalShapeOk('synopsis.fill', { items: [{ docId: 'a', synopsis: 'b' }] })).toBe(true);
    expect(proposalShapeOk('synopsis.fill', { items: [{ docId: 'a' }] })).toBe(false);
    expect(proposalShapeOk('continuity.scan', { findings: [] })).toBe(true);
    expect(proposalShapeOk('dialogue.draft', { ink: '-> END', revision: 0 })).toBe(true);
    expect(proposalShapeOk('dialogue.draft', { ink: 3 })).toBe(false);
    expect(proposalShapeOk('shots.derive', { shots: [] })).toBe(true);
    expect(proposalShapeOk('shots.derive', [])).toBe(false);
    expect(proposalShapeOk('meta.set', {})).toBe(false);
  });
});
