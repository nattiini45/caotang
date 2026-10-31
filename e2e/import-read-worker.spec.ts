/**
 * The shared import readers (`@caotang/import-read`, issue #268) run the same in Node, on the page's main thread and in a
 * `'self'` module Worker, under the app's Content-Security-Policy, with no `securitypolicyviolation`.
 *
 * The page is the app on the dev server, so its policy is index.html's (`script-src 'self'; worker-src 'self'`, with no
 * `'unsafe-eval'`, no `wasm-unsafe-eval` and no `blob:`). The main-thread run is the one the policy governs most directly: an
 * `eval`, `new Function` or WebAssembly compile anywhere in the readers, or in the part of fflate they load, would be refused
 * there and reported. The Worker run proves the readers need no DOM (`DOMParser` does not exist in a Worker) and that the
 * Worker itself is admitted by `worker-src 'self'`. Node is the test runner itself.
 */

import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { attr, descendants, readXml, textOf } from '../packages/import-read/src/xml.js';
import { openZip } from '../packages/import-read/src/zip.js';
import { rawZip } from '../packages/import-read/test/zip-fixtures.js';

import type * as Summary from './import-read-summary.js';
import { readersSummary, type ReadersInput, type ReadersSummary } from './import-read-summary.js';
import type * as XmlModule from '../packages/import-read/src/xml.js';
import type * as ZipModule from '../packages/import-read/src/zip.js';

declare global {
  interface Window {
    __cspViolations?: string[];
  }
}

const fsUrl = (relative: string): string =>
  `/@fs/${fileURLToPath(new URL(relative, import.meta.url)).replaceAll('\\', '/').replace(/^\/+/, '')}`;

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const DOCUMENT = `<?xml version="1.0" encoding="UTF-16"?><w:document xmlns:w="${W}"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Kapitel &amp; 草堂</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">One </w:t></w:r><w:r><w:t>two.</w:t></w:r></w:p></w:body></w:document>`;

function utf16le(text: string): number[] {
  const out: number[] = [0xff, 0xfe];
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    out.push(c & 0xff, c >> 8);
  }
  return out;
}

const input: ReadersInput = {
  xml: utf16le(DOCUMENT),
  zip: [
    ...rawZip([
      { name: 'word/document.xml', data: new TextEncoder().encode(DOCUMENT.replace('UTF-16', 'UTF-8')) },
      { name: '__MACOSX/word/._document.xml', data: new Uint8Array(4) },
      { name: new Uint8Array([0x47, 0x72, 0x94, 0xe1, 0x65, 0x2e, 0x74, 0x78, 0x74]), data: new Uint8Array(1) },
    ]),
  ],
  traversal: [...rawZip([{ name: '../evil.txt', data: new Uint8Array(1) }])],
};

const expected: ReadersSummary = {
  xml: { encoding: 'utf-16le', paragraphs: ['Kapitel & 草堂', 'One two.'], style: 'Heading1' },
  malformed: 'XmlReadError:mismatched-tag',
  entries: ['word/document.xml', 'Größe.txt'],
  ignored: ['__MACOSX/word/._document.xml'],
  fromZip: ['Kapitel & 草堂', 'One two.'],
  traversal: 'ImportArchiveError:path-traversal',
};

test('the import readers give the same answers in Node, on the main thread and in a self Worker, with no CSP violation', async ({ page }) => {
  // Node.
  expect(await readersSummary(input, { readXml, descendants, attr, textOf, openZip })).toEqual(expected);

  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__cspViolations?.push(`${event.effectiveDirective} refused ${event.blockedURI || '(inline)'}`);
    });
  });
  await page.goto('/');
  const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(policy).toContain("worker-src 'self'");
  expect(policy).not.toContain('unsafe-eval');

  // The main thread, under the page's policy.
  const mainThread = await page.evaluate(
    async ({ xmlUrl, zipUrl, summaryUrl, data }) => {
      const xml = (await import(/* @vite-ignore */ xmlUrl)) as typeof XmlModule;
      const zip = (await import(/* @vite-ignore */ zipUrl)) as typeof ZipModule;
      const summary = (await import(/* @vite-ignore */ summaryUrl)) as typeof Summary;
      return summary.readersSummary(data, { ...xml, openZip: zip.openZip });
    },
    {
      xmlUrl: fsUrl('../packages/import-read/src/xml.ts'),
      zipUrl: fsUrl('../packages/import-read/src/zip.ts'),
      summaryUrl: fsUrl('./import-read-summary.ts'),
      data: input,
    },
  );
  expect(mainThread).toEqual(expected);

  // A module Worker from this origin.
  const inWorker = await page.evaluate(
    async ({ workerUrl, data }) =>
      new Promise<unknown>((resolve) => {
        const worker = new Worker(workerUrl, { type: 'module' });
        worker.onmessage = (event: MessageEvent) => {
          resolve(event.data);
          worker.terminate();
        };
        worker.onerror = (event) => resolve({ error: event.message || 'the worker failed to start' });
        worker.postMessage(data);
      }),
    { workerUrl: fsUrl('./import-read.worker.ts'), data: input },
  );
  expect(inWorker).toEqual({ summary: expected, violations: [], isWorker: true });

  expect(await page.evaluate(() => window.__cspViolations ?? ['the violation listener was not installed'])).toEqual([]);
});
