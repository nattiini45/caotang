/**
 * The physical-CSS guard ([i18n.md §5.1, §8.2](../docs/architecture/i18n.md), I8 / #195).
 *
 * A physical direction declaration (`margin-left`, `padding-right`, `left`, `border-top-left-radius`,
 * `text-align: left`, `float: right`, …) does not mirror when `<html dir="rtl">`. The logical
 * equivalents do (`margin-inline-start`, `text-align: start`, `float: inline-start`). This guard scans
 * the app's CSS and JSX `style` objects and fails on a declaration that is not in
 * `tools/logical-css-allowlist.json`.
 *
 * The allowlist is seeded from the occurrences that exist today; each entry names one declaration in
 * one selector context (and one at-rule context), never a whole file or module. That is what makes a
 * new physical rule in an already-allowlisted file fail. The entries shrink through I9, which converts
 * them to logical properties. `--write` lowers and prunes, and refuses to add a new occurrence; `--init`
 * seeds the file once.
 *
 * Imperative DOM writes (`element.style.left = …`) are outside this guard; none exist today. The
 * editor's ruler and media scrubbers are the genuinely physical cases §5.1 names, and they stay in
 * the allowlist until I9 re-checks them.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

/** The app source the guard covers. */
export const APP_ROOT = 'apps/desktop/src';

/** The committed allowlist. */
export const ALLOWLIST_FILE = 'tools/logical-css-allowlist.json';

/** A CSS property name that carries a physical left/right direction. */
const PHYSICAL_PROPERTY = /^(?:left|right)$|(?:^|-)(?:left|right)(?:-|$)/;

/** Properties whose value is a physical direction. */
const DIRECTION_VALUED = new Set(['text-align', 'float', 'clear']);

/** Inline style keys that carry a physical direction; the script reads camelCase names. */
const INLINE_PHYSICAL = /^(?:left|right|inset(?:Left|Right)|(?:margin|padding|border|scrollMargin|scrollPadding)(?:Left|Right)|border(?:Top|Bottom)(?:Left|Right)Radius|border(?:Left|Right)(?:Color|Style|Width)?)$/;

/** Inline style keys whose string value is the direction. */
const INLINE_DIRECTION_VALUED = new Map([
  ['textAlign', 'text-align'],
  ['float', 'float'],
  ['clear', 'clear'],
]);

function posixPath(path) {
  return path.split(sep).join('/');
}

/** Comments become spaces, and newlines survive, so line numbers stay true. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
}

/** The selector context of a stack of open blocks: at-rules then the innermost selector chain. */
function contextOf(stack) {
  return stack.map((block) => block.prelude).join(' | ') || '(root)';
}

/**
 * Scans CSS text. Every physical declaration is returned with its file, selector/at-rule context,
 * property key (a direction-valued property includes its value) and 1-based line.
 */
export function scanCss(source, file = '(inline)') {
  const text = stripComments(source.replace(/\r\n/g, '\n'));
  const occurrences = [];
  const stack = [];
  let buffer = '';
  let bufferLine = 1;
  let line = 1;

  const flush = () => {
    const declaration = buffer.trim();
    buffer = '';
    if (declaration === '' || declaration.startsWith('@')) return;
    const separator = declaration.indexOf(':');
    if (separator === -1) return;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    if (property === '' || property.startsWith('--')) return;
    let key = null;
    if (PHYSICAL_PROPERTY.test(property)) key = property;
    else if (DIRECTION_VALUED.has(property)) {
      const direction = value.split(/[\s;]/)[0]?.toLowerCase();
      if (direction === 'left' || direction === 'right') key = `${property}=${direction}`;
    }
    if (key !== null) occurrences.push({ file, context: contextOf(stack), property: key, line: bufferLine });
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\n') line += 1;
    if (char === '{') {
      stack.push({ prelude: buffer.trim() });
      buffer = '';
      bufferLine = line;
      continue;
    }
    if (char === '}') {
      flush();
      stack.pop();
      bufferLine = line;
      continue;
    }
    if (char === ';') {
      flush();
      bufferLine = line;
      continue;
    }
    if (buffer === '') bufferLine = line;
    buffer += char;
  }
  flush();
  return occurrences;
}

