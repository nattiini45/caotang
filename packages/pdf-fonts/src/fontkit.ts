/**
 * What both PDFs do with @pdf-lib/fontkit: open a font, cut a subset into a font program, name it, and pad its glyphs. The
 * module itself is loaded by a dynamic `import()` in {@link loadFontkit}, so a host that imports this file for the helpers
 * (the exporter does) loads fontkit only when a font is opened.
 */

import type * as FontkitNamespace from '@pdf-lib/fontkit';
import type { Font } from '@pdf-lib/fontkit';

import { checkFontBytes, sfntFromWoff, type FontLoader } from './font-bytes.js';

type FontkitModule = typeof FontkitNamespace;

export type FontkitSubset = ReturnType<Font['createSubset']>;

let module: Promise<FontkitModule> | undefined;

/** fontkit, once. The ES build has only a default export; its types name `create` directly. Both shapes are read. */
export function loadFontkit(): Promise<FontkitModule> {
  module ??= import('@pdf-lib/fontkit').then((loaded) => (loaded as unknown as { default?: FontkitModule }).default ?? loaded);
  return module;
}

/** A parsed font; TrueType or OpenType bytes, not WOFF (see `sfntFromWoff`). */
export async function openFont(bytes: Uint8Array): Promise<Font> {
  return (await loadFontkit()).create(bytes as Parameters<FontkitModule['create']>[0]) as Font;
}

/**
 * The font a host's loader reads: its bytes must start as a font file does (an HTML page served in a font's place is refused
 * with what was served, named `label`), a WOFF is unpacked, and fontkit parses the result.
 */
export async function loadFont(load: FontLoader, label: string): Promise<Font> {
  return openFont(await sfntFromWoff(checkFontBytes(await load(), label)));
}

/** {@link loadFont}, and the bytes it parsed, for a second engine that shapes from the same file (indic-shaper.ts). */
export async function loadFontWithBytes(load: FontLoader, label: string): Promise<{ readonly font: Font; readonly bytes: Uint8Array }> {
  const bytes = await sfntFromWoff(checkFontBytes(await load(), label));
  return { font: await openFont(bytes), bytes };
}

/** What `encodeSubset` reaches past fontkit's types: the stream's `error` event, and the method the stream runs. */
interface EncodingSubset {
  encode(stream: unknown): void;
  encodeStream(): { on(event: 'data' | 'end' | 'error', listener: (value: never) => void): unknown };
}

/**
 * The subset's font program. fontkit 1.1.1 encodes it on the next tick, inside `encodeStream` (Subset.encodeStream), so a
 * failure there would be thrown outside any handler and the stream would never end. The encoding is therefore run
 * through a wrapper that rejects with the failure, and an `error` the stream itself emits rejects too: the compile that
 * asked for the subset fails with the error instead of hanging or crashing the process.
 */
export function encodeSubset(subset: { encodeStream(): unknown }): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const internals = subset as unknown as EncodingSubset;
    const encode = internals.encode.bind(subset);
    internals.encode = (stream) => {
      try {
        encode(stream);
      } catch (error) {
        reject(error);
      }
    };
    const parts: Uint8Array[] = [];
    const stream = internals.encodeStream();
    stream.on('error', (error: unknown) => reject(error));
    stream.on('data', (chunk: Uint8Array) => parts.push(chunk));
    stream.on('end', () => {
      const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
      let at = 0;
      for (const part of parts) {
        out.set(part, at);
        at += part.length;
      }
      resolve(out);
    });
  });
}

/** Six capital letters from the glyph list (PDF 1.7 §9.6.4): the same subset always gets the same tag. */
export function subsetTag(key: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193) >>> 0;
  let tag = '';
  for (let i = 0; i < 6; i++) {
    tag += String.fromCharCode(65 + (hash % 26));
    hash = Math.floor(hash / 26) + i * 7919;
  }
  return tag;
}

interface TtfSubsetInternals {
  _addGlyph(gid: number): number;
  glyf: Uint8Array[];
  offset: number;
}

/**
 * fontkit 1.1.1 writes a TrueType subset's `loca` in the short format, which stores each offset halved, whenever the
 * glyph data is under 128 KB (loca.preEncode), but copies each glyph's bytes as the source font has them
 * (TTFSubset._addGlyph). A font whose glyphs are not padded would shift every glyph after one of odd length by a byte.
 * Each glyph copied into the subset is padded to an even length here; a pad byte after a glyph is ignored.
 */
export function padGlyphs(subset: object): void {
  const internals = subset as unknown as TtfSubsetInternals;
  const add = internals._addGlyph.bind(subset);
  internals._addGlyph = (gid) => {
    const index = add(gid);
    const last = internals.glyf[internals.glyf.length - 1];
    if (last !== undefined && last.length % 2 === 1) {
      // The copy is a Buffer under Node; the same type is used for the padded one.
      const make = (last.constructor as { alloc?: (size: number) => Uint8Array }).alloc;
      const padded = typeof make === 'function' ? make(last.length + 1) : new Uint8Array(last.length + 1);
      padded.set(last);
      internals.glyf[internals.glyf.length - 1] = padded;
      internals.offset += 1;
    }
    return index;
  };
}
