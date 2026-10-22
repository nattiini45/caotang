/**
 * The coverage tables against the fonts they were generated from (src/coverage, scripts/): a font update without a rerun of
 * the scripts fails here. Also the two vendored font files against the SHA-256 their SHA256SUMS pins, and Unicode's emoji
 * list against the one the emoji table was generated from.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Font } from '@pdf-lib/fontkit';
import { NOTO_ARABIC_CODE_POINTS } from '../src/coverage/noto-arabic-coverage.js';
import { NOTO_CJK_CODE_POINTS } from '../src/coverage/noto-cjk-coverage.js';
import {
  NOTO_EMOJI_CODE_POINTS,
  NOTO_EMOJI_LAYOUT,
  NOTO_EMOJI_RANGES,
  NOTO_EMOJI_SEQUENCES,
  NOTO_EMOJI_TONED,
} from '../src/coverage/noto-emoji-coverage.js';
import { NOTO_HEBREW_CODE_POINTS } from '../src/coverage/noto-hebrew-coverage.js';
import { arabicFontMaps, emojiFontLayoutGlyph, emojiFontMaps, fallbackCovers, hebrewFontMaps } from '../src/coverage.js';
import { emojiKey } from '../src/emoji.js';
import { ARABIC_FONT_FILE, CJK_FONT_FILE, EMOJI_FONT_FILE, HEBREW_FONT_FILE } from '../src/font-files.js';
import { loadFont } from '../src/fontkit.js';
import { harfbuzzEmoji } from './harfbuzz-reference.js';
import { loadArabicFontInNode, loadCjkFontInNode, loadEmojiFontInNode, loadHebrewFontInNode } from '../src/node-loader.js';

const VENDOR = new URL('../../../vendor/', import.meta.url);
const EMOJI_TEST_PATH = new URL('./fixtures/emoji-test-17.0.txt', import.meta.url);
const EMOJI_TEST_SHA256 = '1d8a944f88d7952f7ef7c5167fef3c67995bcae24543949710231b03a201acda';

/** The Unicode Emoji version Noto Emoji 3.006 supports (vendor/noto-emoji/README.md). Raise it with the font, never alone. */
const FONT_EMOJI_VERSION = '17.0';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** The SHA-256 a vendor package's SHA256SUMS pins for a file. */
function pinned(directory: string, file: string): string | undefined {
  const sums = readFileSync(new URL(`${directory}/SHA256SUMS`, VENDOR), 'utf8');
  return sums.split('\n').map((line) => line.split(/\s+/)).find((parts) => parts[1] === file)?.[0];
}

describe('the vendored font files', () => {
  it.each([
    ['noto-sans-cjk', CJK_FONT_FILE],
    ['noto-emoji', EMOJI_FONT_FILE],
    ['noto-sans-arabic', ARABIC_FONT_FILE],
    ['noto-sans-hebrew', HEBREW_FONT_FILE],
  ])('%s/%s is the file its SHA256SUMS pins, byte for byte', (directory, file) => {
    const digest = pinned(directory, file);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256(readFileSync(new URL(`${directory}/${file}`, VENDOR)))).toBe(digest);
  });

  it('are the only copy of each font in the repository: the screenplay package holds no Noto file', () => {
    for (const file of ['NotoSansMonoCJKsc-Regular.otf', 'NotoEmoji-Regular.ttf', 'OFL-NotoSansMonoCJK.txt', 'OFL-NotoEmoji.txt']) {
      expect(() => readFileSync(new URL(`../../screenplay/src/fonts/${file}`, import.meta.url)), file).toThrow();
    }
  });
});

describe('the CJK coverage table', () => {
  let font: Font;
  beforeAll(async () => {
    font = await loadFont(loadCjkFontInNode, 'CJK font');
  });

  it('has every code point the font maps, and no other', () => {
    const set = font.characterSet;
    expect(set.length).toBe(NOTO_CJK_CODE_POINTS);
    for (const code of set) expect(fallbackCovers(String.fromCodePoint(code)), code.toString(16)).toBe(true);
    for (const ch of ['😀', 'ꙮ', 'ά', '\u0378']) expect(fallbackCovers(ch), ch).toBe(set.includes(ch.codePointAt(0) ?? 0));
  });

  it('covers Hanzi, kana, Hangul, Greek and Cyrillic', () => {
    for (const ch of '草堂東京のアパート서울거리，。「」αЯ') expect(fallbackCovers(ch), ch).toBe(true);
  });
});

describe('the Arabic and Hebrew coverage tables', () => {
  let arabic: Font;
  let hebrew: Font;
  beforeAll(async () => {
    arabic = await loadFont(loadArabicFontInNode, 'Arabic font');
    hebrew = await loadFont(loadHebrewFontInNode, 'Hebrew font');
  });

  it.each([
    ['Arabic', () => arabic, NOTO_ARABIC_CODE_POINTS, arabicFontMaps],
    ['Hebrew', () => hebrew, NOTO_HEBREW_CODE_POINTS, hebrewFontMaps],
  ] as const)('have every code point the %s font maps, and no other', (_name, font, count, maps) => {
    const set = font().characterSet;
    expect(set.length).toBe(count);
    for (const code of set) expect(maps(String.fromCodePoint(code)), code.toString(16)).toBe(true);
    for (const ch of ['😀', 'ꙮ', 'ά', 'a'.repeat(1), 'ا', 'א']) expect(maps(ch), ch).toBe(set.includes(ch.codePointAt(0) ?? 0));
  });

  it('cover the letters the tests print', () => {
    for (const ch of 'السلام عليكم؟پچگژٹڈںے٠١٢۰۱۲') if (ch !== ' ') expect(arabicFontMaps(ch), ch).toBe(true);
    for (const ch of 'שלוםךםןףץ־״׳') expect(hebrewFontMaps(ch), ch).toBe(true);
  });
});

