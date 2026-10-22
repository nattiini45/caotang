import { expect, test, type Page } from '@playwright/test';

import { binderRow, binderTitle, countOf, createProject, firstChapter, waitForSaved } from './support.js';

/**
 * The dialogue container a scene is compared with (coherence.md §5.1 `medium.speaker-parity`, ui-modules.md §4): the writer
 * links a scene to a container in the Inspector's scene declarations, the list holds only the live dialogue containers, and
 * clearing the link is a command of its own. Each change is one `coherence.setSceneMeta`.
 */

async function sceneWithDialogue(page: Page): Promise<void> {
  await createProject(page, 'Link Book');
  const chapter = await firstChapter(page);
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('Scene A');
  await page.keyboard.press('Enter');
  await expect(binderRow(page, 'Scene A')).toBeVisible();

  await binderTitle(page, chapter).click({ button: 'right' });
  await page.getByRole('menu', { name: `Actions for ${chapter}` }).getByRole('menuitem', { name: 'New dialogue here' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'Dialogue: Untitled dialogue' })).toBeVisible();
}

async function openDeclarations(page: Page): Promise<void> {
  const meta = page.getByTestId('scene-meta');
  if ((await meta.getAttribute('open')) === null) await meta.locator('summary').click();
}

test('a scene is linked to a dialogue container in the inspector, the list holds only dialogue containers, and the link clears and survives a reload', async ({ page }) => {
  await sceneWithDialogue(page);
  await binderTitle(page, 'Scene A').click();
  await openDeclarations(page);

  const field = page.getByRole('combobox', { name: 'Dialogue container' });
  await expect(field).toHaveValue('');
  // The documents of the binder are not offered: only the dialogue container is.
  await expect(field.locator('option')).toHaveText(['No dialogue container linked', 'Untitled dialogue']);

  await field.selectOption({ label: 'Untitled dialogue' });
  await expect(field).toHaveValue(/.+/);
  await expect.poll(() => countOf(page, 'coherence.setSceneMeta')).toBe(1);
  await expect(page.getByTestId('dialogue-container-missing')).toHaveCount(0);
  await waitForSaved(page);

  await page.reload();
  await page.locator('.project-row', { hasText: 'Link Book' }).getByRole('button', { name: 'Open' }).click();
  await binderTitle(page, 'Scene A').click();
  await openDeclarations(page);
  await expect(page.getByRole('combobox', { name: 'Dialogue container' })).toHaveValue(/.+/);

  await page.getByRole('combobox', { name: 'Dialogue container' }).selectOption({ label: 'No dialogue container linked' });
  await expect(page.getByRole('combobox', { name: 'Dialogue container' })).toHaveValue('');
  await expect.poll(() => countOf(page, 'coherence.setSceneMeta')).toBe(1);

  // A scan says how many scenes it compared, so a link that compares nothing is never silent.
  await page.getByRole('tab', { name: 'Findings' }).click();
  await page.getByRole('button', { name: 'Scan the manuscript' }).click();
  await expect(page.getByTestId('run-history')).toContainText(
    'speaker parity: 0 scene(s) linked, 0 scene(s) have no dialogue container link; they are not compared',
  );
});
