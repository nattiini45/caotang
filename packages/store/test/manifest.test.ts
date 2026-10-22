import { describe, expect, it } from 'vitest';
import { createEmptyManifest, isFixedRoot, nextSiblingOrder, serializeManifest, validateManifest } from '../src/index.js';

const doc = (id: string, parentId: string, order: number) => ({
  id,
  parentId,
  type: 'document' as const,
  title: id,
  order,
  status: null,
  label: null,
  keywords: [],
  synopsis: '',
  notes: '',
});

describe('manifest validation', () => {
  it('accepts a freshly created project', () => {
    const m = createEmptyManifest('The Lighthouse Keeper');
    const report = validateManifest(m);
    expect(report.ok, JSON.stringify(report.errors)).toBe(true);
  });

  it('rejects a non-Caotang manifest with "not a Caotang project"', () => {
    const report = validateManifest({ app: 'other' });
    expect(report.ok).toBe(false);
    expect(report.errors[0]?.message).toContain('not a Caotang project');
  });

  it('refuses a future formatVersion instead of guess-upgrading', () => {
    const m = { ...createEmptyManifest('X'), formatVersion: 99 };
    const report = validateManifest(m);
    expect(report.ok).toBe(false);
    expect(report.errors[0]?.message).toContain('newer than this build');
  });

  it('reports the field path of the first violation', () => {
    const m = createEmptyManifest('X');
    (m.tree[1] as { order: number }).order = -1;
    const report = validateManifest(m);
    expect(report.ok).toBe(false);
    expect(report.errors[0]?.path).toBe('tree[1].order');
    expect(report.errors[0]?.message).toContain('expected integer ≥ 0, got -1');
  });

  it('rejects duplicate ids and unresolvable parents', () => {
    const m = createEmptyManifest('X');
    m.tree.push(doc('n_DUPLICATE01', 'manuscript', 10));
    m.tree.push(doc('n_DUPLICATE01', 'n_MISSING0001', 20));
    const report = validateManifest(m);
    expect(report.ok).toBe(false);
    const paths = report.errors.map((e) => e.path);
    expect(paths).toContain('tree[3].id');
    expect(paths).toContain('tree[4].parentId');
  });

  it('detects a parent cycle', () => {
    const m = createEmptyManifest('X');
    m.tree.push(doc('n_Aaaaaaaaaa', 'n_Bbbbbbbbbb', 10));
    m.tree.push(doc('n_Bbbbbbbbbb', 'n_Aaaaaaaaaa', 20));
    const report = validateManifest(m);
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.message.includes('cycle'))).toBe(true);
  });

  it('requires a docs/ file for every document node', () => {
    const m = createEmptyManifest('X');
    m.tree.push(doc('n_3W8RN2TQ6C', 'manuscript', 10));
    const missing = validateManifest(m, { docFiles: [] });
    expect(missing.ok).toBe(false);
    expect(missing.errors.some((e) => e.message.includes('has no docs/'))).toBe(true);

    const present = validateManifest(m, { docFiles: ['n_3W8RN2TQ6C.md'] });
    expect(present.ok, JSON.stringify(present.errors)).toBe(true);
  });

  it('reports orphan docs as imported, never as an error', () => {
    const m = createEmptyManifest('X');
    const report = validateManifest(m, { docFiles: ['n_ORPHAN0001.md'] });
    expect(report.ok).toBe(true);
    expect(report.orphans).toEqual(['n_ORPHAN0001.md']);
  });

  it('keeps an unknown status as a warning, not a data loss', () => {
    const m = createEmptyManifest('X');
    m.tree.push({ ...doc('n_3W8RN2TQ6C', 'manuscript', 10), status: 'polished' });
    const report = validateManifest(m, { docFiles: ['n_3W8RN2TQ6C.md'] });
    expect(report.ok).toBe(true);
    expect(report.warnings.some((w) => w.message.includes('unknown vocabulary id'))).toBe(true);
  });

  it('enforces the keyword and synopsis limits', () => {
    const m = createEmptyManifest('X');
    m.tree.push({
      ...doc('n_3W8RN2TQ6C', 'manuscript', 10),
      keywords: Array.from({ length: 33 }, (_, i) => `k${i}`),
    });
    const report = validateManifest(m, { docFiles: ['n_3W8RN2TQ6C.md'] });
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.message.includes('max 32 per node'))).toBe(true);
  });

  it('tolerates absent codex/filters/goals (additive in v1)', () => {
    const m = createEmptyManifest('X');
    delete m.codex;
    expect(validateManifest(m).ok).toBe(true);
  });
});

