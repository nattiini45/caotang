/**
 * The views that load when they are first opened (lazy-view.tsx): the storyboard, the dialogue container and Settings. A writer sees a
 * status line while the code arrives, and a sentence with Try again and Reload when it does not, never a blank pane. The dev server
 * serves each view as its own module, so a request for one can be held or refused here; prod-smoke.spec.ts checks the same on the
 * built app, where the pieces are hashed chunks.
 */

import { expect, test, type Page } from '@playwright/test';

import { binderTitle, createProject, firstChapter } from './support.js';

const STORYBOARD_MODULE = '**/src/media/StoryboardView.tsx*';
const PROMPT_PACK_MODULE = '**/src/media/PromptPackPanel.tsx*';

/** Makes a storyboard from the context menu of the manuscript's first chapter; the new node is selected and its view opens. */
async function makeStoryboard(page: Page): Promise<void> {
  await binderTitle(page, await firstChapter(page)).click({ button: 'right' });
  await page.getByRole('menu', { name: 'Actions for Chapter 1' }).getByRole('menuitem', { name: 'New storyboard here' }).click();
  await page.keyboard.press('Escape');
}

test('a view says it is loading while its code arrives, then opens', async ({ page }) => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await createProject(page, 'Loading Lines');
  await page.route(STORYBOARD_MODULE, async (route) => {
    await held;
    await route.continue();
  });
  await makeStoryboard(page);
  await expect(page.getByRole('status').filter({ hasText: 'Loading Storyboard' })).toBeVisible();
  release();
  await expect(page.getByRole('region', { name: 'Storyboard: Storyboard' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Loading Storyboard' })).toHaveCount(0);
});

test('a view whose code cannot be fetched says so, leaves the rest of the app working, and opens again after Reload', async ({ page }) => {
  await createProject(page, 'Offline Board');
  await page.route(STORYBOARD_MODULE, (route) => route.abort());
  await makeStoryboard(page);

  const failure = page.getByRole('alert').filter({ hasText: 'Storyboard could not be loaded' });
  await expect(failure).toBeVisible();
  await expect(failure.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(failure.getByRole('button', { name: 'Reload' })).toBeVisible();
  // The binder still answers, so the writer can leave the item.
  await binderTitle(page, await firstChapter(page)).click();
  await expect(failure).toHaveCount(0);

  // The code is reachable again. Some browsers retry a failed import and open the board; Chromium keeps the failure for the life of
  // the page and says so. Either way the pane is never blank, and Reload gets the board.
  await page.unroute(STORYBOARD_MODULE);
  await binderTitle(page, 'Storyboard').click();
  await page.getByRole('button', { name: 'Try again' }).click();
  const board = page.getByRole('region', { name: 'Storyboard: Storyboard' });
  const still = page.getByRole('alert').filter({ hasText: 'Storyboard still could not be loaded' });
  await expect(board.or(still)).toBeVisible();
  if (await still.isVisible()) {
    await still.getByRole('button', { name: 'Reload' }).click();
    await page.getByRole('listitem').filter({ hasText: 'Offline Board' }).getByRole('button', { name: 'Open' }).click();
    await binderTitle(page, 'Storyboard').click();
  }
  await expect(board).toBeVisible();
});

test('the prompt pack tab fails on its own without taking the board with it', async ({ page }) => {
  await createProject(page, 'Pack Tab');
  await makeStoryboard(page);
  await expect(page.getByRole('region', { name: 'Storyboard: Storyboard' })).toBeVisible();

  await page.route(PROMPT_PACK_MODULE, (route) => route.abort());
  await page.getByRole('radio', { name: 'Prompt pack' }).click();
  const failure = page.getByRole('alert').filter({ hasText: 'The prompt pack could not be loaded' });
  await expect(failure).toBeVisible();
  // The board's header and its tabs are still there: only the tab's body failed.
  await expect(page.getByRole('region', { name: 'Storyboard: Storyboard' })).toBeVisible();
  await page.getByRole('radio', { name: 'Board', exact: true }).click();
  await expect(failure).toHaveCount(0);
  await expect(page.getByRole('radio', { name: 'Board', exact: true })).toBeChecked();
});
