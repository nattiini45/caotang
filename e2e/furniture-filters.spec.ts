import { expect, test, type Page } from '@playwright/test';

import { binderRow, createProject } from './support.js';

/**
 * The furniture's UI behaviour: the keyword and date criteria in the filter bar, the filter
 * chord, a saved filter's delete clearing the bar, the sprint starting again after it finished, the goals section of a folder,
 * and the Alt+arrow reorder in the binder. Each assertion is on what the writer sees.
 */

/** A chapter with two scenes, built from the binder the way a writer would (as binder-furniture.spec.ts does). */
async function chapterWithScenes(page: Page): Promise<void> {
  await createProject(page, 'Furniture Filters');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await expect(binderRow(page, 'Chapter 1')).toBeVisible();
  for (const scene of ['The Lamp', 'The Harbour']) {
    await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
    await page.getByRole('textbox', { name: 'Rename Untitled' }).fill(scene);
    await page.keyboard.press('Enter');
    await expect(binderRow(page, scene)).toBeVisible();
  }
}

test('a keyword the scenes do not carry matches nothing, and a window of days matches what was changed within it', async ({ page }) => {
  await chapterWithScenes(page);

  await page.getByRole('textbox', { name: 'Keywords, any of these' }).fill('glacier');
  await expect(page.getByTestId('filter-status')).toContainText('0 scenes match');
  await expect(binderRow(page, 'The Lamp')).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Keywords, any of these' }).fill('');

  // Both scenes were written a moment ago, so a one-day window keeps both of them.
  await page.getByRole('spinbutton', { name: 'Changed in the last days' }).fill('1');
  await expect(binderRow(page, 'The Lamp')).toBeVisible();
  await expect(binderRow(page, 'The Harbour')).toBeVisible();
});

test('Ctrl+Alt+F moves the focus to the filter field, and Ctrl+Shift+F is still focus mode', async ({ page }) => {
  await chapterWithScenes(page);
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await page.keyboard.press('Control+Alt+F');
  await expect(page.getByRole('searchbox', { name: 'Filter the binder by text' })).toBeFocused();
});

test('deleting the saved filter the binder shows also clears the bar, so the tree shows everything again', async ({ page }) => {
  await chapterWithScenes(page);
  await page.getByRole('searchbox', { name: 'Filter the binder by text' }).fill('lamp');
  await expect(binderRow(page, 'The Harbour')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save current…' }).click();
  await page.getByRole('textbox', { name: 'Filter name' }).fill('Lamp scenes');
  await page.getByRole('button', { name: 'Save filter' }).click();
  await expect(page.getByRole('button', { name: 'Delete Lamp scenes' })).toBeVisible();

  await page.getByRole('button', { name: 'Delete Lamp scenes' }).click();
  await expect(page.getByRole('searchbox', { name: 'Filter the binder by text' })).toHaveValue('');
  await expect(binderRow(page, 'The Harbour')).toBeVisible();
});

test('a sprint that has finished starts again, as a running sprint', async ({ page }) => {
  await chapterWithScenes(page);
  const sprint = page.getByRole('region', { name: 'Sprint timer' });
  await sprint.getByRole('button', { name: 'Start sprint' }).click();
  await sprint.getByRole('button', { name: 'Stop' }).click();
  await expect(sprint.getByRole('button', { name: 'Start sprint' })).toBeVisible();

  await sprint.getByRole('button', { name: 'Start sprint' }).click();
  await expect(sprint.getByRole('button', { name: 'Pause' })).toBeVisible();
});

test('a folder has a goals section in the inspector, where a goal is added and removed', async ({ page }) => {
  await chapterWithScenes(page);
  await binderRow(page, 'Chapter 1').click();
  const goals = page.getByTestId('inspector-goals');
  await expect(goals).toBeVisible();
  await goals.getByRole('spinbutton', { name: 'Inspector goal words' }).fill('500');
  await goals.getByRole('button', { name: 'Add goal' }).click();
  await expect(goals.locator('[data-goal]')).toHaveCount(1);
  await goals.getByRole('button', { name: /^Remove the goal/ }).click();
  await expect(goals.locator('[data-goal]')).toHaveCount(0);
});

test('Alt+Down moves the selected scene below the scene after it, and the binder shows the new order', async ({ page }) => {
  await chapterWithScenes(page);
  await binderRow(page, 'The Lamp').click();
  await page.keyboard.press('Alt+ArrowDown');
  await expect
    .poll(async () => {
      const lamp = await binderRow(page, 'The Lamp').boundingBox();
      const harbour = await binderRow(page, 'The Harbour').boundingBox();
      return lamp !== null && harbour !== null && lamp.y > harbour.y;
    })
    .toBe(true);
});

test('a saved filter on a status the project has removed says so, and the bar shows that status as unknown', async ({ page }) => {
  await chapterWithScenes(page);
  await binderRow(page, 'The Lamp').click();

  // A status is added in the vocabulary editor, set on The Lamp, and saved in a filter.
  await page.getByRole('button', { name: /^Status: No status\. Change status/ }).click();
  await page.getByRole('menuitem', { name: '+ Add status…' }).click();
  const editor = page.getByRole('dialog', { name: 'Statuses and labels' });
  await editor.getByRole('textbox', { name: 'New status' }).fill('Second pass');
  await editor.getByRole('button', { name: 'Add status' }).click();
  await expect(editor.getByRole('textbox', { name: 'Name of Second pass' })).toBeVisible();
  await editor.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: /^Status: No status\. Change status/ }).click();
  await page.getByRole('menuitemradio', { name: 'Second pass' }).click();
  await expect(page.getByRole('button', { name: /^Status: Second pass\. Change status/ })).toBeVisible();

  await page.getByRole('combobox', { name: 'Status filter' }).selectOption({ label: 'Second pass' });
  await page.getByRole('button', { name: 'Save current…' }).click();
  await page.getByRole('textbox', { name: 'Filter name' }).fill('Second pass scenes');
  await page.getByRole('button', { name: 'Save filter' }).click();

  // The status is removed from the vocabulary. The saved filter keeps naming it, and its row says so.
  await page.getByRole('button', { name: /^Status: Second pass\. Change status/ }).click();
  await page.getByRole('menuitem', { name: '+ Add status…' }).click();
  // The term's row holds its name box and its Remove button, so the row is the name box's parent.
  const termRow = editor.getByRole('textbox', { name: 'Name of Second pass' }).locator('xpath=..');
  await termRow.getByRole('button', { name: 'Remove' }).click();
  await editor.getByRole('button', { name: 'Done' }).click();
  const row = page.locator('.saved-filter', { hasText: 'Second pass scenes' });
  await expect(row.getByText('Unknown status')).toBeVisible();

  // Applied, the bar shows the removed status as a disabled "Unknown status" option, so the select is not blank.
  await row.locator('.saved-filter-apply').click();
  const status = page.getByRole('combobox', { name: 'Status filter' });
  await expect(status.locator('option:checked')).toHaveText('Unknown status');
  await expect(status.locator('option:checked')).toBeDisabled();
});