/** Physical declarations in JSX `style={{ … }}` objects and `CSSProperties` values. */
export function scanInlineStyles(path, source, file = path) {
  const scriptKind = /\.tsx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind);
  const occurrences = [];
  const objects = new Map();
  const addObject = (object, context) => {
    if (!objects.has(object)) objects.set(object, context);
  };
  const isCssProperties = (type) => type !== undefined && /\bCSSProperties\b/.test(type.getText(parsed));

  const visit = (node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(parsed) === 'style') {
      const initializer = node.initializer;
      if (initializer && ts.isJsxExpression(initializer) && initializer.expression && ts.isObjectLiteralExpression(initializer.expression)) {
        addObject(initializer.expression, 'style={{…}}');
      }
    }
    if (ts.isVariableDeclaration(node) && isCssProperties(node.type) && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      addObject(node.initializer, 'CSSProperties');
    }
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      isCssProperties(node.type)
    ) {
      const collect = (child) => {
        if (ts.isObjectLiteralExpression(child)) addObject(child, 'CSSProperties');
        ts.forEachChild(child, collect);
      };
      if (node.body) collect(node.body);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(parsed, visit);

  for (const [object, context] of objects) {
    for (const property of object.properties) {
      const name = property.name && ts.isIdentifier(property.name) ? property.name.text : null;
      if (name === null) continue;
      const line = parsed.getLineAndCharacterOfPosition(property.getStart(parsed)).line + 1;
      if (INLINE_PHYSICAL.test(name)) {
        occurrences.push({ file, context, property: name, line });
        continue;
      }
      const logical = INLINE_DIRECTION_VALUED.get(name);
      if (logical && ts.isPropertyAssignment(property) && ts.isStringLiteral(property.initializer)) {
        const direction = property.initializer.text.toLowerCase();
        if (direction === 'left' || direction === 'right') {
          occurrences.push({ file, context, property: `${logical}=${direction}`, line });
        }
      }
    }
  }
  return occurrences;
}

/** Scans the app for physical CSS declarations, in stylesheets and JSX style objects. */
export function scanTree(root) {
  const occurrences = [];
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      if (/\.css$/.test(entry)) {
        files.push(path);
        occurrences.push(...scanCss(readFileSync(path, 'utf8'), posixPath(relative(root, path))));
        continue;
      }
      if (/\.(ts|tsx)$/.test(entry)) {
        if (/\.d\.ts$/.test(entry) || /\.(test|spec)\.(ts|tsx)$/.test(entry)) continue;
        const source = readFileSync(path, 'utf8');
        const found = scanInlineStyles(path, source, posixPath(relative(root, path)));
        if (found.length > 0) files.push(path);
        occurrences.push(...found);
      }
    }
  };
  walk(root);
  occurrences.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.property.localeCompare(b.property));
  return { occurrences, files };
}

function keyOf(occurrence) {
  return `${occurrence.file}\u0000${occurrence.context}\u0000${occurrence.property}`;
}

/** The allowlist document, with one entry per declaration context and its count. */
export function makeAllowlist(occurrences) {
  const counts = new Map();
  for (const occurrence of occurrences) {
    const key = keyOf(occurrence);
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { file: occurrence.file, context: occurrence.context, property: occurrence.property, count: 1 });
  }
  const entries = [...counts.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.context.localeCompare(b.context) || a.property.localeCompare(b.property),
  );
  return { version: 1, entries };
}

/** Reads and validates the allowlist. */
export function readAllowlist(path) {
  const allowlist = JSON.parse(readFileSync(path, 'utf8'));
  if (allowlist.version !== 1) throw new Error(`${path}: unsupported allowlist version ${String(allowlist.version)}`);
  if (!Array.isArray(allowlist.entries)) throw new Error(`${path}: allowlist has no entries`);
  return allowlist;
}

