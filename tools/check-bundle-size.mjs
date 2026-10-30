#!/usr/bin/env node
/**
 * The bundle-size gate: reads the desktop build and fails when it grew past what the owner accepted.
 *
 * Run: `node tools/check-bundle-size.mjs [dist]` after `pnpm build` (dist defaults to apps/desktop/dist). CI runs it right after the
 * build. It prints every JS chunk with its raw and gzip size, and what loads at start, then exits 1 on any of:
 *   - a chunk over BUDGET.chunkLimit that is not on BUDGET.allow;
 *   - a chunk over its own cap on BUDGET.allow (fontkit is one library, already loaded only for CJK and emoji text, so it has 750 kB);
 *   - an allow-list entry whose chunk has fallen under the limit or gone, so a split is never left covered by an old exception;
 *   - the first load (the module script and the modulepreload links in index.html) over BUDGET.initialGzip;
 *   - all JS over BUDGET.totalJs.
 *
 * Vite's own "chunks are larger than 500 kB" warning is turned down to the highest cap (apps/desktop/vite.config.ts), because it names
 * no chunk's reason and moves for no one; this script is the gate. The numbers live in BUDGET below. Everything except the 500 kB
 * limit and fontkit's 750 kB is the size of a real build plus about 5%, so a change that grows the app by more than that is a decision
 * somebody makes and writes down, in the change that does it. To raise a number: build, run this, put the new size plus the margin in
 * BUDGET, and say why in the change. To split a chunk: remove its entry when the script says it is no longer needed.
 *
 * Sizes are bytes in the file and zlib's default gzip; 1 kB is 1000 bytes, as Vite counts.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

/** The limits, in bytes. */
export const BUDGET = {
  /** A JS chunk over this must be on the allow-list. */
  chunkLimit: 500_000,
  /**
   * Chunks allowed over the limit, by chunk name (the file name without its hash), each with its own cap.
   * `fontkit.es` is one indivisible library, already loaded only for CJK and emoji text in a PDF. `index` is debt: the entry (the app,
   * the agent harness and gateway, the exporters, the coherence checks and the stores). It is capped a little above what it measured,
   * so a feature that adds to the entry is a deliberate cap change here rather than a surprise; the cap comes down as the rest is split
   * (#31). The Ink compiler (`ink-full`, 244 kB) loads when a project holds a dialogue container, which took the shared `src` chunk
   * under the limit, so `src` has no entry any more.
   */
  // The entry measured 1,419.9 kB with the agent trace store, the Trace tab and the trace export (Wave 19); its cap was 1,450 kB.
  // 1,458.6 kB measured with macros (#57): the bus's macro reader, the harness's checkMacro and expandMacro, the store's commands and loader, and the
  // Save as macro dialog with its model; the cap is that plus about 1%. The Macros panel is in the Settings chunk.
  // 1,481.1 kB measured with macros (#57), the prompt-injection guards (#54) and the export Preview (#106) together, on top of main's wave 20 review fixes; the cap is that plus about 1%.
  allow: {
    'fontkit.es': 750_000,
    // 1,495.9 kB measured with the narrow layout (#18) and external-call progress (#79) together, on top of wave 22; the cap is that plus about 1%.
    // 1,516.6 kB measured with the result schemas of every callable row (#58), whose specs the registry builds at start; the cap is that plus about 1%.
    // 1,532.9 kB measured with those and hooks (#59) together: the bus's hook reader and commands, the store's loader and serializer, the harness's runner and
    // its checks, and the plan card's hook line, which put the entry 0.9 kB over the old cap; the cap is that plus about 1%.
    index: 1_549_000,
  },
  /** The first load, gzip: the entry chunk and the chunks index.html loads with it. */
  // 772.4 kB measured with Colour emoji, against 769.1 kB before it; 779.3 kB with Colour emoji and Agent rules together (Wave 14); 786.4 kB with the agent run log and resume.
  // 810.0 kB measured with the instructions layer, the agent files and recurring tasks (Wave 17).
  // 831.2 kB measured with the restore planner and rewind menus (#53) and the host-model rows (#81) together; the ceiling is that plus about 1%.
  // 840.2 kB measured with macros (#57); 847.8 kB measured with macros, the injection guards and the export Preview together on top of wave 20's fixes,
  // which left 0.2 kB under the old 848.0 kB ceiling, so it is raised to that plus about 1%.
  // 858.2 kB measured with the result schemas (#58); the ceiling is that plus about 1%.
  // 867.7 kB measured with the planner's cut-reply handling (#97): the loop's cut words and retry, and the plan card's cut-reply note,
  // which put the first load 0.7 kB over the old 867.0 kB ceiling, so it is raised to that plus about 1%.
  // The input-method guard in every Enter handler and the keymap (#188) adds about 0.05 kB on top; the 876.0 kB ceiling covers both.
  initialGzip: 876_000,
  /** All JS, raw. */
  // 5,168.5 kB measured with upstream fontkit 2.0.4 (browser-module, 356 kB, loaded on use for Devanagari text) and the Indic shaper, which is
  // about 280 kB of it; the ceiling is that plus about 5%. 5,824.3 kB measured with Cousine Regular (396 kB, loaded on use for the screenplay PDF font choice, #19).
  // 5,902.2 kB measured with the instructions layer, the agent files and recurring tasks (Wave 17).
  // 5,975.3 kB measured with the restore planner and the step and conversation rewind menus (#53) and the four host-model rows (#81) together; the
  // app carries the host-model rows' registry metadata, params and preflights and none of their ports, which only the MCP server builds.
  // 6,036.1 kB measured with those and macros (#57), the prompt-injection guards (#54) and the export Preview (#106) together; the ceiling is that plus about 0.6%.
  // 6,076.1 kB measured with the narrow layout (#18): its model, notice and hook, the drawer, sheet and More menu in the workspace, and the row Actions button; the ceiling is that plus about 1%.
  totalJs: 6_140_000,
};

