/**
 * The common CJK and emoji files in the screenplay PDF (screenplay.md §5.3, pdf-fonts `common.ts`): a script whose characters are
 * all in a common file reads only that, a script with one character outside it reads the full font, and the PDF holds the same
 * font program whichever file is read.
 */

import { withCommon, type CommonFontLoader, type FontLoader } from '@caotang/pdf-fonts';
import { describe, expect, it } from 'vitest';
import type { FlatBlock } from '../src/index.js';
import { createPdfRenderer, drawPdf, importFountainScript, layoutPdf, loadCjkFallback, loadCourierPrime, loadEmojiFallback } from '../src/index.js';
import { text } from './fixtures/corpus.js';
import { LOADERS } from './fixtures/fonts.js';

function blocksOf(source: string): FlatBlock[] {
  return importFountainScript(source).nodes.map((node, i): FlatBlock => {
    if (node.kind === 'section') return { kind: 'chapter', title: node.title, level: node.depth, number: i + 1 };
    return { kind: 'scene', docId: `d${i}`, body: node.body, title: node.title, number: i + 1 };
  });
}

/** A loader that records which of its two files it read. */
function watched(of: CommonFontLoader): { readonly load: CommonFontLoader; readonly reads: string[] } {
  const reads: string[] = [];
  const load = withCommon(
    async () => {
      reads.push('full');
      return of();
    },
    async () => {
      reads.push('common');
      return of.common();
    },
  );
  return { load, reads };
}

/** The same font with no common file, so the full font is always what is read. */
const fullOnly = (of: FontLoader): FontLoader => async () => of();

/**
 * A font program as bytes, without the `head` table's checkSumAdjustment: fontkit's subset copies it from the file it was cut
 * from, where it is that whole file's checksum, so it differs between the two files and means nothing in a subset.
 */
function withoutChecksum(program: Uint8Array): Uint8Array {
  const view = new DataView(program.buffer, program.byteOffset, program.byteLength);
  const copy = program.slice();
  for (let i = 0; i < view.getUint16(4); i += 1) {
    const entry = 12 + i * 16;
    if (String.fromCharCode(...program.subarray(entry, entry + 4)) === 'head') copy.fill(0, view.getUint32(entry + 8) + 8, view.getUint32(entry + 8) + 12);
  }
  return copy;
}

/** What a PDF holds of a subset: the font's name, the unit each CID stands for and its width, the glyph each draws, and the font program. */
function held(subset: { readonly baseFont: string; readonly entries: readonly unknown[]; readonly glyphs: ReadonlyMap<string, unknown>; readonly program: Uint8Array } | undefined): unknown {
  if (subset === undefined) throw new Error('no subset');
  return { baseFont: subset.baseFont, entries: subset.entries, glyphs: [...subset.glyphs], program: Buffer.from(withoutChecksum(subset.program)).toString('hex') };
}

const CHINESE = '杜甫坐在窗前，灯火摇动。他提笔写下第一行诗。';
const JAPANESE = 'ユキはカーテンを開ける。朝の光が部屋に差し込む。';
const KOREAN = '안녕하세요! 오늘 날씨가 정말 좋네요.';
const RARE = '龘';

