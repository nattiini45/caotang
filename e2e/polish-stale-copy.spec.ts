import { expect, test, type Page } from '@playwright/test';

import { binderTitle, bodyOf, createProject, idOf, projectIdOf, treeOf, waitForSaved, writerText } from './support.js';

/**
 * A stopped tab keeps its words in this browser (unsent-copy.ts, persistence.ts), and the project offers them back once it opens
 * again (UnsentWords.tsx). The offer adds the words as new documents, so nothing another tab saved is overwritten, or it discards
 * the copy. The stopped tab's own notice says the words are kept.
 */

/**
 * The seam that makes a write fail where a test needs it to: the store's document writes (`store`) and the copy in the browser's
 * storage (`copy`). Each flag is off until a test turns it on, and an off flag passes every call through unchanged.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const refusals: Record<string, boolean> = { store: false, copy: false };
    (globalThis as unknown as { __caotangRefuse: Record<string, boolean> }).__caotangRefuse = refusals;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>): IDBRequest<IDBValidKey> {
      const request = put.apply(this, args);
      // A refused write fails the way a full disk does: its request errors and its transaction aborts, so the store sees a failure.
      if (refusals['store']) this.transaction.abort();
      return request;
    };
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, key: string, value: string): void {
      if (refusals['copy'] && key.startsWith('caotang.unsent.')) throw new DOMException('the test refuses the copy write', 'QuotaExceededError');
      setItem.call(this, key, value);
    };
  });
});

/** Turns one refusal on or off in the page (see the seam above). */
async function refuse(page: Page, kind: 'store' | 'copy', on: boolean): Promise<void> {
  await page.evaluate(
    ([name, value]) => {
      (globalThis as unknown as { __caotangRefuse: Record<string, boolean> }).__caotangRefuse[name] = value;
    },
    [kind, on] as const,
  );
}

/**
 * Opens a project from the projects screen once its row is on the list. The list loads after the heading shows, and under a loaded
 * full-suite run that gap is longer than a fixed wait, so the row is waited for by what it shows, not by time.
 */
async function openFromProjects(page: Page, name: string): Promise<void> {
  const row = page.getByRole('listitem').filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole('button', { name: 'Open', exact: true }).click();
}

/** A page of the same browser context: it shares the browser's storage with the first, as a second tab does. */
async function secondTab(page: Page): Promise<Page> {
  const other = await page.context().newPage();
  await other.goto('/');
  return other;
}

/** The copy this browser holds for a project, read from the browser's storage, or `null` when it holds none. */
async function keptCopy(page: Page, projectId: string): Promise<string | null> {
  return page.evaluate((pid) => {
    const storage = (globalThis as unknown as { localStorage: { getItem(key: string): string | null } }).localStorage;
    return storage.getItem(`caotang.unsent.${pid}`);
  }, projectId);
}

/** A chapter with one scene that holds saved text, in a new project. */
async function projectWithScene(page: Page, name: string, text: string): Promise<void> {
  await createProject(page, name);
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('The Landing');
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Document text' }).fill(text);
  await waitForSaved(page);
}

/** Another writer stores newer text for the scene at the revision the stopped tab holds, as a second writer's own write would. */
async function storeNewerText(other: Page, projectId: string | null, sceneId: string): Promise<void> {
  await other.evaluate(
    async ([pid, docId]) => {
      const idb = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = idb.open('caotang');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const tx = db.transaction('documents', 'readwrite');
      const documents = tx.objectStore('documents');
      const row = await new Promise<{ projectId: string; id: string; body: string; revision: number }>((resolve, reject) => {
        const request = documents.get([pid, docId]);
        request.onsuccess = () => resolve(request.result as { projectId: string; id: string; body: string; revision: number });
        request.onerror = () => reject(request.error);
      });
      documents.put({ ...row, body: 'Written in another tab.\n', revision: row.revision + 1 });
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      db.close();
    },
    [projectId ?? '', sceneId] as const,
  );
}

/**
 * Makes the stopped tab: another writer stores newer text, and this tab types on until its save is refused. Returns the project id
 * and the scene id, with the stopped tab's notice on screen.
 */
async function stopTab(page: Page, name: string): Promise<{ projectId: string; sceneId: string }> {
  await projectWithScene(page, name, 'Saved here first.');
  const projectId = await projectIdOf(page);
  const sceneId = await idOf(page, 'The Landing');
  const other = await secondTab(page);
  await storeNewerText(other, projectId, sceneId);
  await page.getByRole('textbox', { name: 'Document text' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' More from here.');
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'conflict');
  await expect(page.getByTestId('stale-tab-notice')).toHaveAttribute('data-kept', 'browser');
  return { projectId: projectId ?? '', sceneId };
}

