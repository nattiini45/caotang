/**
 * The hardcoded-string ratchet ([i18n.md §0.1, §8.2](../docs/architecture/i18n.md), I8 / #195).
 *
 * The inventory counts **unwrapped user-facing sites** in `apps/desktop/src`: JSX text nodes,
 * user-facing JSX attributes (`aria-label`, `title`, `placeholder`, `label`, `alt` and their ARIA
 * siblings), sentence-like string literals and prose templates. A site is wrapped when it sits inside
 * a Lingui macro (`t`, `msg`, `defineMessage`, `plural`, `select`, `selectOrdinal`), a `<Trans>`,
 * `<Plural>`, `<Select>` or `<SelectOrdinal>` element, or a `{ id, message }` pair.
 *
 * **The baseline is the ratchet.** `tools/ui-strings-baseline.json` records, per source file and per
 * site kind, the count allowed to remain unwrapped. A file that is not in the baseline has an
 * allowance of zero, so a new file may not add English sites. A path that is in the baseline but no
 * longer exists is reported as stale: a rename therefore fails on both sides until the allowance is
 * moved in an explicit, reviewable baseline edit. That is deliberate — per-path keys make a rename
 * visible instead of silently carrying an allowance to a new name.
 *
 * Counts only go down. `--write` lowers existing entries and drops stale ones; it refuses to add a
 * positive allowance for a new path. `--init` seeds the file once and refuses when it already exists,
 * so it cannot raise the ratchet; convert the file instead.
 *
 * Classification is a heuristic, as §0.1 says: it overcounts JSX text split by inline elements and
 * undercounts strings built from fragments. The committed baseline is the number this repository
 * holds itself to; the §0.1 table is the earlier estimate and is not copied here.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

/** The tree whose English surface the ratchet covers. */
export const UI_ROOT = 'apps/desktop/src';

/** The committed allowance. */
export const BASELINE_FILE = 'tools/ui-strings-baseline.json';

/** The site kinds, in report order. */
export const KINDS = ['jsxText', 'attribute', 'literal', 'template'];

/** The top-of-file marker that exempts a file from translation (i18n.md §3.4). */
export const MODEL_FACING_MARKER = '// i18n: model-facing';

/** JSX attributes whose values a writer reads. */
export const USER_FACING_ATTRIBUTES = new Set([
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'title',
  'placeholder',
  'label',
  'alt',
]);

/**
 * The inventory asks "is this string already a message?", so it recognizes every macro form,
 * including the descriptor and branch builders. The concatenation pass in
 * `check-translations.mjs` asks a narrower question and deliberately recognizes only the
 * value-producing forms; the two sets differ by design, not by accident.
 */
const WRAPPER_CALLEES = new Set(['t', 'msg', 'defineMessage', 'plural', 'select', 'selectOrdinal']);

/** The JSX elements that wrap a message. */
const WRAPPER_ELEMENTS = new Set(['Trans', 'Plural', 'Select', 'SelectOrdinal']);

/** JSX elements whose text is code or styling, not interface copy. */
const SKIP_TEXT_ELEMENTS = new Set(['style', 'script', 'code', 'pre']);

/** Calls whose string arguments are developer plumbing, not interface copy. */
const DEVELOPER_CALLEES = [
  /^console\.(log|warn|error|info|debug|trace|table|group|groupEnd|time|timeEnd)$/,
  /^localStorage\./,
  /^sessionStorage\./,
  /^(fetch|require|RegExp|JSON\.parse|JSON\.stringify|Symbol|querySelector|querySelectorAll|getElementById|getElementsByClassName|addEventListener|removeEventListener|dispatchEvent)$/,
];

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/;

/** A file's relative path with forward slashes, for stable JSON keys on every platform. */
function posixPath(path) {
  return path.split(sep).join('/');
}

/** True when the source declares itself model-facing at the top (i18n.md §3.4). */
export function isModelFacing(source) {
  return source
    .split(/\r?\n/, 12)
    .some((line) => line.trim().startsWith(MODEL_FACING_MARKER));
}

