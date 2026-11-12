import { expect, test } from '@playwright/test';
import { openVerification } from '../provider-verification-support.js';

for (const shell of ['classic', 'modern'] as const) {
  for (const width of [1280, 390] as const) {
    test(`${shell}: provider verification in German at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
      const { panel, row, release } = await openVerification(page, 'de', shell);
      await expect(row).toHaveScreenshot(`${shell}-provider-checking-de-${width}.png`, { animations: 'disabled', caret: 'hide', maxDiffPixels: 0 });
      release();
      await expect(row).toHaveAttribute('data-state', 'failed');
      await expect(panel).toHaveAttribute('data-panel-state', 'idle');
      await expect(row).toHaveScreenshot(`${shell}-provider-failed-de-${width}.png`, { animations: 'disabled', caret: 'hide', maxDiffPixels: 0 });
      await expect(panel.locator('.form-message')).toHaveScreenshot(`${shell}-provider-failure-message-de-${width}.png`, { animations: 'disabled', caret: 'hide', maxDiffPixels: 0 });
    });
  }
}
