import { expect, test } from '@playwright/test';

import { EMPTY_BUDGET_USE, type AgentEvent, type TurnReport } from '../../packages/harness/src/index.js';
import { newTurnView, reduceTurn } from '../../apps/desktop/src/app/agent-model.js';

/**
 * The turn's reasoning as the panel holds it (provider-gateway §3, §6/D12): `model.reasoning` deltas accumulate whole —
 * the Thinking block is the record, not a tail like the stream line — and they are a different channel from both the
 * panel's `model.delta` text and the reply's replayable `reasoning` blocks, which never reach this fold at all.
 */

const TURN = 'sess.turn-1';

function fold(events: readonly AgentEvent[], intent = 'Think it through.') {
  return events.reduce((turn, event) => reduceTurn(turn, event), newTurnView(TURN, intent));
}

test('a new turn has no reasoning, and reasoning deltas accumulate in full, apart from the stream', () => {
  const turn = fold([
    { type: 'turn', turnId: TURN, phase: 'planning' },
    { type: 'model.reasoning', turnId: TURN, delta: 'weighing ' },
    { type: 'model.delta', turnId: TURN, delta: '{"reply":"' },
    { type: 'model.reasoning', turnId: TURN, delta: 'the openings' },
  ]);

  expect(turn.reasoning).toBe('weighing the openings');
  // The prose channel is untouched by it: the tail holds only the model's own text.
  expect(turn.streamed).toBe('{"reply":"');
});

test('the thinking survives the report: it is the turn’s record, shown collapsed, while the stream line clears', () => {
  const report: TurnReport = {
    turnId: TURN,
    status: 'replied',
    text: 'Done.',
    summary: 'Done.',
    steps: [],
    cards: [],
    trace: [],
    tokens: { promptTokens: 4, completionTokens: 2, requests: 1 },
    dropped: [],
    modelCalls: 1,
    mode: 'ask',
    budgetUse: EMPTY_BUDGET_USE,
  };
  const turn = fold([
    { type: 'model.reasoning', turnId: TURN, delta: 'what the model thought' },
    { type: 'model.delta', turnId: TURN, delta: 'visible tail' },
    { type: 'report', turnId: TURN, report },
  ]);

  expect(turn.reasoning).toBe('what the model thought');
  expect(turn.streamed).toBe('');
});

test('another turn’s reasoning is not this one’s', () => {
  const turn = fold([{ type: 'model.reasoning', turnId: TURN, delta: 'mine' }]);
  const after = reduceTurn(turn, { type: 'model.reasoning', turnId: 'sess.turn-2', delta: 'theirs' });
  expect(after.reasoning).toBe('mine');
});
