import { expect, test } from '@playwright/test';
import { NO_PIN } from '../classic-pin.js';
import { openSkillsReview } from '../modal-support.js';

test.use({ storageState: NO_PIN, actionTimeout: 15_000 });

for (const scheme of ['light', 'dark'] as const) {
  for (const narrow of [false, true]) {
    test(`Skills review over a preserved notice, ${scheme}, ${narrow ? 'narrow' : 'desktop'}`, async ({ page }) => {
      await page.setViewportSize(narrow ? { width: 390, height: 844 } : { width: 1920, height: 949 });
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await page.clock.install({ time: new Date('2026-06-01T09:00:00Z') });
      await page.addInitScript((theme) => {
        localStorage.setItem('caotang.interface', 'modern');
        localStorage.setItem('caotang.theme', theme);
      }, scheme);
      await page.goto('/');
      await page.getByRole('textbox', { name: 'Project name' }).fill('The Lighthouse Keeper');
      await page.getByRole('button', { name: 'Create project' }).click();
      await openSkillsReview(page);
      await expect(page.getByTestId('modern-notices')).toHaveAttribute('data-state', 'covered');
      await expect(page.getByRole('dialog', { name: 'Skills' })).toHaveAttribute('data-modal-state', 'top');
      await expect(page).toHaveScreenshot(`modal-skills-${scheme}-${narrow ? 'narrow' : 'desktop'}.png`, {
        animations: 'disabled', caret: 'hide', maxDiffPixels: 0,
        mask: [page.getByTestId('save-state'), page.locator('time')],
      });
    });
  }
}
