/** The fallback fonts both PDFs set text in: where they live, and what the compile log calls them. */

/** The CJK font's file name in `@caotang/font-noto-cjk` (vendor/noto-sans-cjk). */
export const CJK_FONT_FILE = 'NotoSansMonoCJKsc-Regular.woff';

/**
 * The common CJK file's name, beside the full one: the same font cut to the characters of everyday use (vendor/noto-sans-cjk,
 * common-charset.txt). A document whose characters are all in it reads this file, any other reads the full one.
 */
export const CJK_COMMON_FONT_FILE = 'NotoSansMonoCJKsc-Regular-common.woff';

/** The CJK font's name, as the compile log names it. */
export const CJK_FONT_NAME = 'Noto Sans Mono CJK SC';

/**
 * The Bold weight of the CJK font, beside the Regular in `@caotang/font-noto-cjk`: built the same way and mapping the same
 * characters, so the Regular's coverage tables choose its file too. A PDF reads it only for CJK text in a bold place.
 */
export const CJK_BOLD_FONT_FILE = 'NotoSansMonoCJKsc-Bold.woff';

/** The Bold's common file, cut to the same characters as the Regular's ({@link CJK_COMMON_FONT_FILE}). */
export const CJK_BOLD_COMMON_FONT_FILE = 'NotoSansMonoCJKsc-Bold-common.woff';

/** The Bold CJK font's name, as the compile log names it. */
export const CJK_BOLD_FONT_NAME = 'Noto Sans Mono CJK SC Bold';

/** The emoji font's file name in `@caotang/font-noto-emoji` (vendor/noto-emoji). */
export const EMOJI_FONT_FILE = 'NotoEmoji-Regular.woff';

/** The common emoji file's name, beside the full one: the single-code-point emoji and the keycaps (vendor/noto-emoji, common-emoji.txt). */
export const EMOJI_COMMON_FONT_FILE = 'NotoEmoji-Regular-common.woff';

/** The emoji font's name, as the compile log names it. */
export const EMOJI_FONT_NAME = 'Noto Emoji';

/** The colour emoji file's name in `@caotang/font-noto-color-emoji` (vendor/noto-color-emoji): the vector pictures both PDFs draw as Type 3 glyphs. */
export const COLOUR_EMOJI_FILE = 'NotoColorEmoji.bin';

/** The colour emoji's name, as the compile log names it. */
export const COLOUR_EMOJI_NAME = 'Noto Color Emoji';

/** The Arabic font's file name in `@caotang/font-noto-arabic` (vendor/noto-sans-arabic). */
export const ARABIC_FONT_FILE = 'NotoSansArabic-Regular.ttf';

/** The Arabic font's name, as the compile log names it. */
export const ARABIC_FONT_NAME = 'Noto Sans Arabic';

/** The Hebrew font's file name in `@caotang/font-noto-hebrew` (vendor/noto-sans-hebrew). */
export const HEBREW_FONT_FILE = 'NotoSansHebrew-Regular.ttf';

/** The Hebrew font's name, as the compile log names it. */
export const HEBREW_FONT_NAME = 'Noto Sans Hebrew';

/** The Devanagari font's file name in `@caotang/font-noto-devanagari` (vendor/noto-sans-devanagari). */
export const DEVANAGARI_FONT_FILE = 'NotoSansDevanagari-Regular.ttf';

/** The Devanagari font's name, as the compile log names it. */
export const DEVANAGARI_FONT_NAME = 'Noto Sans Devanagari';

/** The Bengali font's file name in `@caotang/font-noto-bengali` (vendor/noto-sans-bengali). */
export const BENGALI_FONT_FILE = 'NotoSansBengali-Regular.ttf';

/** The Bengali font's name, as the compile log names it. */
export const BENGALI_FONT_NAME = 'Noto Sans Bengali';

/** The Gurmukhi font's file name in `@caotang/font-noto-gurmukhi` (vendor/noto-sans-gurmukhi). */
export const GURMUKHI_FONT_FILE = 'NotoSansGurmukhi-Regular.ttf';

/** The Gurmukhi font's name, as the compile log names it. */
export const GURMUKHI_FONT_NAME = 'Noto Sans Gurmukhi';

/** The Gujarati font's file name in `@caotang/font-noto-gujarati` (vendor/noto-sans-gujarati). */
export const GUJARATI_FONT_FILE = 'NotoSansGujarati-Regular.ttf';

/** The Gujarati font's name, as the compile log names it. */
export const GUJARATI_FONT_NAME = 'Noto Sans Gujarati';

/** The Odia font's file name in `@caotang/font-noto-oriya` (vendor/noto-sans-oriya). */
export const ORIYA_FONT_FILE = 'NotoSansOriya-Regular.ttf';

/** The Odia font's name, as the compile log names it. */
export const ORIYA_FONT_NAME = 'Noto Sans Oriya';

/** The Tamil font's file name in `@caotang/font-noto-tamil` (vendor/noto-sans-tamil). */
export const TAMIL_FONT_FILE = 'NotoSansTamil-Regular.ttf';

/** The Tamil font's name, as the compile log names it. */
export const TAMIL_FONT_NAME = 'Noto Sans Tamil';

/** The Telugu font's file name in `@caotang/font-noto-telugu` (vendor/noto-sans-telugu). */
export const TELUGU_FONT_FILE = 'NotoSansTelugu-Regular.ttf';

/** The Telugu font's name, as the compile log names it. */
export const TELUGU_FONT_NAME = 'Noto Sans Telugu';

/** The Kannada font's file name in `@caotang/font-noto-kannada` (vendor/noto-sans-kannada). */
export const KANNADA_FONT_FILE = 'NotoSansKannada-Regular.ttf';

/** The Kannada font's name, as the compile log names it. */
export const KANNADA_FONT_NAME = 'Noto Sans Kannada';

/** The Malayalam font's file name in `@caotang/font-noto-malayalam` (vendor/noto-sans-malayalam). */
export const MALAYALAM_FONT_FILE = 'NotoSansMalayalam-Regular.ttf';

/** The Malayalam font's name, as the compile log names it. */
export const MALAYALAM_FONT_NAME = 'Noto Sans Malayalam';

/** The Sinhala font's file name in `@caotang/font-noto-sinhala` (vendor/noto-sans-sinhala). */
export const SINHALA_FONT_FILE = 'NotoSansSinhala-Regular.ttf';

/** The Sinhala font's name, as the compile log names it. */
export const SINHALA_FONT_NAME = 'Noto Sans Sinhala';

/**
 * The comic lettering faces in `@caotang/font-comic-lettering` (vendor/comic-lettering): Comic Neue for balloon and caption text with
 * its oblique and bold for thoughts, radio and emphasis, and Bangers for sound effects. The lettering model and the PDF name a face by
 * the key; the loaders map it to the file.
 */
export const COMIC_LETTERING_FACES = ['regular', 'italic', 'bold', 'bold-italic', 'sfx'] as const;

export type ComicLetteringFace = (typeof COMIC_LETTERING_FACES)[number];

export const COMIC_LETTERING_FONT_FILES: Readonly<Record<ComicLetteringFace, string>> = {
  regular: 'ComicNeue-Regular.woff',
  italic: 'ComicNeue-Italic.woff',
  bold: 'ComicNeue-Bold.woff',
  'bold-italic': 'ComicNeue-BoldItalic.woff',
  sfx: 'Bangers-Regular.woff',
};

/** The faces' family names, as the compile log names them. */
export const COMIC_NEUE_FONT_NAME = 'Comic Neue';
export const BANGERS_FONT_NAME = 'Bangers';
