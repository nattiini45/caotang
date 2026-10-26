import { expect, test, type Page } from '@playwright/test';

import { createProject, writerText } from './support.js';

/**
 * A project is renamed from the projects list (Home.tsx): the rename is the project's own `project.rename` command, so the name the
 * list shows, the name the toolbar shows when the project opens, and the name the project file holds are the same one. A blank name is
 * not saved, and Escape leaves the name as it was.
 */

/** The projects screen, from a project's workspace. */
async function projectsScreen(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Projects in this browser' })).toBeVisible();
}

test('a project is renamed from the projects list, and it opens under its new name', async ({ page }) => {
  await createProject(page, 'Old Name');
  await projectsScreen(page);

  await page.getByRole('button', { name: 'Rename Old Name' }).click();
  const form = page.getByRole('form', { name: 'New name for Old Name' });
  await form.getByRole('textbox', { name: 'New name', exact: true }).fill('New Name');
  await form.getByRole('button', { name: 'Save the name' }).click();

  await expect(page.getByText(new RegExp(`Renamed the project to “${writerText('New Name')}”\\.`))).toBeVisible();
  await expect(page.locator('.project-row .project-name', { hasText: 'New Name' })).toBeVisible();
  await expect(page.locator('.project-row .project-name', { hasText: 'Old Name' })).toHaveCount(0);

  await page.getByRole('listitem').filter({ hasText: 'New Name' }).getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  await expect(page.locator('h1.project-name')).toContainText('New Name');
});

test('a blank name is not saved, and Escape keeps the name the project had', async ({ page }) => {
  await createProject(page, 'Keep Name');
  await projectsScreen(page);

  await page.getByRole('button', { name: 'Rename Keep Name' }).click();
  const form = page.getByRole('form', { name: 'New name for Keep Name' });
  const field = form.getByRole('textbox', { name: 'New name', exact: true });
  await field.fill('   ');
  await expect(form.getByRole('button', { name: 'Save the name' })).toBeDisabled();

  await field.press('Escape');
  await expect(form).toHaveCount(0);
  await expect(page.locator('.project-row .project-name', { hasText: 'Keep Name' })).toBeVisible();
});
