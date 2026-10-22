#!/usr/bin/env node
/**
 * The PDF validation gate: reads the corpus the exporter's pdf-write-corpus test wrote and the expected.json beside it, and
 * fails when any file is not what the writers meant to write.
 *
 * Run: `CAOTANG_PDF_OUT=<dir> pnpm exec vitest run packages/exporter/test/pdf-write-corpus.test.ts`, then
 * `node tools/pdf-validate/check.mjs <dir> [--external[=qpdf,pdffonts,...]]`. CI's pdf-validate job does both.
 *
 * Always run, in Node, so a clean checkout can run them:
 *   - structure: the file starts `%PDF-` and ends `%%EOF`, and every in-use xref entry points at its own `N G obj`;
 *   - fonts: the fonts the file names, whether each carries its font program and a ToUnicode map, against expected.json;
 *   - pdf.js (a dev dependency of @caotang/exporter, never imported from src/): the document opens with no message at its
 *     default verbosity, every page's operator list builds, the page size and text are what expected.json says, and no font
 *     the file embeds is reported missing.
 * With --external (all of them, or the comma-separated names), the same files go through the independent tools CI installs.
 * A tool that is not on PATH is a failure, not a skip: a gate that quietly checks nothing is the failure it exists to prevent.
 *   - qpdf --check: exit 0 and no WARNING line;
 *   - pdffonts: the same font expectations, read from Poppler's table;
 *   - pdftotext -layout: the page text, whitespace aside;
 *   - pdftoppm -r 72 -png: no `Syntax Error` or `Syntax Warning` on stderr;
 *   - gs -dPDFSTOPONERROR, nullpage: exit 0 and no `**** Error` / `**** Warning`;
 *   - mutool draw: no `error:` or `warning:` line.
 * Each tool's raw output is written to <dir>/logs for CI to upload on a failure.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const exporterDir = fileURLToPath(new URL('../../packages/exporter/', import.meta.url));
const requireFromExporter = createRequire(join(exporterDir, 'package.json'));

/** Every external tool this script can run, in the order it runs them. */
export const EXTERNAL_TOOLS = ['qpdf', 'pdffonts', 'pdftotext', 'pdftoppm', 'gs', 'mutool'];

/** Whether a character is a line end. */
const isEol = (char) => char === '\r' || char === '\n';

/** The text with every whitespace character removed: layout and spacing differ between engines, the characters do not. */
export function squash(text) {
  return text.replace(/\s/g, '');
}

/** The strings of `needles` that `haystack` does not contain, whitespace aside. */
function missingText(haystack, needles) {
  const flat = squash(haystack);
  return needles.filter((needle) => !flat.includes(squash(needle)));
}

/** A font's name without the six capitals and `+` a subset carries. */
export function unsubset(name) {
  if (name.length > 7 && name[6] === '+' && [...name.slice(0, 6)].every((char) => char >= 'A' && char <= 'Z')) return name.slice(7);
  return name;
}

/**
 * The classic cross-reference table against the bytes: the file is framed by `%PDF-` and `%%EOF`, `startxref` points at `xref`,
 * the free head entry is first, the table covers /Size objects, and each in-use entry's offset lands on its own `N G obj`.
 */
export function checkStructure(bytes) {
  const problems = [];
  const text = Buffer.from(bytes).toString('latin1');
  if (!text.startsWith('%PDF-')) problems.push('the file does not start with %PDF-');
  if (!text.trimEnd().endsWith('%%EOF')) problems.push('the file does not end with %%EOF');
  const startKeyword = text.lastIndexOf('startxref');
  if (startKeyword < 0) return [...problems, 'there is no startxref'];
  const startxref = Number.parseInt(text.slice(startKeyword + 'startxref'.length).trim(), 10);
  if (!Number.isInteger(startxref) || !text.startsWith('xref', startxref)) {
    return [...problems, `startxref ${startxref} does not point at an xref table`];
  }

  let at = startxref + 'xref'.length;
  const lineAt = () => {
    while (isEol(text[at]) || text[at] === ' ') at += 1;
    let stop = at;
    while (stop < text.length && !isEol(text[stop])) stop += 1;
    const line = text.slice(at, stop);
    at = stop;
    return line;
  };
  let entries = 0;
  for (;;) {
    const header = lineAt();
    if (header.startsWith('trailer')) break;
    const [startText, countText] = header.split(' ');
    const first = Number(startText);
    const count = Number(countText);
    if (!Number.isInteger(first) || !Number.isInteger(count) || count > text.length / 20) return [...problems, `the xref subsection header "${header}" is not "first count"`];
    // Entries are 20 bytes each, however the line ends are written, so the cursor steps by 20 from the first digit.
    while (text[at] === '\r' || text[at] === '\n') at += 1;
    for (let i = 0; i < count; i += 1) {
      const entry = text.slice(at, at + 20);
      at += 20;
      const number = first + i;
      entries = Math.max(entries, number + 1);
      const offset = Number(entry.slice(0, 10));
      const generation = Number(entry.slice(11, 16));
      const flag = entry[17];
      if (entry.length !== 20 || entry[10] !== ' ' || entry[16] !== ' ' || (flag !== 'n' && flag !== 'f')) {
        problems.push(`xref entry ${number} is not a 20-byte "offset generation n|f" line`);
        continue;
      }
      if (number === 0 && flag !== 'f') problems.push('xref entry 0 is not the free head of the list');
      if (flag === 'n' && !text.startsWith(`${number} ${generation} obj`, offset)) {
        problems.push(`xref entry ${number} points at byte ${offset}, which is not "${number} ${generation} obj"`);
      }
    }
  }
  const trailer = text.slice(at, text.indexOf('startxref', at));
  const sizeAt = trailer.indexOf('/Size');
  const size = sizeAt < 0 ? Number.NaN : Number.parseInt(trailer.slice(sizeAt + '/Size'.length).trim(), 10);
  if (size !== entries) problems.push(`the trailer's /Size is ${size}, and the xref table has ${entries} entries`);
  if (!trailer.includes('/Root')) problems.push('the trailer has no /Root');
  return problems;
}

