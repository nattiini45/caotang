import { expect, test } from '@playwright/test';

import { createProject, waitForSaved, writerText } from './support.js';

/**
 * Leaving a project (project-format §8) and running a demo (context-assembly §6): a project left with changes the writer has no
 * copy of is suggested a bundle on the projects screen, once, without holding up the leave; and a demo run works on the sample the
 * writer already has, rather than making another each time.
 */

test('leaving a project with changes since its last bundle suggests one on the projects screen, and the bundle can be made from there', async ({
  page,
}) => {
  await createProject(page, 'Leave Book');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await waitForSaved(page);
  await page.getByRole('button', { name: 'Projects', exact: true }).click();

  const suggestion = page.getByTestId('leave-suggestion');
  await expect(suggestion).toContainText(new RegExp(`“${writerText('Leave Book')}” has changes that are not in a bundle yet`));
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    suggestion.getByRole('button', { name: 'Export a bundle' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.caotang$/);
  await expect(page.getByTestId('leave-suggestion')).toHaveCount(0);
});

test('leaving a project with nothing changed since it was opened suggests nothing', async ({ page }) => {
  await createProject(page, 'Untouched Book');
  await waitForSaved(page);
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Projects in this browser' })).toBeVisible();
  await expect(page.getByTestId('leave-suggestion')).toHaveCount(0);
});

test('a demo run after another reuses the sample, so the projects screen lists one sample', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Draft the opening scene' }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Projects in this browser' })).toBeVisible();

  await page.getByRole('button', { name: 'Check for continuity problems' }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Projects in this browser' })).toBeVisible();

  await expect(page.getByRole('listitem').filter({ hasText: 'Sample manuscript' })).toHaveCount(1);
});
