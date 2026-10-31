/**
 * Guide translation sections ([i18n.md §9.3](../docs/architecture/i18n.md), L13 / the I15 tooling): splits a guide by its
 * headings with one shared normalisation, hashes each English section, stamps `<!-- source: <hash> -->` markers into a
 * translation, reports every section as current, missing, stale or renamed, and resolves the English-fallback section
 * for the in-app help link.
 *
 *   node tools/guide-sections.mjs                       the plain report for every locale under docs/i18n/ (never fails)
 *   node tools/guide-sections.mjs --locale de           one locale; a locale with no file yet reports every section missing
 *   node tools/guide-sections.mjs --check [--locale …]  the same report, exit 1 when a section is stale or renamed
 *   node tools/guide-sections.mjs --stamp de            stamp the markers into docs/i18n/de/USER-GUIDE.md (never creates the file)
 *   node tools/guide-sections.mjs --stamp              stamp every locale found under docs/i18n/
 *   node tools/guide-sections.mjs --mark-stale          add visible per-section stale notices, without changing markers
 *   node tools/guide-sections.mjs --write-status        write the current-section data used by in-app help links
 *   node tools/guide-sections.mjs --root <dir>          read the guides under <dir> instead of the repository root
 *   node tools/guide-sections.mjs --help                usage
 *
 * The human-readable report is the CLI's; tests import the functions and feed fixtures. Nothing here contacts a service.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMain } from './i18n-lib.mjs';

/** The English guide, relative to the repository root; it is the authoritative source. */
export const ENGLISH_GUIDE_PATH = 'docs/USER-GUIDE.md';

/** The directory translated guides live in, relative to the repository root: `docs/i18n/<lang>/USER-GUIDE.md`. */
export const GUIDES_ROOT = 'docs/i18n';

/** The generated current-section link data consumed by the app's help resolver. */
export const GUIDE_STATUS_PATH = 'apps/desktop/src/i18n/guide-status.json';

/** Every status the report gives a section. `stale` and `renamed` are the stale class: never current. */
export const SECTION_STATUSES = ['current', 'stale', 'missing', 'renamed'];

/** The path of one locale's translated guide, relative to the repository root. */
export function translatedGuidePath(locale) {
  return `${GUIDES_ROOT}/${locale}/USER-GUIDE.md`;
}

/**
 * The one shared normalisation, applied before splitting, hashing, stamping and resolving: LF line endings and no
 * trailing blank lines. A CRLF checkout therefore hashes exactly like an LF one.
 */
export function normaliseGuide(text) {
  return text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
}

