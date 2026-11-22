/** The fallback fonts the PDF tests load: the host's Node loaders, and the parsed source fonts to compare a subset with. */

import { loadFont } from '@caotang/pdf-fonts';
import {
  loadArabicFontInNode,
  loadBengaliFontInNode,
  loadCjkFontInNode,
  loadDevanagariFontInNode,
  loadEmojiFontInNode,
  loadGujaratiFontInNode,
  loadGurmukhiFontInNode,
  loadHebrewFontInNode,
  loadKannadaFontInNode,
  loadMalayalamFontInNode,
  loadOriyaFontInNode,
  loadSinhalaFontInNode,
  loadTamilFontInNode,
  loadTeluguFontInNode,
} from '@caotang/pdf-fonts/node-loader';
import type { Font } from '@pdf-lib/fontkit';

export const LOADERS = {
  cjk: loadCjkFontInNode,
  emoji: loadEmojiFontInNode,
  arabic: loadArabicFontInNode,
  hebrew: loadHebrewFontInNode,
  indic: {
    devanagari: loadDevanagariFontInNode,
    bengali: loadBengaliFontInNode,
    gurmukhi: loadGurmukhiFontInNode,
    gujarati: loadGujaratiFontInNode,
    oriya: loadOriyaFontInNode,
    tamil: loadTamilFontInNode,
    telugu: loadTeluguFontInNode,
    kannada: loadKannadaFontInNode,
    malayalam: loadMalayalamFontInNode,
    sinhala: loadSinhalaFontInNode,
  },
} as const;

let cjk: Promise<Font> | undefined;
let emoji: Promise<Font> | undefined;

/** Noto Sans Mono CJK SC as fontkit reads it. */
export const sourceCjk = (): Promise<Font> => (cjk ??= loadFont(loadCjkFontInNode, 'CJK font'));

/** Noto Emoji as fontkit reads it. */
export const sourceEmoji = (): Promise<Font> => (emoji ??= loadFont(loadEmojiFontInNode, 'emoji font'));