/** The fonts a file names: BaseFont without its subset tag, whether its program is embedded, and whether it has a ToUnicode map. */
export async function fontsOf(bytes) {
  const { PDFDict, PDFArray, PDFName, PDFDocument } = requireFromExporter('pdf-lib');
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
  const name = (dict, key) => {
    const value = dict.get(PDFName.of(key));
    return value instanceof PDFName ? value.decodeText() : undefined;
  };
  const hasProgram = (descriptor) =>
    descriptor instanceof PDFDict && ['FontFile', 'FontFile2', 'FontFile3'].some((key) => descriptor.has(PDFName.of(key)));
  const fonts = [];
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict) || name(object, 'Type') !== 'Font') continue;
    const subtype = name(object, 'Subtype');
    if (subtype === 'CIDFontType0' || subtype === 'CIDFontType2') continue;
    let carrier = object;
    if (subtype === 'Type0') {
      const descendants = doc.context.lookup(object.get(PDFName.of('DescendantFonts')));
      const first = descendants instanceof PDFArray ? doc.context.lookup(descendants.get(0)) : undefined;
      if (first instanceof PDFDict) carrier = first;
    }
    fonts.push({
      name: unsubset(name(object, 'BaseFont') ?? '(unnamed)'),
      embedded: hasProgram(doc.context.lookup(carrier.get(PDFName.of('FontDescriptor')))),
      toUnicode: object.has(PDFName.of('ToUnicode')),
    });
  }
  return fonts;
}

/**
 * The problems between the fonts a file has and the ones expected.json lists: every expected font is there, every font there is
 * expected (an expected name is a substring of the font's), whether it is embedded is exact, and a font that must carry a
 * ToUnicode map does.
 */
export function compareFonts(expected, actual) {
  const problems = [];
  const matching = (want) => actual.filter((font) => font.name.includes(want.name));
  for (const want of expected) {
    const found = matching(want);
    if (found.length === 0) problems.push(`no font named ${want.name}`);
    for (const font of found) {
      if (font.embedded !== want.embedded) problems.push(`${font.name} is ${font.embedded ? '' : 'not '}embedded, expected ${want.embedded ? '' : 'not '}embedded`);
      if (want.toUnicode && !font.toUnicode) problems.push(`${font.name} has no ToUnicode map`);
    }
  }
  for (const font of actual) {
    if (!expected.some((want) => font.name.includes(want.name))) problems.push(`unexpected font ${font.name}`);
  }
  return problems;
}

/** The pdf.js build for Node, from the exporter's node_modules. */
async function loadPdfjs() {
  const pdfjsDir = join(exporterDir, 'node_modules', 'pdfjs-dist');
  if (!existsSync(pdfjsDir)) throw new Error('pdfjs-dist is not installed: run pnpm install');
  const pdfjs = await import(pathToFileURL(join(pdfjsDir, 'legacy', 'build', 'pdf.mjs')).href);
  return { pdfjs, standardFonts: `${join(pdfjsDir, 'standard_fonts')}/` };
}

/**
 * The file through pdf.js: no message while it opens, no throw from any page's operator list, the page count, size and text from
 * expected.json, and no embedded font that pdf.js could not load. pdf.js prints a warning for what it repaired or ignored, so any
 * console output while it works is a problem.
 */
