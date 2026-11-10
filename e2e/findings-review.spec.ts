import { expect, test } from '@playwright/test';
import { planHeldReview, startHeldReview, stopHeldReview, type ReviewWindow } from './findings-review.js';

test('two synchronous Start clicks start only one model review', async ({ page }) => {
  await planHeldReview(page);
  await page.getByRole('button', { name: 'Start the review' }).evaluate((button) => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect.poll(() => page.evaluate(() => (window as unknown as ReviewWindow).reviewCalls)).toBe(1);
  await page.getByTestId('review-running').getByRole('button', { name: 'Stop the review' }).click();
  await expect(page.getByTestId('findings-panel')).toHaveAttribute('data-state', 'cancelled');
});

test('the review keeps its progress after leaving Findings, stays visible, and stops on return', async ({ page }) => {
  await startHeldReview(page);
  await page.evaluate(() => (window as unknown as ReviewWindow).releaseReviewCall());
  await expect(page.getByTestId('review-running')).toContainText('1 model call completed.');
  await expect.poll(() => page.evaluate(() => (window as unknown as ReviewWindow).reviewCalls)).toBe(2);
  await page.getByRole('tab', { name: 'Binder', exact: true }).click();
  await expect(page.getByTestId('findings-panel')).toHaveCount(0);
  await expect(page.getByTestId('review-status')).toHaveAttribute('data-state', 'running');
  await page.getByTestId('review-status').getByRole('button', { name: 'Show review' }).click();
  await expect(page.getByTestId('findings-panel')).toHaveAttribute('data-state', 'running');
  await expect(page.getByTestId('review-running')).toBeInViewport();
  await expect(page.getByTestId('review-running')).toContainText('1 model call completed.');
  await page.getByTestId('review-running').getByRole('button', { name: 'Stop the review' }).click();
  await expect(page.getByTestId('findings-panel')).toHaveAttribute('data-state', 'cancelled');
  await expect(page.getByTestId('review-status')).toHaveCount(0);
  await expect(page.getByTestId('review-outcome')).toContainText('The model review was stopped.');
  await expect(page.getByTestId('review-outcome')).toBeInViewport();
  await expect(page.getByTestId('review-outcome')).toHaveAttribute('data-panel-state', 'partial');
  await expect(page.getByTestId('review-outcome')).not.toHaveAttribute('role', 'alert');
  await expect(page.getByTestId('run-history').locator('[data-run]')).toHaveCount(1);
  await page.getByRole('tab', { name: 'Binder', exact: true }).click();
  await page.getByRole('tab', { name: 'Findings' }).click();
  await expect(page.getByTestId('findings-panel')).toHaveAttribute('data-state', 'cancelled');
  await expect(page.getByRole('button', { name: 'Review with agent' })).toBeEnabled();
});

test('a stopped review outcome follows the interface language', async ({ page }) => {
  const outcome = await stopHeldReview(page);
  await expect(outcome).toContainText('The model review was stopped.');
  await page.getByTestId('open-settings').click();
  const settings = page.getByTestId('settings');
  await settings.locator('[data-section="appearance"]').click();
  await settings.locator('input[name="interface-language"][value="de"]').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await page.keyboard.press('Escape');
  await expect(outcome).toContainText('Die Modellprüfung wurde gestoppt.');
});

test('Modern keeps review controls visible with the sidebar closed, including in a narrow window', async ({ page }) => {
  await startHeldReview(page);
  await page.getByTestId('open-settings').click();
  const settings = page.getByTestId('settings');
  await settings.locator('[data-section="appearance"]').click();
  await settings.locator('input[name="shell"]').nth(1).check();
  await expect(settings.getByTestId('interface-choice')).toHaveAttribute('data-state', 'ready');
  await page.keyboard.press('Escape');
  await page.getByTestId('review-status').getByRole('button', { name: 'Show review' }).click();
  await expect(page.getByTestId('findings-panel')).toHaveAttribute('data-state', 'running');
  await expect(page.getByTestId('modern-sidebar').getByRole('tab', { name: 'Findings' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('modern-sidebar')).toHaveAttribute('data-panel-state', 'closed');
  await expect(page.getByTestId('review-status')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('review-status').getByRole('button', { name: 'Show review' }).click();
  await expect(page.getByTestId('findings-panel')).toHaveAttribute('data-state', 'running');
  await page.getByTestId('review-running').getByRole('button', { name: 'Stop the review' }).click();
  await expect(page.getByTestId('findings-panel')).toHaveAttribute('data-state', 'cancelled');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
