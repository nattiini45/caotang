/**
 * The colour emoji asset (colour-emoji.ts, vendor/noto-color-emoji) and the Type 3 writer (type3.ts): the file against its pin and
 * its budget, the coverage table against the file and Unicode's emoji list, every operator and name the file holds against the
 * whitelist the build enforces, the writer's objects, and the guarantee that a document's text never reaches a glyph.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ColourEmoji, colourEmojiCovers, colourEmojiKey, openColourEmoji } from '../src/colour-emoji.js';
import { NOTO_COLOUR_EMOJI_BYTES, NOTO_COLOUR_EMOJI_KEYS, NOTO_COLOUR_EMOJI_SHA256 } from '../src/coverage/noto-colour-emoji-coverage.js';
import { loadColourEmojiInNode } from '../src/node-loader.js';
import { TYPE3_CODES, type3Objects, type3Place, type Type3Glyph } from '../src/type3.js';
import { cidFontObjects } from '../src/cid-font.js';

const VENDOR = new URL('../../../vendor/noto-color-emoji/', import.meta.url);
const EMOJI_TEST = new URL('./fixtures/emoji-test-17.0.txt', import.meta.url);

/** The file's budget: 8 MB as stored (docs/decisions.md). */
const ASSET_BUDGET = 8 * 1024 * 1024;

/** Unicode's fully-qualified emoji and components, as strings. */
function listed(): string[] {
  return readFileSync(EMOJI_TEST, 'utf8')
    .split('\n')
    .flatMap((line) => {
      const match = /^([0-9A-F ]+?)\s*;\s*(fully-qualified|component)\b/.exec(line);
      return match === null ? [] : [String.fromCodePoint(...(match[1] ?? '').trim().split(/\s+/).map((hex) => parseInt(hex, 16)))];
    });
}

const bytes = (): Uint8Array => new Uint8Array(readFileSync(new URL('NotoColorEmoji.bin', VENDOR)));

describe('the colour emoji file', () => {
  it('is the file SHA256SUMS pins and the coverage table records', () => {
    const sums = readFileSync(new URL('SHA256SUMS', VENDOR), 'utf8');
    const digest = createHash('sha256').update(bytes()).digest('hex');
    expect(sums).toContain(`${digest}  NotoColorEmoji.bin`);
    expect(NOTO_COLOUR_EMOJI_SHA256).toBe(digest);
    expect(NOTO_COLOUR_EMOJI_BYTES).toBe(bytes().byteLength);
  });

  it('is within the 8 MB budget as stored', () => {
    expect(bytes().byteLength).toBeLessThanOrEqual(ASSET_BUDGET);
  });

  it('is read by the Node loader as it is', async () => {
    expect(Buffer.from(await loadColourEmojiInNode()).equals(Buffer.from(bytes()))).toBe(true);
  });

  it('is refused when its length or its bytes are not the pinned ones', async () => {
    const good = bytes();
    await expect(ColourEmoji.open(good.subarray(0, good.byteLength - 1))).rejects.toThrow(/bytes, not the/);
    const flipped = good.slice();
    flipped[flipped.byteLength - 1] = (flipped[flipped.byteLength - 1] ?? 0) ^ 1;
    await expect(ColourEmoji.open(flipped)).rejects.toThrow(/SHA-256/);
  });
});

