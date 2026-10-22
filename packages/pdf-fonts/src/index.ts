/**
 * What the contact-sheet PDF (`@caotang/exporter`) and the screenplay PDF (`@caotang/screenplay`) share for their fallback
 * fonts. The byte checks and the WOFF unpacker are here; the fontkit helpers load fontkit lazily (./fontkit.ts); the Node
 * loaders are the subpath `@caotang/pdf-fonts/node-loader`. Arabic and Hebrew: which characters the two fonts print and how a
 * line is cut into runs are here (./rtl-script.ts); the bidirectional algorithm and the shaper hold `bidi-js` and the shaping
 * engine, so they are the subpaths `@caotang/pdf-fonts/bidi` and `@caotang/pdf-fonts/shaper`. Devanagari: which characters the font prints
 * and how Indic text is cut into units are here (./brahmic.ts); the Indic shaper holds upstream `fontkit`, so it is the subpath
 * `@caotang/pdf-fonts/indic-shaper`.
 */

export { MAX_SFNT_BYTES, checkFontBytes, looksLikeFont, sfntFromWoff, type FontLoader } from './font-bytes.js';
export {
  ARABIC_FONT_FILE,
  ARABIC_FONT_NAME,
  CJK_FONT_FILE,
  CJK_FONT_NAME,
  DEVANAGARI_FONT_FILE,
  DEVANAGARI_FONT_NAME,
  EMOJI_FONT_FILE,
  EMOJI_FONT_NAME,
  HEBREW_FONT_FILE,
  HEBREW_FONT_NAME,
} from './font-files.js';
export { encodeSubset, loadFont, loadFontWithBytes, loadFontkit, openFont, padGlyphs, subsetTag, type FontkitSubset } from './fontkit.js';
export {
  cidFontObjects,
  cutCidSubset,
  describeSubset,
  NO_TEXT,
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
  emojiLayoutGlyph,
  emojiPrint,
  emojiStyleOf,
  firstCodePoint,
  graphemesOf,
  isEmojiCluster,
  isEmojiPicture,
  type EmojiStyle,
} from './emoji.js';
export {
  arabicFontMaps,
  devanagariFontMaps,
  emojiFontHasSequence,
  emojiFontHasTonedSequence,
  emojiFontLayoutGlyph,
  emojiFontMaps,
  fallbackCovers,
  hebrewFontMaps,
  inRanges,
} from './coverage.js';
export {
  countMarks,
  hasBidiControl,
  hasRtlScript,
  isBidiControl,
  isRtlMark,
  needsBidi,
  rtlFontMaps,
  rtlFontPrints,
  rtlRunKind,
  rtlScriptOf,
  scriptRuns,
  withoutMarks,
  type RtlScript,
  type ScriptRun,
} from './rtl-script.js';
export {
  clustersOf,
  devanagariFontPrints,
  devanagariRuns,
  hasBrahmic,
  hasDevanagari,
  isBrahmic,
  isDevanagariUnit,
  joinConjuncts,
  startsWithBrahmicMark,
  type DevanagariRun,
  type ShapedScript,
} from './brahmic.js';
