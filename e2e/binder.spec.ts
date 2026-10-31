import { expect, test, type Page } from '@playwright/test';

import { binderRow, binderTitle, createProject, projectTrace, rejected, trace, traceNames, waitForSaved } from './support.js';

/**
 * ui-modules §2: the binder's gestures, the keyboard map, the delete confirmation and the
 * drop rules, each asserted against the commands it emits.
 */

/** The binder's own toolbar. The editor's empty state has a button of the same name, so the scope matters. */
function binderToolbar(page: Page) {
  return page.getByRole('toolbar', { name: 'Binder actions' });
}

/** A chapter with two scenes in it, built from the binder the way a writer would. */
async function chapterWithScenes(page: Page): Promise<void> {
  await createProject(page, 'Binder Book');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await expect(binderRow(page, 'Chapter 1')).toBeVisible();
  for (const scene of ['Scene A', 'Scene B']) {
    await binderToolbar(page).getByRole('button', { name: 'New document' }).click();
    const field = page.getByRole('textbox', { name: 'Rename Untitled' });
    await field.fill(scene);
    await page.keyboard.press('Enter');
    await expect(binderRow(page, scene)).toBeVisible();
  }
}

/** The titles of the binder's rows, top to bottom, sections excluded. */
async function binderTitles(page: Page): Promise<string[]> {
  return page.locator('.binder-tree .row:not(.is-section) .row-title').allTextContents();
}

test('a chapter created from the empty state is named in place, with no rename opened', async ({ page }) => {
  await createProject(page, 'Named Chapter');

  await page.getByRole('button', { name: 'Create Chapter 1' }).click();

  await expect(binderRow(page, 'Chapter 1')).toBeVisible();
  await expect(page.getByRole('textbox', { name: /^Rename / })).toHaveCount(0);
  expect(await traceNames(page)).toEqual(['binder.create', 'view.setSelection', 'view.setCorkboardScope']);
});

test('a new document opens in rename, and Escape cancels without a rename command', async ({ page }) => {
  await createProject(page, 'Escape Book');
  // A document goes inside a chapter, so the chapter is made first and is the selection New document uses.
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await expect(binderRow(page, 'Chapter 1')).toBeVisible();

  await binderToolbar(page).getByRole('button', { name: 'New document' }).click();
  const field = page.getByRole('textbox', { name: 'Rename Untitled' });
  await expect(field).toBeFocused();
  await page.keyboard.press('Escape');

  await expect(field).toHaveCount(0);
  await expect(binderRow(page, 'Untitled')).toBeVisible();
  expect(await projectTrace(page)).toEqual(['binder.create', 'binder.create']);
});

