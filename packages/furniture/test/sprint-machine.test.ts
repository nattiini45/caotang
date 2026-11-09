import { describe, expect, it } from 'vitest';
import { checkMachine } from '@caotang/machine/testing';
import { createSprint, sprintMachine, sprintTable, transitionSprint } from '../src/sprint.js';
import type { SprintEvent, SprintMachineState, SprintState } from '../src/sprint.js';

function adapt({ status, ...fields }: SprintState): SprintMachineState {
  return { ...fields, kind: status };
}

const idle = createSprint(1);
const running = transitionSprint(idle, { type: 'start', at: 1000, words: 10 });
const paused = transitionSprint(running, { type: 'pause', at: 2000, words: 20 });
const finished = transitionSprint(paused, { type: 'stop', at: 3000, words: 30 });
const states = [idle, running, paused, finished];
const events: SprintEvent[] = [
  { type: 'start', at: 1000, words: 10 },
  { type: 'pause', at: 2000, words: 20 },
  { type: 'pause', at: 61_000, words: 99 },
  { type: 'resume', at: 3000, words: 30 },
  { type: 'tick', at: 2000, words: 20 },
  { type: 'tick', at: 61_000, words: 99 },
  { type: 'stop', at: 2000, words: 20 },
  { type: 'stop', at: 61_000, words: 99 },
  { type: 'setDuration', minutes: 5 },
  { type: 'reset' },
];

describe('the registered sprint timer', () => {
  it('agrees with every table row, including early and expired event payloads', () => {
    expect(checkMachine(sprintMachine, { states: states.map(adapt), events })).toEqual([]);
  });

  it('adapts the existing status API without changing a result or adding a kind field to it', () => {
    for (const state of states) {
      for (const event of events) {
        const before = structuredClone(state);
        const next = transitionSprint(state, event);
        const adapted = adapt(state);
        const result = sprintMachine.step(adapted, event);
        expect(result).toEqual(adapt(next));
        if (next === state) expect(result).toBe(adapted);
        expect(state).toEqual(before);
        expect(next).not.toHaveProperty('kind');
      }
    }
  });

  it('keeps finished resettable rather than declaring it a terminal state', () => {
    expect(sprintTable.final).toEqual([]);
    expect(sprintMachine.step(adapt(finished), { type: 'reset' }).kind).toBe('idle');
  });
});
