/**
 * **Import Kanka…** (issue #293): a JSON campaign export chosen in the binder opens in the shared import preview with its entities
 * offered as codex entries, and Import writes the entries, their Research pages and the world-history index as one
 * `binder.importTree`. Cancel writes nothing.
 */

import { expect, test, type Page } from '@playwright/test';

import { bodyOf, createProject, traceNames, treeOf, waitForSaved } from './support.js';

/** A zip whose entries are stored, not compressed: enough to hand the app an export without a zip tool. */
function storedZip(entries: Record<string, string | Buffer>): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (data: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of data) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = typeof text === 'string' ? Buffer.from(text) : text;
    const path = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(path.length, 26);
    locals.push(local, path, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(path.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, path);
    offset += 30 + path.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const entity = (id: number, name: string, extra: Record<string, unknown>): string =>
  JSON.stringify({
    id,
    name,
    entity: { id, name, type: '', entry: '', is_private: false, image_path: '', entityTags: [], relationships: [], posts: [], entityAttributes: [], reminders: [], ...extra },
  });

// Kanka's own export layout, with invented text.
const CAMPAIGN: Record<string, string | Buffer> = {
  'info.json': JSON.stringify({ kanka_version: '2.1.4', export_version: '2.1.4' }),
  'campaign.json': JSON.stringify({ id: 1, name: 'The Ninth House' }),
  'characters/elena_11.json': entity(11, 'Elena', {
    type: 'Cartographer',
    entry: '<p>Elena maps the harbour with [entity:12].</p><script>alert(1)</script>',
    entityAttributes: [{ id: 1, name: 'Age', value: '34', default_order: 1 }],
    relationships: [{ id: 5, owner_id: 11, target_id: 12, relation: 'sister', attitude: 3, mirror_id: 6 }],
    reminders: [{ id: 1, type_id: 2, year: 1204, month: 3, day: 2 }],
  }),
  'characters/mara_12.json': entity(12, 'Mara', { entry: '<p>Mara keeps the light.</p>' }),
  'journals/secret_16.json': entity(16, 'Secret', { is_private: true, entry: '<p>Only the writer sees this.</p>' }),
  'events/flood_17.json': JSON.stringify({ id: 17, name: 'The Flood', date: 'Year 1204', entity: { id: 17, name: 'The Flood', entry: '<p>The water came at night.</p>', reminders: [] } }),
  'gallery/91.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
};

const choose = async (page: Page): Promise<void> => {
  await page.locator('input[type="file"][aria-label="Kanka export"]').setInputFiles({ name: 'campaign.zip', mimeType: 'application/zip', buffer: storedZip(CAMPAIGN) });
};

test('a Kanka export offers its entities, and Import writes the entries and their pages as one step', async ({ page }) => {
  await createProject(page, 'Kanka Import');
  await choose(page);

  const dialog = page.getByRole('dialog', { name: 'Import “campaign.zip”' });
  await expect(dialog).toBeVisible();
  const carried = dialog.getByRole('list', { name: 'What the campaign carried' });
  await expect(carried).toContainText('4 entities are offered as codex entries with their own Research pages');
  await expect(carried).toContainText('1 private entity is kept manual');
  await expect(carried).toContainText('The events and calendar dates became one World history page.');
  await expect(dialog.getByRole('list', { name: 'What was approximated' })).toContainText('1 connection is written as text on its page');
  await expect(dialog.getByRole('list', { name: 'What the import removed' })).toContainText('1 script was removed');
  await expect(dialog.getByRole('list', { name: 'What the import removed' })).toContainText('1 SVG picture was refused');
  const codex = dialog.getByRole('region', { name: 'Codex rows' });
  await expect(codex).toContainText('Elena');
  await expect(codex).toContainText('Secret');

  // Cancel writes nothing.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(await traceNames(page)).not.toContain('binder.importTree');

  await choose(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Import 4 entries' }).click();
  await expect(dialog).toBeHidden();
  await waitForSaved(page);

  expect((await traceNames(page)).filter((name) => name === 'binder.importTree')).toHaveLength(1);
  const tree = await treeOf(page);
  // Everything is Research: a campaign export is worldbuilding, not a draft.
  expect(tree.filter((node) => node.parentId === 'manuscript').map((node) => node.title)).toEqual([]);
  const research = tree.filter((node) => node.parentId === 'research').map((node) => node.title);
  expect(research).toContain('World history');
  expect(research).toContain('Elena');
  expect(research).toContain('Secret');

  const elena = tree.find((node) => node.title === 'Elena');
  const body = await bodyOf(page, elena?.id ?? '');
  expect(body).toContain('Elena maps the harbour with Mara.');
  expect(body).toContain('- Age: 34');
  expect(body).toContain('- Mara — sister (attitude 3, two-way)');
  expect(body).toContain('- Born: year 1204, month 3, day 2');
  expect(body).not.toContain('alert');

  const history = tree.find((node) => node.title === 'World history');
  expect(await bodyOf(page, history?.id ?? '')).toContain('- Year 1204 — The Flood');

  // The entries are in the codex, written by the same step.
  await page.getByRole('tab', { name: 'Codex' }).click();
  const entries = page.getByRole('region', { name: 'Codex entries' });
  await expect(entries).toContainText('Elena');
  await expect(entries).toContainText('The Flood');
});

test('an export from an older Kanka is refused with a plain message', async ({ page }) => {
  await createProject(page, 'Kanka Old Export');
  await page.locator('input[type="file"][aria-label="Kanka export"]').setInputFiles({
    name: 'old.zip',
    mimeType: 'application/zip',
    buffer: storedZip({ ...CAMPAIGN, 'info.json': JSON.stringify({ kanka_version: '1.0.34' }) }),
  });
  await expect(page.getByText('This export was made by Kanka 1.0.34.')).toBeVisible();
  expect(await traceNames(page)).not.toContain('binder.importTree');
});
