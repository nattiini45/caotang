/**
 * The Bold of the CJK font (vendor/noto-sans-cjk, #253): Noto Sans Mono CJK SC Bold, built by the same script as the Regular, as a
 * full and a common file. The checked-in files against SHA256SUMS and the budgets build.py states, that each maps exactly what the
 * Regular's file of its kind maps (so the Regular's coverage tables choose the Bold's file too), that the common file draws what the
 * full one does, and that the Node loader finds both.
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Font } from '@pdf-lib/fontkit';
import { cjkCommonCovers, cjkLoaderFor } from '../src/common.js';
import { CJK_BOLD_COMMON_FONT_FILE, CJK_BOLD_FONT_FILE, CJK_COMMON_FONT_FILE, CJK_FONT_FILE } from '../src/font-files.js';
import { loadFont } from '../src/fontkit.js';
import { hanGlyph, type HanLanguageTag } from '../src/han-locale.js';
import { cjkBoldCommonFontCandidates, cjkBoldFontCandidates, loadCjkBoldFontInNode, loadCjkFontInNode } from '../src/node-loader.js';

const VENDOR = new URL('../../../vendor/noto-sans-cjk/', import.meta.url);

/** The budgets build.py enforces: 2 MB for a common file and 11 MB for a full one, of 1,024 bytes. */
const COMMON_BUDGET = 2 * 1024 * 1024;
const FULL_BUDGET = 11 * 1024 * 1024;

const read = (file: string): Buffer => readFileSync(new URL(file, VENDOR));
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const sizeOf = (file: string): number => statSync(new URL(file, VENDOR)).size;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function pinned(file: string): string | undefined {
  return read('SHA256SUMS')
    .toString('utf8')
    .split(/\r?\n/)
    .map((line) => line.split(/\s+/))
    .find((parts) => parts[1] === file)?.[0];
}

describe('the Bold CJK font files', () => {
  it.each([CJK_BOLD_FONT_FILE, CJK_BOLD_COMMON_FONT_FILE])('%s is the file SHA256SUMS pins', (file) => {
    expect(pinned(file)).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256(read(file))).toBe(pinned(file));
  });

  it('pins the upstream Bold OTF it is built from', () => {
    expect(pinned('NotoSansMonoCJKsc-Bold.otf')).toBe('a452fedfc0619e43e080b7b861ce34cbd3ec4fbcea495bf8c402a5a02a5dcbdc');
  });

  it('keeps every file of both weights within its budget, the common file smaller than the full one', () => {
    for (const [full, common] of [
      [CJK_FONT_FILE, CJK_COMMON_FONT_FILE],
      [CJK_BOLD_FONT_FILE, CJK_BOLD_COMMON_FONT_FILE],
    ] as const) {
      expect(sizeOf(full), full).toBeLessThanOrEqual(FULL_BUDGET);
      expect(sizeOf(common), common).toBeLessThanOrEqual(COMMON_BUDGET);
      expect(sizeOf(common)).toBeLessThan(sizeOf(full));
    }
    expect([sizeOf(CJK_BOLD_FONT_FILE), sizeOf(CJK_BOLD_COMMON_FONT_FILE)]).toEqual([10786312, 1968608]);
  });

  it('is a TrueType WOFF, not CFF (@pdf-lib/fontkit 1.1.1 writes broken CFF subsets)', () => {
    for (const file of [CJK_BOLD_FONT_FILE, CJK_BOLD_COMMON_FONT_FILE]) {
      const bytes = read(file);
      expect(bytes.subarray(0, 4).toString('latin1'), file).toBe('wOFF');
      // The flavour of the wrapped font: 00 01 00 00 is TrueType outlines, OTTO would be CFF.
      expect([...bytes.subarray(4, 8)], file).toEqual([0, 1, 0, 0]);
    }
  });
});

describe('the Bold CJK font', () => {
  let bold: Font;
  let boldCommon: Font;
  let regular: Font;
  let regularCommon: Font;
  beforeAll(async () => {
    [bold, boldCommon, regular, regularCommon] = await Promise.all([
      loadFont(loadCjkBoldFontInNode, 'Bold CJK font'),
      loadFont(loadCjkBoldFontInNode.common, 'Bold common CJK font'),
      loadFont(loadCjkFontInNode, 'CJK font'),
      loadFont(loadCjkFontInNode.common, 'common CJK font'),
    ]);
  }, 60_000);

  it('is the Bold weight of the Regular’s family', () => {
    expect(bold.postscriptName).toBe('NotoSansMonoCJKsc-Bold');
    expect(boldCommon.postscriptName).toBe('NotoSansMonoCJKsc-Bold');
    expect(bold.familyName).toBe(regular.familyName);
    expect(bold.unitsPerEm).toBe(regular.unitsPerEm);
  });

  it('maps exactly the characters the Regular maps, in the full and in the common file', () => {
    expect([...bold.characterSet]).toEqual([...regular.characterSet]);
    expect([...boldCommon.characterSet]).toEqual([...regularCommon.characterSet]);
    // So the Regular's table of the common file says which Bold file a document reads.
    for (const code of boldCommon.characterSet.slice(0, 200)) expect(cjkCommonCovers(String.fromCodePoint(code))).toBe(true);
  });

  it('draws the characters of the common file as its full file does, in the forms of every language', () => {
    const tags: (HanLanguageTag | undefined)[] = [undefined, 'JAN ', 'KOR ', 'ZHT ', 'ZHH '];
    let differing = 0;
    // Every 7th character of the common set, and the ones the issue names, in every regional form.
    const sample = [...boldCommon.characterSet.filter((_, index) => index % 7 === 0), ...[...'草堂鬱國語體學骨直'].map((ch) => ch.codePointAt(0) ?? 0)];
    for (const code of sample) {
      const ch = String.fromCodePoint(code);
      if (!boldCommon.hasGlyphForCodePoint(code)) continue;
      for (const tag of tags) {
        const a = hanGlyph(boldCommon, ch, tag);
        const b = hanGlyph(bold, ch, tag);
        if (a.advanceWidth !== b.advanceWidth || !same(a.path.toSVG(), b.path.toSVG())) differing += 1;
      }
    }
    expect(differing).toBe(0);
  }, 120_000);

  it('draws designed bold glyphs, not the Regular’s, and says it is weight 700', () => {
    expect(same(bold.glyphForCodePoint(0x8349).path.toSVG(), regular.glyphForCodePoint(0x8349).path.toSVG())).toBe(false);
    const weight = (font: Font): number => (font as unknown as { 'OS/2': { usWeightClass: number } })['OS/2'].usWeightClass;
    expect(weight(bold)).toBe(700);
    expect(weight(regular)).toBe(400);
  });

  it('is read from its common file for common characters and from the full file for a rare one (龘)', () => {
    expect(cjkLoaderFor(loadCjkBoldFontInNode, '草堂第页')).toBe(loadCjkBoldFontInNode.common);
    expect(cjkLoaderFor(loadCjkBoldFontInNode, '草堂龘')).not.toBe(loadCjkBoldFontInNode.common);
  });

  it('is found by the Node loader in the font package', async () => {
    const ends = (paths: readonly string[], file: string): boolean => paths.some((path) => path.replaceAll('\\', '/').endsWith(`/${file}`));
    expect(ends(cjkBoldFontCandidates(), CJK_BOLD_FONT_FILE)).toBe(true);
    expect(ends(cjkBoldCommonFontCandidates(), CJK_BOLD_COMMON_FONT_FILE)).toBe(true);
    expect(new TextDecoder().decode((await loadCjkBoldFontInNode.common()).slice(0, 4))).toBe('wOFF');
  });
});