describe('the colour coverage table', () => {
  it('holds exactly the keys of the file, in base 36', async () => {
    const asset = await openColourEmoji(loadColourEmojiInNode);
    const table = NOTO_COLOUR_EMOJI_KEYS.split(' ').map((seq) => String.fromCodePoint(...seq.split('.').map((part) => parseInt(part, 36))));
    expect(table.length).toBeGreaterThan(3900);
    for (const cluster of table) expect(asset.has(cluster), cluster).toBe(true);
    expect(new Set(table.map(colourEmojiKey)).size).toBe(table.length);
  });

  it('keys an emoji by its code points without variation selectors', () => {
    expect(colourEmojiKey('👍🏽')).toBe('1f44d-1f3fd');
    expect(colourEmojiKey('❤️')).toBe('2764');
    expect(colourEmojiKey('🏳️‍🌈')).toBe('1f3f3-200d-1f308');
    expect(colourEmojiKey('1️⃣')).toBe('31-20e3');
  });

  it('covers every fully-qualified emoji of Unicode 17.0, and says nothing of what is not an emoji', () => {
    const missing = listed().filter((emoji) => !colourEmojiCovers(emoji));
    expect(missing).toEqual([]);
    expect(colourEmojiCovers('A')).toBe(false);
    expect(colourEmojiCovers('🐶🏽')).toBe(false);
  });
});

describe('the glyphs of the file', () => {
  it('draw only paths, colours, shadings, graphics states and clips', async () => {
    const asset = await openColourEmoji(loadColourEmojiInNode);
    const OPERATORS = new Set(['m', 'l', 'c', 'h', 're', 'f', 'W', 'n', 'q', 'Q', 'cm', 'g', 'rg', 'sh', 'gs', 'Do']);
    const NAMES = new Set([
      'ShadingType', 'ColorSpace', 'DeviceRGB', 'DeviceGray', 'Coords', 'Domain', 'Function', 'Extend', 'FunctionType', 'C0', 'C1', 'N',
      'Functions', 'Bounds', 'Encode', 'BM', 'SoftLight', 'ca',
    ]);
    const seen = new Set<string>();
    let glyphs = 0;
    for (const cluster of listed()) {
      const glyph = asset.glyph(cluster);
      expect(glyph, cluster).toBeDefined();
      if (glyph === undefined) continue;
      glyphs += 1;
      // The glyph's operators.
      for (const token of glyph.content.split(/\s+/)) {
        if (token === '' || /^-?\d+(\.\d+)?$/.test(token)) continue;
        if (token.startsWith('/')) {
          expect(glyph.ids, `${cluster} names ${token}`).toContain(token.slice(1));
          continue;
        }
        if (!OPERATORS.has(token)) throw new Error(`${cluster}: operator ${token} is not on the whitelist`);
      }
      expect(glyph.content).not.toMatch(/[()]/);
      // What the glyph names.
      for (const id of glyph.ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const text = asset.pool(id);
        if (id.startsWith('p')) {
          for (const token of text.split(/\s+/)) if (token !== '' && !/^-?\d+(\.\d+)?$/.test(token) && !OPERATORS.has(token)) throw new Error(`${id}: ${token}`);
          continue;
        }
        for (const token of text.replace(/[|[\]<>]/g, ' ').split(/\s+/)) {
          if (token === '' || /^-?\d+(\.\d+)?$/.test(token) || token === 'true' || token === 'false') continue;
          if (!token.startsWith('/') || !NAMES.has(token.slice(1))) throw new Error(`${id}: ${token} is not on the whitelist`);
        }
      }
    }
    expect(glyphs).toBeGreaterThan(3900);
    expect(seen.size).toBeGreaterThan(1000);
  }, 60_000);

  it('give each emoji an advance and a box in the 1000-unit em', async () => {
    const asset = await openColourEmoji(loadColourEmojiInNode);
    const glyph = asset.glyph('👍🏽');
    expect(glyph?.advance).toBe(1245);
    const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = glyph?.bbox ?? [];
    expect(x1).toBeGreaterThan(x0);
    expect(y1).toBeGreaterThan(y0);
    expect(x1 - x0).toBeLessThanOrEqual(1300);
  });
});

