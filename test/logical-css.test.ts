/**
 * The physical-CSS guard (I8 / #195): the app is inside its seeded allowlist, and the fixtures prove
 * that a new physical declaration fails even in a file the allowlist already knows.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ALLOWLIST_FILE,
  APP_ROOT,
  compareToAllowlist,
  lowerAllowlist,
  makeAllowlist,
  readAllowlist,
  renderAllowlist,
  scanCss,
  scanInlineStyles,
  scanTree,
} from '../tools/logical-css.mjs';

const repoRoot = resolve(__dirname, '..');
const fixtureRoot = resolve(repoRoot, 'test/fixtures/i18n-guards/css');

function read(name: string): string {
  return readFileSync(resolve(fixtureRoot, name), 'utf8');
}

describe('the seeded allowlist', () => {
  it('covers every physical declaration in the app and is a real measurement, not an empty pass', () => {
    const tree = scanTree(resolve(repoRoot, APP_ROOT));
    const allowlist = readAllowlist(resolve(repoRoot, ALLOWLIST_FILE));
    expect(tree.occurrences.length).toBeGreaterThan(60);
    expect(allowlist.entries.length).toBeGreaterThan(60);
    expect(compareToAllowlist(tree.occurrences, allowlist)).toEqual([]);
  });

  it('serialises entries in a stable order', () => {
    const allowlist = makeAllowlist([
      { file: 'z.css', context: '.z', property: 'left', line: 1 },
      { file: 'a.css', context: '.a', property: 'margin-left', line: 1 },
    ]);
    expect(renderAllowlist(allowlist)).toBe(renderAllowlist(allowlist));
    expect(renderAllowlist(allowlist).indexOf('a.css')).toBeLessThan(renderAllowlist(allowlist).indexOf('z.css'));
  });
});

describe('the scanner', () => {
  it('finds physical properties and direction values, including inside an at-rule', () => {
    const occurrences = scanCss(read('physical.css'), 'physical.css');
    expect(occurrences.map((occurrence) => occurrence.property)).toEqual(['margin-left', 'text-align=right', 'padding-right']);
    expect(occurrences[1]?.context).toBe('.card');
    expect(occurrences[2]?.context).toBe('@media (min-width: 10px) | .card');
  });

  it('finds nothing in logical CSS', () => {
    expect(scanCss(read('logical.css'), 'logical.css')).toEqual([]);
  });

  it('finds a physical inline style', () => {
    const occurrences = scanInlineStyles('Inline.tsx', read('Inline.tsx'), 'Inline.tsx');
    expect(occurrences.map((occurrence) => occurrence.property)).toEqual(['marginLeft', 'text-align=right']);
  });
});

describe('the allowlist is per declaration, never per file or module', () => {
  it('fails a physical declaration with an empty allowlist', () => {
    const occurrences = scanCss(read('physical.css'), 'physical.css');
    const problems = compareToAllowlist(occurrences, { version: 1, entries: [] });
    expect(problems).toEqual([
      expect.stringContaining('physical.css:2: margin-left in .card'),
      expect.stringContaining('physical.css:3: text-align=right in .card'),
      expect.stringContaining('physical.css:8: padding-right in @media (min-width: 10px) | .card'),
    ]);
  });

  it('still fails the other declarations when one in the same selector is allowed', () => {
    const occurrences = scanCss(read('physical.css'), 'physical.css');
    const allowlist = makeAllowlist([occurrences[0]!]);
    const problems = compareToAllowlist(occurrences, allowlist);
    expect(problems).toEqual([
      expect.stringContaining('text-align=right in .card'),
      expect.stringContaining('padding-right in @media (min-width: 10px) | .card'),
    ]);
  });

  it('passes when every declaration has its own entry', () => {
    const occurrences = scanCss(read('physical.css'), 'physical.css');
    expect(compareToAllowlist(occurrences, makeAllowlist(occurrences))).toEqual([]);
  });

  it('lowers and prunes, and refuses to add a new occurrence', () => {
    const before = scanCss(read('physical.css'), 'physical.css');
    const allowlist = makeAllowlist(before);
    const after = scanCss('.card { margin-left: 1px; }', 'physical.css');
    const lowered = lowerAllowlist(after, allowlist);
    expect(lowered.problems).toEqual([]);
    expect(lowered.allowlist.entries).toEqual([
      { file: 'physical.css', context: '.card', property: 'margin-left', count: 1 },
    ]);

    const added = scanCss('.card { margin-left: 1px; padding-right: 2px; }', 'physical.css');
    const refused = lowerAllowlist(added, allowlist);
    expect(refused.problems).toEqual([expect.stringContaining('new physical direction declaration (padding-right')]);
  });
});
