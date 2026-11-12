import { expect, test, type Page } from '@playwright/test';

import { binderTitle, card, countOf, createProject, freezeClock, projectTrace, trace } from './support.js';

/**
 * ui-modules §3: the corkboard shows a container's children as cards, and every gesture on
 * it is a binder command. These tests pin the card sizes, the 800 ms synopsis debounce, the
 * 2,000-character cap, and the empty state.
 */

/** A chapter opened on the corkboard, with no cards yet. */
async function emptyChapter(page: Page): Promise<void> {
  await createProject(page, 'Board Book');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await expect(page.getByRole('heading', { name: 'No cards yet' })).toBeVisible();
}

/** Add one card to the open corkboard and name it. */
async function addCard(page: Page, title: string): Promise<void> {
  await page.locator('.corkboard-head').getByRole('button', { name: 'New card' }).click();
  const field = page.getByRole('textbox', { name: 'Rename Untitled' });
  await field.fill(title);
  await page.keyboard.press('Enter');
  await expect(card(page, title)).toBeVisible();
}

/**
 * The card's text as a reader sees it: what the browser renders, so a hidden element is absent. The drag
 * grip is a handle, not text, so its glyph is left out.
 */
async function visibleCardText(page: Page, title: string): Promise<string> {
  const text = await card(page, title).evaluate((element) => (element as HTMLElement).innerText);
  return text.replace(/⋮/g, '').replace(/\s+/g, ' ').trim();
}

test('an empty container says what to do, and New card adds a card at the end', async ({ page }) => {
  await emptyChapter(page);
  await expect(page.getByText('Drag scenes in from the binder, or create one.')).toBeVisible();

  await addCard(page, 'Opening');
  await addCard(page, 'Closing');

  await expect(page.locator('.cards .card-title')).toHaveText(['Opening', 'Closing']);
  expect((await trace(page)).filter((row) => row.command === 'binder.create')).toHaveLength(3);
});

test('a right-click on the empty board offers New card, which is named as it is made', async ({ page }) => {
  await emptyChapter(page);

  const point = await page.locator('.corkboard').evaluate((board) => {
    const box = board.getBoundingClientRect();
    for (let y = Math.max(box.top, 0) + 4; y < Math.min(box.bottom, innerHeight); y += 8) {
      for (let x = Math.max(box.left, 0) + 4; x < Math.min(box.right, innerWidth); x += 8) {
        if (document.elementFromPoint(x, y) === board) return { x, y };
      }
    }
    return null;
  });
  if (point === null) throw new Error('the empty corkboard has no visible, unobscured surface point');
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: 'New card' }).click();

  const field = page.getByRole('textbox', { name: 'Rename Untitled' });
  await expect(field).toBeFocused();
  await field.fill('From the menu');
  await page.keyboard.press('Enter');
  await expect(card(page, 'From the menu')).toBeVisible();
});

test('the three card sizes change what a card shows, and changing size writes no command', async ({ page }) => {
  await emptyChapter(page);
  await addCard(page, 'Sized');
  // Large cards show the keyword row, so the card needs a keyword. The card is selected, so the inspector holds it.
  await page.getByLabel('Add keyword').fill('sea');
  await page.getByLabel('Add keyword').press('Enter');
  const cards = page.locator('.cards');
  expect(await projectTrace(page)).toEqual(['binder.create', 'binder.create', 'binder.rename', 'binder.setMeta']);

  await page.getByRole('radio', { name: /^S: Small cards/ }).click();
  await expect(cards).toHaveClass(/zoom-S/);
  // Small cards are title only: the card's visible text is the title and nothing else.
  await expect.poll(() => visibleCardText(page, 'Sized')).toBe('Sized');
  await expect(card(page, 'Sized').getByRole('textbox', { name: 'Synopsis' })).toHaveCount(0);

  await page.getByRole('radio', { name: /^M: Medium cards/ }).click();
  await expect(card(page, 'Sized').getByRole('textbox', { name: 'Synopsis' })).toBeVisible();
  await expect(card(page, 'Sized').locator('.card-labels')).toHaveCount(0);

  await page.getByRole('radio', { name: /^L: Large cards/ }).click();
  await expect(cards).toHaveClass(/zoom-L/);
  await expect(page.getByRole('radio', { name: /^L: Large cards/ })).toHaveAttribute('aria-checked', 'true');
  // Large cards add the keyword row to the title and the synopsis.
  await expect(card(page, 'Sized').locator('.card-labels .chip-keyword')).toHaveText(['sea']);
  await expect(card(page, 'Sized').getByRole('textbox', { name: 'Synopsis' })).toBeVisible();
  // Zoom is view state: the three changes wrote no command, so the trace is the same as before them.
  expect(await projectTrace(page)).toEqual(['binder.create', 'binder.create', 'binder.rename', 'binder.setMeta']);
});