test('a stopped tab keeps its words in this browser, and the reopened project puts them back as a new document', async ({ page }) => {
  const { projectId } = await stopTab(page, 'Kept Words');

  // The words are in the browser's storage under the project, not only on screen.
  const kept = await keptCopy(page, projectId);
  expect(kept).toContain('More from here.');

  // The reload is asked for twice, and the second answer goes back to the projects screen.
  const notice = page.getByRole('dialog', { name: 'This project is open in another tab' });
  await notice.getByRole('button', { name: 'Reload this tab' }).click();
  await expect(notice).toContainText('Reloading this tab keeps the words in this browser');
  page.once('dialog', (dialog) => void dialog.accept());
  await notice.getByRole('button', { name: 'Reload and keep the words here' }).click();
  await expect(page.getByRole('heading', { name: 'Projects in this browser' })).toBeVisible();

  // Opening the project offers the words back, and putting them back adds them as a new document.
  await openFromProjects(page, 'Kept Words');
  const offer = page.getByTestId('unsent-words');
  await expect(offer).toContainText('Kept from a stopped tab', { timeout: 20_000 });
  await offer.getByRole('button', { name: 'Put them back as new documents' }).click();

  await expect(binderTitle(page, 'The Landing (kept from a stopped tab)')).toBeVisible();
  await expect(page.getByTestId('unsent-words')).toHaveCount(0);
  expect(await keptCopy(page, projectId)).toBeNull();
  // The document goes back into the chapter it was in, and no other chapter is made.
  const tree = await treeOf(page);
  const chapter = tree.find((node) => node.title === 'Chapter 1');
  expect(tree.find((node) => node.title === 'The Landing (kept from a stopped tab)')?.parentId).toBe(chapter?.id);
  expect(tree.some((node) => node.title === 'Kept from a stopped tab')).toBe(false);

  // The scene the other tab saved is untouched, and the restored document holds the stopped tab's text.
  await binderTitle(page, 'The Landing').click();
  await expect(page.getByRole('textbox', { name: 'Document text' })).toContainText('Written in another tab.');
  await binderTitle(page, 'The Landing (kept from a stopped tab)').click();
  await expect(page.getByRole('textbox', { name: 'Document text' })).toContainText('More from here.');
});

test('kept words whose chapter is gone, or that an older build kept with no chapter, go into one new chapter at the end', async ({ page }) => {
  await projectWithScene(page, 'Chapter Gone', 'Saved here.');
  const projectId = (await projectIdOf(page)) ?? '';
  // Two kept documents: one whose chapter no longer exists, and one an older build kept, which recorded no chapter.
  await page.evaluate((pid) => {
    const entry = {
      stopId: 'stop-older',
      savedAt: '2026-10-01T09:00:00.000Z',
      documents: [
        { docId: 'n_KEPT000001', title: 'Lost Scene', body: 'Words from a chapter that is gone.', parentId: 'n_GONE000001' },
        { docId: 'n_KEPT000002', title: 'Old Scene', body: 'Words an older build kept.' },
      ],
    };
    globalThis.localStorage.setItem(`caotang.unsent.${pid}`, JSON.stringify([entry]));
  }, projectId);
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await openFromProjects(page, 'Chapter Gone');
  const offer = page.getByTestId('unsent-words');
  await expect(offer).toContainText('Kept from a stopped tab', { timeout: 20_000 });
  await offer.getByRole('button', { name: 'Put them back as new documents' }).click();
  await expect(page.getByTestId('unsent-words')).toHaveCount(0);

  const tree = await treeOf(page);
  const kept = tree.filter((node) => node.title === 'Kept from a stopped tab');
  expect(kept).toHaveLength(1);
  expect(kept[0]).toMatchObject({ parentId: 'manuscript', type: 'folder' });
  // At the end of the manuscript, after Chapter 1.
  expect(tree.filter((node) => node.parentId === 'manuscript').map((node) => node.title)).toEqual(['Chapter 1', 'Kept from a stopped tab']);
  for (const title of ['Lost Scene (kept from a stopped tab)', 'Old Scene (kept from a stopped tab)']) {
    expect(tree.find((node) => node.title === title)?.parentId).toBe(kept[0]?.id);
  }
});

