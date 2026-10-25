/**
 * The translation guardrails ([i18n.md §8.2](../docs/architecture/i18n.md), I8 / #195).
 *
 * Six checks, all read-only except `--write-stats`:
 *
 * 1. **Catalogue drift.** `lingui extract` is run into a temporary catalogue directory whose config
 *    imports the repository's own `lingui.config.ts` and changes only the output path. The generated
 *    files must equal the committed ones after {@link normalisePo}, which fixes `POT-Creation-Date`.
 *    The header is the one line extraction rewrites on every run; without this normalisation the
 *    guard would fail daily. Missing non-source translations never fail: the English catalogue is
 *    compared for drift, and an empty translation is the per-message fallback working as designed.
 * 2. **Compile.** Every source message and every non-empty translation is compiled with the same
 *    Lingui compiler the build uses; an ICU syntax error is a failure.
 * 3. **Placeholder parity.** A translation's named ICU arguments must be the source's arguments.
 * 4. **Translator hygiene.** A message with values has a translator comment, uses no positional
 *    placeholder (`{0}`, `%s`, `%1$s`), and is not built by concatenation (`t\`…\` + …`).
 * 5. **Statistics.** `locales/stats.json` records, for each shippable target locale, the translated,
 *    untranslated, missing, fuzzy and same-as-English counts. Fuzzy and missing count as
 *    untranslated; obsolete entries are omitted. The source locale and the dev/test pseudo
 *    catalogues are not picker entries and are omitted. The file is deterministic: sorted locale
 *    keys, fixed field order, no timestamp.
 * 6. **Model-facing marker.** A file whose top says `// i18n: model-facing` may not import
 *    `@lingui/*`.
 *
 * The human-readable report is the CLI's; tests import the functions and feed fixtures.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createCompiledCatalog } from '@lingui/cli/api';
import { parsePoFile } from '@lingui/format-po';
import ts from 'typescript';

import { MODEL_FACING_MARKER, isMain, posixPath, sourceFilesUnder } from './i18n-lib.mjs';

export { MODEL_FACING_MARKER };

/** The committed catalogues, relative to the repository root. */
export const LOCALES_ROOT = 'apps/desktop/src/i18n/locales';

/** The generated statistics file, relative to the repository root. */
export const STATS_FILE = 'apps/desktop/src/i18n/locales/stats.json';

/** The source locale; its catalogue is compared for drift, never for completion. */
export const SOURCE_LOCALE = 'en';

/** Dev/test catalogues with no translators; they are not picker entries. */
export const PSEUDO_LOCALES = new Set(['pseudo-LOCALE', 'pseudo-RTL']);

/** A stable header value, so a run on another day compares equal. */
const NORMALISED_POT_DATE = '"POT-Creation-Date: 1970-01-01 00:00+0000\\n"';

/** The fields of one locale's statistics, in this order. */
export const STATS_FIELDS = ['total', 'translated', 'untranslated', 'missing', 'fuzzy', 'sameAsEnglish', 'completion'];

/** Normalises line endings and the one extraction header that changes on every run. */
export function normalisePo(content) {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/^"POT-Creation-Date:.*"$/m, NORMALISED_POT_DATE);
}

/** The first differing line of two normalised catalogues, or an empty list when they agree. */
export function compareCatalogues(committed, generated) {
  const left = normalisePo(committed).split('\n');
  const right = normalisePo(generated).split('\n');
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) {
      return [`line ${index + 1}: committed ${JSON.stringify(left[index] ?? '')}, extracted ${JSON.stringify(right[index] ?? '')}`];
    }
  }
  return [];
}

