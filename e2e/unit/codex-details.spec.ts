import { expect, test } from '@playwright/test';
import { contextPreviewOf } from '../../apps/desktop/src/app/context-preview.js';
import { NEW_ENTRY_FROM, stepPreviewOf } from '../../apps/desktop/src/app/plan-preview.js';
import { IDS, project } from './fixtures.js';

test('the prompt preview includes an Always entry without its detail values or labels', () => {
  const state = project();
  state.manifest.codex = [{
    id: 'c_0000000001', name: 'Fenn', aliases: [], type: 'Guest', description: 'A keeper of the tide logs.',
    includePolicy: 'always', caseSensitive: false, exclude: [], attachments: [], keywords: [], origin: 'manual', sources: [],
  }];
  const budgets = { layerBudgets: {} };
  const baseline = contextPreviewOf(state, IDS.sceneA, budgets);
  expect(baseline.kind).toBe('prompt');
  expect(JSON.stringify(baseline)).toContain('A keeper of the tide logs.');
  state.manifest.codexDetailFields = [{ type: 'Guest', key: 'affiliation', label: 'Hidden field label', kind: 'text' }];
  const entry = state.manifest.codex[0];
  if (entry === undefined) throw new Error('missing fixture entry');
  entry.details = { affiliation: 'Hidden detail value' };
  expect(contextPreviewOf(state, IDS.sceneA, budgets)).toEqual(baseline);
});

test('an explicit detail write shows the fields being proposed before approval', () => {
  const preview = stepPreviewOf('codex.write', {
    entries: [
      { action: 'create', name: 'Fenn', details: { episode: 3, note: '' } },
      { action: 'update', id: 'c_0000000001', name: 'Tess', changes: [{ field: 'details.note', from: '""', to: 'null' }] },
    ],
  }, project());
  expect(preview).toMatchObject({
    kind: 'codex',
    entries: [
      { changes: expect.arrayContaining([
        { field: 'Details: episode', from: NEW_ENTRY_FROM, to: '3' },
        { field: 'Details: note', from: NEW_ENTRY_FROM, to: 'Empty text' },
      ]) },
      { changes: [{ field: 'Details: note', from: 'Empty text', to: '(none)' }] },
    ],
  });
});
