/**
 * A turn whose plan the app built (`AgentSession.submitPlan`, the "Fix with agent" entry of a coherence finding, coherence.md §6.3).
 * The plan is checked and carded as a planner's is, its draft is the only model call, and nothing is written before its card is
 * approved. A plan that does not parse is refused before anything is staged.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { getBody, getRevision, type ProjectState } from '@caotang/store';

import { createAgentSession, createAgentPorts, createContextPort, type Decision, type PendingCard } from '../../src/index.js';
import { checkedHarness, clock, LANDING, LANDING_BODY, makeState, STORM } from '../fixtures.js';
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

describe('a plan of reads and the writer’s rules (agent-harness §4)', () => {
  /** "The Storm" is read-denied, with the note the refusal names. */
  const RULES = { rules: [{ effect: 'deny' as const, tool: '*', scope: { subtree: STORM }, access: 'read' as const, note: 'Private scene', source: 'project' as const }] };

  /** A session on the project with those rules, and the writer's decision on every card. */
  async function readsSession(state: ProjectState, decide: Decision = { action: 'approve' }) {
    const harness = checkedHarness({ state, ports: createAgentPorts(), clock: clock.now, rules: () => RULES });
    return createAgentSession({
      harness,
      gateway: await mockGateway([]),
      context: createContextPort({ state, withheld: (tool) => harness.withheld(tool) }),
      decide: async (card) => {
        pending.push(card);
        return decide;
      },
      sessionId: 'given-reads',
    });
  }
  let pending: PendingCard[] = [];
  beforeEach(() => {
    pending = [];
  });

  const readBoth = {
    steps: [
      { tool: 'doc.read', params: { doc: STORM }, expect: 'the storm scene' },
      { tool: 'doc.read', params: { doc: LANDING }, expect: 'the landing scene' },
    ],
  };

  it('settles a read a deny covers as refused, and still runs the plan’s other reads', async () => {
    const session = await readsSession(makeState());
    const report = await session.submitPlan('Read both scenes.', readBoth, { readsWithoutCard: true });

    expect(report.status).toBe('replied');
    expect(report.steps.map((step) => [step.tool, step.status])).toEqual([
      ['doc.read', 'failed'],
      ['doc.read', 'done'],
    ]);
    const text = JSON.stringify(report);
    expect(text).toContain('Private scene');
    expect(text).not.toContain('The Storm');
    expect(text).toContain(LANDING_BODY);
    expect(pending).toHaveLength(0);
  });

  it('keeps the refusal on the card when the plan is carded, so the card never promises a refused step', async () => {
    const session = await readsSession(makeState(), { action: 'cancel' });
    const report = await session.submitPlan('Read both scenes.', readBoth);

    expect(report.status).toBe('failed');
    expect(pending).toHaveLength(0);
    expect(report.askBack?.reason).toContain('Private scene');
    expect(report.steps).toHaveLength(0);
  });
});
