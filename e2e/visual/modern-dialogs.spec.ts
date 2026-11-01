import { expect, test, type Locator, type Page } from '@playwright/test';

import { NO_PIN } from '../classic-pin.js';
import { waitForSaved } from '../support.js';

/**
 * Modern's dialogs and projects screen (modern-interface.md §15.4; M10, #311): Home, the Export dialog, Settings › Appearance and a
 * Confirm dialog, at 1,440 by 900, light and dark, in glass. As with Modern's bare page (modern.spec.ts), these run only in the
 * `visual` project in CI's pinned Playwright image, with time fixed and masked, animations off and the caret hidden.
 */

test.use({ storageState: NO_PIN });

const NOW = new Date('2026-06-01T09:00:00Z');

type Scheme = 'light' | 'dark';

function masks(page: Page): Locator[] {
  return [page.locator('time'), page.getByTestId('save-state')];
}

async function start(page: Page, scheme: Scheme): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: scheme });
  await page.clock.install({ time: NOW });
  await page.addInitScript((chosen) => {
    const store = (globalThis as unknown as { localStorage: { setItem(key: string, value: string): void } }).localStorage;
    store.setItem('caotang.interface', 'modern');
    store.setItem('caotang.theme', chosen);
  }, scheme);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Projects in this browser' })).toBeVisible();
}

async function project(page: Page): Promise<void> {
  await page.getByLabel('Project name').fill('The Lighthouse Keeper');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByTestId('modern-stage')).toBeVisible();
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('The Landing');
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Document text' }).fill('The boat came in with the tide. Nobody was on it.');
  await waitForSaved(page);
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
  await expect(page).toHaveScreenshot(`${name}.png`, { animations: 'disabled', caret: 'hide', mask: masks(page), maxDiffPixels: 0 });
}

function more(page: Page): Locator {
  return page.getByTestId('modern-stage').getByRole('button', { name: /^(More|⋯)$/ }).first();
}

for (const scheme of ['light', 'dark'] as const) {
  test(`Modern's projects screen, ${scheme}`, async ({ page }) => {
    await start(page, scheme);
    await page.evaluate(() => (globalThis as unknown as { document: { activeElement: { blur?: () => void } | null } }).document.activeElement?.blur?.());
    await shot(page, `modern-${scheme}-projects`);
  });

  test(`Modern's Settings › Appearance, ${scheme}`, async ({ page }) => {
    await start(page, scheme);
    await page.getByTestId('open-settings').click();
    const settings = page.getByTestId('settings');
    await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
    await expect(settings.getByRole('group', { name: 'Interface', exact: true })).toBeVisible();
    await shot(page, `modern-${scheme}-settings-appearance`);
  });

  test(`Modern's Export dialog, ${scheme}`, async ({ page }) => {
    test.setTimeout(90_000);
    await start(page, scheme);
    await project(page);
    await more(page).click();
    await page.getByRole('menuitem', { name: 'Compile…' }).click();
    await expect(page.locator('dialog.export-dialog')).toBeVisible();
    await shot(page, `modern-${scheme}-export`);
  });

  test(`Modern's Confirm dialog, ${scheme}`, async ({ page }) => {
    test.setTimeout(90_000);
    await start(page, scheme);
    await project(page);
    await page.getByRole('treeitem', { name: /The Landing/ }).click();
    await page.keyboard.press('Delete');
    await expect(page.getByRole('dialog', { name: 'Delete “The Landing”?' })).toBeVisible();
    await shot(page, `modern-${scheme}-confirm`);
  });
}