/** Reads every committed `messages.po`, keyed by locale. */
export function readCatalogues(cataloguesRoot) {
  const catalogues = {};
  for (const entry of readdirSync(cataloguesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(cataloguesRoot, entry.name, 'messages.po');
    if (!existsSync(path)) continue;
    catalogues[entry.name] = { path, catalog: parsePoFile(readFileSync(path, 'utf8')) };
  }
  return catalogues;
}

/** The non-obsolete items of a parsed catalogue. */
export function activeItems(catalog) {
  return catalog.items.filter((item) => !item.obsolete);
}

function formsOf(item) {
  return Array.isArray(item.msgstr) ? item.msgstr : [String(item.msgstr ?? '')];
}

function isMissing(item) {
  return formsOf(item).every((form) => form.trim() === '');
}

function isFuzzy(item) {
  return item.flags.fuzzy === true || item.flags.fuzzy === 'true';
}

function sourceArgs(item) {
  return [...icuArguments(item.msgid), ...(item.msgid_plural ? icuArguments(item.msgid_plural) : [])];
}

function itemLabel(item) {
  return item.msgctxt ? `${item.msgctxt}\u0004${item.msgid}` : item.msgid;
}

/**
 * The ICU argument names in a message, including arguments used inside plural/select branches but
 * not the branch bodies themselves. Positional names (`{0}`) are returned too, so the hygiene check
 * can reject them.
 */
export function icuArguments(message) {
  const args = [];
  scanMessage(message, args);
  return args;
}

/** True when the apostrophe at `index` starts ICU quoting rather than a contraction. */
function startsQuote(text, index) {
  const next = text[index + 1];
  return next === '{' || next === '}' || next === '#';
}

/** The index after an apostrophe-delimited run; `index` points at its opening apostrophe. */
function skipQuote(text, index) {
  let cursor = index + 1;
  while (cursor < text.length) {
    if (text[cursor] === "'") {
      if (text[cursor + 1] === "'") {
        cursor += 2;
        continue;
      }
      return cursor + 1;
    }
    cursor += 1;
  }
  return text.length;
}

function findClosingBrace(text, start) {
  let depth = 1;
  let quoted = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'") {
      if (text[index + 1] === "'") {
        index += 1;
        continue;
      }
      if (startsQuote(text, index)) quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return text.length;
}

function splitTopLevelComma(text) {
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'") {
      if (text[index + 1] === "'") {
        index += 1;
        continue;
      }
      if (startsQuote(text, index)) quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (char === ',' && depth === 0) return [text.slice(0, index), text.slice(index + 1)];
  }
  return [text, ''];
}

/** Every top-level `{…}` body in a plural/select tail, which is branch message text, not an argument. */
function branchBodies(text) {
  const bodies = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "'") {
      if (text[index + 1] === "'") {
        index += 2;
        continue;
      }
      index = startsQuote(text, index) ? skipQuote(text, index) : index + 1;
      continue;
    }
    if (char === '{') {
      const end = findClosingBrace(text, index);
      bodies.push(text.slice(index + 1, end));
      index = end + 1;
      continue;
    }
    index += 1;
  }
  return bodies;
}

function scanMessage(text, args) {
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "'") {
      if (text[index + 1] === "'") {
        index += 2;
        continue;
      }
      index = startsQuote(text, index) ? skipQuote(text, index) : index + 1;
      continue;
    }
    if (char !== '{') {
      index += 1;
      continue;
    }
    const end = findClosingBrace(text, index);
    const inner = text.slice(index + 1, end);
    const [namePart, tail] = splitTopLevelComma(inner);
    const name = namePart.trim();
    if (name !== '') args.push(name);
    const [typePart, branches] = splitTopLevelComma(tail.trim());
    const type = typePart.trim();
    if (type === 'plural' || type === 'selectordinal' || type === 'select') {
      for (const body of branchBodies(branches)) scanMessage(body, args);
    }
    index = end + 1;
  }
}

/** Positional placeholders: ICU numbers and the printf forms. */
export function positionalPlaceholders(message) {
  const names = icuArguments(message).filter((name) => /^\d+$/.test(name));
  const printf = message.match(/%(?:\d+\$)?[sdif]/gi) ?? [];
  return [...new Set([...names, ...printf])];
}

