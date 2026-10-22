import { expect, test, type Page } from '@playwright/test';

import { binderTitle, countOf, createProject } from './support.js';

/**
 * The inspector's number fields follow the project (coherence.md §5.2): a field shows what the
 * project holds, so a value the project took back leaves the field showing nothing, and leaving the
 * field writes nothing.
 */

function inspector(page: Page) {
  return page.getByRole('complementary', { name: 'Inspector' });
}

/** A chapter with one scene in it, the scene selected, and its scene declarations open. */
async function selectedScene(page: Page): Promise<void> {
  await createProject(page, 'Scene Draft Book');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('The Landing');
  await page.keyboard.press('Enter');
  await binderTitle(page, 'The Landing').click();
  await page.getByTestId('scene-meta').locator('summary').click();
  await expect(inspector(page).getByRole('spinbutton', { name: 'Day offset' })).toBeVisible();
}

test('a day offset the project took back leaves the field showing what the project holds', async ({ page }) => {
  await selectedScene(page);
  const dayOffset = inspector(page).getByRole('spinbutton', { name: 'Day offset' });

  await dayOffset.fill('7');
  await dayOffset.blur();
  await expect(dayOffset).toHaveValue('7');

  // The focus leaves the field, so the chord is the app's undo and not the field's own.
  await binderTitle(page, 'The Landing').click();
  await page.keyboard.press('Control+z');

  // The project holds no day offset now, so the field shows none: it does not keep the number the
  // project took back.
  await expect(dayOffset).toHaveValue('');
});

test('leaving a day offset the project took back writes nothing', async ({ page }) => {
  await selectedScene(page);
  const dayOffset = inspector(page).getByRole('spinbutton', { name: 'Day offset' });

  await dayOffset.fill('7');
  await dayOffset.blur();
  await expect(dayOffset).toHaveValue('7');

  await binderTitle(page, 'The Landing').click();
  await page.keyboard.press('Control+z');
  await expect(dayOffset).toHaveValue('');

  // The field is left once more. The draft is the project's own value, so nothing is written: the
  // number the project took back is not put back by a blur.
  const before = await countOf(page, 'coherence.setSceneMeta');
  await dayOffset.focus();
  await dayOffset.blur();
  expect(await countOf(page, 'coherence.setSceneMeta')).toBe(before);
  await expect(dayOffset).toHaveValue('');
});
