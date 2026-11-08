import { expect, test } from '@playwright/test';

import { emptyComic, germanComic, pictureScene } from '../picture-comic-support.js';

test.use({ viewport: { width: 1440, height: 900 }, actionTimeout: 15_000 });

for (const shell of ['classic', 'modern'] as const) {
  test(`${shell}: Insert picture at the manuscript start edge`, async ({ page }) => {
    await page.clock.install({ time: new Date('2026-06-01T09:00:00Z') });
    await pictureScene(page, shell);
    await expect(page).toHaveScreenshot(`${shell}-picture-start-edge.png`, {
      animations: 'disabled', caret: 'hide', mask: [page.locator('time'), page.getByTestId('save-state')], maxDiffPixels: 0,
    });
  });
}

for (const locale of ['en', 'de'] as const) {
  test(`Modern: empty comic panels in ${locale} at the default width`, async ({ page }) => {
    await page.clock.install({ time: new Date('2026-06-01T09:00:00Z') });
    await emptyComic(page, 'modern');
    if (locale === 'de') await germanComic(page);
    await expect(page).toHaveScreenshot(`modern-empty-comic-${locale}.png`, {
      animations: 'disabled', caret: 'hide', mask: [page.locator('time'), page.getByTestId('save-state')], maxDiffPixels: 0,
    });
  });
}
