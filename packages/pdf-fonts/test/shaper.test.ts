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
import { blankGlyphOf, clusterTexts, fontkitShape, shapeKeepingMarks, withMarkGlyphs } from '../src/shaper.js';

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

describe('the text of each glyph (what a reader copies)', () => {
  /** What a reader puts together from a right-to-left run drawn left to right: the glyphs' texts, last drawn first. */
  const copied = (run: ReturnType<typeof fontkitShape>) => [...run.glyphs].reverse().map((glyph) => glyph.text).join('');

  it('is the letters of the text, in order, for every unmarked sample of the spike, whatever the cache of the engine remembers', () => {
    const unmarked = plain(['plain', 'lam-alef', 'persian', 'urdu', 'digits']);
    for (const sample of unmarked) {
      const run = shaped(sample, sample.text);
      expect(copied(run), sample.text).toBe([...sample.text].filter((ch) => ch !== '\u200c' && ch !== '\u200d').join(''));
    }
  });

  it('gives the text to the glyph that advances, and none to the dots and blanks the font draws as glyphs of their own', () => {
    // Noto Sans Arabic draws a dotted letter as a skeleton and a positioned dot with no advance (sheen is one, teh marbuta another).
    const run = fontkitShape('سارة', fonts.arabic, 'rtl', 'arabic');
    expect(run.glyphs.some((glyph) => glyph.advance === 0)).toBe(true);
    for (const glyph of run.glyphs) expect(glyph.text === '', glyph.id + ' advances ' + glyph.advance).toBe(glyph.advance === 0);
    // The engine's own report of a glyph's code points is the first text that used the glyph: a beh in the middle of a word was a
    // noon, or a yeh. The text is the letter that was typed, in each word.
    expect(copied(fontkitShape('دنيا', fonts.arabic, 'rtl', 'arabic'))).toBe('دنيا');
    expect(copied(fontkitShape('دبيا', fonts.arabic, 'rtl', 'arabic'))).toBe('دبيا');
    expect(copied(fontkitShape('عليكم', fonts.arabic, 'rtl', 'arabic'))).toBe('عليكم');
    expect(copied(fontkitShape('غرفة', fonts.arabic, 'rtl', 'arabic'))).toBe('غرفة');
  });

  it('puts a whole run on its first advancing glyph when the glyphs cannot be matched to the letters, so nothing is split or lost', () => {
    // Two letters, one glyph: a ligature of the font.
    expect(clusterTexts([500], 'لا', 'rtl')).toEqual(['لا']);
    // Four glyphs, three of them advancing, for two letters.
    expect(clusterTexts([0, 300, 300, 300], 'اب', 'ltr')).toEqual(['', 'اب', '', '']);
    expect(clusterTexts([300, 300, 300, 0], 'اب', 'rtl')).toEqual(['', '', 'اب', '']);
  });

  it('leaves the marks and the joiners to withMarkGlyphs', () => {
    expect(clusterTexts([300, 300], 'ب\u200cا', 'ltr')).toEqual(['ب', 'ا']);
    expect(clusterTexts([300, 300], 'بَا', 'ltr')).toEqual(['ب', 'ا']);
  });
});

describe('the text of the marks and joiners that are not drawn', () => {
  const blank = 3;
  const glyph = (id: number, text: string, advance = 300) => ({ id, advance, dx: 0, dy: 0, text });
  const texts = (glyphs: readonly { id: number; text: string }[]) => glyphs.map((entry) => `${entry.id}:${entry.text}`);

  it('is returned as it was when there is none', () => {
    const glyphs = [glyph(10, 'ب')];
    expect(withMarkGlyphs(glyphs, 'ب', 'rtl', blank)).toBe(glyphs);
  });

  it('puts a mark after its letter in the logical order: before the letter, in the order the glyphs are drawn, for a right-to-left run', () => {
    // بِسْم: drawn left to right, meem, seen, beh.
    const drawn = [glyph(30, 'م'), glyph(20, 'س'), glyph(10, 'ب')];
    const run = withMarkGlyphs(drawn, 'بِسْم', 'rtl', blank);
    expect(texts(run)).toEqual(['30:م', '3:ْ', '20:س', '3:ِ', '10:ب']);
    // A reader that reverses the right-to-left word character by character gets the typed text, marks after their letters.
    expect([...run].reverse().map((entry) => entry.text).join('')).toBe('بِسْم');
    // The mark glyphs draw nothing and advance nothing.
    expect(run.filter((entry) => entry.id === blank).every((entry) => entry.advance === 0 && entry.dx === 0 && entry.dy === 0)).toBe(true);
  });

  it('puts the marks of a left-to-right run after the letter in the order drawn, and a mark at the start first', () => {
    const run = withMarkGlyphs([glyph(10, 'a'), glyph(11, 'b')], 'ًaَb', 'ltr', blank);
    expect(texts(run)).toEqual(['3:ً', '10:a', '3:َ', '11:b']);
  });

  it('keeps a zero-width non-joiner, which the shaper gives no letter, after the letter before it', () => {
    const run = withMarkGlyphs([glyph(20, 'ب'), glyph(10, 'م')], 'م\u200cب', 'rtl', blank);
    expect([...run].reverse().map((entry) => entry.text).join('')).toBe('م\u200cب');
  });

  it('puts every mark of a letter after it, in order, and follows the letter that owns a cluster the font draws as several glyphs', () => {
    // Glyphs: a dot (no text) and the skeleton of the one letter, then a second letter; two marks on the first.
    const drawn = [glyph(5, 'ب'), glyph(9, '', 0), glyph(7, 'ا')];
    const run = withMarkGlyphs(drawn, 'اَّب', 'rtl', blank);
    expect([...run].reverse().map((entry) => entry.text).join('')).toBe('اَّب');
  });

  it('returns the glyphs as they were when their texts are not the letters of the source', () => {
    const drawn = [glyph(1, 'x')];
    expect(withMarkGlyphs(drawn, 'بَ', 'rtl', blank)).toBe(drawn);
  });

  it('is what an engine that takes a text with its marks does: the bare text shaped, the marks as glyphs that draw nothing', () => {
    const keeping = shapeKeepingMarks(fontkitShape);
    const text = 'بِسْمِ اللّٰهِ';
    // fontkit throws on this text as typed; the marks are left out of what it shapes.
    expect(fontkitShape(text, fonts.arabic, 'rtl', 'arabic').failed).toBeDefined();
    const run = keeping(text, fonts.arabic, 'rtl', 'arabic');
    expect(run.failed).toBeUndefined();
    expect([...run.glyphs].reverse().map((entry) => entry.text).join('')).toBe(text);
    expect(run.advance).toBe(fontkitShape(withoutMarks(text), fonts.arabic, 'rtl', 'arabic').advance);
    // A text without marks is the engine's own result, and a failure is passed on.
    expect(keeping('سلام', fonts.arabic, 'rtl', 'arabic')).toEqual(fontkitShape('سلام', fonts.arabic, 'rtl', 'arabic'));
    expect(shapeKeepingMarks(() => ({ glyphs: [], advance: 0, failed: 'no' }))('بِ', fonts.arabic, 'rtl', 'arabic').failed).toBe('no');
  });

  it('borrows the glyph a font draws for a space', () => {
    expect(blankGlyphOf(fonts.arabic)).toBeGreaterThan(0);
    expect(blankGlyphOf(fonts.hebrew)).toBeGreaterThan(0);
  });
});
