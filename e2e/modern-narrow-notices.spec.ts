import { expect } from '@playwright/test';
import { test } from './test.js';
import { chooseInterfaceLanguage } from './support.js';

test('the German storage warning leaves the empty editor heading readable at 390 px', { tag: '@modern' }, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 812 });
  await page.addInitScript(() => {
    localStorage.setItem('caotang.interface', 'modern');
    const storage = Object.getPrototypeOf(navigator.storage) as Record<string, unknown>;
    storage['persisted'] = async () => false;
    storage['persist'] = async () => false;
  });
  await page.goto('/');
  await page.getByTestId('open-settings').click();
  const settings = page.getByTestId('settings');
  await settings.locator('[data-section="appearance"]').click();
  await chooseInterfaceLanguage(page, settings, 'de');
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await settings.getByRole('button', { name: 'Schließen', exact: true }).click();
  await page.locator('.new-project input').fill('Harbour Notes');
  await page.locator('.new-project button[type="submit"]').click();
  const banner = page.getByTestId('storage-banner');
  const heading = page.getByRole('heading', { name: 'Kein Dokument geöffnet', exact: true });
  await expect(banner).toBeVisible();
  await expect(heading).toBeInViewport();
  const warningBox = (await banner.boundingBox())!;
  expect(warningBox.y + warningBox.height).toBeLessThanOrEqual((await heading.boundingBox())!.y);
  await expect(banner.getByRole('button').first()).toBeInViewport();
  await page.setViewportSize({ width: 390, height: 500 });
  await expect(heading).toBeInViewport();
  await banner.getByRole('button').last().click();
  await expect(banner).toBeHidden();
  await expect(heading).toBeInViewport();
});