/** Every TypeScript/TSX source file under `root`, sorted, without tests or declarations. */
function sourceFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      if (/\.d\.ts$/.test(entry) || /\.(test|spec)\.(ts|tsx)$/.test(entry)) continue;
      files.push(path);
    }
  };
  walk(root);
  return files;
}

/** True when the text has a letter a writer could read. */
function hasLetters(text) {
  return /\p{L}/u.test(text);
}

/** Text that is unmistakably a path, selector, colour, unit or markup token, whatever the context. */
function isClearlyTechnical(text) {
  const value = text.trim();
  if (/^(https?|data|file|mailto|tel|blob):/i.test(value)) return true;
  if (/^[./~]/.test(value)) return true;
  if (/^[#.][\w-]+$/.test(value)) return true;
  if (/^[\w-]+(\/[\w.-]+)+$/.test(value)) return true;
  if (/^#[0-9a-f]{3,8}$/i.test(value)) return true;
  if (/^(rgb|hsl|oklch|lab|lch|color-mix|var)\(/i.test(value)) return true;
  if (/^--/.test(value)) return true;
  if (/^\d+(\.\d+)?(px|rem|em|%|vh|vw|vmin|vmax|ch|s|ms|deg)$/i.test(value)) return true;
  if (/^<[^>]+>$/.test(value)) return true;
  return false;
}

/** Text that is a path, selector, colour, unit, identifier or other developer token. */
function isTechnical(value) {
  const text = value.trim();
  if (text === '') return true;
  if (!hasLetters(text)) return true;
  if (isClearlyTechnical(text)) return true;
  if (/^[A-Z][A-Z0-9_]*$/.test(text)) return true;
  if (/^[a-z]+(-[a-z]+)+$/.test(text)) return true;
  if (/^\w+\.\w+$/.test(text)) return true;
  if (/^[A-Za-z0-9+/=]{24,}$/.test(text)) return true;
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return true;
  // A CSS selector: `[data-x="…"]`, `article[data-x]`, `[role=…]:not(…)`, `{…}px`.
  if (/\[[^\]]*\]/.test(text) && /[,:>+~[\]]/.test(text)) return true;
  if (/^\{…\}(px|rem|em|%|ch|vh|vw)$/.test(text)) return true;
  // A single `key:` prefix (optionally with one interpolation), not a sentence.
  if (/^[\w.-]+:(\{…\})?$/.test(text)) return true;
  return false;
}

/**
 * Whether a value reads like interface copy. Attribute values are copy by virtue of the attribute;
 * elsewhere a single lowercase token is usually an identifier, so prose needs a space, sentence
 * punctuation, an ICU placeholder or CJK text.
 */
export function isProse(value, kind = 'literal') {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text === '' || !hasLetters(text)) return false;
  // An attribute or a JSX text node is rendered to the writer; only an unmistakable technical token
  // (`https:`, a path, a unit) is excluded. `OK` and `PDF` are labels, not identifiers, here.
  if (kind === 'attribute' || kind === 'jsxText') return !isClearlyTechnical(text);
  if (isTechnical(text)) return false;
  if (/\s/.test(text)) return true;
  if (/[.!?…]$/.test(text)) return true;
  if (/[,;:]/.test(text)) return true;
  if (/\{[^}]+\}/.test(text)) return true;
  if (CJK.test(text)) return true;
  return false;
}

function propertyName(node) {
  if (!node.name) return null;
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) || ts.isNoSubstitutionTemplateLiteral(node.name)) {
    return node.name.text;
  }
  return null;
}

function calleeName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.getText();
  return null;
}

function isWrapperExpression(expression) {
  if (ts.isIdentifier(expression)) return WRAPPER_CALLEES.has(expression.text);
  if (ts.isPropertyAccessExpression(expression)) {
    const name = expression.name.text;
    const owner = calleeName(expression.expression);
    // `i18n._(...)` / `i18n.t(...)` are the runtime lookup, not a raw string.
    return (name === '_' || name === 't') && owner === 'i18n';
  }
  return false;
}

