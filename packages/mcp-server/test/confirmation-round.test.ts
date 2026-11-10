import { describe, expect, it } from 'vitest';
import { inputResponse } from '@modelcontextprotocol/server';
import { checkMachine } from '@caotang/machine/testing';

import {
  confirmationRoundMachine,
  confirmationRoundTable,
  stepConfirmationRound,
  type ConfirmationRoundEvent,
  type ConfirmationRoundState,
  type RoundState,
} from '../src/index.js';

const round: RoundState = { v: 1, tool: 'doc.import', digest: 'd', turnId: 't', callId: 'c', nonce: 'n' };
const states: ConfirmationRoundState[] = [
  { kind: 'unasked' },
  { kind: 'asked', round },
  { kind: 'accepted', round },
  { kind: 'declined', round },
  { kind: 'cancelled', round },
  { kind: 'not-confirmed', round },
];

const answers = [
  { response: undefined, kind: 'asked' },
  { response: { roots: [] }, kind: 'asked' },
  { response: { role: 'assistant', content: [] }, kind: 'asked' },
  { response: { action: 'accept', content: { confirmed: true } }, kind: 'accepted' },
  { response: { action: 'accept', content: { confirmed: false } }, kind: 'not-confirmed' },
  { response: { action: 'accept' }, kind: 'not-confirmed' },
  { response: { action: 'accept', content: { confirmed: 'true' } }, kind: 'not-confirmed' },
  { response: { action: 'decline', content: { confirmed: true } }, kind: 'declined' },
  { response: { action: 'cancel', content: { confirmed: true } }, kind: 'cancelled' },
] as const;

const events: ConfirmationRoundEvent[] = [
  { type: 'ask', round },
  ...answers.map(({ response }): ConfirmationRoundEvent => ({ type: 'answer', reply: inputResponse({ confirm: response }, 'confirm') })),
];

describe('the MRTR confirmation round', () => {
  it('agrees with every table pair and has reachable non-final states and absorbing final states', () => {
    expect(checkMachine(confirmationRoundMachine, { states, events })).toEqual([]);
    expect(confirmationRoundMachine.table).toBe(confirmationRoundTable);
  });

  it('asks with the original sealed payload, without adding a lifecycle tag to it', () => {
    const asked = stepConfirmationRound({ kind: 'unasked' }, { type: 'ask', round });
    expect(asked).toEqual({ kind: 'asked', round });
    if (asked.kind === 'asked') expect(asked.round).toBe(round);
    expect(Object.keys(round)).toEqual(['v', 'tool', 'digest', 'turnId', 'callId', 'nonce']);
  });

  it.each(answers)('classifies $response as $kind without changing the bound round', ({ response, kind }) => {
    const result = stepConfirmationRound({ kind: 'asked', round }, { type: 'answer', reply: inputResponse({ confirm: response }, 'confirm') });
    expect(result).toEqual({ kind, round });
    if (result.kind !== 'unasked') expect(result.round).toBe(round);
  });

  it('ignores every answer when no round is bound to these arguments', () => {
    const unasked: ConfirmationRoundState = { kind: 'unasked' };
    for (const event of events.filter((event) => event.type === 'answer')) {
      expect(stepConfirmationRound(unasked, event)).toBe(unasked);
    }
  });

  it('keeps every final decision unchanged on every event', () => {
    for (const state of states.filter((state) => confirmationRoundTable.final.includes(state.kind))) {
      for (const event of events) expect(stepConfirmationRound(state, event)).toBe(state);
    }
  });
});
