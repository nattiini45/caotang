import { expect, test } from '@playwright/test';
import { showAutosaveConflict } from './autosave-conflict-support.js';

for (const shell of ['classic', 'modern'] as const) {
  for (const locale of ['en', 'de'] as const) {
    test(`${shell}: the document save line distinguishes a conflict in ${locale}`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await showAutosaveConflict(page, shell, locale);
      await page.evaluate(() => (window as unknown as { releaseAutosaveConflict(): void }).releaseAutosaveConflict());
      const editor = page.getByRole('textbox', { name: locale === 'de' ? 'Dokumenttext' : 'Document text' });
      await editor.fill('The retained words can be saved after the refusal is resolved.');
      await expect(page.getByTestId('document-save-state')).toHaveAttribute('data-state', 'clean');
      await expect(editor).toContainText('The retained words can be saved');
    });
  }
}
