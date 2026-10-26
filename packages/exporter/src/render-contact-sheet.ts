/**
 * The contact-sheet PDF emitter — [storyboard.md](../../../docs/architecture/storyboard.md) §6, `ContactSheetPdfRenderer`.
 *
 * `@caotang/storyboard` lays the sheet out (`planContactSheet`, `paginate`): the page size, the card grid, the number chips,
 * the spec rows, the action lines and the header, in points from the top left. This file draws that plan and nothing else.
 * It makes no layout decision of its own, except two that need the real font: a line the plan's width estimate let through
 * is cut with an ellipsis where the font says it overflows, and a picture is scaled to fit its box without being stretched.
 *
 * ## The library
 *
 * `pdf-lib` (exact pin, MIT), loaded with a dynamic `import()` inside {@link drawContactSheet} and nowhere else, so the editor
 * bundle never pays for it (the DOCX and EPUB pattern, exporter.md §3). It runs in the browser and in Node, with no network:
 * Latin text is set in the PDF's built-in Helvetica, which every PDF reader has, so a Latin-only sheet embeds no font.
 *
 * ## The fallback font
 *
 * Helvetica's built-in encoding is WinAnsi: Latin letters with their accents, and common punctuation. Text outside it is set
 * in Noto Sans Mono CJK SC (`@caotang/font-noto-cjk`), embedded through `@pdf-lib/fontkit` (exact pin, MIT) as a subset that carries only
 * the glyphs the file draws. Each run of text switches font per character cluster: Helvetica for what WinAnsi encodes, the
 * fallback for the rest. The font is read through the input's `loadFallbackFont`, and only when a run needs it, so a
 * Latin-only sheet never reads it and its bytes do not change. The font comes as two files (`@caotang/pdf-fonts/common`): a
 * sheet whose characters are all in the small common file reads only that, and one character outside it reads the full font
 * ({@link fallbackNeeds} reads the sheet's text before the first font is loaded), so the PDF holds the same glyphs either way.
 *
 * Emoji are set in Noto Emoji (`./emoji-font.ts`), monochrome, the last fallback: a cluster in emoji presentation (🎬, ❤️,
 * 👨‍👩‍👧, 🇩🇪, 1️⃣, 👍🏽) goes to it directly; a pictograph whose default is text (☺, ✌) tries Helvetica and Noto Sans Mono CJK first.
 * Each emoji is laid out through the font's ligatures as one grapheme cluster, so a sequence is measured, cut and drawn as one
 * unit, and the ToUnicode map gives the exact sequence back when it is copied. The emoji font is read only when a sheet holds
 * an emoji, through the input's `loadEmojiFont`; it too has a common file, which a sheet whose emoji are all in it reads alone.
 *
 * With `colourEmoji` on, an emoji that Noto Color Emoji has is drawn in colour instead (`./colour-emoji-font.ts`): a Type 3 glyph of the vector
 * picture in `@caotang/font-noto-color-emoji`, read through `loadColourEmoji` only when the sheet holds such an emoji. It ignores the ink the
 * text is set in, and on the dark number chip it has a light backing. An emoji the colour set lacks is set in the emoji font in the same
 * space, and named in the log; when the colour file cannot be read, the whole sheet falls back to the emoji font, and the log says so.
 *
 * Arabic, Persian, Urdu and Hebrew are set in Noto Sans Arabic and Noto Sans Hebrew (`./rtl-font.ts`), after Helvetica and before
 * the CJK font. A text line holding either script is resolved by the bidirectional algorithm of UAX #9 (`@caotang/pdf-fonts/bidi`)
 * after it is cut to its box, so the cut falls between whole grapheme clusters in logical order; a word is shaped and drawn glyph
 * by glyph (cid-embedding.ts `drawPlaced`) in visual order with each glyph's letter in ToUnicode and no `/ActualText`, and a line
 * whose paragraph runs right to left ends at the right edge of its box. The
 * fonts are read through the input's `loadArabicFont` and `loadHebrewFont`, and only when a sheet holds their script.
 *
 * Devanagari (Hindi, Marathi, Nepali, Sanskrit) is set in Noto Sans Devanagari (`./devanagari-font.ts`), in the same place in the order: a
 * word is shaped by upstream fontkit in the project's language and drawn glyph by glyph with its typed text as `/ActualText`. A
 * line is cut to its box between grapheme clusters, a conjunct whole, and the ellipsis follows a cluster. The font is read through
 * the input's `loadDevanagariFont`, and only when a sheet holds Devanagari.
 *
 * A character no font has (another Indic script, a reserved pictograph) is drawn as `?`, and the compile log names each
 * one. So is every character a font would have drawn when that font cannot be read, and the log says why.
 *
 * ## Pictures
 *
 * PNG and JPEG are embedded as they are stored. A WebP is decoded to PNG first, by the input's `transcodePicture` (the app draws it
 * on a canvas; Node decodes it with `@jsquash/webp`, ./picture-transcoder-node.ts), scaled down to 300 dpi of its card, and
 * embedded as that PNG; the format is read from the bytes, never the file name. A picture the engine cannot draw (a WebP with no
 * transcoder, bytes that are gone, a file that does not parse) gets the card's caption in its box instead, and the log names the
 * picture once.
 *
 * ## The paper sheet
 *
 * A plan made with `paperFrames` has paper cards (`PlacedCard.paper`): the emitter draws each as an empty box with a darker 0.75 pt line,
 * no picture and no placeholder text, and its caption beside the chip. It reads no picture file.
 */

import {
  ARABIC_FONT_NAME,
  CJK_FONT_NAME,
  COLOUR_EMOJI_NAME,
  DEVANAGARI_FONT_NAME,
  EMOJI_FONT_NAME,
  HEBREW_FONT_NAME,
  clustersOf,
  countMarks,
  devanagariFontPrints,
  emojiStyleOf,
  fallbackCovers,
  isBidiControl,
  isRtlMark,
  loadFont,
  rtlFontPrints,
  rtlScriptOf,
  scriptRuns,
  type FontLoader,
  type RtlScript,
} from '@caotang/pdf-fonts';
import type * as Bidi from '@caotang/pdf-fonts/bidi';
import type * as ColourModule from '@caotang/pdf-fonts/colour';
import type { Shape } from '@caotang/pdf-fonts/shaper';
import type * as PdfLib from 'pdf-lib';
import { sniffImage, type PlacedCard, type PlacedText, type SheetPlan } from '@caotang/storyboard';

