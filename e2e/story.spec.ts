import { expect, test, type Page } from '@playwright/test';

import { card, createProject, idOf, projectTrace, trace, traceNames, waitForSaved } from './support.js';

/**
 * ui-modules §6, the shell's eval bar: a scripted story must produce the same command trace
 * an agent plan would. This one builds a chapter from nothing, adds three cards, and drags
 * the last card to the front. Every project command it causes is asserted, in order.
 */

/** Rename the row or card that is in rename mode: the field is named for the title it held. */
async function nameIt(page: Page, placeholderTitle: string, name: string): Promise<void> {
  const field = page.getByRole('textbox', { name: `Rename ${placeholderTitle}` });
  await expect(field).toBeFocused();
  await field.fill(name);
  await page.keyboard.press('Enter');
}

test('a chapter, three cards and a reorder produce the exact command trace', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => {
    // WebKit doesn't know the viewport's interactive-widget key (#364) and says so once; that notice is not a problem.
    if (/Viewport argument key "interactive-widget" not recognized/.test(message.text())) return;
    if (message.type() === 'error' || message.type() === 'warning') problems.push(message.text());
  });

  await createProject(page, 'The Lighthouse Keeper');

  // 1. A chapter, from the binder's own button. It is named at once.
  await page.getByRole('button', { name: 'New folder' }).click();
  await nameIt(page, 'Untitled', 'Act One');
  await expect(page.locator('.row-title', { hasText: /^Act One$/ })).toBeVisible();

  // 2. Three cards, from the corkboard, each named as it is created.
  const newCard = page.locator('.corkboard-head').getByRole('button', { name: 'New card' });
  await newCard.click();
  await nameIt(page, 'Untitled', 'The Landing');
  await newCard.click();
  await nameIt(page, 'Untitled', 'Second Scene');
  await newCard.click();
  await nameIt(page, 'Untitled', 'Third Scene');
  await expect(page.locator('.cards .card-title')).toHaveText(['The Landing', 'Second Scene', 'Third Scene']);

  // 3. Drag the third card to the front: onto the left edge of the first card.
  const source = card(page, 'Third Scene');
  const target = card(page, 'The Landing');
  await source.locator('.card-grip').dragTo(target, { targetPosition: { x: 4, y: 40 } });
  await expect(page.locator('.cards .card-title')).toHaveText(['Third Scene', 'The Landing', 'Second Scene']);

  // The project's own commands, in the order they ran.
  expect(await projectTrace(page)).toEqual([
    'binder.create',
    'binder.rename',
    'binder.create',
    'binder.rename',
    'binder.create',
    'binder.rename',
    'binder.create',
    'binder.rename',
    'binder.move',
  ]);

  // And the whole log, view events included, so a change in what the UI emits is caught here.
  expect(await traceNames(page)).toEqual([
    'binder.create',
    'view.setSelection',
    'view.setCorkboardScope',
    'binder.rename',
    'binder.create',
    'view.setSelection',
    'view.setActiveDoc',
    'binder.rename',
    'binder.create',
    'view.setSelection',
    'view.setActiveDoc',
    'binder.rename',
    'binder.create',
    'view.setSelection',
    'view.setActiveDoc',
    'binder.rename',
    'binder.move',
    'view.setSelection',
  ]);

  // The rows carry the titles the commands named, not the ids they acted on.
  const rows = await trace(page);
  const move = rows.find((row) => row.command === 'binder.move');
  expect(move?.summary).toBe('moved "Third Scene" to position 0 under "Act One"');
  expect(move?.affected).toEqual([{ nodeId: await idOf(page, 'Third Scene'), title: 'Third Scene' }]);
  expect(rows.filter((row) => row.command === 'binder.create').every((row) => row.issuedBy === 'user')).toBe(true);

  await waitForSaved(page);
  expect(problems).toEqual([]);
});
