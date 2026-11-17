import { expect, type Page } from '@playwright/test';

import { createProject, waitForSaved } from './support.js';

export async function createGoalScene(page: Page, title: string, shell: 'classic' | 'modern', synopsis = false): Promise<void> {
  await createProject(page, title);
  if (shell === 'modern') {
    await page.getByRole('navigation', { name: 'Binder' }).getByRole('button', { name: 'Binder', exact: true }).click();
    await expect(page.getByTestId('modern-binder')).toHaveAttribute('data-state', 'open');
  }
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('Opening');
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Document text' }).fill('The boat reached the harbour before dawn.');
  if (shell === 'modern') {
    await page.mouse.move(700, 450);
    await expect(page.getByTestId('modern-binder')).toHaveAttribute('data-state', 'closed');
  }
  if (synopsis) {
    if (shell === 'modern') {
      await page.keyboard.press('Control+k');
      const palette = page.getByRole('dialog', { name: 'Search and commands' });
      await palette.getByRole('combobox', { name: 'Search scenes, codex and commands' }).fill('Scene info');
      await palette.getByRole('option').filter({ has: page.locator('.modern-palette-label', { hasText: /^Scene info$/ }) }).first().click();
      const info = page.getByRole('dialog', { name: 'Scene info' });
      await info.getByRole('textbox', { name: 'Synopsis', exact: true }).fill('The boat returns.');
      await page.keyboard.press('Escape');
      await expect(info).toBeHidden();
    } else await page.getByRole('textbox', { name: 'Synopsis', exact: true }).fill('The boat returns.');
  }
  await waitForSaved(page);
}

