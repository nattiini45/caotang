/**
 * The Node loaders (node-loader.ts) find the two fallback fonts in their packages, and the files unpack from WOFF to the
 * TrueType fonts fontkit reads.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ARABIC_FONT_FILE, CJK_BOLD_FONT_FILE, CJK_FONT_FILE, DEVANAGARI_FONT_FILE, EMOJI_FONT_FILE, HEBREW_FONT_FILE } from '../src/font-files.js';
import { sfntFromWoff } from '../src/font-bytes.js';
import { openFont } from '../src/fontkit.js';
import {
  arabicFontCandidates,
  cjkBoldFontCandidates,
  cjkFontCandidates,
  devanagariFontCandidates,
  emojiFontCandidates,
  hebrewFontCandidates,
  loadArabicFontInNode,
  loadCjkFontInNode,
  loadDevanagariFontInNode,
  loadEmojiFontInNode,
  loadHebrewFontInNode,
  readFirst,
} from '../src/node-loader.js';

describe('the fallback font file', () => {
  it('is found by the Node loader in @caotang/font-noto-cjk, and unpacks from WOFF to a TrueType font', async () => {
    // Separator-agnostic: `cjkFontCandidates` joins with `node:path`, so the
    // candidate carries `\` on Windows and `/` elsewhere.
    expect(cjkFontCandidates().some((path) => {
      const norm = path.replaceAll('\\', '/');
      return norm.endsWith(`font-noto-cjk/${CJK_FONT_FILE}`) || norm.endsWith(`noto-sans-cjk/${CJK_FONT_FILE}`);
    })).toBe(true);
    const woff = await loadCjkFontInNode();
    expect(new TextDecoder().decode(woff.slice(0, 4))).toBe('wOFF');
    const sfnt = await sfntFromWoff(woff);
    expect([...sfnt.slice(0, 4)]).toEqual([0, 1, 0, 0]);
    const font = await openFont(sfnt) as unknown as { familyName: string; hasGlyphForCodePoint(code: number): boolean };
    expect(font.familyName).toBe('Noto Sans Mono CJK SC');
    for (const char of '中體かカ한Яα') expect(font.hasGlyphForCodePoint(char.codePointAt(0) ?? 0)).toBe(true);
  });
});

describe('the emoji font file', () => {
  it('is found by the Node loader in @caotang/font-noto-emoji, and unpacks from WOFF to a static TrueType font', async () => {
    // Separator-agnostic, like the CJK loader's assertion above.
    expect(emojiFontCandidates().some((path) => {
      const norm = path.replaceAll('\\', '/');
      return norm.endsWith(`font-noto-emoji/${EMOJI_FONT_FILE}`) || norm.endsWith(`noto-emoji/${EMOJI_FONT_FILE}`);
    })).toBe(true);
    const woff = await loadEmojiFontInNode();
    expect(new TextDecoder().decode(woff.slice(0, 4))).toBe('wOFF');
    const sfnt = await sfntFromWoff(woff);
    expect([...sfnt.slice(0, 4)]).toEqual([0, 1, 0, 0]);
    const font = await openFont(sfnt) as unknown as { familyName: string; variationAxes: Record<string, unknown>; hasGlyphForCodePoint(code: number): boolean };
    expect(font.familyName).toBe('Noto Emoji');
    expect(Object.keys(font.variationAxes)).toEqual([]);
    for (const char of ['🎬', '😀', '❤']) expect(font.hasGlyphForCodePoint(char.codePointAt(0) ?? 0)).toBe(true);
  });
});

describe('the Arabic, Hebrew and Devanagari font files', () => {
  it.each([
    ['Arabic', arabicFontCandidates, loadArabicFontInNode, ARABIC_FONT_FILE, 'Noto Sans Arabic', 'ب'],
    ['Hebrew', hebrewFontCandidates, loadHebrewFontInNode, HEBREW_FONT_FILE, 'Noto Sans Hebrew', 'ש'],
    ['Devanagari', devanagariFontCandidates, loadDevanagariFontInNode, DEVANAGARI_FONT_FILE, 'Noto Sans Devanagari', 'क'],
  ] as const)('are found by the Node loader in the %s font package, and are static TrueType fonts fontkit reads as they are', async (_name, candidates, load, file, family, letter) => {
    expect(candidates().some((path) => path.endsWith(file))).toBe(true);
    const bytes = await load();
    expect([...bytes.slice(0, 4)]).toEqual([0, 1, 0, 0]);
    const font = (await openFont(bytes)) as unknown as { familyName: string; variationAxes: Record<string, unknown>; hasGlyphForCodePoint(code: number): boolean };
    expect(font.familyName).toBe(family);
    expect(Object.keys(font.variationAxes)).toEqual([]);
    expect(font.hasGlyphForCodePoint(letter.codePointAt(0) ?? 0)).toBe(true);
  });
});

describe('the CJK Bold loader’s failure path', () => {
  it('names every place it looked when the file is in none of them', async () => {
    // The error says the file it wanted and every candidate it tried, in order.
    // os.tmpdir() + pathToFileURL: a hand-written 'file:///tmp/...' URL has no drive on Windows.
    const missingDir = join(tmpdir(), 'caotang-no-fonts-here');
    const missing = [join(missingDir, 'fonts', 'one.woff'), join(missingDir, 'fonts', 'two.woff')];
    await expect(readFirst(CJK_BOLD_FONT_FILE, missing)).rejects.toThrow(
      `${CJK_BOLD_FONT_FILE} is not at ${missing[0]} or ${missing[1]}`,
    );
    // The Bold loader goes through the same path: its candidates are the bundled `fonts/` copy, then the package.
    const candidates = cjkBoldFontCandidates(pathToFileURL(join(missingDir, 'loader.mjs')).href);
    expect(candidates[0]).toBe(join(missingDir, 'fonts', CJK_BOLD_FONT_FILE));
  });
});
