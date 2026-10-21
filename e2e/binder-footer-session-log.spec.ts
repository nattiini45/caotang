import { expect, test, type Page } from '@playwright/test';

import { binderRow, createProject } from './support.js';

/**
 * The binder footer's weekly and monthly goals count the words of the sessions that ended in their
 * window (goals-progress §9.3), and those lines are read from every project's log. The log only
 * moves when a sitting is recorded, so the reading waits for its window instead of following every
 * keystroke.
 */

/**
 * Counts the reads of the session log in the page.
 *
 * The status line reads the log every three seconds to count today's words (Workspace.tsx), and it reads
 * it through the same path the footer's reading uses — so a count that carried it would be moved by the
 * page's own poll whether the footer read or not, and a liveness check on it would prove nothing. That
 * poll is silenced here, and the count is the footer's reading alone.
 */
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
    // The status line's poll of today's words is the page's own reading of the log. Nothing else runs on a
    // three-second interval, so this one is the page's and only the page's.
    const timers = window.setInterval.bind(window);
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]): number => {
      if (timeout === 3_000) return 0;
      return timers(handler as () => void, timeout, ...args);
    }) as typeof window.setInterval;
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

  // The counter moves: the page reads the log when it opens, and the footer's goal makes it read the log
  // again. A count that never counted would fail here instead of hiding behind the bound below.
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
  // of them costs one reading and not one each. The count is the footer's alone — the page's own poll is silenced
  // above — so a reading per keystroke would be 17.
  const duringBurst = await sessionReads(page);
  expect(duringBurst).toBeLessThanOrEqual(3);

  // And the reading is not silent: once its window has waited out, the burst does get its one reading. The count is
  // the footer's alone, so this is the footer's reading and not the page's own poll — which is what a footer that
  // never read would fail.
  await expect.poll(() => sessionReads(page), { timeout: 5_000 }).toBeGreaterThan(duringBurst);
});
