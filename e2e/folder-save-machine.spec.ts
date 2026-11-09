import { expect, test } from '@playwright/test';

import { holdFolderSave, releaseFolderPicker, releaseFolderWrite } from './folder-save-support.js';
import { createProject, FOLDER_ACCESS_ONLY } from './support.js';

test.skip(({ browserName }) => browserName !== 'chromium', FOLDER_ACCESS_ONLY);

test('a repeated folder save gesture starts one picker and publishes its progress', async ({ page }) => {
  await holdFolderSave(page);
  await createProject(page, 'Folder save');
  await page.getByRole('button', { name: 'Save to folder', exact: true }).evaluate((button) => {
    (button as unknown as { click(): void }).click();
    (button as unknown as { click(): void }).click();
  });
  expect(await page.evaluate(() => (globalThis as unknown as { folderPickerCalls: number }).folderPickerCalls)).toBe(1);
  await releaseFolderPicker(page);
  await expect(page.getByTestId('folder-save')).toHaveAttribute('data-state', 'saving');
  await expect(page.getByRole('status').filter({ hasText: 'Saving to the folder…' })).toBeVisible();
  await page.getByRole('button', { name: 'Save to folder', exact: true }).click();
  expect(await page.evaluate(() => (globalThis as unknown as { folderPickerCalls: number }).folderPickerCalls)).toBe(1);
  await releaseFolderWrite(page);
  await expect(page.getByTestId('folder-save')).toHaveAttribute('data-state', 'saved');
  await expect(page.getByRole('status').filter({ hasText: 'Saved the project to the folder' })).toBeVisible();
});
