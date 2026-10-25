/**
 * The hardcoded-string ratchet (I8 / #195): the real tree is inside its committed baseline, and the
 * fixtures prove each failure mode. The fixtures live under `test/fixtures/i18n-guards/`, outside
 * `apps/desktop/src`, so the real scan never sees them.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BASELINE_FILE,
  KINDS,
  UI_ROOT,
  compareToBaseline,
  lowerBaseline,
  makeBaseline,
  readBaseline,
  renderBaseline,
  scanSource,
  scanTree,
  seedBaseline,
  summarise,
  type Baseline,
  type FileCounts,
  type ScanTree,
} from '../tools/check-ui-strings.mjs';

const repoRoot = resolve(__dirname, '..');
const fixtureRoot = resolve(repoRoot, 'test/fixtures/i18n-guards/ui-strings');

function read(name: string): string {
  return readFileSync(resolve(fixtureRoot, name), 'utf8');
}

function countsOf(sites: readonly { kind: string }[]): FileCounts {
  return Object.fromEntries(KINDS.map((kind) => [kind, sites.filter((site) => site.kind === kind).length])) as FileCounts;
}

function treeOf(files: readonly { file: string; counts: FileCounts }[]): ScanTree {
  return { root: '(test)', files: files.map((file) => ({ ...file, modelFacing: false })), sites: [] };
}

const empty = (): FileCounts => ({ jsxText: 0, attribute: 0, literal: 0, template: 0 });

/** Runs a test body against a fresh temporary directory, removed whatever it writes. */
function withTempDir(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'caotang-ratchet-'));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('the committed baseline', () => {
  it('covers the real tree: no file has more unwrapped sites than its allowance', () => {
    const tree = scanTree(resolve(repoRoot, UI_ROOT));
    const baseline = readBaseline(resolve(repoRoot, BASELINE_FILE));
    // Control: the scan found the interface. An empty tree would make both sides agree on nothing.
    expect(summarise(tree).sites).toBeGreaterThan(1_000);
    expect(compareToBaseline(tree, baseline)).toEqual([]);
  });

  it('is serialised with sorted keys and no timestamp, so a rerun does not churn the file', () => {
    const baseline: Baseline = {
      version: 1,
      root: UI_ROOT,
      files: { 'z.tsx': { ...empty(), literal: 1 }, 'a.tsx': { ...empty(), jsxText: 1 } },
    };
    const rendered = renderBaseline(baseline);
    expect(rendered.indexOf('"a.tsx"')).toBeLessThan(rendered.indexOf('"z.tsx"'));
    expect(rendered).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(JSON.parse(rendered)).toEqual(baseline);
  });
});

describe('the inventory', () => {
  it('counts a hardcoded ARIA label, a title, a placeholder and an imperative textContent string', () => {
    const scan = scanSource('hardcoded.tsx', read('hardcoded.tsx'));
    expect(countsOf(scan.sites)).toEqual({ jsxText: 1, attribute: 3, literal: 1, template: 1 });
    expect(scan.sites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'attribute', text: 'Close dialog' }),
        expect.objectContaining({ kind: 'attribute', text: 'Search projects' }),
        expect.objectContaining({ kind: 'literal', text: 'No projects here yet' }),
        expect.objectContaining({ kind: 'jsxText', text: 'Choose a project to begin.' }),
        expect.objectContaining({ kind: 'template', text: '{…} projects selected' }),
      ]),
    );
    expect(scan.sites.some((site) => site.text === 'application/json')).toBe(false);
  });

  it('counts nothing in a file where every string is already a message', () => {
    const scan = scanSource('wrapped.tsx', read('wrapped.tsx'));
    expect(scan.sites).toEqual([]);
  });

  it('counts a prose template but not a path or class-name template', () => {
    const scan = scanSource('templates.tsx', read('templates.tsx'));
    expect(countsOf(scan.sites)).toEqual({ jsxText: 0, attribute: 0, literal: 0, template: 1 });
    expect(scan.sites[0]?.text).toBe('{…} items selected');
  });
});

