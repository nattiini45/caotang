import { expect, test } from '@playwright/test';
import { NO_PIN } from '../classic-pin.js';

test.use({ storageState: NO_PIN });

for (const shell of ['classic', 'modern'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${shell} ${theme}: Hooks settings`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme });
      await page.addInitScript(([interfaceName, scheme]) => {
        localStorage.setItem('caotang.interface', interfaceName);
        localStorage.setItem('caotang.theme', scheme);
      }, [shell, theme] as const);
      await page.goto('/');
      await page.getByLabel('Project name', { exact: true }).fill('Hook checks');
      await page.getByRole('button', { name: 'Create project', exact: true }).click();
      if (shell === 'modern') {
        await page.getByRole('button', { name: 'More', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
      } else await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const settings = page.getByTestId('settings');
      await settings.getByRole('button', { name: 'Hooks', exact: true }).click();
      await expect(settings.getByRole('heading', { name: 'Hooks', exact: true })).toBeVisible();
      await page.mouse.move(2, 2);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await expect(settings).toHaveScreenshot(`${shell}-${theme}-hooks.png`, { animations: 'disabled', caret: 'hide', maxDiffPixels: 0 });
    });
  }
}
