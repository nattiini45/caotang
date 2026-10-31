import { readFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import { createProject, waitForSaved } from './support.js';
import { textEntry, zipEntries } from './zip-entries.js';

/**
 * epub-metadata.md and exporter.md §3a, read from the file a writer receives: the author, the ISBN and the cover that the
 * Project panel sets reach the EPUB's package document, and the identifier is the same on every export. A bundle keeps all of
 * it: the project is removed from the browser, imported back from its bundle, and the same checks pass again.
 */

/** A 1×1 PNG, the smallest picture a cover can be. The cover import checks it, and the EPUB carries its transcoded PNG. */
const COVER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

async function manuscriptWithScene(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('The Landing');
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Document text' }).fill('The boat came in with the tide. Nobody was on it.');
  await waitForSaved(page);
}

/** The Project panel: an author, an ISBN and a cover, each saved when its field is left. */
async function setProjectDetails(page: Page, projectName: string): Promise<void> {
  await page.getByRole('button', { name: projectName }).click();
  const panel = page.getByRole('dialog', { name: 'Project' });
  await panel.getByRole('textbox', { name: 'Author' }).fill('Ada Writer');
  await panel.getByRole('textbox', { name: 'Author' }).press('Enter');
  await panel.getByRole('textbox', { name: 'ISBN' }).fill('978-0-306-40615-7');
  await panel.getByRole('textbox', { name: 'ISBN' }).press('Enter');
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await panel.getByLabel('Cover image file').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: COVER_PNG });
  await expect(page.getByRole('status').filter({ hasText: 'The cover is set' })).toBeVisible();
  await panel.getByRole('button', { name: 'Done' }).click();
  await expect(panel).toHaveCount(0);
  await waitForSaved(page);
}

/** Compiles the manuscript to EPUB from the export dialog, and reads the file the browser downloads. */
async function downloadEpub(page: Page): Promise<Map<string, Uint8Array>> {
  await page.getByRole('button', { name: 'Compile…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  await dialog.getByRole('radio', { name: /^EPUB \(\.epub\)/ }).check();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'Compile', exact: true }).click(),
  ]);
  const path = await download.path();
  return zipEntries(new Uint8Array(readFileSync(path ?? '')));
}

/** The package document of an EPUB carries the panel's values, and the identifier it returns is the one a retailer keys on. */
function expectPackage(entries: Map<string, Uint8Array>): string {
  const opf = textEntry(entries, 'OEBPS/content.opf');
  expect(opf).toContain('<dc:creator id="creator">Ada Writer</dc:creator>');
  expect(opf).toContain('<dc:identifier id="isbn-id">urn:isbn:9780306406157</dc:identifier>');
  expect(opf).toContain('<meta refines="#isbn-id" property="identifier-type" scheme="onix:codelist5">15</meta>');
  expect(opf).toContain('<item id="cover-image" href="cover.png" media-type="image/png" properties="cover-image"/>');
  expect(opf).toContain('<meta name="cover" content="cover-image"/>');
  // EPUB export strips and re-encodes the cover under the picture profile, so check the carried PNG rather than the source bytes.
  const cover = entries.get('OEBPS/cover.png');
  expect(cover).toBeDefined();
  expect(Array.from(cover?.subarray(0, 8) ?? [])).toEqual(Array.from(COVER_PNG.subarray(0, 8)));
  expect(cover?.length).toBeGreaterThan(8);

  const pubId = /<dc:identifier id="pub-id">(urn:uuid:[^<]+)<\/dc:identifier>/.exec(opf)?.[1];
  expect(pubId).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
  // The unique identifier is the stored uuid, not the ISBN, so a retailer's record of the book does not move with the ISBN.
  expect(opf).toContain(`<dc:identifier id="pub-id">${pubId}</dc:identifier>`);
  return pubId ?? '';
}

test('the EPUB package document carries the author, the ISBN and the cover, and a bundle restores them with the same identifier', async ({ page }) => {
  await createProject(page, 'Package Book');
  await manuscriptWithScene(page);
  await setProjectDetails(page, 'Package Book');

  const identifier = expectPackage(await downloadEpub(page));

  // Export a bundle, remove the project from this browser, and import the bundle: nothing about the book may be lost.
  await waitForSaved(page);
  await page.getByRole('button', { name: 'Projects' }).click();
  await expect(page.getByRole('heading', { name: 'Projects in this browser' })).toBeVisible();
  const [bundle] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export Package Book as a bundle' }).click(),
  ]);
  const bundlePath = (await bundle.path()) ?? '';

  await page.getByRole('button', { name: 'Remove Package Book from this browser' }).click();
  await page.getByRole('dialog', { name: 'Remove “Package Book” from this browser?' }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('heading', { name: 'No projects here yet' })).toBeVisible();

  await page.getByTestId('bundle-input').setInputFiles(bundlePath);
  await expect(page.getByRole('heading', { name: 'Package Book', level: 1 })).toBeVisible();

  expect(expectPackage(await downloadEpub(page))).toBe(identifier);
});
