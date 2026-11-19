import { expect, test } from '@playwright/test';
import { contextPreviewOf } from '../../apps/desktop/src/app/context-preview.js';
import { stepPreviewOf } from '../../apps/desktop/src/app/plan-preview.js';
import { IDS, project } from './fixtures.js';

test('the prompt preview includes codex descriptions without external research references', () => {
  const state = project();
  const entry = {
    id: 'c_0000000001', name: 'Fenn', aliases: [], type: 'character', description: 'A keeper of the tide logs.',
    includePolicy: 'always' as const, caseSensitive: false, exclude: [], attachments: [], keywords: [],
    origin: 'manual' as const, sources: [],
  };
  state.manifest.codex = [entry];
  const budgets = { layerBudgets: {} };
  const before = contextPreviewOf(state, IDS.sceneA, budgets);
  expect(JSON.stringify(before)).toContain(entry.description);
  state.manifest.codex = [{ ...entry, references: [{ id: 'ref_0000000001', title: 'Hidden', quote: 'Hidden quote', url: 'https://example.org/tides' }] }];
  expect(contextPreviewOf(state, IDS.sceneA, budgets)).toEqual(before);
});

test('an explicit reference write shows the proposed source on a confirmation card', () => {
  const preview = stepPreviewOf('codex.write', { entries: [{
    action: 'update', id: 'c_0000000001', name: 'Fenn',
    changes: [{ field: 'references', from: 'null', to: JSON.stringify([{ action: 'create', title: 'Tide Tables', publisher: 'Gull Press' }]) }],
  }] }, project());
  expect(preview).toMatchObject({
    kind: 'codex',
    entries: [{ changes: [{ field: 'External references', to: expect.stringMatching(/Tide Tables.*Gull Press/) }] }],
  });
});
