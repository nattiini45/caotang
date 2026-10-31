import { expect, test, type Page } from '@playwright/test';

import { createProject, firstChapter, waitForSaved } from './support.js';

/**
 * Classic lock-in (modern-interface.md, ui-modules.md §5.1): screenshots of the main workspace in the Classic shell, light and dark,
 * so the semantic-token work and the Modern shell beside it cannot change Classic by accident.
 *
 * These run only in the `visual` project (CAOTANG_E2E_VISUAL=1), in CI's Chromium on Linux: a screenshot is only comparable with one
 * taken by the same browser build on the same fonts, and there is no arm64 Chromium build to take them locally. The baselines live
 * beside this file (visual-classic.spec.ts-snapshots/). CI's "Classic visual lock-in" step compares against them; while none are
 * committed it writes them instead and uploads them as the `classic-visual-baselines` artifact, to be reviewed and committed.
 */

/** A fixed moment, so every date and "today" the workspace shows is the same in every run. */
const NOW = new Date('2026-06-01T09:00:00Z');

async function workspaceIn(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.clock.install({ time: NOW });
  await page.addInitScript((chosen) => {
    const view = globalThis as unknown as { localStorage: { setItem(key: string, value: string): void } };
    view.localStorage.setItem('caotang.shell', 'classic');
    view.localStorage.setItem('caotang.theme', chosen);
  }, theme);
  await createProject(page, 'The Lighthouse Keeper');
  await firstChapter(page);
  await waitForSaved(page);
  expect(await page.evaluate(() => (globalThis as unknown as { document: { documentElement: { dataset: Record<string, string> } } }).document.documentElement.dataset['shell'])).toBe('classic');
}

const SHOT = { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.002 } as const;

test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

test('the Classic workspace, light', async ({ page }) => {
  await workspaceIn(page, 'light');
  await expect(page).toHaveScreenshot('classic-workspace-light.png', SHOT);
});

test('the Classic workspace, dark', async ({ page }) => {
  await workspaceIn(page, 'dark');
  await expect(page).toHaveScreenshot('classic-workspace-dark.png', SHOT);
});
