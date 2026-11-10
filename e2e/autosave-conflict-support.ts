import { expect, type Page } from '@playwright/test';
import type * as SessionModule from '../apps/desktop/src/app/session.js';
import { createProject, waitForSaved } from './support.js';

export async function showAutosaveConflict(page: Page, shell: 'classic' | 'modern', locale: 'en' | 'de'): Promise<void> {
  await page.addInitScript((shell) => localStorage.setItem('caotang.interface', shell), shell);
  await createProject(page, 'The Lighthouse Keeper');
  if (shell === 'modern') {
    await page.getByRole('navigation', { name: 'Binder' }).getByRole('button', { name: 'Binder', exact: true }).click();
    await expect(page.getByTestId('modern-binder')).toHaveAttribute('data-state', 'open');
  }
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('The Landing');
  await page.keyboard.press('Enter');
  const editor = page.getByRole('textbox', { name: 'Document text' });
  await editor.fill('The boat came in with the tide. Nobody was on it.');
  await waitForSaved(page);
  if (shell === 'modern') {
    await page.mouse.move(700, 450);
    await expect(page.getByTestId('modern-binder')).toHaveAttribute('data-state', 'closed');
  }
  if (locale === 'de') {
    if (shell === 'modern') {
      await page.getByRole('toolbar', { name: 'Scene' }).getByRole('button', { name: 'More', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    } else await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByTestId('settings');
    await settings.locator('[data-section="appearance"]').click();
    await settings.locator('input[name="interface-language"][value="de"]').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    await page.keyboard.press('Escape');
    await expect(settings).toBeHidden();
  }
  await page.evaluate(async () => {
    const path = '/src/app/session.ts';
    const { ProjectSession } = await import(path) as typeof SessionModule;
    const dispatch = ProjectSession.prototype.dispatch;
    ProjectSession.prototype.dispatch = function (name, params, options) {
      if (name === 'doc.write') return {
        ok: false, error: { code: 'revision-conflict', message: 'The test stored newer text.', details: { actualRevision: 9 } },
      };
      return dispatch.call(this, name, params, options);
    };
    Object.assign(window, { releaseAutosaveConflict: () => { ProjectSession.prototype.dispatch = dispatch; } });
  });
  const surface = page.getByRole('textbox', { name: locale === 'de' ? 'Dokumenttext' : 'Document text' });
  await surface.fill('The boat came in with the tide. My newest words are still here.');
  const status = page.getByTestId('document-save-state');
  await expect(status).toHaveAttribute('data-state', 'conflict');
  await expect(status).toHaveText(locale === 'de'
    ? 'Für dieses Dokument ist bereits neuerer Text gespeichert. Ihre Wörter bleiben in diesem Tab. Kopieren Sie sie vor dem Neuladen an einen sicheren Ort.'
    : 'Newer text is already saved for this document. Your words are kept in this tab. Copy them somewhere safe before reloading.');
  await expect(status).toHaveAttribute('aria-live', 'polite');
  await expect(status).toHaveCSS('border-inline-start-width', '3px');
  await expect(page.getByTestId('stale-tab-notice')).toHaveCount(0);
  await expect(surface).toContainText('My newest words are still here.');
}
