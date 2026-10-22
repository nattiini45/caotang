import { describe, expect, it } from 'vitest';
import {
  FOUNTAIN_EXTENSION,
  SCREENPLAY_KIND,
  characterCueNames,
  cueKey,
  cueSpellingGroups,
  isScreenplayKind,
  parseFountain,
  screenplayBodyPath,
} from '../src/index.js';
import { stripExtensions } from '../src/classify.js';
import { SCRIPT_ONE_ACT, text } from './fixtures/corpus.js';

describe('screenplay document kind (screenplay.md §2.1)', () => {
  it('names the kind and its body file extension as the spec does', () => {
    expect(SCREENPLAY_KIND).toBe('screenplay');
    expect(FOUNTAIN_EXTENSION).toBe('.fountain');
    expect(screenplayBodyPath('n_7K2QX9M4A1')).toBe('docs/n_7K2QX9M4A1.fountain');
  });

  it('treats only the screenplay kind as a screenplay; an absent kind is prose', () => {
    expect(isScreenplayKind('screenplay')).toBe(true);
    expect(isScreenplayKind('prose')).toBe(false);
    expect(isScreenplayKind(undefined)).toBe(false);
    expect(isScreenplayKind(null)).toBe(false);
  });
});

describe('character cues as mention and consistency inputs (screenplay.md §4)', () => {
  it('lists each character once, with extensions and dual markers removed', () => {
    expect(characterCueNames(parseFountain(SCRIPT_ONE_ACT).elements)).toEqual(['ELENA', 'MARCUS']);
  });

  it('keys cues so that punctuation and case do not separate one character', () => {
    expect(cueKey('MR. SMITH')).toBe('MR SMITH');
    expect(cueKey('MR SMITH')).toBe('MR SMITH');
    expect(cueKey("O'BRIEN")).toBe('OBRIEN');
  });

  it('groups cues spelled more than one way, and names every spelling', () => {
    const elements = parseFountain(text('@McCLANE', 'Yippee.', '', 'MCCLANE', 'Again.', '', 'ANNA', 'Hi.')).elements;
    expect(cueSpellingGroups(elements)).toEqual([{ key: 'MCCLANE', spellings: ['McCLANE', 'MCCLANE'] }]);
  });

  it('reports no group when every cue is spelled one way', () => {
    expect(cueSpellingGroups(parseFountain(SCRIPT_ONE_ACT).elements)).toEqual([]);
  });
});

describe('stripExtensions', () => {
  /** The expression loop it replaced; the scan must agree with it. */
  const before = (text: string): string => {
    let t = text.trim();
    for (;;) {
      const next = t.replace(/\s*\([^()]*\)$/, '').trimEnd();
      if (next === t) return t;
      t = next;
    }
  };
  const SAMPLES = [
    '',
    ' ',
    '()',
    ')',
    '(',
    'ANNA',
    'ANNA (V.O.)',
    "ANNA (V.O.) (CONT'D)",
    'ANNA(V.O.)',
    'ANNA   (V.O.)   ',
    '(V.O.)',
    'ANNA (A (B))',
    'ANNA (A) B)',
    'ANNA ((A)',
    'ANNA (A))',
    'ANNA )(',
    'ИВАН (за кадром)',
    'ANNA \u00a0(V.O.)\r\n',
    '(a)(b)(c)',
  ];

  it('removes trailing parenthesised extensions as the expression did', () => {
    for (const s of SAMPLES) expect(stripExtensions(s)).toBe(before(s));
    expect(stripExtensions("ANNA (V.O.) (CONT'D)")).toBe('ANNA');
    expect(stripExtensions('ANNA (A (B))')).toBe('ANNA (A (B))');
    expect(stripExtensions('ANNA ((A)')).toBe('ANNA (');
  });

  it('stays linear on long runs of spaces, brackets and extensions', () => {
    const big = 50_000;
    const start = performance.now();
    stripExtensions(`A${' '.repeat(big)}x`);
    stripExtensions(`A${'('.repeat(big)}`);
    stripExtensions(`A${')'.repeat(big)}`);
    stripExtensions(`A${' (a)'.repeat(big / 5)}`);
    stripExtensions(`${'(a)'.repeat(big / 3)}`);
    expect(performance.now() - start).toBeLessThan(500);
  });
});
