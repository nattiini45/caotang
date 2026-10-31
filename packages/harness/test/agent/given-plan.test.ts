/**
 * A turn whose plan the app built (`AgentSession.submitPlan`, the "Fix with agent" entry of a coherence finding, coherence.md §6.3).
 * The plan is checked and carded as a planner's is, its draft is the only model call, and nothing is written before its card is
 * approved. A plan that does not parse is refused before anything is staged.
 */

import { describe, expect, it } from 'vitest';

import { getBody, getRevision, type ProjectState } from '@caotang/store';

import { createAgentSession, createAgentPorts, createContextPort, type Decision, type PendingCard } from '../../src/index.js';
import { checkedHarness, clock, LANDING, makeState } from '../fixtures.js';
import { mockGateway } from './gateway.js';
import { prose } from './scripts.js';

const INTENT = 'Fix the passage that a coherence finding names';
const REWRITTEN = 'The ferry was on time, for once.';

/** The words "The ferry was late", as the editor would have captured them as a selection (edit-anchors §2). */
function selectionOf(state: ProjectState) {
  const body = getBody(state, LANDING);
  const to = 'The ferry was late'.length;
  return { from: 0, to, exact: body.slice(0, to), prefix: '', suffix: body.slice(to, to + 20), capturedRevision: getRevision(state, LANDING) };
}

function planOf(state: ProjectState) {
  return {
    steps: [
      {
        tool: 'scene.draft',
        params: { doc: LANDING, mode: 'rewrite_selection', selection: selectionOf(state), instruction: 'Make the ferry on time.' },
        expect: 'the passage no longer conflicts',
      },
    ],
  };
}

/** A session on the project, with the writer's decision on every card it shows, and the cards it showed. */
async function sessionFor(state: ProjectState, decision: Decision, pending: PendingCard[]) {
  const gateway = await mockGateway([prose('Brief: Make the ferry on time.', REWRITTEN)]);
  const harness = checkedHarness({ state, ports: createAgentPorts(), clock: clock.now });
  return createAgentSession({
    harness,
    gateway,
    context: createContextPort({ state }),
    decide: async (card) => {
      pending.push(card);
      return decision;
    },
    sessionId: 'given-plan',
  });
}

describe('a turn whose plan the app built (coherence.md §6.3)', () => {
  it('stages the one draft, shows its card, and rewrites the passage once the writer approves', async () => {
    const state = makeState();
    const pending: PendingCard[] = [];
    const session = await sessionFor(state, { action: 'approve' }, pending);
    const report = await session.submitPlan(INTENT, planOf(state));
    expect(report.status).toBe('applied');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.card.steps[0]?.tool).toBe('scene.draft');
    expect(getBody(state, LANDING).startsWith(REWRITTEN)).toBe(true);
  });

  it('writes nothing when the writer cancels its card', async () => {
    const state = makeState();
    const before = getBody(state, LANDING);
    const session = await sessionFor(state, { action: 'cancel' }, []);
    await session.submitPlan(INTENT, planOf(state));
    expect(getBody(state, LANDING)).toBe(before);
  });

  it('refuses a plan that does not parse before anything is staged, and calls no model', async () => {
    const state = makeState();
    const pending: PendingCard[] = [];
    const session = await sessionFor(state, { action: 'approve' }, pending);
    const report = await session.submitPlan(INTENT, { steps: 'not a list' });
    expect(report.status).toBe('failed');
    expect(report.modelCalls).toBe(0);
    expect(pending).toHaveLength(0);
  });
});
