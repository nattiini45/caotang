/**
 * The one CID-font writer both PDFs use (cid-font.ts): a CID for each (glyph, text) pair, never one per glyph; a CIDToGIDMap
 * that sends each CID to its glyph in the subset; a ToUnicode map with 100 entries to a block; and objects that refer to each
 * other by index, so a host can write them with any PDF library.
 */

import { describe, expect, it } from 'vitest';
import { NO_TEXT, cidFontObjects, cutCidSubset, toUnicodeCMap, type CidSubset } from '../src/cid-font.js';
import { loadFont, openFont } from '../src/fontkit.js';
import { loadCjkFontInNode, loadEmojiFontInNode } from '../src/node-loader.js';

const decode = (bytes: Uint8Array | string | undefined): string => (typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes));

describe('cutCidSubset', () => {
  it('gives each unit a CID of its own, in order, and stores a glyph once however many CIDs name it', async () => {
    const font = await loadFont(loadEmojiFontInNode, 'emoji font');
    const thumbs = font.glyphForCodePoint(0x1f44d).id;
    const subset = await cutCidSubset(
      font,
      [
        { glyphId: thumbs, width: 1440, text: '👍' },
        { glyphId: thumbs, width: 1440, text: '👍🏽' },
        { glyphId: font.glyphForCodePoint(0x1f3ac).id, width: 1440, text: '🎬' },
      ],
      'NotoEmoji-Regular',
    );
    expect(subset.baseFont).toMatch(/^[A-Z]{6}\+NotoEmoji-Regular$/);
    expect(subset.entries.map((entry) => entry.text)).toEqual(['👍', '👍🏽', '🎬']);
    expect(subset.entries[0]?.gid).toBe(subset.entries[1]?.gid);
    expect(subset.entries[2]?.gid).not.toBe(subset.entries[0]?.gid);
    // .notdef and two glyphs.
    expect((await openFont(subset.program)).numGlyphs).toBe(3);
  });

  it('gives the same name to the same subset, and another to another', async () => {
    const font = await loadFont(loadCjkFontInNode, 'CJK font');
    const cut = (chars: string): Promise<CidSubset> =>
      cutCidSubset(font, [...chars].map((char) => ({ glyphId: font.glyphForCodePoint(char.codePointAt(0) ?? 0).id, width: 1200, text: char })), 'NotoSansMonoCJKsc-Regular');
    expect((await cut('草堂')).baseFont).toBe((await cut('草堂')).baseFont);
    expect((await cut('草堂')).baseFont).not.toBe((await cut('草堂早')).baseFont);
  });
});

describe('cidFontObjects', () => {
  const subset: CidSubset = {
    baseFont: 'ABCDEF+Test',
    program: new Uint8Array([1, 2, 3]),
    entries: [
      { gid: 1, width: 600, text: 'a' },
      { gid: 1, width: 1200, text: 'b' },
      { gid: 2, width: 1200, text: '' },
    ],
    bbox: [-10, -20, 30, 40],
    ascent: 800,
    descent: -200,
    capHeight: 700,
  };
  const objects = cidFontObjects(subset);

  it('writes the six objects in the order the hosts number them', () => {
    expect(objects).toHaveLength(6);
    expect(objects[0]?.dict).toMatchObject({ Subtype: { name: 'Type0' }, Encoding: { name: 'Identity-H' }, DescendantFonts: [{ ref: 1 }], ToUnicode: { ref: 4 } });
    expect(objects[1]?.dict).toMatchObject({ Subtype: { name: 'CIDFontType2' }, FontDescriptor: { ref: 2 }, CIDToGIDMap: { ref: 5 }, DW: 1000 });
    expect(objects[1]?.dict['W']).toEqual([1, [600, 1200, 1200]]);
    expect(objects[2]?.dict).toMatchObject({ FontFile2: { ref: 3 }, FontBBox: [-10, -20, 30, 40], Ascent: 800, Descent: -200, CapHeight: 700 });
    expect(objects[3]?.stream).toBe(subset.program);
    expect(objects[3]?.dict).toEqual({ Length1: 3 });
  });

  it('maps each CID to its glyph, CID 0 to .notdef, so two CIDs can share one glyph', () => {
    expect([...(objects[5]?.stream as Uint8Array)]).toEqual([0, 0, 0, 1, 0, 1, 0, 2]);
  });

  it('gives a CID with text its ToUnicode entry, and a CID without text the zero-width space, never no entry', () => {
    const map = decode(objects[4]?.stream);
    expect(map).toContain('3 beginbfchar\n<0001> <0061>\n<0002> <0062>\n<0003> <200B>\nendbfchar');
  });
});

describe('toUnicodeCMap', () => {
  it('maps every CID, so no reader falls back to the CID as the text: pdf.js reads an unmapped code as the character of that number', () => {
    // Fifty CIDs, a few with no text, among them one past 0x20 (a printable character if it were left unmapped).
    const entries = Array.from({ length: 50 }, (_, index) => ({ gid: index + 1, width: 500, text: index % 7 === 3 ? '' : String.fromCharCode(0x627 + index) }));
    const map = toUnicodeCMap(entries);
    const mapped = [...map.matchAll(/^<([0-9A-F]{4})> <([0-9A-F]+)>$/gm)].map((match) => [parseInt(match[1] ?? '', 16), match[2]] as const).filter(([cid]) => cid > 0);
    expect(mapped.map(([cid]) => cid)).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
    expect(mapped.filter(([, text]) => text === '200B').map(([cid]) => cid)).toEqual([4, 11, 18, 25, 32, 39, 46]);
    expect(NO_TEXT).toBe('​');
  });

  it('writes 100 entries to a block, as the PDF spec allows at most, and an astral character as a surrogate pair', () => {
    const entries = Array.from({ length: 250 }, (_, index) => ({ gid: index + 1, width: 1000, text: index === 0 ? '👍' : 'x' }));
    const map = toUnicodeCMap(entries);
    expect([...map.matchAll(/(\d+) beginbfchar/g)].map((match) => match[1])).toEqual(['100', '100', '50']);
    expect(map).toContain('<0001> <D83DDC4D>');
  });
});
