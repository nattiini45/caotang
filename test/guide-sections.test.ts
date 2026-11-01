/**
 * The guide-section tooling (i18n.md §9.3, L13): the heading splitter and source hash, the marker stamping, the
 * staleness report (current, stale, missing, renamed — a renamed heading is stale, never a new current section, and
 * no hash is ever invented), the English-fallback resolver with its reason, the CLI's exit codes, and one
 * determinism check on the real `docs/USER-GUIDE.md`. Fixtures are built here; only the last describe reads the repo.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ENGLISH_GUIDE_PATH,
  GUIDE_STATUS_PATH,
  guideStatusDocument,
  isStaleStatus,
  markStaleSections,
  STALE_BANNER_LINE,
  normaliseGuide,
  reportSections,
  resolveGuideSection,
  sectionIdOf,
  sourceHashOf,
  splitSections,
  stampSourceMarkers,
} from '../tools/guide-sections.mjs';

const repoRoot = resolve(__dirname, '..');
const tool = join(repoRoot, 'tools', 'guide-sections.mjs');

const ENGLISH = ['# Guide', '', 'Intro.', '', '## Alpha', '', 'Alpha body.', '', '## Beta', '', 'Beta body.', ''].join('\n');
const ENGLISH_EDITED = ENGLISH.replace('Alpha body.', 'Alpha body, edited.');
const ENGLISH_RENAMED = ENGLISH.replace('## Alpha', '## Alpha renamed');
const GERMAN = ['# Anleitung', '', 'Einführung.', '', '## Teil Alpha', '', 'Alpha-Körper.', '', '## Teil Beta', '', 'Beta-Körper.', ''].join('\n');

/** An independent SHA-256, so the test pins the hash contract rather than the implementation. */
const hashOf = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);

function pick<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) throw new Error(`fixture has no element ${index}`);
  return value;
}

function run(args: string[]) {
  const result = spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8' });
  return { status: result.status ?? -1, stdout: String(result.stdout), stderr: String(result.stderr) };
}

function makeRoot(english: string, translation: string | null): string {
  const root = mkdtempSync(join(tmpdir(), 'caotang-guide-'));
  mkdirSync(join(root, 'docs', 'i18n', 'de'), { recursive: true });
  writeFileSync(join(root, ENGLISH_GUIDE_PATH), english);
  if (translation !== null) writeFileSync(join(root, 'docs', 'i18n', 'de', 'USER-GUIDE.md'), translation);
  return root;
}

describe('splitting and hashing', () => {
  it('splits a guide by its headings of any level, and content before the first heading is one section with no heading', () => {
    const sections = splitSections(ENGLISH);
    expect(sections.map((section) => section.level)).toEqual([1, 2, 2]);
    expect(sections.map((section) => section.heading)).toEqual(['Guide', 'Alpha', 'Beta']);
    expect(pick(sections, 1).text).toBe('## Alpha\n\nAlpha body.');
    const preamble = splitSections('Intro only.\n\n## A\n\nx\n');
    expect(preamble.map((section) => section.level)).toEqual([0, 2]);
    expect(pick(preamble, 0).heading).toBe('');
  });

  it('normalises line endings and trailing blank lines before hashing, so a CRLF guide hashes like an LF one', () => {
    expect(normaliseGuide('a\r\nb\rc\n\n\n')).toBe('a\nb\nc');
    expect(sourceHashOf('## A\r\n\r\nbody\r\n')).toBe(sourceHashOf('## A\n\nbody'));
  });

  it('hashes the section text including its heading line: the first 8 hex of the SHA-256, deterministic', () => {
    const alpha = pick(splitSections(ENGLISH), 1).text;
    expect(sourceHashOf(alpha)).toBe(hashOf('## Alpha\n\nAlpha body.'));
    expect(sourceHashOf(alpha)).toMatch(/^[0-9a-f]{8}$/);
    expect(sourceHashOf(alpha)).toBe(sourceHashOf(alpha));
    expect(sectionIdOf('Your work and where it lives')).toBe('your-work-and-where-it-lives');
  });
});