/** The canonical serialisation: sorted entries, two spaces, a trailing newline. */
export function renderAllowlist(allowlist) {
  const entries = [...allowlist.entries].sort(
    (a, b) => a.file.localeCompare(b.file) || a.context.localeCompare(b.context) || a.property.localeCompare(b.property),
  );
  return `${JSON.stringify({ version: 1, entries }, null, 2)}\n`;
}

/** A measured occurrence outside the allowance fails; an entry for a gone occurrence is ignored. */
export function compareToAllowlist(occurrences, allowlist) {
  const allowed = new Map(allowlist.entries.map((entry) => [keyOf(entry), entry.count]));
  const measured = new Map();
  const problems = [];
  for (const occurrence of occurrences) {
    const key = keyOf(occurrence);
    measured.set(key, (measured.get(key) ?? 0) + 1);
    if ((measured.get(key) ?? 0) > (allowed.get(key) ?? 0)) {
      const context = occurrence.context === '(root)' ? '' : ` in ${occurrence.context}`;
      problems.push(
        `${occurrence.file}:${occurrence.line}: ${occurrence.property}${context} is a physical direction declaration outside the allowlist`,
      );
    }
  }
  return problems;
}

/** Lowers existing entries and drops gone ones; a new declaration is refused, not allowed. */
export function lowerAllowlist(occurrences, allowlist) {
  const measured = new Map();
  for (const occurrence of occurrences) {
    const key = keyOf(occurrence);
    measured.set(key, (measured.get(key) ?? 0) + 1);
  }
  const entries = [];
  const problems = [];
  for (const entry of allowlist.entries) {
    const count = Math.min(entry.count, measured.get(keyOf(entry)) ?? 0);
    if (count > 0) entries.push({ ...entry, count });
  }
  const known = new Set(allowlist.entries.map((entry) => keyOf(entry)));
  for (const occurrence of occurrences) {
    const key = keyOf(occurrence);
    if (known.has(key)) {
      known.delete(key);
      continue;
    }
    problems.push(
      `${occurrence.file}:${occurrence.line}: new physical direction declaration (${occurrence.property} in ${occurrence.context}); convert it instead of adding an allowance`,
    );
  }
  return { allowlist: { version: 1, entries }, problems };
}

function isMain() {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url;
}

function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const root = join(repoRoot, APP_ROOT);
  const allowlistPath = join(repoRoot, ALLOWLIST_FILE);
  const tree = scanTree(root);
  const init = process.argv.includes('--init');
  const write = process.argv.includes('--write');

  if (init) {
    if (existsSync(allowlistPath)) {
      console.error(`${ALLOWLIST_FILE} exists; lower it with --write`);
      process.exitCode = 1;
      return;
    }
    writeFileSync(allowlistPath, renderAllowlist(makeAllowlist(tree.occurrences)));
    console.log(`wrote ${ALLOWLIST_FILE}: ${tree.occurrences.length} declaration(s)`);
    return;
  }

  const allowlist = readAllowlist(allowlistPath);
  if (write) {
    const lowered = lowerAllowlist(tree.occurrences, allowlist);
    if (lowered.problems.length > 0) {
      console.error(lowered.problems.join('\n'));
      process.exitCode = 1;
      return;
    }
    writeFileSync(allowlistPath, renderAllowlist(lowered.allowlist));
    console.log(`lowered ${ALLOWLIST_FILE}: ${lowered.allowlist.entries.length} declaration context(s)`);
    return;
  }

  const problems = compareToAllowlist(tree.occurrences, allowlist);
  console.log(`${tree.occurrences.length} physical declaration(s) in ${tree.files.length} file(s); ${problems.length} problem(s)`);
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
  }
}

if (isMain()) main();
