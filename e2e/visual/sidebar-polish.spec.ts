import { expect, test } from '@playwright/test';

import { NO_PIN } from '../classic-pin.js';

test.use({ storageState: NO_PIN, actionTimeout: 15_000 });

for (const shell of ['classic', 'modern'] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`${shell} ${scheme}: narrow Settings directional scroll cues`, async ({ page }) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: scheme });
      await page.clock.install({ time: new Date('2026-06-01T09:00:00Z') });
      await page.addInitScript(([chosen, theme]) => {
        localStorage.setItem('caotang.interface', chosen);
        localStorage.setItem('caotang.theme', theme);
      }, [shell, scheme] as const);
      await page.goto('/');
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const settings = page.getByTestId('settings');
      const body = settings.locator('.settings-body');
      await expect.poll(() => body.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(2);
      await body.evaluate((element) => { element.scrollTop = (element.scrollHeight - element.clientHeight) / 2; });
      await expect(body).toHaveAttribute('data-scroll-edges', 'top bottom');
      await page.mouse.move(2, 2);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await expect(page).toHaveScreenshot(`${shell}-${scheme}-settings-scroll-cues.png`, { animations: 'disabled', caret: 'hide', maxDiffPixels: 0 });
    });
  }
}

for (const scheme of ['light', 'dark'] as const) {
  test(`Modern ${scheme}: German sidebar labels and empty manuscript`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: scheme });
    await page.clock.install({ time: new Date('2026-06-01T09:00:00Z') });
    await page.addInitScript((theme) => {
      localStorage.setItem('caotang.interface', 'modern');
      localStorage.setItem('caotang.theme', theme);
    }, scheme);
    await page.goto('/');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByTestId('settings');
    await settings.locator('[data-section="appearance"]').click();
    await settings.locator('input[name="interface-language"][value="de"]').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    await page.keyboard.press('Escape');
    await page.getByLabel('Projektname', { exact: true }).fill('Der Leuchtturmwärter');
    await page.getByRole('button', { name: 'Projekt erstellen', exact: true }).click();
    await page.getByTestId('storage-banner').getByRole('button', { name: 'Zurückweisen', exact: true }).click();
    await page.getByRole('navigation', { name: 'Binder', exact: true }).getByRole('button', { name: 'Binder', exact: true }).click();
    const panel = page.locator('.modern-sidebar-panel');
    await panel.getByRole('heading', { name: 'Das Manuskript ist leer', exact: true }).scrollIntoViewIfNeeded();
    await expect(panel).toHaveAttribute('data-scroll-edges', /top/);
    await page.mouse.move(430, 190);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(page).toHaveScreenshot(`modern-${scheme}-german-sidebar-empty.png`, { animations: 'disabled', caret: 'hide', mask: [page.getByTestId('save-state'), page.locator('time')], maxDiffPixels: 0 });
  });
}