import type { FontkitFont } from './cid-embedding.js';
import { CjkEmbedding, CjkFace } from './cjk-font.js';
import { DevanagariEmbedding, DevanagariFace } from './devanagari-font.js';
import { ColourEmbedding } from './colour-emoji-font.js';
import { EmojiEmbedding, EmojiFace, type EmojiGlyph } from './emoji-font.js';
import { isAnimatedWebp } from './image-size.js';
import { RtlEmbedding, RtlFace, type PlacedGlyph } from './rtl-font.js';

export const PDF_MIME = 'application/pdf';

/** The resolution a picture is kept to on the sheet: its card's box at this many dots per inch. */
const PICTURE_DPI = 300;

/**
 * Decodes a picture the PDF cannot embed (a WebP) into PNG bytes, scaled down, never up, to `maxPixels` on its longer side when
 * one is given. A rejection is a picture that cannot be drawn: the card shows its caption and the log gives the reason.
 */
export type PictureTranscoder = (bytes: Uint8Array, format: 'webp', maxPixels?: number) => Promise<Uint8Array>;

export interface ContactSheetPdfInput {
  readonly plan: SheetPlan;
  /** Shot id to the asset id of the picture its card draws (`planContactSheet`'s `pictures`). */
  readonly pictures: ReadonlyMap<string, string>;
  /**
   * The bytes of one picture by asset id, or `null` when they cannot be read. A rejection is read as `null` too: the card shows
   * its caption and the log names the picture with the reason, and the rest of the sheet is drawn.
   */
  readonly readPicture: (assetId: string) => Promise<Uint8Array | null>;
  /** The document's title, in its metadata. */
  readonly title: string;
  readonly author?: string;
  /** The moment the compile ran: the document's creation and modification dates, so one compile writes one file. */
  readonly at: Date;
  /**
   * Reads the fallback font for text outside WinAnsi (`@caotang/font-noto-cjk`). Called at most once, and only when the sheet holds such
   * text. A loader with a `common` file (`withCommon`, `@caotang/pdf-fonts`) is read through it when the sheet's characters are all in it.
   * Without it, that text is drawn as `?` and the log says so.
   */
  readonly loadFallbackFont?: FontLoader;
  /**
   * Reads the emoji font (Noto Emoji, `./emoji-font.ts`). Called at most once, and only when the sheet holds an emoji; a `common`
   * file is read when all its emoji are in it. Without it, emoji are drawn as `?` and the log says so.
   */
  readonly loadEmojiFont?: FontLoader;
  /**
   * Colour emoji (storyboard.md §6): an emoji that Noto Color Emoji has is drawn as its vector picture, in its own colours, whatever ink the
   * text is set in; the rest keep the emoji font. Absent is off, and the sheet is the one it was before colour emoji existed.
   */
  readonly colourEmoji?: boolean;
  /**
   * Reads the colour emoji file (`@caotang/font-noto-color-emoji`; `./colour-emoji-font.ts`). Called at most once, and only with
   * {@link colourEmoji} on and an emoji the file has on the sheet. When it is missing or cannot be read, the sheet is set in the emoji font
   * and the log says so.
   */
  readonly loadColourEmoji?: FontLoader;
  /** Reads Noto Sans Arabic (`./rtl-font.ts`). Called at most once, and only when the sheet holds Arabic-script text. Without it, that text is drawn as `?` and the log says so. */
  readonly loadArabicFont?: FontLoader;
  /** Reads Noto Sans Hebrew (`./rtl-font.ts`). Called at most once, and only when the sheet holds Hebrew. Without it, Hebrew is drawn as `?` and the log says so. */
  readonly loadHebrewFont?: FontLoader;
  /** Reads Noto Sans Devanagari (`./devanagari-font.ts`). Called at most once, and only when the sheet holds Devanagari. Without it, Devanagari is drawn as `?` and the log says so. */
  readonly loadDevanagariFont?: FontLoader;
  /** Decodes a WebP picture to PNG (see {@link PictureTranscoder}). Called once per picture, and only for a WebP. Without it, a WebP's cards show the caption and the log says so. */
  readonly transcodePicture?: PictureTranscoder;
  /** The project's language (a BCP 47 tag): Devanagari is shaped in it, and Marathi and Nepali use other forms of some letters than Hindi does. Han characters take its forms. */
  readonly language?: string;
}

export interface ContactSheetPdf {
  readonly contents: Uint8Array;
  readonly notes: readonly string[];
}

/** A colour as red, green and blue from 0 to 1. */
interface Shade {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

const INK: Shade = { r: 0.1, g: 0.1, b: 0.1 };
const MUTED: Shade = { r: 0.4, g: 0.4, b: 0.4 };
const FRAME_FILL: Shade = { r: 0.93, g: 0.93, b: 0.93 };
const FRAME_LINE: Shade = { r: 0.7, g: 0.7, b: 0.7 };
/** The ruled line of a paper sheet's frame: darker than the picture sheet's, since a pencil drawing is to sit inside it. */
const FRAME_RULE: Shade = { r: 0.3, g: 0.3, b: 0.3 };
const CHIP_FILL: Shade = { r: 0.15, g: 0.15, b: 0.15 };
const PAPER: Shade = { r: 1, g: 1, b: 1 };

/** The fonts a piece of text can be set in: Helvetica (or Helvetica-Bold), Noto Sans Mono CJK, Noto Emoji, Noto Color Emoji, Noto Sans Arabic, Noto Sans Hebrew, Noto Sans Devanagari. */
type Face = 'base' | 'cjk' | 'emoji' | 'colour' | 'devanagari' | RtlScript;

/**
 * One grapheme cluster of a line, resolved to the font that draws it. An emoji carries the glyphs its layout gave. A letter of
 * Arabic or Hebrew is a cluster until the line is put in visual order; then each run of them is one piece that holds the glyphs
 * the shaper placed (`placed`), its width at the size drawn, and the run's logical text.
 */
interface Piece {
  readonly text: string;
  readonly face: Face;
  readonly glyphs?: readonly EmojiGlyph[];
  readonly placed?: readonly PlacedGlyph[];
  readonly width?: number;
}

const VS15 = 0xfe0e;

/** Variation selectors and the zero-width joiner: dropped from a cluster when the fallback font has no glyph for them. */
function isJoinerOrSelector(code: number): boolean {
  return code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f) || (code >= 0xe0100 && code <= 0xe01ef);
}

