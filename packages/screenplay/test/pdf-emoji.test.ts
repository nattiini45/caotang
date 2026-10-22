/**
 * Emoji in the screenplay PDF (screenplay.md §5.3): grapheme clusters as units of the grid, the Noto Emoji fallback subset
 * laid out with fontkit, the coverage table against the font and Unicode's emoji list, the text a reader extracts, and
 * the Latin-only file that stays as it was.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as fontkitModule from '@pdf-lib/fontkit';
import type { Font } from '@pdf-lib/fontkit';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FlatBlock } from '../src/index.js';
import {
  createPdfRenderer,
  drawPdf,
  emojiPrint,
  importFountainScript,
  isEmojiCluster,
  layoutPdf,
  loadCjkFallback,
  loadCourierPrime,
  loadEmojiFallback,
  paginate,
  parseFountain,
  textColumns,
  textUnits,
  unitColumns,
  LAYOUT,
} from '../src/index.js';
import { emojiGlyph, subsetNotoEmoji } from '../src/emoji-font.js';
import { SCRIPT_ONE_ACT, SCRIPT_WITH_TITLE_PAGE, text } from './fixtures/corpus.js';
import { LOADERS, sourceEmoji } from './fixtures/fonts.js';

const fontkit = ((fontkitModule as unknown as { default?: typeof fontkitModule }).default ?? fontkitModule) as typeof fontkitModule;
// Unicode's list is kept with the coverage tables it generates (packages/pdf-fonts/scripts/emoji-coverage.mjs).
const EMOJI_TEST_PATH = new URL('../../pdf-fonts/test/fixtures/emoji-test-15.1.txt', import.meta.url);

let font: Font;
beforeAll(async () => {
  font = await sourceEmoji();
});

function blocksOf(source: string): FlatBlock[] {
  return importFountainScript(source).nodes.map((node, i): FlatBlock => {
    if (node.kind === 'section') return { kind: 'chapter', title: node.title, level: node.depth, number: i + 1 };
    return { kind: 'scene', docId: `d${i}`, body: node.body, title: node.title, number: i + 1 };
  });
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const linesOf = (source: string) => paginate(parseFountain(source).elements).flatMap((page) => page.lines);

async function pdfOf(source: string, title = 'T'): Promise<string> {
  const blob = await createPdfRenderer(LOADERS).emit(blocksOf(source), { title });
  return decode(new Uint8Array(await blob.arrayBuffer()));
}

/** Unicode's emoji list: each line's emoji and its status. */
function emojiList(): { emoji: string; status: string }[] {
  return readFileSync(EMOJI_TEST_PATH, 'utf8')
    .split('\n')
    .filter((line) => /^[0-9A-F]/.test(line))
    .map((line) => {
      const [points = '', rest = ''] = line.split(';');
      const emoji = String.fromCodePoint(...points.trim().split(/\s+/).map((hex) => parseInt(hex, 16)));
      return { emoji, status: rest.split('#')[0]?.trim() ?? '' };
    });
}

/**
 * The text a reader extracts: each Tj's string through its font (WinAnsi for F1, the ToUnicode maps for F2 and F3), the
 * runs of one baseline in x order.
 */
function extract(pdf: string): string[] {
  // Each font's ToUnicode map, in the order the file has them: the CJK font's first when there is one.
  const maps = [...pdf.matchAll(/begincmap[\s\S]*?endcmap/g)].map((cmap) => {
    const map = new Map<string, string>();
    for (const m of cmap[0].matchAll(/<([0-9A-F]{4})> <([0-9A-F]+)>/g)) {
      const units = (m[2] ?? '').match(/.{4}/g)?.map((h) => parseInt(h, 16)) ?? [];
      map.set(m[1] ?? '', String.fromCharCode(...units));
    }
    return map;
  });
  const hasCjk = pdf.includes('/F2 ');
  const mapOf = (font: string): Map<string, string> | undefined => (font === 'F2' ? maps[0] : maps[hasCjk ? 1 : 0]);
  const rows = new Map<string, { x: number; text: string }[]>();
  let page = 0;
  for (const stream of pdf.matchAll(/stream\nBT\n([\s\S]*?)\nET\nendstream/g)) {
    page += 1;
    let font = 'F1';
    let x = 0;
    let y = '';
    for (const op of (stream[1] ?? '').split('\n')) {
      const tf = /^\/(F\d) \d+ Tf$/.exec(op);
      const tm = /^1 0 0 1 (\S+) (\S+) Tm$/.exec(op);
      if (tf !== null) font = tf[1] ?? 'F1';
      else if (tm !== null) {
        x = Number(tm[1]);
        y = `${page}:${tm[2]}`;
      } else if (op.endsWith(' Tj')) {
        const body = op.slice(0, -3);
        const map = mapOf(font);
        const textOf =
          font === 'F1'
            ? body
                .slice(1, -1)
                .replace(/\\([()\\])/g, '$1')
                .replace(/\\(\d{3})/g, (_m, oct: string) => new TextDecoder('windows-1252').decode(new Uint8Array([parseInt(oct, 8)])))
            : (body.slice(1, -1).match(/.{4}/g) ?? []).map((cid) => map?.get(cid) ?? '\uFFFD').join('');
        const row = rows.get(y) ?? [];
        row.push({ x, text: textOf });
        rows.set(y, row);
      }
    }
  }
  return [...rows.values()].map((row) => row.sort((a, b) => a.x - b.x).map((run) => run.text).join(''));
}