describe('stamping markers into a translation', () => {
  it('writes <!-- source: <hash> --> under each heading, paired by position, and is idempotent', () => {
    const stamped = stampSourceMarkers(ENGLISH, GERMAN);
    expect(stamped).toContain(`## Teil Alpha\n<!-- source: ${hashOf('## Alpha\n\nAlpha body.')} -->`);
    expect(stamped).toContain(`## Teil Beta\n<!-- source: ${hashOf('## Beta\n\nBeta body.')} -->`);
    expect(stampSourceMarkers(ENGLISH, stamped)).toBe(stamped);
    expect(reportSections(ENGLISH, stamped).counts.current).toBe(3);
  });

  it('never invents a marker: translation sections past the English count stay unmarked', () => {
    const extra = `${GERMAN}## Teil Gamma\n\nGamma.\n`;
    const stamped = stampSourceMarkers(ENGLISH, extra);
    const after = stamped.slice(stamped.indexOf('## Teil Gamma'));
    expect(after.startsWith('<!-- source:')).toBe(false);
    const report = reportSections(ENGLISH, stamped);
    expect(pick(report.sections, 3).status).toBe('renamed');
    expect(pick(report.sections, 3).marker).toBe(null);
  });
});

describe('the staleness report', () => {
  it('reports every section current when each marker matches its English hash', () => {
    const report = reportSections(ENGLISH, stampSourceMarkers(ENGLISH, GERMAN));
    expect(report.total).toBe(3);
    expect(report.sections.map((row) => row.status)).toEqual(['current', 'current', 'current']);
    expect(pick(report.sections, 1).marker).toBe(hashOf('## Alpha\n\nAlpha body.'));
  });

  it('reports a section stale after an English edit, with the old marker kept and never rewritten', () => {
    const report = reportSections(ENGLISH_EDITED, stampSourceMarkers(ENGLISH, GERMAN));
    const alpha = pick(report.sections, 1);
    expect(alpha.status).toBe('stale');
    expect(alpha.marker).toBe(hashOf('## Alpha\n\nAlpha body.'));
    expect(alpha.hash).toBe(hashOf('## Alpha\n\nAlpha body, edited.'));
    expect(alpha.marker).not.toBe(alpha.hash);
    expect(pick(report.sections, 2).status).toBe('current');
    expect(isStaleStatus('stale')).toBe(true);
  });

  it('treats a renamed English heading as stale, not as a new current section', () => {
    const report = reportSections(ENGLISH_RENAMED, stampSourceMarkers(ENGLISH, GERMAN));
    const alpha = pick(report.sections, 1);
    expect(alpha.status).toBe('stale');
    expect(alpha.status).not.toBe('current');
    expect(isStaleStatus(alpha.status)).toBe(true);
  });

  it('reports renamed when a marker names a different English section, and renamed is stale-class', () => {
    const parts = splitSections(stampSourceMarkers(ENGLISH, GERMAN)).map((section) => section.text);
    const swapped = `${[parts[0], parts[2], parts[1]].join('\n\n')}\n`;
    const report = reportSections(ENGLISH, swapped);
    expect(pick(report.sections, 1).status).toBe('renamed');
    expect(pick(report.sections, 2).status).toBe('renamed');
    expect(isStaleStatus('renamed')).toBe(true);
    expect(isStaleStatus('current')).toBe(false);
    expect(isStaleStatus('missing')).toBe(false);
  });

  it('reports missing when the translation does not exist, is shorter, or carries no marker — and invents no hash', () => {
    const absent = reportSections(ENGLISH, null);
    expect(absent.total).toBe(3);
    expect(absent.counts.missing).toBe(3);
    expect(absent.sections.every((row) => row.marker === null)).toBe(true);
    const short = reportSections(ENGLISH, '# Nur\n\nText.\n');
    expect(short.counts.missing).toBe(3);
    expect(pick(short.sections, 0).status).toBe('missing');
    const unmarked = reportSections(ENGLISH, GERMAN);
    expect(unmarked.counts.missing).toBe(3);
    expect(unmarked.sections.every((row) => row.marker === null)).toBe(true);
  });

  it('reports stale for a well-formed marker that does not match the English hash', () => {
    const wrong = GERMAN.replace('## Teil Alpha\n', '## Teil Alpha\n<!-- source: deadbeef -->\n');
    const report = reportSections(ENGLISH, wrong);
    expect(pick(report.sections, 1).status).toBe('stale');
    expect(pick(report.sections, 1).marker).toBe('deadbeef');
  });
});

