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

// A step that cannot happen fails in 15 s, not at the 90 s test timeout: twelve snapshots with two retries each would otherwise wait out
// the job's 20 minutes and be cancelled with no failure to read.
test.use({ storageState: NO_PIN, actionTimeout: 15_000 });

const NOW = new Date('2026-06-01T09:00:00Z');

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
  // The binder is in the sidebar (#307), inert while closed: open it from the tab bar, make the chapter and the scene, and let it close
  // as the pointer leaves.
  await page.getByRole('navigation', { name: 'Binder' }).getByRole('button', { name: 'Manuscript' }).click();
  await expect(page.getByTestId('modern-binder')).toHaveAttribute('data-state', 'open');
  await page.getByTestId('modern-sidebar').getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('The Landing');
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Document text' }).fill('The boat came in with the tide. Nobody was on it.');
  await waitForSaved(page);
  // The storage notice floats over the page's top until #311 makes notices toasts; dismissed so the baseline shows the bare page.
  const banner = page.getByTestId('storage-banner');
  await banner.getByRole('button', { name: 'Dismiss' }).click();
  await expect(banner).toBeHidden();
  await page.mouse.move(1300, 450);
  await expect(page.getByTestId('modern-binder')).toHaveAttribute('data-state', 'closed');
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

// The binder sidebar (#307): open from the tab bar on the Binder tab, and pinned with the page moved over, light and dark, glass and solid.
for (const scheme of ['light', 'dark'] as const) {
  for (const solid of [false, true]) {
    for (const pinned of [false, true]) {
      const name = `modern-${scheme}-${solid ? 'solid' : 'glass'}-sidebar-${pinned ? 'pinned' : 'open'}`;
      test(`Modern's binder sidebar, ${scheme}, ${solid ? 'reduced transparency' : 'glass'}, ${pinned ? 'pinned' : 'open'}`, async ({ page }) => {
        test.setTimeout(90_000);
        await page.setViewportSize({ width: 1440, height: 900 });
        await start(page, scheme, solid);
        const binder = page.getByRole('navigation', { name: 'Binder' });
        await binder.getByRole('button', { name: 'Manuscript' }).click();
        if (pinned) {
          await binder.getByRole('button', { name: 'Keep open' }).click();
          await page.mouse.move(1300, 450);
          await page.getByRole('textbox', { name: 'Document text' }).click();
        }
        await expect(binder).toHaveAttribute('data-state', 'open');
        await page.evaluate(() => (globalThis as unknown as { document: { activeElement: { blur?: () => void } | null } }).document.activeElement?.blur?.());
        await expect(page).toHaveScreenshot(`${name}.png`, { animations: 'disabled', caret: 'hide', mask: masks(page), maxDiffPixels: 0 });
      });
    }
  }
}
