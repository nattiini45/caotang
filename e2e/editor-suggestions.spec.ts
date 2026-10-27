import { expect, test, type Page } from '@playwright/test';

import { fakeEndpoint, planThenAnswer, useFakeEndpoint } from './endpoint.js';
import { bodyOf, idOf, waitForSaved } from './support.js';

/**
 * Apply-then-review (editor-engine §15): with Settings > Writing set to mark the changes for review, an approved agent edit keeps the
 * agent's text in the scene and marks what it changed, and the writer keeps or puts back each change. The text is already saved when the
 * marks appear, so the stored body is the accepted text throughout; rejecting a change is what edits it.
 *
 * The agent is the fake endpoint's (endpoint.ts), which rewrites the sentence the writer selected in one scene, changing two words. The
 * marks, the review bar, the turn card and the store are the app's own.
 */

const BEFORE = 'The harbour was quiet and the tide was slow.';
const REWRITE = 'The harbour was silent and the tide was late.';

const PLAN = {
  steps: [
    {
      tool: 'scene.draft',
      params: {
        doc: 'The Friend',
        instruction: 'Reword the sentence.',
        mode: 'rewrite_selection',
        selection: { from: 0, to: BEFORE.length, exact: BEFORE, prefix: '', suffix: '', capturedRevision: 0 },
      },
      expect: 'The Friend is reworded',
    },
  ],
};

/** Settings > Writing, set to mark the changes for review, saved, and closed. */
async function markChangesForReview(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Writing' }).click();
  await settings.getByRole('combobox', { name: 'When you apply an agent edit' }).selectOption('suggestions');
  await settings.getByRole('button', { name: 'Save writing settings' }).click();
  await expect(settings.getByText(/Saved\./)).toBeVisible();
  await settings.getByRole('button', { name: 'Close' }).click();
}

/** The sample project, open on The Friend with its sentence typed, saved and selected. */
async function openFriendWithText(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  await page.getByRole('treeitem', { name: /The Friend/ }).locator('.row-title').click();
  await page.getByRole('textbox', { name: 'Document text' }).click();
  await page.keyboard.type(BEFORE);
  await waitForSaved(page);
  await page.keyboard.press('Control+A');
  return idOf(page, 'The Friend');
}

/** Sends the intent and approves the plan once its draft is on screen. */
async function applyRewrite(page: Page): Promise<void> {
  const field = page.getByRole('combobox', { name: 'Intent' });
  await expect(field).toBeEnabled();
  await field.fill('Reword the sentence in The Friend.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('ghost-bar')).toContainText('The Friend');
  await page.getByTestId('plan-card').getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByTestId('checkpoint')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await fakeEndpoint(page, planThenAnswer(PLAN, 'Reworded.', REWRITE));
  await useFakeEndpoint(page);
  await markChangesForReview(page);
});

test('an applied rewrite is marked word by word, the text is already saved, and each change can be put back or kept', async ({ page }) => {
  const friend = await openFriendWithText(page);
  await applyRewrite(page);

  const bar = page.getByTestId('review-bar');
  await expect(bar).toContainText('2 suggestions pending review');
  await expect(page.getByTestId('turn-review')).toContainText('2 suggestions pending review');
  // Only the changed words are marked, and the store already holds the agent's text.
  const surface = page.getByRole('textbox', { name: 'Document text' });
  await expect(surface.locator('del')).toContainText(['quiet', 'slow']);
  await expect(surface.locator('ins')).toContainText(['silent', 'late']);
  expect(await bodyOf(page, friend)).toBe(`${REWRITE}\n`);
  // The app's CSP has no unsafe-inline, so a mark must not carry a style attribute.
  await expect(surface.locator('ins[style], del[style]')).toHaveCount(0);

  // Reject the first change from the keyboard-reachable bar: Next selects it, Reject puts its word back and saves that as an edit.
  await surface.press('Control+Home');
  await bar.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(bar).toContainText('1 of 2');
  await bar.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(bar).toContainText('1 suggestion pending review');
  await expect.poll(async () => (await bodyOf(page, friend)) ?? '').toBe('The harbour was quiet and the tide was late.\n');

  // Keep the rest: nothing the store holds changes, and the bar goes.
  await bar.getByRole('button', { name: 'Accept all', exact: true }).click();
  await expect(bar).toHaveCount(0);
  await expect(page.getByTestId('turn-review')).toHaveCount(0);
  await waitForSaved(page);
  expect(await bodyOf(page, friend)).toBe('The harbour was quiet and the tide was late.\n');
  await expect(surface.locator('ins, del')).toHaveCount(0);
});

test('the turn card keeps or puts back every change of the turn at once', async ({ page }) => {
  const friend = await openFriendWithText(page);
  await applyRewrite(page);
  const review = page.getByTestId('turn-review');
  await expect(review).toContainText('2 suggestions pending review');
  await review.getByRole('button', { name: 'Reject all', exact: true }).click();
  await expect(review).toHaveCount(0);
  await expect.poll(async () => (await bodyOf(page, friend)) ?? '').toBe(`${BEFORE}\n`);
});

test('reloading with changes still marked keeps the agent’s text and says so once', async ({ page }) => {
  const friend = await openFriendWithText(page);
  await applyRewrite(page);
  await expect(page.getByTestId('review-bar')).toContainText('2 suggestions pending review');
  await waitForSaved(page);

  await page.reload();
  await page.getByRole('listitem').filter({ hasText: 'Sample manuscript' }).getByRole('button', { name: 'Open' }).click();
  await page.getByRole('treeitem', { name: /The Friend/ }).locator('.row-title').click();

  await expect(page.getByText(/2 suggestions from the last agent turn were kept as written on reload/)).toBeVisible();
  await expect(page.getByTestId('review-bar')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Document text' }).locator('ins, del')).toHaveCount(0);
  expect(await bodyOf(page, friend)).toBe(`${REWRITE}\n`);
});
