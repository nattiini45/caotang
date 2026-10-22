/**
 * The controls of the media views (storyboard.md §3.1–3.2, screenplay.md §3, ui-modules §0.4): the card sizes of the shot board,
 * the arrow keys and the names of the mode switches, the words the shot editor shows for camera values, and the lightbox's
 * focus, which stays inside it and returns to the picture that opened it. The tests use the keyboard and the names a screen reader
 * hears, as a writer on a keyboard would.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

import { binderRow, binderTitle, createProject, firstChapter } from './support.js';

const PROJECT = 'Board Controls';
/** A 1×1 PNG, the smallest picture the store will take. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

/** Makes a node from the context menu of the row it goes under, and keeps its default title (ui-modules §2.2). */
async function makeUnder(page: Page, under: string, item: string): Promise<void> {
  // The media entries are on chapters, so "under the manuscript" is its first chapter, made when there is none.
  const parent = under === 'Manuscript' ? await firstChapter(page) : under;
  await binderTitle(page, parent).click({ button: 'right' });
  await page.getByRole('menu', { name: `Actions for ${parent}` }).getByRole('menuitem', { name: item }).click();
  await page.keyboard.press('Escape');
}

/** A storyboard with one shot, whose fields are open in the editor. */
async function storyboardWithShot(page: Page): Promise<Locator> {
  await createProject(page, PROJECT);
  await makeUnder(page, 'Manuscript', 'New storyboard here');
  await makeUnder(page, 'Storyboard', 'New shot here');
  await page.getByRole('article', { name: 'Shot 1: New shot' }).getByRole('button', { name: 'Edit the fields of shot 1' }).click();
  return page.getByRole('article', { name: 'Shot 1: New shot' });
}

test('the card sizes show what storyboard.md 3.1 names: S the number and picture, M adds the title, one spec row and the coverage, L adds the action, status and label', async ({
  page,
}) => {
  const card = await storyboardWithShot(page);
  await page.getByLabel('Shot size').selectOption('MCU');
  await page.getByLabel('Camera angle').selectOption('birds');
  await page.getByLabel('Camera movement').selectOption('dolly-in');
  await page.getByLabel('Duration, seconds').fill('4');
  await page.getByLabel('Lens').fill('35mm');
  await page.getByLabel('Transition out').selectOption('dissolve');
  await page.getByLabel('Action', { exact: true }).fill('She turns toward the door.');
  // The editor's dropdowns word the stored values; the card's row says the same words, not the tokens.
  const shown = async (label: string): Promise<string> => (await page.getByLabel(label).locator('option:checked').textContent()) ?? '';
  const words = [await shown('Shot size'), await shown('Camera angle'), await shown('Camera movement')];
  const transition = await shown('Transition out');
  expect(words).toEqual(['Medium close-up (MCU)', 'Bird’s-eye view', 'Dolly in']);
  await page.getByRole('button', { name: 'Save shot' }).click();
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible();

  // Medium is the default: the title, one spec row (the four spec parts, then the lens and the transition) and the coverage line.
  // The action waits for Large.
  const board = page.locator('ol.sb-cards');
  await expect(board).toHaveClass(/zoom-M/);
  await expect(card.locator('.card-title')).toBeVisible();
  await expect(card.locator('.sb-spec')).toHaveCount(1);
  await expect(card.locator('.sb-spec')).toHaveText(`${words.join(' · ')} · 4 s · 35mm · ${transition}`);
  await expect(card.locator('.sb-spec')).toHaveText('Medium close-up (MCU) · Bird’s-eye view · Dolly in · 4 s · 35mm · Dissolve');
  await expect(card.getByText('0 lines covered', { exact: true })).toBeVisible();
  await expect(card.locator('.sb-action')).toHaveCount(0);
  await expect(card.locator('.chip-status')).toHaveCount(0);

  // Small keeps the number and the picture only: no title, no spec row, no coverage line.
  await page.getByRole('radio', { name: /^S: Small cards/ }).click();
  await expect(board).toHaveClass(/zoom-S/);
  await expect(card.locator('.card-title')).toHaveCount(0);
  await expect(card.locator('.sb-spec')).toHaveCount(0);
  await expect(card.getByText('lines covered')).toHaveCount(0);
  await expect(card.locator('.sb-number')).toHaveText('1');

  // Large adds the action, and the status and the label the vocabulary holds for the shot. The shot's status and label are set the way
  // a writer sets them on any node: the status from the binder row, and the label from the Inspector, which holds the shot once the
  // binder selects it (a row shows a label only once it has one).
  // The storyboard sits in a chapter, so its row is opened to show the shot.
  await page.getByRole('button', { name: 'Expand Storyboard' }).click();
  // The new shot's title opens in rename mode once its row shows; Escape keeps the title it has.
  const rename = page.getByRole('textbox', { name: 'Rename New shot' });
  if ((await rename.count()) > 0) {
    await rename.focus();
    await page.keyboard.press('Escape');
  }
  await binderRow(page, 'New shot').getByRole('button', { name: /^Status of New shot/ }).click();
  await page.getByRole('menuitemradio', { name: 'Revised' }).click();
  await binderTitle(page, 'New shot').click();
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await inspector.getByRole('button', { name: /^Label: No label/ }).click();
  await page.getByRole('menuitem', { name: '+ Add label…' }).click();
  const vocabulary = page.getByRole('dialog', { name: 'Statuses and labels' });
  await vocabulary.getByRole('button', { name: 'Labels', exact: true }).click();
  await vocabulary.getByRole('textbox', { name: 'New label' }).fill('Main unit');
  await vocabulary.getByRole('button', { name: 'Add label' }).click();
  await expect(vocabulary.getByRole('textbox', { name: 'Name of Main unit' })).toBeVisible();
  await vocabulary.getByRole('button', { name: 'Done' }).click();
  await inspector.getByRole('button', { name: /^Label: No label/ }).click();
  await page.getByRole('menuitemradio', { name: 'Main unit' }).click();

  await page.getByRole('radio', { name: /^L: Large cards/ }).click();
  await expect(board).toHaveClass(/zoom-L/);
  await expect(card.locator('.sb-action')).toHaveText('She turns toward the door.');
  await expect(card.locator('.chip-status')).toHaveText('Revised');
  await expect(card.locator('.card-labels .chip-label')).toHaveText('Main unit');
});