test('a synopsis is committed 800 ms after the last keystroke, not before', async ({ page }) => {
  // The clock is installed before the page loads, so the app's timers run normally until the freeze.
  // From there the test runs time forward itself, and the debounce is measured to the millisecond.
  await page.clock.install();
  await emptyChapter(page);
  await addCard(page, 'Debounced');
  const synopsis = card(page, 'Debounced').getByRole('textbox', { name: 'Synopsis' });
  await freezeClock(page);

  await synopsis.click();
  await synopsis.pressSequentially('Elena', { delay: 20 });
  await expect(synopsis).toHaveValue('Elena');

  await page.clock.runFor(799);
  expect(await countOf(page, 'binder.setSynopsis')).toBe(0);
  await page.clock.runFor(1);
  expect(await countOf(page, 'binder.setSynopsis')).toBe(1);

  // Time running on after the commit writes nothing more: one pause, one command.
  await page.clock.runFor(5_000);
  expect(await countOf(page, 'binder.setSynopsis')).toBe(1);
  const write = (await trace(page)).find((row) => row.command === 'binder.setSynopsis');
  expect(write?.affected.map((node) => node.title)).toEqual(['Debounced']);
});

test('the synopsis is capped at 2,000 characters, with a live counter', async ({ page }) => {
  await emptyChapter(page);
  await addCard(page, 'Capped');
  const synopsis = card(page, 'Capped').getByRole('textbox', { name: 'Synopsis' });

  await expect(synopsis).toHaveAttribute('maxlength', '2000');
  await synopsis.fill('x'.repeat(2000));
  await expect(card(page, 'Capped').getByText('2,000 / 2,000')).toBeVisible();
  // The browser stops the 2,001st character; the field never holds more than the cap.
  await synopsis.press('x');
  await expect(synopsis).toHaveValue('x'.repeat(2000));
});

test('a card dropped on the open space after the last card goes to the end', async ({ page }) => {
  await emptyChapter(page);
  await addCard(page, 'First');
  await addCard(page, 'Second');

  // Two cards fit on the first row, so a point below them is the board's own empty space.
  await card(page, 'First').locator('.card-grip').dragTo(page.locator('.cards'), {
    targetPosition: { x: 10, y: 150 },
  });

  await expect(page.locator('.cards .card-title')).toHaveText(['Second', 'First']);
});

test('the corkboard shows the container selected in the binder, and the manuscript by default', async ({ page }) => {
  await emptyChapter(page);
  await addCard(page, 'In chapter one');

  // The manuscript's own children: the chapter, as a card with its item count.
  await page.locator('.row.is-section', { hasText: 'Manuscript' }).click();
  await expect(page.locator('.corkboard-head .crumbs li')).toHaveText(['Manuscript']);
  await expect(card(page, 'Chapter 1')).toBeVisible();
  await expect(card(page, 'In chapter one')).toHaveCount(0);

  // Selecting the chapter scopes the board to its cards.
  await binderTitle(page, 'Chapter 1').click();
  await expect(page.locator('.corkboard-head .crumbs li')).toHaveText(['Manuscript', 'Chapter 1']);
  await expect(card(page, 'In chapter one')).toBeVisible();
  await expect(card(page, 'Chapter 1')).toHaveCount(0);
});
