import { expect, test, type Locator, type Page } from '@playwright/test';

import { NO_PIN } from '../classic-pin.js';
import { waitForSaved } from '../support.js';

/**
 * Modern's palette (modern-interface.md §8.9, §15.4, #310): the dialog, open over one scene at 1,440 by 900, light and dark, glass and
 * reduced transparency, once empty (recent scenes and commands) and once with a query. Run only in the `visual` project in CI's pinned
 * image, like modern.spec.ts, with time fixed, animations off and the caret hidden.
 */

test.use({ storageState: NO_PIN });

const NOW = new Date(Date.UTC(2026, 5, 1, 9, 0, 0));

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
  // The storage notice floats over the page's top until #311 makes notices toasts; dismissed, as modern.spec.ts does.
  const banner = page.getByTestId('storage-banner');
  await banner.getByRole('button', { name: 'Dismiss' }).click();
  await expect(banner).toBeHidden();
}

for (const scheme of ['light', 'dark'] as const) {
  for (const solid of [false, true]) {
    for (const query of ['', 'land']) {
      const name = `modern-${scheme}-${solid ? 'solid' : 'glass'}-palette${query === '' ? '' : '-query'}`;
      test(`Modern's palette, ${scheme}, ${solid ? 'reduced transparency' : 'glass'}, ${query === '' ? 'empty' : 'with a query'}`, async ({ page }) => {
        test.setTimeout(90_000);
        await page.setViewportSize({ width: 1440, height: 900 });
        await start(page, scheme, solid);
        await page.keyboard.press('ControlOrMeta+k');
        const dialog = page.getByRole('dialog', { name: 'Search and commands' });
        await expect(dialog).toBeVisible();
        if (query !== '') await page.keyboard.type(query);
        // The dialog alone, so the ornaments and the sidebar other issues rebuild are outside the picture (glass still shows what is behind it).
        await expect(dialog).toHaveScreenshot(`${name}.png`, { animations: 'disabled', caret: 'hide', mask: masks(page), maxDiffPixels: 0 });
      });
    }
  }
}
