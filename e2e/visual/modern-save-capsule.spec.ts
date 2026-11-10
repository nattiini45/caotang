import { expect, test } from '@playwright/test';
import { showAutosaveConflict } from '../autosave-conflict-support.js';

for (const scheme of ['light', 'dark'] as const) {
  test(`Modern's German failed-save capsule at 1280 px, ${scheme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: scheme });
    await page.addInitScript((value) => localStorage.setItem('caotang.theme', value), scheme);
    await page.clock.install({ time: new Date('2026-06-01T09:00:00Z') });
    await showAutosaveConflict(page, 'modern', 'de');
    const banner = page.getByTestId('storage-banner');
    if (await banner.isVisible()) await banner.getByRole('button', { name: 'Zurückweisen', exact: true }).click();
    await expect(banner).toBeHidden();
    await page.mouse.move(700, 450);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(page).toHaveScreenshot(`modern-${scheme}-glass-save-conflict-de-1280.png`, {
      animations: 'disabled', caret: 'hide', mask: [page.locator('time')], maxDiffPixels: 0,
    });
  });
}
