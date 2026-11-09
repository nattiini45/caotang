import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { measureWork } from './support/measure-work.js';

describe('the deterministic reader work counter', { timeout: 120_000 }, () => {
  it('counts nested loops, callback visits, and repeated native suffix searches', () => {
    const results = measureWork(`
      export function loops(n: number) {
        let total = 0;
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) total++;
        return total;
      }
      export function callbacks(n: number) {
        return Array.from({ length: n }, (_, i) => i).map(i => i + 1).length;
      }
      export function suffix(n: number) {
        const text = 'a'.repeat(n);
        for (let i = 0; i < n; i++) text.indexOf('b', i);
        return n;
      }
    `, [
      { name: 'loops', args: [10] }, { name: 'loops', args: [40] },
      { name: 'callbacks', args: [10] }, { name: 'callbacks', args: [40] },
      { name: 'suffix', args: [10] }, { name: 'suffix', args: [40] },
    ]);
    expect(results.map(({ result }) => result)).toEqual([100, 1600, 10, 40, 10, 40]);
    expect(results[1]!.steps / results[0]!.steps).toBeGreaterThan(14);
    expect(results[3]!.steps / results[2]!.steps).toBeGreaterThan(3);
    expect(results[5]!.scanned / results[4]!.scanned).toBeGreaterThan(14);
  });

  it.each(['^a+a+b', 'a+b', '^a+\\s*(?<=a)a+b'])('detects polynomial backtracking in %s', (pattern) => {
    const results = measureWork(`
      export function match(text: string) { return new RegExp(${JSON.stringify(pattern)}, 'iu').test(text); }
    `, [{ name: 'match', args: ['a'.repeat(32)] }, { name: 'match', args: ['a'.repeat(128)] }]);
    expect(results.map(({ result }) => result)).toEqual([false, false]);
    expect(results[1]!.backtracks / results[0]!.backtracks).toBeGreaterThan(10);
  });

  it.each(['^a+a+b', 'a+a+b'])('refuses %s when it exhausts the linear work ceiling', (pattern) => {
    expect(() => measureWork(`export function match(text: string) { return new RegExp(${JSON.stringify(pattern)}, 'iu').test(text); }`, [
      { name: 'match', args: ['a'.repeat(1024)] },
    ])).toThrow('The regex work ceiling was exceeded');
  });

  it('detects restoring the XML duplicate-attribute scan', () => {
    const original = readFileSync(new URL('../packages/import-read/src/xml.ts', import.meta.url), 'utf8');
    const quadratic = original.replace('seen.has(attrName)', 'raw.some((a) => a.name === attrName)');
    expect(quadratic).not.toBe(original);
    const results = measureWork(quadratic, [128, 512].map((n) => ({
      name: 'readXml',
      args: [`<a ${Array.from({ length: n }, (_, i) => `x${i}="1"`).join(' ')} x0="2"/>`],
    })));
    expect(results[1]!.steps / results[0]!.steps).toBeGreaterThan(10);
    for (const { result } of results) expect(result).toMatchObject({ ok: false, error: { code: 'duplicate-attribute' } });
  });

  it('preserves global, sticky, split, replacement and no-match results', () => {
    const source = `export function run() {
      const g = /a/gu;
      const y = /a/yu;
      g.lastIndex = 9;
      y.lastIndex = 1;
      return ['ab'.split(/b/u), 'ab'.replace(/b/u, 'c'), /z/u.exec('ab'), g.exec('a'), y.exec('ba'), y.lastIndex];
    }`;
    expect(measureWork(source, [{ name: 'run', args: [] }])[0]!.result).toEqual([['a', ''], 'ac', null, null, ['a'], 2]);
  });
});