test('the kept words can be discarded, and the offer goes with them', async ({ page }) => {
  const { projectId } = await stopTab(page, 'Discarded Words');

  const notice = page.getByRole('dialog', { name: 'This project is open in another tab' });
  await notice.getByRole('button', { name: 'Reload this tab' }).click();
  page.once('dialog', (dialog) => void dialog.accept());
  await notice.getByRole('button', { name: 'Reload and keep the words here' }).click();
  await expect(page.getByRole('heading', { name: 'Projects in this browser' })).toBeVisible();

  await openFromProjects(page, 'Discarded Words');
  const offer = page.getByTestId('unsent-words');
  await expect(offer).toBeVisible({ timeout: 20_000 });
  await offer.getByRole('button', { name: 'Discard them' }).click();
  await expect(page.getByTestId('unsent-words')).toHaveCount(0);
  expect(await keptCopy(page, projectId)).toBeNull();

  // Nothing was added to the project: the scene holds the other tab's text, and no restored document exists.
  await expect(binderTitle(page, 'The Landing (kept from a stopped tab)')).toHaveCount(0);
  await binderTitle(page, 'The Landing').click();
  await expect(page.getByRole('textbox', { name: 'Document text' })).toContainText('Written in another tab.');
  expect(await bodyOf(page, await idOf(page, 'The Landing'))).toContain('Written in another tab.');
});

test('a put-back the store refuses keeps the copy, and a second try puts the words back once', async ({ page }) => {
  const { projectId } = await stopTab(page, 'Refused Put Back');

  const notice = page.getByRole('dialog', { name: 'This project is open in another tab' });
  await notice.getByRole('button', { name: 'Reload this tab' }).click();
  page.once('dialog', (dialog) => void dialog.accept());
  await notice.getByRole('button', { name: 'Reload and keep the words here' }).click();
  await expect(page.getByRole('heading', { name: 'Projects in this browser' })).toBeVisible();

  await openFromProjects(page, 'Refused Put Back');
  const offer = page.getByTestId('unsent-words');
  await expect(offer).toBeVisible({ timeout: 20_000 });

  // The first try puts the words back in the session, but the store refuses to save them: the words stay kept, and the offer says so.
  await refuse(page, 'store', true);
  await offer.getByRole('button', { name: 'Put them back as new documents' }).click();
  await expect(offer.getByRole('alert')).toContainText('has not saved them yet');
  expect(await keptCopy(page, projectId ?? '')).toContain('More from here.');

  // The second try finds the document the first made, and repeats nothing: once the store saves, the copy goes and one document is there.
  await refuse(page, 'store', false);
  await offer.getByRole('button', { name: 'Put them back as new documents' }).click();
  await expect(page.getByTestId('unsent-words')).toHaveCount(0);
  expect(await keptCopy(page, projectId ?? '')).toBeNull();
  await expect(binderTitle(page, 'The Landing (kept from a stopped tab)')).toHaveCount(1);
  await binderTitle(page, 'The Landing (kept from a stopped tab)').click();
  await expect(page.getByRole('textbox', { name: 'Document text' })).toContainText('More from here.');
});

test('a copy the browser refuses to keep is shown as not kept, and the notice never says the words are kept', async ({ page }) => {
  await projectWithScene(page, 'Refused Copy', 'Saved here first.');
  const projectId = await projectIdOf(page);
  const sceneId = await idOf(page, 'The Landing');
  const other = await secondTab(page);
  await storeNewerText(other, projectId, sceneId);

  await refuse(page, 'copy', true);
  await page.getByRole('textbox', { name: 'Document text' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' More from here.');
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'conflict');
  await expect(page.getByTestId('stale-tab-notice')).toHaveAttribute('data-kept', 'memory');
  expect(await keptCopy(page, projectId ?? '')).toBeNull();
});

test('removing a project from this browser deletes the words its stopped tab kept', async ({ page }) => {
  const { projectId } = await stopTab(page, 'Removed Words');

  const notice = page.getByRole('dialog', { name: 'This project is open in another tab' });
  await notice.getByRole('button', { name: 'Reload this tab' }).click();
  page.once('dialog', (dialog) => void dialog.accept());
  await notice.getByRole('button', { name: 'Reload and keep the words here' }).click();
  await expect(page.getByRole('heading', { name: 'Projects in this browser' })).toBeVisible();
  expect(await keptCopy(page, projectId ?? '')).toContain('More from here.');

  await page.getByRole('button', { name: 'Remove Removed Words from this browser' }).click();
  const confirm = page.getByRole('dialog', { name: 'Remove “Removed Words” from this browser?' });
  await confirm.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByText(new RegExp(`Removed “${writerText('Removed Words')}” from this browser`))).toBeVisible();

  // Nothing can open the project again to offer the words back, so the browser keeps none of them.
  expect(await keptCopy(page, projectId ?? '')).toBeNull();
});