function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code < 0xa0);
}

/** The text a plan draws. It takes every string the emitter may set, the caption of a card whose picture is drawn included. */
function planTexts(plan: SheetPlan): string[] {
  const texts: string[] = [];
  for (const sheet of plan.pages) {
    texts.push(sheet.title.text, sheet.pageLabel.text);
    if (sheet.summary !== undefined) texts.push(sheet.summary.text);
    if (sheet.emptyNote !== undefined) texts.push(sheet.emptyNote.text);
    for (const card of sheet.cards) {
      texts.push(card.chipText.text, card.fallback.text);
      if (card.placeholder !== undefined) texts.push(card.placeholder.text);
      if (card.caption !== undefined) texts.push(card.caption.text);
      for (const line of [...card.spec, ...card.action]) texts.push(line.text);
    }
  }
  return texts;
}

/**
 * What a sheet sets in the CJK font and in the emoji font, as `piecesOf` routes it: the characters of every cluster that is
 * neither WinAnsi, nor a right-to-left or Devanagari letter, nor an emoji in emoji presentation, and the emoji clusters. It
 * decides which file of each font is read (`@caotang/pdf-fonts/common`), so it errs toward more: a text pictograph is counted
 * for the emoji font when the CJK font lacks any of it.
 */
export function fallbackNeeds(texts: Iterable<string>, builtIn: ReadonlySet<number>): { readonly cjk: Set<string>; readonly emoji: Set<string> } {
  const cjk = new Set<string>();
  const emoji = new Set<string>();
  for (const text of texts) {
    for (const cluster of clustersOf(text.normalize('NFC'))) {
      const codes = [...cluster].map((char) => char.codePointAt(0) ?? 0);
      if ((codes.length === 1 && isControl(codes[0] ?? 0)) || isBidiControl(cluster)) continue;
      const style = emojiStyleOf(cluster);
      if (style === 'emoji') {
        emoji.add(cluster);
        continue;
      }
      const textCodes = codes.filter((code) => code !== VS15);
      if (textCodes.length > 0 && textCodes.every((code) => builtIn.has(code))) continue;
      const first = String.fromCodePoint(codes[0] ?? 0);
      if (rtlFontPrints(first) !== undefined || devanagariFontPrints(first)) continue;
      for (const code of textCodes) cjk.add(String.fromCodePoint(code));
      if (style === 'text' && !textCodes.every((code) => fallbackCovers(String.fromCodePoint(code)))) emoji.add(String.fromCodePoint(...textCodes));
    }
  }
  return { cjk, emoji };
}

/** The text cut, with an ellipsis, to the width the font measures. Text that fits is returned as it is. */
export function fitToWidth(text: string, maxWidth: number, measure: (text: string) => number): string {
  if (measure(text) <= maxWidth) return text;
  const clusters = clustersOf(text);
  let keep = clusters.length;
  while (keep > 0 && measure(`${clusters.slice(0, keep).join('').trimEnd()}…`) > maxWidth) keep -= 1;
  return keep === 0 ? '' : `${clusters.slice(0, keep).join('').trimEnd()}…`;
}

/** The box a picture of `width` × `height` is drawn in: as large as fits inside `box`, centred, never stretched. */
export function containIn(
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  width: number,
  height: number,
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  if (width <= 0 || height <= 0) return { ...box };
  const scale = Math.min(box.width / width, box.height / height);
  const drawnWidth = width * scale;
  const drawnHeight = height * scale;
  return { x: box.x + (box.width - drawnWidth) / 2, y: box.y + (box.height - drawnHeight) / 2, width: drawnWidth, height: drawnHeight };
}

/**
 * Draws a contact-sheet plan as a PDF. Every page of the plan is one page of the file, in order, so the page count the plan
 * states is the page count the file has.
 */
