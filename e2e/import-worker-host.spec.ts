/**
 * The import preview's Worker host (issues #283 / #274 / #390): the readers run off the main thread, so a large file does not block
 * typing or scrolling while it parses. The first test measures the main-thread frame gap during a large RTF read and shows it stays
 * small while the read itself takes much longer — the change is shown to help, not assumed (#390). It also checks the app's CSP admits
 * the Worker with no violation. The second cancels a read in flight. The third picks an `.rtfd` package folder (#274).
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { bodyOf, createProject, traceNames, treeOf, waitForSaved } from './support.js';

declare global {
  interface Window {
    __frames?: number[];
    __csp?: string[];
    __stop?: boolean;
  }
}

const PNG_HEX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64').toString('hex');

/** A large RTF: `chapters` headings, each over `paras` paragraphs of prose, so the parse is heavy but the split is cheap. */
function bigRtf(chapters: number, paras: number): string {
  const parts = ['{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0 Times;}}{\\stylesheet{\\s0 Normal;}{\\s1 heading 1;}}'];
  for (let c = 1; c <= chapters; c += 1) {
    parts.push(`{\\pard\\s1\\outlinelevel0 Chapter ${c}\\par}`);
    for (let p = 0; p < paras; p += 1) {
      parts.push('{\\pard The ferry came at noon and Mara watched the grey water from the rocks below the lamp room.\\par}');
    }
  }
  parts.push('}');
  return parts.join('\n');
}

async function startTicker(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__frames = [];
    window.__csp = [];
    window.__stop = false;
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__csp?.push(`${event.effectiveDirective} refused ${event.blockedURI || '(inline)'}`);
    });
    let last = performance.now();
    const tick = (now: number): void => {
      window.__frames?.push(now - last);
      last = now;
      if (window.__stop !== true) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function stopTicker(page: Page): Promise<{ maxGap: number; csp: string[] }> {
  return page.evaluate(() => {
    window.__stop = true;
    const frames = window.__frames ?? [];
    return { maxGap: frames.reduce((max, gap) => Math.max(max, gap), 0), csp: window.__csp ?? [] };
  });
}

test('a large RTF reads in a Worker: the main thread stays responsive and the CSP admits it', async ({ page }) => {
  await createProject(page, 'Big Import');
  await startTicker(page);

  const rtf = bigRtf(24, 500);
  const started = Date.now();
  await page.locator('input[type="file"][aria-label="RTF file"]').setInputFiles({ name: 'big.rtf', mimeType: 'application/rtf', buffer: Buffer.from(rtf, 'utf8') });

  const dialog = page.getByRole('dialog', { name: 'Import “big.rtf”' });
  await expect(dialog.locator('.import-preview-detected')).toContainText('24 chapters', { timeout: 30_000 });
  const readMs = Date.now() - started;
  const { maxGap, csp } = await stopTicker(page);

  expect(csp).toEqual([]);
  // The read takes much longer than the longest main-thread stall: the parse ran in the Worker, not on this thread. The bound scales
  // with the measured read so a slow runner does not flake, and a main-thread parse (a stall as long as the read) would fail it.
  expect(maxGap).toBeLessThan(Math.max(150, readMs * 0.4));

  await dialog.getByRole('button', { name: 'Import 24 chapters' }).click();
  await expect(dialog).toBeHidden();
  await waitForSaved(page);
  expect((await traceNames(page)).filter((name) => name === 'binder.importTree')).toHaveLength(1);
  const tree = await treeOf(page);
  expect(tree.filter((node) => node.parentId === 'manuscript' && node.type === 'folder')).toHaveLength(24);
});

test('cancelling a read in flight closes the preview and writes nothing', async ({ page }) => {
  await createProject(page, 'Cancelled Import');
  await page.locator('input[type="file"][aria-label="RTF file"]').setInputFiles({ name: 'big.rtf', mimeType: 'application/rtf', buffer: Buffer.from(bigRtf(24, 500), 'utf8') });
  const dialog = page.getByRole('dialog', { name: 'Import “big.rtf”' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(await traceNames(page)).not.toContain('binder.importTree');
});

test('an RTFD package folder imports its text and its picture', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'the package folder picker is exercised in Chromium; the reader itself runs in every browser');
  const dir = mkdtempSync(join(tmpdir(), 'caotang-rtfd-'));
  const rtf = [
    '{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0 Times;}}{\\stylesheet{\\s0 Normal;}{\\s1 heading 1;}}',
    '{\\pard\\s1\\outlinelevel0 The Package\\par}',
    '{\\pard Hello from the RTFD package.\\par}',
    `{\\pard{\\pict\\pngblip ${PNG_HEX}}\\par}`,
    '}',
  ].join('\n');
  writeFileSync(join(dir, 'TXT.rtf'), rtf, 'utf8');
  writeFileSync(join(dir, 'image.png'), Buffer.from(PNG_HEX, 'hex'));

  await createProject(page, 'Package Import');
  await page.locator('input[type="file"][aria-label="RTFD package folder"]').setInputFiles(dir);

  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.import-preview-detected')).toContainText('1 chapter');
  await expect(dialog.getByRole('checkbox', { name: 'Import 1 picture' })).toBeChecked();
  await dialog.getByRole('button', { name: 'Import 1 chapter' }).click();
  await expect(dialog).toBeHidden();
  await waitForSaved(page);

  const tree = await treeOf(page);
  const documents = tree.filter((node) => node.type === 'document');
  let imported: string | null = null;
  for (const node of documents) {
    const body = await bodyOf(page, node.id);
    if (body !== null && body.includes('Hello from the RTFD package.')) {
      imported = body;
      break;
    }
  }
  expect(imported).not.toBeNull();
  expect(imported).toMatch(/!\[[^\]]*\]\(\.\.\/assets\/a_[0-9A-Z]{10}\.png\)/);
});
