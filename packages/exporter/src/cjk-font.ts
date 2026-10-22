/**
 * The fallback font for text the PDF's built-in Helvetica cannot encode ([storyboard.md](../../../docs/architecture/storyboard.md) §6).
 *
 * The font is Noto Sans CJK SC Regular (OFL-1.1), as a TrueType WOFF file in `@caotang/font-noto-cjk` (vendor/noto-sans-cjk,
 * where its source, checksum and build are written down). It covers Chinese (simplified and traditional), Japanese kana and
 * kanji, Korean Hangul, Greek and Cyrillic.
 *
 * The exporter names no place to read it from. The host passes a {@link FontLoader}: the app fetches the file from its own
 * origin (Vite emits it as a separate asset), and Node reads it from the package (`./fallback-fonts-node.ts`). The emitter calls the
 * loader only when a file holds a character Helvetica cannot encode, so a Latin-only export never reads the font.
 */

export { MAX_SFNT_BYTES, checkFontBytes, looksLikeFont, sfntFromWoff, type FontLoader } from '@caotang/pdf-fonts';

/** The fallback font's file name in `@caotang/font-noto-cjk`. */
export const CJK_FONT_FILE = 'NotoSansCJKsc-Regular.woff';

/** The fallback font's name, as the compile log names it. */
export const CJK_FONT_NAME = 'Noto Sans CJK SC';