/** A string a message already owns: a macro argument, a wrapping element, or a MessageRef value. */
function isWrapped(node) {
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isJsxElement(parent) || ts.isJsxSelfClosingElement(parent)) {
      const tag = ts.isJsxElement(parent) ? parent.openingElement.tagName : parent.tagName;
      if (ts.isIdentifier(tag) && WRAPPER_ELEMENTS.has(tag.text)) return true;
    }
    if (ts.isCallExpression(parent) && isWrapperExpression(parent.expression)) return true;
    if (ts.isTaggedTemplateExpression(parent) && isWrapperExpression(parent.tag)) return true;
    if (ts.isPropertyAssignment(parent) && propertyName(parent) === 'message') {
      const object = parent.parent;
      if (
        ts.isObjectLiteralExpression(object) &&
        object.properties.some((property) => ts.isPropertyAssignment(property) && propertyName(property) === 'id')
      ) {
        return true;
      }
    }
    current = parent;
  }
  return false;
}

/** The enclosing JSX attribute, when the node is an attribute initializer. */
function enclosingJsxAttribute(node) {
  let current = node.parent;
  if (current && ts.isJsxExpression(current)) current = current.parent;
  return current && ts.isJsxAttribute(current) ? current : null;
}

/** True when a call argument is developer plumbing. */
function isDeveloperContext(node) {
  let current = node.parent;
  while (current) {
    if (ts.isCallExpression(current)) {
      const name = calleeName(current.expression);
      if (name && DEVELOPER_CALLEES.some((pattern) => pattern.test(name))) return true;
    }
    if (ts.isNewExpression(current)) {
      const name = calleeName(current.expression);
      if (name === 'Error') return true;
    }
    if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current)) return true;
    current = current.parent;
  }
  return false;
}

/** True when JSX text sits in code/styling markup rather than interface copy. */
function isCodeText(node) {
  let current = node.parent;
  while (current) {
    if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current)) {
      const tag = ts.isJsxElement(current) ? current.openingElement.tagName : current.tagName;
      if (ts.isIdentifier(tag) && SKIP_TEXT_ELEMENTS.has(tag.text)) return true;
    }
    current = current.parent;
  }
  return false;
}

/** A template's literal parts joined, with a marker for each interpolation. */
function templateText(node) {
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return node.head.text + node.templateSpans.map((span) => `{…}${span.literal.text}`).join('');
}

/**
 * Scans one file. Returns the unwrapped sites with their kind and line, or an empty list for a file
 * marked model-facing.
 */
export function scanSource(filePath, source) {
  const modelFacing = isModelFacing(source);
  if (modelFacing) return { file: filePath, modelFacing, sites: [] };

  const scriptKind = /\.tsx$/.test(filePath) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);
  const sites = [];
  const lineOf = (node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const add = (node, kind, text) => sites.push({ kind, line: lineOf(node), text: text.replace(/\s+/g, ' ').trim() });

  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const text = node.text.replace(/\s+/g, ' ').trim();
      if (!isWrapped(node) && !isCodeText(node) && hasLetters(text) && !isClearlyTechnical(text)) add(node, 'jsxText', text);
      return;
    }

    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(file);
      if (USER_FACING_ATTRIBUTES.has(name) && !isWrapped(node)) {
        const initializer = node.initializer;
        if (initializer && ts.isStringLiteral(initializer)) {
          if (isProse(initializer.text, 'attribute')) add(initializer, 'attribute', initializer.text);
        } else if (initializer && ts.isJsxExpression(initializer) && initializer.expression) {
          const expression = initializer.expression;
          if (ts.isStringLiteral(expression) && isProse(expression.text, 'attribute')) {
            add(expression, 'attribute', expression.text);
          } else if (
            (ts.isNoSubstitutionTemplateLiteral(expression) || ts.isTemplateExpression(expression)) &&
            isProse(templateText(expression), 'attribute')
          ) {
            add(expression, 'attribute', templateText(expression));
          }
        }
      }
      // Its initializer is handled here; do not count it again as a literal or template.
      return;
    }

    if (ts.isStringLiteral(node)) {
      if (enclosingJsxAttribute(node)) return;
      if (isWrapped(node) || isDeveloperContext(node)) return;
      if (isProse(node.text, 'literal')) add(node, 'literal', node.text);
      return;
    }

    if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      if (enclosingJsxAttribute(node)) return;
      if (ts.isTaggedTemplateExpression(node.parent)) return;
      if (isWrapped(node) || isDeveloperContext(node)) return;
      const text = templateText(node);
      if (!hasLetters(text) || isTechnical(text)) return;
      const prose = text.replace(/\{…\}/g, '');
      const interpolated = ts.isTemplateExpression(node) && node.templateSpans.length > 0;
      if (/\s/.test(prose) || (interpolated && /[.!?…]/.test(prose)) || CJK.test(prose)) add(node, 'template', text);
      return;
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(file, visit);
  return { file: filePath, modelFacing, sites };
}

