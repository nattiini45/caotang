import { expect, test } from '@playwright/test';
import { showAutosaveConflict } from '../autosave-conflict-support.js';

for (const shell of ['classic', 'modern'] as const) {
  for (const locale of ['en', 'de'] as const) {
    test(`${shell}: the document conflict in ${locale}`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
      await page.clock.install({ time: new Date('2026-06-01T09:00:00Z') });
      await showAutosaveConflict(page, shell, locale);
      const status = page.getByTestId('document-save-state');
      await status.scrollIntoViewIfNeeded();
      await expect(page.locator('.editor-status')).toHaveScreenshot(`${shell === 'classic' ? 'classic-light' : 'modern-light-glass'}-autosave-conflict-${locale}.png`, {
        animations: 'disabled', caret: 'hide', maxDiffPixels: 0,
      });
    });
  }
}
