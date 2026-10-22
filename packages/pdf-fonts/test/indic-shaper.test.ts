/**
 * The Indic shaper (indic-shaper.ts) against HarfBuzz. harfbuzzjs 1.6.3 is a devDependency of this package and the reference:
 * for every fixture the glyph ids, advances and offsets of upstream fontkit 2.0.4 must be HarfBuzz's, glyph for glyph. This is the
 * gate of issue #35. The fixtures are in test/fixtures/shaping/devanagari-fixtures.json and what HarfBuzz gives is stored in
 * devanagari-golden.json (scripts/indic-golden.mjs), which the test also recomputes, so the file cannot go stale.
 */

import { readFileSync } from 'node:fs';
import * as hb from 'harfbuzzjs';
import { beforeAll, describe, expect, it } from 'vitest';
import { sfntFromWoff } from '../src/font-bytes.js';
import { createFontkitShaper, languageTag, shapeWord, type BrahmicShaper } from '../src/indic-shaper.js';
import { loadDevanagariFontInNode } from '../src/node-loader.js';

interface Fixture {
  group: string;
  text: string;
  lang: string;
}
interface Plain {
  gid: number;
  xAdvance: number;
  xOffset: number;
  yOffset: number;
}

const read = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/shaping/${name}`, import.meta.url), 'utf8'));
const fixtures = read('devanagari-fixtures.json') as Fixture[];
const golden = read('devanagari-golden.json') as { samples: (Fixture & { harfbuzz: Plain[] })[] };

let bytes: Uint8Array;
let shaper: BrahmicShaper;
let reference: (text: string, lang: string) => Plain[];

beforeAll(async () => {
  bytes = await sfntFromWoff(await loadDevanagariFontInNode());
  shaper = await createFontkitShaper({ deva: bytes });
  const font = new hb.Font(new hb.Face(new hb.Blob(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)));
  reference = (text, lang) => {
    const buffer = new hb.Buffer();
    buffer.addText(text);
    buffer.setDirection(hb.Direction.LTR);
    buffer.setScript('Deva');
    buffer.setLanguage(lang);
    hb.shape(font, buffer);
    const positions = buffer.getGlyphPositions();
    return buffer.getGlyphInfos().map((info, index) => ({
      gid: info.codepoint,
      xAdvance: positions[index]?.xAdvance ?? 0,
      xOffset: positions[index]?.xOffset ?? 0,
      yOffset: positions[index]?.yOffset ?? 0,
    }));
  };
});

const options = (lang: string) => ({ fontId: 'deva', script: 'deva', lang });
const plain = (glyphs: readonly { gid: number; xAdvance: number; xOffset: number; yOffset: number }[]): Plain[] =>
  glyphs.map(({ gid, xAdvance, xOffset, yOffset }) => ({ gid, xAdvance, xOffset, yOffset }));

describe('the fixtures', () => {
  it('include the strings the decision on issue #35 names, and a Marathi and a Nepali `locl` case', () => {
    const texts = fixtures.map((fixture) => fixture.text);
    for (const text of ['हिन्दी', 'क्षत्रिय', 'कि', 'र्क', 'श्री', 'द्ध', 'प्रेम', 'कार्यक्रम', 'स्त्री', 'क़', 'क़']) expect(texts).toContain(text);
    expect(fixtures.filter((fixture) => fixture.lang === 'mr').length).toBeGreaterThan(0);
    expect(fixtures.filter((fixture) => fixture.lang === 'ne').length).toBeGreaterThan(0);
  });

  it('are the ones the golden file holds', () => {
    expect(golden.samples.map(({ group, text, lang }) => ({ group, text, lang }))).toEqual(fixtures);
  });
});

describe('fontkit 2.0.4 against HarfBuzz', () => {
  it('gives the glyph id, advance and offsets HarfBuzz gives for every fixture', () => {
    for (const sample of golden.samples.filter((one) => one.group !== 'zwj-half')) {
      expect(plain(shaper.shape(sample.text, options(sample.lang))), `${sample.text} (${sample.lang})`).toEqual(sample.harfbuzz);
    }
  });

  it('is the reference the golden file stored: HarfBuzz shapes the fixtures now as it did then', () => {
    for (const sample of golden.samples) expect(reference(sample.text, sample.lang), `${sample.text} (${sample.lang})`).toEqual(sample.harfbuzz);
  });

  it('differs from HarfBuzz in one known case, and only by an advance: a half form asked for with a joiner (क्‍ष) is 59 units wider', () => {
    const [sample] = golden.samples.filter((one) => one.group === 'zwj-half');
    expect(sample).toBeDefined();
    const ours = plain(shaper.shape(sample?.text ?? '', options('hi')));
    expect(ours.map((glyph) => glyph.gid)).toEqual(sample?.harfbuzz.map((glyph) => glyph.gid));
    expect(ours.map((glyph) => glyph.xAdvance)).toEqual([609, 0, 578]);
    expect(sample?.harfbuzz.map((glyph) => glyph.xAdvance)).toEqual([550, 0, 578]);
  });

  it('draws what it should: the short i before its consonant, reph after it, a conjunct as one glyph', () => {
    const glyphs = (text: string, lang = 'hi') => shaper.shape(text, options(lang));
    // कि: the vowel sign is drawn first, and its glyph is the narrow one.
    const ki = glyphs('कि');
    expect(ki.map((glyph) => glyph.gid)).toEqual([545, 56]);
    // र्क: reph is a mark on the consonant, after it in drawing order, with no advance of its own and a pen offset back over the consonant.
    const rka = glyphs('र्क');
    expect(rka).toHaveLength(2);
    expect(rka[1]?.xAdvance).toBe(0);
    expect(rka[1]?.xOffset).toBeLessThan(0);
    // क्ष, द्ध and श्री: one glyph for the conjunct.
    expect(glyphs('द्ध')).toHaveLength(1);
    expect(glyphs('क्ष')).toHaveLength(1);
    expect(glyphs('श्री')).toHaveLength(2);
  });

  it('selects the forms of the language: the Marathi la and the Nepali jha and digits are other glyphs than the Hindi ones', () => {
    const gids = (text: string, lang: string) => shaper.shape(text, options(lang)).map((glyph) => glyph.gid);
    expect(gids('ल', 'mr')).not.toEqual(gids('ल', 'hi'));
    expect(gids('झ', 'ne')).not.toEqual(gids('झ', 'hi'));
    expect(gids('२०८१', 'ne')).not.toEqual(gids('२०८१', 'hi'));
    // No language is the font's default forms.
    expect(shaper.shape('ल', { fontId: 'deva', script: 'deva' })).toEqual(shaper.shape('ल', options('hi')));
  });

  it('gives the precomposed nukta letter and the letter with its nukta the same glyphs', () => {
    expect(plain(shaper.shape('क़', options('hi')))).toEqual(plain(shaper.shape('क़', options('hi'))));
  });
});

describe('the shaper is the same whatever it shaped before', () => {
  it('gives a run the same glyphs after any other run, which fontkit 2.0.4 alone does not (its glyph cache keeps the first code points)', async () => {
    const texts = fixtures.map((fixture) => fixture.text);
    // One shaper that has seen every fixture in order, and a new one for each run.
    const warm = await createFontkitShaper({ deva: bytes });
    for (const text of [...texts, 'क्े', 'र्के', 'क्े']) warm.shape(text, options('hi'));
    for (const text of ['र्के', 'क्े', 'र्े', 'र्रे', ...texts.slice(0, 10)]) {
      const fresh = await createFontkitShaper({ deva: bytes });
      // The warm shaper caches by run, so the comparison is made on a text it has not seen with this language.
      expect(warm.shape(text, options('hi')), text).toEqual(fresh.shape(text, options('hi')));
      expect(plain(warm.shape(`${text}‌`, options('mr'))), text).toEqual(plain(fresh.shape(`${text}‌`, options('mr'))));
    }
  });

  it('matches HarfBuzz on the ill-formed runs that depend on that history in fontkit alone', async () => {
    for (const text of ['र्के', 'र्रे']) {
      const fresh = await createFontkitShaper({ deva: bytes });
      expect(plain(fresh.shape(text, options('hi'))), text).toEqual(reference(text, 'hi'));
    }
  });
});

describe('the clusters', () => {
  it('give each glyph the offset of the cluster it belongs to, with the reordered vowel sign in its consonant\'s cluster', () => {
    // हिन्दी is हि | न्दी: the short i is drawn first and belongs to cluster 0 with its consonant.
    expect(shaper.shape('हिन्दी', options('hi')).map((glyph) => glyph.cluster)).toEqual([0, 0, 2, 2, 2]);
    // क्षत्रिय is क्ष | त्रि | य
    expect(shaper.shape('क्षत्रिय', options('hi')).map((glyph) => glyph.cluster)).toEqual([0, 3, 3, 7]);
  });

});

describe('shapeWord', () => {
  it('rebuilds the spans from the clusters: the text of each cluster, once, over its glyphs in drawing order', () => {
    const word = shapeWord(shaper, 'हिन्दी', options('hi'));
    expect(word.failed).toBeUndefined();
    expect(word.spans).toEqual([
      { glyphs: 2, text: 'हि' },
      { glyphs: 3, text: 'न्दी' },
    ]);
    // The first glyph drawn of a cluster carries the cluster's text for ToUnicode, the others none.
    expect(word.glyphs.map((glyph) => glyph.text)).toEqual(['हि', '', 'न्दी', '', '']);
    expect(word.advance).toBe(word.glyphs.reduce((sum, glyph) => sum + glyph.advance, 0));
    expect(word.spans.map((span) => span.text).join('')).toBe('हिन्दी');
  });

  it('keeps the logical text whole where glyphs are moved: the spans of a word, in order, are the typed word', () => {
    for (const text of ['कार्यक्रम', 'प्रेम', 'र्क', 'कि', 'वर्षे', 'क्षत्रिय']) {
      const word = shapeWord(shaper, text, options('hi'));
      expect(word.spans.reduce((n, span) => n + span.glyphs, 0), text).toBe(word.glyphs.length);
      expect(word.spans.map((span) => span.text).join(''), text).toBe(text);
    }
  });

  it('reports an engine failure as a word with no glyphs, never as a throw', () => {
    const word = shapeWord(shaper, 'कि', { fontId: 'missing', script: 'deva', lang: 'hi' });
    expect(word.glyphs).toEqual([]);
    expect(word.failed).toMatch(/no font missing/);
  });
});

describe('languageTag', () => {
  it('maps the languages written in Devanagari to the font\'s language systems, and any other to the default forms', () => {
    expect(languageTag('hi')).toBe('HIN ');
    expect(languageTag('mr-IN')).toBe('MAR ');
    expect(languageTag('NE')).toBe('NEP ');
    expect(languageTag('sa')).toBe('SAN ');
    expect(languageTag('en')).toBeUndefined();
    expect(languageTag(undefined)).toBeUndefined();
  });
});
