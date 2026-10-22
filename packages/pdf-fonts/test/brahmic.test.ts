/**
 * The Brahmic units (brahmic.ts): a line of Indic text is measured, broken and cut between grapheme clusters, with a conjunct
 * whole whether or not the engine's segmenter keeps it so (UAX #29 GB9c, Unicode 15.1).
 */

import { describe, expect, it } from 'vitest';
import {
  clustersOf,
  devanagariFontPrints,
  devanagariRuns,
  hasBrahmic,
  hasDevanagari,
  isDevanagariUnit,
  joinConjuncts,
  startsWithBrahmicMark,
} from '../src/brahmic.js';
import { graphemesOf } from '../src/emoji.js';

describe('which text is Brahmic', () => {
  it('is any text with a character from Devanagari to Sinhala, Devanagari Extended or the Vedic block, and no other', () => {
    for (const text of ['हिन्दी', 'বাংলা', 'தமிழ்', 'සිංහල', 'a ꣠', 'x᳐']) expect(hasBrahmic(text), text).toBe(true);
    for (const text of ['Latin only', 'العربية', 'עברית', '日本語', '😀', 'ไทย', '']) expect(hasBrahmic(text), text).toBe(false);
    expect(hasDevanagari('x हिन्दी')).toBe(true);
    expect(hasDevanagari('বাংলা')).toBe(false);
  });

  it('is printed by the Devanagari font for the characters of its blocks that the font maps, not for another Brahmic script', () => {
    for (const ch of 'हिन्दी।॥०९ंःऽ़') expect(devanagariFontPrints(ch), ch).toBe(true);
    for (const ch of ['ক', 'த', 'a', ' ', '‍']) expect(devanagariFontPrints(ch), ch).toBe(false);
  });
});

describe('the units of Brahmic text', () => {
  it('are clusters: a consonant with its vowel sign, its conjunct and its marks, never a bare code point', () => {
    expect(clustersOf('हिन्दी')).toEqual(['हि', 'न्दी']);
    expect(clustersOf('क्षत्रिय')).toEqual(['क्ष', 'त्रि', 'य']);
    expect(clustersOf('कार्यक्रम')).toEqual(['का', 'र्य', 'क्र', 'म']);
    expect(clustersOf('क़')).toEqual(['क़']);
    expect(clustersOf('क़')).toEqual(['क़']);
    expect(clustersOf('पुस्तकें')).toEqual(['पु', 'स्त', 'कें']);
  });

  it('keep a conjunct whole when the engine\'s segmenter does not: the join rule is applied here', () => {
    // What an engine without GB9c gives: a cluster ends at the virama.
    const old = ['क्', 'ष', 'त्', 'रि', 'य'];
    expect(joinConjuncts(old)).toEqual(['क्ष', 'त्रि', 'य']);
    // A joiner after the virama is part of the virama's cluster, and does not stop the join.
    expect(joinConjuncts(['क्‍', 'ष'])).toEqual(['क्‍ष']);
    expect(joinConjuncts(['क्‌', 'ष'])).toEqual(['क्‌ष']);
    // A virama before a space, a vowel sign or the end of the text joins nothing.
    expect(joinConjuncts(['क्', ' ', 'ष'])).toEqual(['क्', ' ', 'ष']);
    expect(joinConjuncts(['क्'])).toEqual(['क्']);
    // The same for the viramas of the other scripts.
    expect(joinConjuncts(['ক্', 'ষ'])).toEqual(['ক্ষ']);
    expect(joinConjuncts(['க்', 'ஷ'])).toEqual(['க்ஷ']);
  });

  it('are what the segmenter gives for text without a Brahmic character', () => {
    for (const text of ['Latin text', 'café', 'é', '👨‍👩‍👧 🇩🇪', 'שָׁלוֹם']) expect(clustersOf(text), text).toEqual(graphemesOf(text));
  });

  it('put clusters back together as the text: nothing is lost or reordered', () => {
    for (const text of ['हिन्दी में', 'क़ फ़ ड़', 'श्री-गणेश।', 'क्‍ष क्‌ष', 'বাংলা তামিল']) expect(clustersOf(text).join(''), text).toBe(text);
  });
});

describe('the runs', () => {
  it('are the letters the Devanagari font prints, and the text between them', () => {
    expect(devanagariRuns(clustersOf('Hello हिन्दी world।'))).toEqual([
      { kind: 'other', text: 'Hello ' },
      { kind: 'letters', text: 'हिन्दी' },
      { kind: 'other', text: ' world' },
      { kind: 'letters', text: '।' },
    ]);
    expect(devanagariRuns(clustersOf('एक दो'))).toEqual([
      { kind: 'letters', text: 'एक' },
      { kind: 'other', text: ' ' },
      { kind: 'letters', text: 'दो' },
    ]);
  });

  it('leave another Brahmic script as text between: it has no font', () => {
    expect(devanagariRuns(clustersOf('হিন্দি')).every((run) => run.kind === 'other')).toBe(true);
    expect(isDevanagariUnit('कि')).toBe(true);
    expect(isDevanagariUnit('ক')).toBe(false);
  });
});

describe('a mark with no consonant', () => {
  it('begins a unit of its own, and is known as a mark', () => {
    expect(startsWithBrahmicMark('ं')).toBe(true);
    expect(startsWithBrahmicMark('ि')).toBe(true);
    expect(startsWithBrahmicMark('कि')).toBe(false);
    expect(startsWithBrahmicMark('a')).toBe(false);
    expect(startsWithBrahmicMark('́')).toBe(false);
  });
});
