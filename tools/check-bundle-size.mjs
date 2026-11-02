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
 *   - all JS over BUDGET.totalJs;
 *   - a lazy chunk on BUDGET.lazy over its own raw cap, missing from the build, or in the first load (Modern's `modern-shell`,
 *     modern-interface.md §12, loads only while Modern is on);
 *   - the entry stylesheet (the stylesheet links in index.html) more than BUDGET.css.entryMargin over BUDGET.css.entry, or a lazy
 *     stylesheet over its cap on BUDGET.css.caps (Modern's, 62 kB raw);
 *   - "Modern first load" (the first load plus `modern-shell`'s JS and CSS, gzip) more than BUDGET.modernFirstLoadDelta over Classic's
 *     first load.
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
   * `fontkit.es` is one indivisible library, already loaded only for CJK and emoji text in a PDF. `index` is debt: the entry (the app shell,
   * gateway, coherence checks and stores; the agent harness and exporters load on use after PR #147). It is capped a little above what it measured,
   * so a feature that adds to the entry is a deliberate cap change here rather than a surprise; the cap comes down as the rest is split
   * (#31). The Ink compiler (`ink-full`, 244 kB) loads when a project holds a dialogue container, which took the shared `src` chunk
   * under the limit, so `src` has no entry any more.
   *
   * **I3 (#193) raised `index` and `initialGzip` for the compiled English catalogue and the Lingui runtime**, which must be in the
   * entry before the first paint (i18n.md §3.3, §3.5). Measured on the final I3 build: `index` 1,270.8 kB raw / 382.8 kB gzip (from
   * 1,262.0 / 379.3 at I2), first load 769.2 kB gzip (from 765.7). The installed `en` catalogue is 25 bytes of compiled data; the rest
   * is the about 3.5 kB gzip of runtime. No non-English catalogue ships in I3, so there is **no locale chunk to measure** yet: each
   * later locale is its own lazy chunk and its size is recorded when it ships.
   *
   * **I5 (#196) raised `index` for the shell, home and Settings conversion.** The English source catalogue grew from the I3/I4 witness
   * set to 622 messages; the converted surfaces' English text is in the entry catalogue because every screen renders from it before a
   * paint. Measured on the L6 build: `index` 1,340.0 kB raw / 403.5 kB gzip. The cap is that measurement plus about 5%:
   * 1,339,957 bytes × 1.05 = 1,406,954.85, rounded down to the thousand as I3 did, = 1,406,000. The first load (795.3 kB gzip) and all
   * JS (5,397.5 kB raw) stayed under their existing caps, so neither moved. I6's catalogue growth carries the same measurement and
   * margin obligation.
   */
  // The entry measured 1,419.9 kB with the agent trace store, the Trace tab and the trace export (Wave 19); its cap was 1,450 kB.
  // 1,458.6 kB measured with macros (#57): the bus's macro reader, the harness's checkMacro and expandMacro, the store's commands and loader, and the
  // Save as macro dialog with its model; the cap is that plus about 1%. The Macros panel is in the Settings chunk.
  // 1,481.1 kB measured with macros (#57), the prompt-injection guards (#54) and the export Preview (#106) together, on top of main's wave 20 review fixes; the cap is that plus about 1%.
  // PR side before the merge: I6's catalogue growth, measured bytes plus 5%, rounded up to 1,000; owner-approved basis in i18n.md §3.5.
  allow: {
    'fontkit.es': 750_000,
    // 1,495.9 kB measured with the narrow layout (#18) and external-call progress (#79) together, on top of wave 22; the cap is that plus about 1%.
    // 1,516.6 kB measured with the result schemas of every callable row (#58), whose specs the registry builds at start; the cap is that plus about 1%.
    // 1,532.9 kB measured with those and hooks (#59) together: the bus's hook reader and commands, the store's loader and serializer, the harness's runner and
    // its checks, and the plan card's hook line, which put the entry 0.9 kB over the old cap; the cap is that plus about 1%.
    // 1,549.2 kB measured with prompt caching (#86): the gateway's cache parts, policy and per-provider markers, the assembler's per-layer
    // parts and cache boundary, the harness's cache watch and the Settings switch, on top of main's context limits (#254), which put the
    // entry 0.2 kB over the old cap; the cap is that plus about 1%.
    // 1,565.0 kB measured with the FDX tree reader (#264) on top of the interface setting (#314), 22 bytes under the old cap; the FDX reader
    // adds about 1 kB here (the rest of it is in the locale chunk); the cap is that plus about 1%.
    // 1,133.8 kB measured on the merge of main into #322 (2026-10-31): #322 adds pictures, timelines, comics and i18n. The entry is
    // smaller than main's 1,565.0 kB because #322's lazy harness and exporters keep the agent loop, the run log and the export
    // pipelines out of it; the editor's projection and paste pipeline that main's agent chunk shared are in it now. The cap is that
    // plus about 1%, rounded up to the thousand.
    // 1,190.7 kB measured on the merge of main c69b6ff7 into #322 (2026-11-01): main's work since the last merge (#317 import core,
    // #321 FDX import, #327 script settings, #331 tokens, #333 the shared import preview dialog, #330 the shell actions and Classic
    // shell, #329 the plain-text reader, #320 footnotes in the editor) is in the entry, beside #322's own review fixes. The cap is that
    // plus about 1%, rounded up to the thousand.
    index: 1_203_000,
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
  // 877.5 kB measured with the picture registry (#152): the asset records, the backfill on open and the use scan, with the import
  // pipeline and metadata strip loaded on first import; the ceiling is that plus about 1%.
  // 887.3 kB measured with the FDX tree reader, its report and the Import script dialog (#264), 2.4 kB over main's 884.9 kB, which put
  // the first load 1.3 kB over the old 886.0 kB ceiling (the FDX importer already sat in the first load through the store's
  // screenplay.import); the ceiling is that plus about 1%.
  // 891.6 kB measured with the codex batch import (#273) on top of that: `codex.importBatch`'s descriptor (its pre-validation of up to
  // 5,000 entries and their Research pages, with a refusal per failing entry) is in the registry the app builds at start and lands in
  // the first-load locale chunk; the ceiling is that plus about 1%.
  // PR side before the merge: 848,000 (PR #147's deep lazy-load pass brought first load to 824.0 kB gzip).
  // 1,005.0 kB measured on the merge of main into #322 (2026-10-31): #322 adds pictures, timelines, comics and i18n (the English
  // catalogue and the Lingui runtime are in the entry) on top of main's 891.6 kB. The agent loop and the run log stay lazy: the
  // Settings prompt preview takes scene.draft's task from the harness's agent/scene-task.ts, not from the loop. Main's macro check
  // (the tool table) and the tool registry stay in the first load, as on main. The ceiling is that plus about 1%, rounded up to the thousand.
  // 1,018.9 kB measured with Import plain text… and Import RTF… on the splitter source (#267, #283, #274), against 1,015.9 kB on main.
  // The readers, the splitter and the preview's sources are lazy chunks (text-source 2.8, rtf-source 11.6, splitter-source 14.0 kB
  // gzip, on use); the first load grows by the compiled English catalogue (+2.5 kB gzip for the preview's 118 new rule, split, check
  // and notice messages, which must be in the entry before the first paint, i18n.md §3.3) and the two binder buttons with their
  // loaders (+0.4 kB). Main left 0.1 kB of room, so localising the preview could not fit; the ceiling is that plus about 1%,
  // rounded up to the thousand.
  
  // 1,016.1 kB (1,016,124 bytes) measured with the editor's footnote words localised (#337): the labels port's footnote names, `setLabels` and the
  // decorations that rename the markers and notes of an open editor on a language switch, which put the first load about 0.1 kB over
  // the old 1,016.0 kB ceiling. The ceiling is that plus about 1%, rounded up to the thousand.
  initialGzip: 1_030_000,
  /** All JS, raw. */
  // 5,168.5 kB measured with upstream fontkit 2.0.4 (browser-module, 356 kB, loaded on use for Devanagari text) and the Indic shaper, which is
  // about 280 kB of it; the ceiling is that plus about 5%. 5,824.3 kB measured with Cousine Regular (396 kB, loaded on use for the screenplay PDF font choice, #19).
  // 5,902.2 kB measured with the instructions layer, the agent files and recurring tasks (Wave 17).
  // 5,975.3 kB measured with the restore planner and the step and conversation rewind menus (#53) and the four host-model rows (#81) together; the
  // app carries the host-model rows' registry metadata, params and preflights and none of their ports, which only the MCP server builds.
  // 6,036.1 kB measured with those and macros (#57), the prompt-injection guards (#54) and the export Preview (#106) together; the ceiling is that plus about 0.6%.
  // 6,076.1 kB measured with the narrow layout (#18): its model, notice and hook, the drawer, sheet and More menu in the workspace, and the row Actions button; the ceiling is that plus about 1%.
  // 6,137.5 kB measured on main at #252, 2.5 kB under that ceiling, with eight feature PRs in flight (#175, #209, #86, #69, #106, #152, #192, #253)
  // that each add a few kB of app code; the ceiling is raised once to the measured size plus about 1% so each PR is not trimmed to fit.
  // 6,202.0 kB measured with this batch merged (#254, #255, #257, #258, #259, #261, #262) and the story parts (#175); the ceiling is that plus about 1%.
  // The shared import readers (#268) are lazy chunks and leave the caps as they are: `xml` is 1.7 kB raw, 1.0 kB gzip, measured after #264 merged (the XML decoder
  // the Final Draft import loads on use; the entry grew 0.5 kB raw for its loader and refusal handling). Measured standalone, minified, the whole XML reader is 14.1 kB
  // (4.5 kB gzip) and the archive reader 8.5 kB (3.4 kB gzip) without fflate, which is already its own chunk; each lands in this table as the
  // importers that use it are built (#263).
  // PR side before the merge: the feature/library total measured 6,563.1 kB with no duplicated modules; the owner approved its
  // measurement plus 5% (2026-10-30): 6,892,000. Main's side was 6,265,000.
  // 7,496.5 kB measured on the merge of main into #322 (2026-10-31): #322 adds pictures, timelines, comics and i18n to main's features
  // (the German catalogue, the comic lettering fonts and the pictures pipeline are lazy chunks). The ceiling is that plus about 1%,
  // rounded up to the thousand.
  // 7,578.3 kB measured on the merge of main c69b6ff7 into #322 (2026-11-01), with the same main work as the entry above (the footnote
  // nodes and their editor plugin, the import preview, the FDX and plain-text readers). The ceiling is that plus about 1%, rounded up
  // to the thousand.
  // 7,671.1 kB measured with Import plain text… and Import RTF… (#267, #283, #274), against 7,579.2 kB on main: the splitter source
  // with import-core (38.0 kB), the RTF reader and its source (31.7 kB), the plain-text reader and its source (6.2 kB), all loaded on
  // use, and the English and German catalogues' new messages (6.6 and 7.3 kB). The ceiling is that plus about 1%, rounded up to the
  // thousand.
  // 7,684.2 kB measured with the Modern stage, page and materials (#305): the `modern-shell` chunk (4.5 kB raw, loaded only while
  // Modern is on) and the entry's interface store, Shell frame and Appearance switches. The ceiling rises once, by the Modern chunk's
  // measured size rounded up to the thousand (modern-interface.md §12): 7,748,000 + 5,000.
  // 7,754.4 kB measured on the merge of #351 (focus mode, Show in Findings) into #312 (the narrow layout): narrow layout + focus mode,
  // #312/#351; Classic unchanged. Both are lazy chunks (`narrow-panels`, `focus-mode`) and the slots they touch; Classic's first load
  // did not move. The ceiling is that plus about 0.6 kB.
  // Stageshow polish wave 2 (#360–#364), approved by Caspar 2026-11-02. #363 alone measured 7,755,027 bytes (+535 on 7,754,492: the
  // Modern folds, Add a provider, and interface.ts moving from the entry into the `shared` chunk).
  // With #364 merged on #363: 7,755,060 bytes measured.
  // #361 (the write surfaces) merged on #363 and #364: 7,756,925 bytes measured; the ceiling stays 7,760,000.
  totalJs: 7_760_000,
  /**
   * Named lazy chunks with a raw cap each, that must exist and must not be in the first load (modern-interface.md §12). `modern-shell`
   * is Modern's JS (ModernShell, the stage, the page, later the ornaments, sidebar, popovers, palette and companion): target 60 kB, cap
   * 70 kB. 4.5 kB raw, 1.8 kB gzip measured at #305.
   */
  lazy: { 'modern-shell': 70_000 },
  css: {
    /**
     * The entry stylesheet (index.html's stylesheet links), raw, as measured: 105,500 bytes at #305, which added nothing to it (Modern's
     * styles are in its own chunk). It may grow by `entryMargin` (1%) before the number here has to move with a reason.
     */
    entry: 105_500,
    entryMargin: 0.01,
    /** Lazy stylesheets by chunk name, raw. Modern's (tokens/modern.css and shell-modern.css): 12.3 kB raw, 2.7 kB gzip at #305. */
    // Stageshow polish #357: the Modern control kit (controls-modern.css: buttons, fields, selects, checks, radios, switches, segmented,
    // disclosures, badges, help text, empty states) took the sheet from 47.6 kB to 60,375 bytes raw (9.6 kB gzip); the cap is 59,089 (its first cut) plus
    // about 5%. Raised from 30 kB at #311: every Modern surface (ornaments, sidebar, Scene info, companion, palette, dialogs) is in this
    // one on-use sheet; it never loads for Classic.
    // Stageshow polish #358: dense materials, overlay band, menu columns. 67,121 bytes raw (10.9 kB gzip) measured on top of #357's
    // control kit (+6,746 bytes); the cap is that plus about 2%.
    // Stageshow polish #363: the agent window, Import and Export (header row, folded Recurring tasks and plan actions, the Export recipe
    // fold, Import's rule grid, opaque reading dialogs). 72,615 bytes raw measured (+5,367 on 67,248).
    // Stageshow polish #364: 44 px targets on coarse pointers at every width, the tablet sidebar's room, the agent sheet kept in the
    // overlay band and the touch picture checkbox. 73,752 bytes raw measured with #363 and #364 merged (68,508 for #364 alone on #358's).
    // Stageshow polish #361: the write surfaces (ghost and review bars, Codex, board, timeline, pictures, comic page, Scene info, the
    // More disclosure). 83,185 bytes raw measured with #363, #364 and #361 merged (+9.4 kB on 73,752); the cap was that plus about 1%.
    // Stageshow polish #361 + #362 + #363 + #364: plus calm dialogs, Settings, Home and the palette (one menu style, Compile's rows,
    // Home at 390 px, k-tonal and k-quiet). 86,334 bytes raw measured on the merge; the cap is that plus about 1%.
    caps: { 'modern-shell': 87_200 },
  },
  /**
   * "Modern first load" (Classic's plus Modern's chunk and stylesheet, gzip) may exceed Classic's first load by this much. Raised from
   * 25,000 for narrow layout + focus mode, #312/#351; Classic unchanged: 25.4 kB measured on their merge, which is that plus 0.5 kB.
   * Their panels are lazy chunks already; what is left is the slots' wiring in `modern-shell` (§12).
   * Stageshow polish #357: 28.0 kB measured with the control kit, all of it CSS (Modern's stylesheet grew 2.4 kB gzip; no JS moved);
   * the allowance is its first cut (27.7 kB) plus about 0.6 kB.
   * Stageshow polish #358: dense materials, overlay band, menu columns. 29,164 bytes measured, nearly all of it Modern's stylesheet
   * (the JS caps do not move); the allowance is that plus about 1%.
   * Stageshow polish #363: the agent window, Import and Export. 29,950 bytes measured (+0.8 kB on 29,164 at the base, nearly all of it
   * Modern's stylesheet); the allowance was that plus about 0.5%.
   * Stageshow polish #364: phones and tablets (coarse 44 px targets, the tablet sidebar, the kept agent and Scene info sheets), merged on
   * #363. 30,079 bytes measured, nearly all of it Modern's stylesheet (the JS caps do not move).
   * Stageshow polish #361: the write surfaces, merged on #363 and #364. 31,546 bytes measured, nearly all of it Modern's stylesheet; the
   * allowance was that plus about 1%.
   * Stageshow polish #361 + #362 + #363 + #364: plus calm dialogs, Settings, Home and the palette. 32,038 bytes measured on the merge,
   * nearly all of it Modern's stylesheet; the allowance is that plus about 1%.
   */
  modernFirstLoadDelta: 32_360,
};

/** The lazy chunk whose JS and CSS make "Modern first load". */
export const MODERN_CHUNK = 'modern-shell';

const KB = 1000;

/** A size in kB, one decimal. */
function kb(bytes) {
  return (bytes / KB).toFixed(1);
}

/** A chunk's name: its file name without the extension and the 8-character hash Vite appends (`fontkit.es-B1-xruQ9.js` is `fontkit.es`). */
export function chunkName(file) {
  const base = file.endsWith('.js') ? file.slice(0, -3) : file.endsWith('.css') ? file.slice(0, -4) : file;
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

/** The stylesheets index.html links, by file name, in the order the page lists them. */
export function initialStylesOf(html) {
  return tagsOf(html).flatMap((tag) => {
    const spaced = ` ${tag}`;
    const url = tag.startsWith('link ') && attribute(spaced, 'rel') === 'stylesheet' ? attribute(spaced, 'href') : undefined;
    return url === undefined ? [] : [url.slice(url.lastIndexOf('/') + 1)];
  });
}

/** Every tag's text in an HTML page, comments left out, whitespace inside a tag made spaces. */
function tagsOf(html) {
  const tags = [];
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
    tags.push(html.slice(at + 1, close).replaceAll('\n', ' ').replaceAll('\r', ' ').replaceAll('\t', ' '));
    at = close + 1;
  }
  return tags;
}

/** The JS files index.html loads at start: the module script and the modulepreload links, by file name, in the order the page lists them. */
export function initialFilesOf(html) {
  return tagsOf(html).flatMap((tag) => {
    const spaced = ` ${tag}`;
    const isScript = tag.startsWith('script ') && attribute(spaced, 'type') === 'module';
    const isPreload = tag.startsWith('link ') && attribute(spaced, 'rel') === 'modulepreload';
    const url = isScript ? attribute(spaced, 'src') : isPreload ? attribute(spaced, 'href') : undefined;
    return url === undefined ? [] : [url.slice(url.lastIndexOf('/') + 1)];
  });
}

/**
 * Measures the chunks against the budget. `chunks` are `{ file, bytes, gzip }`; `initial` are the file names the first load fetches;
 * `styles`, when given, are the stylesheets `{ files, initial }` in the same shape. Returns the rows (largest first), the first load's
 * gzip size, the total JS, the stylesheet rows, Modern's first load, and the problems.
 */
export function analyse(chunks, initial, budget = BUDGET, styles = undefined) {
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

  for (const [name, cap] of Object.entries(budget.lazy ?? {})) {
    const named = rows.filter((row) => row.name === name);
    if (named.length === 0) problems.push(`the lazy chunk "${name}" is not in the build: it was renamed or merged into another chunk`);
    for (const row of named) {
      if (row.initial) problems.push(`${row.chunk.file} is in the first load, and "${name}" must load only on use`);
      if (row.chunk.bytes > cap) problems.push(`${row.chunk.file} is ${kb(row.chunk.bytes)} kB, over its lazy cap of ${kb(cap)} kB`);
    }
  }

  const styleRows = styles === undefined ? [] : stylesReport(styles, budget, problems);
  const report = { rows, initialGzip, totalJs, problems, styles: styleRows };
  const modern = modernFirstLoad(report);
  if (modern !== undefined && budget.modernFirstLoadDelta !== undefined && modern - initialGzip > budget.modernFirstLoadDelta) {
    problems.push(
      `Modern's first load is ${kb(modern)} kB gzip, ${kb(modern - initialGzip)} kB over Classic's, more than the ${kb(budget.modernFirstLoadDelta)} kB allowed`,
    );
  }
  return { ...report, modernFirstLoad: modern };
}

/** The stylesheets with what each is, checking the entry's and the lazy caps. */
function stylesReport(styles, budget, problems) {
  const first = new Set(styles.initial);
  const rows = [...styles.files]
    .sort((a, b) => b.bytes - a.bytes || (a.file < b.file ? -1 : 1))
    .map((chunk) => ({ chunk, name: chunkName(chunk.file), initial: first.has(chunk.file) }));
  const css = budget.css;
  if (css !== undefined) {
    const entry = rows.filter((row) => row.initial).reduce((sum, row) => sum + row.chunk.bytes, 0);
    const ceiling = Math.floor(css.entry * (1 + css.entryMargin));
    if (entry > ceiling) {
      problems.push(`the entry stylesheet is ${kb(entry)} kB, over ${kb(css.entry)} kB measured plus ${css.entryMargin * 100}% (${kb(ceiling)} kB)`);
    }
    for (const [name, cap] of Object.entries(css.caps)) {
      const named = rows.filter((row) => row.name === name);
      if (named.length === 0) problems.push(`the stylesheet "${name}" is not in the build`);
      for (const row of named) {
        if (row.initial) problems.push(`${row.chunk.file} is linked from index.html, and "${name}" must load only on use`);
        if (row.chunk.bytes > cap) problems.push(`${row.chunk.file} is ${kb(row.chunk.bytes)} kB, over its cap of ${kb(cap)} kB`);
      }
    }
  }
  return rows;
}

/** Classic's first load plus Modern's chunk and stylesheet, gzip, or undefined when the build has no Modern chunk. */
function modernFirstLoad(report) {
  const js = report.rows.filter((row) => row.name === MODERN_CHUNK && !row.initial);
  if (js.length === 0) return undefined;
  const css = report.styles.filter((row) => row.name === MODERN_CHUNK && !row.initial);
  return report.initialGzip + [...js, ...css].reduce((sum, row) => sum + row.chunk.gzip, 0);
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
  for (const { chunk, initial } of report.styles ?? []) {
    out.push(`css ${chunk.file}: ${kb(chunk.bytes)} kB raw, ${kb(chunk.gzip)} kB gzip, ${initial ? 'first load' : 'on use'}`);
  }
  if (report.modernFirstLoad !== undefined) {
    out.push(`Modern first load: ${kb(report.modernFirstLoad)} kB gzip (${kb(report.modernFirstLoad - report.initialGzip)} kB over Classic's)`);
  }
  if (report.problems.length === 0) {
    out.push('bundle size: ok');
  } else {
    out.push('', ...report.problems.map((problem) => `- ${problem}`), '', 'bundle size: FAILED');
  }
  return out.join('\n');
}

/** Reads `<dist>/index.html`, `<dist>/assets/*.js` and `<dist>/assets/*.css`. */
export function readBuild(dist) {
  const html = join(dist, 'index.html');
  const assets = join(dist, 'assets');
  if (!existsSync(html) || !existsSync(assets)) {
    throw new Error(`no build in ${dist}: run pnpm build first`);
  }
  const measure = (file) => {
    const bytes = readFileSync(join(assets, file));
    return { file, bytes: bytes.length, gzip: gzipSync(bytes).length };
  };
  const files = readdirSync(assets);
  const page = readFileSync(html, 'utf8');
  return {
    chunks: files.filter((file) => file.endsWith('.js')).map(measure),
    initial: initialFilesOf(page),
    styles: { files: files.filter((file) => file.endsWith('.css')).map(measure), initial: initialStylesOf(page) },
  };
}

// Run directly: `node tools/check-bundle-size.mjs [dist]`.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const dist = resolve(process.argv[2] ?? join(fileURLToPath(new URL('..', import.meta.url)), 'apps', 'desktop', 'dist'));
  const build = readBuild(dist);
  const report = analyse(build.chunks, build.initial, BUDGET, build.styles);
  process.stdout.write(`${renderReport(report)}\n`);
  if (report.problems.length > 0) process.exitCode = 1;
}
