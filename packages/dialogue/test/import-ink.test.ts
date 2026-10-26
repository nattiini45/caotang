import { describe, expect, it } from 'vitest';

import { compileInk, exportCsv, lineIdsOf, mintImportIds, missingLineIds, planInkImport, type ImportedContainer } from '../src/index.js';
import { WHOLE_STORY } from './fixtures.js';

/** A deterministic byte source: the same seed gives the same ids, every run. */
function seeded(seed: number): (n: number) => Uint8Array {
  let x = seed >>> 0;
  return (n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      out[i] = (x >>> 24) & 0xff;
    }
    return out;
  };
}

const compiles = (body: string): boolean => compileInk(body).ok;
const container = (title: string, body: string): ImportedContainer => ({ title, knots: [title], body });
const sourcesOf = (containers: readonly ImportedContainer[]) => containers.map((c, i) => ({ id: `c${i}`, title: c.title, body: c.body }));

describe('planInkImport on a whole story', () => {
  const plan = planInkImport(WHOLE_STORY);

  it('plans bodies that compile and carry no line id: the import keeps the Ink as written', () => {
    expect(plan.containers.length).toBeGreaterThan(1);
    for (const c of plan.containers) {
      expect(compiles(c.body), c.title).toBe(true);
      expect(lineIdsOf(c.body), c.title).toEqual([]);
    }
  });
});

describe('mintImportIds', () => {
  const plan = planInkImport(WHOLE_STORY);

  it('gives every speakable line and choice an id, keeps every body compiling, and repeats no id across containers', () => {
    const result = mintImportIds(plan.containers, { randomBytes: seeded(1), compiles });
    expect(result.minted).toBeGreaterThan(3);
    expect(result.unplaceable).toEqual([]);
    expect(result.duplicatesInSource).toEqual([]);
    expect(result.kept).toEqual([]);
    for (const c of result.containers) {
      expect(compiles(c.body), c.title).toBe(true);
      expect(missingLineIds(c.body), c.title).toEqual([]);
    }
    const ids = result.containers.flatMap((c) => lineIdsOf(c.body).map((l) => l.lineId));
    expect(ids).toHaveLength(result.minted);
    expect(new Set(ids).size).toBe(ids.length);
    expect(exportCsv(sourcesOf(result.containers)).ok).toBe(true);
  });

  it('draws every container from one taken set: a source that repeats its first draw still mints distinct ids', () => {
    const fresh = seeded(8);
    let draws = 0;
    const repeating = (n: number): Uint8Array => {
      draws += 1;
      return draws <= 2 ? new Uint8Array(n) : fresh(n);
    };
    const twice = [container('a', '=== a ===\nOne.\n-> END\n'), container('b', '=== b ===\nTwo.\n-> END\n')];
    const result = mintImportIds(twice, { randomBytes: repeating });
    const ids = result.containers.flatMap((c) => lineIdsOf(c.body).map((l) => l.lineId));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('keeps ids the source already holds, and avoids ids the caller says the project holds', () => {
    const tagged = container('a', '=== a ===\nOne. # lineId: l_00000000AA\nTwo.\n-> END\n');
    const taken = new Set(['l_1111111111']);
    const result = mintImportIds([tagged], { randomBytes: seeded(2), taken });
    const ids = lineIdsOf(result.containers[0]?.body ?? '').map((l) => l.lineId);
    expect(ids).toHaveLength(2);
    expect(ids).toContain('l_00000000AA');
    expect(result.minted).toBe(1);
  });

  it('names a line that cannot take an id with its container and line, and leaves that line without one', () => {
    const stuck = container('Gate', '=== Gate ===\nAlice: Hi.\n* [Yes] Oh yes. -> END\n');
    const result = mintImportIds([stuck], { randomBytes: seeded(3), compiles });
    expect(result.unplaceable).toEqual([{ title: 'Gate', line: 3, text: 'Oh yes.' }]);
    expect(result.containers[0]?.body).toContain('] Oh yes. -> END');
    expect(compiles(result.containers[0]?.body ?? '')).toBe(true);
  });

  it('reports an id the source holds in two containers, and renames neither', () => {
    const a = container('a', '=== a ===\nOne. # lineId: l_00000000AA\n-> END\n');
    const b = container('b', '=== b ===\nTwo. # lineId: l_00000000AA\nThree.\n-> END\n');
    const result = mintImportIds([a, b], { randomBytes: seeded(4) });
    expect(result.duplicatesInSource).toEqual(['l_00000000AA']);
    expect(result.containers[0]?.body).toBe(a.body);
    expect(result.containers[1]?.body.startsWith('=== b ===\nTwo. # lineId: l_00000000AA\nThree. # lineId: l_')).toBe(true);
  });

  it('leaves a container as written, and says so, when the minted text would not compile', () => {
    const good = container('a', '=== a ===\nOne.\n-> END\n');
    const result = mintImportIds([good], { randomBytes: seeded(5), compiles: (body) => !body.includes('lineId') });
    expect(result.kept).toEqual(['a']);
    expect(result.minted).toBe(0);
    expect(result.containers[0]?.body).toBe(good.body);
  });

  it('changes nothing in a story that has every id already, and is idempotent', () => {
    const first = mintImportIds(plan.containers, { randomBytes: seeded(6) });
    const second = mintImportIds(first.containers, { randomBytes: seeded(7) });
    expect(second.minted).toBe(0);
    expect(second.containers.map((c) => c.body)).toEqual(first.containers.map((c) => c.body));
  });
});