test('New document with nothing selected is refused in words, and makes no loose scene under the manuscript', async ({ page }) => {
  await createProject(page, 'Loose Book');

  await binderToolbar(page).getByRole('button', { name: 'New document' }).click();
  await expect(page.getByText('A document goes inside a chapter, not directly under the manuscript.')).toBeVisible();
  await expect(binderRow(page, 'Untitled')).toHaveCount(0);
  expect(await projectTrace(page)).toEqual([]);

  // The writer's way in: a chapter from New folder (the manuscript is the folder's place with nothing selected), then the document.
  await binderToolbar(page).getByRole('button', { name: 'New folder' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('Chapter 1');
  await page.keyboard.press('Enter');
  await expect(binderRow(page, 'Chapter 1')).toHaveAttribute('aria-level', '2');
  await binderToolbar(page).getByRole('button', { name: 'New document' }).click();
  await expect(page.getByRole('textbox', { name: 'Rename Untitled' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(binderRow(page, 'Untitled')).toHaveAttribute('aria-level', '3');
});

test('Ctrl+N with nothing selected is refused in the same words as the button, and dispatches no binder.create', async ({ page }) => {
  await createProject(page, 'Shortcut Book');

  await page.keyboard.press('Control+n');
  await expect(page.getByText('A document goes inside a chapter, not directly under the manuscript.')).toBeVisible();
  await expect(binderRow(page, 'Untitled')).toHaveCount(0);
  expect(await projectTrace(page)).not.toContain('binder.create');
  expect((await rejected(page)).filter((row) => row.command === 'binder.create')).toEqual([]);
});

test('on a project with no chapter the empty editor offers New chapter, not a New document that would be refused', async ({ page }) => {
  await createProject(page, 'Empty Editor Book');
  const editor = page.locator('.editor-pane.is-empty');

  await expect(editor.getByRole('button', { name: 'New document', exact: true })).toHaveCount(0);
  await editor.getByRole('button', { name: 'New chapter', exact: true }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('Chapter 1');
  await page.keyboard.press('Enter');
  await expect(binderRow(page, 'Chapter 1')).toHaveAttribute('aria-level', '2');
  expect(await projectTrace(page)).toEqual(['binder.create', 'binder.rename']);

  // With the chapter selected, a document has a place, so the empty editor offers New document again.
  await expect(editor.getByRole('button', { name: 'New document', exact: true })).toBeVisible();
  await expect(editor.getByRole('button', { name: 'New chapter', exact: true })).toHaveCount(0);
});

test('a bare status chip is at least 24 px square, and one that carries words grows to hold them instead of spilling into the title', async ({
  page,
}) => {
  await chapterWithScenes(page);
  const chip = binderRow(page, 'Scene A').locator('.chip.chip-status.is-bare');
  const box = await chip.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(24);
  expect(box?.height).toBeGreaterThanOrEqual(24);

  // A status the project no longer holds reads "Unknown status" on the same bare chip (Binder.tsx). Only an imported or hand-edited
  // project reaches it, so the words are put on the rendered chip here, and the chip must be as wide as what it holds.
  const fits = await chip.evaluate((element) => {
    element.append('Unknown status');
    return element.scrollWidth <= element.clientWidth;
  });
  expect(fits).toBe(true);
});

test('a double-click on a title opens it for rename, and Enter commits the new name', async ({ page }) => {
  await chapterWithScenes(page);

  await binderTitle(page, 'Scene A').dblclick();
  const field = page.getByRole('textbox', { name: 'Rename Scene A' });
  await expect(field).toBeFocused();
  await field.fill('Scene A, revised');
  await page.keyboard.press('Enter');

  await expect(binderRow(page, 'Scene A, revised')).toBeVisible();
  expect((await trace(page)).filter((row) => row.command === 'binder.rename').at(-1)?.summary).toBe(
    'renamed "Scene A" to "Scene A, revised"',
  );
});

test('F2 renames the selected row, Enter commits it, and an empty title reverts', async ({ page }) => {
  await chapterWithScenes(page);

  await binderTitle(page, 'Chapter 1').click();
  await page.keyboard.press('F2');
  await page.getByRole('textbox', { name: 'Rename Chapter 1' }).fill('Part One');
  await page.keyboard.press('Enter');
  await expect(binderRow(page, 'Part One')).toBeVisible();

  await binderTitle(page, 'Part One').click();
  await page.keyboard.press('F2');
  await page.getByRole('textbox', { name: 'Rename Part One' }).fill('   ');
  await page.keyboard.press('Enter');
  await expect(binderRow(page, 'Part One')).toBeVisible();

  const renames = (await trace(page)).filter((row) => row.command === 'binder.rename');
  expect(renames.map((row) => row.summary)).toEqual([
    'renamed "Untitled" to "Scene A"',
    'renamed "Untitled" to "Scene B"',
    'renamed "Chapter 1" to "Part One"',
  ]);
});

test('Delete asks first and names what goes; Cancel keeps everything', async ({ page }) => {
  await chapterWithScenes(page);
  await binderTitle(page, 'Chapter 1').click();

  await page.keyboard.press('Delete');
  const dialog = page.getByRole('dialog', { name: 'Delete “Chapter 1”?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('2 items inside it');
  await expect(dialog).toContainText('across 2 documents');
  await expect(dialog).toContainText('Ctrl+Z');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await expect(dialog).toBeHidden();
  await expect(binderRow(page, 'Chapter 1')).toBeVisible();
  expect(await projectTrace(page)).not.toContain('project.deleteNode');
});

test('a confirmed delete removes the subtree, and Ctrl+Z brings it back whole', async ({ page }) => {
  await chapterWithScenes(page);
  await binderTitle(page, 'Chapter 1').click();

  await page.keyboard.press('Delete');
  await page.getByRole('dialog', { name: 'Delete “Chapter 1”?' }).getByRole('button', { name: 'Delete' }).click();
  await expect(binderRow(page, 'Chapter 1')).toHaveCount(0);
  await expect(binderRow(page, 'Scene A')).toHaveCount(0);

  const deletes = (await trace(page)).filter((row) => row.command === 'project.deleteNode');
  expect(deletes).toHaveLength(1);
  expect(deletes[0]?.issuedBy).toBe('user');
  expect(deletes[0]?.affected.map((node) => node.title)).toEqual(['Chapter 1', 'Scene A', 'Scene B']);

  await page.keyboard.press('Control+z');
  await expect(binderRow(page, 'Chapter 1')).toBeVisible();
  await expect(binderRow(page, 'Scene A')).toBeVisible();
  await expect(binderRow(page, 'Scene B')).toBeVisible();
});

test('after a keyboard delete is confirmed, focus goes to the row that takes the removed one, not to the page', async ({ page }) => {
  await chapterWithScenes(page);
  await binderTitle(page, 'Scene A').click();

  await page.keyboard.press('Delete');
  await expect(page.getByRole('dialog', { name: 'Delete “Scene A”?' })).toBeVisible();
  // The keyboard path: Tab from Cancel to Delete, and Enter confirms.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');

  await expect(binderRow(page, 'Scene A')).toHaveCount(0);
  await expect(binderRow(page, 'Scene B')).toBeFocused();
});

test('a section cannot be renamed or deleted from the keyboard', async ({ page }) => {
  await createProject(page, 'Sections Book');
  const manuscript = page.locator('.row.is-section', { hasText: 'Manuscript' });

  await manuscript.click();
  await page.keyboard.press('F2');
  await expect(page.getByRole('textbox', { name: /^Rename / })).toHaveCount(0);
  await page.keyboard.press('Delete');
  await expect(page.getByRole('dialog')).toBeHidden();

  // The bus refuses both commands on a fixed root, and a refusal writes no activity row. So the trace
  // cannot tell a key that never dispatched from one that dispatched and was turned away; the rejections
  // can, and a keyboard path that sent either command to the bus would show up there.
  expect(await projectTrace(page)).not.toContain('binder.rename');
  expect(await projectTrace(page)).not.toContain('project.deleteNode');
  const attempted = (await rejected(page)).filter((row) => ['binder.rename', 'project.deleteNode'].includes(row.command));
  expect(attempted).toEqual([]);
});

test('a document dropped on the upper edge of another moves there, and the trace names the move', async ({ page }) => {
  await chapterWithScenes(page);
  expect(await binderTitles(page)).toEqual(['Chapter 1', 'Scene A', 'Scene B']);

  await binderRow(page, 'Scene B').dragTo(binderRow(page, 'Scene A'), { targetPosition: { x: 20, y: 2 } });

  await expect.poll(() => binderTitles(page)).toEqual(['Chapter 1', 'Scene B', 'Scene A']);
  const move = (await trace(page)).find((row) => row.command === 'binder.move');
  expect(move?.summary).toBe('moved "Scene B" to position 0 under "Chapter 1"');
});

test('a document dropped on a folder moves into it, and the trace names the new parent', async ({ page }) => {
  await chapterWithScenes(page);
  // A second chapter, made from the manuscript section so it sits beside Chapter 1.
  await page.locator('.row.is-section', { hasText: 'Manuscript' }).click();
  await binderToolbar(page).getByRole('button', { name: 'New folder' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('Chapter 2');
  await page.keyboard.press('Enter');
  await expect(binderRow(page, 'Chapter 2')).toBeVisible();

  // The middle of the folder's row is "into": the scene is appended to it.
  await binderRow(page, 'Scene A').dragTo(binderRow(page, 'Chapter 2'));

  await expect.poll(() => binderTitles(page)).toEqual(['Chapter 1', 'Scene B', 'Chapter 2', 'Scene A']);
  const move = (await trace(page)).find((row) => row.command === 'binder.move');
  expect(move?.summary).toBe('moved "Scene A" to position 0 under "Chapter 2"');
});

test('a right-click opens the binder menu for the row, and Rename from it opens the field', async ({ page }) => {
  await chapterWithScenes(page);

  await binderTitle(page, 'Scene B').click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Actions for Scene B' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Open in editor' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Delete…' })).toBeVisible();

  await menu.getByRole('menuitem', { name: 'Rename' }).click();
  await expect(page.getByRole('textbox', { name: 'Rename Scene B' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('a folder cannot be dropped into its own child, and nothing is moved', async ({ page }) => {
  await chapterWithScenes(page);
  const before = await traceNames(page);

  await binderRow(page, 'Chapter 1').dragTo(binderRow(page, 'Scene A'));

  expect(await traceNames(page)).toEqual(before);
  await expect(binderRow(page, 'Chapter 1')).toBeVisible();
});

test('Ctrl+Enter opens the selected scene in the editor, and the arrow keys select it first', async ({ page }) => {
  await chapterWithScenes(page);
  // The corkboard is showing after the chapter was made; the scene is opened from the binder's keys.
  await binderTitle(page, 'Chapter 1').click();
  await page.keyboard.press('ArrowDown');
  await expect(binderRow(page, 'Scene A')).toHaveAttribute('aria-selected', 'true');

  await page.keyboard.press('Control+Enter');

  await expect(page.getByRole('textbox', { name: 'Document text' })).toBeFocused();
  await expect(page.locator('.editor-title', { hasText: 'Scene A' })).toBeVisible();
  expect((await traceNames(page)).slice(-1)).toEqual(['view.setActiveDoc']);
});

test('the arrow keys move the selection through the visible rows, and Left and Right fold a folder', async ({ page }) => {
  await chapterWithScenes(page);
  // A second folder beside Chapter 1: made from the manuscript section, so it is a sibling and not a child.
  await page.locator('.row.is-section', { hasText: 'Manuscript' }).click();
  await binderToolbar(page).getByRole('button', { name: 'New folder' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('Chapter 2');
  await page.keyboard.press('Enter');
  await binderTitle(page, 'Chapter 1').click();

  await page.keyboard.press('ArrowDown');
  await expect(binderRow(page, 'Scene A')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(binderRow(page, 'Scene B')).toHaveAttribute('aria-selected', 'true');

  // A folder under a section starts open. Left folds it and hides its scenes, and Right opens it again;
  // each fold is a view.setExpanded override, and the trace records it.
  await binderTitle(page, 'Chapter 1').click();
  await expect(binderRow(page, 'Chapter 1')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(binderRow(page, 'Chapter 1')).toHaveAttribute('aria-expanded', 'false');
  await expect(binderRow(page, 'Scene A')).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(binderRow(page, 'Chapter 1')).toHaveAttribute('aria-expanded', 'true');
  expect((await traceNames(page)).slice(-1)).toEqual(['view.setExpanded']);
});

test('a new folder from the toolbar goes beside the chapter the selection is in', async ({ page }) => {
  await chapterWithScenes(page);

  // Scene B is selected and sits in Chapter 1; a folder made from here is a chapter beside Chapter 1, in the manuscript.
  await binderTitle(page, 'Scene B').click();
  await binderToolbar(page).getByRole('button', { name: 'New folder' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('Chapter 2');
  await page.keyboard.press('Enter');
  await expect(binderRow(page, 'Chapter 2')).toBeVisible();
  // Level 2 is a section's child; a folder inside Chapter 1 would be level 3.
  await expect(binderRow(page, 'Chapter 2')).toHaveAttribute('aria-level', '2');

  // The same from a chapter: with Chapter 1 selected, the new folder lands beside it, in the manuscript.
  await binderTitle(page, 'Chapter 1').click();
  await binderToolbar(page).getByRole('button', { name: 'New folder' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('Chapter 3');
  await page.keyboard.press('Enter');
  await expect(binderRow(page, 'Chapter 3')).toBeVisible();
  await expect(binderRow(page, 'Chapter 3')).toHaveAttribute('aria-level', '2');
});

test('the context menu offers a new folder on a section and a folder, and a new document on a folder but not the manuscript', async ({ page }) => {
  await chapterWithScenes(page);

  await binderTitle(page, 'Chapter 1').click({ button: 'right' });
  const folderMenu = page.getByRole('menu', { name: 'Actions for Chapter 1' });
  await expect(folderMenu.getByRole('menuitem', { name: 'New document here' })).toBeVisible();
  await expect(folderMenu.getByRole('menuitem', { name: 'New folder here' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);

  await page.locator('.row.is-section', { hasText: 'Manuscript' }).click({ button: 'right' });
  const sectionMenu = page.getByRole('menu', { name: 'Actions for Manuscript' });
  await expect(sectionMenu.getByRole('menuitem', { name: 'New folder here' })).toBeVisible();
  // The manuscript takes chapters only, so its menu offers no document. A screenplay scene there is the media
  // track's own entry, which its tests place on the manuscript, so it is left as it is (see the round's cross-scope requests).
  await expect(sectionMenu.getByRole('menuitem', { name: 'New document here' })).toHaveCount(0);
});

test('a part: a folder moved into the folder above holds chapters, says so, and keeps them after a reload (#269)', async ({ page }) => {
  await chapterWithScenes(page);

  // A new folder beside Chapter 1, named as a part, then moved above it with Alt+Up.
  await binderTitle(page, 'Chapter 1').click();
  await binderToolbar(page).getByRole('button', { name: 'New folder' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('Part One');
  await page.keyboard.press('Enter');
  await binderTitle(page, 'Part One').click();
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => binderTitles(page)).toEqual(['Part One', 'Chapter 1', 'Scene A', 'Scene B']);

  // Alt+Right moves Chapter 1 into the folder above, which now holds a chapter: a part, one level up, that says "Part" in words.
  await binderTitle(page, 'Chapter 1').click();
  await page.keyboard.press('Alt+ArrowRight');
  await expect(binderRow(page, 'Chapter 1')).toHaveAttribute('aria-level', '3');
  await expect(binderRow(page, 'Part One')).toHaveAttribute('data-role', 'part');
  await expect(binderRow(page, 'Part One').locator('.row-role')).toHaveText('Part');
  await expect(binderRow(page, 'Chapter 1')).toHaveAttribute('data-role', 'chapter');
  expect((await projectTrace(page)).slice(-1)).toEqual(['binder.move']);

  // The nesting is the project's: it is there after a reload.
  await waitForSaved(page);
  await page.reload();
  await page.getByRole('listitem').filter({ hasText: 'Binder Book' }).getByRole('button', { name: 'Open' }).click();
  await expect(binderRow(page, 'Chapter 1')).toHaveAttribute('aria-level', '3');
  await expect(binderRow(page, 'Part One')).toHaveAttribute('data-role', 'part');
});

test('with nothing selected after a load, Tab reaches the tree and the arrow keys start it', async ({ page }) => {
  await chapterWithScenes(page);
  await waitForSaved(page);

  // A reload leaves nothing selected, since view state is not persisted.
  await page.reload();
  await page.getByRole('listitem').filter({ hasText: 'Binder Book' }).getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();

  // Tab from the top of the page until a binder row has focus. With no row in the tab order, Tab walks
  // straight past the tree and this loop runs out.
  for (let press = 0; press < 40; press += 1) {
    if ((await page.evaluate(() => document.activeElement?.getAttribute('role') ?? null)) === 'treeitem') break;
    await page.keyboard.press('Tab');
  }
  const manuscript = page.locator('.row.is-section', { hasText: 'Manuscript' });
  await expect(manuscript).toBeFocused();

  await page.keyboard.press('ArrowDown');
  await expect(manuscript).toHaveAttribute('aria-selected', 'true');
});

test('a status change from the binder chip is one binder.setMeta, and the chip shows the new status', async ({ page }) => {
  await chapterWithScenes(page);

  await binderRow(page, 'Scene A').getByRole('button', { name: /^Status of Scene A/ }).click();
  await page.getByRole('menuitemradio', { name: 'Revised' }).click();

  await expect(binderRow(page, 'Scene A').getByRole('button', { name: /^Status of Scene A/ })).toContainText('Revised');
  const meta = (await trace(page)).filter((row) => row.command === 'binder.setMeta');
  expect(meta).toHaveLength(1);
  expect(meta[0]?.affected.map((node) => node.title)).toEqual(['Scene A']);
});
