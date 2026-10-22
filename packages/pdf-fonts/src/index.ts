/**
 * What the contact-sheet PDF (`@caotang/exporter`) and the screenplay PDF (`@caotang/screenplay`) share for their fallback
 * fonts. The byte checks and the WOFF unpacker are here; the fontkit helpers load fontkit lazily (./fontkit.ts); the Node
 * loaders are the subpath `@caotang/pdf-fonts/node-loader`.
 */

export { MAX_SFNT_BYTES, checkFontBytes, looksLikeFont, sfntFromWoff, type FontLoader } from './font-bytes.js';
export { CJK_FONT_FILE, CJK_FONT_NAME, EMOJI_FONT_FILE, EMOJI_FONT_NAME } from './font-files.js';
export { encodeSubset, loadFontkit, openFont, padGlyphs, subsetTag, type FontkitSubset } from './fontkit.js';
