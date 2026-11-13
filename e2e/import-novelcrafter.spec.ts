/**
 * **Import NovelCrafter zip…** (issue #292): a NovelCrafter export zip chosen in the binder opens in the shared import preview,
 * its manuscript split into chapters and its codex entries as confirmable rows with their relations and losses reported, and Import
 * writes the documents and the codex entry as one `binder.importTree`. Cancel writes nothing.
 */

import { expect, test, type Page } from '@playwright/test';

import { bodyOf, createProject, traceNames, treeOf, waitForSaved } from './support.js';

/** A zip whose entries are stored, not compressed: enough to hand the app an export without a zip tool. */
function storedZip(entries: Record<string, string>): Buffer {
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
    const data = Buffer.from(text);
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

const EXPORT: Record<string, string> = {
  'novel.md': '# Chapter One\n\nThe ferry came at noon.\n\n# Chapter Two\n\nThe letter arrived on a Tuesday.\n',
  'characters/Elena/entry.md': '---\nname: Elena\naliases: [El]\ntags: [captain]\nrole: protagonist\n---\nElena is the ferry captain.\n',
  'characters/Elena/metadata.json': '{"relations":[{"name":"Mara","type":"first mate"}]}',
  'characters/Elena/notes.md': 'She keeps the ledger.\n',
};

const choose = async (page: Page): Promise<void> => {
  await page.locator('input[type="file"][aria-label="NovelCrafter export zip"]').setInputFiles({ name: 'export.zip', mimeType: 'application/zip', buffer: storedZip(EXPORT) });
};

test('a NovelCrafter export opens with its manuscript and a codex row, and Import writes the documents and the codex entry as one step', async ({ page }) => {
  await createProject(page, 'NovelCrafter Import');
  await choose(page);

  const dialog = page.getByRole('dialog', { name: 'Import “export.zip”' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.import-preview-detected')).toContainText('2 chapters');
  await expect(dialog.locator('.import-preview-detected')).toContainText('1 codex row');
  // The report keeps the relations and lists what stays in NovelCrafter.
  await expect(dialog.getByRole('list', { name: 'What the import kept' })).toContainText('1 relation listed as a Connection');
  await expect(dialog.getByRole('list', { name: 'What stays in NovelCrafter' })).toContainText('Chats, snippets and prompts are not part of the export.');
  // The codex entry is a confirmable row, not silently merged.
  await expect(dialog.getByRole('combobox', { name: 'What to do with Elena', exact: true })).toBeVisible();

  // Cancel writes nothing.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(await traceNames(page)).not.toContain('binder.importTree');

  await choose(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Import 2 chapters' }).click();
  await expect(dialog).toBeHidden();
  await waitForSaved(page);

  expect((await traceNames(page)).filter((name) => name === 'binder.importTree')).toHaveLength(1);
  const tree = await treeOf(page);
  const chapters = tree.filter((node) => node.parentId === 'manuscript' && node.type === 'folder').map((node) => node.title);
  expect(chapters).toEqual(expect.arrayContaining(['Chapter One', 'Chapter Two']));
  const one = tree.find((node) => node.title === 'Chapter One');
  const scenes = tree.filter((node) => node.parentId === one?.id && node.type === 'document');
  const body = await bodyOf(page, scenes[0]?.id ?? '');
  expect(body).toContain('The ferry came at noon.');
  // The codex entry the manuscript does not name is kept as a research page of its own.
  expect(tree.some((node) => node.type === 'document' && node.title === 'Elena')).toBe(true);
});
