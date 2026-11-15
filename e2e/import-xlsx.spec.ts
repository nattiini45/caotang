/**
 * **Import spreadsheet…** with an Excel workbook (issue #289): an `.xlsx` chosen in the binder opens in the shared import preview,
 * its worksheet is a choice, and its rows import as codex entries or as timeline scenes exactly as a CSV of that sheet would.
 * Import writes one `binder.importTree`; Cancel writes nothing.
 */

import { expect, test } from '@playwright/test';

import { createProject, traceNames, treeOf, waitForSaved } from './support.js';

/** A zip whose entries are stored, not compressed: enough to hand the app a workbook without a zip tool. */
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

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const cell = (reference: string, value: string, type?: string, style?: number): string =>
  `<c r="${reference}"${type === undefined ? '' : ` t="${type}"`}${style === undefined ? '' : ` s="${style}"`}>${type === 'inlineStr' ? `<is><t>${value}</t></is>` : `<v>${value}</v>`}</c>`;
const sheet = (rows: string[][]): string =>
  `<?xml version="1.0"?><worksheet ${NS}><sheetData>${rows.map((cells, index) => `<row r="${index + 1}">${cells.join('')}</row>`).join('')}</sheetData></worksheet>`;

/** Two worksheets: a story bible, and a timeline whose Start column holds Excel date serials. */
function workbook(): Buffer {
  const bible = sheet([
    [cell('A1', 'Name', 'inlineStr'), cell('B1', 'Type', 'inlineStr'), cell('C1', 'Description', 'inlineStr')],
    [cell('A2', 'Elena', 'inlineStr'), cell('B2', 'Character', 'inlineStr'), cell('C2', 'A cartographer, back from sea', 'inlineStr')],
    [cell('A3', 'Mara', 'inlineStr'), cell('B3', 'Character', 'inlineStr'), cell('C3', 'Keeps the light', 'inlineStr')],
  ]);
  const timeline = sheet([
    [cell('A1', 'Title', 'inlineStr'), cell('B1', 'Start', 'inlineStr'), cell('C1', 'Summary', 'inlineStr')],
    [cell('A2', 'The Landing', 'inlineStr'), cell('B2', '46026', undefined, 1), cell('C2', 'The ferry came at noon.', 'inlineStr')],
    [cell('A3', 'Salt', 'inlineStr'), cell('B3', '46031', undefined, 1), cell('C3', 'The letter arrived.', 'inlineStr')],
  ]);
  return storedZip({
    'xl/workbook.xml': `<?xml version="1.0"?><workbook ${NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Bible" sheetId="1" r:id="rId1"/><sheet name="Timeline" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/styles.xml': `<?xml version="1.0"?><styleSheet ${NS}><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
    'xl/worksheets/sheet1.xml': bible,
    'xl/worksheets/sheet2.xml': timeline,
  });
}

test('a workbook opens on its first worksheet, and Import writes its codex entries as one step', async ({ page }) => {
  await createProject(page, 'XLSX Import');
  const file = { name: 'bible.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: workbook() };
  await page.locator('input[type="file"][aria-label="Spreadsheet file"]').setInputFiles(file);

  const dialog = page.getByRole('dialog', { name: 'Import “bible.xlsx”' });
  await expect(dialog).toBeVisible();
  const carried = dialog.getByRole('list', { name: 'What the file carried' });
  await expect(carried).toContainText('Read from the worksheet “Bible”.');
  await expect(carried).toContainText('2 worksheets in this workbook; the others are left out');
  await expect(carried).toContainText('2 rows are offered as codex entries with their own Research pages');
  const rules = dialog.getByRole('group', { name: 'Rules' });
  await expect(rules.getByLabel('Worksheet', { exact: true })).toHaveValue('Bible');
  await expect(dialog.getByRole('region', { name: 'Codex rows' })).toContainText('Elena');

  // Cancel writes nothing.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(await traceNames(page)).not.toContain('binder.importTree');

  await page.locator('input[type="file"][aria-label="Spreadsheet file"]').setInputFiles(file);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Import 2 entries' }).click();
  await expect(dialog).toBeHidden();
  await waitForSaved(page);

  expect((await traceNames(page)).filter((name) => name === 'binder.importTree')).toHaveLength(1);
  const research = (await treeOf(page)).filter((node) => node.parentId === 'research').map((node) => node.title);
  expect(research).toContain('Elena');
  expect(research).toContain('Mara');
});

test('the other worksheet imports as scenes, its Excel dates read as days', async ({ page }) => {
  await createProject(page, 'XLSX Timeline');
  await page.locator('input[type="file"][aria-label="Spreadsheet file"]').setInputFiles({
    name: 'timeline.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: workbook(),
  });

  const dialog = page.getByRole('dialog', { name: 'Import “timeline.xlsx”' });
  await expect(dialog).toBeVisible();
  const rules = dialog.getByRole('group', { name: 'Rules' });
  await rules.getByLabel('Worksheet', { exact: true }).selectOption('Timeline');
  await rules.getByLabel('Import as', { exact: true }).selectOption('timeline');
  const carried = dialog.getByRole('list', { name: 'What the file carried' });
  await expect(carried).toContainText('Read from the worksheet “Timeline”.');
  await expect(carried).toContainText('2 rows became scenes');
  await expect(carried).toContainText('Days are counted from 2026-01-04');

  await dialog.getByRole('button', { name: 'Import 2 scenes' }).click();
  await expect(dialog).toBeHidden();
  await waitForSaved(page);

  const scenes = (await treeOf(page)).filter((node) => node.type === 'document').map((node) => node.title);
  expect(scenes).toContain('The Landing');
  expect(scenes).toContain('Salt');
});
