import { expect, test, type Page } from '@playwright/test';

import { fakeEndpoint, planThenAnswer, useFakeEndpoint } from './endpoint.js';
import { bodyOf, idOf, waitForSaved, loose } from './support.js';

/**
 * The first-run card (context-assembly §6): the three demo intents, each run end to end on the built-in demo provider with
 * no key configured. Nothing here types a key or touches Settings, so the agent that answers is the mock one.
 */

const FRIEND_OPENING = 'The ferry came in on the evening tide';

/** The card's button for one demo, by its label. */
function demo(page: Page, label: string) {
  return page.getByRole('button', { name: label, exact: true });
}

test('the first-run card shows the three demo intents, and the agent names the demo provider', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('first-run')).toBeVisible();
  await expect(demo(page, 'Draft the opening scene')).toBeVisible();
  await expect(demo(page, 'Fill in the synopses')).toBeVisible();
  await expect(demo(page, 'Check for continuity problems')).toBeVisible();

  await demo(page, 'Check for continuity problems').click();
  // The demo profile's name already says it is a demo, so the label carries that once.
  await expect(page.getByTestId('agent-provider')).toHaveText(loose('Provider: Demo (no key)', true));
});

test('drafting the opening scene of The Friend runs end to end with no key: one card, a draft in the editor, and the text written on approval', async ({
  page,
}) => {
  await page.goto('/');
  await demo(page, 'Draft the opening scene').click();

  // The agent proposes one write, so it shows a one-step card, and the draft waits in the editor's ghost preview.
  const card = page.getByTestId('plan-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('scene.draft');
  await expect(page.getByTestId('ghost-bar')).toBeVisible();

  // Nothing is written until the writer applies it.
  const friend = await idOf(page, 'The Friend');
  expect(await bodyOf(page, friend)).toBe('');

  await page.getByTestId('ghost-bar').getByRole('button', { name: 'Apply', exact: true }).click();

  await expect(page.getByTestId('checkpoint')).toBeVisible();
  await expect.poll(async () => (await bodyOf(page, friend)) ?? '').toContain(FRIEND_OPENING);
  await expect(page.getByTestId('ghost-bar')).toHaveCount(0);
  await expect(page.locator('.agent-report')).toContainText('Applied:');
});

test('a draft the writer applied is kept by the browser: after a reload the sample still holds it', async ({ page }) => {
  await page.goto('/');
  await demo(page, 'Draft the opening scene').click();
  await expect(page.getByTestId('ghost-bar')).toBeVisible();
  await page.getByTestId('ghost-bar').getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByTestId('checkpoint')).toBeVisible();
  await waitForSaved(page);

  await page.reload();
  await page.getByRole('button', { name: 'Open', exact: true }).first().click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  await page.getByRole('treeitem', { name: /The Friend/ }).locator('.row-title').click();
  await expect(page.getByRole('textbox', { name: 'Document text' })).toContainText(FRIEND_OPENING);
});

test('filling the synopses of Chapter 1 runs end to end with no key: one batched card, and the synopses are set on approval', async ({
  page,
}) => {
  await page.goto('/');
  await demo(page, 'Fill in the synopses').click();

  const card = page.getByTestId('plan-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('synopsis.fill');
  await card.getByRole('button', { name: 'Approve', exact: true }).click();

  await expect(page.getByTestId('checkpoint')).toBeVisible();
  await expect.poll(() => synopsisOf(page, 'The Landing')).toMatch(/^Elena comes back/);
  await expect.poll(() => synopsisOf(page, 'The Storm')).toMatch(/^A storm takes the lamp/);
});

/** The synopsis of a binder node, as the project holds it now. */
async function synopsisOf(page: Page, title: string): Promise<string> {
  const found = await page.evaluate((wanted) => {
    const caotang = (globalThis as unknown as { __caotang?: { tree(): { title: string; synopsis: string }[] } }).__caotang;
    return caotang?.tree().find((row) => row.title === wanted)?.synopsis ?? null;
  }, title);
  return found ?? '';
}

test('the demo intents run on the built-in demo profile, and an endpoint that is active is never sent them', async ({ page }) => {
  let requests = 0;
  await fakeEndpoint(page, (request) => {
    requests += 1;
    return planThenAnswer({ steps: [] }, 'Not used.')(request);
  });
  await useFakeEndpoint(page);
  requests = 0;

  await demo(page, 'Draft the opening scene').click();
  await expect(page.getByTestId('ghost-bar')).toBeVisible();
  expect(requests).toBe(0);
  // The header names the active provider, and the turn names the one it ran on.
  await expect(page.getByTestId('agent-provider')).toHaveText(loose('Provider: Fake endpoint', true));
  await expect(page.locator('.agent-turn').first()).toContainText('Ran on Demo (no key)');
});

test('checking for continuity problems is a read: no card, the finding in the reply, and the finding in the Findings inbox', async ({ page }) => {
  await page.goto('/');
  await demo(page, 'Check for continuity problems').click();

  // The scan reads the manuscript and writes its findings to the inbox, so no card is shown and nothing in the text changes.
  const report = page.locator('.agent-report');
  await expect(report).toContainText('Found 1 continuity finding');
  await expect(page.getByTestId('plan-card')).toHaveCount(0);
  await expect(page.getByTestId('checkpoint')).toHaveCount(0);

  await page.getByRole('tab', { name: 'Findings' }).click();
  await expect(page.getByTestId('findings-open')).toHaveText('1 open');
  await expect(page.locator('article.finding')).toHaveCount(1);
});

test('a draft streams into the scene’s ghost preview as it is written, and reaches the text only on Apply', async ({ page }) => {
  await page.goto('/');
  // Record the length of the ghost's text at each change while the draft arrives: one value per chunk the stream delivers.
  await page.evaluate(() => {
    const seen: number[] = [];
    (globalThis as unknown as { __ghostSeen: number[] }).__ghostSeen = seen;
    new MutationObserver(() => {
      const length = document.querySelector('.caotang-editor-ghost')?.textContent?.length ?? 0;
      if (length > 0 && seen.at(-1) !== length) seen.push(length);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });

  await demo(page, 'Draft the opening scene').click();
  await expect(page.getByTestId('ghost-bar')).toBeVisible();
  const friend = await idOf(page, 'The Friend');
  await expect(page.getByTestId('ghost-bar').getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();

  // The text is still only in the preview: the document is empty until the writer applies it.
  expect(await bodyOf(page, friend)).toBe('');
  await expect(page.locator('.caotang-editor-ghost')).toContainText(FRIEND_OPENING);
  // The ghost grew over several changes, each longer than the last, so the draft arrived in pieces and was not shown whole at once.
  const seen = await page.evaluate(() => (globalThis as unknown as { __ghostSeen: number[] }).__ghostSeen);
  expect(seen.length).toBeGreaterThan(3);
  expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  expect(seen[0]).toBeLessThan(seen.at(-1) ?? 0);

  await page.getByTestId('ghost-bar').getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(async () => (await bodyOf(page, friend)) ?? '').toContain(FRIEND_OPENING);
});
