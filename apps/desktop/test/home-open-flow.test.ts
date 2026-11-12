import { checkMachine } from '@caotang/machine/testing';
import { describe, expect, it } from 'vitest';

import { homeOpenMachine, type HomeOpenEvent, type HomeOpenState } from '../src/app/home-open-flow.js';
import type { FolderDiffers, Opened, PendingEncoding, PendingRecovery, RecoveryRefusal } from '../src/app/lifecycle.js';

const recovery = { name: 'Recovered folder' } as PendingRecovery;
const encoding = { name: 'Legacy bundle', cancelNote: 'The recovered manifest was written.' } as PendingEncoding;
const differs = { projectName: 'The other version' } as FolderDiffers;
const opened = {} as Opened;
const files = [{ change: 'changed' as const, label: 'Harbour' }];
const refusals: RecoveryRefusal[] = ['locked', 'changed', 'files'];
const states: HomeOpenState[] = [
  { kind: 'idle' },
  { kind: 'recovery', recovery, refusal: null },
  ...refusals.map((reason): HomeOpenState => ({ kind: 'recovery', recovery, refusal: { reason, files } })),
  { kind: 'encoding', encoding },
  { kind: 'differs', differs },
];
const events: HomeOpenEvent[] = [
  { type: 'open-result', outcome: { kind: 'opened', opened } },
  { type: 'open-result', outcome: { kind: 'recover', recovery } },
  { type: 'open-result', outcome: { kind: 'encoding', encoding } },
  { type: 'open-result', outcome: { kind: 'differs', differs } },
  { type: 'resume' },
  { type: 'recovery-result', outcome: { kind: 'opened', opened } },
  { type: 'recovery-result', outcome: { kind: 'encoding', encoding } },
  ...refusals.map((reason): HomeOpenEvent => ({ type: 'recovery-result', outcome: { kind: 'refused', reason, files } })),
  { type: 'recovery-failed' },
  { type: 'cancel' },
];

describe('Home pending-open machine', () => {
  it('exhaustively agrees with its table for every state, event and outcome variant', () => {
    expect(checkMachine(homeOpenMachine, { states, events })).toEqual([]);
  });

  it('holds each initial open outcome without mixing dialog payloads', () => {
    expect(homeOpenMachine.step({ kind: 'idle' }, events[0]!)).toEqual({ kind: 'idle' });
    expect(homeOpenMachine.step({ kind: 'idle' }, events[1]!)).toEqual({ kind: 'recovery', recovery, refusal: null });
    expect(homeOpenMachine.step({ kind: 'idle' }, events[2]!)).toEqual({ kind: 'encoding', encoding });
    expect(homeOpenMachine.step({ kind: 'idle' }, events[3]!)).toEqual({ kind: 'differs', differs });
  });

  for (const reason of refusals) {
    it(`keeps the recovery and named files together after a ${reason} refusal`, () => {
      const state = homeOpenMachine.step(states[1]!, { type: 'recovery-result', outcome: { kind: 'refused', reason, files } });
      expect(state).toEqual({ kind: 'recovery', recovery, refusal: { reason, files } });
      if (state.kind !== 'recovery') throw new Error('Recovery was lost.');
      expect(state.recovery).toBe(recovery);
      expect(state.refusal?.files).toBe(files);
      expect(homeOpenMachine.step(state, { type: 'recovery-result', outcome: { kind: 'encoding', encoding } })).toEqual({ kind: 'encoding', encoding });
      expect(homeOpenMachine.step(state, { type: 'recovery-result', outcome: { kind: 'opened', opened } })).toEqual({ kind: 'idle' });
      expect(homeOpenMachine.step(state, { type: 'recovery-failed' })).toEqual({ kind: 'idle' });
    });
  }

  it('clears a completed or failed recovery and its refusal before another offer', () => {
    const cleared = homeOpenMachine.step(states[2]!, { type: 'recovery-failed' });
    expect(homeOpenMachine.step(cleared, events[1]!)).toEqual({ kind: 'recovery', recovery, refusal: null });
  });

  it('clears each pending dialog on cancel and only consumes encoding or differs on resume', () => {
    for (const state of states.slice(1)) expect(homeOpenMachine.step(state, { type: 'cancel' })).toEqual({ kind: 'idle' });
    for (const state of states) {
      const resumed = homeOpenMachine.step(state, { type: 'resume' });
      if (state.kind === 'encoding' || state.kind === 'differs') expect(resumed).toEqual({ kind: 'idle' });
      else expect(resumed).toBe(state);
    }
  });

  for (const kind of ['recover', 'encoding', 'differs', 'opened'] as const) {
    it(`resumes an encoding review into ${kind}`, () => {
      const idle = homeOpenMachine.step({ kind: 'encoding', encoding }, { type: 'resume' });
      const outcome = events.find((event) => event.type === 'open-result' && event.outcome.kind === kind)!;
      const result = homeOpenMachine.step(idle, outcome);
      expect(result.kind).toBe(kind === 'recover' ? 'recovery' : kind === 'opened' ? 'idle' : kind);
      expect('refusal' in result ? result.refusal : null).toBeNull();
    });
  }
});