describe('visible stale notices', () => {
  it('marks only stale sections, preserves their old source markers, and removes a notice when current again', () => {
    const stamped = stampSourceMarkers(ENGLISH, GERMAN);
    const marked = markStaleSections(ENGLISH_EDITED, stamped);
    expect(marked).toContain(`## Teil Alpha\n<!-- source: ${hashOf('## Alpha\n\nAlpha body.')} -->\n${STALE_BANNER_LINE}`);
    expect(pick(splitSections(marked), 2).text).not.toContain(STALE_BANNER_LINE);
    expect(markStaleSections(ENGLISH_EDITED, marked)).toBe(marked);
    expect(reportSections(ENGLISH_EDITED, marked).counts.stale).toBe(1);
    expect(markStaleSections(ENGLISH, marked)).not.toContain(STALE_BANNER_LINE);
  });
});

describe('the English-fallback resolver', () => {
  it('returns the translated section with reason current only when the marker matches, marker stripped', () => {
    const resolved = resolveGuideSection({
      locale: 'de',
      sectionId: 'alpha',
      english: ENGLISH,
      translated: stampSourceMarkers(ENGLISH, GERMAN),
    });
    expect(resolved.reason).toBe('current');
    expect(resolved.locale).toBe('de');
    expect(resolved.text).toBe('## Teil Alpha\n\nAlpha-Körper.');
    expect(resolved.heading).toBe('Teil Alpha');
    expect(resolved.hash).toBe(hashOf('## Alpha\n\nAlpha body.'));
  });

  it('returns the English section with reason stale after an English edit or a renamed heading', () => {
    const stamped = stampSourceMarkers(ENGLISH, GERMAN);
    const edited = resolveGuideSection({ locale: 'de', sectionId: 'alpha', english: ENGLISH_EDITED, translated: stamped });
    expect(edited.reason).toBe('stale');
    expect(edited.text).toBe('## Alpha\n\nAlpha body, edited.');
    // A renamed English heading changes the section id; asked for the new id, the old marker no longer matches.
    const renamed = resolveGuideSection({ locale: 'de', sectionId: 'alpha-renamed', english: ENGLISH_RENAMED, translated: stamped });
    expect(renamed.reason).toBe('stale');
    expect(renamed.text).toBe('## Alpha renamed\n\nAlpha body.');
  });

  it('omits stale help targets and keeps current ones with their translated anchors', () => {
    const stamped = stampSourceMarkers(ENGLISH, GERMAN);
    const currentReport = reportSections(ENGLISH, stamped);
    const current = guideStatusDocument([{ locale: 'de', translation: stamped, report: currentReport }]);
    expect(current.locales.de.sections.alpha.anchor).toBe('teil-alpha');
    const staleReport = reportSections(ENGLISH_EDITED, stamped);
    const stale = guideStatusDocument([{ locale: 'de', translation: stamped, report: staleReport }]);
    expect(stale.locales.de.sections.alpha).toBeUndefined();
    expect(stale.locales.de.sections.beta.anchor).toBe('teil-beta');
  });

  it('returns the English section with reason missing when there is no translation or no marker', () => {
    const fromAbsent = resolveGuideSection({ locale: 'de', sectionId: 'alpha', english: ENGLISH, translated: null });
    expect(fromAbsent.reason).toBe('missing');
    expect(fromAbsent.text).toBe('## Alpha\n\nAlpha body.');
    const fromUnmarked = resolveGuideSection({ locale: 'de', sectionId: 'alpha', english: ENGLISH, translated: GERMAN });
    expect(fromUnmarked.reason).toBe('missing');
  });

  it('resolves an unknown section id to the whole English document as missing', () => {
    const resolved = resolveGuideSection({ locale: 'de', sectionId: 'no-such-section', english: ENGLISH, translated: null });
    expect(resolved.reason).toBe('missing');
    expect(resolved.text).toBe(normaliseGuide(ENGLISH));
  });
});

