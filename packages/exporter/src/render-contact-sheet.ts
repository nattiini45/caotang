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
 * in Noto Sans CJK SC (`./cjk-font.ts`), embedded through `@pdf-lib/fontkit` (exact pin, MIT) as a subset that carries only
 * the glyphs the file draws. Each run of text switches font per character cluster: Helvetica for what WinAnsi encodes, the
 * fallback for the rest. The font is read through the input's `loadFallbackFont`, and only when a run needs it, so a
 * Latin-only sheet never reads it and its bytes do not change.
 *
 * Emoji are set in Noto Emoji (`./emoji-font.ts`), monochrome, the last fallback: a cluster in emoji presentation (🎬, ❤️,
 * 👨‍👩‍👧, 🇩🇪, 1️⃣, 👍🏽) goes to it directly; a pictograph whose default is text (☺, ✌) tries Helvetica and Noto Sans CJK first.
 * Each emoji is laid out through the font's ligatures as one grapheme cluster, so a sequence is measured, cut and drawn as one
 * unit, and the ToUnicode map gives the exact sequence back when it is copied. The emoji font is read only when a sheet holds
 * an emoji, through the input's `loadEmojiFont`.
 *
 * A character no font has (Arabic, Devanagari, an emoji newer than Emoji 15.1) is drawn as `?`, and the compile log names each
 * one. So is every character a font would have drawn when that font cannot be read, and the log says why.
 *
 * ## Pictures
 *
 * PNG and JPEG are embedded as they are stored. A picture the engine cannot draw (a WebP file, bytes that are gone, a file that
 * does not parse) gets the card's caption in its box instead, and the log names the picture once.
 */

import type * as PdfLib from 'pdf-lib';
import { emojiStyleOf, graphemesOf, sniffImage, type PlacedCard, type PlacedText, type SheetPlan } from '@caotang/storyboard';

import { CJK_FONT_NAME, sfntFromWoff, type FontLoader } from './cjk-font.js';
import { EMOJI_FONT_NAME, EmojiEmbedding, EmojiFace, type EmojiGlyph, type FontkitFont } from './emoji-font.js';

export const PDF_MIME = 'application/pdf';

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
   * Reads the fallback font for text outside WinAnsi (`./cjk-font.ts`). Called at most once, and only when the sheet holds such
   * text. Without it, that text is drawn as `?` and the log says so.
   */
  readonly loadFallbackFont?: FontLoader;
  /**
   * Reads the emoji font (Noto Emoji, `./emoji-font.ts`). Called at most once, and only when the sheet holds an emoji. Without
   * it, emoji are drawn as `?` and the log says so.
   */
  readonly loadEmojiFont?: FontLoader;
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
const CHIP_FILL: Shade = { r: 0.15, g: 0.15, b: 0.15 };
const PAPER: Shade = { r: 1, g: 1, b: 1 };

/** The fonts a piece of text can be set in: Helvetica (or Helvetica-Bold), Noto Sans CJK, Noto Emoji. */
type Face = 'base' | 'cjk' | 'emoji';

/** One grapheme cluster of a line, resolved to the font that draws it. An emoji carries the glyphs its layout gave. */
interface Piece {
  readonly text: string;
  readonly face: Face;
  readonly glyphs?: readonly EmojiGlyph[];
}

/** The character clusters of a text: a letter with its combining marks, an emoji with its modifiers, as a reader sees one character. */
const clustersOf = graphemesOf;

const VS15 = 0xfe0e;

/** Variation selectors and the zero-width joiner: dropped from a cluster when the fallback font has no glyph for them. */
function isJoinerOrSelector(code: number): boolean {
  return code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f) || (code >= 0xe0100 && code <= 0xe01ef);
}