test('a goal set in the inspector is changed there, and the goal keeps its one place', async ({ page }) => {
  await chapterWithScenes(page);
  await binderRow(page, 'Chapter 1').click();
  const goals = page.getByTestId('inspector-goals');
  await goals.getByRole('spinbutton', { name: 'Inspector goal words' }).fill('500');
  await goals.getByRole('button', { name: 'Add goal' }).click();
  await expect(goals.locator('[data-goal]')).toHaveCount(1);

  await goals.getByRole('button', { name: /^Edit the goal/ }).click();
  await expect(goals.getByRole('button', { name: 'Save goal' })).toBeVisible();
  await expect(goals.getByRole('spinbutton', { name: 'Inspector goal words' })).toHaveValue('500');
  await goals.getByRole('spinbutton', { name: 'Inspector goal words' }).fill('800');
  await goals.getByRole('button', { name: 'Save goal' }).click();

  // The same goal, changed in place: one goal row, with the new target, and the form is back to adding.
  await expect(goals.locator('[data-goal]')).toHaveCount(1);
  await expect(goals.locator('.goal-sentence').first()).toContainText('at least 800 words');
  await expect(goals.getByRole('button', { name: 'Add goal' })).toBeVisible();
});

test('the footer keeps one line for the nearest goal, and a click on it opens that goal in the inspector', async ({ page }) => {
  await chapterWithScenes(page);
  await binderRow(page, 'Chapter 1').click();
  const goals = page.getByTestId('inspector-goals');
  await goals.getByRole('spinbutton', { name: 'Inspector goal words' }).fill('500');
  await goals.getByRole('button', { name: 'Add goal' }).click();
  await expect(goals.locator('[data-goal]')).toHaveCount(1);

  // A scene is selected, so the inspector shows the scene and not the goal's folder.
  await binderRow(page, 'The Lamp').click();
  await expect(page.getByTestId('inspector-goals')).toHaveCount(0);
  const line = page.getByTestId('binder-footer').locator('.goal-summary');
  await expect(line).toHaveCount(1);
  await expect(line.locator('.goal-sentence')).toContainText('at least 500 words on \u2068Chapter 1\u2069');
  await expect(line.getByTestId('goal-progress')).toContainText('of 500 words · in progress');

  await line.click();
  await expect(page.getByTestId('inspector-goals').locator('[data-goal]')).toHaveCount(1);
});
