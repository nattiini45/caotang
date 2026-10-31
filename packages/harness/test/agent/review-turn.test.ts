/**
 * A coherence review inside an agent turn (coherence.md §5.3, §7 tool 16, agent-harness §2): the planner's step is staged into a
 * card that shows what the review will read, and the review runs only when the writer approves that card. Each test drives the
 * real session on the real harness, with the review's model supplied as the app supplies it.
 */

import { describe, expect, it } from 'vitest';

import type { CoherenceModel } from '@caotang/coherence';
import type { ProjectState } from '@caotang/store';

import { createAgentPorts, createAgentSession, createContextPort, type AgentEvent, type Decision, type PendingCard } from '../../src/index.js';
import { checkedHarness, clock, makeState, STORM } from '../fixtures.js';
import { mockGateway } from './gateway.js';
import { steps, transcript } from './scripts.js';

const INTENT = 'Review the storm for problems';

/** A review model that finds nothing, and counts the calls it is asked. */
function quietModel(): { readonly model: CoherenceModel; readonly calls: () => number } {
  let count = 0;
  return {
    model: {
      model: 'review-test',
      complete: async () => {
        count += 1;
        return { content: '{"spans": []}', usage: { promptTokens: 4, completionTokens: 2 } };
      },
    },
    calls: () => count,
  };
}

/** One turn with a planner that proposes a review of the storm, and the decision the writer makes on its card. */
async function reviewTurn(state: ProjectState, decision: Decision, model: CoherenceModel) {
  const gateway = await mockGateway([
    transcript(INTENT, [steps({ tool: 'coherence.review', params: { scope: { mode: 'doc', docIds: [STORM] } }, expect: 'the storm is reviewed' })]),
  ]);
  const harness = checkedHarness({ state, ports: createAgentPorts(), clock: clock.now, coherence: { model: () => model } });
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
    sessionId: 'review-turn',
  });
  const report = await session.submit(INTENT);
  return { report, pending, events, state };
}

describe('a coherence review in an agent turn', () => {
  it('shows the documents it will read on the card, and runs the review once the writer approves', async () => {
    const state = makeState();
    const { model, calls } = quietModel();
    const { report, pending } = await reviewTurn(state, { action: 'approve' }, model);

    // The card that the writer decided on names the scene the review reads, with its token estimate.
    const shown = pending.at(-1)?.card;
    expect(shown).toBeDefined();
    const step = shown?.steps[0];
    expect(step?.tool).toBe('coherence.review');
    const title = state.manifest.tree.find((node) => node.id === STORM)?.title ?? '';
    expect(step?.preview).toMatchObject({ documents: [{ title }] });

    // The approved card ran the review through the app's model, and the run is in the held file.
    expect(calls()).toBe(1);
    expect(state.coherence?.runs).toHaveLength(1);
    const done = report.steps.find((entry) => entry.tool === 'coherence.review');
    expect(done?.status).toBe('done');
  });

  it('runs no review, and calls no model, when the writer cancels the card', async () => {
    const state = makeState();
    const { model, calls } = quietModel();
    const { report } = await reviewTurn(state, { action: 'cancel' }, model);
    expect(calls()).toBe(0);
    expect(state.coherence?.runs ?? []).toEqual([]);
    expect(report.steps.some((entry) => entry.tool === 'coherence.review' && entry.status === 'done')).toBe(false);
  });
});
