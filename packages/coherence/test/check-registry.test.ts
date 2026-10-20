/**
 * The package header and the check registry (coherence.md §5.4).
 *
 * The header counted the checks once, and the registry grew without it: the count drifted and nothing failed. The
 * header now points at the registry, and this test holds it to that.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { DETERMINISTIC_CHECK_IDS } from '../src/index.js';

const HEADER = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8').split('*/')[0] ?? '';

describe('the package header', () => {
  it('points at the check registry instead of counting the checks', () => {
    expect(HEADER).toContain('checks/index.ts');
    expect(HEADER).not.toMatch(/\b(eight|fourteen|eighteen|four|\d+) deterministic checks/);
  });

  it('names every check the closed registry holds', () => {
    expect(DETERMINISTIC_CHECK_IDS).toHaveLength(14);
  });
});
