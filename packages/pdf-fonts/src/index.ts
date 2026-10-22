/**
 * What the contact-sheet PDF (`@caotang/exporter`) and the screenplay PDF (`@caotang/screenplay`) share for their fallback
 * fonts. The byte checks and the WOFF unpacker are here; the fontkit helpers load fontkit lazily (./fontkit.ts).
 */

export { MAX_SFNT_BYTES, checkFontBytes, looksLikeFont, sfntFromWoff, type FontLoader } from './font-bytes.js';
export { encodeSubset, loadFontkit, openFont, padGlyphs, subsetTag, type FontkitSubset } from './fontkit.js';
