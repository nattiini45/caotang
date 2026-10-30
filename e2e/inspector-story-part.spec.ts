import { expect, test, type Page } from '@playwright/test';

import { binderRow, binderTitle, createProject, traceNames, waitForSaved } from './support.js';

/**
 * Negative days and story parts in the Inspector (coherence.md §5.2.2, §8; timeline.md §2.2–§2.3): the day field takes a minus
 * sign and reads it back as "Day −14", a folder declares a part that covers its scenes, and a scene's own part wins.
 */
/** Opens the scene declarations, which keep their own open state across a selection change. */
async function openDeclarations(page: Page): Promise<void> {
  const details = page.getByTestId('scene-meta');
  if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open))) await details.locator('summary').click();
}

test('a scene takes a day before day 0, and a folder’s epilogue covers its scene until the scene declares its own part', async ({ page }) => {
  await createProject(page, 'Parts Book');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await expect(binderRow(page, 'Chapter 1')).toBeVisible();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('Years later');
  await page.keyboard.press('Enter');
  await expect(binderRow(page, 'Years later')).toBeVisible();

  await binderTitle(page, 'Years later').click();
  await openDeclarations(page);
  const day = page.getByRole('spinbutton', { name: 'Day offset' });
  await day.fill('-14');
  await day.press('Enter');
  await expect(page.getByTestId('day-offset-note')).toHaveText('Day \u221214, before day 0.');
  await expect.poll(() => traceNames(page)).toContain('coherence.setSceneMeta');

  // A day past the range is put back, not committed.
  await day.fill('-10000001');
  await day.press('Enter');
  await expect(day).toHaveValue('-14');

  await binderTitle(page, 'Chapter 1').click();
  const folderPart = page.getByTestId('folder-story-part').getByRole('combobox', { name: 'Story part' });
  await folderPart.selectOption('epilogue');
  await expect(folderPart).toHaveValue('epilogue');

  await binderTitle(page, 'Years later').click();
  await openDeclarations(page);
  await expect(page.getByTestId('story-part-note')).toHaveText('Covered by the folder “Chapter 1”, which is declared epilogue.');
  const scenePart = page.getByTestId('scene-meta').getByRole('combobox', { name: 'Story part' });
  await expect(scenePart).toHaveValue('');
  await scenePart.selectOption('prologue');
  await expect(scenePart).toHaveValue('prologue');
  await expect(page.getByTestId('story-part-note')).toHaveText('A long jump into the epilogue or out of the prologue is never reported as a gap.');

  await page.getByRole('textbox', { name: 'Document text' }).click();
  await page.keyboard.type('The house had been empty for years.');
  await waitForSaved(page);
});