/** Counts sites per kind for one scan. */
function countsOf(sites) {
  const counts = Object.fromEntries(KINDS.map((kind) => [kind, 0]));
  for (const site of sites) counts[site.kind] += 1;
  return counts;
}

/**
 * Scans a tree. `files` is keyed by a path relative to `root` and contains every source file,
 * including model-facing ones with zero counts, so a marker change is visible in the baseline.
 */
export function scanTree(root) {
  const files = [];
  const sites = [];
  for (const path of sourceFiles(root)) {
    const scan = scanSource(path, readFileSync(path, 'utf8'));
    const file = posixPath(relative(root, path));
    const counts = countsOf(scan.sites);
    files.push({ file, modelFacing: scan.modelFacing, counts });
    for (const site of scan.sites) sites.push({ ...site, file });
  }
  files.sort((a, b) => a.file.localeCompare(b.file));
  return { root, files, sites };
}

/** Total sites in a tree, and its per-kind totals. */
export function summarise(tree) {
  const totals = Object.fromEntries(KINDS.map((kind) => [kind, 0]));
  let sites = 0;
  for (const file of tree.files) {
    for (const kind of KINDS) totals[kind] += file.counts[kind];
    sites += Object.values(file.counts).reduce((sum, count) => sum + count, 0);
  }
  return { sites, files: tree.files.length, totals };
}

/** The allowance object the repository commits. */
export function makeBaseline(tree) {
  const files = {};
  for (const entry of tree.files) {
    const total = Object.values(entry.counts).reduce((sum, count) => sum + count, 0);
    if (total > 0) files[entry.file] = { ...entry.counts };
  }
  return { version: 1, root: UI_ROOT, files };
}

/** Reads and validates a baseline document. */
export function readBaseline(path) {
  const baseline = JSON.parse(readFileSync(path, 'utf8'));
  if (baseline.version !== 1) throw new Error(`${path}: unsupported baseline version ${String(baseline.version)}`);
  if (baseline.root !== UI_ROOT) throw new Error(`${path}: baseline root is ${String(baseline.root)}, expected ${UI_ROOT}`);
  if (baseline.files === null || typeof baseline.files !== 'object') throw new Error(`${path}: baseline has no files`);
  return baseline;
}

/** The canonical serialisation: stable key order, two spaces, a trailing newline, no timestamp. */
export function renderBaseline(baseline) {
  const files = {};
  for (const file of Object.keys(baseline.files).sort()) files[file] = baseline.files[file];
  return `${JSON.stringify({ version: 1, root: UI_ROOT, files }, null, 2)}\n`;
}

/** The remedy every over-allowance message names. */
const REMEDY = 'wrap the string in t`…` or <Trans>…</Trans>';

/**
 * Creates the baseline once. An existing file is never overwritten: lowering it is `--write`'s job,
 * and an unconditional seed would let `--init` raise the ratchet.
 */
export function seedBaseline(path, tree, { fileExists = existsSync } = {}) {
  if (fileExists(path)) return { ok: false, message: `${BASELINE_FILE} exists; lower it with --write` };
  const baseline = makeBaseline(tree);
  writeFileSync(path, renderBaseline(baseline));
  return { ok: true, baseline };
}

/**
 * Compares a scan against the baseline. A new path has zero allowance, an increased kind fails, and a
 * baseline path with no source file is stale (a rename must be moved deliberately). A file that has
 * just been marked model-facing keeps its source path but drops to zero sites, so its remaining
 * allowance fails until `--write` prunes it deliberately.
 */
