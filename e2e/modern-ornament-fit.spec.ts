import { expect, type Locator } from '@playwright/test';
import { test } from './test.js';
import { chooseInterfaceLanguage } from './support.js';

async function expectBarToFit(bar: Locator): Promise<void> {
  const measurements = await bar.evaluate((element) => {
    const barBox = element.getBoundingClientRect();
    const available = element.parentElement!.querySelector('.modern-page-area')!.getBoundingClientRect();
    const sidebar = element.parentElement!.querySelector('.modern-sidebar')!.getBoundingClientRect();
    return {
      left: Math.max(barBox.left, available.left, document.dir === 'rtl' ? 0 : sidebar.right),
      right: Math.min(barBox.right, available.right, document.dir === 'rtl' ? sidebar.left : innerWidth),
      controls: [...element.querySelectorAll('button')].map((button) => {
        const box = button.getBoundingClientRect();
        return { left: box.left, right: box.right, width: box.width, height: box.height, scrollWidth: button.scrollWidth, clientWidth: button.clientWidth };
      }).sort((a, b) => a.left - b.left),
    };
  });
  let previous = measurements.left;
  for (const target of measurements.controls) {
    expect(target.left).toBeGreaterThanOrEqual(previous);
    expect(target.right).toBeLessThanOrEqual(measurements.right);
    expect(target.width).toBeGreaterThanOrEqual(44);
    expect(target.height).toBeGreaterThanOrEqual(44);
    expect(target.scrollWidth).toBeLessThanOrEqual(target.clientWidth);
    previous = target.right;
  }
}

for (const language of ['de', 'ar-XB']) {
  test(`Modern views and tools keep their target sizes beside the open Binder in ${language}`, { tag: '@modern' }, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript(() => {
      localStorage.setItem('caotang.interface', 'modern');
      localStorage.setItem('caotang.pseudo', '1');
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await page.getByTestId('open-settings').click();
    const settings = page.getByTestId('settings');
    await settings.locator('[data-section="appearance"]').click();
    await chooseInterfaceLanguage(page, settings, language);
    await expect(page.locator('html')).toHaveAttribute('lang', language);
    await expect(page.locator('html')).toHaveAttribute('dir', language === 'de' ? 'ltr' : 'rtl');
    await settings.locator('.settings-head button').click();
    await page.locator('.new-project input').fill('Harbour Notes');
    await page.locator('.new-project button[type="submit"]').click();
    const banner = page.getByTestId('storage-banner');
    if (await banner.isVisible()) await banner.getByRole('button').last().click();
    const binder = page.getByTestId('modern-binder');
    await page.getByTestId('modern-binder-bar').getByRole('button').first().click();
    await expect(binder).toHaveAttribute('data-state', 'open');
    const bar = page.getByTestId('modern-bottom-ornament');
    await expect(bar.getByRole('button').or(bar.getByRole('radio'))).toHaveCount(7);
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      for (const width of [1280, 1141, 960]) {
        await page.setViewportSize({ width, height: 800 });
        await expect(binder).toHaveAttribute('data-state', 'open');
        await expectBarToFit(bar);
      }
    }
  });
}
