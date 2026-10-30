import { expect, test } from '@playwright/test';

import { scanForInjection } from '../../packages/context/src/index.js';

import { sampleProjectState } from '../../apps/desktop/src/app/demo.js';

/**
 * The scan for instruction-shaped text that runs at import (issue #54) must not cry wolf: the sample manuscript, which the first-run
 * card opens for every new writer, has nothing in it for the scan to report. Run without a browser: the scan is a pure function.
 */

test('the scan finds nothing in the sample manuscript: its titles, synopses, bodies and codex entries', () => {
  const state = sampleProjectState();
  const texts = [
    ...state.manifest.tree.flatMap((node) => [node.title, node.synopsis, node.notes, ...node.keywords]),
    ...[...state.documents.values()].map((record) => record.body),
    ...(state.manifest.codex ?? []).flatMap((entry) => [entry.name, entry.description, ...entry.aliases]),
  ];
  expect(texts.length).toBeGreaterThan(5);
  for (const text of texts) expect(scanForInjection(text), text).toEqual([]);
});
