/**
 * The fontkit backend of the shaper (shaper.ts) against the spike's golden file (test/fixtures/shaping/): HarfBuzz is the
 * reference, and unmarked Arabic and Hebrew must agree with it, glyph for glyph.
 */

import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Font } from '@pdf-lib/fontkit';
import { openFont } from '../src/fontkit.js';
import { loadArabicFontInNode, loadHebrewFontInNode } from '../src/node-loader.js';
import { withoutMarks } from '../src/rtl-script.js';
import { fontkitShape } from '../src/shaper.js';

interface Glyphs {
  glyphs: { id: number; advance: number; dx: number; dy: number }[];
}
interface Sample {
  category: string;
  font: 'arabic' | 'hebrew';
  text: string;
  harfbuzz: Glyphs;
  fontkit: Glyphs | { error: string };
  same: boolean;
  withoutMarks?: { text: string; harfbuzz: Glyphs; fontkit: Glyphs; same: boolean };
}

const golden = JSON.parse(readFileSync(new URL('./fixtures/shaping/golden.json', import.meta.url), 'utf8')) as { samples: Sample[] };

const fonts: Record<'arabic' | 'hebrew', Font> = {} as Record<'arabic' | 'hebrew', Font>;
beforeAll(async () => {
  fonts.arabic = await openFont(await loadArabicFontInNode());
  fonts.hebrew = await openFont(await loadHebrewFontInNode());
});

const plain = (names: string[]) => golden.samples.filter((sample) => names.includes(sample.category));
const shaped = (sample: { font: 'arabic' | 'hebrew' }, text: string) => fontkitShape(text, fonts[sample.font], 'rtl', sample.font);
const asGolden = (run: ReturnType<typeof fontkitShape>): Glyphs => ({
  glyphs: run.glyphs.map(({ id, advance, dx, dy }) => ({ id, advance, dx, dy })),
});

describe('the spike result', () => {
  it('holds the samples the test below walks', () => {
    expect(golden.samples.length).toBeGreaterThan(70);
  });

  it('says unmarked Arabic and Hebrew agree with HarfBuzz, and that marked text does not always', () => {
    const unmarked = plain(['plain', 'lam-alef', 'persian', 'urdu', 'digits']);
    expect(unmarked.length).toBeGreaterThan(50);
    expect(unmarked.filter((sample) => !sample.same)).toEqual([]);
    const marked = plain(['marks']);
    expect(marked.some((sample) => !sample.same)).toBe(true);
    expect(marked.every((sample) => sample.withoutMarks?.same === true)).toBe(true);
  });
});

describe('fontkitShape', () => {
  it('gives the glyphs, advances and offsets HarfBuzz gives for unmarked text', () => {
    for (const sample of plain(['plain', 'lam-alef', 'persian', 'urdu', 'digits'])) {
      const run = shaped(sample, sample.text);
      expect(run.failed, sample.text).toBeUndefined();
      expect(asGolden(run), sample.text).toEqual(sample.harfbuzz);
    }
  });

  it('gives what HarfBuzz gives for marked text once its marks are left out', () => {
    for (const sample of plain(['marks'])) {
      const bare = withoutMarks(sample.text);
      expect(bare, sample.text).toBe(sample.withoutMarks?.text);
      expect(asGolden(shaped(sample, bare)), sample.text).toEqual(sample.withoutMarks?.harfbuzz);
    }
  });

  it('is what the golden file recorded for marked text, so a change of engine or font shows', () => {
    for (const sample of plain(['marks'])) {
      const run = shaped(sample, sample.text);
      if ('error' in sample.fontkit) expect(run.failed, sample.text).toBeDefined();
      else expect(asGolden(run), sample.text).toEqual(sample.fontkit);
    }
  });

  it('picks the joining form from the neighbours: a letter in the middle of a word is not the glyph of the letter alone', () => {
    const bases = (text: string) => fontkitShape(text, fonts.arabic, 'rtl', 'arabic').glyphs.filter((glyph) => glyph.advance > 0).map((glyph) => glyph.id);
    const [alone] = bases('ب');
    const word = bases('ببب');
    expect(word).toHaveLength(3);
    expect(new Set(word).size).toBe(3);
    expect(word).not.toContain(alone);
  });

  it('lists the glyphs of a word right to left in visual order, with the advance summed', () => {
    const run = fontkitShape('السلام', fonts.arabic, 'rtl', 'arabic');
    expect(run.advance).toBe(run.glyphs.reduce((sum, glyph) => sum + glyph.advance, 0));
    expect(run.advance).toBeGreaterThan(0);
    // The first letter of the word (alef) is the right-most glyph, so it is the last one listed.
    expect(run.glyphs[run.glyphs.length - 1]?.text).toBe('ا');
  });

  it('reports an engine failure as a run with no glyphs, never as a throw', () => {
    const run = fontkitShape('بِسْمِ اللّٰهِ', fonts.arabic, 'rtl', 'arabic');
    expect(run.glyphs).toEqual([]);
    expect(run.failed).toMatch(/undefined/);
  });
});
