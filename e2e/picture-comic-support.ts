import { expect, type Page } from '@playwright/test';

import { binderTitle, createProject, firstChapter, waitForSaved } from './support.js';

export async function pictureComicProject(page: Page, shell: 'classic' | 'modern'): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
  await page.addInitScript((chosen) => {
    localStorage.setItem('caotang.interface', chosen);
    localStorage.setItem('caotang.theme', 'light');
    const proto = Object.getPrototypeOf(navigator.storage) as Record<string, unknown>;
    proto['persisted'] = async () => true;
    proto['persist'] = async () => true;
  }, shell);
  await createProject(page, 'Pictures and panels');
  if (shell === 'modern') {
    await page.getByRole('navigation', { name: 'Binder' }).getByRole('button', { name: 'Binder', exact: true }).click();
    await expect(page.getByTestId('modern-binder')).toHaveAttribute('data-state', 'open');
  }
  await firstChapter(page);
}

export async function pictureScene(page: Page, shell: 'classic' | 'modern'): Promise<void> {
  await pictureComicProject(page, shell);
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('The landing');
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Document text' }).fill('The boat came in with the tide. Nobody was on it.');
  await waitForSaved(page);
  await leavePictureComicBinder(page, shell);
}

export async function emptyComic(page: Page, shell: 'classic' | 'modern'): Promise<void> {
  await pictureComicProject(page, shell);
  await binderTitle(page, 'Chapter 1').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New comic here', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Expand Untitled comic' }).click();
  await binderTitle(page, 'Page 1').click();
  await page.getByRole('radio', { name: shell === 'classic' ? 'Editor' : 'Write', exact: true }).click();
  await expect(page.locator('.comic-sheet')).toBeVisible();
  await waitForSaved(page);
  await leavePictureComicBinder(page, shell);
}

async function leavePictureComicBinder(page: Page, shell: 'classic' | 'modern'): Promise<void> {
  if (shell === 'modern') {
    await page.mouse.move(1380, 450);
    await expect(page.getByTestId('modern-binder')).toHaveAttribute('data-state', 'closed');
  }
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

export async function germanComic(page: Page): Promise<void> {
  await page.getByRole('toolbar', { name: 'Scene' }).getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.locator('[data-section="appearance"]').click();
  await settings.locator('input[name="interface-language"][value="de"]').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}