const HEADING_LINE = /^(#{1,6})(?:[ \t]+(.*))?$/;

/**
 * Splits a guide into its sections: one section per ATX heading line (`#`…`######`), running to the next heading of
 * any level, its text being the heading line plus its body. Content before the first heading, when it has any
 * non-blank line, is one section with `level` 0 and no heading. Each section's `text` is normalised.
 */
export function splitSections(markdown) {
  const lines = normaliseGuide(markdown).split('\n');
  const sections = [];
  let preamble = [];
  let current = null;
  const flushPreamble = () => {
    if (preamble.some((line) => line.trim() !== '')) {
      sections.push({ level: 0, heading: '', lines: preamble, text: '' });
    }
    preamble = [];
  };
  for (const line of lines) {
    const match = HEADING_LINE.exec(line);
    if (match) {
      flushPreamble();
      const heading = (match[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim();
      current = { level: match[1].length, heading, lines: [line], text: '' };
      sections.push(current);
    } else if (current === null) {
      preamble.push(line);
    } else {
      current.lines.push(line);
    }
  }
  flushPreamble();
  for (const section of sections) section.text = normaliseGuide(section.lines.join('\n'));
  return sections;
}

/** The anchor slug of a heading, GitHub-style: lower-case, punctuation dropped, spaces to hyphens. */
export function sectionIdOf(heading) {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
    .trim()
    .replace(/ /g, '-');
}

/** Sections with their ids attached; repeated headings get `-1`, `-2`, … and the preamble is `top`. */
export function assignSectionIds(sections) {
  const seen = new Map();
  return sections.map((section) => {
    const base = section.level === 0 ? 'top' : sectionIdOf(section.heading);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return { ...section, id: count === 0 ? base : `${base}-${count}` };
  });
}

/**
 * The source hash of a section: the first 8 hex characters of the SHA-256 of its normalised text, heading line
 * included — so a renamed English heading changes the hash and the translation goes stale, never current.
 */
export function sourceHashOf(sectionText) {
  return createHash('sha256').update(normaliseGuide(sectionText), 'utf8').digest('hex').slice(0, 8);
}

const MARKER_LINE = /^[ \t]*<!--[ \t]*source:[ \t]*([0-9a-fA-F]{8})[ \t]*-->[ \t]*$/;
const ANY_SOURCE_MARKER_LINE = /^[ \t]*<!--[ \t]*source:[^>]*-->[ \t]*$/;

/** The well-formed `<!-- source: <hash> -->` marker a section carries, lower-cased, or null when it has none. */
export function markerOf(section) {
  for (const line of section.lines) {
    const match = MARKER_LINE.exec(line);
    if (match) return match[1].toLowerCase();
  }
  return null;
}

/** A section's text with its source-marker lines removed, so a resolved section renders as prose. */
export function stripSourceMarkers(text) {
  return normaliseGuide(
    text
      .split('\n')
      .filter((line) => !ANY_SOURCE_MARKER_LINE.test(line))
      .join('\n'),
  );
}

/**
 * Stamps `<!-- source: <hash> -->` under the heading of every translation section that has an English counterpart at
 * the same position, replacing any marker already there. Sections past the English count are left unmarked — the tool
 * never invents a hash. The result is normalised (LF, one trailing newline).
 */
export function stampSourceMarkers(englishMarkdown, translationMarkdown) {
  const english = splitSections(englishMarkdown);
  const translation = splitSections(translationMarkdown);
  const stamped = translation.map((section, index) => {
    const lines = section.lines.filter((line) => !ANY_SOURCE_MARKER_LINE.test(line));
    const source = english[index];
    if (source !== undefined) {
      const marker = `<!-- source: ${sourceHashOf(source.text)} -->`;
      if (section.level === 0) lines.unshift(marker);
      else lines.splice(1, 0, marker);
    }
    return lines.join('\n');
  });
  return `${normaliseGuide(stamped.join('\n'))}\n`;
}

/** True for the stale class: a status that `--check` fails on and the resolver reports as `stale`. */
export function isStaleStatus(status) {
  return status === 'stale' || status === 'renamed';
}

/** The visible notice `--mark-stale` puts inside every translated section whose source marker no longer matches. */
export const STALE_BANNER_LINE = '> **Translation stale:** This section no longer matches the English source. The in-app help link opens the current English section.';

/**
 * Add or refresh the visible per-section stale notices without changing any source marker. Current sections lose an
 * old notice, missing sections stay untouched, and running the command again is idempotent. The notice is deliberately
 * English: it is tooling-owned fallback text, not a translation a locale maintainer has to keep in sync.
 */
export function markStaleSections(englishMarkdown, translationMarkdown) {
  if (translationMarkdown == null) return null;
  const report = reportSections(englishMarkdown, translationMarkdown);
  const sections = splitSections(translationMarkdown).map((section, index) => {
    const lines = section.lines.filter((line) => line.trim() !== STALE_BANNER_LINE);
    if (isStaleStatus(report.sections[index]?.status)) {
      const marker = lines.findIndex((line) => MARKER_LINE.test(line));
      lines.splice(marker >= 0 ? marker + 1 : section.level === 0 ? 0 : 1, 0, STALE_BANNER_LINE);
    }
    return lines.join('\n');
  });
  return `${normaliseGuide(sections.join('\n'))}\n`;
}

/**
 * The staleness report of one translation against the English source. Sections are paired by position, never by
 * heading text (headings are translated). Each English section is `current` when the translation section at its
 * position carries exactly its hash, `stale` when it carries a marker that names anything else, `renamed` when that
 * marker names a different English section (or the translation runs past the English count) — treated as stale,
 * never as a new current section — and `missing` when there is no translation section there or no well-formed marker.
 * A missing translation (`null`) reports every section as missing. No hash is ever invented: an unmarked section
 * reports `marker: null`.
 */
export function reportSections(englishMarkdown, translationMarkdown) {
  const english = assignSectionIds(splitSections(englishMarkdown)).map((section) => ({
    ...section,
    hash: sourceHashOf(section.text),
  }));
  const translation = translationMarkdown == null ? [] : assignSectionIds(splitSections(translationMarkdown));
  const hashes = english.map((section) => section.hash);
  const sections = english.map((section, index) => {
    const translated = translation[index];
    const marker = translated === undefined ? null : markerOf(translated);
    let status = 'missing';
    if (translated !== undefined && marker !== null) {
      if (marker === section.hash) status = 'current';
      else {
        const named = hashes.indexOf(marker);
        status = named !== -1 && named !== index ? 'renamed' : 'stale';
      }
    }
    return { index, id: section.id, heading: section.heading, level: section.level, hash: section.hash, marker, status };
  });
  for (let index = english.length; index < translation.length; index += 1) {
    const translated = translation[index];
    sections.push({
      index,
      id: translated.id,
      heading: translated.heading,
      level: translated.level,
      hash: null,
      marker: markerOf(translated),
      status: 'renamed',
    });
  }
  const counts = { current: 0, stale: 0, missing: 0, renamed: 0 };
  for (const row of sections) counts[row.status] += 1;
  return { sections, counts, total: english.length };
}

/**
 * The English-fallback resolver for the in-app help link: given a locale, a section id and the two documents, the
 * translated section is returned only when it exists at that position and its marker matches the English source hash;
 * the English section is returned otherwise. The reason is `current`, `stale` (which includes renamed) or `missing`;
 * a section id the English guide does not have resolves to the whole English document as `missing`.
 */
export function resolveGuideSection({ locale, sectionId, english, translated }) {
  const sections = assignSectionIds(splitSections(english)).map((section) => ({ ...section, hash: sourceHashOf(section.text) }));
  const index = sections.findIndex((section) => section.id === sectionId);
  const base = { locale, sectionId };
  if (index === -1) {
    return { ...base, reason: 'missing', text: normaliseGuide(english), heading: null, hash: null };
  }
  const source = sections[index];
  const translatedSection = translated == null ? undefined : splitSections(translated)[index];
  const marker = translatedSection === undefined ? null : markerOf(translatedSection);
  if (translatedSection === undefined || marker === null) {
    return { ...base, reason: 'missing', text: source.text, heading: source.heading, hash: source.hash };
  }
  if (marker === source.hash) {
    return { ...base, reason: 'current', text: stripSourceMarkers(translatedSection.text), heading: translatedSection.heading, hash: source.hash };
  }
  return { ...base, reason: 'stale', text: source.text, heading: source.heading, hash: source.hash };
}

/**
 * The small build-time link table: only current sections are present, each with its translated anchor.
 * Missing, stale and renamed sections are absent, so the browser resolver falls back to English.
 */
export function guideStatusDocument(locales) {
  const result = {};
  for (const entry of [...locales].sort((a, b) => a.locale.localeCompare(b.locale))) {
    const translated = entry.translation == null ? [] : assignSectionIds(splitSections(entry.translation));
    const sections = {};
    for (const row of entry.report.sections) {
      if (row.status !== 'current') continue;
      sections[row.id] = { hash: row.hash, anchor: translated[row.index]?.id ?? row.id };
    }
    result[entry.locale] = { sections };
  }
  return { sourceLocale: 'en', locales: result };
}

/** The Markdown report for the English guide and one entry per locale: its path, whether the file exists, its report. */
export function renderReport({ englishPath, englishMarkdown, locales }) {
  const english = assignSectionIds(splitSections(englishMarkdown));
  const lines = [
    '# Guide translation report',
    '',
    `English source: ${englishPath} — ${english.length} section${english.length === 1 ? '' : 's'}.`,
    '',
  ];
  if (locales.length === 0) {
    lines.push(`No translated guides under ${GUIDES_ROOT}/ yet: for every locale, every section of the English guide reports missing.`, '');
    return `${lines.join('\n')}\n`;
  }
  for (const { locale, path, exists, report } of locales) {
    lines.push(`## ${locale} — ${path}${exists ? '' : ' (no file yet: every section reports missing)'}`, '');
    if (!exists) {
      lines.push(`All ${report.total} sections missing.`, '');
      continue;
    }
    const cell = (text) => String(text).replace(/\|/g, '\\|');
    lines.push('| # | Section | Status | Marker | English hash |', '| --- | --- | --- | --- | --- |');
    for (const row of report.sections) {
      lines.push(
        `| ${row.index + 1} | ${cell(`${row.id} — ${row.heading || '(no heading)'}`)} | ${row.status} | ${row.marker ?? '—'} | ${row.hash ?? '—'} |`,
      );
    }
    lines.push('');
    const { counts, total } = report;
    lines.push(`${counts.current} current, ${counts.stale} stale, ${counts.missing} missing, ${counts.renamed} renamed of ${total} sections.`, '');
  }
  return `${lines.join('\n')}\n`;
}

const USAGE = `Guide translation sections (docs/architecture/i18n.md §9.3, L13).

Usage:
  node tools/guide-sections.mjs                        plain report for every locale under docs/i18n/ (never fails)
  node tools/guide-sections.mjs --locale <lang>        one locale; a locale with no file yet reports every section missing
  node tools/guide-sections.mjs --check [--locale …]   same report, exit 1 when a section is stale or renamed (missing never fails)
  node tools/guide-sections.mjs --stamp <lang>         stamp <!-- source: <hash> --> markers into docs/i18n/<lang>/USER-GUIDE.md
                                                       (never creates the file); --stamp without a locale stamps every locale found
  node tools/guide-sections.mjs --mark-stale           add visible notices to stale sections and remove notices now current
  node tools/guide-sections.mjs --write-status         write apps/desktop/src/i18n/guide-status.json for current help links
  node tools/guide-sections.mjs --root <dir>           read the guides under <dir> instead of the repository root
  node tools/guide-sections.mjs --help                 this text

Exit codes: 0 ok, 1 --check found a stale or renamed section, 2 usage or read error.
`;

const LOCALE_TAG = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;

function usageError(message) {
  process.stderr.write(`${message}\n\n${USAGE}`);
  process.exitCode = 2;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }
  let root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let locale = null;
  let check = false;
  let writeStatus = false;
  let markStale = false;
  let stamp;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--root') {
      const value = args[index + 1];
      if (value === undefined) return usageError('--root needs a directory');
      root = resolve(value);
      index += 1;
    } else if (arg === '--locale') {
      const value = args[index + 1];
      if (value === undefined) return usageError('--locale needs a language tag');
      locale = value;
      index += 1;
    } else if (arg === '--check') {
      check = true;
    } else if (arg === '--mark-stale') {
      markStale = true;
    } else if (arg === '--write-status') {
      writeStatus = true;
    } else if (arg === '--stamp') {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith('--')) {
        stamp = value;
        index += 1;
      } else {
        stamp = null;
      }
    } else {
      return usageError(`unknown argument: ${arg}`);
    }
  }
  for (const tag of [locale, stamp].filter((value) => typeof value === 'string')) {
    if (!LOCALE_TAG.test(tag)) return usageError(`not a language tag: ${tag}`);
  }

  const englishFile = join(root, ENGLISH_GUIDE_PATH);
  if (!existsSync(englishFile)) return usageError(`no English guide at ${ENGLISH_GUIDE_PATH} under ${root}`);
  const englishMarkdown = readFileSync(englishFile, 'utf8');

  const guidesRoot = join(root, GUIDES_ROOT);
  const found = existsSync(guidesRoot)
    ? readdirSync(guidesRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : [];
  const selected = locale === null ? found : [locale];
  const entries = selected.map((tag) => {
    const path = translatedGuidePath(tag);
    const exists = existsSync(join(root, path));
    return { locale: tag, path, exists, translation: exists ? readFileSync(join(root, path), 'utf8') : null };
  });

  if (stamp !== undefined) {
    for (const entry of entries) {
      if (stamp !== null && stamp !== entry.locale) continue;
      if (!entry.exists) {
        process.stdout.write(`no translated guide at ${entry.path} yet; nothing stamped (the tool never creates the file)\n`);
        continue;
      }
      const stamped = stampSourceMarkers(englishMarkdown, entry.translation);
      if (stamped !== entry.translation) {
        writeFileSync(join(root, entry.path), stamped);
        process.stdout.write(`stamped ${entry.path}\n`);
      } else {
        process.stdout.write(`${entry.path} is already stamped\n`);
      }
      entry.translation = stamped;
    }
  }

  if (markStale) {
    for (const entry of entries) {
      if (!entry.exists) continue;
      const marked = markStaleSections(englishMarkdown, entry.translation);
      if (marked !== entry.translation) {
        writeFileSync(join(root, entry.path), marked);
        process.stdout.write(`marked stale sections in ${entry.path}\n`);
      }
      entry.translation = marked;
    }
  }

  const locales = entries.map((entry) => ({ ...entry, report: reportSections(englishMarkdown, entry.translation) }));
  if (writeStatus) {
    const statusFile = join(root, GUIDE_STATUS_PATH);
    mkdirSync(dirname(statusFile), { recursive: true });
    writeFileSync(statusFile, `${JSON.stringify(guideStatusDocument(locales), null, 2)}\n`);
    process.stdout.write(`wrote ${GUIDE_STATUS_PATH}\n`);
  }
  process.stdout.write(renderReport({ englishPath: ENGLISH_GUIDE_PATH, englishMarkdown, locales }));

  if (check) {
    const stale = locales.flatMap((entry) =>
      entry.report.sections
        .filter((row) => isStaleStatus(row.status))
        .map((row) => `${entry.locale} § ${row.id}: ${row.status}`),
    );
    if (stale.length > 0) {
      process.stderr.write(`${stale.length} stale or renamed section(s):\n${stale.join('\n')}\n`);
      process.exitCode = 1;
    }
  }
}

if (isMain(import.meta.url)) main();
