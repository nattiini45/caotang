/**
 * The translation report (L11 / #202): thresholds, credits from Git, and a disposable contributor fixture walked from a PO edit to the report.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { creditsOf, gateOf, renderReport, reportFor } from '../tools/translation-report.mjs';

const PO = (translated: boolean): string =>
  [
    'msgid ""',
    'msgstr ""',
    '"Content-Type: text/plain; charset=utf-8\n"',
    '"Language: de\n"',
    '',
    'msgid "Save"',
    `msgstr "${translated ? 'Speichern' : ''}"`,
    '',
    'msgid "Cancel"',
    'msgstr "Abbrechen"',
    '',
  ].join('\n');

describe('the picker gate in the report', () => {
  it('reads 95, 60, 59, 55 and 54 per decision D5, with hysteresis only for a listed language', () => {
    expect(gateOf(95)).toBe('plain');
    expect(gateOf(94.9)).toBe('preview');
    expect(gateOf(60)).toBe('preview');
    expect(gateOf(59)).toBe('hidden');
    expect(gateOf(59, true)).toBe('preview (kept by hysteresis)');
    expect(gateOf(55, true)).toBe('preview (kept by hysteresis)');
    expect(gateOf(54, true)).toBe('hidden');
  });
});

describe('credits', () => {
  it('count commits per author, most first, and skip blank lines', () => {
    expect(creditsOf('Ada\nGrace\n\nAda\n')).toEqual([
      { name: 'Ada', commits: 2 },
      { name: 'Grace', commits: 1 },
    ]);
  });

  it('say so when no language is shipped', () => {
    expect(renderReport({ locales: {} }, () => [], '0.9.0')).toContain('nothing to report yet');
  });
});

describe('a disposable contributor fixture', () => {
  it('goes from a PO edit committed by a contributor to completion and credit in the report', () => {
    const root = mkdtempSync(join(tmpdir(), 'caotang-translate-'));
    try {
      const folder = join(root, 'apps/desktop/src/i18n/locales');
      for (const tag of ['en', 'de']) mkdirSync(join(folder, tag), { recursive: true });
      writeFileSync(join(folder, 'en/messages.po'), PO(true).replace('Language: de', 'Language: en'));
      writeFileSync(join(folder, 'de/messages.po'), PO(false));
      const git = (...args: string[]): void => {
        execFileSync('git', ['-c', 'user.name=Ada Translator', '-c', 'user.email=ada@example.org', ...args], { cwd: root });
      };
      git('init', '-q');
      git('add', '.');
      git('commit', '-q', '-m', 'Start the German catalogue');
      expect(reportFor(root)).toContain('| de | 2 | 1 | 1 | 0 | 50 % | hidden |');
      writeFileSync(join(folder, 'de/messages.po'), PO(true));
      git('commit', '-q', '-am', 'Translate Save');
      const report = reportFor(root, '1.0.0');
      expect(report).toContain('# Translation report: 1.0.0');
      expect(report).toContain('| de | 2 | 2 | 0 | 0 | 100 % | plain |');
      expect(report).toContain('- Ada Translator (2 commits)');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