describe('the CJK file a script reads', () => {
  const common = text('INT. 草堂 - NIGHT', '', CHINESE, '', 'YUKI', JAPANESE, '', 'MINJUN', KOREAN);
  const outside = text('INT. 草堂 - NIGHT', '', `${CHINESE}${RARE}`, '', 'YUKI', JAPANESE);

  it('is the common file when every character is in it', async () => {
    const { load, reads } = watched(LOADERS.cjk);
    const layout = layoutPdf(blocksOf(common), { title: 'T' });
    expect(await loadCjkFallback(layout, load)).toBeDefined();
    expect(reads).toEqual(['common']);
  });

  it('is the full font when one character is outside it, and the character prints, with no "?" and no note', async () => {
    const { load, reads } = watched(LOADERS.cjk);
    const layout = layoutPdf(blocksOf(outside), { title: 'T' });
    expect(layout.fallbackCharacters).toContain(RARE);
    expect(layout.notes).toEqual([]);
    const subset = await loadCjkFallback(layout, load);
    expect(reads).toEqual(['full']);
    expect(subset?.glyphs.has(RARE)).toBe(true);
    expect(subset?.entries.find((entry) => entry.text === RARE)?.gid).toBeGreaterThan(0);
  });

  it.each([undefined, 'ja', 'ko', 'zh-TW', 'zh-HK'])('puts the same font in the PDF from either file, in the project language %s', async (language) => {
    const font = await loadCourierPrime();
    for (const source of [common, outside]) {
      const layout = layoutPdf(blocksOf(source), { title: 'T', ...(language === undefined ? {} : { language }) });
      const fromCommon = await loadCjkFallback(layout, LOADERS.cjk, language);
      const fromFull = await loadCjkFallback(layout, fullOnly(LOADERS.cjk), language);
      expect(held(fromCommon)).toEqual(held(fromFull));
      expect(drawPdf(layout, font, fromCommon).length).toBe(drawPdf(layout, font, fromFull).length);
    }
  });

  it('reads no file for a script with no CJK character', async () => {
    const { load, reads } = watched(LOADERS.cjk);
    const layout = layoutPdf(blocksOf(text('INT. CAFÉ - DAY', '', 'Crème brûlée.')), { title: 'T' });
    expect(await loadCjkFallback(layout, load)).toBeUndefined();
    expect(reads).toEqual([]);
  });

  it('is read once, whatever the number of compiles that need the same file', async () => {
    const { load, reads } = watched(LOADERS.cjk);
    const renderer = createPdfRenderer({ ...LOADERS, cjk: load });
    await renderer.emit(blocksOf(common), { title: 'T' });
    await renderer.emit(blocksOf(common), { title: 'T' });
    expect(reads).toEqual(['common']);
  });
});

describe('the emoji file a script reads', () => {
  const common = text('INT. HARBOUR - DAY', '', 'Dogs 🐶 and a heart ❤️, the number 1️⃣, a smile 😀.');
  const outside = text('INT. HARBOUR - DAY', '', 'Dogs 🐶, a family 👨‍👩‍👧 and the flag 🇩🇪.');

  it('is the common file when every emoji is in it', async () => {
    const { load, reads } = watched(LOADERS.emoji);
    const layout = layoutPdf(blocksOf(common), { title: 'T' });
    expect(layout.emojiCharacters.length).toBeGreaterThan(0);
    expect(await loadEmojiFallback(layout, load)).toBeDefined();
    expect(reads).toEqual(['common']);
  });

  it.each([['a ZWJ sequence', '👨‍👩‍👧'], ['a flag', '🇩🇪'], ['a skin tone', '👍🏽'], ['an emoji of a group the common file leaves out', '🚗']])(
    'is the full font for %s, and the emoji prints with no note',
    async (_name, emoji) => {
      const { load, reads } = watched(LOADERS.emoji);
      const layout = layoutPdf(blocksOf(text('INT. HARBOUR - DAY', '', `Dogs 🐶 and ${emoji}.`)), { title: 'T' });
      const subset = await loadEmojiFallback(layout, load);
      expect(reads).toEqual(['full']);
      expect(layout.notes).toEqual([]);
      expect(subset?.glyphs.has(emoji)).toBe(true);
    },
  );

  it('puts the same font in the PDF from either file', async () => {
    const font = await loadCourierPrime();
    for (const source of [common, outside]) {
      const layout = layoutPdf(blocksOf(source), { title: 'T' });
      const fromCommon = await loadEmojiFallback(layout, LOADERS.emoji);
      const fromFull = await loadEmojiFallback(layout, fullOnly(LOADERS.emoji));
      expect(held(fromCommon)).toEqual(held(fromFull));
      expect(drawPdf(layout, font, undefined, fromCommon).length).toBe(drawPdf(layout, font, undefined, fromFull).length);
    }
  });

  it('reads no file for a script with no emoji', async () => {
    const { load, reads } = watched(LOADERS.emoji);
    const layout = layoutPdf(blocksOf(text('INT. CAFÉ - DAY', '', 'Crème brûlée © ®.')), { title: 'T' });
    expect(await loadEmojiFallback(layout, load)).toBeUndefined();
    expect(reads).toEqual([]);
  });
});
