/**
 * The bidirectional algorithm of bidi.ts: the levels and the line reordering against a slice of Unicode's
 * BidiCharacterTest.txt, then the paragraph direction (P2, P3) and the runs a line is drawn as (L2, L4).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { embeddingLevels, languageDirection, mirrored, paragraphDirection, visualOrder, visualRuns } from '../src/bidi.js';

interface Case {
  readonly line: number;
  readonly text: string;
  readonly direction: 'ltr' | 'rtl' | 'auto';
  readonly paragraphLevel: number;
  /** The resolved level of each code point, or null where rule X9 removed it. */
  readonly levels: readonly (number | null)[];
  /** The indices of the code points left to right, the removed ones skipped. */
  readonly order: readonly number[];
}

function readCases(): Case[] {
  const file = readFileSync(new URL('./fixtures/bidi-character-test-13.0.0-slice.txt', import.meta.url), 'utf8');
  const cases: Case[] = [];
  file.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const [codes = '', direction = '', level = '', levels = '', order = ''] = line.split(';');
    cases.push({
      line: index + 1,
      text: String.fromCodePoint(...codes.split(' ').map((code) => parseInt(code, 16))),
      direction: direction === '0' ? 'ltr' : direction === '1' ? 'rtl' : 'auto',
      paragraphLevel: Number(level),
      levels: levels.split(' ').map((value) => (value === 'x' ? null : Number(value))),
      order: order === '' ? [] : order.split(' ').map(Number),
    });
  });
  return cases;
}

const cases = readCases();

describe('BidiCharacterTest.txt (Unicode 13.0.0, a slice)', () => {
  it('holds the examples of UAX #9 and several hundred more cases', () => {
    expect(cases.length).toBeGreaterThan(400);
  });

  it('gives the paragraph level and the level of every code point the test lists', () => {
    for (const test of cases) {
      const { levels, paragraphLevel } = embeddingLevels(test.text, test.direction);
      expect(paragraphLevel, `line ${test.line}`).toBe(test.paragraphLevel);
      test.levels.forEach((level, index) => {
        if (level !== null) expect(levels[index], `line ${test.line}, code point ${index}`).toBe(level);
      });
    }
  });

  it('orders the code points of the line as the test lists them (rule L2)', () => {
    for (const test of cases) {
      const { levels } = embeddingLevels(test.text, test.direction);
      const order = visualOrder(levels).filter((index) => test.levels[index] !== null);
      expect(order, `line ${test.line}`).toEqual(test.order);
    }
  });
});

describe('paragraphDirection (rules P2 and P3)', () => {
  it('is the direction of the first strong character', () => {
    expect(paragraphDirection('שלום world')).toBe('rtl');
    expect(paragraphDirection('world שלום')).toBe('ltr');
    expect(paragraphDirection('  (123) مرحبا')).toBe('rtl');
    expect(paragraphDirection('"Hello," قال')).toBe('ltr');
  });

  it('skips what an isolate holds', () => {
    expect(paragraphDirection('\u2067abc\u2069 שלום')).toBe('rtl');
    expect(paragraphDirection('\u2067שלום\u2069 abc')).toBe('ltr');
  });

  it('takes the neutral direction when no character is strong, and LTR when none is given', () => {
    expect(paragraphDirection('(...) 42', 'rtl')).toBe('rtl');
    expect(paragraphDirection('(...) 42')).toBe('ltr');
    expect(paragraphDirection('', 'rtl')).toBe('rtl');
    // A strong character wins over the neutral direction.
    expect(paragraphDirection('Hello', 'rtl')).toBe('ltr');
  });
});

describe('languageDirection', () => {
  it('is right to left for Arabic, Persian, Urdu, Hebrew and Yiddish, with or without a region', () => {
    for (const tag of ['ar', 'ar-EG', 'fa', 'fa_IR', 'ur', 'he', 'he-IL', 'yi', 'AR', ' he ']) expect(languageDirection(tag), tag).toBe('rtl');
  });

  it('is left to right for every other language and for none', () => {
    for (const tag of ['en', 'en-US', 'de', 'zh-Hans', 'hi', 'ara', '', undefined]) expect(languageDirection(tag), String(tag)).toBe('ltr');
  });
});

describe('mirrored (rule L4)', () => {
  it('turns brackets, and leaves other characters', () => {
    expect(mirrored('(')).toBe(')');
    expect(mirrored(']')).toBe('[');
    expect(mirrored('«')).toBe('»');
    expect(mirrored('a')).toBe('a');
  });
});

/** A line's runs written as `kind:text` for a short comparison. */
const shown = (text: string, base: 'ltr' | 'rtl') => visualRuns(text, base).map((run) => `${run.kind[0]}${run.level}:${run.text}`);

describe('visualRuns', () => {
  it('is the line itself for left-to-right text in a left-to-right paragraph', () => {
    expect(shown('Hello, world', 'ltr')).toEqual(['o0:Hello, world']);
  });

  it('puts an Arabic word between Latin words where UAX #9 does, and keeps the word in logical order for the shaper', () => {
    expect(shown('say مرحبا now', 'ltr')).toEqual(['o0:say ', 'l1:مرحبا', 'o0: now']);
  });

  it('reverses the order of words in a right-to-left paragraph', () => {
    expect(shown('שלום עולם', 'rtl')).toEqual(['l1:עולם', 'o1: ', 'l1:שלום']);
  });

  it('keeps a Latin word and its digits left to right inside a right-to-left paragraph', () => {
    expect(shown('שלום Bob 42', 'rtl')).toEqual(['o2:Bob 42', 'o1: ', 'l1:שלום']);
  });

  it('turns the parentheses of a right-to-left run, so (בשקט) draws with its brackets the right way round', () => {
    // Left to right as drawn: "(", the word, ")" -- the brackets are the mirror images of the ones typed.
    const runs = visualRuns('(בשקט)', 'rtl');
    expect(runs.map((run) => run.text)).toEqual(['(', 'בשקט', ')']);
    // In a left-to-right paragraph the same text keeps ( ) where they were typed, around the word, in the order typed.
    expect(shown('x (בשקט) y', 'ltr')).toEqual(['o0:x (', 'l1:בשקט', 'o0:) y']);
  });

  it('writes a right-to-left run of other characters in visual order, whole clusters at a time', () => {
    // A family emoji (a ZWJ sequence) between two words is not reversed code point by code point.
    const runs = visualRuns('אב \u{1F468}\u200d\u{1F469}\u200d\u{1F467} גד', 'rtl');
    expect(runs.map((run) => run.text)).toEqual(['גד', ' \u{1F468}\u200d\u{1F469}\u200d\u{1F467} ', 'אב']);
  });

  it('draws the bidirectional control characters as nothing', () => {
    expect(visualRuns('a\u200fb\u200ec', 'ltr').map((run) => run.text)).toEqual(['abc']);
  });

  it('gives each digit and punctuation mark of the Arabic font a run of its own', () => {
    expect(shown('كم؟', 'rtl')).toEqual(['s1:؟', 'l1:كم']);
    expect(shown('٢٠٢٤', 'rtl').length).toBe(4);
  });

  it('puts trailing white space at the paragraph level (rule L1)', () => {
    expect(shown('שלום  ', 'ltr')).toEqual(['l1:שלום', 'o0:  ']);
  });
});
