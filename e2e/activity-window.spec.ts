import { expect, test } from '@playwright/test';

import { createProject, trace } from './support.js';

/**
 * The Activity panel's window (command-bus.md §8).
 *
 * The log holds a row for every command of the sitting, and the panel shows a window of them: the
 * newest rows, and the older ones one window at a time, on the button that names how many are left.
 */

test('the activity panel shows a window of a long sitting, and the button opens the rows behind it', async ({
  page,
}) => {
  await createProject(page, 'Long Sitting');

  // Two documents to move the selection between: every move is a command, and every command is a
  // row in the log, so the sitting's log grows without the writer's hands on the project.
  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('Act One');
  await page.keyboard.press('Enter');
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('Scene');
  await page.keyboard.press('Enter');

  const tree = page.getByRole('tree', { name: 'Binder' });
  await tree.getByRole('treeitem').first().click();
  for (let round = 0; round < 120; round += 1) {
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
  }

  await page.getByRole('tab', { name: 'Activity' }).click();
  // The view changes are the many rows of this sitting, and the panel leaves them out unless the
  // writer asks for them.
  await page.getByLabel('Show view changes').check();

  const rows = page.getByRole('list', { name: 'Activity' }).getByRole('listitem');
  const button = page.getByRole('button', { name: /^Show older \(\d+ more\)$/ });

  await expect(button).toBeVisible();
  const total = (await trace(page)).length;
  expect(total).toBeGreaterThan(200);

  // The window is the newest 200 rows. Every view event of this sitting is newer than the rename, so
  // the newest row that can still be undone fell out of the window — and the panel pins that row in
  // rather than hide the one command it dispatches (activity-window.ts). The panel shows the
  // window's 200 rows and the pinned one.
  await expect(rows).toHaveCount(201);
  await expect(rows.last().getByRole('button', { name: /^Undo:/ })).toBeVisible();

  // The button names the rows behind them.
  await expect(button).toHaveText(`Show older (${total - 201} more)`);

  // The button opens one more window of rows. This sitting's log is smaller than that window, so the
  // undo row is one of the window's own rows now, and nothing is pinned to it.
  expect(total).toBeLessThanOrEqual(400);
  await button.click();
  await expect(rows).toHaveCount(Math.min(total, 400));
});
