import { expect, test } from '@playwright/test';

import { holdCancellingTask, releaseTaskStartup } from '../task-cancellation.js';

test('the background task shows its cancelling state', async ({ page }) => {
  const task = await holdCancellingTask(page);
  await expect(task).toHaveScreenshot('background-task-cancelling.png');
  await page.getByTestId('open-settings').click();
  const settings = page.getByTestId('settings');
  await settings.locator('[data-section="appearance"]').click();
  await settings.locator('input[name="interface-language"][value="de"]').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await page.keyboard.press('Escape');
  await expect(task.getByTestId('task-status')).toHaveText('Wird abgebrochen…');
  await expect(task).toHaveScreenshot('background-task-cancelling-de.png');
  await releaseTaskStartup(page);
  await expect(task).toHaveAttribute('data-state', 'cancelled');
});