describe('the ratchet', () => {
  it('refuses a new file with no baseline entry: its allowance is zero', () => {
    const baseline: Baseline = { version: 1, root: UI_ROOT, files: {} };
    const problems = compareToBaseline(treeOf([{ file: 'New.tsx', counts: { ...empty(), jsxText: 1 } }]), baseline);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('new file has an allowance of zero');
    expect(problems[0]).toContain('wrap the string in t');
  });

  it('refuses an increase in one kind even when another kind went down', () => {
    const baseline: Baseline = { version: 1, root: UI_ROOT, files: { 'a.tsx': { ...empty(), jsxText: 2, literal: 1 } } };
    const problems = compareToBaseline(treeOf([{ file: 'a.tsx', counts: { ...empty(), jsxText: 3, literal: 0 } }]), baseline);
    expect(problems).toEqual([expect.stringContaining('jsxText 3 exceeds the baseline allowance 2; wrap the string in t')]);
  });

  it('accepts a lower count: the baseline only ever goes down', () => {
    const baseline: Baseline = { version: 1, root: UI_ROOT, files: { 'a.tsx': { ...empty(), jsxText: 2 } } };
    expect(compareToBaseline(treeOf([{ file: 'a.tsx', counts: { ...empty(), jsxText: 1 } }]), baseline)).toEqual([]);
  });

  it('reports both sides of a rename, so the allowance cannot silently move to a new path', () => {
    const baseline: Baseline = { version: 1, root: UI_ROOT, files: { 'old.tsx': { ...empty(), jsxText: 1 } } };
    const problems = compareToBaseline(treeOf([{ file: 'new.tsx', counts: { ...empty(), jsxText: 1 } }]), baseline);
    expect(problems).toEqual([
      expect.stringContaining('new.tsx: 1 unwrapped user-facing site(s)'),
      expect.stringContaining('old.tsx: stale baseline entry'),
    ]);
  });

  it('fails when a baselined file is marked model-facing, until --write prunes the allowance', () => {
    const baseline: Baseline = { version: 1, root: UI_ROOT, files: { 'a.tsx': { ...empty(), jsxText: 1 } } };
    const tree: ScanTree = {
      root: '(test)',
      files: [{ file: 'a.tsx', modelFacing: true, counts: empty() }],
      sites: [],
    };
    expect(compareToBaseline(tree, baseline)).toEqual([
      expect.stringContaining('a.tsx: marked model-facing, but the baseline still allows 1 site(s)'),
    ]);
    const lowered = lowerBaseline(tree, baseline);
    expect(lowered.problems).toEqual([]);
    expect(lowered.baseline.files).toEqual({});
  });

  it('seeds a baseline only when the file is absent', () => {
    const tree = treeOf([{ file: 'a.tsx', counts: { ...empty(), jsxText: 1 } }]);
    withTempDir((directory) => {
      const path = join(directory, 'baseline.json');
      const seeded = seedBaseline(path, tree);
      expect(seeded.ok).toBe(true);
      expect(readBaseline(path)).toEqual(makeBaseline(tree));
    });
  });

  it('refuses to seed over an existing baseline, so --init cannot raise the ratchet', () => {
    const tree = treeOf([{ file: 'a.tsx', counts: { ...empty(), jsxText: 1 } }]);
    withTempDir((directory) => {
      const path = join(directory, 'baseline.json');
      const existing = '{"version":1,"root":"apps/desktop/src","files":{}}\n';
      writeFileSync(path, existing);
      const seeded = seedBaseline(path, tree);
      expect(seeded).toEqual({ ok: false, message: `${BASELINE_FILE} exists; lower it with --write` });
      expect(readFileSync(path, 'utf8')).toBe(existing);
    });
  });

  it('builds a baseline from the measured tree, omitting files with no sites', () => {
    const tree = {
      root: UI_ROOT,
      files: [
        { file: 'a.tsx', modelFacing: false, counts: { ...empty(), jsxText: 1 } },
        { file: 'b.tsx', modelFacing: false, counts: empty() },
      ],
      sites: [],
    };
    expect(makeBaseline(tree)).toEqual({ version: 1, root: UI_ROOT, files: { 'a.tsx': { ...empty(), jsxText: 1 } } });
  });
});
