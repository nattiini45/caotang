import { describe, expect, it } from 'vitest';
import { checkMachine } from '@caotang/machine/testing';

import { importPreviewMachine, stepImportPreview, type ImportPreviewEvent, type ImportPreviewPhase } from '../src/import-preview/phase.js';

const states: ImportPreviewPhase[] = [
  { kind: 'loading', progress: 'Reading…' }, { kind: 'failed', message: 'Unreadable.' }, { kind: 'ready' },
  { kind: 'committing' }, { kind: 'commit-failed', message: 'Refused.' }, { kind: 'closed', committed: false }, { kind: 'closed', committed: true },
];
const events: ImportPreviewEvent[] = [
  { type: 'progress', progress: 'Halfway…' }, { type: 'loaded' }, { type: 'load-failed', message: 'Unreadable.' },
  { type: 'commit' }, { type: 'commit-failed', message: 'Refused.' }, { type: 'committed' }, { type: 'cancel' },
];

describe('UI-12 import preview phase', () => {
  it('agrees with every table row and ignores unlisted events by identity', () => {
    expect(checkMachine(importPreviewMachine, { states, events })).toEqual([]);
  });

  it('allows retry or cancellation after failure, but neither cancellation nor a second commit during a write', () => {
    const committing = stepImportPreview({ kind: 'ready' }, { type: 'commit' });
    expect(stepImportPreview(committing, { type: 'cancel' })).toBe(committing);
    expect(stepImportPreview(committing, { type: 'commit' })).toBe(committing);
    const failed = stepImportPreview(committing, { type: 'commit-failed', message: 'Refused.' });
    expect(stepImportPreview(failed, { type: 'commit' })).toEqual({ kind: 'committing' });
    expect(stepImportPreview(failed, { type: 'cancel' })).toEqual({ kind: 'closed', committed: false });
  });
});
