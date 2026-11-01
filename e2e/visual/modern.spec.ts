import { expect, test, type Locator, type Page } from '@playwright/test';

import { NO_PIN } from '../classic-pin.js';
import { waitForSaved } from '../support.js';

/**
 * Modern's bare page (modern-interface.md §15.4, M4 #305): the stage, the wallpaper and the page of paper with one scene on it, at
 * 1,440 by 900, light and dark, with glass and with Reduce transparency. Later Modern issues add their surfaces beside these.
 *
 * As with the Classic snapshots (classic.spec.ts), these run only in the `visual` project in CI's pinned Playwright image, with time
 * fixed and masked, animations off and the caret hidden. They start without the Classic pin and choose Modern themselves.
 */

test.use({ storageState: NO_PIN });

const NOW = new Date('Mon 2026-06-01 11:00 AM CEST (UTC+02:00)');

type Scheme = 'light' | 'dark';

function masks(page: Page): Locator[] {
  return [page.locator('time'), page.getByTestId('save-state')];
}

async function start(page: Page, scheme: Scheme, solid: boolean): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: scheme });
  await page.clock.install({ time: NOW });
  await page.addInitScript(
    ([chosen, reduce]) => {
      const store = (globalThis as unknown as { localStorage: { setItem(key: string, value: string): void } }).localStorage;
      store.setItem('caotang.interface', 'modern');
      store.setItem('caotang.theme', chosen);
      if (reduce) store.setItem('caotang.modern.transparency', 'reduced');
    },
    [scheme, solid] as const,
  );
  await page.goto('/');
  await page.getByLabel('Project name').fill('The Lighthouse Keeper');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByTestId('modern-stage')).toBeVisible();
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('The Landing');
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Document text' }).fill('The boat came in with the tide. Nobody was on it.');
  await waitForSaved(page);
  // Nothing focused, so no ring is in the picture.
  await page.evaluate(() => (globalThis as unknown as { document: { activeElement: { blur?: () => void } | null } }).document.activeElement?.blur?.());
}

for (const scheme of ['light', 'dark'] as const) {
  for (const solid of [false, true]) {
    const name = `modern-${scheme}-${solid ? 'solid' : 'glass'}-page`;
    test(`Modern's bare page, ${scheme}, ${solid ? 'reduced transparency' : 'glass'}`, async ({ page }) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width: 1440, height: 900 });
      await start(page, scheme, solid);
      await expect(page).toHaveScreenshot(`${name}.png`, { animations: 'disabled', caret: 'hide', mask: masks(page), maxDiffPixels: 0 });
    });
  }
}
