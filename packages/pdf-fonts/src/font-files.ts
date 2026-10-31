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

/** The emoji font's file name in `@caotang/font-noto-emoji` (vendor/noto-emoji). */
export const EMOJI_FONT_FILE = 'NotoEmoji-Regular.woff';

/** The common emoji file's name, beside the full one: the single-code-point emoji and the keycaps (vendor/noto-emoji, common-emoji.txt). */
export const EMOJI_COMMON_FONT_FILE = 'NotoEmoji-Regular-common.woff';

/** The emoji font's name, as the compile log names it. */
export const EMOJI_FONT_NAME = 'Noto Emoji';

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