export function compareToBaseline(tree, baseline) {
  const problems = [];
  const measured = new Map(tree.files.map((entry) => [entry.file, entry]));
  for (const entry of tree.files) {
    const allowed = baseline.files[entry.file];
    if (entry.modelFacing) {
      const allowance = Object.values(allowed ?? {}).reduce((sum, count) => sum + count, 0);
      if (allowance > 0) {
        problems.push(
          `${entry.file}: marked model-facing, but the baseline still allows ${String(allowance)} site(s); run --write to prune the allowance deliberately`,
        );
      }
      continue;
    }
    if (!allowed) {
      const total = Object.values(entry.counts).reduce((sum, count) => sum + count, 0);
      if (total > 0) {
        problems.push(
          `${entry.file}: ${String(total)} unwrapped user-facing site(s), but a new file has an allowance of zero; ${REMEDY}`,
        );
      }
      continue;
    }
    for (const kind of KINDS) {
      const count = entry.counts[kind] ?? 0;
      const cap = allowed[kind] ?? 0;
      if (count > cap) {
        problems.push(`${entry.file}: ${kind} ${String(count)} exceeds the baseline allowance ${String(cap)}; ${REMEDY}`);
      }
    }
  }
  for (const file of Object.keys(baseline.files)) {
    if (!measured.has(file)) problems.push(`${file}: stale baseline entry; the file is gone or renamed`);
  }
  return problems;
}

/**
 * Lowers existing allowances and drops stale entries. A new path with sites is refused: convert the
 * file, or move the allowance by hand in a reviewable baseline edit.
 */
export function lowerBaseline(tree, baseline) {
  const problems = [];
  const measured = new Map(tree.files.map((entry) => [entry.file, entry]));
  const files = {};
  for (const [file, allowed] of Object.entries(baseline.files)) {
    const entry = measured.get(file);
    if (!entry) continue;
    const counts = {};
    for (const kind of KINDS) counts[kind] = Math.min(allowed[kind] ?? 0, entry.counts[kind] ?? 0);
    if (Object.values(counts).some((count) => count > 0)) files[file] = counts;
  }
  for (const entry of tree.files) {
    if (entry.modelFacing) continue;
    if (Object.prototype.hasOwnProperty.call(baseline.files, entry.file)) continue;
    const total = Object.values(entry.counts).reduce((sum, count) => sum + count, 0);
    if (total > 0) {
      problems.push(`${entry.file}: new file with ${total} site(s); convert it instead of adding an allowance`);
    }
  }
  return { baseline: { version: 1, root: UI_ROOT, files }, problems };
}

function renderSummary(tree) {
  const summary = summarise(tree);
  const rows = KINDS.map((kind) => `${kind} ${summary.totals[kind]}`).join(', ');
  return `${summary.sites} unwrapped user-facing site(s) in ${summary.files} file(s): ${rows}`;
}

function isMain() {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const uiRoot = join(root, UI_ROOT);
  const baselinePath = join(root, BASELINE_FILE);
  const write = process.argv.includes('--write');
  const init = process.argv.includes('--init');
  const tree = scanTree(uiRoot);

  if (init) {
    const seeded = seedBaseline(baselinePath, tree);
    if (!seeded.ok) {
      console.error(seeded.message);
      process.exitCode = 1;
      return;
    }
    console.log(`wrote ${BASELINE_FILE}`);
    console.log(renderSummary(tree));
    return;
  }

  const baseline = readBaseline(baselinePath);
  if (write) {
    const lowered = lowerBaseline(tree, baseline);
    if (lowered.problems.length > 0) {
      console.error(lowered.problems.join('\n'));
      process.exitCode = 1;
      return;
    }
    writeFileSync(baselinePath, renderBaseline(lowered.baseline));
    console.log(`lowered ${BASELINE_FILE}`);
    console.log(renderSummary(tree));
    return;
  }

  const problems = compareToBaseline(tree, baseline);
  console.log(renderSummary(tree));
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
  }
}

if (isMain()) main();
