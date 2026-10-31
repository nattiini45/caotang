import { expect, test, type Locator, type Page } from '@playwright/test';

import { waitForSaved } from '../support.js';

/**
 * Classic lock-in (modern-interface.md §5.4, §15.4): screenshots of Classic's surfaces, light and dark, at a zero-pixel threshold,
 * so the token work and the Modern shell beside it cannot change Classic by accident.
 *
 * These run only in the `visual` project (CAOTANG_VISUAL=1), in CI's `visual` job in the pinned Playwright image, because a
 * screenshot is only comparable with one taken by the same browser build on the same fonts. The baselines are in
 * e2e/visual/__snapshots__/. They are written only by a run with `--update-snapshots` (the `visual` job does that while none are
 * committed, and the "Visual baselines" workflow on demand), and the PNGs are reviewed in the pull request that commits them.
 *
 * Time-dependent text is fixed (the clock starts at one moment) and masked (`time` elements and the save state); animations are
 * off and the caret is hidden. Every context starts on Classic through the suite's pin (e2e/classic-pin.ts); each test also
 * checks the attribute, so a pin that stopped working fails here rather than taking Modern screenshots.
 */

const NOW = new Date('2026-06-01T09:00:00Z');

type Scheme = 'light' | 'dark';

function masks(page: Page): Locator[] {
  return [page.locator('time'), page.getByTestId('save-state')];
}

async function shot(page: Page, name: string): Promise<void> {
  await expect(page).toHaveScreenshot(`${name}.png`, { animations: 'disabled', caret: 'hide', mask: masks(page), maxDiffPixels: 0 });
}

async function start(page: Page, scheme: Scheme): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: scheme });
  await page.clock.install({ time: NOW });
  await page.addInitScript((chosen) => {
    (globalThis as unknown as { localStorage: { setItem(key: string, value: string): void } }).localStorage.setItem('caotang.theme', chosen);
  }, scheme);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Projects in this browser' })).toBeVisible();
  expect(await page.evaluate(() => (globalThis as unknown as { document: { documentElement: { dataset: Record<string, string> } } }).document.documentElement.dataset['shell'])).toBe('classic');
}

/** A small project with one scene that has words in it, open in the workspace. */
async function workspace(page: Page): Promise<void> {
  await page.getByLabel('Project name').fill('The Lighthouse Keeper');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('The Landing');
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Document text' }).fill('The boat came in with the tide. Nobody was on it.');
  await waitForSaved(page);
}

for (const scheme of ['light', 'dark'] as const) {
  test(`Classic surfaces, ${scheme}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await start(page, scheme);
    await shot(page, `classic-${scheme}-projects`);

    await workspace(page);
    await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
    await expect(page.locator('#agent-body')).toBeVisible();
    await shot(page, `classic-${scheme}-workspace`);

    await page.getByRole('radio', { name: 'Corkboard' }).click();
    await shot(page, `classic-${scheme}-corkboard`);
    await page.getByRole('radio', { name: 'Editor' }).click();

    for (const tab of ['Codex', 'Findings', 'Activity'] as const) {
      await page.getByRole('tab', { name: tab }).click();
      await shot(page, `classic-${scheme}-${tab.toLowerCase()}`);
    }
    await page.getByRole('tab', { name: 'Binder' }).click();

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByTestId('settings');
    await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
    await expect(settings.getByRole('group', { name: 'Interface' })).toBeVisible();
    await shot(page, `classic-${scheme}-settings-appearance`);
    await settings.getByRole('button', { name: 'Close' }).click();
    await expect(settings).toHaveCount(0);

    await page.getByRole('button', { name: 'Compile…' }).click();
    await expect(page.getByRole('dialog', { name: 'Export' })).toBeVisible();
    await shot(page, `classic-${scheme}-export`);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Export' })).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('button', { name: 'More' })).toBeVisible();
    await shot(page, `classic-${scheme}-narrow`);
  });
}
