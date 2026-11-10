import { describe, expect, it } from 'vitest';
import { checkMachine } from '@caotang/machine/testing';
import { writerStopMachine } from '../src/writer-stop.js';

describe('the folder writer stop', () => {
  it('agrees with its table for every stop cause and event', () => {
    expect(checkMachine(writerStopMachine, {
      states: [
        { kind: 'open' },
        { kind: 'drift', cause: 'changed a document' },
        { kind: 'saved-drift', cause: 'changed the manifest after saving' },
        { kind: 'partial', recovery: 'read the timeline again' },
      ],
      events: [
        { type: 'drift', cause: 'changed a document', saved: false },
        { type: 'drift', cause: 'changed the manifest after saving', saved: true },
        { type: 'partial', recovery: 'read the timeline again' },
      ],
    })).toEqual([]);
  });

  it('keeps the first stop cause when a timeline write reports partial', () => {
    const drift = writerStopMachine.step({ kind: 'open' }, { type: 'drift', cause: 'changed a document', saved: true });
    const partial = writerStopMachine.step(drift, { type: 'partial', recovery: 'read the timeline again' });
    expect(partial).toEqual({ kind: 'saved-drift', cause: 'changed a document', recovery: 'read the timeline again' });
    expect(writerStopMachine.step(partial, { type: 'drift', cause: 'another change', saved: false })).toBe(partial);
  });
});
