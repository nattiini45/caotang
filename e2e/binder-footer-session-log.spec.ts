import { expect, test, type Page } from '@playwright/test';

import { binderRow, createProject } from './support.js';

/**
 * The binder footer's weekly and monthly goals count the words of the sessions that ended in their
 * window (goals-progress §9.3), and those lines are read from every project's log. The log only
 * moves when a sitting is recorded, so the reading waits for its window instead of following every
 * keystroke.
 */

/** Counts the reads of the session log in the page. */
async function countSessionReads(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = IDBIndex.prototype.getAll;
    const counter = window as unknown as { sessionReads: number };
    counter.sessionReads = 0;
    IDBIndex.prototype.getAll = function patched(this: IDBIndex, ...args: Parameters<IDBIndex['getAll']>) {
      // In a browser `objectStore` is the index's store itself (an IDBObjectStore property), so its name is the store's.
      if (this.objectStore.name === 'sessions') counter.sessionReads += 1;
      return original.apply(this, args);
    };
  });
}

/** How many times the session log has been read since the count was last set to zero. */
async function sessionReads(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { sessionReads: number }).sessionReads);
}

test('the footer does not read every project’s session log on every keystroke', async ({ page }) => {
  await countSessionReads(page);
  await createProject(page, 'Session Log Reads');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('The Lamp');
  await page.keyboard.press('Enter');

  // A weekly goal is what makes the footer read the sessions log at all.
  await binderRow(page, 'Manuscript').click();
  const goals = page.getByTestId('inspector-goals');
  await goals.getByRole('combobox', { name: 'Inspector goal kind' }).selectOption('weekly');
  await goals.getByLabel('Inspector goal words').fill('500');
  await goals.getByRole('button', { name: 'Add goal' }).click();
  await expect(goals.locator('.goal-sentence')).toContainText('at least 500 words this week');

  // The goal made the footer read the log, so the counter is known to move: a count that never counted would fail
  // here instead of hiding behind the bound below.
  await expect.poll(() => sessionReads(page)).toBeGreaterThan(0);

  // The scene is written in, and the writes are counted from here on.
  await binderRow(page, 'The Lamp').click();
  await page.evaluate(() => {
    (window as unknown as { sessionReads: number }).sessionReads = 0;
  });
  const surface = page.getByRole('textbox', { name: 'Document text' });
  await surface.click();
  await page.keyboard.type('The lamp was lit.');

  // The keystrokes are no reason to read every project's log: the reading waits for its window, so a burst of the 17
  // of them costs one reading and not one each. The count is the page's, so it also carries the readings of the
  // today's-words poll and of the sitting's own append — a couple, against the 17 a reading per keystroke would be.
  const duringBurst = await sessionReads(page);
  expect(duringBurst).toBeLessThanOrEqual(3);

  // And the reading is not silent: once its window has waited out, the burst does get its one reading.
  await expect.poll(() => sessionReads(page), { timeout: 5_000 }).toBeGreaterThan(duringBurst);
});
