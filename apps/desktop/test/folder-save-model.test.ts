import { checkMachine } from '@caotang/machine/testing';
import { describe, expect, it } from 'vitest';

import { folderSaveMachine, stepFolderSave, type FolderSaveEvent, type FolderSaveState } from '../src/app/folder-save-model.js';

const question = { kind: 'not-empty', name: 'Manuscript' } as const;

describe('the folder save flow', () => {
  it('agrees with every declared transition', () => {
    const states: FolderSaveState[] = [
      { kind: 'idle' }, { kind: 'picking' }, { kind: 'saving' }, { kind: 'asking', question }, { kind: 'saved' },
    ];
    const events: FolderSaveEvent[] = [
      { type: 'pick' }, { type: 'save' }, { type: 'ask', question }, { type: 'saved' }, { type: 'fail' }, { type: 'cancel' },
    ];
    expect(checkMachine(folderSaveMachine, { states, events })).toEqual([]);
  });

  it('ignores repeated gestures and cancellation while writing', () => {
    const picking = stepFolderSave({ kind: 'idle' }, { type: 'pick' });
    expect(stepFolderSave(picking, { type: 'pick' })).toBe(picking);
    const saving = stepFolderSave(picking, { type: 'save' });
    for (const type of ['pick', 'save', 'cancel'] as const) {
      expect(stepFolderSave(saving, { type })).toBe(saving);
    }
  });

  it('keeps exactly one question until an answer starts the next attempt', () => {
    const asking = stepFolderSave({ kind: 'saving' }, { type: 'ask', question });
    expect(asking).toEqual({ kind: 'asking', question });
    expect(stepFolderSave(asking, { type: 'save' })).toEqual({ kind: 'saving' });
    expect(stepFolderSave(asking, { type: 'pick' })).toEqual({ kind: 'picking' });
    expect(stepFolderSave(asking, { type: 'cancel' })).toEqual({ kind: 'idle' });
  });

  it('allows another attempt after a cancelled picker, a failure or a success', () => {
    const states: FolderSaveState[] = [
      stepFolderSave({ kind: 'picking' }, { type: 'cancel' }),
      stepFolderSave({ kind: 'saving' }, { type: 'fail' }),
      stepFolderSave({ kind: 'saving' }, { type: 'saved' }),
    ];
    for (const state of states) expect(stepFolderSave(state, { type: 'pick' })).toEqual({ kind: 'picking' });
  });
});