describe('the real English guide', () => {
  it('hashes docs/USER-GUIDE.md deterministically: same input twice, same output, unique 8-hex hashes', () => {
    const guide = readFileSync(join(repoRoot, ENGLISH_GUIDE_PATH), 'utf8');
    const first = splitSections(guide).map((section) => sourceHashOf(section.text));
    const second = splitSections(readFileSync(join(repoRoot, ENGLISH_GUIDE_PATH), 'utf8')).map((section) => sourceHashOf(section.text));
    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThanOrEqual(25);
    expect(first.every((hash) => /^[0-9a-f]{8}$/.test(hash))).toBe(true);
    expect(new Set(first).size).toBe(first.length);
    const report = reportSections(guide, null);
    expect(report.total).toBe(first.length);
    expect(report.counts.missing).toBe(first.length);
  });

  it('keeps the app help-link table in step with the German report without making future staleness a test failure', () => {
    const english = readFileSync(join(repoRoot, ENGLISH_GUIDE_PATH), 'utf8');
    const translation = readFileSync(join(repoRoot, 'docs/i18n/de/USER-GUIDE.md'), 'utf8');
    const report = reportSections(english, translation);
    expect(report.total).toBeGreaterThanOrEqual(25);
    const expected = guideStatusDocument([{ locale: 'de', translation, report }]);
    const committed = JSON.parse(readFileSync(join(repoRoot, GUIDE_STATUS_PATH), 'utf8'));
    expect(committed).toEqual(expected);
    for (const row of report.sections.filter((section) => section.status !== 'current')) {
      expect(committed.locales.de.sections[row.id]).toBeUndefined();
    }
  });
});

describe('the CLI', () => {
  it('stamps a translation on --stamp, and never creates a missing file', () => {
    const root = makeRoot(ENGLISH, GERMAN);
    try {
      const stamped = run(['--root', root, '--stamp', 'de']);
      expect(stamped.status).toBe(0);
      expect(stamped.stdout).toContain('stamped');
      const file = join(root, 'docs', 'i18n', 'de', 'USER-GUIDE.md');
      expect(readFileSync(file, 'utf8')).toContain('<!-- source:');
      expect(reportSections(ENGLISH, readFileSync(file, 'utf8')).counts.current).toBe(3);
      rmSync(file);
      const again = run(['--root', root, '--stamp', 'de']);
      expect(again.status).toBe(0);
      expect(again.stdout).toContain('never creates');
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prints a plain report that never fails, and --check exits 1 on a stale section and 0 when current', () => {
    const root = makeRoot(ENGLISH, stampSourceMarkers(ENGLISH, GERMAN));
    try {
      const plain = run(['--root', root]);
      expect(plain.status).toBe(0);
      expect(plain.stdout).toContain('Guide translation report');
      expect(plain.stdout).toContain('3 current, 0 stale, 0 missing, 0 renamed');
      expect(run(['--root', root, '--check']).status).toBe(0);
      writeFileSync(join(root, ENGLISH_GUIDE_PATH), ENGLISH_EDITED);
      const stalePlain = run(['--root', root]);
      expect(stalePlain.status).toBe(0);
      expect(stalePlain.stdout).toContain('stale');
      const staleCheck = run(['--root', root, '--check']);
      expect(staleCheck.status).toBe(1);
      expect(staleCheck.stderr).toContain('stale');
      const marked = run(['--root', root, '--mark-stale', '--locale', 'de']);
      expect(marked.status).toBe(0);
      expect(readFileSync(join(root, 'docs/i18n/de/USER-GUIDE.md'), 'utf8')).toContain(STALE_BANNER_LINE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports every section missing when no translation exists, and --check still passes', () => {
    const root = makeRoot(ENGLISH, null);
    try {
      rmSync(join(root, 'docs', 'i18n'), { recursive: true, force: true });
      const none = run(['--root', root, '--check']);
      expect(none.status).toBe(0);
      expect(none.stdout).toContain('No translated guides');
      const locale = run(['--root', root, '--locale', 'de', '--check']);
      expect(locale.status).toBe(0);
      expect(locale.stdout).toContain('no file yet');
      expect(locale.stdout).toContain('missing');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prints usage on --help and exits 2 on an unknown argument', () => {
    const help = run(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--check');
    expect(help.stdout).toContain('--stamp');
    expect(run(['--bogus']).status).toBe(2);
  });
});
