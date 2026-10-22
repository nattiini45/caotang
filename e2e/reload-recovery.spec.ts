import { expect, test, type Page } from '@playwright/test';

import { binderTitle, bodyOf, createProject, idOf, projectIdOf, waitForSaved } from './support.js';

/**
 * Typing is not lost to a reload (pending-journal.ts, editor-engine §9). The words typed in the last moment are kept in the browser's
 * storage synchronously when the page goes away, and put back, or offered, when the project opens again.
 */

/** The store's document writes can be refused from the test, the way a full disk refuses them (the stale-copy spec uses the same seam). */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const refusals: Record<string, boolean> = { store: false };
    (globalThis as unknown as { __caotangRefuse: Record<string, boolean> }).__caotangRefuse = refusals;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>): IDBRequest<IDBValidKey> {
      const request = put.apply(this, args);
      if (refusals['store']) this.transaction.abort();
      return request;
    };
  });
});

async function refuseStore(page: Page, on: boolean): Promise<void> {
  await page.evaluate((value) => {
    (globalThis as unknown as { __caotangRefuse: Record<string, boolean> }).__caotangRefuse['store'] = value;
  }, on);
}

async function chapterWithScene(page: Page, scene: string): Promise<void> {
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill(scene);
  await page.keyboard.press('Enter');
}

async function reopen(page: Page, name: string, scene: string): Promise<void> {
  const row = page.getByRole('listitem').filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole('button', { name: 'Open' }).click();
  await binderTitle(page, scene).click();
}

test('text typed and then reloaded within a moment is there after the reload', async ({ page }) => {
  await createProject(page, 'Quick Reload');
  await chapterWithScene(page, 'Opening');
  await waitForSaved(page);
  const surface = page.getByRole('textbox', { name: 'Document text' });
  await surface.click();

  await page.keyboard.type('The last words before the tab went.');
  await page.reload();

  await reopen(page, 'Quick Reload', 'Opening');
  await expect(surface).toContainText('The last words before the tab went.');
});

test('text the store never got is kept in the browser at the reload, saved when the project opens, and said', async ({ page }) => {
  await createProject(page, 'Journal Book');
  await chapterWithScene(page, 'Opening');
  await page.getByRole('textbox', { name: 'Document text' }).fill('Saved before the trouble.');
  await waitForSaved(page);
  const projectId = await projectIdOf(page);

  // From here every store write fails, so the typing below can reach only the browser's storage.
  await refuseStore(page, true);
  await page.getByRole('textbox', { name: 'Document text' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed with the store refusing.');
  await page.reload();

  // The store holds the older text, and the journal holds the newer.
  await page.evaluate((id) => {
    const raw = localStorage.getItem(`caotang.pending.${id}`);
    if (raw === null) throw new Error('no pending journal');
  }, projectId);

  await reopen(page, 'Journal Book', 'Opening');
  await expect(page.getByRole('textbox', { name: 'Document text' })).toContainText('Saved before the trouble. Typed with the store refusing.');
  await expect(page.locator('.status-line')).toContainText('Caotang kept 1 unsaved change from before the reload and saved it.');
  await waitForSaved(page);
  expect(await page.evaluate((id) => localStorage.getItem(`caotang.pending.${id}`), projectId)).toBeNull();
  expect(await bodyOf(page, await idOf(page, 'Opening'))).toContain('Typed with the store refusing.');
});

test('text the store has moved past is offered back as a new document, and not written over the newer text', async ({ page }) => {
  await createProject(page, 'Moved Past');
  await chapterWithScene(page, 'Opening');
  await page.getByRole('textbox', { name: 'Document text' }).fill('The newer text another tab saved.');
  await waitForSaved(page);
  const projectId = await projectIdOf(page);
  const scene = await idOf(page, 'Opening');

  // A journal whose words were typed against a revision the store has since left behind.
  await page.evaluate(
    ([id, docId]) => {
      localStorage.setItem(
        `caotang.pending.${id}`,
        JSON.stringify([{ docId, body: 'Words typed against an older save.', baseRevision: 0, at: new Date().toISOString() }]),
      );
    },
    [projectId, scene] as const,
  );
  await page.reload();
  await reopen(page, 'Moved Past', 'Opening');

  await expect(page.getByRole('textbox', { name: 'Document text' })).toContainText('The newer text another tab saved.');
  const offer = page.getByTestId('unsent-words');
  await expect(offer).toContainText('Kept from before a reload');
  await offer.getByRole('button', { name: 'Put them back as new documents' }).click();
  await expect(binderTitle(page, 'Opening (kept from before a reload)')).toBeVisible();
  expect(await bodyOf(page, scene)).toBe('The newer text another tab saved.\n');
  expect(await bodyOf(page, await idOf(page, 'Opening (kept from before a reload)'))).toContain('Words typed against an older save.');
});
