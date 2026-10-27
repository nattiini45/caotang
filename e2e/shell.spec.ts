import { expect, test } from '@playwright/test';

import { createProject, projectIdOf, trace, waitForSaved, withoutIsolates } from './support.js';

/**
 * The smoke tests of the app shell. The wiring they asserted (the store
 * builds a valid manifest, the bundle resolves through Vite) is now asserted by every
 * suite that creates a project; these keep the boot path itself under test.
 */

test('the projects screen opens with no projects and offers to create one', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Caotang', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create project' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No projects here yet' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('creating a project opens the shell with its two sections and no command history', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await createProject(page, 'A Different Book');

  await expect(page.getByRole('heading', { name: 'A Different Book', level: 1 })).toBeVisible();
  const tree = page.getByRole('tree', { name: 'Binder' });
  // The sections are the fixed roots: they are visible, and they are not rows you rename.
  await expect(tree.getByRole('treeitem', { name: 'Manuscript' })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: 'Research' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'The manuscript is empty' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No document open' })).toBeVisible();
  // Creating a project is not an edit to it, so the activity log starts empty.
  expect(await trace(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('a new project is in the browser store as soon as the shell shows', async ({ page }) => {
  await createProject(page, 'Stored at once');
  await waitForSaved(page);

  expect(await projectIdOf(page)).toMatch(/^p_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/);
});

test('focus mode hides both rails and keeps the open scene exactly where it was', async ({ page }) => {
  await createProject(page);
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('Focused');
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Document text' }).fill('Still here after focus.');
  await waitForSaved(page);

  await page.getByRole('button', { name: 'Focus', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Document text' })).toHaveText('Still here after focus.');

  // The chord toggles it back. It works from the focused button, and from inside the editor.
  await page.keyboard.press('Control+Shift+F');
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
});

test('the Undo button names the writer’s own typing by its scene, with no revision number', async ({ page }) => {
  await createProject(page, 'Undo Words');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('Sitting');
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Document text' }).fill('The lamp was lit at dusk.');
  await waitForSaved(page);

  // The writer's typing is the newest undo group. Its label is the writer's words; the log keeps its own sentence.
  expect(withoutIsolates(await page.getByRole('button', { name: 'Undo', exact: true }).getAttribute('title'))).toBe('Undo: your typing in “Sitting”');
});

test('the Focus button leaves focus mode with a click, so the mode is not left to the chord alone', async ({ page }) => {
  // Desktop Chrome is 1280 by 720 here. In focus mode the centre column used to sit over the toolbar, and a second click on
  // Focus timed out: Playwright's click waits for the button to be the element at its point.
  await createProject(page);
  const focus = page.getByRole('button', { name: 'Focus', exact: true });

  await focus.click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toHaveCount(0);
  // The toolbar keeps the full window width in focus mode, and the centre sits under it.
  const toolbar = await page.locator('.toolbar').boundingBox();
  const centre = await page.locator('.center').boundingBox();
  expect(toolbar?.width).toBe(page.viewportSize()?.width);
  expect(centre?.y ?? 0).toBeGreaterThanOrEqual((toolbar?.y ?? 0) + (toolbar?.height ?? 0) - 1);

  await focus.click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  await expect(focus).toHaveAttribute('aria-pressed', 'false');
});

test('at 1024 pixels wide, with a scene open, the page does not scroll sideways and the inspector ends inside the window', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 720 });
  await createProject(page, 'Narrow Window');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('Narrow scene');
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Document text' }).fill('The save state is in the toolbar.');
  await waitForSaved(page);

  const fit = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    width: window.innerWidth,
    inspectorRight: document.querySelector('.inspector')?.getBoundingClientRect().right ?? null,
  }));
  expect(fit.scrollWidth).toBeLessThanOrEqual(fit.width);
  expect(fit.inspectorRight).not.toBeNull();
  expect(fit.inspectorRight ?? Infinity).toBeLessThanOrEqual(fit.width);
});

test('the centre switches between the editor and the corkboard', async ({ page }) => {
  await createProject(page);
  const editor = page.getByRole('radio', { name: 'Editor' });
  const corkboard = page.getByRole('radio', { name: 'Corkboard' });

  await expect(editor).toHaveAttribute('aria-checked', 'true');
  await corkboard.click();
  await expect(corkboard).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('heading', { name: 'No cards yet' })).toBeVisible();
  await editor.click();
  await expect(editor).toHaveAttribute('aria-checked', 'true');
});
