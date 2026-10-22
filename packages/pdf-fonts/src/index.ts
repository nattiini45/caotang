/**
 * What the contact-sheet PDF (`@caotang/exporter`) and the screenplay PDF (`@caotang/screenplay`) share for their fallback
 * fonts. The byte checks and the WOFF unpacker are here; the fontkit helpers load fontkit lazily (./fontkit.ts); the Node
 * loaders are the subpath `@caotang/pdf-fonts/node-loader`.
 */

export { MAX_SFNT_BYTES, checkFontBytes, looksLikeFont, sfntFromWoff, type FontLoader } from './font-bytes.js';
export { CJK_FONT_FILE, CJK_FONT_NAME, EMOJI_FONT_FILE, EMOJI_FONT_NAME } from './font-files.js';
export { encodeSubset, loadFont, loadFontkit, openFont, padGlyphs, subsetTag, type FontkitSubset } from './fontkit.js';
export {
  cidFontObjects,
  cutCidSubset,
  describeSubset,
  toUnicodeCMap,
  type CidEntry,
  type CidSubset,
  type CidUnit,
  type PdfObject,
  type SubsetSource,
  type PdfValue,
} from './cid-font.js';
export {
  emojiKey,
  emojiPrint,
  emojiStyleOf,
  firstCodePoint,
  graphemesOf,
  isEmojiCluster,
  isEmojiPicture,
  type EmojiStyle,
} from './emoji.js';
export { emojiFontHasSequence, emojiFontHasTonedSequence, emojiFontMaps, fallbackCovers, inRanges } from './coverage.js';
