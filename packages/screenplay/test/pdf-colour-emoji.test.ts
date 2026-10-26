/**
 * Colour emoji in the screenplay PDF (screenplay.md §5.3): Noto Color Emoji's vector pictures as Type 3 fonts, in the same cell as the
 * monochrome emoji; the layout that knows which emoji print in colour before the file loads; the fallback to the monochrome font per
 * emoji and for the whole file; the text a reader copies out; and the file it leaves as it was when colour is off.
 */

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { isEmojiCluster } from '@caotang/pdf-fonts';
import { colourEmojiCovers } from '@caotang/pdf-fonts/colour';
import { loadColourEmojiInNode } from '@caotang/pdf-fonts/node-loader';
import { describe, expect, it } from 'vitest';
import type { FlatBlock } from '../src/index.js';
import { drawPdf, importFountainScript, layoutPdf, preparePdf, renderPdf } from '../src/index.js';
import { LOADERS } from './fixtures/fonts.js';

const EMOJI_TEST = new URL('../../pdf-fonts/test/fixtures/emoji-test-17.0.txt', import.meta.url);

function blocksOf(source: string): FlatBlock[] {
  return importFountainScript(source).nodes.map((node, i): FlatBlock => {
    if (node.kind === 'section') return { kind: 'chapter', title: node.title, level: node.depth, number: i + 1 };
    return { kind: 'scene', docId: `d${i}`, body: node.body, title: node.title, number: i + 1 };
  });
}

const SOURCE = 'INT. KITCHEN - DAY\n\nMara waves 👍🏽 at the flag 🏳️‍🌈 and a family 👨‍👩‍👧, then ❤️ and 1️⃣ and 🇩🇪.\n';
const LOADERS_COLOUR = { ...LOADERS, colourEmoji: loadColourEmojiInNode };

const decode = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

/** The streams of a file written with the hexadecimal and Flate filters, decoded to text. */
function deflatedStreams(pdf: string): string[] {
  return [...pdf.matchAll(/\/Filter \[\/ASCIIHexDecode \/FlateDecode\] ?>>\nstream\n([0-9A-F\n]*)>\nendstream/g)].map((match) =>
    inflateSync(Buffer.from((match[1] ?? '').replaceAll('\n', ''), 'hex')).toString('latin1'),
  );
}

/** The ToUnicode entries of the Type 3 fonts of a file, as the text they give back. */
function type3Texts(pdf: string): string[] {
  const texts: string[] = [];
  for (const map of deflatedStreams(pdf)) {
    if (!map.includes('<00> <FF>')) continue;
    for (const entry of map.matchAll(/<[0-9A-F]{2}> <([0-9A-F]{4,})>/g)) {
      const hex = entry[1] ?? '';
      const units: number[] = [];
      for (let i = 0; i + 4 <= hex.length; i += 4) units.push(parseInt(hex.slice(i, i + 4), 16));
      texts.push(String.fromCharCode(...units));
    }
  }
  return texts;
}

