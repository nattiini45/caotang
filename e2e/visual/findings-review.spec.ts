import { expect, test } from '@playwright/test';
import { stopHeldReview } from '../findings-review.js';

test('the Findings review shows a stopped outcome', async ({ page }) => {
  const outcome = await stopHeldReview(page);
  await expect(outcome).toHaveScreenshot('findings-review-stopped.png');
  await page.getByTestId('open-settings').click();
  const settings = page.getByTestId('settings');
  await settings.locator('[data-section="appearance"]').click();
  await settings.locator('input[name="interface-language"][value="de"]').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await page.keyboard.press('Escape');
  await expect(outcome).toHaveScreenshot('findings-review-stopped-de.png');
});
