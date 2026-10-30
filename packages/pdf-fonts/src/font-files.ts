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