const KB = 1000;

/** A size in kB, one decimal. */
function kb(bytes) {
  return (bytes / KB).toFixed(1);
}

/** A chunk's name: its file name without the extension and the 8-character hash Vite appends (`fontkit.es-B1-xruQ9.js` is `fontkit.es`). */
export function chunkName(file) {
  const base = file.endsWith('.js') ? file.slice(0, -3) : file;
  return base.length > 9 && base[base.length - 9] === '-' ? base.slice(0, -9) : base;
}

/** The value of an attribute in a tag's text, or undefined. */
function attribute(tag, name) {
  for (const quote of ['"', "'"]) {
    const needle = ` ${name}=${quote}`;
    const start = tag.indexOf(needle);
    if (start === -1) continue;
    const from = start + needle.length;
    const end = tag.indexOf(quote, from);
    if (end !== -1) return tag.slice(from, end);
  }
  return undefined;
}

/** The JS files index.html loads at start: the module script and the modulepreload links, by file name, in the order the page lists them. */
export function initialFilesOf(html) {
  const files = [];
  let at = 0;
  while ((at = html.indexOf('<', at)) !== -1) {
    if (html.startsWith('<!--', at)) {
      const end = html.indexOf('-->', at + 4);
      if (end === -1) break;
      at = end + 3;
      continue;
    }
    const close = html.indexOf('>', at);
    if (close === -1) break;
    const tag = html.slice(at + 1, close).replaceAll('\n', ' ').replaceAll('\r', ' ').replaceAll('\t', ' ');
    at = close + 1;
    const spaced = ` ${tag}`;
    const isScript = tag.startsWith('script ') && attribute(spaced, 'type') === 'module';
    const isPreload = tag.startsWith('link ') && attribute(spaced, 'rel') === 'modulepreload';
    const url = isScript ? attribute(spaced, 'src') : isPreload ? attribute(spaced, 'href') : undefined;
    if (url !== undefined) files.push(url.slice(url.lastIndexOf('/') + 1));
  }
  return files;
}

/**
 * Measures the chunks against the budget. `chunks` are `{ file, bytes, gzip }`; `initial` are the file names the first load fetches.
 * Returns the rows (largest first), the first load's gzip size, the total JS, and the problems.
 */
