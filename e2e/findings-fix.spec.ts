import { expect, test } from '@playwright/test';

import { bodyOf, idOf } from './support.js';

/**
 * "Fix with agent" on a finding (coherence.md §6.3), end to end on the demo provider. The coherence review that found the contradiction
 * changed no text. The fix is an agent turn whose one step rewrites the finding's passage; the draft waits in the ghost preview, and the
 * passage changes only when the writer applies it.
 */

/** The two passages the demo review quotes (the demo scripts' statements), by document. */
const PASSAGES: Readonly<Record<string, string>> = { 'The Landing': 'The ferry was late, as always.', 'The Storm': 'The lamp failed.' };
/**
 * The passage Fix with agent rewrites (coherence.md §6.3): the finding's primary quote, the first in binder order. The sample's binder
 * puts The Landing before The Storm, so the rewrite lands there, and The Storm keeps its text.
 */
const FIXED = 'The Landing';
/** The rewrite the demo provider drafts for The Landing's statement (the demo scripts' DEMO_STATEMENTS). */
const REWRITE = 'The ferry was late, held at the mainland until the storm had passed.';

test('Fix with agent on a finding proposes a rewrite of its passage, and the text changes only when the writer applies it', async ({ page }) => {
  await page.goto('/');
  // The sample opens with the read-only continuity check; the model review, which finds the contradiction with its passages, is a
  // typed request, and its card is approved here.
  await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  const intent = page.getByRole('combobox', { name: 'Intent' });
  await expect(intent).toBeEnabled();
  await intent.fill('Review the manuscript for contradictions.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByTestId('plan-card').getByRole('button', { name: 'Approve', exact: true }).click();

  await page.getByRole('tab', { name: 'Findings' }).click();
  const finding = page.locator('article.finding').first();
  await expect(finding).toBeVisible();

  const titles = Object.keys(PASSAGES);
  const ids = Object.fromEntries(await Promise.all(titles.map(async (title) => [title, await idOf(page, title)] as const)));
  const before = Object.fromEntries(await Promise.all(titles.map(async (title) => [title, (await bodyOf(page, ids[title]!)) ?? ''] as const)));
  for (const title of titles) expect(before[title]).toContain(PASSAGES[title]);

  await finding.getByRole('button', { name: 'Fix with agent', exact: true }).click();

  // The fix is a turn in the agent: one scene draft over the passage, which the writer decides on in the ghost preview.
  await expect(page.getByTestId('ghost-bar')).toBeVisible();
  // The note under the finding promises no card: the demo answers this passage, but the note cannot know that when it is written.
  await expect(finding.getByRole('status')).toHaveText('The fix has started in the agent panel. Its outcome shows there.');
  await expect(page.getByTestId('ghost-bar').getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
  for (const title of titles) expect(await bodyOf(page, ids[title]!)).toBe(before[title]);

  await page.getByTestId('ghost-bar').getByRole('button', { name: 'Apply', exact: true }).click();
  // The finding quotes both passages and the fix rewrites the one binder order picks, The Landing. Its passage is gone and the rewrite is
  // in its place; The Storm is unchanged.
  await expect.poll(async () => ((await bodyOf(page, ids[FIXED]!)) ?? '').includes(REWRITE)).toBe(true);
  expect((await bodyOf(page, ids[FIXED]!)) ?? '').not.toContain(PASSAGES[FIXED]!);
  for (const title of titles.filter((other) => other !== FIXED)) expect(await bodyOf(page, ids[title]!)).toBe(before[title]);
});
