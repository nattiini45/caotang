/**
 * `dialogue.draft` drafts over its container as the focus (dialogue-narrative.md §7, context-assembly §2): the card's prompt names the
 * codex entries of the characters who speak in the container (L2) and its prior beats (L4), where a draft used to carry the Ink inline
 * with the standard stack left out.
 */

import { describe, expect, it } from 'vitest';

import { addDocument, type ProjectState } from '@caotang/store';

import { createAgentPorts, createAgentSession, createContextPort, type AgentEvent, type Decision, type PendingCard } from '../../src/index.js';
import { checkedHarness, clock, makeState, OPENED } from '../fixtures.js';
import { mockGateway } from './gateway.js';
import { prose, steps, transcript } from './scripts.js';

const INTENT = 'Write the reply at the tavern.';
const CONTAINER = 'n_TAVERN0001';
/** Two beats. Elena speaks; the second beat's line names nobody, so the codex's other entries stay out. */
const INK = ['=== opening ===', 'Elena: The ferry is late again.', '-> arrival', '', '=== arrival ===', 'A bird sings from the rafters.', '-> END'].join('\n');

function withContainer(): ProjectState {
  const state = makeState();
  addDocument(state, { id: CONTAINER, parentId: 'manuscript', title: 'Tavern', type: 'dialogue', body: INK, now: OPENED });
  return state;
}

/** One turn that drafts a reply in the container, and the writer's decision on the card it shows. */
async function draftTurn(state: ProjectState, decision: Decision): Promise<{ pending: PendingCard[]; events: AgentEvent[] }> {
  const gateway = await mockGateway([
    transcript(INTENT, [steps({ tool: 'dialogue.draft', params: { doc: CONTAINER, instruction: 'A thank-you.' }, expect: 'the reply is drafted' })]),
    prose('Brief: A thank-you.', '=== reply ===\nThanks for the drink.\n-> END'),
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
    sessionId: 'dialogue-focus',
  });
  await session.submit(INTENT);
  return { pending, events };
}

describe('dialogue.draft over its container as the focus (dialogue-narrative §7)', () => {
  it('lists the codex entry of the character who speaks in the container, in the codex layer, with the speakers as its reason', async () => {
    const { pending } = await draftTurn(withContainer(), { action: 'cancel' });
    const context = pending.at(-1)?.card.steps[0]?.context;
    expect(context?.codex.included).toEqual([expect.objectContaining({ name: 'Elena', reason: expect.stringContaining('speakers') })]);
  });

  it('lists the container’s beats in the story-so-far layer, in body order', async () => {
    const { pending } = await draftTurn(withContainer(), { action: 'cancel' });
    expect(pending.at(-1)?.card.steps[0]?.context?.storySoFar.included).toEqual(['opening', 'arrival']);
  });

  it('shows the container’s Ink as the focus, so the card reads the text the new beat follows', async () => {
    const { pending } = await draftTurn(withContainer(), { action: 'cancel' });
    expect(pending.at(-1)?.card.steps[0]?.context?.focus?.head).toContain('Elena: The ferry is late again.');
  });

  it('draws the container’s beats and speakers from its Ink, so a container with no lines has neither', async () => {
    const state = makeState();
    addDocument(state, { id: CONTAINER, parentId: 'manuscript', title: 'Tavern', type: 'dialogue', body: '', now: OPENED });
    const { pending } = await draftTurn(state, { action: 'cancel' });
    const context = pending.at(-1)?.card.steps[0]?.context;
    expect(context?.storySoFar.included).toEqual([]);
    expect(context?.codex.included.some((entry) => entry.name === 'Elena')).toBe(false);
  });
});
