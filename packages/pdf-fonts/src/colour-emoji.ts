/**
 * The colour emoji asset ([screenplay.md §5.3](../../../docs/architecture/screenplay.md), vendor/noto-color-emoji): what both PDFs
 * read to draw an emoji in colour, as a Type 3 glyph (type3.ts), and which emoji it has.
 *
 * The asset is one file, `NotoColorEmoji.bin`, built offline from Noto's COLRv1 font (vendor/noto-color-emoji/build.py, where the
 * source, the budgets and the layout are written down). Nothing here interprets a font: each emoji is a string of PDF operators
 * compiled from the font's paint graph, and the shapes, shadings and soft masks they name, in blocks deflated one by one, so a
 * document with a few emoji inflates only the blocks they are in. The index holds the keys: an emoji's code points without
 * variation selectors, as lower-case hexadecimal joined by dashes (`1f44d-1f3fd` for 👍🏽).
 *
 * The file is pinned: {@link openColourEmoji} refuses bytes whose length or SHA-256 is not the one the coverage table records
 * (coverage/noto-colour-emoji-coverage.ts, generated from the file), and refuses any block that holds a character outside the
 * few PDF syntax uses (no parenthesis, so no string; no angle bracket pair that is not a dictionary). The text of a document is never
 * spliced into a glyph: a document's emoji only select entries by key.
 *
 * This module holds the key table, so it is the subpath `@caotang/pdf-fonts/colour` and the hosts import it dynamically.
 */

import type { FontLoader } from './font-bytes.js';
import { NOTO_COLOUR_EMOJI_BYTES, NOTO_COLOUR_EMOJI_KEYS, NOTO_COLOUR_EMOJI_SHA256 } from './coverage/noto-colour-emoji-coverage.js';
import type { Type3Glyph } from './type3.js';

const MAGIC = 0x43454d4a; // 'CEMJ'
const VERSION = 1;
const HEADER = 16;
/** The most an index may inflate to, and a block. The shipped file's are about 1 MB and 48 kB. */
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_BLOCK_BYTES = 1024 * 1024;
/** What a glyph's or a pool entry's text may hold: names, numbers, white space, brackets and the dot, the dash and the slash of those. */
const SAFE = /^[0-9A-Za-z\s.\-/[\]<>|]*$/;

const VS = /[︎️]/g;

/** The key of an emoji cluster: its code points without variation selectors, in lower-case hexadecimal joined by dashes. */
export function colourEmojiKey(cluster: string): string {
  const codes: string[] = [];
  for (const ch of cluster.replace(VS, '')) codes.push((ch.codePointAt(0) ?? 0).toString(16));
  return codes.join('-');
}

let covered: ReadonlySet<string> | undefined;

/** The keys the asset has, from the generated table. */
function keySet(): ReadonlySet<string> {
  covered ??= new Set(NOTO_COLOUR_EMOJI_KEYS.split(' ').map((seq) => seq.split('.').map((part) => parseInt(part, 36).toString(16)).join('-')));
  return covered;
}

/** Whether the colour asset has a picture for an emoji cluster (known before the asset loads). */
export function colourEmojiCovers(cluster: string): boolean {
  return keySet().has(colourEmojiKey(cluster));
}

/** The asset's index, as the build writes it. */
interface Index {
  readonly version: number;
  readonly keys: string;
  readonly glyphOf: readonly number[];
  readonly glyphs: readonly number[];
  readonly pool: readonly number[];
  readonly kinds: string;
  readonly blocks: readonly number[];
}

/** One emoji of the asset: the operators that draw it, the pool entries they name, its advance and box in the 1000-unit em. */
export interface ColourGlyph {
  readonly advance: number;
  readonly bbox: readonly [number, number, number, number];
  readonly content: string;
  readonly ids: readonly string[];
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw new Error('this environment has no Web Crypto, so the colour emoji file cannot be checked');
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function inflate(unzlib: (data: Uint8Array, options: { out: Uint8Array }) => Uint8Array, packed: Uint8Array, size: number, limit: number): string {
  if (!Number.isInteger(size) || size < 0 || size > limit) throw new Error('the colour emoji file holds a block of an unreasonable size');
  const out = unzlib(packed, { out: new Uint8Array(size + 1) });
  if (out.byteLength !== size) throw new Error('a block of the colour emoji file did not inflate to its stated length');
  return new TextDecoder('utf-8').decode(out);
}

/** The colour emoji asset, opened: its keys, and the blocks inflated so far. */
export class ColourEmoji {
  private readonly keyIndex = new Map<string, number>();
  private readonly texts = new Map<number, string>();

