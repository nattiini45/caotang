/**
 * The views that load when they are first opened (lazy-view.tsx): the storyboard, the dialogue container and Settings. The Ink compiler is
 * a download of its own (ink-compiler.ts): the dialogue view and the Inspector wait for it with a status line, and say so when it fails. A writer sees a
 * status line while the code arrives, and a sentence with Try again and Reload when it does not, never a blank pane. The dev server
 * serves each view as its own module, so a request for one can be held or refused here; prod-smoke.spec.ts checks the same on the
 * built app, where the pieces are hashed chunks.
 */

import { expect, test, type Page } from '@playwright/test';

import { binderTitle, createProject, firstChapter, waitForSaved } from './support.js';

const STORYBOARD_MODULE = '**/src/media/StoryboardView.tsx*';
const PROMPT_PACK_MODULE = '**/src/media/PromptPackPanel.tsx*';
/** The Ink compiler (inkjs), which the dev server serves as one pre-bundled module. */
const INK_COMPILER_MODULE = '**/.vite/deps/inkjs_full*';

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

/** Makes a dialogue container from the context menu of the manuscript's first chapter; the new node is selected. */
async function makeDialogue(page: Page): Promise<void> {
  await binderTitle(page, await firstChapter(page)).click({ button: 'right' });
  await page.getByRole('menu', { name: 'Actions for Chapter 1' }).getByRole('menuitem', { name: 'New dialogue here' }).click();
  await page.keyboard.press('Escape');
}

test('the dialogue view says the Ink compiler is loading while it arrives, then opens and checks the Ink', async ({ page }) => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await createProject(page, 'Compiler Wait');
  await page.route(INK_COMPILER_MODULE, async (route) => {
    await held;
    await route.continue();
  });
  await makeDialogue(page);
  await expect(page.getByRole('status').filter({ hasText: 'Loading the Ink compiler' }).first()).toBeVisible();
  await expect(page.getByRole('region', { name: 'Dialogue: Untitled dialogue' })).toHaveCount(0);
  release();
  await expect(page.getByRole('region', { name: 'Dialogue: Untitled dialogue' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Loading the Ink compiler' })).toHaveCount(0);
  // The compiler answers: the Inspector's counts are read from it.
  await expect(page.getByLabel('Structure of the container')).toBeVisible();
});

test('a compiler that cannot be fetched says so, offers Try again and Reload, and leaves the rest of the app working', async ({ page }) => {
  await createProject(page, 'Compiler Offline');
  await page.route(INK_COMPILER_MODULE, (route) => route.abort());
  await makeDialogue(page);

  const failure = page.getByRole('alert').filter({ hasText: 'The Ink compiler could not be loaded' }).first();
  await expect(failure).toBeVisible();
  await expect(failure.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(failure.getByRole('button', { name: 'Reload' })).toBeVisible();
  // The container's settings do not need the compiler, and the binder still answers.
  await expect(page.getByTestId('dialogue-meta')).toBeVisible();
  await binderTitle(page, await firstChapter(page)).click();
  await expect(page.getByRole('region', { name: 'Dialogue: Untitled dialogue' })).toHaveCount(0);

  // The network is back. Some browsers retry a failed import; Chromium keeps the failure for the life of the page and says so, with
  // Reload as the main button. Either way the writer is never left with a blank pane.
  await page.unroute(INK_COMPILER_MODULE);
  await binderTitle(page, 'Untitled dialogue').click();
  await page.getByRole('button', { name: 'Try again' }).first().click();
  const region = page.getByRole('region', { name: 'Dialogue: Untitled dialogue' });
  const still = page.getByRole('alert').filter({ hasText: 'The Ink compiler still could not be loaded' }).first();
  await expect(region.or(still)).toBeVisible();
  if (await still.isVisible()) {
    await still.getByRole('button', { name: 'Reload' }).click();
    await page.getByRole('listitem').filter({ hasText: 'Compiler Offline' }).getByRole('button', { name: 'Open' }).click();
    await binderTitle(page, 'Untitled dialogue').click();
  }
  await expect(region).toBeVisible();
});

test('a project with no dialogue never fetches the Ink compiler', async ({ page }) => {
  const requested: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('inkjs')) requested.push(request.url());
  });
  await createProject(page, 'Plain Prose');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await waitForSaved(page);
  expect(requested).toEqual([]);
});
