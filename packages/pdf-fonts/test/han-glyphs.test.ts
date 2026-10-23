/** The regional forms of Han characters in the vendored CJK font (han-locale.ts), against fixtures and against HarfBuzz. */

import * as hb from 'harfbuzzjs';
import { beforeAll, describe, expect, it } from 'vitest';
import { sfntFromWoff } from '../src/font-bytes.js';
import { loadFont } from '../src/fontkit.js';
import { hanGlyph, hanLocaleTag } from '../src/han-locale.js';
import { loadCjkFontInNode } from '../src/node-loader.js';
import { HAN_DELTAS, HAN_FORMS, HAN_LANGUAGES, HAN_PUNCTUATION } from './fixtures/han-forms.js';

type Font = Awaited<ReturnType<typeof loadFont>>;
let font: Font;
let shape: (text: string, language: string) => number[];

beforeAll(async () => {
  font = await loadFont(loadCjkFontInNode, 'the CJK font');
  const sfnt = await sfntFromWoff(await loadCjkFontInNode());
  const face = new hb.Font(new hb.Face(new hb.Blob(sfnt.buffer.slice(sfnt.byteOffset, sfnt.byteOffset + sfnt.byteLength) as ArrayBuffer)));
  shape = (text, language) => {
    const buffer = new hb.Buffer();
    buffer.addText(text);
    buffer.guessSegmentProperties();
    buffer.setLanguage(language);
    hb.shape(face, buffer);
    return buffer.getGlyphInfos().map((info) => info.codepoint);
  };
}, 60_000);

const idOf = (char: string, language: string | undefined): number => hanGlyph(font, char, hanLocaleTag(language)).id;

describe('the CJK font draws a Han character in the forms of the language', () => {
  for (const [char, forms] of Object.entries(HAN_FORMS)) {
    it(`${char} has the fixture ids`, () => {
      expect(idOf(char, undefined)).toBe(forms.sc);
      for (const { language } of HAN_LANGUAGES) expect(idOf(char, language), language).toBe(forms[language]);
    });
  }

  it('takes the Simplified Chinese glyph, the cmap one, for zh, zh-Hans, zh-CN, zh-SG and no language', () => {
    for (const [char, forms] of Object.entries(HAN_FORMS)) {
      expect(font.glyphForCodePoint(char.codePointAt(0) ?? 0).id).toBe(forms.sc);
      for (const language of ['zh', 'zh-Hans', 'zh-CN', 'zh-SG', '', 'en', 'not a tag']) expect(idOf(char, language), `${char} ${language}`).toBe(forms.sc);
    }
  });

  it('takes the same form from the tags of one language: ja-JP, zh-TW, zh-MO, zh-Hant-HK', () => {
    for (const char of Object.keys(HAN_FORMS)) {
      expect(idOf(char, 'ja-JP')).toBe(idOf(char, 'ja'));
      expect(idOf(char, 'zh-TW')).toBe(idOf(char, 'zh-Hant'));
      expect(idOf(char, 'zh-MO')).toBe(idOf(char, 'zh-Hant'));
      expect(idOf(char, 'zh-Hant-HK')).toBe(idOf(char, 'zh-HK'));
    }
  });

  it('puts each form beside the cmap glyph as the font does: the fixtures are the issue’s table in this build’s ids', () => {
    for (const [char, deltas] of Object.entries(HAN_DELTAS)) {
      const forms = HAN_FORMS[char];
      if (forms === undefined) throw new Error(char);
      for (const { language } of HAN_LANGUAGES) expect(forms[language] - forms.sc, `${char} ${language}`).toBe(deltas[language as keyof typeof deltas]);
    }
    // 次 in Korean is a glyph of its own, far from the others.
    expect(HAN_FORMS['次']?.ko).not.toBe(HAN_FORMS['次']?.sc);
    expect(Math.abs((HAN_FORMS['次']?.ko ?? 0) - (HAN_FORMS['次']?.sc ?? 0))).toBeGreaterThan(1000);
  });

  it('centres the fullwidth full stop 。 in Traditional Chinese and Hong Kong, and keeps it bottom-left otherwise', () => {
    expect(idOf('。', undefined)).toBe(HAN_PUNCTUATION.sc);
    for (const { language } of HAN_LANGUAGES) expect(idOf('。', language), language).toBe(HAN_PUNCTUATION[language]);
    expect(HAN_PUNCTUATION['zh-Hant']).not.toBe(HAN_PUNCTUATION.sc);
  });

  it('leaves kana, Hangul and Latin letters in the font alone, in every language', () => {
    for (const char of 'あカ한aλ') for (const { language } of HAN_LANGUAGES) expect(idOf(char, language), `${char} ${language}`).toBe(idOf(char, undefined));
  });

  it('gives the ids HarfBuzz gives, whatever the language', () => {
    for (const [char, forms] of Object.entries(HAN_FORMS)) {
      expect(shape(char, 'zh-Hans'), `${char} zh-Hans`).toEqual([forms.sc]);
      for (const { language } of HAN_LANGUAGES) expect(shape(char, language), `${char} ${language}`).toEqual([forms[language]]);
    }
    // 。 has no script of its own: HarfBuzz takes it from the Han character before it.
    for (const { language } of HAN_LANGUAGES) expect(shape('直。', language).at(-1), language).toBe(HAN_PUNCTUATION[language]);
  });
});
