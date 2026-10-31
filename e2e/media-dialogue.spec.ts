/**
 * The dialogue container in the app (dialogue-narrative.md §2.1, §3, §4). The Ink source is drawn with its own syntax and Tab
 * completes a knot after a divert, a graph card moves the caret to its knot, a whole Ink story imports as containers in one
 * step, and the container's settings in the Inspector are commands of their own. media/README.md says what each view does.
 */

import { expect, test, type Page } from '@playwright/test';

import { binderTitle, bodyOf, createProject, firstChapter, idOf, traceNames, waitForSaved, writerText } from './support.js';

const PROJECT = 'Night Shift';

const INK = '=== start ===\nAlice: Hello.\n* [Wave] -> wave\n* [Leave] -> END\n\n=== wave ===\nAlice: Bye.\n-> END\n';

/**
 * Makes a dialogue container from the context menu of the manuscript, and leaves it with the title the binder gave it.
 */
async function makeDialogue(page: Page): Promise<void> {
  // The media entries are on chapters, so the node goes into the manuscript's first chapter.
  await binderTitle(page, await firstChapter(page)).click({ button: 'right' });
  await page.getByRole('menu', { name: 'Actions for Chapter 1' }).getByRole('menuitem', { name: 'New dialogue here' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'Dialogue: Untitled dialogue' })).toBeVisible();
}

/** The Ink source field, which the dialogue view shows under its graph. */
function inkSource(page: Page) {
  return page.getByRole('textbox', { name: 'Ink source' });
}

/** Where the caret is in the field that has focus, or `null` when no field has it. */
async function caretOf(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const doc = (globalThis as unknown as { document: { activeElement: { selectionStart?: number } | null } }).document;
    return doc.activeElement?.selectionStart ?? null;
  });
}

test('the Ink source draws its knots and diverts, and Tab completes a knot name after a divert', async ({ page }) => {
  await createProject(page, PROJECT);
  await makeDialogue(page);
  await inkSource(page).fill(`${INK}\n-> wa`);

  await expect(page.locator('.src-layer .tok-knot')).toHaveCount(2);
  await expect(page.locator('.src-layer .tok-divert').first()).toBeVisible();

  // The caret is after "-> wa", and "wave" is the knot it starts.
  await inkSource(page).press('Tab');
  await expect(inkSource(page)).toHaveValue(`${INK}\n-> wave`);
});

test('a graph card moves the caret to the header of its knot in the Ink text', async ({ page }) => {
  await createProject(page, PROJECT);
  await makeDialogue(page);
  await inkSource(page).fill(INK);
  // The graph reads the text once the writer pauses, so the card appears a moment after the fill.
  const card = page.getByRole('button', { name: /^wave:/ });
  await expect(card).toBeVisible();
  await card.click();

  await expect(inkSource(page)).toBeFocused();
  expect(await caretOf(page)).toBe(INK.indexOf('=== wave ==='));
});

test('a whole Ink story imports as one branching container per knot cluster, in one step', async ({ page }) => {
  await createProject(page, PROJECT);
  await page.locator('input[type="file"][aria-label="Ink file"]').setInputFiles({
    name: 'tavern.ink',
    mimeType: 'text/plain',
    buffer: Buffer.from(INK),
  });

  await expect(page.getByText(new RegExp(`Imported 1 dialogue container from ${writerText('tavern.ink')}\\.`))).toBeVisible();
  await waitForSaved(page);
  await expect.poll(() => traceNames(page)).toContain('dialogue.importInk');
  // The cluster takes the name of its first knot, which is what the binder shows.
  await expect(binderTitle(page, 'start')).toBeVisible();
});

test('Import Ink leaves the Ink as written unless the one-time line-id box is ticked, and the box starts unticked', async ({ page }) => {
  await createProject(page, PROJECT);
  const box = page.getByRole('checkbox', { name: 'Add line ids to the imported containers (one time)' });
  await expect(box).not.toBeChecked();
  await page.locator('input[type="file"][aria-label="Ink file"]').setInputFiles({ name: 'tavern.ink', mimeType: 'text/plain', buffer: Buffer.from(INK) });

  await expect(page.getByText(new RegExp(`Imported 1 dialogue container from ${writerText('tavern.ink')}\\.`))).toBeVisible();
  const body = (await bodyOf(page, await idOf(page, 'start'))) ?? '';
  expect(body).toContain('Alice: Hello.\n* [Wave] -> wave\n* [Leave] -> END');
  expect(body).not.toContain('lineId');
});

test('Import Ink with the line-id box ticked adds ids once, and names a line that cannot take one', async ({ page }) => {
  await createProject(page, PROJECT);
  await page.getByRole('checkbox', { name: 'Add line ids to the imported containers (one time)' }).check();
  const stuck = '=== start ===\nAlice: Hello.\n* [Yes] Oh yes. -> END\n';
  await page.locator('input[type="file"][aria-label="Ink file"]').setInputFiles({ name: 'gate.ink', mimeType: 'text/plain', buffer: Buffer.from(stuck) });

  await expect(page.getByText(/Added 2 line ids to the imported containers, once\./)).toBeVisible();
  await expect(page.getByText(/1 line \(⁨?start⁩? line 3\) could not take one: move the choice or jump so the line has room for its id\./)).toBeVisible();
  await expect(page.getByText(/"Add line ids on save" was left as it was\./)).toBeVisible();
  const body = (await bodyOf(page, await idOf(page, 'start'))) ?? '';
  expect(body.match(/# lineId: l_/g)).toHaveLength(2);
  // The setting is untouched: the import is a one-time mint, so no container setting was written.
  await waitForSaved(page);
  expect(await traceNames(page)).not.toContain('dialogue.setMeta');
});

test('the container settings in the Inspector change the engine target and the line-id opt-in, each as a command', async ({ page }) => {
  await createProject(page, PROJECT);
  await makeDialogue(page);
  await binderTitle(page, 'Untitled dialogue').click();

  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  const settings = inspector.getByTestId('dialogue-meta');
  await expect(settings).toBeVisible();

  await settings.getByRole('combobox', { name: 'Engine target' }).selectOption('yarn-csv');
  await settings.getByRole('checkbox', { name: 'Add line ids on save' }).check();
  await waitForSaved(page);
  await expect.poll(() => traceNames(page)).toContain('dialogue.setMeta');
  // Two changes, two rows: the engine target and the opt-in are separate commands, each undoable on its own.
  await expect.poll(async () => (await traceNames(page)).filter((name) => name === 'dialogue.setMeta').length).toBe(2);
});
