/**
 * HarfBuzz as the reference for the emoji font: what the font draws for a sequence when its GSUB is applied in full, which
 * fontkit 1.1.1 does not do for every sequence. Tests only: harfbuzzjs is a devDependency of this package and nothing that
 * writes a PDF loads it (the table in src/coverage/noto-emoji-coverage.ts is generated with it, scripts/emoji-coverage.mjs).
 * The screenplay and exporter tests read it from here.
 */

import * as hb from 'harfbuzzjs';

import { sfntFromWoff } from '../src/font-bytes.js';
import { loadEmojiFontInNode } from '../src/node-loader.js';

/** The glyph ids HarfBuzz draws for a text, in order: those it gives room, not the variation selectors and joiners it hides. */
export type EmojiShaper = (text: string) => number[];

let shaper: Promise<EmojiShaper> | undefined;

/** HarfBuzz on the vendored emoji font, once. */
export function harfbuzzEmoji(): Promise<EmojiShaper> {
  shaper ??= (async () => {
    const sfnt = await sfntFromWoff(await loadEmojiFontInNode());
    const font = new hb.Font(new hb.Face(new hb.Blob(sfnt.buffer.slice(sfnt.byteOffset, sfnt.byteOffset + sfnt.byteLength) as ArrayBuffer)));
    const buffer = new hb.Buffer();
    return (text) => {
      buffer.reset();
      buffer.addText(text);
      buffer.guessSegmentProperties();
      hb.shape(font, buffer);
      const positions = buffer.getGlyphPositions();
      return buffer
        .getGlyphInfos()
        .filter((_, index) => (positions[index]?.xAdvance ?? 0) > 0)
        .map((info) => info.codepoint);
    };
  })();
  return shaper;
}
