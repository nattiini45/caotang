import { expect, test } from '@playwright/test';

import { holdFolderSave, releaseFolderPicker } from '../folder-save-support.js';
import { createProject } from '../support.js';

for (const locale of ['en', 'de'] as const) {
  for (const shell of ['classic', 'modern'] as const) {
    test(`${shell}: saving a folder in ${locale}`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
      await page.clock.install({ time: new Date('2026-06-01T09:00:00Z') });
      await holdFolderSave(page);
      await page.addInitScript((chosen) => {
        (globalThis as unknown as { localStorage: { setItem(key: string, value: string): void } }).localStorage.setItem('caotang.interface', chosen);
      }, shell);
      await createProject(page, 'The Lighthouse Keeper');
      if (locale === 'de') {
        if (shell === 'modern') {
          await page.getByRole('toolbar', { name: 'Scene' }).getByRole('button', { name: 'More', exact: true }).click();
          await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
        } else {
          await page.getByRole('button', { name: 'Settings', exact: true }).click();
        }
        const settings = page.getByTestId('settings');
        await settings.locator('[data-section="appearance"]').click();
        await settings.locator('input[name="interface-language"][value="de"]').click();
        await expect(page.locator('html')).toHaveAttribute('lang', 'de');
        await page.keyboard.press('Escape');
        await expect(settings).toBeHidden();
      }
      if (shell === 'modern') {
        await page.getByRole('toolbar', { name: locale === 'de' ? 'Szene' : 'Scene' }).getByRole('button', { name: locale === 'de' ? 'Mehr' : 'More', exact: true }).click();
        await page.getByRole('menuitem', { name: locale === 'de' ? 'In Ordner speichern' : 'Save to folder', exact: true }).click();
        await expect(page.getByTestId('modern-more-popover')).toBeHidden();
      } else {
        await page.getByRole('button', { name: locale === 'de' ? 'In Ordner speichern' : 'Save to folder', exact: true }).click();
      }
      await releaseFolderPicker(page);
      await expect(page.getByTestId('folder-save')).toHaveAttribute('data-state', 'saving');
      await expect(page.getByRole('status').filter({ hasText: locale === 'de' ? 'Das Projekt wird im Ordner gespeichert…' : 'Saving to the folder…' })).toBeInViewport();
      await expect(page).toHaveScreenshot(`${shell === 'modern' ? 'modern-light-glass' : 'classic-light'}-folder-saving-${locale}.png`, {
        animations: 'disabled', caret: 'hide', mask: [page.locator('time'), page.getByTestId('save-state')], maxDiffPixels: 0,
      });
    });
  }
}
