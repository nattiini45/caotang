#!/usr/bin/env node
/* global window */
/**
 * Renders PDFs to PNG in every reader that is here, so the colour emoji can be looked at (docs/testing/colour-emoji.md).
 *
 *   CAOTANG_PDF_OUT=/tmp/pdfs pnpm exec vitest run packages/exporter/test/pdf-write-corpus.test.ts
 *   node tools/render-colour-emoji.mjs /tmp/pdfs /tmp/renders [name-prefix]
 *
 * Every `<name>.pdf` of the first directory whose name starts with the prefix (default `screenplay-colour` and `sheet-colour`) is drawn to
 * `<name>-<engine>.png` in the second, page 1 at three times its size:
 *   - pdf.js (`pdfjs-dist`, a dev dependency of @caotang/exporter), in Chromium (`@playwright/test`'s, installed with
 *     `pnpm exec playwright install chromium`). Any console message pdf.js prints while it draws fails the run.
 *   - PDFium and MuPDF, when Python has `pypdfium2` and `pymupdf` (`pip install pypdfium2 pymupdf`: scratch tooling, not part of
 *     `pnpm install`), and Poppler's `pdftocairo` and Ghostscript's `gs`, when they are on PATH. An engine that is not here is said to be
 *     skipped, never counted as passed.
 * Nothing compares the pictures: the check is by eye, before and after, and the exit code only says an engine failed to draw.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const requireFromExporter = createRequire(join(root, 'packages', 'exporter', 'package.json'));

const [, , inputArg, outputArg, ...prefixes] = process.argv;
if (inputArg === undefined || outputArg === undefined) {
  console.error('usage: node tools/render-colour-emoji.mjs <dir of pdfs> <dir for pngs> [name prefix...]');
  process.exit(2);
}
const input = resolve(inputArg);
const output = resolve(outputArg);
mkdirSync(output, { recursive: true });
const wanted = prefixes.length > 0 ? prefixes : ['screenplay-colour', 'sheet-colour'];
const files = readdirSync(input).filter((name) => name.endsWith('.pdf') && wanted.some((prefix) => name.startsWith(prefix)));
if (files.length === 0) {
  console.error(`no PDF in ${input} starts with ${wanted.join(' or ')}`);
  process.exit(2);
}

const SCALE = 3;
const failures = [];
const skipped = [];

/** pdf.js in Chromium: the page imports pdf.js from this server, draws page 1 into a canvas and says when it is done. */
async function withPdfjs() {
  const pdfjsDir = join(requireFromExporter.resolve('pdfjs-dist/package.json'), '..', 'build');
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/') {
      response.setHeader('content-type', 'text/html');
      response.end(`<!doctype html><canvas id="c"></canvas><script type="module">
        import * as pdfjs from '/pdf.mjs';
        pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.mjs';
        const file = new URLSearchParams(location.search).get('file');
        try {
          const doc = await pdfjs.getDocument({ url: '/files/' + file, verbosity: 1 }).promise;
          const page = await doc.getPage(1);
          const viewport = page.getViewport({ scale: ${SCALE} });
          const canvas = document.getElementById('c');
          canvas.width = viewport.width; canvas.height = viewport.height;
          await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
          window.__done = true;
        } catch (error) { window.__done = String(error); }
      </script>`);
      return;
    }
    const path = url.pathname.startsWith('/files/') ? join(input, basename(url.pathname)) : join(pdfjsDir, basename(url.pathname));
    if (!existsSync(path)) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader('content-type', path.endsWith('.pdf') ? 'application/pdf' : 'text/javascript');
    response.end(readFileSync(path));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  let browser;
  try {
    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch();
    for (const name of files) {
      const page = await browser.newPage();
      const said = [];
      page.on('console', (message) => said.push(`${message.type()}: ${message.text()}`));
      page.on('pageerror', (error) => said.push(`error: ${error.message}`));
      await page.goto(`http://127.0.0.1:${port}/?file=${encodeURIComponent(name)}`);
      await page.waitForFunction(() => window.__done !== undefined, undefined, { timeout: 60_000 });
      const state = await page.evaluate(() => window.__done);
      if (state !== true) failures.push(`pdf.js could not draw ${name}: ${state}`);
      for (const line of said) failures.push(`pdf.js said, drawing ${name}: ${line}`);
      writeFileSync(join(output, `${name.replace(/\.pdf$/, '')}-pdfjs.png`), await page.locator('#c').screenshot());
      await page.close();
    }
  } catch (error) {
    failures.push(`pdf.js in Chromium did not run: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await browser?.close();
    server.close();
  }
}

/** PDFium and MuPDF through Python, when it has them. */
function withPython() {
  const script = `
import sys
out, scale, names = sys.argv[1], float(sys.argv[2]), sys.argv[3:]
engines = []
try:
    import pypdfium2
    engines.append('pdfium')
except ImportError:
    print('skip pdfium')
try:
    import pymupdf
    engines.append('mupdf')
except ImportError:
    print('skip mupdf')
for path in names:
    stem = path.rsplit('/', 1)[-1].rsplit('\\\\', 1)[-1][:-4]
    if 'pdfium' in engines:
        pypdfium2.PdfDocument(path)[0].render(scale=scale).to_pil().save(f'{out}/{stem}-pdfium.png')
    if 'mupdf' in engines:
        pymupdf.open(path)[0].get_pixmap(matrix=pymupdf.Matrix(scale, scale)).save(f'{out}/{stem}-mupdf.png')
print('ran ' + ' '.join(engines))
`;
  const result = spawnSync('python', ['-I', '-c', script, output, String(SCALE), ...files.map((name) => join(input, name))], { encoding: 'utf8' });
  if (result.error !== undefined || result.status !== 0) {
    skipped.push(`PDFium and MuPDF (python: ${result.error?.message ?? result.stderr.trim().split('\n').at(-1)})`);
    return;
  }
  for (const line of result.stdout.split('\n')) if (line.startsWith('skip ')) skipped.push(line.slice(5));
}

/** Poppler's pdftocairo and Ghostscript, when they are on PATH. */
function withCommandLineReaders() {
  for (const name of files) {
    const stem = name.replace(/\.pdf$/, '');
    const file = join(input, name);
    const cairo = spawnSync('pdftocairo', ['-png', '-singlefile', '-f', '1', '-l', '1', '-r', String(72 * SCALE), file, join(output, `${stem}-poppler`)], { encoding: 'utf8' });
    if (cairo.error !== undefined) skipped.push('pdftocairo (Poppler)');
    else if (cairo.status !== 0) failures.push(`pdftocairo could not draw ${name}: ${cairo.stderr.trim()}`);
    const gs = spawnSync('gs', ['-q', '-dBATCH', '-dNOPAUSE', '-dSAFER', '-dFirstPage=1', '-dLastPage=1', '-sDEVICE=png16m', `-r${72 * SCALE}`, `-sOutputFile=${join(output, `${stem}-ghostscript.png`)}`, file], { encoding: 'utf8' });
    if (gs.error !== undefined) skipped.push('gs (Ghostscript)');
    else if (gs.status !== 0 || /\*\*\*\*/.test(gs.stderr + gs.stdout)) failures.push(`gs could not draw ${name}: ${(gs.stderr + gs.stdout).trim()}`);
  }
}

await withPdfjs();
withPython();
withCommandLineReaders();
console.log(`rendered ${files.length} file(s) to ${output}`);
if (skipped.length > 0) console.log(`skipped (not here): ${[...new Set(skipped)].join(', ')}`);
if (failures.length > 0) {
  for (const line of failures) console.error(line);
  process.exit(1);
}