describe('the emoji coverage tables', () => {
  let font: Font;
  beforeAll(async () => {
    font = await loadFont(loadEmojiFontInNode, 'emoji font');
  });

  it('are generated from the font', () => {
    const set = font.characterSet;
    expect(set.length).toBe(NOTO_EMOJI_CODE_POINTS);
    expect(NOTO_EMOJI_RANGES.length).toBeGreaterThan(0);
    for (const code of set) expect(emojiFontMaps(String.fromCodePoint(code)), code.toString(16)).toBe(true);
    for (const table of [NOTO_EMOJI_SEQUENCES, NOTO_EMOJI_TONED]) {
      for (const seq of table.split(' ')) {
        const key = String.fromCodePoint(...seq.split('.').map((part) => parseInt(part, 36)));
        // A sequence is one glyph as its key; a toned key is one glyph only with its tones.
        expect(font.layout(key).glyphs.length === 1, key).toBe(table === NOTO_EMOJI_SEQUENCES);
      }
    }
  });

  it('give the glyph HarfBuzz lays out for each key fontkit does not reach, and leave out every other', async () => {
    const harfbuzz = await harfbuzzEmoji();
    // What fontkit reaches, the way the PDFs try it: the cluster, without its variation selectors, its key.
    const reached = (unit: string): number | undefined => {
      for (const form of [unit, unit.replace(/️/g, ''), emojiKey(unit)]) {
        const glyphs = font.layout(form).glyphs;
        if (glyphs.length === 1 && glyphs[0] !== undefined && glyphs[0].id !== 0) return glyphs[0].id;
      }
      return undefined;
    };
    const fullyQualified = readFileSync(EMOJI_TEST_PATH, 'utf8')
      .split('\n')
      .filter((line) => /^[0-9A-F]/.test(line) && line.split(';')[1]?.trim().startsWith('fully-qualified'))
      .map((line) => String.fromCodePoint(...(line.split(';')[0] ?? '').trim().split(/\s+/).map((hex) => parseInt(hex, 16))));
    expect(fullyQualified).toHaveLength(3944);
    const drifted = new Map<string, number>();
    for (const unit of fullyQualified) {
      const reference = harfbuzz(unit);
      expect(reference, unit).toHaveLength(1);
      if (reached(unit) !== reference[0]) drifted.set(emojiKey(unit), reference[0] ?? 0);
    }
    // The woman and man walking, kneeling and running facing right: six keys, 36 sequences with their skin tones.
    expect(drifted.size).toBe(6);
    const table = new Map(
      NOTO_EMOJI_LAYOUT.split(' ').map((entry): [string, number] => {
        const [seq = '', glyph = ''] = entry.split('=');
        return [String.fromCodePoint(...seq.split('.').map((part) => parseInt(part, 36))), parseInt(glyph, 36)];
      }),
    );
    expect(table).toEqual(drifted);
    for (const [key, glyph] of drifted) expect(emojiFontLayoutGlyph(key), key).toBe(glyph);
    // Every fully-qualified sequence is then one glyph through the table or fontkit, and it is HarfBuzz's.
    for (const unit of fullyQualified) {
      expect(emojiFontLayoutGlyph(emojiKey(unit)) ?? reached(unit), unit).toBe(harfbuzz(unit)[0]);
    }
  }, 60_000);

  it('were generated from Unicode’s emoji list for 17.0, byte for byte the one kept here', () => {
    expect(sha256(readFileSync(EMOJI_TEST_PATH))).toBe(EMOJI_TEST_SHA256);
  });

  it('move with the emoji list: the list is not newer than the Emoji version the font supports', () => {
    const header = /^# Version: (\d+)\.(\d+)$/m.exec(readFileSync(EMOJI_TEST_PATH, 'utf8'));
    const [major = 0, minor = 0] = (header?.slice(1) ?? []).map(Number);
    const [fontMajor = 0, fontMinor = 0] = FONT_EMOJI_VERSION.split('.').map(Number);
    const newer = major > fontMajor || (major === fontMajor && minor > fontMinor);
    expect(
      newer,
      `test/fixtures/emoji-test-17.0.txt is Emoji ${major}.${minor}, newer than Emoji ${FONT_EMOJI_VERSION}, which ${font.version} supports: ` +
        'vendor a font that supports it first (vendor/noto-emoji/README.md), then raise FONT_EMOJI_VERSION',
    ).toBe(false);
    expect(`${major}.${minor}`, 'the list is the Emoji version the font is declared to support').toBe(FONT_EMOJI_VERSION);
  });

  it('is Noto Emoji 3.006, which maps what Emoji 16.0 and 17.0 added', () => {
    expect(font.version).toBe('Version 3.006');
    for (const ch of ['🫩', '🫆', '🪾', '🫜', '🪉', '🪏', '🫟', '🫪', '🛘']) expect(emojiFontMaps(ch), ch).toBe(true);
  });
});
