import { describe, expect, it } from 'vitest';
import { checkMachine } from '@caotang/machine/testing';
import { sessionSelectionMachine, type SessionSelection } from '../src/app/agent-session-state.js';

describe('serialized session selection', () => {
  it('agrees with every registered state/event pair', () => {
    expect(checkMachine(sessionSelectionMachine, {
      states: [{ kind: 'unloaded' }, { kind: 'ready' }, { kind: 'loading', request: 1 }, { kind: 'failed', message: 'disk' }],
      events: [{ type: 'load', request: 1 }, { type: 'load', request: 2 }, { type: 'loaded', request: 1 }, { type: 'loaded', request: 2 }, { type: 'failed', request: 1, message: 'disk' }, { type: 'failed', request: 2, message: 'disk' }],
    })).toEqual([]);
  });

  it('ignores concurrent actions and stale results, and can retry a failed load', () => {
    let state: SessionSelection = { kind: 'unloaded' };
    state = sessionSelectionMachine.step(state, { type: 'load', request: 1 });
    expect(sessionSelectionMachine.step(state, { type: 'load', request: 2 })).toBe(state);
    expect(sessionSelectionMachine.step(state, { type: 'loaded', request: 0 })).toBe(state);
    state = sessionSelectionMachine.step(state, { type: 'failed', request: 1, message: 'Keep the current session.' });
    expect(state).toEqual({ kind: 'failed', message: 'Keep the current session.' });
    state = sessionSelectionMachine.step(state, { type: 'load', request: 2 });
    expect(sessionSelectionMachine.step(state, { type: 'loaded', request: 1 })).toBe(state);
    expect(sessionSelectionMachine.step(state, { type: 'loaded', request: 2 })).toEqual({ kind: 'ready' });
  });
});