/** Compiles every source message and every non-empty translation. */
export function checkCompile(catalogues) {
  const problems = new Set();
  for (const [locale, { catalog }] of Object.entries(catalogues).sort(([a], [b]) => a.localeCompare(b))) {
    const messages = {};
    for (const item of activeItems(catalog)) {
      const id = itemLabel(item);
      messages[`${id}\u0000source`] = item.msgid;
      formsOf(item).forEach((form, index) => {
        if (form.trim() !== '') messages[`${id}\u0000${index}`] = form;
      });
    }
    const { errors } = createCompiledCatalog(locale, messages, { strict: false, namespace: 'es' });
    for (const error of errors) {
      problems.add(
        `${locale}: ICU compile error in ${JSON.stringify(error.id.split('\u0000')[0])}: ${error.error.message.split('\n')[0]}`,
      );
    }
  }
  return [...problems];
}

/** Every non-empty translation uses the same named arguments as its source. */
export function checkPlaceholderParity(catalogues) {
  const problems = [];
  for (const [locale, { catalog }] of Object.entries(catalogues).sort(([a], [b]) => a.localeCompare(b))) {
    if (locale === SOURCE_LOCALE || PSEUDO_LOCALES.has(locale)) continue;
    for (const item of activeItems(catalog)) {
      const expected = [...new Set(sourceArgs(item))].sort();
      const label = itemLabel(item);
      formsOf(item).forEach((form, index) => {
        if (form.trim() === '') return; // a missing translation falls back per message; it never fails
        const actual = [...new Set(icuArguments(form))].sort();
        if (expected.join('\u0000') !== actual.join('\u0000')) {
          problems.push(
            `${locale}: ${JSON.stringify(label)} form ${index + 1} has arguments [${actual.join(', ')}], source has [${expected.join(', ')}]`,
          );
        }
      });
    }
  }
  return problems;
}

/** Translator comments, named placeholders and no message built by concatenation. */
export function checkTranslatorHygiene(catalogues) {
  const problems = [];
  for (const [locale, { catalog }] of Object.entries(catalogues).sort(([a], [b]) => a.localeCompare(b))) {
    for (const item of activeItems(catalog)) {
      const label = itemLabel(item);
      const values = sourceArgs(item);
      // The extracted comment travels from the source into every locale's PO; checking the source
      // catalogue is enough and avoids reporting the same missing comment once per locale.
      if (locale === SOURCE_LOCALE && values.length > 0 && item.extractedComments.length === 0 && item.comments.length === 0) {
        problems.push(`${locale}: ${JSON.stringify(label)} has values but no translator comment`);
      }
      const messages =
        locale === SOURCE_LOCALE
          ? [item.msgid, ...(item.msgid_plural ? [item.msgid_plural] : [])]
          : formsOf(item);
      const positional = [...new Set(messages.flatMap((message) => positionalPlaceholders(message)))];
      if (positional.length > 0) {
        problems.push(`${locale}: ${JSON.stringify(label)} uses positional placeholder(s) ${positional.join(', ')}`);
      }
    }
  }
  return problems;
}

/**
 * The value-producing message forms the hygiene rule names: `t`, `msg` and the runtime lookup. The
 * inventory deliberately recognizes more forms, because it asks whether a string already belongs to
 * a message rather than whether it is being assembled with `+`; see `WRAPPER_CALLEES` in
 * `check-ui-strings.mjs` for the broader set and the reason.
 */
function isLinguiMessageExpression(node) {
  if (ts.isParenthesizedExpression(node)) return isLinguiMessageExpression(node.expression);
  if (ts.isTaggedTemplateExpression(node)) {
    const tag = node.tag;
    if (ts.isIdentifier(tag)) return tag.text === 't' || tag.text === 'msg';
    if (ts.isPropertyAccessExpression(tag)) {
      return (tag.name.text === '_' || tag.name.text === 't') && ts.isIdentifier(tag.expression) && tag.expression.text === 'i18n';
    }
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (ts.isIdentifier(callee)) return callee.text === 't' || callee.text === 'msg';
    if (ts.isPropertyAccessExpression(callee)) {
      return (callee.name.text === '_' || callee.name.text === 't') && ts.isIdentifier(callee.expression) && callee.expression.text === 'i18n';
    }
  }
  return false;
}

