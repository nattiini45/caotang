import { expect, test } from '@playwright/test';

import { binderRow, createProject, waitForSaved } from './support.js';

/**
 * What a writer in Firefox or Safari (WebKit) gets: no folder picker, so the project lives in the browser and leaves it as a bundle
 * (project-format §4, Home.tsx `folderSupported`). Nothing is stubbed: the browser itself lacks `showDirectoryPicker`. Chromium has the
 * picker, so this spec is for the other two (the `firefox` and `webkit` projects, which the nightly e2e-browsers workflow runs).
 */

test.skip(({ browserName }) => browserName === 'chromium', 'Chromium has the folder picker; lifecycle.spec.ts covers it there');

test('the browser has no folder picker, and the projects screen says so instead of offering one', async ({ page }) => {
  await page.goto('/');
  expect(await page.evaluate(() => 'showDirectoryPicker' in window)).toBe(false);
  await expect(page.getByRole('button', { name: 'Import bundle (.caotang)' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open a folder…' })).toHaveCount(0);
  await expect(page.getByText('Opening and saving a project folder needs a Chromium-based browser. Bundles work everywhere.')).toBeVisible();
});

test('an open project offers no Save to folder, and its bundle exports and imports back as a separate copy', async ({ page }) => {
  await createProject(page, 'Bundle Only');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await expect(binderRow(page, 'Chapter 1')).toBeVisible();
  await waitForSaved(page);
  await expect(page.getByRole('button', { name: 'Save to folder' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Projects' }).click();
  await expect(page.getByRole('heading', { name: 'Projects in this browser' })).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export Bundle Only as a bundle' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.caotang$/);
  const path = await download.path();
  expect(path).not.toBeNull();

  await page.getByTestId('bundle-input').setInputFiles(path ?? '');
  await expect(page.getByRole('heading', { name: 'Bundle Only', level: 1 })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'separate copy' })).toBeVisible();
  await expect(binderRow(page, 'Chapter 1')).toBeVisible();
});