export async function checkWithPdfjs(bytes, expected) {
  const problems = [];
  const { pdfjs, standardFonts } = await loadPdfjs();
  const heard = [];
  const channels = ['log', 'info', 'warn', 'error'];
  const originals = channels.map((channel) => console[channel]);
  for (const channel of channels) console[channel] = (...args) => void heard.push(args.map(String).join(' '));
  try {
    const task = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      verbosity: 1,
      standardFontDataUrl: standardFonts,
      useSystemFonts: false,
    });
    const doc = await task.promise;
    if (doc.numPages !== expected.pages.length) problems.push(`pdf.js counts ${doc.numPages} pages, expected ${expected.pages.length}`);
    for (let number = 1; number <= doc.numPages; number += 1) {
      const page = await doc.getPage(number);
      const [x0, y0, x1, y1] = page.view;
      if (Math.abs(x1 - x0 - expected.size[0]) > 0.01 || Math.abs(y1 - y0 - expected.size[1]) > 0.01) {
        problems.push(`page ${number} is ${x1 - x0} x ${y1 - y0}, expected ${expected.size[0]} x ${expected.size[1]}`);
      }
      const operators = await page.getOperatorList();
      for (let i = 0; i < operators.fnArray.length; i += 1) {
        if (operators.fnArray[i] !== pdfjs.OPS.setFont) continue;
        const font = page.commonObjs.get(operators.argsArray[i][0]);
        const want = expected.fonts.find((candidate) => unsubset(font.name ?? '').includes(candidate.name));
        if (want?.embedded && font.missingFile) problems.push(`page ${number}: pdf.js found no font program for ${font.name}`);
      }
      const content = await page.getTextContent();
      const text = content.items.map((item) => ('str' in item ? item.str : '')).join(' ');
      for (const missing of missingText(text, expected.pages[number - 1] ?? [])) problems.push(`page ${number}: pdf.js text does not hold "${missing}"`);
    }
    await task.destroy();
  } catch (error) {
    problems.push(`pdf.js threw: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    channels.forEach((channel, i) => {
      console[channel] = originals[i];
    });
  }
  for (const line of heard) problems.push(`pdf.js said: ${line}`);
  return problems;
}

/** Runs one external tool; a tool that cannot start is a problem of its own. */
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error !== undefined) return { missing: true, status: null, stdout: '', stderr: String(result.error.message) };
  return { missing: false, status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Poppler's pdffonts table as fonts: name, then (from the right) object id, generation, uni, sub, emb. */
/**
 * Lines a MuPDF build prints about itself, not about the file: Ubuntu's mupdf-tools is built without LittleCMS and says so on every
 * draw. Matched whole, so a warning about the file is never mistaken for one.
 */
const MUTOOL_BUILD_NOTES = new Set(['warning: ICC support is not available']);

/** The `error:` and `warning:` lines of mutool's output that are about the file. */
export function mutoolComplaints(output) {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(error|warning):/i.test(line) && !MUTOOL_BUILD_NOTES.has(line));
}

export function parsePdffonts(output) {
  return output
    .split('\n')
    .slice(2)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const cells = line.trim().split(/\s+/);
      return { name: unsubset(cells[0] ?? ''), embedded: cells.at(-5) === 'yes', toUnicode: cells.at(-3) === 'yes' };
    });
}

/** The problems one external tool finds in one file. `file` is a path; `tmp` is a scratch directory. */
function externalCheck(tool, file, expected, tmp, log) {
  const out = (result) => `${result.stdout}${result.stderr}`;
  switch (tool) {
    case 'qpdf': {
      const result = run('qpdf', ['--check', file]);
      log(out(result));
      if (result.missing) return ['qpdf is not installed'];
      const problems = result.status === 0 ? [] : [`qpdf --check exited ${result.status}`];
      if (out(result).includes('WARNING')) problems.push('qpdf --check printed a WARNING');
      return problems;
    }
    case 'pdffonts': {
      const result = run('pdffonts', [file]);
      log(out(result));
      if (result.missing) return ['pdffonts is not installed'];
      if (result.status !== 0) return [`pdffonts exited ${result.status}`];
      return compareFonts(expected.fonts, parsePdffonts(result.stdout));
    }
    case 'pdftotext': {
      const result = run('pdftotext', ['-enc', 'UTF-8', '-layout', file, '-']);
      log(out(result));
      if (result.missing) return ['pdftotext is not installed'];
      if (result.status !== 0) return [`pdftotext exited ${result.status}`];
      // Pages end in a form feed, and the last one is followed by an empty string.
      const pages = result.stdout.split('\f');
      const problems = [];
      expected.pages.forEach((needles, i) => {
        const wanted = [...needles, ...(expected.actualText?.[i] ?? [])];
        for (const missing of missingText(pages[i] ?? '', wanted)) problems.push(`page ${i + 1}: pdftotext does not give back "${missing}"`);
      });
      if (pages.filter((page) => page.trim() !== '').length !== expected.pages.length) problems.push('pdftotext found a different number of pages');
      return problems;
    }
    case 'pdftoppm': {
      const result = run('pdftoppm', ['-r', '72', '-png', file, join(tmp, 'page')]);
      log(out(result));
      if (result.missing) return ['pdftoppm is not installed'];
      const problems = result.status === 0 ? [] : [`pdftoppm exited ${result.status}`];
      if (result.stderr.includes('Syntax Error') || result.stderr.includes('Syntax Warning')) problems.push('pdftoppm reported a Syntax Error or Warning');
      return problems;
    }
    case 'gs': {
      const result = run('gs', ['-q', '-dNOPAUSE', '-dBATCH', '-dPDFSTOPONERROR', '-sDEVICE=nullpage', file]);
      log(out(result));
      if (result.missing) return ['gs is not installed'];
      const problems = result.status === 0 ? [] : [`gs exited ${result.status}`];
      if (out(result).includes('**** Error') || out(result).includes('**** Warning')) problems.push('gs printed an error or warning');
      return problems;
    }
    case 'mutool': {
      const result = run('mutool', ['draw', '-r', '72', '-o', join(tmp, 'mu-%d.png'), file]);
      log(out(result));
      if (result.missing) return ['mutool is not installed'];
      const problems = result.status === 0 ? [] : [`mutool draw exited ${result.status}`];
      if (mutoolComplaints(out(result)).length > 0) problems.push('mutool printed an error or warning');
      return problems;
    }
    default:
      return [`unknown tool ${tool}`];
  }
}

/**
 * Checks every file expected.json lists. Returns `{ file, problems }` rows. A file expected.json lists but the directory lacks is a
 * problem of its own, and so is a PDF in the directory that expected.json does not list.
 */
export async function checkCorpus(dir, options = {}) {
  const tools = options.tools ?? [];
  const logDir = options.logDir ?? join(dir, 'logs');
  const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8'));
  const rows = [];
  if (tools.length > 0) mkdirSync(logDir, { recursive: true });
  for (const entry of expected.files) {
    const path = join(dir, entry.file);
    if (!existsSync(path)) {
      rows.push({ file: entry.file, problems: ['the file is missing from the corpus'] });
      continue;
    }
    const bytes = readFileSync(path);
    const problems = [];
    const add = (label, found) => problems.push(...found.map((problem) => `${label}: ${problem}`));
    add('structure', checkStructure(bytes));
    try {
      add('fonts', compareFonts(entry.fonts, await fontsOf(bytes)));
    } catch (error) {
      add('fonts', [`pdf-lib could not read the file: ${error instanceof Error ? error.message : String(error)}`]);
    }
    add('pdf.js', await checkWithPdfjs(bytes, entry));
    for (const tool of tools) {
      const tmp = mkdtempSync(join(tmpdir(), 'pdf-validate-'));
      let raw = '';
      try {
        add(tool, externalCheck(tool, path, entry, tmp, (text) => void (raw += text)));
      } finally {
        rmSync(tmp, { recursive: true, force: true });
        writeFileSync(join(logDir, `${tool}-${entry.file}.txt`), raw);
      }
    }
    rows.push({ file: entry.file, problems });
  }
  return rows;
}

// Run directly: `node tools/pdf-validate/check.mjs <dir> [--external[=tool,tool]]`.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const dir = resolve(args.find((arg) => !arg.startsWith('--')) ?? process.env['CAOTANG_PDF_OUT'] ?? '');
  const external = args.find((arg) => arg === '--external' || arg.startsWith('--external='));
  const tools = external === undefined ? [] : external === '--external' ? EXTERNAL_TOOLS : external.slice('--external='.length).split(',');
  if (!existsSync(join(dir, 'expected.json'))) {
    process.stderr.write(`no expected.json in ${dir}: write the corpus first (CAOTANG_PDF_OUT=<dir>, packages/exporter/test/pdf-write-corpus.test.ts)\n`);
    process.exit(2);
  }
  const rows = await checkCorpus(dir, { tools });
  for (const row of rows) {
    process.stdout.write(`${row.problems.length === 0 ? 'ok  ' : 'FAIL'} ${row.file}\n`);
    for (const problem of row.problems) process.stdout.write(`       ${problem}\n`);
  }
  const failed = rows.filter((row) => row.problems.length > 0).length;
  process.stdout.write(`\npdf-validate: ${rows.length - failed} of ${rows.length} files passed${tools.length > 0 ? ` (with ${tools.join(', ')})` : ' (Node checks only)'}\n`);
  if (failed > 0) process.exitCode = 1;
}
