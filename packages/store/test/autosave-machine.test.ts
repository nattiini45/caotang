import { describe, expect, it } from 'vitest';
import { checkMachine } from '@caotang/machine/testing';
import {
  autosaveMachine, autosaveSlot, stepAutosave, type AutosaveSlot, type AutosaveSlotEvent,
} from '../src/runtime/autosave-machine.js';

const error = new Error('write refused');
const source = (): string => 'draft';
const seed = autosaveSlot('stored', 3);
const pending = stepAutosave(seed, { type: 'edit', source }).slot;
const saving = stepAutosave(pending, { type: 'take', source, body: 'draft' }).slot;

describe('the document autosave machine', () => {
  it('agrees with every registered transition, including payload and re-entry variants', () => {
    const states: AutosaveSlot[] = [seed, pending, saving,
      stepAutosave(saving, { type: 'edit', source: 'newer' }).slot,
      stepAutosave(saving, { type: 'write-failed', error, conflict: false }).slot,
      stepAutosave(saving, { type: 'write-failed', error, conflict: true }).slot,
      stepAutosave(pending, { type: 'produce', forWrite: true }).slot,
      stepAutosave(saving, { type: 'reseat' }).slot,
    ];
    const events: AutosaveSlotEvent[] = [
      { type: 'open', body: 'reopened', revision: 7 }, { type: 'reseated', body: 'restored', revision: 7 },
      { type: 'edit', source }, { type: 'edit', source: 'newer' },
      { type: 'cancel-window' }, { type: 'window-fired' }, { type: 'reset-budget' }, { type: 'reseat' },
      { type: 'produce', forWrite: true }, { type: 'produce', forWrite: false },
      { type: 'produced', source, result: { ok: true, body: 'draft' } },
      { type: 'produced', source, result: { ok: false, error } },
      { type: 'produced', source: 'superseded', result: { ok: true, body: 'old' } },
      { type: 'read-failed', error }, { type: 'producer-failed', error },
      { type: 'take', source, body: 'draft' }, { type: 'take', source, body: 'stored' },
      { type: 'take', source: 'superseded', body: 'stored' }, { type: 'written', revision: 4 },
      { type: 'write-failed', error, conflict: false }, { type: 'write-failed', error, conflict: true },
    ];
    for (const state of states) Object.freeze(state);
    expect(checkMachine(autosaveMachine, { states, events })).toEqual([]);
  });

  it('describes the debounce and write as effects without calling a producer', () => {
    const throwing = (): string => { throw new Error('not an effect interpreter'); };
    const edit = stepAutosave(seed, { type: 'edit', source: throwing });
    expect(edit.effects).toEqual([{ type: 'arm-window' }, { type: 'notify' }]);
    const write = stepAutosave(edit.slot, { type: 'take', source: throwing, body: 'draft' });
    expect(write.effects).toEqual([
      { type: 'notify' }, { type: 'write', body: 'draft', before: 'stored', revision: 3 },
    ]);
    expect(seed).toEqual(autosaveSlot('stored', 3));
  });

  it('keeps the newer body and its own window on a conflict, without arming a retry', () => {
    const edited = stepAutosave(saving, { type: 'edit', source: 'newest' }).slot;
    const failed = stepAutosave(edited, { type: 'write-failed', error, conflict: true });
    expect(failed.slot).toMatchObject({ kind: 'conflict', revision: 3,
      pending: { source: 'newest', body: 'newest' }, scheduled: true, lastError: error });
    expect(failed.effects).toEqual([{ type: 'notify' }]);
    const reseating = stepAutosave(failed.slot, { type: 'reseat' }).slot;
    const rebased = stepAutosave(reseating, { type: 'reseated', body: 'restored', revision: 9 });
    expect(rebased.slot).toMatchObject({ kind: 'clean', revision: 9, pending: null, lastError: null });
  });

  it('arms exactly one producer retry and drains a newer edit only when its window expired', () => {
    let slot = stepAutosave(pending, { type: 'produce', forWrite: true }).slot;
    slot = stepAutosave(slot, { type: 'produced', source, result: { ok: false, error } }).slot;
    const first = stepAutosave(slot, { type: 'producer-failed', error });
    expect(first.slot.kind).toBe('pending');
    expect(first.effects).toEqual([{ type: 'arm-window' }, { type: 'notify' }]);
    slot = stepAutosave(first.slot, { type: 'produce', forWrite: true }).slot;
    const second = stepAutosave(slot, { type: 'producer-failed', error });
    expect(second.slot.kind).toBe('error');
    expect(second.effects).toEqual([{ type: 'notify' }]);
    const newer = stepAutosave(saving, { type: 'edit', source: 'newest' }).slot;
    expect(stepAutosave(newer, { type: 'written', revision: 4 }).effects).toEqual([{ type: 'notify' }]);
    const expired = stepAutosave(newer, { type: 'window-fired' }).slot;
    expect(stepAutosave(expired, { type: 'written', revision: 4 }).effects)
      .toEqual([{ type: 'notify' }, { type: 'drain' }]);
  });
});