/**
 * §2's field table fixes `tree[].id` as `"n_" + 10 base32`, unique, with
 * `root`/`manuscript`/`research` reserved. An id is also a filename, so a
 * manifest carrying `id: "chapter-1"` would resolve to a file the writer can
 * never name — the format contract has to be enforced at load, not trusted from
 * the generator.
 */
describe('tree[].id format (§2 field table)', () => {
  it('rejects an id that is not "n_" + 10 Crockford base32 chars', () => {
    for (const bad of ['garbage', 'chapter-1', 'n_SHORT', 'n_TOOLONG0123456', 'c_3W8RN2TQ6C', 'p_3W8RN2TQ6C']) {
      const m = createEmptyManifest('X');
      m.tree.push(doc(bad, 'manuscript', 10));
      const report = validateManifest(m, { docFiles: [`${bad}.md`] });
      expect(report.ok, `"${bad}" should not validate`).toBe(false);
      expect(report.errors.some((e) => e.path === 'tree[3].id' && e.message.includes('n_" + 10'))).toBe(
        true,
      );
    }
  });

  it('rejects a body with a character outside the Crockford alphabet', () => {
    // I, L, O and U are excluded on purpose so an id can be read aloud (§2/A4).
    const m = createEmptyManifest('X');
    m.tree.push(doc('n_ABCDEFGHIJ', 'manuscript', 10));
    expect(validateManifest(m, { docFiles: ['n_ABCDEFGHIJ.md'] }).ok).toBe(false);
  });

  it('accepts the three reserved root ids and well-formed generated ids', () => {
    const m = createEmptyManifest('X');
    m.tree.push(doc('n_3W8RN2TQ6C', 'manuscript', 10));
    m.tree.push(doc('n_7K2QX9M4A1', 'manuscript', 20));
    const report = validateManifest(m, { docFiles: ['n_3W8RN2TQ6C.md', 'n_7K2QX9M4A1.md'] });
    expect(report.ok, JSON.stringify(report.errors)).toBe(true);
  });
});

describe('project creation helpers', () => {
  it('creates exactly the three fixed roots', () => {
    const m = createEmptyManifest('Book');
    expect(m.tree.map((n) => n.id)).toEqual(['root', 'manuscript', 'research']);
    expect(m.tree[0]?.parentId).toBeNull();
  });

  it('marks fixed roots as non-deletable', () => {
    expect(isFixedRoot('root')).toBe(true);
    expect(isFixedRoot('manuscript')).toBe(true);
    expect(isFixedRoot('n_3W8RN2TQ6C')).toBe(false);
  });

  it('gap-encodes sibling order at max + 10', () => {
    const m = createEmptyManifest('Book');
    expect(nextSiblingOrder(m.tree, 'root')).toBe(30);
    m.tree.push(doc('n_3W8RN2TQ6C', 'manuscript', 10));
    expect(nextSiblingOrder(m.tree, 'manuscript')).toBe(20);
  });
});

describe('the scene style (exporter.md §2, Per-scene styling)', () => {
  const sceneWith = (extra: Record<string, unknown>) => ({ ...doc('n_3W8RN2TQ6C', 'manuscript', 10), ...extra });

  it('is absent from a manifest written before the field existed, which loads without a notice for it', () => {
    const m = createEmptyManifest('X');
    m.tree.push(doc('n_3W8RN2TQ6C', 'manuscript', 10));
    expect(serializeManifest(m)).not.toContain('"style"');
    const report = validateManifest(JSON.parse(serializeManifest(m)), { docFiles: ['n_3W8RN2TQ6C.md'] });
    expect(report.ok).toBe(true);
    expect(report.warnings.filter((w) => w.message.includes('style'))).toEqual([]);
  });

  it('round-trips a known style with no notice', () => {
    const m = createEmptyManifest('X');
    m.tree.push(sceneWith({ style: 'section' }));
    const report = validateManifest(JSON.parse(serializeManifest(m)), { docFiles: ['n_3W8RN2TQ6C.md'] });
    expect(report.ok).toBe(true);
    expect(report.warnings.filter((w) => w.message.includes('style'))).toEqual([]);
    expect(JSON.parse(serializeManifest(m)).tree.at(-1).style).toBe('section');
  });

  it('drops a style that is not a string, with a notice', () => {
    const m = createEmptyManifest('X');
    m.tree.push(sceneWith({ style: 3 }));
    const report = validateManifest(m, { docFiles: ['n_3W8RN2TQ6C.md'] });
    expect(report.ok).toBe(true);
    expect(report.warnings.some((w) => w.message.includes('expected a string'))).toBe(true);
    expect('style' in m.tree.at(-1)!).toBe(false);
  });
});
