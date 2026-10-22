/**
 * The media track in the app (screenplay, dialogue and storyboard). A screenplay scene, a storyboard and a dialogue container are made from
 * the binder, open in their own views, keep what the writer typed across a reload, and compile through the bus from the
 * Compile dialog. media/README.md says what each view does; these tests read the app through its gestures and the hook.
 */

import { expect, test, type Page } from '@playwright/test';

import { binderTitle, bodyOf, createProject, firstChapter, idOf, trace, traceNames, waitForSaved } from './support.js';

const SCENE_TEXT = 'INT. LIGHTHOUSE - NIGHT\n\nThe lamp turns.\n';
const INK_TEXT = '=== start ===\nAlice: Hello.\n* [Wave] -> wave\n* [Leave] -> END\n\n=== wave ===\nAlice: Bye.\n-> END\n';
const PROJECT = 'Night Shift';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Makes a node from the context menu of the row it goes under, and leaves it with the title the binder gave it. The
 * new node opens for renaming, and Escape keeps the default title (ui-modules §2.2).
 */
async function makeUnder(page: Page, under: string, item: string): Promise<void> {
  // The media entries are on chapters, so "under the manuscript" is its first chapter, made when there is none.
  const parent = under === 'Manuscript' ? await firstChapter(page) : under;
  await binderTitle(page, parent).click({ button: 'right' });
  await page.getByRole('menu', { name: `Actions for ${parent}` }).getByRole('menuitem', { name: item }).click();
  await page.keyboard.press('Escape');
}

/** Reloads the page and opens the project from the projects list, as a writer does after a restart. */
async function reopen(page: Page): Promise<void> {
  await page.reload();
  await page.getByRole('listitem').filter({ hasText: PROJECT }).getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
}

test('each media node is made from the binder and opens in its own view', async ({ page }) => {
  await createProject(page, PROJECT);

  await makeUnder(page, 'Manuscript', 'New screenplay scene here');
  await expect(page.getByRole('region', { name: 'Screenplay: Untitled scene' })).toBeVisible();

  await makeUnder(page, 'Manuscript', 'New storyboard here');
  await expect(page.getByRole('region', { name: 'Storyboard: Storyboard' })).toBeVisible();

  await makeUnder(page, 'Manuscript', 'New dialogue here');
  await expect(page.getByRole('region', { name: 'Dialogue: Untitled dialogue' })).toBeVisible();
});

test('the text of a screenplay scene and of a dialogue container survives a reload', async ({ page }) => {
  await createProject(page, PROJECT);

  await makeUnder(page, 'Manuscript', 'New screenplay scene here');
  await page.getByRole('radio', { name: 'Source', exact: true }).click();
  await page.getByRole('textbox', { name: 'Fountain source' }).fill(SCENE_TEXT);

  await makeUnder(page, 'Manuscript', 'New dialogue here');
  await page.getByRole('textbox', { name: 'Ink source' }).fill(INK_TEXT);
  await waitForSaved(page);

  // The bodies reach the store under their kind's own names, so the hook reads them back by id.
  const sceneId = await idOf(page, 'Untitled scene');
  const dialogueId = await idOf(page, 'Untitled dialogue');
  await expect.poll(() => bodyOf(page, sceneId)).toContain('The lamp turns.');
  await expect.poll(() => bodyOf(page, dialogueId)).toBe(INK_TEXT);

  await reopen(page);
  await binderTitle(page, 'Untitled scene').click();
  await expect(page.getByRole('region', { name: 'Screenplay: Untitled scene' })).toContainText('The lamp turns.');

  await binderTitle(page, 'Untitled dialogue').click();
  await expect(page.getByRole('textbox', { name: 'Ink source' })).toHaveValue(INK_TEXT);
});