test('at S the footer is hidden from sight, and a key that reaches Fields brings it into view', async ({ page }) => {
  const card = await storyboardWithShot(page);
  await page.getByRole('radio', { name: /^S: Small cards/ }).click();
  const footer = card.locator('.sb-foot');
  await expect(footer).toHaveClass(/is-visually-hidden/);
  await expect.poll(async () => (await footer.boundingBox())?.width ?? 0).toBeLessThanOrEqual(1);

  // Earlier and Later are disabled for the only shot, so Tab from the card reaches Fields, and the footer is drawn for it.
  const fields = card.getByRole('button', { name: 'Edit the fields of shot 1' });
  await card.focus();
  await page.keyboard.press('Tab');
  await expect(fields).toBeFocused();
  await expect.poll(async () => (await footer.boundingBox())?.width ?? 0).toBeGreaterThan(1);
});

test('the Board and Prompt pack switch take the arrow keys, and their names are their visible words', async ({ page }) => {
  await storyboardWithShot(page);
  const board = page.getByRole('radio', { name: 'Board', exact: true });
  const pack = page.getByRole('radio', { name: 'Prompt pack', exact: true });
  await board.focus();
  await expect(board).toHaveAttribute('aria-checked', 'true');
  await expect(pack).toHaveAttribute('tabindex', '-1');

  await page.keyboard.press('ArrowRight');
  await expect(pack).toHaveAttribute('aria-checked', 'true');
  await expect(pack).toBeFocused();
  await expect(page.getByRole('list', { name: /^Shots in/ })).toHaveCount(0);

  await page.keyboard.press('ArrowLeft');
  await expect(board).toHaveAttribute('aria-checked', 'true');
  await expect(board).toBeFocused();
});

test('the Script, Source and Pages switch of a screenplay scene takes the arrow keys, Home and End', async ({ page }) => {
  await createProject(page, PROJECT);
  await makeUnder(page, 'Manuscript', 'New screenplay scene here');
  const script = page.getByRole('radio', { name: 'Script', exact: true });
  const source = page.getByRole('radio', { name: 'Source', exact: true });
  const pages = page.getByRole('radio', { name: 'Pages', exact: true });
  await script.focus();

  await page.keyboard.press('ArrowRight');
  await expect(source).toHaveAttribute('aria-checked', 'true');
  await expect(source).toBeFocused();
  await page.keyboard.press('End');
  await expect(pages).toHaveAttribute('aria-checked', 'true');
  await expect(pages).toBeFocused();
  await page.keyboard.press('Home');
  await expect(script).toHaveAttribute('aria-checked', 'true');
  await expect(script).toBeFocused();
});

test('the shot editor names camera values in words, and keeps the stored value', async ({ page }) => {
  await storyboardWithShot(page);
  const angle = page.getByLabel('Camera angle');
  await expect(angle.locator('option', { hasText: 'Bird’s-eye view' })).toHaveCount(1);
  await expect(angle.locator('option', { hasText: 'birds' })).toHaveCount(0);
  await expect(page.getByLabel('Camera movement').locator('option', { hasText: 'Dolly in' })).toHaveCount(1);
  await expect(page.getByLabel('Transition out').locator('option', { hasText: 'Match on action' })).toHaveCount(1);

  // The option's value is still the stored enum value, so choosing it writes the same shot the list holds.
  await angle.selectOption('birds');
  await expect(angle).toHaveValue('birds');
});

test('the lightbox keeps Tab inside itself, and Escape gives focus back to the picture that opened it', async ({ page }) => {
  const card = await storyboardWithShot(page);
  await page.getByLabel('Choose an image file for shot 1').setInputFiles({ name: 'frame.png', mimeType: 'image/png', buffer: PNG });
  await expect(card.locator('img')).toBeVisible();

  const opener = card.getByRole('button', { name: 'Look at the image of shot 1 larger' });
  await opener.click();
  const lightbox = page.getByRole('dialog', { name: 'Image of New shot' });
  await expect(lightbox).toBeVisible();
  const close = lightbox.getByRole('button', { name: 'Close' });
  await expect(close).toBeFocused();

  // The Close button is the only thing a Tab can reach in the lightbox, so Tab and Shift+Tab leave the focus on it.
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(close).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(lightbox).toHaveCount(0);
  await expect(opener).toBeFocused();
});