/** Finds `t\`…\` + …` and its call/property forms in source. */
export function findConcatenations(roots) {
  const problems = [];
  for (const root of roots) {
    for (const path of sourceFilesUnder(root)) {
      const source = readFileSync(path, 'utf8');
      const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, /\.tsx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const lines = new Set();
      const visit = (node) => {
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
          if (isLinguiMessageExpression(node.left) || isLinguiMessageExpression(node.right)) {
            const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
            if (!lines.has(line)) {
              lines.add(line);
              problems.push(`${posixPath(relative(process.cwd(), path))}:${line}: a message is built by concatenation`);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(file, visit);
    }
  }
  return problems;
}

/** Finds a model-facing file that imports the message runtime. */
export function findModelFacingImports(roots) {
  const problems = [];
  for (const root of roots) {
    for (const path of sourceFilesUnder(root)) {
      const source = readFileSync(path, 'utf8');
      if (!source.split(/\r?\n/, 12).some((line) => line.trim().startsWith(MODEL_FACING_MARKER))) continue;
      const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, /\.tsx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const visit = (node) => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith('@lingui/')) {
          problems.push(`${posixPath(relative(process.cwd(), path))}: a model-facing file imports ${node.moduleSpecifier.text}`);
        }
        if (ts.isCallExpression(node)) {
          const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
          const requireCall = ts.isIdentifier(node.expression) && node.expression.text === 'require';
          if (dynamicImport || requireCall) {
            const argument = node.arguments[0];
            if (argument && ts.isStringLiteral(argument) && argument.text.startsWith('@lingui/')) {
              problems.push(`${posixPath(relative(process.cwd(), path))}: a model-facing file imports ${argument.text}`);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(file, visit);
    }
  }
  return problems;
}

/** The application and package source roots that the marker guard and concatenation guard cover. */
export function repositorySourceRoots(repoRoot) {
  const roots = [];
  for (const group of ['apps', 'packages']) {
    const groupRoot = join(repoRoot, group);
    if (!existsSync(groupRoot)) continue;
    for (const entry of readdirSync(groupRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const src = join(groupRoot, entry.name, 'src');
      if (existsSync(src)) roots.push(src);
    }
  }
  return roots;
}

/** Statistics for one parsed catalogue. */
export function localeStats(catalog) {
  const items = activeItems(catalog);
  let translated = 0;
  let untranslated = 0;
  let missing = 0;
  let fuzzy = 0;
  let sameAsEnglish = 0;
  for (const item of items) {
    const missingForm = isMissing(item);
    const fuzzyForm = isFuzzy(item);
    if (missingForm) missing += 1;
    if (fuzzyForm) fuzzy += 1;
    if (missingForm || fuzzyForm) {
      untranslated += 1;
      continue;
    }
    translated += 1;
    const form = formsOf(item)[0] ?? '';
    if (!item.msgid_plural && form === item.msgid) sameAsEnglish += 1;
  }
  const total = items.length;
  const completion = total === 0 ? 0 : Math.round((translated / total) * 1000) / 10;
  return { total, translated, untranslated, missing, fuzzy, sameAsEnglish, completion };
}

/** The statistics document: shippable target locales only, sorted, no timestamp. */
export function computeStats(catalogues) {
  const locales = {};
  for (const locale of Object.keys(catalogues).sort()) {
    if (locale === SOURCE_LOCALE || PSEUDO_LOCALES.has(locale)) continue;
    const { catalog } = catalogues[locale];
    locales[locale] = localeStats(catalog);
  }
  return { sourceLocale: SOURCE_LOCALE, locales };
}

/** The canonical stats serialisation: locale keys sorted, fixed field order, two spaces, one newline. */
export function renderStats(stats) {
  const locales = {};
  for (const locale of Object.keys(stats.locales).sort()) {
    const entry = stats.locales[locale];
    locales[locale] = Object.fromEntries(STATS_FIELDS.map((field) => [field, entry[field]]));
  }
  return `${JSON.stringify({ sourceLocale: SOURCE_LOCALE, locales }, null, 2)}\n`;
}

/** Reads the committed statistics, or `undefined` when the file is absent. */
export function readStats(path) {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** A temporary extraction whose resulting catalogue directory is removed after reading. */
export function extractToTemp(repoRoot) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'caotang-lingui-'));
  try {
    const configPath = join(tempRoot, 'lingui.check.mjs');
    const realConfig = pathToFileURL(join(repoRoot, 'lingui.config.ts')).href;
    const config = `import path from 'node:path';
import config from '${realConfig}';
if (!Array.isArray(config.catalogs) || config.catalogs.length !== 1) {
  throw new Error('check-translations expects exactly one catalogue in lingui.config.ts');
}
export default {
  ...config,
  rootDir: ${JSON.stringify(repoRoot)},
  catalogs: [{ ...config.catalogs[0], path: path.join(import.meta.dirname, 'locales', '{locale}', 'messages') }],
};
`;
    writeFileSync(configPath, config);
    const require = createRequire(import.meta.url);
    const linguiBin = join(dirname(require.resolve('@lingui/cli')), 'lingui.js');
    const run = spawnSync(process.execPath, [linguiBin, 'extract', '--config', configPath, '--workers', '1'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (run.status !== 0) {
      throw new Error(`lingui extract failed (status ${String(run.status)}):\n${run.stdout}\n${run.stderr}`);
    }
    const generated = {};
    const localesDir = join(tempRoot, 'locales');
    for (const entry of readdirSync(localesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(localesDir, entry.name, 'messages.po');
      if (existsSync(path)) generated[entry.name] = readFileSync(path, 'utf8');
    }
    return generated;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

/** Compares every committed catalogue with a fresh extraction. */
export function checkDrift(repoRoot, generated = extractToTemp(repoRoot)) {
  const problems = [];
  const committed = readCatalogues(join(repoRoot, LOCALES_ROOT));
  for (const locale of Object.keys(committed).sort()) {
    if (!(locale in generated)) {
      problems.push(`${locale}: committed catalogue has no extracted counterpart`);
      continue;
    }
    for (const difference of compareCatalogues(readFileSync(committed[locale].path, 'utf8'), generated[locale])) {
      problems.push(`${locale}: ${difference}`);
    }
  }
  for (const locale of Object.keys(generated).sort()) {
    if (!(locale in committed)) problems.push(`${locale}: extraction produced a catalogue that is not committed`);
  }
  return problems;
}

function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const cataloguesRoot = join(repoRoot, LOCALES_ROOT);
  const catalogues = readCatalogues(cataloguesRoot);
  const statsPath = join(repoRoot, STATS_FILE);
  const problems = [
    ...checkDrift(repoRoot),
    ...checkCompile(catalogues),
    ...checkPlaceholderParity(catalogues),
    ...checkTranslatorHygiene(catalogues),
    ...findConcatenations(repositorySourceRoots(repoRoot)),
    ...findModelFacingImports(repositorySourceRoots(repoRoot)),
  ];

  const stats = computeStats(catalogues);
  const rendered = renderStats(stats);
  if (process.argv.includes('--write-stats')) {
    writeFileSync(statsPath, rendered);
    console.log(`wrote ${STATS_FILE}`);
  } else {
    const committed = readStats(statsPath);
    if (committed === undefined) {
      problems.push(`${STATS_FILE} is missing; run \`node tools/check-translations.mjs --write-stats\``);
    } else if (renderStats(committed) !== rendered) {
      problems.push(`${STATS_FILE} is stale; run \`node tools/check-translations.mjs --write-stats\``);
    }
  }

  console.log(
    `${Object.keys(catalogues).length} catalogues; ${Object.keys(stats.locales).length} target locale(s); ${problems.length} problem(s)`,
  );
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) main();
