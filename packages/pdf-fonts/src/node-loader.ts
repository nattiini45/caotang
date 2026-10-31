/**
 * The fallback fonts, read in Node: the MCP server, and the tests. The app has its own loaders, over `fetch`
 * (apps/desktop/src/app/fallback-fonts.ts), so this file is a subpath of its own (`@caotang/pdf-fonts/node-loader`) and the
 * package's index never imports it: the browser bundle never sees `node:fs`.
 *
 * Five fonts, each a {@link FontLoader}: Noto Sans Mono CJK SC (`@caotang/font-noto-cjk`), Noto Emoji
 * (`@caotang/font-noto-emoji`), Noto Sans Arabic (`@caotang/font-noto-arabic`), Noto Sans Hebrew (`@caotang/font-noto-hebrew`) and
 * Noto Sans Devanagari (`@caotang/font-noto-devanagari`); and the comic lettering faces of `@caotang/font-comic-lettering`
 * (Comic Neue and Bangers), one file each, behind a loader that takes the face.
 * The CJK and emoji loaders are for the full font and carry the loader of the font's common file as `common` ({@link withCommon});
 * the PDF writers read that one when a document's characters are all in it (common.ts).
 * Where each loader looks, in order:
 *
 * 1. `fonts/<file>` beside the running module. The MCPB bundle stages the files there, beside `caotang-mcp.mjs`, so the
 *    installed server needs no `node_modules`.
 * 2. The font's package, resolved from the running module: a checkout, and the built bundle run in place.
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withCommon, type CommonFontLoader, type ComicLetteringFontLoader, type FontLoader } from './font-bytes.js';
import {
  ARABIC_FONT_FILE,
  CJK_COMMON_FONT_FILE,
  CJK_FONT_FILE,
  COMIC_LETTERING_FONT_FILES,
  DEVANAGARI_FONT_FILE,
  EMOJI_COMMON_FONT_FILE,
  EMOJI_FONT_FILE,
  HEBREW_FONT_FILE,
  type ComicLetteringFace,
} from './font-files.js';

const COMIC_LETTERING_PACKAGE = '@caotang/font-comic-lettering';
const CJK_PACKAGE = '@caotang/font-noto-cjk';
const EMOJI_PACKAGE = '@caotang/font-noto-emoji';
const ARABIC_PACKAGE = '@caotang/font-noto-arabic';
const HEBREW_PACKAGE = '@caotang/font-noto-hebrew';
const DEVANAGARI_PACKAGE = '@caotang/font-noto-devanagari';

/** The places a font file is read from, in the order they are tried. */
function fontCandidates(file: string, pkg: string, moduleUrl: string): string[] {
  const candidates = [join(dirname(fileURLToPath(moduleUrl)), 'fonts', file)];
  try {
    candidates.push(createRequire(moduleUrl).resolve(`${pkg}/${file}`));
  } catch {
    // Not resolvable from here: the bundled copy, if any, is the only place.
  }
  return candidates;
}

/** Reads a font from the first place that holds it, and says every place it looked when none does. */
async function readFirst(file: string, candidates: readonly string[]): Promise<Uint8Array> {
  for (const path of candidates) {
    try {
      return new Uint8Array(await readFile(path));
    } catch {
      // Try the next place.
    }
  }
  throw new Error(`${file} is not at ${candidates.join(' or ')}`);
}

/** The places {@link loadCjkFontInNode} reads, in the order it tries them. */
export function cjkFontCandidates(moduleUrl: string = import.meta.url): string[] {
  return fontCandidates(CJK_FONT_FILE, CJK_PACKAGE, moduleUrl);
}

/** The places the common CJK file is read from, in the order they are tried. */
export function cjkCommonFontCandidates(moduleUrl: string = import.meta.url): string[] {
  return fontCandidates(CJK_COMMON_FONT_FILE, CJK_PACKAGE, moduleUrl);
}

/** The places {@link loadEmojiFontInNode} reads, in the order it tries them. */
export function emojiFontCandidates(moduleUrl: string = import.meta.url): string[] {
  return fontCandidates(EMOJI_FONT_FILE, EMOJI_PACKAGE, moduleUrl);
}

/** The places the common emoji file is read from, in the order they are tried. */
export function emojiCommonFontCandidates(moduleUrl: string = import.meta.url): string[] {
  return fontCandidates(EMOJI_COMMON_FONT_FILE, EMOJI_PACKAGE, moduleUrl);
}

/** Reads Noto Sans Mono CJK SC, the fallback for text outside Latin script; its `common` reads the common file. */
export const loadCjkFontInNode: CommonFontLoader = withCommon(
  async () => readFirst(CJK_FONT_FILE, cjkFontCandidates()),
  async () => readFirst(CJK_COMMON_FONT_FILE, cjkCommonFontCandidates()),
);

/** Reads Noto Emoji, the fallback for emoji; its `common` reads the common file. */
export const loadEmojiFontInNode: CommonFontLoader = withCommon(
  async () => readFirst(EMOJI_FONT_FILE, emojiFontCandidates()),
  async () => readFirst(EMOJI_COMMON_FONT_FILE, emojiCommonFontCandidates()),
);

/** The places {@link loadArabicFontInNode} reads, in the order it tries them. */
export function arabicFontCandidates(moduleUrl: string = import.meta.url): string[] {
  return fontCandidates(ARABIC_FONT_FILE, ARABIC_PACKAGE, moduleUrl);
}

/** The places {@link loadHebrewFontInNode} reads, in the order it tries them. */
export function hebrewFontCandidates(moduleUrl: string = import.meta.url): string[] {
  return fontCandidates(HEBREW_FONT_FILE, HEBREW_PACKAGE, moduleUrl);
}

/** Reads Noto Sans Arabic, the font for Arabic, Persian and Urdu text. */
export const loadArabicFontInNode: FontLoader = async () => readFirst(ARABIC_FONT_FILE, arabicFontCandidates());

/** Reads Noto Sans Hebrew, the font for Hebrew text. */
export const loadHebrewFontInNode: FontLoader = async () => readFirst(HEBREW_FONT_FILE, hebrewFontCandidates());

/** The places {@link loadDevanagariFontInNode} reads, in the order it tries them. */
export function devanagariFontCandidates(moduleUrl: string = import.meta.url): string[] {
  return fontCandidates(DEVANAGARI_FONT_FILE, DEVANAGARI_PACKAGE, moduleUrl);
}

/** Reads Noto Sans Devanagari, the font for Hindi, Marathi, Nepali and Sanskrit text. */
export const loadDevanagariFontInNode: FontLoader = async () => readFirst(DEVANAGARI_FONT_FILE, devanagariFontCandidates());

/** The places {@link loadComicLetteringFontInNode} reads a face from, in the order it tries them. */
export function comicLetteringFontCandidates(face: ComicLetteringFace, moduleUrl: string = import.meta.url): string[] {
  return fontCandidates(COMIC_LETTERING_FONT_FILES[face], COMIC_LETTERING_PACKAGE, moduleUrl);
}

/** Reads one face of the comic lettering (Comic Neue, or Bangers for sound effects): a WOFF file of `@caotang/font-comic-lettering`. */
export const loadComicLetteringFontInNode: ComicLetteringFontLoader = async (face) =>
  readFirst(COMIC_LETTERING_FONT_FILES[face], comicLetteringFontCandidates(face));
