/**
 * The RTF reader (`@caotang/import-rtf`, issue #274) runs the same in Node, on the page's main thread and in a `'self'` module
 * Worker, under the app's Content-Security-Policy, with no `securitypolicyviolation`. The code pages go through the host's own
 * `TextDecoder`, so this also checks that each browser decodes GBK and the Windows code page the same way Node does.
 */

import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { readRtf } from '../packages/import-rtf/src/rtf.js';

import type * as Summary from './import-rtf-summary.js';
import { rtfSummary, type RtfInput, type RtfSummary } from './import-rtf-summary.js';
import type * as RtfModule from '../packages/import-rtf/src/rtf.js';

declare global {
  interface Window {
    __cspViolations?: string[];
  }
}

const fsUrl = (relative: string): string =>
  `/@fs/${fileURLToPath(new URL(relative, import.meta.url)).replaceAll('\\', '/').replace(/^\/+/, '')}`;

const PNG = '89504e470d0a1a0a0000000d49484452';
const RTF = [
  '{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0 Arial;}{\\f1\\fcharset134 SimSun;}}',
  "\\pard\\qc\\b Chapter One\\b0\\par",
  "\\pard \\'93Caf\\'e9\\'94 {\\f1\\'d6\\'d0\\'ce\\'c4} \\uc0\\u55357 \\u56832  \\uc1\\u8364?{\\footnote Note.}\\par",
  '\\trowd\\pard\\intbl a\\cell b\\cell\\row',
  `\\pard{\\pict\\pngblip ${PNG}}\\par}`,
].join('\n');

const input: RtfInput = { rtf: [...new TextEncoder().encode(RTF)] };

const expected: RtfSummary = {
  blocks: ['**Chapter One**', '“Café” 中文 😀 €[^1]', 'a | b', '<image rtf-image-1.png>'],
  footnotes: ['1@1: Note.'],
  assets: ['rtf-image-1.png image/png 16'],
  losses: ['formatting', 'table', 'formatting'],
  notRtf: 'RtfReadError:not-rtf',
};

test('the RTF reader gives the same answers in Node, on the main thread and in a self Worker, with no CSP violation', async ({ page }) => {
  // Node.
  expect(rtfSummary(input, readRtf)).toEqual(expected);

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
    async ({ rtfUrl, summaryUrl, data }) => {
      const rtf = (await import(/* @vite-ignore */ rtfUrl)) as typeof RtfModule;
      const summary = (await import(/* @vite-ignore */ summaryUrl)) as typeof Summary;
      return summary.rtfSummary(data, rtf.readRtf);
    },
    { rtfUrl: fsUrl('../packages/import-rtf/src/rtf.ts'), summaryUrl: fsUrl('./import-rtf-summary.ts'), data: input },
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
    { workerUrl: fsUrl('./import-rtf.worker.ts'), data: input },
  );
  expect(inWorker).toEqual({ summary: expected, violations: [], isWorker: true });

  expect(await page.evaluate(() => window.__cspViolations ?? ['the violation listener was not installed'])).toEqual([]);
});