const SEQUENCES = ['👨‍👩‍👧', '👍🏽', '🧑🏽‍💻', '🇩🇪', '🇺🇳', '1️⃣', '#️⃣', '🏴󠁧󠁢󠁳󠁣󠁴󠁿', '❤️', '🏳️‍🌈', '🐦‍🔥', '🙂‍↔️', '🫱🏻‍🫲🏿'];

describe('emoji as grapheme clusters', () => {
  it('cuts text into units: an emoji cluster whole, everything else a code point', () => {
    expect(textUnits('a👨‍👩‍👧b🇩🇪🇺🇳1️⃣')).toEqual(['a', '👨‍👩‍👧', 'b', '🇩🇪', '🇺🇳', '1️⃣']);
    expect(textUnits('🏴󠁧󠁢󠁳󠁣󠁴󠁿👍🏽')).toEqual(['🏴󠁧󠁢󠁳󠁣󠁴󠁿', '👍🏽']);
    expect(textUnits('Café 草堂')).toEqual([...'Café 草堂']);
    // A text-style selector stays with its character, which is not an emoji.
    expect(textUnits('❤︎!')).toEqual(['❤︎', '!']);
  });

  it('knows an emoji from a text-style pictograph', () => {
    for (const unit of [...SEQUENCES, '😀', '✅', '⌚', '🏽', '©️']) expect(isEmojiCluster(unit), unit).toBe(true);
    for (const unit of ['©', '®', '™', '❤', '☺', '❤︎', 'a', '草', '1']) expect(isEmojiCluster(unit), unit).toBe(false);
  });

  it('gives every emoji cluster two columns, however many code points it holds', () => {
    for (const unit of [...SEQUENCES, '😀', '✅']) expect(unitColumns(unit), unit).toBe(2);
    expect(textColumns('Hi 👨‍👩‍👧!')).toBe(6);
    expect(textColumns('🇩🇪🇺🇳')).toBe(4);
    // Latin text is still its length in code points.
    expect(textColumns('Crème brûlée — “twice”.')).toBe([...'Crème brûlée — “twice”.'].length);
  });

  it('never splits an emoji across lines, and fills a line to its 60 columns', () => {
    const lines = linesOf(text('👨‍👩‍👧'.repeat(31))).map((line) => line.text);
    expect(lines).toEqual(['👨‍👩‍👧'.repeat(30), '👨‍👩‍👧']);
  });

  it('wraps a dialogue line of emoji and text by columns', () => {
    const dialogue = linesOf(text('ANNA', `We won 🎉🎉🎉 ${'🇩🇪'.repeat(14)}`)).filter((line) => line.kind === 'dialogue');
    for (const line of dialogue) expect(textColumns(line.text)).toBeLessThanOrEqual(LAYOUT.width.dialogue);
    // A line may break between emoji with no space, as between Hanzi: 34 of the 35 columns, then the rest.
    expect(dialogue.map((line) => line.text)).toEqual([`We won 🎉🎉🎉 ${'🇩🇪'.repeat(10)}`, '🇩🇪'.repeat(4)]);
    // Twenty flags are 40 columns: the word breaks between flags, never inside one.
    const long = linesOf(text('ANNA', '🇩🇪'.repeat(20))).filter((line) => line.kind === 'dialogue');
    expect(long.map((line) => line.text)).toEqual(['🇩🇪'.repeat(17), '🇩🇪'.repeat(3)]);
  });
});

