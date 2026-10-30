/**
 * `dialogue.draft` wired to the provider like `scene.draft` (dialogue-narrative.md §7): the loop drafts the container's Ink before
 * its card is shown, the dialogue module checks it, and the approved Ink is one document write into the container. Ink the module
 * cannot compile never reaches a card, and nothing is written before the writer approves.
 */

import { describe, expect, it } from 'vitest';

import { addDocument, getBody, getRevision, type ProjectState } from '@caotang/store';

import { createAgentPorts, createAgentSession, createContextPort, type AgentEvent, type Decision, type PendingCard } from '../../src/index.js';
import { checkedHarness, clock, makeState, OPENED } from '../fixtures.js';
import { mockGateway } from './gateway.js';
import { prose, steps, transcript } from './scripts.js';

const INTENT = 'Write the reply at the tavern.';
const CONTAINER = 'n_TAVERN0001';
const INK = ['=== reply ===', 'Thanks for the drink.', '-> END'].join('\n');
const BROKEN_INK = ['=== reply ===', '* [Unclosed choice', '-> END'].join('\n');

/** A project with an empty dialogue container in the manuscript. */
function withContainer(): ProjectState {
  const state = makeState();
  addDocument(state, { id: CONTAINER, parentId: 'manuscript', title: 'Tavern', type: 'dialogue', body: '', now: OPENED });
  return state;
}

/** One turn: a planner that proposes the draft, the Ink the model writes, and the writer's decision on the card. */
async function draftTurn(state: ProjectState, ink: string, decision: Decision) {
  const gateway = await mockGateway([
    transcript(INTENT, [steps({ tool: 'dialogue.draft', params: { doc: CONTAINER, instruction: 'A thank-you.' }, expect: 'the reply is drafted' })]),
    prose('Brief: A thank-you.', ink),
  ]);
  const harness = checkedHarness({ state, ports: createAgentPorts(), clock: clock.now });
  const pending: PendingCard[] = [];
  const events: AgentEvent[] = [];
  const session = createAgentSession({
    harness,
    gateway,
    context: createContextPort({ state }),
    decide: async (card) => {
      pending.push(card);
      return decision;
    },
    emit: (event) => events.push(event),
    sessionId: 'dialogue-draft',
  });
  const report = await session.submit(INTENT);
  return { report, pending, events };
}

describe('dialogue.draft through the agent (dialogue-narrative.md §7)', () => {
  it('shows the drafted Ink on its card, and writes it into the container once the writer approves', async () => {
    const state = withContainer();
    const revision = getRevision(state, CONTAINER);
    const { report, pending } = await draftTurn(state, INK, { action: 'approve' });
    expect(pending.at(-1)?.card.steps[0]?.tool).toBe('dialogue.draft');
    expect(pending.at(-1)?.card.steps[0]?.preview).toMatchObject({ container: 'Tavern', ink: INK });
    expect(report.steps.find((step) => step.tool === 'dialogue.draft')?.status).toBe('done');
    expect(getBody(state, CONTAINER)).toContain('Thanks for the drink.');
    expect(getRevision(state, CONTAINER)).toBeGreaterThan(revision);
  });

  it('writes nothing when the writer cancels the card', async () => {
    const state = withContainer();
    await draftTurn(state, INK, { action: 'cancel' });
    expect(getBody(state, CONTAINER)).toBe('');
  });

  it('refuses Ink the module cannot compile back to the model, so no card is shown for it', async () => {
    const state = withContainer();
    const { pending } = await draftTurn(state, BROKEN_INK, { action: 'approve' });
    expect(pending).toHaveLength(0);
    expect(getBody(state, CONTAINER)).toBe('');
  });

  it('refuses a container name the project does not hold, in the dialogue module’s words, and writes nothing', () => {
    const state = withContainer();
    const harness = checkedHarness({ state, ports: createAgentPorts(), clock: clock.now });
    // The call is approved and Ink is staged, so it reaches the port's container check rather than the permission gate or the
    // nothing-staged refusal, which would also refuse it.
    const outcome = harness.call(
      { name: 'dialogue.draft', callId: 'd-1', params: { doc: 'Nowhere', instruction: 'x' }, proposal: { ink: INK, revision: getRevision(state, CONTAINER) } },
      { turnId: 't', permission: { approvedPlan: true } },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.message).toContain('no node is called "Nowhere"');
    expect(getBody(state, CONTAINER)).toBe('');
  });

  it('is not wired in a bare harness, and is wired where the app builds its harness with the agent ports (session.ts)', () => {
    const bare = checkedHarness({ state: makeState(), clock: clock.now });
    expect(bare.tools().find((tool) => tool.name === 'dialogue.draft')?.wired).toBe(false);
    const app = checkedHarness({ state: makeState(), ports: createAgentPorts(), clock: clock.now });
    expect(app.tools().find((tool) => tool.name === 'dialogue.draft')?.wired).toBe(true);
  });
});