  private constructor(
    private readonly bytes: Uint8Array,
    private readonly base: number,
    private readonly index: Index,
    private readonly unzlib: (data: Uint8Array, options: { out: Uint8Array }) => Uint8Array,
  ) {
    index.keys.split('\n').forEach((key, i) => this.keyIndex.set(key, index.glyphOf[i] ?? -1));
  }

  /** Checks the bytes against the pin and reads the index. Throws, saying what is wrong, when they are not the shipped file. */
  static async open(bytes: Uint8Array): Promise<ColourEmoji> {
    if (bytes.byteLength !== NOTO_COLOUR_EMOJI_BYTES) {
      throw new Error(`the colour emoji file is ${bytes.byteLength} bytes, not the ${NOTO_COLOUR_EMOJI_BYTES} it should be`);
    }
    if ((await sha256Hex(bytes)) !== NOTO_COLOUR_EMOJI_SHA256) throw new Error('the colour emoji file is not the one this build was made for (its SHA-256 differs)');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0) !== MAGIC || view.getUint32(4) !== VERSION) throw new Error('the colour emoji file is not in the format this build reads');
    const packedIndex = view.getUint32(8);
    const rawIndex = view.getUint32(12);
    const { unzlibSync } = await import('fflate/browser');
    const unzlib = unzlibSync as (data: Uint8Array, options: { out: Uint8Array }) => Uint8Array;
    const index = JSON.parse(inflate(unzlib, bytes.subarray(HEADER, HEADER + packedIndex), rawIndex, MAX_INDEX_BYTES)) as Index;
    return new ColourEmoji(bytes, HEADER + packedIndex, index, unzlib);
  }

  /** Whether the asset has a picture for a cluster. */
  has(cluster: string): boolean {
    return (this.keyIndex.get(colourEmojiKey(cluster)) ?? -1) >= 0;
  }

  private block(number: number): string {
    let text = this.texts.get(number);
    if (text === undefined) {
      const [offset = 0, packed = 0, size = 0] = this.index.blocks.slice(3 * number, 3 * number + 3);
      if (offset + packed > this.bytes.byteLength - this.base) throw new Error('a block of the colour emoji file runs past its end');
      text = inflate(this.unzlib, this.bytes.subarray(this.base + offset, this.base + offset + packed), size, MAX_BLOCK_BYTES);
      if (!SAFE.test(text)) throw new Error('the colour emoji file holds a character a glyph may not');
      this.texts.set(number, text);
    }
    return text;
  }

  private chunk(table: readonly number[], at: number): string {
    const [block = 0, offset = 0, length = 0] = table.slice(at, at + 3);
    return this.block(block).slice(offset, offset + length);
  }

  /** The picture of a cluster, or undefined when the asset has none. */
  glyph(cluster: string): ColourGlyph | undefined {
    const glyph = this.keyIndex.get(colourEmojiKey(cluster)) ?? -1;
    if (glyph < 0) return undefined;
    const row = this.index.glyphs.slice(8 * glyph, 8 * glyph + 8);
    const text = this.chunk(row, 0);
    const split = text.indexOf('\n');
    const ids = text.slice(0, split).split(' ').filter((id) => id !== '');
    return {
      advance: row[3] ?? 0,
      bbox: [row[4] ?? 0, row[5] ?? 0, row[6] ?? 0, row[7] ?? 0],
      content: text.slice(split + 1).trimEnd(),
      ids,
    };
  }

  /** The text of a pool entry by id (`s12`): what the glyphs that name it share. */
  pool(id: string): string {
    const number = Number(id.slice(1));
    if (!Number.isInteger(number) || this.index.kinds.charAt(number) !== id.charAt(0)) throw new Error(`the colour emoji file has no pool entry ${id}`);
    return this.chunk(this.index.pool, 3 * number).trimEnd();
  }

  /** A Type 3 glyph for an emoji cluster, at a stated advance, or undefined when the asset has none. */
  type3Glyph(cluster: string, width: number): Type3Glyph | undefined {
    const glyph = this.glyph(cluster);
    return glyph === undefined ? undefined : { text: cluster, width, content: glyph.content, ids: glyph.ids, bbox: glyph.bbox };
  }
}

/** Reads the asset from a loader and opens it. */
export async function openColourEmoji(load: FontLoader): Promise<ColourEmoji> {
  return ColourEmoji.open(await load());
}

/** zlib compression for the glyph streams of a host that writes them itself (the screenplay PDF); pdf-lib compresses its own. */
export async function deflater(): Promise<(data: Uint8Array) => Uint8Array> {
  const { zlibSync } = await import('fflate/browser');
  return (data) => zlibSync(data, { level: 9 });
}
