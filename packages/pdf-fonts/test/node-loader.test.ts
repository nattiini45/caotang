/**
 * The Node loaders (node-loader.ts) find the two fallback fonts in their packages, and the files unpack from WOFF to the
 * TrueType fonts fontkit reads.
 */

import { describe, expect, it } from 'vitest';
import { CJK_FONT_FILE, EMOJI_FONT_FILE } from '../src/font-files.js';
import { sfntFromWoff } from '../src/font-bytes.js';
import { openFont } from '../src/fontkit.js';
import { cjkFontCandidates, emojiFontCandidates, loadCjkFontInNode, loadEmojiFontInNode } from '../src/node-loader.js';

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
