/**
 * The two common fonts (vendor/noto-sans-cjk and vendor/noto-emoji, each a file cut from its full font to the characters of
 * everyday use): the checked-in files against the sets and budgets their build states, the coverage tables against the files,
 * that a common font draws every character it holds as the full font does, and which loader a document reads.
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Font } from '@pdf-lib/fontkit';
import { cjkCommonCovers, cjkLoaderFor, emojiCommonCovers, emojiLoaderFor } from '../src/common.js';
import { fallbackCovers } from '../src/coverage.js';
import { NOTO_CJK_COMMON_CODE_POINTS, NOTO_EMOJI_COMMON_CODE_POINTS } from '../src/coverage/noto-common-coverage.js';
import { CJK_COMMON_FONT_FILE, CJK_FONT_FILE, EMOJI_COMMON_FONT_FILE, EMOJI_FONT_FILE } from '../src/font-files.js';
import { loaderFor, withCommon, type FontLoader } from '../src/font-bytes.js';
import { loadFont } from '../src/fontkit.js';
import { hanGlyph, type HanLanguageTag } from '../src/han-locale.js';
import { cjkCommonFontCandidates, emojiCommonFontCandidates, loadCjkFontInNode, loadEmojiFontInNode } from '../src/node-loader.js';

const VENDOR = new URL('../../../vendor/', import.meta.url);

/** The budgets build.py enforces: 2 MB and 300 kB, of 1,024 bytes. */
const CJK_BUDGET = 2 * 1024 * 1024;
const EMOJI_BUDGET = 300 * 1024;

const read = (path: string): Buffer => readFileSync(new URL(path, VENDOR));
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The code points a charset file declares (vendor/noto-sans-cjk/common-charset.txt: hexadecimal code points and ranges). */
function declaredCharset(): number[] {
  const found: number[] = [];
  for (const line of read('noto-sans-cjk/common-charset.txt').toString('utf8').split(/\r?\n/)) {
    if (line.startsWith('#')) continue;
    for (const token of line.split(' ').filter((part) => part !== '')) {
      const [low = '', high = low] = token.split('-');
      for (let code = parseInt(low, 16); code <= parseInt(high, 16); code += 1) found.push(code);
    }
  }
  return found;
}

/** The emoji a list declares (vendor/noto-emoji/common-emoji.txt: one a line, as hexadecimal code points). */
function declaredEmoji(): string[] {
  return read('noto-emoji/common-emoji.txt')
    .toString('utf8')
    .split(/\r?\n/)
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => String.fromCodePoint(...line.split(' ').map((code) => parseInt(code, 16))));
}

describe('the common font files', () => {
  it.each([
    ['noto-sans-cjk', CJK_COMMON_FONT_FILE, CJK_BUDGET, CJK_FONT_FILE],
    ['noto-emoji', EMOJI_COMMON_FONT_FILE, EMOJI_BUDGET, EMOJI_FONT_FILE],
  ])('%s/%s is the file its SHA256SUMS pins, within its budget, and smaller than the full font', (directory, file, budget, full) => {
    const sums = read(`${directory}/SHA256SUMS`).toString('utf8');
    const digest = sums
      .split(/\r?\n/)
      .map((line) => line.split(/\s+/))
      .find((parts) => parts[1] === file)?.[0];
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256(read(`${directory}/${file}`))).toBe(digest);
    const size = statSync(new URL(`${directory}/${file}`, VENDOR)).size;
    expect(size).toBeLessThanOrEqual(budget);
    expect(size).toBeLessThan(statSync(new URL(`${directory}/${full}`, VENDOR)).size);
  });
});

describe('the common CJK font', () => {
  let common: Font;
  let full: Font;
  beforeAll(async () => {
    common = await loadFont(loadCjkFontInNode.common, 'common CJK font');
    full = await loadFont(loadCjkFontInNode, 'CJK font');
  });

  it('maps exactly the characters of common-charset.txt, which the full font maps too', () => {
    const declared = declaredCharset();
    expect([...common.characterSet]).toEqual(declared);
    expect(common.characterSet.length).toBe(NOTO_CJK_COMMON_CODE_POINTS);
    const fullSet = new Set(full.characterSet);
    for (const code of declared) expect(fullSet.has(code), code.toString(16)).toBe(true);
  });

  it('has a coverage table of the characters it maps, and of no other', () => {
    const held = new Set(common.characterSet);
    for (const code of full.characterSet) expect(cjkCommonCovers(String.fromCodePoint(code)), code.toString(16)).toBe(held.has(code));
    for (const ch of ['😀', '']) expect(cjkCommonCovers(ch), ch).toBe(false);
  });

  it('holds the characters of every language it is written for, and leaves rare ones to the full font', () => {
    for (const ch of '草堂東京のアパート서울거리，。「」αЯ你好吗学校國語體學') expect(cjkCommonCovers(ch), ch).toBe(true);
    // 龘 (U+9F98) is a rare Han character, 갂 (U+AC02) a Hangul syllable outside KS X 1001: the full font draws both.
    for (const ch of ['龘', '靐', '갂']) {
      expect(cjkCommonCovers(ch), ch).toBe(false);
      expect(fallbackCovers(ch), ch).toBe(true);
    }
  });

  it('draws each character it holds as the full font does, in the forms of every language', () => {
    const tags: (HanLanguageTag | undefined)[] = [undefined, 'JAN ', 'KOR ', 'ZHT ', 'ZHH '];
    let differing = 0;
    for (const code of common.characterSet) {
      const ch = String.fromCodePoint(code);
      const regional = (code >= 0x2e80 && code <= 0x9fff) || (code >= 0x3000 && code <= 0x303f) || code >= 0xff00;
      for (const tag of regional ? tags : [undefined]) {
        const a = hanGlyph(common, ch, tag);
        const b = hanGlyph(full, ch, tag);
        if (a.advanceWidth !== b.advanceWidth || !same(a.path.toSVG(), b.path.toSVG())) differing += 1;
      }
    }
    expect(differing).toBe(0);
  }, 120_000);

  it('is found by the Node loader in the font package', async () => {
    expect(cjkCommonFontCandidates().some((path) => path.replaceAll('\\', '/').endsWith(`/${CJK_COMMON_FONT_FILE}`))).toBe(true);
    expect(new TextDecoder().decode((await loadCjkFontInNode.common()).slice(0, 4))).toBe('wOFF');
  });
});

