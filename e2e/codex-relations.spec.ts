import { expect, test, type Page } from '@playwright/test';
import { createProject, waitForSaved } from './support.js';

function browserStoreAt(page: Page, version: number): Promise<string> {
  return page.evaluate((target) => new Promise<string>((resolve) => {
    const request = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB.open('caotang', target);
    request.onsuccess = () => { request.result.close(); resolve('open'); };
    request.onerror = () => resolve(request.error?.name ?? 'unknown');
  }), version);
}

async function newEntry(page: Page, name: string): Promise<void> {
  const back = page.getByRole('button', { name: '← All entries' });
  if (await back.isVisible()) await back.click();
  await page.getByRole('button', { name: 'New entry' }).click();
  const field = page.getByRole('textbox', { name: 'Name', exact: true });
  await field.fill(name);
  await field.press('Enter');
  await waitForSaved(page);
}

test('a relation is edited on the entry that states it and shows on the entry it links to', async ({ page }) => {
  test.setTimeout(90_000);
  await createProject(page, 'Harbour Ledger');
  const codex = page.getByRole('tab', { name: 'Codex' });
  await codex.click();
  await newEntry(page, 'Fenn');
  await newEntry(page, 'Mara');
  expect(await browserStoreAt(page, 6)).toBe('open');

  await page.getByRole('button', { name: '← All entries' }).click();
  await page.getByRole('button', { name: /^Fenn/ }).click();
  const relations = page.getByRole('region', { name: 'Relations' });
  await expect(relations).toContainText('This entry links to nothing yet.');
  const add = relations.getByRole('button', { name: 'Add relation' });
  await add.click();
  await relations.getByLabel('Linked entry').selectOption({ label: 'Mara' });
  await relations.getByLabel('Label', { exact: true }).fill('ally');
  await relations.getByRole('button', { name: 'Save relation' }).click();
  await expect(add).toBeFocused();
  await expect(relations).toContainText('ally');
  await waitForSaved(page);
  expect(await browserStoreAt(page, 8)).toBe('VersionError');

  await page.reload();
  await page.getByRole('listitem').filter({ hasText: 'Harbour Ledger' }).getByRole('button', { name: 'Open' }).click();
  await codex.click();
  await page.getByRole('button', { name: /^Fenn/ }).click();
  await expect(relations).toContainText('ally');
  const target = relations.getByRole('button', { name: 'Mara', exact: true });
  await target.click();

  const linked = page.getByRole('region', { name: 'Relations' });
  await expect(linked).toContainText('Linked from');
  await expect(linked.getByRole('button', { name: 'Fenn', exact: true })).toBeVisible();
  await expect(linked).toContainText('This entry links to nothing yet.');

  await linked.getByRole('button', { name: 'Fenn', exact: true }).click();
  const edit = relations.getByRole('button', { name: 'Edit relation to Mara' });
  await edit.click();
  await relations.getByLabel('Label', { exact: true }).fill('rival');
  await relations.getByRole('button', { name: 'Save relation' }).click();
  await expect(edit).toBeFocused();
  await expect(relations).toContainText('rival');
  await expect(relations).not.toContainText('ally');

  await page.getByRole('button', { name: '← All entries' }).click();
  await page.getByRole('button', { name: 'Graph', pressed: false }).click();
  const drawing = page.locator('svg.codex-graph-drawing');
  await expect(drawing).toBeVisible();
  const links = page.getByRole('list', { name: 'Entries and their links' });
  await expect(links).toContainText('Mara');
  const follow = links.getByRole('button', { name: 'Links to Mara.' });
  await follow.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 2, name: 'Mara' })).toBeVisible();
  await page.getByRole('button', { name: '← All entries' }).click();
  await page.getByRole('button', { name: 'List', pressed: false }).click();
  await page.getByRole('button', { name: /^Fenn/ }).click();

  await relations.getByRole('button', { name: 'Remove relation to Mara' }).click();
  await expect(add).toBeFocused();
  await expect(relations).toContainText('This entry links to nothing yet.');
  await waitForSaved(page);
  await page.reload();
  await page.getByRole('listitem').filter({ hasText: 'Harbour Ledger' }).getByRole('button', { name: 'Open' }).click();
  await codex.click();
  await page.getByRole('button', { name: /^Mara/ }).click();
  await expect(linked).not.toContainText('Linked from');
});
