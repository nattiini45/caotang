import { expect, it } from 'vitest';
import { checkMachine } from '@caotang/machine/testing';
import { recurringRunTable, stepRecurringRun, type RecurringRunState, type RecurringRunEvent } from '../src/app/recurring-state.js';

const states: RecurringRunState[] = [{ kind: 'idle' }, { kind: 'running', taskId: 'task' }, { kind: 'recording', taskId: 'task' }];
const events: RecurringRunEvent[] = ['task', 'other'].flatMap((taskId) => (['start', 'record', 'finish'] as const).map((type) => ({ type, taskId })));

it('checks every recurring run phase and owner against its table', () => {
  expect(checkMachine({ table: recurringRunTable, step: stepRecurringRun }, { states, events })).toEqual([]);
});

it('keeps recording owned until the matching completion arrives', () => {
  const recording = stepRecurringRun(states[1]!, { type: 'record', taskId: 'task' });
  expect(recording).toEqual(states[2]);
  expect(stepRecurringRun(recording, { type: 'start', taskId: 'other' })).toBe(recording);
  expect(stepRecurringRun(recording, { type: 'finish', taskId: 'other' })).toBe(recording);
  expect(stepRecurringRun(recording, { type: 'finish', taskId: 'task' })).toEqual(states[0]);
});