describe('the common emoji font', () => {
  let common: Font;
  let full: Font;
  beforeAll(async () => {
    common = await loadFont(loadEmojiFontInNode.common, 'common emoji font');
    full = await loadFont(loadEmojiFontInNode, 'emoji font');
  });

  it('maps exactly the code points of the emoji common-emoji.txt lists, which the full font maps too', () => {
    const listed = new Set([...declaredEmoji().join('')].map((ch) => ch.codePointAt(0) ?? 0));
    expect(new Set(common.characterSet)).toEqual(listed);
    expect(common.characterSet.length).toBe(NOTO_EMOJI_COMMON_CODE_POINTS);
    const fullSet = new Set(full.characterSet);
    for (const code of listed) expect(fullSet.has(code), code.toString(16)).toBe(true);
  });

  it('draws each emoji it lists as the full font does, with and without its variation selector', () => {
    const outline = (font: Font, text: string): unknown =>
      font.layout(text).glyphs.map((glyph) => ({ notdef: glyph.id === 0, advance: glyph.advanceWidth, path: glyph.path.toSVG() }));
    const emoji = declaredEmoji();
    expect(emoji.length).toBeGreaterThan(800);
    for (const cluster of emoji) {
      for (const form of [cluster, cluster.replace('️', '')]) {
        const drawn = outline(common, form);
        expect(same(drawn, outline(full, form)), `${form} (${[...form].map((ch) => ch.codePointAt(0)?.toString(16)).join(' ')})`).toBe(true);
        expect((drawn as { notdef: boolean }[]).some((glyph) => glyph.notdef), form).toBe(false);
      }
    }
  }, 60_000);

  it('knows which clusters the font draws: one emoji of the set, with a variation selector or not, and a keycap', () => {
    for (const cluster of declaredEmoji()) expect(emojiCommonCovers(cluster), cluster).toBe(true);
    for (const cluster of ['😀', '❤️', '❤', '👍', '1️⃣', '#️⃣', '*⃣', '🙏']) expect(emojiCommonCovers(cluster), cluster).toBe(true);
    // A skin tone, a ZWJ sequence, a flag, a tag sequence, a pictograph of a group the set leaves out, and not an emoji at all.
    for (const cluster of ['👍🏽', '👨‍👩‍👧', '🇩🇪', '🏴󠁧󠁢󠁳󠁣󠁴󠁿', '🚗', '🎬', 'a', 'ab', '12', '']) expect(emojiCommonCovers(cluster), cluster).toBe(false);
  });

  it('is found by the Node loader in the font package', async () => {
    expect(emojiCommonFontCandidates().some((path) => path.replaceAll('\\', '/').endsWith(`/${EMOJI_COMMON_FONT_FILE}`))).toBe(true);
    expect(new TextDecoder().decode((await loadEmojiFontInNode.common()).slice(0, 4))).toBe('wOFF');
  });
});

describe('the loader a document reads', () => {
  const full: FontLoader = async () => new Uint8Array([1]);
  const small: FontLoader = async () => new Uint8Array([2]);
  const both = withCommon(full, small);

  it('is the common one when the document sets only common characters in the font, and the full font otherwise', async () => {
    expect(await both()).toEqual(new Uint8Array([1]));
    expect(await loaderFor(both, true)()).toEqual(new Uint8Array([2]));
    expect(await loaderFor(both, false)()).toEqual(new Uint8Array([1]));
    expect(loaderFor(both, true)).toBe(both.common);
  });

  it('is the loader itself when it has no common file', () => {
    expect(loaderFor(full, true)).toBe(full);
    expect(loaderFor(full, false)).toBe(full);
  });

  it('is chosen for CJK by the characters, and a character the full font does not print does not ask for the full font', () => {
    expect(cjkLoaderFor(both, [...'中文かな한글'])).toBe(both.common);
    expect(cjkLoaderFor(both, [...'中文龘'])).toBe(both);
    expect(cjkLoaderFor(both, [])).toBe(both.common);
    // U+0378 is unassigned: neither file has it, so it prints as "?" whichever is read.
    expect(cjkLoaderFor(both, ['中', '͸'])).toBe(both.common);
  });

  it('is chosen for emoji by the clusters', () => {
    expect(emojiLoaderFor(both, ['😀', '❤️', '1️⃣'])).toBe(both.common);
    expect(emojiLoaderFor(both, ['😀', '👍🏽'])).toBe(both);
    expect(emojiLoaderFor(both, ['🇩🇪'])).toBe(both);
  });
});