function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code < 0xa0);
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

  // The fonts are imported once, the first time a fallback font is needed.
  let fontkitModule: Promise<{ default: { create(bytes: Uint8Array): unknown } }> | undefined;
  const fontkitOnce = (): Promise<{ default: { create(bytes: Uint8Array): unknown } }> =>
    (fontkitModule ??= import('@pdf-lib/fontkit') as unknown as Promise<{ default: { create(bytes: Uint8Array): unknown } }>);

  // The fallback font, embedded the first time a run needs it. `null` once it is known to be unavailable, with the reason.
  let fallback: { font: PdfLib.PDFFont; covers: Set<number> } | null | undefined;
  let fallbackError = '';
  const fallbackFont = async (): Promise<{ font: PdfLib.PDFFont; covers: Set<number> } | null> => {
    if (fallback !== undefined) return fallback;
    fallback = null;
    if (input.loadFallbackFont === undefined) {
      fallbackError = 'this compile has no fallback font';
      return fallback;
    }
    try {
      const [bytes, fontkit] = await Promise.all([input.loadFallbackFont(), fontkitOnce()]);
      pdf.registerFontkit(fontkit.default as Parameters<PdfLib.PDFDocument['registerFontkit']>[0]);
      const font = await pdf.embedFont(await sfntFromWoff(bytes), { subset: true });
      fallback = { font, covers: new Set(font.getCharacterSet()) };
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
      const [bytes, fontkit] = await Promise.all([input.loadEmojiFont(), fontkitOnce()]);
      const face = new EmojiFace(fontkit.default.create(await sfntFromWoff(bytes)) as FontkitFont);
      emoji = new EmojiEmbedding(lib, pdf, face);
    } catch (error) {
      emojiError = `the emoji font could not be read (${error instanceof Error ? error.message : String(error)})`;
    }
    return emoji;
  };
  /** The glyphs that draw a cluster in the emoji font, or `null` when it cannot. */
  const emojiGlyphs = async (cluster: string): Promise<readonly EmojiGlyph[] | null> => {
    const loaded = await emojiFont();
    return loaded === null ? null : loaded.face.glyphsOf(cluster);
  };

  // Every character drawn as "?", once each, in the order first met, with how many times it was replaced.
  const missing = new Map<string, number>();
  // Which fallback fonts a "?" would have needed: the log names the ones that could not be read.
  const neededUnavailable = new Set<'cjk' | 'emoji'>();

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
      const style = emojiStyleOf(cluster);
      if (style === 'emoji') {
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
      const loaded = await fallbackFont();
      if (loaded !== null) {
        const kept = textCodes.filter((code) => loaded.covers.has(code) || !isJoinerOrSelector(code));
        if (kept.length > 0 && kept.every((code) => loaded.covers.has(code))) {
          pieces.push({ text: String.fromCodePoint(...kept), face: 'cjk' });
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

  /** The PDF font a text run is set in. */
  const pdfFontOf = (face: Face, base: PdfLib.PDFFont): PdfLib.PDFFont => (face === 'cjk' && fallback ? fallback.font : base);

  /** The width of one run at a size, in its own font. */
  const runWidth = (run: readonly Piece[], base: PdfLib.PDFFont, size: number): number => {
    const face = run[0]?.face ?? 'base';
    if (face === 'emoji') return emoji ? emoji.face.widthOf(run.flatMap((piece) => piece.glyphs ?? []), size) : 0;
    return pdfFontOf(face, base).widthOfTextAtSize(run.map((piece) => piece.text).join(''), size);
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
      if (face === 'emoji' && emoji) {
        emoji.draw(page, run.flatMap((piece) => piece.glyphs ?? []), at, y, size, ink);
      } else {
        page.drawText(run.map((piece) => piece.text).join(''), { x: at, y, size, font: pdfFontOf(face, base), color: color(ink) });
      }
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
  const pictureOf = async (assetId: string): Promise<PdfLib.PDFImage | null> => {
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
        else notes.push(`contact sheet: image ${assetId} is not a PNG or JPEG, so its cards show the caption`);
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
    const pieces = fitPieces(await piecesOf(placed.text), font, placed.fontSize, maxWidth);
    if (pieces.length === 0) return;
    drawPieces(page, pieces, placed.x, flip(placed.y), placed.fontSize, font, ink);
  };

  const drawCard = async (page: PdfLib.PDFPage, card: PlacedCard): Promise<void> => {
    const box = card.image;
    page.drawRectangle({
      x: box.x,
      y: flip(box.y + box.height),
      width: box.width,
      height: box.height,
      color: color(FRAME_FILL),
      borderColor: color(FRAME_LINE),
      borderWidth: 0.5,
    });
    const assetId = input.pictures.get(card.shotId);
    const image = card.hasImage && assetId !== undefined ? await pictureOf(assetId) : null;
    if (image !== null) {
      const fit = containIn(box, image.width, image.height);
      page.drawImage(image, { x: fit.x, y: flip(fit.y + fit.height), width: fit.width, height: fit.height });
    } else {
      await drawText(page, card.placeholder ?? card.fallback, regular, box.width - 2 * (card.fallback.x - box.x), MUTED);
    }

    // The number chip sits on the picture, in its top-left corner.
    page.drawRectangle({
      x: card.chip.x,
      y: flip(card.chip.y + card.chip.height),
      width: card.chip.width,
      height: card.chip.height,
      color: color(CHIP_FILL),
    });
    await drawText(page, card.chipText, bold, card.chip.width, PAPER);

    await drawText(page, card.spec, regular, card.frame.width);
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

  if (fallback) notes.push(`contact sheet: text outside Latin script is set in ${CJK_FONT_NAME}, embedded with only the glyphs it uses`);
  if (emoji?.used === true) notes.push(`contact sheet: emoji are set in ${EMOJI_FONT_NAME}, in monochrome, embedded with only the glyphs they use`);
  if (missing.size > 0) {
    const count = [...missing.values()].reduce((sum, n) => sum + n, 0);
    const named = [...missing.keys()]
      .map((cluster) => `${cluster} (${[...cluster].map((char) => `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`).join(' ')})`)
      .join(', ');
    // The fonts that were read and still had no glyph, and why each font a "?" needed could not be read.
    const read = [...(fallback ? [CJK_FONT_NAME] : []), ...(emoji ? [EMOJI_FONT_NAME] : [])];
    const reasons = [...(neededUnavailable.has('cjk') ? [fallbackError] : []), ...(neededUnavailable.has('emoji') ? [emojiError] : [])];
    const fonts = read.length === 0 ? `the PDF's built-in font cannot show` : `neither the PDF's built-in font nor ${read.join(' nor ')} can show`;
    const why = reasons.length === 0 ? '' : `, and ${reasons.join(', and ')},`;
    notes.push(`contact sheet: ${count} ${count === 1 ? 'character' : 'characters'} ${fonts}${why} ${count === 1 ? 'was' : 'were'} drawn as "?": ${named}`);
  }
  return { contents: await pdf.save({ useObjectStreams: false }), notes };
}
