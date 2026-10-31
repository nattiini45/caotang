/**
 * The synthetic bold of a fallback run (embolden.ts): the stroke width and the character spacing scale with the size, and the width
 * a writer fits to is one spacing per glyph wider than the regular run. The contact sheet's content stream is read back in
 * `packages/exporter/test/contact-sheet-bold.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { EMBOLDEN_RATIO, emboldenOf, emboldenedExtra } from '../src/index.js';

describe('embolden', () => {
  it('strokes 0.025 em and spaces each glyph by the same width', () => {
    expect(EMBOLDEN_RATIO).toBe(0.025);
    expect(emboldenOf(11)).toEqual({ lineWidth: 0.275, spacing: 0.275 });
    expect(emboldenOf(8)).toEqual({ lineWidth: 0.2, spacing: 0.2 });
  });

  it('widens a run by one spacing for each glyph, and an empty run by nothing', () => {
    expect(emboldenedExtra(4, 11)).toBeCloseTo(1.1, 12);
    expect(emboldenedExtra(0, 11)).toBe(0);
  });
});