export async function drawContactSheet(input: ContactSheetPdfInput): Promise<ContactSheetPdf> {
  const lib = await import('pdf-lib');
  const { PDFDocument, StandardFonts, rgb } = lib;
  const color = (c: Shade): PdfLib.RGB => rgb(c.r, c.g, c.b);

  const pdf = await PDFDocument.create({ updateMetadata: false });
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const notes: string[] = [];
  /** What WinAnsi encodes: the same set for Helvetica and Helvetica-Bold. */
  const builtIn = new Set(regular.getCharacterSet());

  // What the sheet sets in the CJK and the emoji font, read from its text the first time either font is needed: it decides
  // which of a font's two files is read.
  let needs: ReturnType<typeof fallbackNeeds> | undefined;
  const fontNeeds = (): ReturnType<typeof fallbackNeeds> => (needs ??= fallbackNeeds(planTexts(input.plan), builtIn));

  // The fallback font, embedded the first time a run needs it. `null` once it is known to be unavailable, with the reason.
  let fallback: CjkEmbedding | null | undefined;
  let fallbackError = '';
  const fallbackFont = async (): Promise<CjkEmbedding | null> => {
    if (fallback !== undefined) return fallback;
    fallback = null;
    if (input.loadFallbackFont === undefined) {
      fallbackError = 'this compile has no fallback font';
      return fallback;
    }
    try {
      const { cjkLoaderFor } = await import('@caotang/pdf-fonts/common');
      const load = cjkLoaderFor(input.loadFallbackFont, fontNeeds().cjk);
      fallback = new CjkEmbedding(lib, pdf, new CjkFace((await loadFont(load, 'the fallback font')) as unknown as FontkitFont, input.language));
    } catch (error) {
      fallbackError = `the fallback font could not be read (${error instanceof Error ? error.message : String(error)})`;
    }
    return fallback;
  };

  // The emoji font, read and laid out the first time a cluster needs it, and embedded by hand (./emoji-font.ts). `null` once it
  // is known to be unavailable, with the reason.
  let emoji: EmojiEmbedding | null | undefined;
  let emojiError = '';
  const emojiFont = async (): Promise<EmojiEmbedding | null> => {
    if (emoji !== undefined) return emoji;
    emoji = null;
    if (input.loadEmojiFont === undefined) {
      emojiError = 'this compile has no emoji font';
      return emoji;
    }
    try {
      const { emojiLoaderFor } = await import('@caotang/pdf-fonts/common');
      const load = emojiLoaderFor(input.loadEmojiFont, fontNeeds().emoji);
      const face = new EmojiFace((await loadFont(load, 'the emoji font')) as unknown as FontkitFont);
      emoji = new EmojiEmbedding(lib, pdf, face);
    } catch (error) {
      emojiError = `the emoji font could not be read (${error instanceof Error ? error.message : String(error)})`;
    }
    return emoji;
  };
  // The colour emoji, opened the first time an emoji the colour set has is met (./colour-emoji-font.ts). `null` once they are known to be
  // unavailable, with the reason; the sheet is then set in the emoji font. The emoji the set lacks are named once.
  let colourModule: typeof ColourModule | undefined;
  let colour: ColourEmbedding | null | undefined;
  let colourError = '';
  const colourLeftOut = new Set<string>();
  const colourFont = async (cluster: string): Promise<ColourEmbedding | null> => {
    if (input.colourEmoji !== true || colour === null) return null;
    colourModule ??= await import('@caotang/pdf-fonts/colour');
    if (!colourModule.colourEmojiCovers(cluster)) {
      colourLeftOut.add(cluster);
      return null;
    }
    if (colour !== undefined) return colour;
    colour = null;
    if (input.loadColourEmoji === undefined) {
      colourError = 'this compile has no colour emoji file';
      return colour;
    }
    try {
      colour = new ColourEmbedding(lib, pdf, await colourModule.openColourEmoji(input.loadColourEmoji));
    } catch (error) {
      colourError = `the colour emoji could not be read (${error instanceof Error ? error.message : String(error)})`;
    }
    return colour;
  };
  /** The glyphs that draw a cluster in the emoji font, or `null` when it cannot. */
  const emojiGlyphs = async (cluster: string): Promise<readonly EmojiGlyph[] | null> => {
    const loaded = await emojiFont();
    return loaded === null ? null : loaded.face.glyphsOf(cluster);
  };

  // The Arabic and Hebrew fonts, read and embedded the first time a cluster of their script needs them, with the bidi module and
  // the shaper they share. `null` once a font is known to be unavailable, with the reason.
  const rtl = new Map<RtlScript, RtlEmbedding | null>();
  const rtlErrors = new Map<RtlScript, string>();
  let tools: { readonly bidi: typeof Bidi; readonly shape: Shape } | undefined;
  const rtlFont = async (script: RtlScript): Promise<RtlEmbedding | null> => {
    const known = rtl.get(script);
    if (known !== undefined) return known;
    rtl.set(script, null);
    const load = script === 'arabic' ? input.loadArabicFont : input.loadHebrewFont;
    const name = script === 'arabic' ? 'Arabic' : 'Hebrew';
    if (load === undefined) {
      rtlErrors.set(script, `this compile has no ${name} font`);
      return null;
    }
    try {
      if (tools === undefined) {
        const shaper = await import('@caotang/pdf-fonts/shaper');
        tools = { bidi: await import('@caotang/pdf-fonts/bidi'), shape: shaper.shapeKeepingMarks(shaper.fontkitShape) };
      }
      const face = new RtlFace(script, (await loadFont(load, `the ${name} font`)) as unknown as FontkitFont, tools.shape);
      const embedding = new RtlEmbedding(lib, pdf, face);
      rtl.set(script, embedding);
      return embedding;
    } catch (error) {
      rtlErrors.set(script, `the ${name} font could not be read (${error instanceof Error ? error.message : String(error)})`);
      return null;
    }
  };
  // The Devanagari font, read and embedded the first time a cluster of the script needs it. `null` once it is known to be
  // unavailable, with the reason.
  let devanagari: DevanagariEmbedding | null | undefined;
  let devanagariError = '';
  const devanagariFont = async (): Promise<DevanagariEmbedding | null> => {
    if (devanagari !== undefined) return devanagari;
    devanagari = null;
    if (input.loadDevanagariFont === undefined) {
      devanagariError = 'this compile has no Devanagari font';
      return devanagari;
    }
    try {
      devanagari = new DevanagariEmbedding(lib, pdf, await DevanagariFace.load(input.loadDevanagariFont, input.language));
    } catch (error) {
      devanagariError = `the Devanagari font could not be read (${error instanceof Error ? error.message : String(error)})`;
    }
    return devanagari;
  };
  // The marks of each script that were left out of what is drawn.
  const marksLeftOut: Record<RtlScript, number> = { arabic: 0, hebrew: 0 };

  // Every character drawn as "?", once each, in the order first met, with how many times it was replaced.
  const missing = new Map<string, number>();
  // Which fallback fonts a "?" would have needed: the log names the ones that could not be read.
  const neededUnavailable = new Set<'cjk' | 'emoji' | 'devanagari' | RtlScript>();

  /**
   * The text as pieces, one per grapheme cluster, each resolved to its font (see the header). A cluster in emoji presentation
   * is set in the emoji font. Any other cluster WinAnsi encodes is set in Helvetica; then in the CJK font when it has every
   * character of the cluster; then, for a pictograph, in the emoji font; and is `?` otherwise, counted in {@link missing}.
   * Control characters become spaces. Each fallback font is loaded here, the first time a cluster needs it.
   */
  const piecesOf = async (text: string): Promise<Piece[]> => {
    const pieces: Piece[] = [];
    for (const cluster of clustersOf(text.normalize('NFC'))) {
      const codes = [...cluster].map((char) => char.codePointAt(0) ?? 0);
      if (codes.length === 1 && isControl(codes[0] ?? 0)) {
        pieces.push({ text: ' ', face: 'base' });
        continue;
      }
      // A bidirectional control character (a mark, an embedding, an isolate) prints nothing and is not drawn.
      if (isBidiControl(cluster)) continue;
      const style = emojiStyleOf(cluster);
      if (style === 'emoji') {
        if ((await colourFont(cluster))?.has(cluster) === true) {
          pieces.push({ text: cluster, face: 'colour' });
          continue;
        }
        const glyphs = await emojiGlyphs(cluster);
        if (glyphs !== null) pieces.push({ text: cluster, face: 'emoji', glyphs });
        else {
          if (emoji === null) neededUnavailable.add('emoji');
          missing.set(cluster, (missing.get(cluster) ?? 0) + 1);
          pieces.push({ text: '?', face: 'base' });
        }
        continue;
      }
      // A text presentation selector (VS15) is never drawn: a pictograph asked for in text presentation is drawn in a text font
      // when one has it, and a letter or digit followed by VS15 (`e\uFE0E`, which is no emoji) stays the letter, in Helvetica.
      const textCodes = codes.filter((code) => code !== VS15);
      if (textCodes.length > 0 && textCodes.every((code) => builtIn.has(code))) {
        pieces.push({ text: String.fromCodePoint(...textCodes), face: 'base' });
        continue;
      }
      // Arabic and Hebrew: Noto Sans Arabic and Noto Sans Hebrew, before the CJK font.
      const script = rtlFontPrints(String.fromCodePoint(codes[0] ?? 0));
      if (script !== undefined) {
        if ((await rtlFont(script)) !== null) {
          pieces.push({ text: cluster, face: script });
          continue;
        }
        neededUnavailable.add(script);
        missing.set(cluster, (missing.get(cluster) ?? 0) + 1);
        pieces.push({ text: '?', face: 'base' });
        continue;
      }
      // Devanagari: Noto Sans Devanagari, after the two right-to-left fonts and before the CJK font.
      if (devanagariFontPrints(String.fromCodePoint(codes[0] ?? 0))) {
        if ((await devanagariFont()) !== null) {
          pieces.push({ text: cluster, face: 'devanagari' });
          continue;
        }
        neededUnavailable.add('devanagari');
        missing.set(cluster, (missing.get(cluster) ?? 0) + 1);
        pieces.push({ text: '?', face: 'base' });
        continue;
      }
      const loaded = await fallbackFont();
      if (loaded !== null) {
        const kept = textCodes.filter((code) => loaded.face.covers(code) || !isJoinerOrSelector(code));
        const glyphs = kept.length > 0 && kept.every((code) => loaded.face.covers(code)) ? loaded.face.glyphsOf(String.fromCodePoint(...kept)) : null;
        if (glyphs !== null) {
          pieces.push({ text: String.fromCodePoint(...kept), face: 'cjk', glyphs });
          continue;
        }
      } else {
        neededUnavailable.add('cjk');
      }
      if (style === 'text') {
        const glyphs = await emojiGlyphs(String.fromCodePoint(...textCodes));
        if (glyphs !== null) {
          pieces.push({ text: cluster, face: 'emoji', glyphs });
          continue;
        }
        if (emoji === null) neededUnavailable.add('emoji');
      }
      missing.set(cluster, (missing.get(cluster) ?? 0) + 1);
      pieces.push({ text: '?', face: 'base' });
    }
    return pieces;
  };

  /** Pieces grouped into runs of one font each, in order: what one `Tj` draws. */
  const runsOf = (pieces: readonly Piece[]): Piece[][] => {
    const runs: Piece[][] = [];
    for (const piece of pieces) {
      const last = runs[runs.length - 1];
      if (last !== undefined && last[0]?.face === piece.face) last.push(piece);
      else runs.push([piece]);
    }
    return runs;
  };

  /**
   * The width of a run of Arabic or Hebrew at a size: the width of each piece that is shaped already, and, for the clusters of a
   * line not put in visual order yet, of each word and each single character the text is cut into (rtl-script.ts), shaped.
   */
  const rtlWidth = (script: RtlScript, run: readonly Piece[], size: number): number => {
    const embedding = rtl.get(script);
    if (embedding === null || embedding === undefined) return 0;
    let width = 0;
    let loose: string[] = [];
    const settle = (): void => {
      for (const part of scriptRuns(loose)) {
        const word = embedding.face.shapeRun(part.text, 'rtl');
        if (word !== null) width += embedding.face.widthOf(word, size);
      }
      loose = [];
    };
    for (const piece of run) {
      if (piece.width === undefined) loose.push(piece.text);
      else {
        settle();
        width += piece.width;
      }
    }
    settle();
    return width;
  };

  /**
   * The width of a run of Devanagari at a size: the run is one shaped word, however many clusters it holds, so a prefix of it (the
   * clusters kept before an ellipsis) is measured as the word it is. A word the engine cannot shape is drawn as "?", a Helvetica
   * one for each cluster.
   */
  const devanagariWidth = (run: readonly Piece[], base: PdfLib.PDFFont, size: number): number => {
    if (devanagari === null || devanagari === undefined) return 0;
    const word = devanagari.face.shapeRun(run.map((piece) => piece.text).join(''));
    return word === null ? base.widthOfTextAtSize('?'.repeat(run.length), size) : devanagari.face.widthOf(word, size);
  };

  /**
   * A line's pieces in the order they are drawn (UAX #9), when it holds Arabic or Hebrew: the clusters of the line, cut to its box
   * already and still in logical order, are resolved at the paragraph's direction, and each run of letters of a script becomes
   * one shaped piece. The marks of a run are left out of its glyphs and counted. A run the engine cannot shape is drawn as "?".
   * A line with neither script is returned as it is.
   */
  const visualPieces = (pieces: readonly Piece[], size: number, direction: 'ltr' | 'rtl'): Piece[] => {
    if (tools === undefined || !pieces.some((piece) => piece.face === 'arabic' || piece.face === 'hebrew')) return [...pieces];
    const known = new Map<string, Piece>();
    for (const piece of pieces) if (!known.has(piece.text)) known.set(piece.text, piece);
    const unknown: Piece = { text: '?', face: 'base' };
    const out: Piece[] = [];
    for (const run of tools.bidi.visualRuns(pieces.map((piece) => piece.text).join(''), direction)) {
      const embedding = run.script === undefined ? undefined : rtl.get(run.script);
      if (run.kind === 'other' || run.script === undefined || embedding === null || embedding === undefined) {
        // The pieces keep their font: a bracket the algorithm turned is the mirror image in Helvetica, if WinAnsi has it.
        // Dropping a control character can join a character to a mark: the mark is left out and counted, as in a shaped run.
        for (const cluster of clustersOf(run.text)) {
          const kept = known.has(cluster) ? undefined : [...cluster].filter((ch) => !isRtlMark(ch));
          if (kept === undefined) out.push(known.get(cluster) as Piece);
          else if (kept.length > 0 && kept.every((ch) => builtIn.has(ch.codePointAt(0) ?? 0))) {
            for (const ch of cluster) if (isRtlMark(ch)) marksLeftOut[rtlScriptOf(ch.codePointAt(0) ?? 0) ?? 'arabic'] += 1;
            out.push({ text: kept.join(''), face: 'base' });
          } else out.push(unknown);
        }
        continue;
      }
      const word = embedding.face.shapeRun(run.source, run.level % 2 === 1 ? 'rtl' : 'ltr');
      if (word === null) {
        for (const cluster of clustersOf(run.source)) {
          missing.set(cluster, (missing.get(cluster) ?? 0) + 1);
          out.push(unknown);
        }
        continue;
      }
      marksLeftOut[run.script] += countMarks(run.source);
      out.push({ text: run.source, face: run.script, placed: word.glyphs, width: embedding.face.widthOf(word, size) });
    }
    return out;
  };

  /** The width of one run at a size, in its own font. */
  const runWidth = (run: readonly Piece[], base: PdfLib.PDFFont, size: number): number => {
    const face = run[0]?.face ?? 'base';
    const glyphs = run.flatMap((piece) => piece.glyphs ?? []);
    if (face === 'emoji') return emoji ? emoji.face.widthOf(glyphs, size) : 0;
    if (face === 'colour') {
      const drawn = colour;
      return drawn ? run.reduce((sum, piece) => sum + drawn.widthOf(piece.text, size), 0) : 0;
    }
    if (face === 'cjk') return fallback ? fallback.face.widthOf(glyphs, size) : 0;
    if (face === 'arabic' || face === 'hebrew') return rtlWidth(face, run, size);
    if (face === 'devanagari') return devanagariWidth(run, base, size);
    return base.widthOfTextAtSize(run.map((piece) => piece.text).join(''), size);
  };

  /** The width of pieces at a size, each run measured in its own font. */
  const widthOf = (pieces: readonly Piece[], base: PdfLib.PDFFont, size: number): number =>
    runsOf(pieces).reduce((sum, run) => sum + runWidth(run, base, size), 0);

  /**
   * Pieces cut, with an ellipsis, to the width the fonts measure: `fitToWidth` over the clusters, each keeping the font it was
   * resolved to, so an emoji sequence is kept or dropped whole. Pieces that fit are returned as they are; an empty list when
   * not one cluster fits.
   */
  const fitPieces = (pieces: readonly Piece[], base: PdfLib.PDFFont, size: number, maxWidth: number): Piece[] => {
    if (widthOf(pieces, base, size) <= maxWidth) return [...pieces];
    const cut = (count: number): Piece[] => {
      let end = count;
      while (end > 0 && /^\s+$/.test(pieces[end - 1]?.text ?? '')) end -= 1;
      return [...pieces.slice(0, end), { text: '…', face: 'base' }];
    };
    let keep = pieces.length;
    while (keep > 0 && widthOf(cut(keep), base, size) > maxWidth) keep -= 1;
    return keep === 0 ? [] : cut(keep);
  };

  /** Draws pieces from a baseline start, each run in its own font, one after the other. */
  const drawPieces = (page: PdfLib.PDFPage, pieces: readonly Piece[], x: number, y: number, size: number, base: PdfLib.PDFFont, ink: Shade): void => {
    let at = x;
    for (const run of runsOf(pieces)) {
      const face = run[0]?.face ?? 'base';
      if (face === 'arabic' || face === 'hebrew') {
        // Each shaped run is drawn glyph by glyph at the positions the shaper gave, in visual order, with each glyph's text in ToUnicode.
        const embedding = rtl.get(face);
        let pen = at;
        for (const piece of run) {
          if (embedding && piece.placed !== undefined) embedding.drawPlaced(page, piece.placed, pen, y, size, ink);
          pen += piece.width ?? 0;
        }
        at = pen;
        continue;
      }
      if (face === 'devanagari') {
        // One shaped word, glyph by glyph at the positions the shaper gave, with the typed text for copying.
        const typed = run.map((piece) => piece.text).join('');
        const word = devanagari?.face.shapeRun(typed) ?? null;
        if (devanagari && word !== null) devanagari.drawPlaced(page, word.glyphs, at, y, size, ink, typed);
        else {
          for (const piece of run) missing.set(piece.text, (missing.get(piece.text) ?? 0) + 1);
          page.drawText('?'.repeat(run.length), { x: at, y, size, font: base, color: color(ink) });
        }
        at += devanagariWidth(run, base, size);
        continue;
      }
      const glyphs = run.flatMap((piece) => piece.glyphs ?? []);
      if (face === 'colour' && colour) {
        // A colour emoji draws its own colours. On the dark number chip it gets a light backing, so it stays legible.
        let pen = at;
        for (const piece of run) {
          const width = colour.widthOf(piece.text, size);
          if (ink === PAPER) page.drawRectangle({ x: pen - 0.5, y: y - 0.25 * size, width: width + 1, height: 1.2 * size, color: color(PAPER) });
          colour.draw(page, piece.text, pen, y, size);
          pen += width;
        }
      } else if (face === 'emoji' && emoji) emoji.draw(page, glyphs, at, y, size, ink);
      else if (face === 'cjk' && fallback) fallback.draw(page, glyphs, at, y, size, ink);
      else page.drawText(run.map((piece) => piece.text).join(''), { x: at, y, size, font: base, color: color(ink) });
      at += runWidth(run, base, size);
    }
  };

  pdf.setTitle(input.title);
  if (input.author !== undefined && input.author.trim() !== '') pdf.setAuthor(input.author.trim());
  pdf.setCreator('Caotang');
  pdf.setProducer('Caotang (pdf-lib)');
  pdf.setCreationDate(input.at);
  pdf.setModificationDate(input.at);

  // Each picture is embedded once, however many cards point at it, and a picture that cannot be drawn is named once.
  const embedded = new Map<string, PdfLib.PDFImage | null>();
  const pictureOf = async (assetId: string, box: { readonly width: number; readonly height: number }): Promise<PdfLib.PDFImage | null> => {
    const known = embedded.get(assetId);
    if (known !== undefined) return known;
    let image: PdfLib.PDFImage | null = null;
    // A read that fails is a picture that cannot be drawn, like one whose bytes are gone: the card shows its caption.
    let bytes: Uint8Array | null = null;
    let readError = '';
    try {
      bytes = await input.readPicture(assetId);
    } catch (error) {
      readError = ` (${error instanceof Error ? error.message : String(error)})`;
    }
    if (bytes === null) {
      notes.push(`contact sheet: image ${assetId} could not be read${readError}, so its cards show the caption`);
    } else {
      const format = sniffImage(bytes);
      try {
        if (format === 'png') image = await pdf.embedPng(bytes);
        else if (format === 'jpeg') image = await pdf.embedJpg(bytes);
        else if (format === 'webp') {
          if (input.transcodePicture === undefined) {
            notes.push(`contact sheet: image ${assetId} is a WebP file, which the PDF cannot embed, so its cards show the caption`);
          } else {
            const maxPixels = Math.ceil((Math.max(box.width, box.height) / 72) * PICTURE_DPI);
            image = await pdf.embedPng(await input.transcodePicture(bytes, 'webp', maxPixels));
            if (isAnimatedWebp(bytes)) notes.push(`contact sheet: image ${assetId} is an animated WebP; its first frame is drawn`);
          }
        } else notes.push(`contact sheet: image ${assetId} is not a PNG or JPEG, so its cards show the caption`);
      } catch (error) {
        image = null;
        notes.push(
          `contact sheet: image ${assetId} could not be embedded (${error instanceof Error ? error.message : String(error)}), so its cards show the caption`,
        );
      }
    }
    embedded.set(assetId, image);
    return image;
  };

  const { width: pageWidth, height: pageHeight, margin, headerHeight } = input.plan.geometry;
  const contentWidth = pageWidth - 2 * margin;
  /** The plan's y runs down from the top; the PDF's runs up from the bottom. */
  const flip = (y: number): number => pageHeight - y;

  const drawText = async (page: PdfLib.PDFPage, placed: PlacedText, font: PdfLib.PDFFont, maxWidth: number, ink: Shade = INK): Promise<void> => {
    const fitted = fitPieces(await piecesOf(placed.text), font, placed.fontSize, maxWidth);
    if (fitted.length === 0) return;
    // A line with Arabic or Hebrew is put in visual order after it is cut. A paragraph that runs right to left ends at the right
    // edge of its box (its direction is that of its first strong character).
    const direction = tools !== undefined && fitted.some((piece) => piece.face === 'arabic' || piece.face === 'hebrew') ? tools.bidi.paragraphDirection(placed.text) : 'ltr';
    const pieces = visualPieces(fitted, placed.fontSize, direction);
    const x = direction === 'rtl' ? placed.x + Math.max(0, maxWidth - widthOf(pieces, font, placed.fontSize)) : placed.x;
    drawPieces(page, pieces, x, flip(placed.y), placed.fontSize, font, ink);
  };

  const drawCard = async (page: PdfLib.PDFPage, card: PlacedCard): Promise<void> => {
    const box = card.image;
    // A paper card is a frame to draw on: an empty box with a darker line, and nothing in it. A picture card's box is shaded.
    page.drawRectangle({
      x: box.x,
      y: flip(box.y + box.height),
      width: box.width,
      height: box.height,
      ...(card.paper ? {} : { color: color(FRAME_FILL) }),
      borderColor: color(card.paper ? FRAME_RULE : FRAME_LINE),
      borderWidth: card.paper ? 0.75 : 0.5,
    });
    if (!card.paper) {
      const assetId = input.pictures.get(card.shotId);
      const image = card.hasImage && assetId !== undefined ? await pictureOf(assetId, box) : null;
      if (image !== null) {
        const fit = containIn(box, image.width, image.height);
        page.drawImage(image, { x: fit.x, y: flip(fit.y + fit.height), width: fit.width, height: fit.height });
      } else {
        await drawText(page, card.placeholder ?? card.fallback, regular, box.width - 2 * (card.fallback.x - box.x), MUTED);
      }
    }

    // The number chip sits on the picture, in its top-left corner, and a paper card's caption on the line beside it.
    page.drawRectangle({
      x: card.chip.x,
      y: flip(card.chip.y + card.chip.height),
      width: card.chip.width,
      height: card.chip.height,
      color: color(CHIP_FILL),
    });
    await drawText(page, card.chipText, bold, card.chip.width, PAPER);
    if (card.caption !== undefined) await drawText(page, card.caption, regular, card.frame.x + card.frame.width - card.caption.x - 4, INK);

    for (const line of card.spec) await drawText(page, line, regular, card.frame.width);
    for (const line of card.action) await drawText(page, line, regular, card.frame.width);
  };

  for (const sheet of input.plan.pages) {
    const page = pdf.addPage([pageWidth, pageHeight]);
    const label = await piecesOf(sheet.pageLabel.text);
    const labelWidth = widthOf(label, bold, sheet.pageLabel.fontSize);
    await drawText(page, sheet.title, bold, Math.max(0, contentWidth - labelWidth - 12));
    drawPieces(page, label, pageWidth - margin - labelWidth, flip(sheet.pageLabel.y), sheet.pageLabel.fontSize, bold, MUTED);
    if (sheet.summary !== undefined) await drawText(page, sheet.summary, regular, contentWidth, MUTED);
    // A rule under the header, above the first row of cards.
    const ruleY = flip(margin + headerHeight - 6);
    page.drawLine({ start: { x: margin, y: ruleY }, end: { x: pageWidth - margin, y: ruleY }, thickness: 0.5, color: color(FRAME_LINE) });

    if (sheet.emptyNote !== undefined) await drawText(page, sheet.emptyNote, regular, contentWidth, MUTED);
    for (const card of sheet.cards) await drawCard(page, card);
  }

  // A sheet whose only emoji the font lacks loaded the font and drew nothing in it: no font is written then.
  if (emoji?.used === true) await emoji.finish();
  if (colour?.used === true) await colour.finish();
  if (fallback?.used === true) await fallback.finish();
  for (const embedding of rtl.values()) if (embedding?.used === true) await embedding.finish();
  if (devanagari?.used === true) await devanagari.finish();

  if (fallback) notes.push(`contact sheet: text outside Latin script is set in ${CJK_FONT_NAME}, embedded with only the glyphs it uses`);
  if (emoji?.used === true) notes.push(`contact sheet: emoji are set in ${EMOJI_FONT_NAME}, in monochrome, embedded with only the glyphs they use`);
  if (colour?.used === true) notes.push(`contact sheet: emoji are set in ${COLOUR_EMOJI_NAME}, in colour, as vector pictures with only the emoji they use`);
  if (colourLeftOut.size > 0) {
    const left = [...colourLeftOut];
    notes.push(`contact sheet: ${COLOUR_EMOJI_NAME} has no picture for ${left.length === 1 ? 'this emoji' : `these ${left.length} emoji`}, so ${left.length === 1 ? 'it is' : 'they are'} set in black and white: ${left.slice(0, 10).join(' ')}${left.length > 10 ? ' …' : ''}`);
  }
  if (colourError !== '') notes.push(`contact sheet: ${colourError}, so the emoji are set in black and white`);
  if (rtl.get('arabic')?.used === true) notes.push(`contact sheet: Arabic, Persian and Urdu text is set in ${ARABIC_FONT_NAME}, embedded with only the glyphs it uses`);
  if (rtl.get('hebrew')?.used === true) notes.push(`contact sheet: Hebrew text is set in ${HEBREW_FONT_NAME}, embedded with only the glyphs it uses`);
  if (devanagari?.used === true) notes.push(`contact sheet: Devanagari text is set in ${DEVANAGARI_FONT_NAME}, embedded with only the glyphs it uses`);
  if (marksLeftOut.hebrew > 0) {
    const n = marksLeftOut.hebrew;
    notes.push(`contact sheet: ${n} Hebrew ${n === 1 ? 'point or cantillation mark is' : 'points and cantillation marks are'} left out of the print, because the font's placement of marks cannot be checked; the text of the file still holds ${n === 1 ? 'it' : 'them'}`);
  }
  if (marksLeftOut.arabic > 0) {
    const n = marksLeftOut.arabic;
    notes.push(`contact sheet: ${n} Arabic ${n === 1 ? 'mark (a haraka, shadda or the like) is' : 'marks (harakat, shadda and the like) are'} left out of the print, because the font's placement of marks cannot be checked; the text of the file still holds ${n === 1 ? 'it' : 'them'}`);
  }
  if (missing.size > 0) {
    const count = [...missing.values()].reduce((sum, n) => sum + n, 0);
    const named = [...missing.keys()]
      .map((cluster) => `${cluster} (${[...cluster].map((char) => `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`).join(' ')})`)
      .join(', ');
    // The fonts that were read and still had no glyph, and why each font a "?" needed could not be read.
    const read = [
      ...(rtl.get('arabic') ? [ARABIC_FONT_NAME] : []),
      ...(rtl.get('hebrew') ? [HEBREW_FONT_NAME] : []),
      ...(devanagari ? [DEVANAGARI_FONT_NAME] : []),
      ...(fallback ? [CJK_FONT_NAME] : []),
      ...(emoji ? [EMOJI_FONT_NAME] : []),
    ];
    const reasons = [
      ...(neededUnavailable.has('arabic') ? [rtlErrors.get('arabic') ?? ''] : []),
      ...(neededUnavailable.has('hebrew') ? [rtlErrors.get('hebrew') ?? ''] : []),
      ...(neededUnavailable.has('devanagari') ? [devanagariError] : []),
      ...(neededUnavailable.has('cjk') ? [fallbackError] : []),
      ...(neededUnavailable.has('emoji') ? [emojiError] : []),
    ];
    const fonts = read.length === 0 ? `the PDF's built-in font cannot show` : `neither the PDF's built-in font nor ${read.join(' nor ')} can show`;
    const why = reasons.length === 0 ? '' : `, and ${reasons.join(', and ')},`;
    notes.push(`contact sheet: ${count} ${count === 1 ? 'character' : 'characters'} ${fonts}${why} ${count === 1 ? 'was' : 'were'} drawn as "?": ${named}`);
  }
  return { contents: await pdf.save({ useObjectStreams: false }), notes };
}
