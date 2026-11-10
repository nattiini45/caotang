import { describe, expect, it } from 'vitest';
import { checkMachine } from '@caotang/machine/testing';
import { exportCompileMachine, exportReadinessMachine, type CompileState, type ExportReadinessState } from '../src/app/export-dialog-model.js';

describe('export dialog lifecycle', () => {
  it('exhaustively checks the compile table, including failed retries and unlisted events', () => {
    expect(checkMachine(exportCompileMachine, {
      states: [{ kind: 'idle' }, { kind: 'running' }, { kind: 'failed', failure: { text: 'Refused', hookRequest: 'request' } }],
      events: [{ type: 'start' }, { type: 'reset' }, { type: 'succeeded' }, { type: 'failed', failure: { text: 'Refused' } }],
    })).toEqual([]);
  });

  it('starts only one compile, retains its failure and clears it on retry or editing', () => {
    let state: CompileState = exportCompileMachine.step({ kind: 'idle' }, { type: 'start' });
    expect(exportCompileMachine.step(state, { type: 'start' })).toBe(state);
    expect(exportCompileMachine.step(state, { type: 'reset' })).toBe(state);
    state = exportCompileMachine.step(state, { type: 'failed', failure: { text: 'Try again', hookRequest: 'request' } });
    expect(state).toEqual({ kind: 'failed', failure: { text: 'Try again', hookRequest: 'request' } });
    expect(exportCompileMachine.step(state, { type: 'reset' })).toEqual({ kind: 'idle' });
    state = exportCompileMachine.step(state, { type: 'start' });
    expect(state).toEqual({ kind: 'running' });
    expect(exportCompileMachine.step(state, { type: 'succeeded' })).toEqual({ kind: 'idle' });
  });

  it('exhaustively checks readiness with current and stale results', () => {
    expect(checkMachine(exportReadinessMachine, {
      states: [
        { kind: 'waiting', request: 1 }, { kind: 'waiting', request: 2 },
        { kind: 'ready', request: 1 }, { kind: 'ready', request: 2 },
        { kind: 'failed', request: 1, message: 'Not ready' }, { kind: 'failed', request: 2, message: 'Not ready' },
      ],
      events: [
        { type: 'check', request: 1 }, { type: 'check', request: 2 }, { type: 'check', request: 3 },
        { type: 'ready', request: 1 }, { type: 'ready', request: 2 },
        { type: 'failed', request: 1, message: 'Not ready' }, { type: 'failed', request: 2, message: 'Not ready' },
      ],
    })).toEqual([]);
  });

  it('resets a failed preview before retrying and ignores an older readiness completion', () => {
    let state: ExportReadinessState = { kind: 'failed', request: 1, message: 'Not ready' };
    state = exportReadinessMachine.step(state, { type: 'check', request: 2 });
    expect(state).toEqual({ kind: 'waiting', request: 2 });
    expect(exportReadinessMachine.step(state, { type: 'ready', request: 1 })).toBe(state);
    expect(exportReadinessMachine.step(state, { type: 'failed', request: 1, message: 'Old failure' })).toBe(state);
    state = exportReadinessMachine.step(state, { type: 'ready', request: 2 });
    expect(state).toEqual({ kind: 'ready', request: 2 });
    expect(exportReadinessMachine.step(state, { type: 'failed', request: 2, message: 'Late failure' })).toBe(state);
  });
});