describe('the layout with the colour set', () => {
  it('names the emoji the colour set prints, and keeps them out of the monochrome font’s list', () => {
    const layout = layoutPdf(blocksOf(SOURCE), { title: 'T' }, undefined, colourEmojiCovers);
    expect(layout.colourCharacters).toEqual(['👍🏽', '🏳️‍🌈', '👨‍👩‍👧', '❤️', '1️⃣', '🇩🇪']);
    expect(layout.emojiCharacters).toEqual([]);
    expect(layout.colourNotes).toEqual([]);
  });

  it('is the layout it was without it: the same pages, whichever font draws an emoji', () => {
    const plain = layoutPdf(blocksOf(SOURCE), { title: 'T' });
    const colour = layoutPdf(blocksOf(SOURCE), { title: 'T' }, undefined, colourEmojiCovers);
    expect(colour.pages).toEqual(plain.pages);
    expect(plain.colourCharacters).toEqual([]);
    expect(plain.emojiCharacters).toEqual(colour.colourCharacters);
  });

  it('leaves an emoji the colour set lacks to the monochrome font and names it in the log', () => {
    // A dog with a skin tone is no emoji of Unicode.
    const layout = layoutPdf(blocksOf('INT. A - DAY\n\nHi 😀 and 🐶🏽.\n'), { title: 'T' }, undefined, colourEmojiCovers);
    expect(layout.colourCharacters).toEqual(['😀']);
    expect(layout.emojiCharacters).toEqual(['🐶🏽']);
    expect(layout.colourNotes).toEqual(['pdf: Noto Color Emoji has no picture for this emoji, so it is printed in black and white: 🐶🏽']);
  });

  it('puts every fully-qualified emoji of Unicode 17.0 in the colour set, or names it as one that falls back', () => {
    const emoji = readFileSync(EMOJI_TEST, 'utf8')
      .split('\n')
      .flatMap((line) => {
        const match = /^([0-9A-F ]+?)\s*;\s*fully-qualified\b/.exec(line);
        return match === null ? [] : [String.fromCodePoint(...(match[1] ?? '').trim().split(/\s+/).map((hex) => parseInt(hex, 16)))];
      });
    expect(emoji.length).toBeGreaterThan(3600);
    // Twenty to a line keeps each paragraph short; the emoji are laid out as the script holds them.
    const lines: string[] = [];
    for (let i = 0; i < emoji.length; i += 20) lines.push(emoji.slice(i, i + 20).join(' '));
    const layout = layoutPdf(blocksOf(`INT. A - DAY\n\n${lines.join('\n\n')}\n`), { title: 'T' }, undefined, colourEmojiCovers);
    const named = new Set(layout.colourNotes.join(' '));
    const printed = new Set(layout.colourCharacters);
    const falls = new Set(layout.emojiCharacters);
    for (const one of emoji) {
      const prints = printed.has(one) || falls.has(one);
      expect(prints, one).toBe(true);
      // An emoji that falls back is in the log's note (which names ten and then an ellipsis), so every one of them is counted there.
      if (falls.has(one)) expect(named.size, one).toBeGreaterThan(0);
    }
    expect(layout.colourCharacters.length + layout.emojiCharacters.length).toBe(new Set(emoji).size);
    expect(layout.emojiCharacters).toEqual([]);
  });
});

