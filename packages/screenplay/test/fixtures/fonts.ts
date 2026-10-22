/** The fallback fonts the PDF tests load: the host's Node loaders, and the parsed source fonts to compare a subset with. */

import { loadFont } from '@caotang/pdf-fonts';
import { loadArabicFontInNode, loadCjkFontInNode, loadEmojiFontInNode, loadHebrewFontInNode } from '@caotang/pdf-fonts/node-loader';
import type { Font } from '@pdf-lib/fontkit';

export const LOADERS = { cjk: loadCjkFontInNode, emoji: loadEmojiFontInNode, arabic: loadArabicFontInNode, hebrew: loadHebrewFontInNode } as const;

let cjk: Promise<Font> | undefined;
let emoji: Promise<Font> | undefined;

/** Noto Sans Mono CJK SC as fontkit reads it. */
export const sourceCjk = (): Promise<Font> => (cjk ??= loadFont(loadCjkFontInNode, 'CJK font'));

/** Noto Emoji as fontkit reads it. */
export const sourceEmoji = (): Promise<Font> => (emoji ??= loadFont(loadEmojiFontInNode, 'emoji font'));