describe('the emoji fallback font', () => {
  it('is Noto Emoji Regular, with TrueType outlines', () => {
    expect(font.postscriptName).toBe('NotoEmoji-Regular');
  });

  it('maps every fully-qualified emoji of Unicode 15.1, the version the font supports, to a glyph', () => {
    const qualified = emojiList().filter((row) => row.status === 'fully-qualified');
    expect(qualified.length).toBe(3773);
    const base: string[] = [];
    for (const { emoji } of qualified) {
      const print = emojiPrint(emoji);
      expect(print, emoji).not.toBe('none');
      const glyph = emojiGlyph(font, emoji);
      expect(glyph?.id ?? 0, emoji).not.toBe(0);
      if (print === 'base') base.push(emoji);
    }
    // The ninety people "facing right" with a gender have no glyph of their own; they print as their first emoji.
    expect(base.length).toBe(90);
    for (const emoji of base) expect(emoji, emoji).toMatch(/\u200D\u27A1\uFE0F$/u);
  });

  it('says of every emoji in the list what the drawing then does', () => {
    for (const { emoji } of emojiList()) {
      if (!isEmojiCluster(emoji)) continue;
      const glyph = emojiGlyph(font, emoji);
      const print = emojiPrint(emoji);
      if (print === 'none') expect(glyph, emoji).toBeUndefined();
      else expect(glyph?.id ?? 0, emoji).not.toBe(0);
    }
  });

  it('lays out each sequence as one glyph: ZWJ, skin tone, flag, keycap, tag sequence, VS16', () => {
    for (const unit of SEQUENCES) {
      expect(emojiPrint(unit), unit).toBe('whole');
      expect(emojiGlyph(font, unit)?.id ?? 0, unit).not.toBe(0);
    }
    // A flag and its neighbour are different glyphs, and a toned thumb is the untoned one: the font has no skin tones.
    expect(emojiGlyph(font, '🇩🇪')?.id).not.toBe(emojiGlyph(font, '🇯🇵')?.id);
    expect(emojiGlyph(font, '👍🏽')?.id).toBe(emojiGlyph(font, '👍')?.id);
  });

  it('subsets to one CID a unit, each drawn as the font draws it, several CIDs to one glyph where they share it', async () => {
    const units = ['👍', '👍🏽', '🇩🇪', '👨‍👩‍👧', '1️⃣', '🏴󠁧󠁢󠁳󠁣󠁴󠁿'];
    const subset = await subsetNotoEmoji(font, units);
    expect(subset.baseFont).toMatch(/^[A-Z]{6}\+NotoEmoji-Regular$/);
    expect(subset.glyphs.size).toBe(units.length);
    expect(new Set(subset.entries.map((entry) => entry.gid)).size).toBe(units.length - 1);
    const read = fontkit.create(subset.program as Buffer);
    for (const [unit, glyph] of subset.glyphs) {
      const gid = subset.entries[glyph.cid - 1]?.gid ?? 0;
      expect(read.getGlyph(gid).path.toSVG(), unit).toBe(emojiGlyph(font, unit)?.path.toSVG());
      expect(glyph.width, unit).toBe(1440);
    }
    expect(subset.program.length).toBeLessThan(40_000);
  });
});