export function analyse(chunks, initial, budget = BUDGET) {
  const problems = [];
  const first = new Set(initial);
  const rows = [...chunks]
    .sort((a, b) => b.bytes - a.bytes || (a.file < b.file ? -1 : 1))
    .map((chunk) => {
      const name = chunkName(chunk.file);
      return { chunk, name, initial: first.has(chunk.file), cap: budget.allow[name] };
    });

  for (const { chunk, cap } of rows) {
    if (cap === undefined) {
      if (chunk.bytes > budget.chunkLimit) {
        problems.push(
          `${chunk.file} is ${kb(chunk.bytes)} kB, over the ${kb(budget.chunkLimit)} kB chunk limit and not on the allow-list: load it on use, split it, or add it to BUDGET.allow with the reason`,
        );
      }
    } else if (chunk.bytes > cap) {
      problems.push(`${chunk.file} is ${kb(chunk.bytes)} kB, over its allow-list cap of ${kb(cap)} kB`);
    }
  }

  for (const name of Object.keys(budget.allow)) {
    const named = rows.filter((row) => row.name === name);
    if (named.length === 0) {
      problems.push(`"${name}" is on the allow-list but no chunk has that name: remove the entry, or rename it to the chunk's new name`);
    } else if (named.every((row) => row.chunk.bytes <= budget.chunkLimit)) {
      const size = Math.max(...named.map((row) => row.chunk.bytes));
      problems.push(`"${name}" is on the allow-list but its chunk is ${kb(size)} kB, under the ${kb(budget.chunkLimit)} kB limit: remove the entry`);
    }
  }

  const known = new Set(chunks.map((chunk) => chunk.file));
  for (const file of initial) {
    if (!known.has(file)) problems.push(`index.html loads ${file}, which is not in the build`);
  }

  const initialGzip = rows.filter((row) => row.initial).reduce((sum, row) => sum + row.chunk.gzip, 0);
  if (initialGzip > budget.initialGzip) {
    problems.push(`the first load is ${kb(initialGzip)} kB gzip, over the ${kb(budget.initialGzip)} kB budget`);
  }
  const totalJs = rows.reduce((sum, row) => sum + row.chunk.bytes, 0);
  if (totalJs > budget.totalJs) {
    problems.push(`all JS is ${kb(totalJs)} kB, over the ${kb(budget.totalJs)} kB ceiling`);
  }
  return { rows, initialGzip, totalJs, problems };
}

/** The report as a table, then the totals and the problems, if any. */
export function renderReport(report) {
  const lines = [['chunk', 'raw kB', 'gzip kB', 'loads']];
  for (const { chunk, initial, cap } of report.rows) {
    const when = initial ? 'first load' : 'on use';
    lines.push([chunk.file, kb(chunk.bytes), kb(chunk.gzip), cap === undefined ? when : `${when} (cap ${kb(cap)})`]);
  }
  const widths = [0, 1, 2].map((column) => Math.max(...lines.map((line) => line[column].length)));
  const table = lines.map((line) =>
    [line[0].padEnd(widths[0]), line[1].padStart(widths[1]), line[2].padStart(widths[2]), line[3]].join('  ').trimEnd(),
  );
  const firstLoad = report.rows.filter((row) => row.initial);
  const firstRaw = firstLoad.reduce((sum, row) => sum + row.chunk.bytes, 0);
  const out = [
    ...table,
    '',
    `first load: ${firstLoad.length} files, ${kb(firstRaw)} kB raw, ${kb(report.initialGzip)} kB gzip`,
    `all JS: ${report.rows.length} files, ${kb(report.totalJs)} kB raw`,
  ];
  if (report.problems.length === 0) {
    out.push('bundle size: ok');
  } else {
    out.push('', ...report.problems.map((problem) => `- ${problem}`), '', 'bundle size: FAILED');
  }
  return out.join('\n');
}

/** Reads `<dist>/index.html` and `<dist>/assets/*.js`. */
export function readBuild(dist) {
  const html = join(dist, 'index.html');
  const assets = join(dist, 'assets');
  if (!existsSync(html) || !existsSync(assets)) {
    throw new Error(`no build in ${dist}: run pnpm build first`);
  }
  const chunks = readdirSync(assets)
    .filter((file) => file.endsWith('.js'))
    .map((file) => {
      const bytes = readFileSync(join(assets, file));
      return { file, bytes: bytes.length, gzip: gzipSync(bytes).length };
    });
  return { chunks, initial: initialFilesOf(readFileSync(html, 'utf8')) };
}

// Run directly: `node tools/check-bundle-size.mjs [dist]`.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const dist = resolve(process.argv[2] ?? join(fileURLToPath(new URL('..', import.meta.url)), 'apps', 'desktop', 'dist'));
  const build = readBuild(dist);
  const report = analyse(build.chunks, build.initial);
  process.stdout.write(`${renderReport(report)}\n`);
  if (report.problems.length > 0) process.exitCode = 1;
}
