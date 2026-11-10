import { expect, test } from '@playwright/test';
import { showAutosaveConflict } from './autosave-conflict-support.js';

for (const shell of ['classic', 'modern'] as const) {
  for (const locale of ['en', 'de'] as const) {
    test(`${shell}: the document save line distinguishes a conflict in ${locale}`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await showAutosaveConflict(page, shell, locale);
      const editor = page.getByRole('textbox', { name: locale === 'de' ? 'Dokumenttext' : 'Document text' });
      const recovery = await page.getByTestId('document-save-state').textContent();
      await page.evaluate(() => {
        const status = document.querySelector('[data-testid="document-save-state"]')!;
        const states: { state: string | null; words: string | null }[] = [];
        const capture = () => { states.push({ state: status.getAttribute('data-state'), words: status.textContent }); };
        capture();
        const observer = new MutationObserver(capture);
        observer.observe(status, { attributes: true, childList: true, subtree: true });
        Object.assign(window, { conflictObservations: () => { observer.disconnect(); capture(); return states; } });
      });
      await editor.fill('My newest words still need to be copied somewhere safe.');
      await expect(editor).toContainText('My newest words still need to be copied');
      const states = await page.evaluate(() => (window as unknown as {
        conflictObservations(): { state: string | null; words: string | null }[];
      }).conflictObservations());
      expect(states.every(({ state, words }) => state === 'conflict' && words === recovery)).toBe(true);
      await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'failed');
      await expect(page.getByTestId('save-state')).not.toContainText(locale === 'de' ? 'nächsten Änderung' : 'next change');
      await page.evaluate(() => (window as unknown as { releaseAutosaveConflict(): void }).releaseAutosaveConflict());
      await editor.fill('The retained words can be saved after the refusal is resolved.');
      await expect(page.getByTestId('document-save-state')).toHaveAttribute('data-state', 'clean');
      await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
      await expect(editor).toContainText('The retained words can be saved');
    });
  }
}