describe('type3Objects', () => {
  const glyph = (text: string, ids: string[] = []): Type3Glyph => ({ text, width: 1440, content: '0 0 m 100 0 l 100 100 l h f', ids, bbox: [0, 0, 100, 100] });
  const pool = (id: string): string => (id.startsWith('p') ? '0 0 m 10 0 l 10 10 l h f' : '<< /ShadingType 2 >>');

  it('writes one font for up to 255 emoji and a font more for each 255 after', () => {
    expect(type3Place(0)).toEqual({ font: 0, code: 1 });
    expect(type3Place(TYPE3_CODES - 1)).toEqual({ font: 0, code: TYPE3_CODES });
    expect(type3Place(TYPE3_CODES)).toEqual({ font: 1, code: 1 });
    const glyphs = Array.from({ length: 300 }, (_, i) => glyph(String.fromCodePoint(0x1f600 + i)));
    const { fonts, objects } = type3Objects(glyphs, pool);
    expect(fonts).toHaveLength(2);
    expect(fonts.map((font) => font.count)).toEqual([255, 45]);
    // Fonts, then a procedure for each emoji, then a ToUnicode map for each font.
    expect(objects).toHaveLength(2 + 300 + 2);
    const first = objects[0]?.dict;
    expect(first?.['Subtype']).toEqual({ name: 'Type3' });
    expect(first?.['FontMatrix']).toEqual({ raw: '[0.001 0 0 0.001 0 0]' });
    expect(first?.['FirstChar']).toBe(1);
    expect(first?.['LastChar']).toBe(255);
  });

  it('starts each procedure with its width and d0, a coloured glyph, and gives each emoji its whole sequence in ToUnicode', () => {
    const { objects } = type3Objects([glyph('👍🏽'), glyph('🏳️‍🌈')], pool);
    expect(objects[1]?.stream).toMatch(/^1440 0 d0\n/);
    const map = String(objects[3]?.stream);
    expect(map).toContain('<01> <D83DDC4DD83CDFFD>');
    expect(map).toContain('<02> <D83CDFF3FE0F200DD83CDF08>');
    expect(map).toContain('<00> <FF>');
  });

  it('writes each shape, shading and graphics state of the pool once, however many glyphs name it', () => {
    const glyphs = Array.from({ length: 300 }, (_, i) => glyph(String.fromCodePoint(0x1f600 + i), ['p1', 'g2', 's3']));
    const { objects } = type3Objects(glyphs, (id) => (id.startsWith('g') ? '<< /ca 0.5 >>' : pool(id)));
    // The fonts, the procedures, the maps, then one form and one shading: a graphics state is a direct value.
    expect(objects).toHaveLength(2 + 300 + 2 + 2);
    expect(objects.filter((object) => object.raw !== undefined)).toHaveLength(1);
  });

  it('puts the text of an emoji nowhere but in ToUnicode, hex-encoded, so no text reaches a glyph procedure', () => {
    const hostile = ') Tj (evil) Tj /Pwn gs <</S/JavaScript /JS(app.alert(1))>>';
    const { objects } = type3Objects([glyph(hostile)], pool);
    const written = JSON.stringify(objects.map((object) => ({ dict: object.dict, stream: object.stream })));
    expect(written).not.toContain('evil');
    expect(written).not.toContain('JavaScript');
    expect(String(objects[1]?.stream)).toBe('1440 0 d0\n0 0 m 100 0 l 100 100 l h f');
    expect(String(objects[2]?.stream)).toMatch(/^[\x20-\x7e\n]*$/);
    expect(String(objects[2]?.stream)).not.toContain('evil');
  });

  it('refuses a pool entry of a kind it does not know', () => {
    expect(() => type3Objects([glyph('😀', ['x1'])], pool)).toThrow(/unknown kind/);
  });

  it('leaves the CID writer as it was: the Type 0 font still has its two-byte codespace', () => {
    const map = String(cidFontObjects({ baseFont: 'AAAAAA+T', program: new Uint8Array([1]), entries: [{ gid: 1, width: 500, text: 'a' }], bbox: [0, 0, 1, 1], ascent: 1, descent: 0, capHeight: 1 })[4]?.stream);
    expect(map).toContain('<0000> <FFFF>');
  });
});
