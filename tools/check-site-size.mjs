#!/usr/bin/env node
/**
 * The landing page's size gate: reads the built site (site/dist, from tools/build-site.mjs) and fails when it grew past what was accepted.
 *
 * Run: `node tools/check-site-size.mjs [dir]` after `node tools/build-site.mjs` (dir defaults to site/dist). CI runs it right after the
 * site build. It prints every file with its raw and gzip size, by kind, then exits 1 on any of:
 *   - any JavaScript at all: a .js, .mjs or .cjs file, a <script> other than the JSON-LD data block, or a modulepreload link. The page
 *     runs no script (its CSP says `script-src 'none'`), so the JS budget is 0 bytes;
 *   - the HTML (index.html, with the product pictures rendered into it) over BUDGET.html;
 *   - the CSS (landing.css, stages.css and kit/stageshow.css together) over BUDGET.css;
 *   - the assets (every other file: the export page picture, the wallpapers, the favicon, llms.txt, the notices) over BUDGET.assets.
 *
 * tools/check-bundle-size.mjs is the app's gate (apps/desktop/dist); this one covers caotang.app/ only.
 *
 * The caps are the build of #359 (the Modern landing with five Stageshow stills and the hero) plus about 10%, so growing the page by
 * more is a decision written down in the change that does it. Measured on that build, in bytes (raw / gzip):
 *   html 102,288 / 16,126; css 62,863 / 15,897 (landing 12,852, stages 17,740, kit 32,271 raw); assets 28,516 / 19,596.
 * To raise a number: build, run this, put the new size plus the margin in BUDGET, and say why in the change.
 *
 * Sizes are bytes in the file and zlib's default gzip; 1 kB is 1000 bytes.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

/** The limits, in bytes. */
export const BUDGET = {
  html: { raw: 112_000, gzip: 17_700 },
  css: { raw: 69_000, gzip: 17_400 },
  assets: { raw: 31_400, gzip: 22_300 },
  js: { raw: 0, gzip: 0 },
};

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dir = resolve(root, process.argv[2] ?? 'site/dist');

if (!existsSync(join(dir, 'index.html'))) {
  console.error(`check-site-size: no ${relative(root, dir) || dir}/index.html; run \`node tools/build-site.mjs\` first.`);
  process.exit(1);
}

/** Every file under the site, as a path relative to it. */
function walk(at, out = []) {
  for (const name of readdirSync(at)) {
    const path = join(at, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(relative(dir, path));
  }
  return out.sort();
}

const kindOf = (file) => {
  const ext = extname(file).toLowerCase();
  if (ext === '.html') return 'html';
  if (ext === '.css') return 'css';
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'js';
  return 'assets';
};

const kB = (bytes) => `${(bytes / 1000).toFixed(1)} kB`;
const totals = { html: { raw: 0, gzip: 0 }, css: { raw: 0, gzip: 0 }, assets: { raw: 0, gzip: 0 }, js: { raw: 0, gzip: 0 } };
const failures = [];

for (const file of walk(dir)) {
  const bytes = readFileSync(join(dir, file));
  const raw = bytes.length;
  const gzip = gzipSync(bytes).length;
  const kind = kindOf(file);
  totals[kind].raw += raw;
  totals[kind].gzip += gzip;
  console.log(`${kind.padEnd(7)} ${file.padEnd(28)} ${kB(raw).padStart(9)} raw ${kB(gzip).padStart(9)} gzip`);
  if (kind === 'js') failures.push(`${file} is JavaScript; the landing page ships none (its CSP is script-src 'none')`);
}

// Script that rides in the page itself rather than in a file.
for (const file of walk(dir).filter((f) => kindOf(f) === 'html')) {
  const html = readFileSync(join(dir, file), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)].filter((m) => !/type="application\/ld\+json"/i.test(m[1]));
  if (scripts.length) failures.push(`${file} has ${scripts.length} script element(s); only the JSON-LD data block is allowed`);
  if (/<link\b[^>]*rel="modulepreload"/i.test(html)) failures.push(`${file} preloads a module`);
  if (/<[^>]+\son[a-z]+="/i.test(html)) failures.push(`${file} has an inline event handler`);
}

console.log('');
for (const kind of ['html', 'css', 'assets', 'js']) {
  const { raw, gzip } = totals[kind];
  const cap = BUDGET[kind];
  console.log(`${kind.padEnd(7)} ${kB(raw).padStart(9)} raw (cap ${kB(cap.raw)}) ${kB(gzip).padStart(9)} gzip (cap ${kB(cap.gzip)})`);
  if (raw > cap.raw) failures.push(`${kind}: ${raw} bytes raw, over its cap of ${cap.raw}`);
  if (gzip > cap.gzip) failures.push(`${kind}: ${gzip} bytes gzip, over its cap of ${cap.gzip}`);
}

if (failures.length) {
  console.error(`\ncheck-site-size: ${failures.length} problem(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\ncheck-site-size: within budget, no JavaScript');