describe('the file with colour emoji', () => {
  it('draws each emoji as one Type 3 code in the cell of the monochrome emoji, with the whole sequence in ToUnicode', async () => {
    const prepared = await preparePdf(blocksOf(SOURCE), { title: 'T', colourEmoji: true }, LOADERS_COLOUR);
    expect(prepared.colour?.glyphs.size).toBe(6);
    expect(prepared.emoji).toBeUndefined();
    const pdf = decode(drawPdf(prepared.layout, prepared.font, prepared.cjk, prepared.emoji, prepared.rtl, prepared.colour));
    expect(pdf).toContain('/Subtype /Type3');
    expect(pdf).not.toContain('NotoEmoji-Regular');
    expect(pdf).toContain('/CE1 ');
    expect(type3Texts(pdf)).toEqual(expect.arrayContaining(['👍🏽', '🏳️‍🌈', '👨‍👩‍👧', '❤️', '1️⃣', '🇩🇪']));
    expect(pdf).toContain('/FontMatrix [0.001 0 0 0.001 0 0]');
    // Each emoji is set at 10 points on its own Tm, like the monochrome emoji: a one-byte hex code.
    expect(pdf.match(/<0[1-6]> Tj/g)).toHaveLength(6);
  });

  it('keeps the monochrome font for the emoji the colour set lacks, in the same file', async () => {
    const prepared = await preparePdf(blocksOf('INT. A - DAY\n\nHi 😀 and 🐶🏽.\n'), { title: 'T', colourEmoji: true }, LOADERS_COLOUR);
    expect(prepared.colour?.glyphs.size).toBe(1);
    expect(prepared.emoji?.glyphs.size).toBe(1);
    expect(prepared.colourNotes).toHaveLength(1);
    const pdf = decode(drawPdf(prepared.layout, prepared.font, prepared.cjk, prepared.emoji, prepared.rtl, prepared.colour));
    expect(pdf).toContain('/Subtype /Type3');
    expect(pdf).toContain('NotoEmoji-Regular');
  });

  it('gives each 255 emoji a Type 3 font of their own', async () => {
    // Distinct emoji of the Miscellaneous Symbols and Pictographs, Emoticons and Transport blocks, a few hundred of them.
    const many = Array.from({ length: 700 }, (_, i) => String.fromCodePoint(0x1f300 + i)).filter((cluster) => isEmojiCluster(cluster) && colourEmojiCovers(cluster));
    expect(many.length).toBeGreaterThan(260);
    const prepared = await preparePdf(blocksOf(`INT. A - DAY\n\n${many.join(' ')}\n`), { title: 'T', colourEmoji: true }, LOADERS_COLOUR);
    expect(prepared.colour?.fonts.fonts.length).toBe(Math.ceil(many.length / 255));
    const pdf = decode(drawPdf(prepared.layout, prepared.font, prepared.cjk, prepared.emoji, prepared.rtl, prepared.colour));
    expect(pdf).toContain('/CE1 ');
    expect(pdf).toContain('/CE2 ');
    expect(type3Texts(pdf)).toHaveLength(prepared.colour?.glyphs.size ?? -1);
    expect(prepared.colour?.glyphs.size).toBeGreaterThan(510);
  });

  it('prints the whole file in monochrome, and says so, when the colour file is not the shipped one', async () => {
    const prepared = await preparePdf(blocksOf(SOURCE), { title: 'T', colourEmoji: true }, { ...LOADERS, colourEmoji: async () => new Uint8Array([1, 2, 3]) });
    expect(prepared.colour).toBeUndefined();
    expect(prepared.emoji?.glyphs.size).toBe(6);
    expect(prepared.colourNotes).toHaveLength(1);
    expect(prepared.colourNotes[0]).toMatch(/^pdf: the colour emoji could not be read \(.*\), so the emoji are printed in black and white$/);
  });

  it('never reads the colour file for a script without an emoji, or with colour off', async () => {
    let reads = 0;
    const counting = async (): Promise<Uint8Array> => {
      reads += 1;
      return loadColourEmojiInNode();
    };
    await preparePdf(blocksOf('INT. A - DAY\n\nNothing but words.\n'), { title: 'T', colourEmoji: true }, { ...LOADERS, colourEmoji: counting });
    await preparePdf(blocksOf(SOURCE), { title: 'T' }, { ...LOADERS, colourEmoji: counting });
    await preparePdf(blocksOf(SOURCE), { title: 'T', colourEmoji: false }, { ...LOADERS, colourEmoji: counting });
    expect(reads).toBe(0);
  });

  it('writes the monochrome file it always wrote when colour is off, with the colour loader passed or not', async () => {
    const off = await preparePdf(blocksOf(SOURCE), { title: 'T' }, LOADERS);
    const withLoader = await preparePdf(blocksOf(SOURCE), { title: 'T', colourEmoji: false }, LOADERS_COLOUR);
    const a = drawPdf(off.layout, off.font, off.cjk, off.emoji, off.rtl);
    const b = drawPdf(withLoader.layout, withLoader.font, withLoader.cjk, withLoader.emoji, withLoader.rtl, withLoader.colour);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('puts no text of the script into a glyph: a script of PDF syntax only reaches the content stream through its own string', async () => {
    const prepared = await preparePdf(blocksOf('INT. A - DAY\n\n👍 ) Tj (evil) /Pwn gs <</S/JavaScript>> 👍🏽\n'), { title: 'T', colourEmoji: true }, LOADERS_COLOUR);
    const pdf = decode(drawPdf(prepared.layout, prepared.font, prepared.cjk, prepared.emoji, prepared.rtl, prepared.colour));
    // The syntax is typed into the one string it is escaped in, and no glyph procedure holds it.
    expect(pdf.match(/evil/g)).toHaveLength(1);
    const procedures = deflatedStreams(pdf).filter((stream) => stream.startsWith('1440 0 d0'));
    expect(procedures).toHaveLength(2);
    for (const procedure of procedures) expect(procedure).not.toMatch(/evil|Tj|JavaScript|[()]/);
  });

  it('renders through renderPdf with the colour set the host passes', async () => {
    const prepared = await preparePdf(blocksOf(SOURCE), { title: 'T', colourEmoji: true }, LOADERS_COLOUR);
    const result = renderPdf(blocksOf(SOURCE), { title: 'T' }, prepared.font, prepared.cjk, prepared.emoji, prepared.rtl, undefined, prepared.colour, colourEmojiCovers);
    expect(decode(result.bytes)).toContain('/Subtype /Type3');
    expect(result.notes).toEqual([]);
  });
});
