/**
 * The sheets the toolbar and the dialogs are styled by must be in the chunk that draws them (vite splits CSS per chunk). The project
 * panel, the Skills panel and the vocabulary editor used to be the only eager importers of `project-dialogs.css` and
 * `skills-dialog.css`; they now load on use, so the workspace keeps the first sheet in the entry and the agent panel keeps the second.
 * Without them the project's name paints as a browser default button, a dialog opens with no backdrop and the compile dialog's field
 * rows lose their grid — none of which a build failure would catch, so this spec reads the computed styles the first paint draws.
 */

import { expect, test } from '@playwright/test';

import { createProject, waitForSaved } from './support.js';

test('the project name and the dialogs the panels no longer load eagerly are still styled', async ({ page }) => {
  await createProject(page, 'Night Shift');

  // `.project-name-button` lives in project-dialogs.css; a browser default button would have a border and a grey background.
  const name = page.locator('.project-name-button');
  await expect(name).toBeVisible();
  await expect(name).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(name).toHaveCSS('border-top-width', '0px');

  // The Skills panel draws `.project-dialog` (width, padding, backdrop) from the same sheet, and only `.skills-dialog` itself from its own.
  await page.getByRole('button', { name: 'Skills', exact: true }).click();
  const skills = page.getByRole('dialog', { name: 'Skills' });
  await expect(skills).toBeVisible();
  await expect(skills).toHaveCSS('padding-top', '0px');
  await expect(skills).not.toHaveCSS('width', 'auto');
  await page.keyboard.press('Escape');
  await expect(skills).toBeHidden();
  await waitForSaved(page);

  // The compile dialog draws `.export-field` rows from the same sheet and imports no CSS of its own.
  await page.getByRole('button', { name: 'Compile…', exact: true }).click();
  const compile = page.getByRole('dialog', { name: 'Export' });
  await expect(compile).toBeVisible();
  await expect(compile.locator('.export-field').first()).toHaveCSS('display', 'grid');
  await page.keyboard.press('Escape');
  await expect(compile).toBeHidden();
});

test('a readers chunk that cannot be fetched says so instead of doing nothing', async ({ page }) => {
  await createProject(page, 'Night Shift');
  // The readers load when a file is chosen; a tab older than the deploy that renamed the chunk cannot fetch it.
  await page.route(/script-import-readers/, (route) => route.abort());
  await page.locator('input[type="file"][aria-label="Script file"]').setInputFiles({ name: 'old.fdx', mimeType: 'text/xml', buffer: Buffer.from('<FinalDraft/>') });
  await expect(page.getByText('The import readers could not be loaded. Reload the page and try again.')).toBeVisible();
});
