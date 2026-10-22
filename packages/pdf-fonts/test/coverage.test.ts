/**
 * The coverage tables against the fonts they were generated from (src/coverage, scripts/): a font update without a rerun of
 * the scripts fails here. Also the two vendored font files against the SHA-256 their SHA256SUMS pins, and Unicode's emoji
 * list against the one the emoji table was generated from.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Font } from '@pdf-lib/fontkit';
import { NOTO_CJK_CODE_POINTS } from '../src/coverage/noto-cjk-coverage.js';
import {
  NOTO_EMOJI_CODE_POINTS,
  NOTO_EMOJI_RANGES,
  NOTO_EMOJI_SEQUENCES,
  NOTO_EMOJI_TONED,
} from '../src/coverage/noto-emoji-coverage.js';
import { emojiFontMaps, fallbackCovers } from '../src/coverage.js';
import { CJK_FONT_FILE, EMOJI_FONT_FILE } from '../src/font-files.js';
import { loadFont } from '../src/fontkit.js';
import { loadCjkFontInNode, loadEmojiFontInNode } from '../src/node-loader.js';

const VENDOR = new URL('../../../vendor/', import.meta.url);
const EMOJI_TEST_PATH = new URL('./fixtures/emoji-test-15.1.txt', import.meta.url);
const EMOJI_TEST_SHA256 = 'd876ee249aa28eaa76cfa6dfaa702847a8d13b062aa488d465d0395ee8137ed9';

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

  it('were generated from Unicode’s emoji list for 15.1, byte for byte the one kept here', () => {
    expect(sha256(readFileSync(EMOJI_TEST_PATH))).toBe(EMOJI_TEST_SHA256);
  });
});