describe('the PDF with emoji', () => {
  const SCRIPT = text(
    'INT. ROOFTOP 🎉 - NIGHT',
    '',
    'The screen: 👨‍👩‍👧 then 👍🏽 and 🇩🇪, 1️⃣, 🏴󠁧󠁢󠁳󠁣󠁴󠁿.',
    '',
    'MARA',
    'We are late! 🏃‍♀️ 草堂 is closed. ✅',
  );

  it('prints each emoji as one glyph a reader copies back as the whole sequence', async () => {
    const pdf = await pdfOf(SCRIPT);
    const lines = extract(pdf);
    expect(lines).toContain('INT. ROOFTOP 🎉 - NIGHT');
    expect(lines).toContain('The screen: 👨‍👩‍👧 then 👍🏽 and 🇩🇪, 1️⃣, 🏴󠁧󠁢󠁳󠁣󠁴󠁿.');
    expect(lines).toContain('We are late! 🏃‍♀️ 草堂 is closed. ✅');
    expect(pdf).toContain('/Subtype /CIDFontType2');
    expect(pdf).toContain('/CIDToGIDMap ');
    expect(pdf).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoEmoji-Regular/);
    expect(pdf).toContain('/F3 10 Tf');
  });

  it('centres each emoji in its two-column cell', async () => {
    const pdf = await pdfOf(text('INT. A - DAY', '', '👨‍👩‍👧 x'));
    // The cell starts at the margin; the glyph is 2600/2048 em at 10 points, so it starts (14.4 − 12.7) / 2 points in.
    const dx = (14.4 - (2600 / 2048) * 10) / 2;
    expect(pdf).toContain(`1 0 0 1 ${(LAYOUT.marginLeft + Math.round(dx * 100) / 100).toFixed(2)} `);
    // And the x after it is two columns on.
    expect(pdf).toContain(`1 0 0 1 ${(LAYOUT.marginLeft + 2 * 7.2).toFixed(2)} `);
  });

  it('prints an emoji the font does not have as "?" in its two columns, and the log names it', async () => {
    const layout = layoutPdf(blocksOf(text('INT. A - DAY', '', 'A face newer than the font: 🫩 and ꙮ.')), { title: 'T' });
    expect(layout.notes).toEqual(['pdf: neither Courier Prime nor the CJK or emoji fallback font can print these 2 characters, so they are printed as "?": 🫩 ꙮ']);
    expect(layout.emojiCharacters).toEqual([]);
    const lines = extract(await pdfOf(text('INT. A - DAY', '', 'A face newer than the font: 🫩 and ꙮ.')));
    expect(lines).toContain('A face newer than the font: ? and ?.');
  });

  it('prints a sequence the font has no glyph for as its first emoji, and the log says so', () => {
    const layout = layoutPdf(blocksOf(text('INT. A - DAY', '', 'She walks off 🚶‍♀️‍➡️.')), { title: 'T' });
    expect(layout.notes).toEqual(['pdf: the emoji font has no glyph for this emoji sequence, so it is printed as its first emoji: 🚶‍♀️‍➡️']);
    expect(layout.emojiCharacters).toEqual(['🚶‍♀️‍➡️']);
  });

  it('keeps every byte ASCII and every xref offset exact with three fonts in the file', async () => {
    const pdf = await pdfOf(SCRIPT, 'Emoji 🎬');
    expect([...pdf].every((ch) => ch.charCodeAt(0) < 0x80)).toBe(true);
    expect(pdf).toContain('/Title <FEFF0045006D006F006A00690020D83CDFAC>');
    const xref = Number(/startxref\n(\d+)\n/.exec(pdf)?.[1]);
    const count = Number(/^0 (\d+)$/m.exec(pdf.slice(xref, xref + 40))?.[1]);
    const rows = pdf.slice(xref).split('\n');
    for (let object = 1; object < count; object++) {
      const offset = Number(rows[2 + object]?.slice(0, 10));
      expect(pdf.slice(offset).startsWith(`${object} 0 obj\n`), `object ${object}`).toBe(true);
    }
  });

  it('works with emoji and no CJK: the emoji font is F3 and the file has no CJK font', async () => {
    const pdf = await pdfOf(text('INT. A - DAY', '', 'Only 😀 here.'));
    expect(pdf).not.toContain('NotoSansMonoCJK');
    expect(pdf).toContain('/F1 3 0 R /F3 ');
    expect(extract(pdf)).toContain('Only 😀 here.');
  });
});

describe('a script with no emoji', () => {
  const HASHES = [
    '993f7c9ad93c53ad71daf2dc120a199b1150e481eff41e057870efd966c9b46e',
    '7d412410e99b12128d61b1eb5c6305e00f449dfc4be0da3a459be05bc52a48d0',
    '21f4fe6591176c4e933a473d0efb7d2dff1d2f1f099c6b2343269d77ddc03748',
  ];
  const BEFORE: readonly [string, string, boolean, Record<string, unknown>][] = [
    ['one act, Courier Prime', SCRIPT_ONE_ACT, true, {}],
    ['one act, base-14 Courier', SCRIPT_ONE_ACT, false, {}],
    ['title page and scene numbers', SCRIPT_WITH_TITLE_PAGE, true, { sceneNumbers: 'both', titlePage: true }],
  ];

  it.each(BEFORE.map((row, i) => [...row, HASHES[i]] as const))('is byte for byte the Latin file it was: %s', async (_name, source, embed, opts, hash) => {
    const layout = layoutPdf(blocksOf(source), { title: 'T', author: 'A', ...opts });
    expect(layout.emojiCharacters).toEqual([]);
    expect(await loadEmojiFallback(layout, LOADERS.emoji)).toBeUndefined();
    const bytes = drawPdf(layout, embed ? await loadCourierPrime() : undefined, await loadCjkFallback(layout, LOADERS.cjk), await loadEmojiFallback(layout, LOADERS.emoji));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(hash);
  });

  it('keeps © ® ™ in Courier Prime, and loads no emoji font for them', async () => {
    const layout = layoutPdf(blocksOf(text('INT. A - DAY', '', 'Acme™ © 2026 ® all rights.')), { title: 'T' });
    expect(layout.emojiCharacters).toEqual([]);
    const pdf = await pdfOf(text('INT. A - DAY', '', 'Acme™ © 2026 ® all rights.'));
    expect(pdf).not.toContain('NotoEmoji');
  });

  it('reaches the emoji module only by the dynamic import in render-pdf.ts', () => {
    const source = readFileSync(new URL('../src/render-pdf.ts', import.meta.url), 'utf8');
    expect(source).toContain("await import('./emoji-font.js')");
    expect(source).not.toMatch(/^import .*emoji-font/m);
    const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(index).not.toContain('emoji-font');
  });
});
