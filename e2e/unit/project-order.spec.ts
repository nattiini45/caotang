import { expect, test } from '@playwright/test';

import { projectOrder, type ProjectSummary } from '../../apps/desktop/src/app/lifecycle.js';

/**
 * The projects screen's order (i18n.md §4.3): UI rows sort with the formatter locale, and the id breaks a tie so the order is
 * total. This is a model test because the projects list itself needs a store; the ordering is the part the locale changes.
 */
function summary(id: string, name: string): ProjectSummary {
  return { id, name, documents: 0, words: 0 };
}

test('the projects screen sorts by name in the formatter locale, and names equal under it sort by id', () => {
  const rows = [summary('p_B', 'Zebra'), summary('p_A', 'Åland'), summary('p_C', 'Zebra')];

  // D9's direction for writer content, here for the UI list: under a Swedish formatter å follows z.
  expect([...rows].sort((a, b) => projectOrder(a, b, 'sv')).map((row) => row.name)).toEqual(['Zebra', 'Zebra', 'Åland']);
  expect([...rows].sort((a, b) => projectOrder(a, b, 'en')).map((row) => row.name)).toEqual(['Åland', 'Zebra', 'Zebra']);

  // The two Zebras are equal under the collator, so the id decides and the order does not depend on the input order.
  expect([...rows].sort((a, b) => projectOrder(a, b, 'sv')).map((row) => row.id)).toEqual(['p_B', 'p_C', 'p_A']);
  expect([...rows].reverse().sort((a, b) => projectOrder(a, b, 'sv')).map((row) => row.id)).toEqual(['p_B', 'p_C', 'p_A']);
});