test('the graph follows the Ink once the writer pauses, and Add line ids asks before it writes', async ({ page }) => {
  await createProject(page, PROJECT);
  await makeUnder(page, 'Manuscript', 'New dialogue here');

  await page.getByRole('textbox', { name: 'Ink source' }).fill(INK_TEXT);
  // The graph reads the text on idle, so the knot named in the text is drawn once the writer has paused.
  await expect(page.getByRole('button', { name: /^wave:/ })).toBeVisible();

  const dialogueId = await idOf(page, 'Untitled dialogue');
  await expect.poll(() => bodyOf(page, dialogueId)).toBe(INK_TEXT);

  await page.getByRole('button', { name: /^Add line ids to \d+ lines?$/ }).click();
  await expect(page.getByRole('group', { name: 'Confirm adding line ids' })).toBeVisible();
  // Nothing is written until the writer confirms.
  expect(await bodyOf(page, dialogueId)).toBe(INK_TEXT);

  await page.getByRole('button', { name: /^Add \d+ line ids?$/ }).click();
  await expect.poll(() => bodyOf(page, dialogueId)).toMatch(/# lineId: l_[0-9A-HJKMNP-TV-Z]{10}/);
});

test('a shot is made in a storyboard as a binder.create, and its fields survive a reload', async ({ page }) => {
  await createProject(page, PROJECT);
  await makeUnder(page, 'Manuscript', 'New storyboard here');
  await makeUnder(page, 'Storyboard', 'New shot here');

  await expect(page.getByRole('region', { name: 'Storyboard: Storyboard' })).toContainText('New shot');
  const rows = await trace(page);
  expect(rows.some((row) => row.command === 'binder.create' && row.summary === 'created the shot "New shot" under "Storyboard"')).toBe(
    true,
  );

  // The fields are a shot.setMeta, saved from the editor on the card. "Saved." is the editor's own confirmation.
  await page.getByRole('article', { name: 'Shot 1: New shot' }).getByRole('button', { name: 'Edit the fields of shot 1' }).click();
  await page.getByLabel('Shot size').selectOption('MCU');
  await page.getByLabel('Duration, seconds').fill('4');
  await page.getByLabel('Lens', { exact: true }).fill('35mm');
  await page.getByRole('button', { name: 'Save shot' }).click();
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible();

  // Read back after a reload: the one spec row is the stored shape, with the lens after the four spec parts (storyboard.md §3.1).
  await reopen(page);
  await binderTitle(page, 'Storyboard').click();
  const card = page.getByRole('article', { name: 'Shot 1: New shot' });
  await expect(card.locator('.sb-spec')).toHaveCount(1);
  await expect(card.locator('.sb-spec')).toHaveText('Medium close-up (MCU) · 4 s · 35mm');
});

test('each media format compiles through the bus from the Compile dialog, and downloads', async ({ page }) => {
  await createProject(page, PROJECT);
  await makeUnder(page, 'Manuscript', 'New screenplay scene here');
  await page.getByRole('radio', { name: 'Source', exact: true }).click();
  await page.getByRole('textbox', { name: 'Fountain source' }).fill(SCENE_TEXT);

  await makeUnder(page, 'Manuscript', 'New dialogue here');
  await page.getByRole('textbox', { name: 'Ink source' }).fill(INK_TEXT);
  // The dialogue table refuses a spoken line with no id, so the writer adds them first, as the dialog says.
  await page.getByRole('button', { name: /^Add line ids to \d+ lines?$/ }).click();
  await page.getByRole('button', { name: /^Add \d+ line ids?$/ }).click();
  const dialogueId = await idOf(page, 'Untitled dialogue');
  // The compile reads the stored body, so it waits until the minted ids have reached the store.
  await expect.poll(() => bodyOf(page, dialogueId)).toMatch(/# lineId: l_/);

  await makeUnder(page, 'Manuscript', 'New storyboard here');
  await makeUnder(page, 'Storyboard', 'New shot here');
  await waitForSaved(page);

  const cases: { row: string; format: string }[] = [
    { row: 'Untitled scene', format: 'Fountain (.fountain)' },
    { row: 'Untitled scene', format: 'Final Draft (.fdx)' },
    { row: 'Untitled scene', format: 'Screenplay PDF (.pdf)' },
    { row: 'Untitled dialogue', format: 'Ink story (.ink.json)' },
    { row: 'Untitled dialogue', format: 'Dialogue table (.csv)' },
    { row: 'Storyboard', format: 'Shot list (.csv)' },
    { row: 'Untitled dialogue', format: 'Dialogue table (.xlsx)' },
    { row: 'Storyboard', format: 'Shot list (.xlsx)' },
  ];
  for (const item of cases) {
    await binderTitle(page, item.row).click();
    await page.getByRole('button', { name: 'Compile…' }).click();
    // The dialog compiles the whole manuscript unless the writer picks the selected item, so the part is picked here.
    const dialog = page.getByRole('dialog', { name: 'Export' });
    await dialog.getByRole('radio', { name: new RegExp(`^Only “${item.row}”`) }).check();
    await dialog.getByRole('radio', { name: new RegExp(`^${escapeRegExp(item.format)}`) }).check();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      dialog.getByRole('button', { name: 'Compile', exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.(fountain|fdx|pdf|json|csv|xlsx)$/);
    await page.keyboard.press('Escape');
  }

  // Every compile went through the bus as the part command, so each one is a row in the activity log.
  expect((await traceNames(page)).filter((name) => name === 'export.compileSelection')).toHaveLength(cases.length);
});
