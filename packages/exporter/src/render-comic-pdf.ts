/**
 * The comic PDF — [comics.md](../../../docs/architecture/comics.md) §5, `comic-pdf`.
 *
 * One PDF page for each comic page, at the page's trim size plus its bleed, in the book's page order. `@caotang/comic` owns every number
 * a page is drawn from: the trim, bleed and live area of each size (`pageGeometry`), the shapes and tails of the seven balloon kinds
 * (`balloonGeometry`) and how a balloon's text breaks into lines (`layoutLettering`). This file turns those into PDF operators and makes
 * no layout decision of its own beyond two that need the real font: the size a balloon's text is set at so that it fits, and where the
 * lines sit.
 *
 * ## Page boxes
 *
 * The MediaBox is the trim plus the bleed on every side, plus a margin for crop marks when they are asked for. The TrimBox is the trim,
 * the BleedBox the trim plus the bleed (the trim itself when the bleed is off) and the CropBox the MediaBox. A borderless panel with a picture
 * that touches an edge of the live area runs on to the bleed edge on that side, which is what the bleed is for; a panel with a border,
 * and every panel without a picture, stays where the page editor shows it. The file is RGB and its pictures are drawn as stored, so the
 * boxes are what the printer needs and the colour handling is not: the compile log says so.
 *
 * ## The two outputs
 *
 * Full art draws each panel's picture, positioned and cropped by the panel's `crop` and scaled to cover the panel, then the panel's border,
 * then every balloon over all the panels, so a balloon may hang over a gutter and is never hidden by the next panel's picture. Paper frames
 * draws only the panels as empty frames to draw in, numbered, with the page's number at its foot, for the paper round trip
 * (comics.md §3.4); it draws no picture and no lettering.
 *
 * ## Text
 *
 * Lettering is set in Comic Neue and Bangers, embedded as subsets, with the chain of fallback fonts the other PDFs use (./comic-text.ts).
 * Every glyph carries the letter it draws, so the text of the file is the lettering as shown (capitals applied, `**` markers gone) and
 * searchable. The text of a balloon is set at the largest size that fits its text box, down to a floor; one that still does not fit is
 * set at the floor, runs past its outline, and its outline is drawn in red, and the log names it. Nothing is clipped.
 *
 * ## Pictures
 *
 * JPEG is embedded as it is stored, and PNG through pdf-lib; a WebP is decoded to PNG first by the input's `transcodePicture`, as the
 * contact sheet does. A picture that cannot be read or drawn leaves its panel a grey frame labelled so, and the log names it once.
 */

import {
  BALLOON_BOLD_LINE_PT,
  BALLOON_LINE_PT,
  balloonBaseFace,
  balloonGeometry,
  balloonRuns,
  borderPt,
  cloudPathOps,
  drawnKind,
  isPageSize,
  layoutLettering,
  letteringSizesPt,
  pageGeometry,
  type ComicBookSettings,
  type ComicPage,
  type PathOp,
  type Point,
  type Rect,
} from '@caotang/comic';
import type { ComicLetteringFace, ComicLetteringFontLoader, FontLoader } from '@caotang/pdf-fonts';
import { sniffImage } from '@caotang/storyboard';
import type * as PdfLib from 'pdf-lib';

import { ComicTextKit, type TextRun } from './comic-text.js';
import { isAnimatedWebp } from './image-size.js';
import type { PictureTranscoder } from './render-contact-sheet.js';

const MM = 72 / 25.4;
/** The resolution a picture is kept to: its panel's box at this many dots per inch. */
const PICTURE_DPI = 300;

/** Crop marks start this far outside the bleed edge, are this long, and leave this much paper beyond them. */
const MARK_GAP_MM = 1;
const MARK_LENGTH_MM = 5;
const MARK_MARGIN_MM = 1;

interface Shade {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

const INK: Shade = { r: 0.06, g: 0.06, b: 0.06 };
const PAPER: Shade = { r: 1, g: 1, b: 1 };
const GUIDE: Shade = { r: 0.55, g: 0.55, b: 0.55 };
const FRAME_FILL: Shade = { r: 0.9, g: 0.9, b: 0.9 };
const FRAME_RULE: Shade = { r: 0.3, g: 0.3, b: 0.3 };
const OVERFLOW: Shade = { r: 0.85, g: 0.1, b: 0.1 };

export const COMIC_PDF_MIME = 'application/pdf';

export interface ComicPdfPageInput {
  /** The page's node id, for the compile log. */
  readonly id: string;
  readonly page: ComicPage;
}

/** The book a comic PDF draws: its settings and its pages in page order. A book with no script is as valid as one with. */
export interface ComicPdfBook {
  readonly title: string;
  readonly settings: ComicBookSettings;
  readonly pages: readonly ComicPdfPageInput[];
}

export interface ComicPdfInput {
  readonly book: ComicPdfBook;
  /** The bytes of one picture by asset id, or `null` when they cannot be read. A rejection is read as `null` too. */
  readonly readPicture: (assetId: string) => Promise<Uint8Array | null>;
  /** The document's title, in its metadata. */
  readonly title: string;
  readonly author?: string;
  /** The moment the compile ran: the document's creation and modification dates, so one compile writes one file. */
  readonly at: Date;
  /** `full-art` (the default) or `paper-frame`. */
  readonly mode?: 'full-art' | 'paper-frame';
  /** Whether the pages carry their bleed. Default on. */
  readonly bleed?: boolean;
  /** Whether crop marks are drawn outside the bleed. Default off. */
  readonly cropMarks?: boolean;
  /** The project's language (a BCP 47 tag): capitals are made in it, and Han characters and Devanagari take its forms. */
  readonly language?: string;
  /** Reads Comic Neue and Bangers. Required when any balloon has text and the output is full art. */
  readonly loadComicFont?: ComicLetteringFontLoader;
  readonly loadFallbackFont?: FontLoader;
  readonly loadEmojiFont?: FontLoader;
  readonly loadArabicFont?: FontLoader;
  readonly loadHebrewFont?: FontLoader;
  readonly loadDevanagariFont?: FontLoader;
  readonly transcodePicture?: PictureTranscoder;
}

export interface ComicPdf {
  readonly contents: Uint8Array;
  readonly notes: readonly string[];
}

const KAPPA = 0.5522847498;

function ellipsePath(cx: number, cy: number, rx: number, ry: number): PathOp[] {
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return [
    ['M', cx + rx, cy],
    ['C', cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry],
    ['C', cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy],
    ['C', cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry],
    ['C', cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy],
    ['Z'],
  ];
}

function polygonPath(points: readonly (readonly [number, number])[]): PathOp[] {
  const [first, ...rest] = points;
  if (first === undefined) return [];
  return [['M', first[0], first[1]], ...rest.map((p): PathOp => ['L', p[0], p[1]]), ['Z']];
}

const isFiniteRect = (rect: readonly number[] | undefined): rect is Rect =>
  rect !== undefined && rect.length === 4 && rect.every((n) => Number.isFinite(n));

const sizeLabel = (widthMm: number, heightMm: number): string => `${Math.round(widthMm * 10) / 10} × ${Math.round(heightMm * 10) / 10} mm`;

/** Draws a book of comic pages as a PDF. Every page is one page of the file, in order. */
export async function drawComicPdf(input: ComicPdfInput): Promise<ComicPdf> {
  const lib = await import('pdf-lib');
  const { PDFDocument, StandardFonts } = lib;
  const paper = input.mode === 'paper-frame';
  const withBleed = input.bleed !== false;
  const cropMarks = input.cropMarks === true;
  const settings = input.book.settings;
  const language = input.language?.trim() || 'en';
  const pages = input.book.pages;
  if (pages.length === 0) throw new Error('the book has no page to draw');
  const notes: string[] = [];

  const pdf = await PDFDocument.create({ updateMetadata: false });

  // The fonts are read before any page is drawn: the layout that breaks a balloon's lines measures text synchronously.
  const texts: TextRun[] = [];
  const faces = new Set<ComicLetteringFace>();
  if (!paper) {
    for (const { page } of pages) {
      for (const panel of page.panels) {
        for (const balloon of panel.balloons) {
          const base = balloonBaseFace(balloon);
          for (const run of balloonRuns(balloon, base, settings, language)) {
            if (run.text.trim() === '') continue;
            texts.push(run);
            faces.add(run.style);
          }
        }
      }
    }
  }
  if (texts.length > 0 && input.loadComicFont === undefined) {
    throw new Error('this compile cannot read the comic lettering fonts (Comic Neue and Bangers), so the balloons cannot be set');
  }
  const kit =
    texts.length === 0 || input.loadComicFont === undefined
      ? undefined
      : await ComicTextKit.create(
          lib,
          pdf,
          {
            loadComicFont: input.loadComicFont,
            ...(input.loadFallbackFont === undefined ? {} : { loadFallbackFont: input.loadFallbackFont }),
            ...(input.loadEmojiFont === undefined ? {} : { loadEmojiFont: input.loadEmojiFont }),
            ...(input.loadArabicFont === undefined ? {} : { loadArabicFont: input.loadArabicFont }),
            ...(input.loadHebrewFont === undefined ? {} : { loadHebrewFont: input.loadHebrewFont }),
            ...(input.loadDevanagariFont === undefined ? {} : { loadDevanagariFont: input.loadDevanagariFont }),
            language,
          },
          texts,
          faces,
        );
  // The built-in font for what is not lettering: the page numbers of paper frames and the label of a missing picture.
  let helveticaFont: PdfLib.PDFFont | undefined;
  const helvetica = async (): Promise<PdfLib.PDFFont> => (helveticaFont ??= await pdf.embedFont(StandardFonts.Helvetica));

  pdf.setTitle(input.title);
  if (input.author !== undefined && input.author.trim() !== '') pdf.setAuthor(input.author.trim());
  pdf.setCreator('Caotang');
  pdf.setProducer('Caotang (pdf-lib)');
  pdf.setCreationDate(input.at);
  pdf.setModificationDate(input.at);
  pdf.catalog.set(lib.PDFName.of('Lang'), lib.PDFString.of(language));
  // A right-to-left book binds on the right: a reader that lays pages out two to a spread puts the first page there.
  if (settings.readingDirection === 'rtl') {
    pdf.catalog.set(lib.PDFName.of('ViewerPreferences'), pdf.context.obj({ Direction: lib.PDFName.of('R2L') }));
  }

  const shade = (c: Shade): [number, number, number] => [c.r, c.g, c.b];

  const paint = (
    page: PdfLib.PDFPage,
    path: readonly PathOp[],
    style: { readonly fill?: Shade; readonly stroke?: { readonly ink: Shade; readonly width: number; readonly dash?: readonly [number, number] } },
  ): void => {
    const o = lib;
    const { fill, stroke } = style;
    page.pushOperators(
      o.pushGraphicsState(),
      ...(fill === undefined ? [] : [o.setFillingRgbColor(...shade(fill))]),
      ...(stroke === undefined
        ? []
        : [
            o.setStrokingRgbColor(...shade(stroke.ink)),
            o.setLineWidth(stroke.width),
            o.setLineJoin(o.LineJoinStyle.Miter),
            o.setLineCap(o.LineCapStyle.Round),
            ...(stroke.dash === undefined ? [] : [o.setDashPattern([stroke.dash[0], stroke.dash[1]], 0)]),
          ]),
      ...path.map((op) => (op[0] === 'M' ? o.moveTo(op[1], op[2]) : op[0] === 'L' ? o.lineTo(op[1], op[2]) : op[0] === 'C' ? o.appendBezierCurve(op[1], op[2], op[3], op[4], op[5], op[6]) : o.closePath())),
      fill !== undefined && stroke !== undefined ? o.fillAndStroke() : fill !== undefined ? o.fill() : stroke !== undefined ? o.stroke() : o.endPath(),
      o.popGraphicsState(),
    );
  };

  // Each picture is embedded once, however many panels point at it. A picture that cannot be drawn is named once.
  const embedded = new Map<string, PdfLib.PDFImage | null>();
  const pictureOf = async (assetId: string, longSidePt: number): Promise<PdfLib.PDFImage | null> => {
    const known = embedded.get(assetId);
    if (known !== undefined) return known;
    let image: PdfLib.PDFImage | null = null;
    let bytes: Uint8Array | null = null;
    let readError = '';
    try {
      bytes = await input.readPicture(assetId);
    } catch (error) {
      readError = ` (${error instanceof Error ? error.message : String(error)})`;
    }
    if (bytes === null) {
      notes.push(`comic PDF: image ${assetId} could not be read${readError}, so its panels are drawn as grey frames`);
    } else {
      const format = sniffImage(bytes);
      try {
        if (format === 'png') image = await pdf.embedPng(bytes);
        else if (format === 'jpeg') image = await pdf.embedJpg(bytes);
        else if (format === 'webp') {
          if (input.transcodePicture === undefined) {
            notes.push(`comic PDF: image ${assetId} is a WebP file, which the PDF cannot embed, so its panels are drawn as grey frames`);
          } else {
            image = await pdf.embedPng(await input.transcodePicture(bytes, 'webp', Math.ceil((longSidePt / 72) * PICTURE_DPI)));
            if (isAnimatedWebp(bytes)) notes.push(`comic PDF: image ${assetId} is an animated WebP; its first frame is drawn`);
          }
        } else notes.push(`comic PDF: image ${assetId} is not a PNG, JPEG or WebP file, so its panels are drawn as grey frames`);
      } catch (error) {
        image = null;
        notes.push(`comic PDF: image ${assetId} could not be embedded (${error instanceof Error ? error.message : String(error)}), so its panels are drawn as grey frames`);
      }
    }
    embedded.set(assetId, image);
    return image;
  };

  const sizesSeen = new Map<string, string>();
  const unknownSizes = new Set<string>();
  const unknownKinds = new Set<string>();
  let unpictured = 0;
  let badPanels = 0;

  for (const [pageIndex, entry] of pages.entries()) {
    const comicPage = entry.page;
    const pageNumber = pageIndex + 1;
    const size = typeof comicPage.size === 'string' ? comicPage.size : '';
    if (!isPageSize(size)) unknownSizes.add(size === '' ? '(none)' : size);
    const geo = pageGeometry(size);
    const trimW = geo.trimWidthMm * MM;
    const trimH = geo.trimHeightMm * MM;
    const bleed = withBleed ? geo.bleedMm * MM : 0;
    const slug = bleed + (cropMarks ? (MARK_GAP_MM + MARK_LENGTH_MM + MARK_MARGIN_MM) * MM : 0);
    const mediaW = trimW + 2 * slug;
    const mediaH = trimH + 2 * slug;
    sizesSeen.set(sizeLabel(geo.trimWidthMm, geo.trimHeightMm), isPageSize(size) ? size : 'us-comic');

    const page = pdf.addPage([mediaW, mediaH]);
    page.setCropBox(0, 0, mediaW, mediaH);
    page.setBleedBox(slug - bleed, slug - bleed, trimW + 2 * bleed, trimH + 2 * bleed);
    page.setTrimBox(slug, slug, trimW, trimH);

    const marginPt = geo.liveMarginMm * MM;
    const liveW = geo.liveWidthMm * MM;
    const liveH = geo.liveHeightMm * MM;
    const liveX = slug + marginPt;
    const liveTop = slug + trimH - marginPt;
    const toX = (n: number): number => liveX + n * liveW;
    const toY = (n: number): number => liveTop - n * liveH;
    const boxOf = (rect: Rect): { x: number; y: number; w: number; h: number } => ({
      x: toX(rect[0]),
      y: toY(rect[1] + rect[3]),
      w: rect[2] * liveW,
      h: rect[3] * liveH,
    });
    const pointOf = (p: Point): [number, number] => [toX(p[0]), toY(p[1])];

    const panels = comicPage.panels.filter((panel) => {
      if (isFiniteRect(panel.rect)) return true;
      badPanels += 1;
      return false;
    });

    // ---- panels
    for (const [panelIndex, panel] of panels.entries()) {
      const rect = boxOf(panel.rect);
      const border = borderPt(panel.border);
      if (paper) {
        paint(page, [['M', rect.x, rect.y], ['L', rect.x + rect.w, rect.y], ['L', rect.x + rect.w, rect.y + rect.h], ['L', rect.x, rect.y + rect.h], ['Z']], {
          stroke: border === 0 ? { ink: GUIDE, width: 0.25 } : { ink: FRAME_RULE, width: border },
        });
        const label = String(panelIndex + 1);
        page.drawText(label, { x: rect.x + 3, y: rect.y + rect.h - 9, size: 7, font: await helvetica(), color: lib.rgb(...shade(GUIDE)) });
        continue;
      }
      const eps = 1e-4;
      const [rx, ry, rw, rh] = panel.rect;
      const wantsPicture = panel.assetId !== undefined && panel.assetId !== '';
      const image = wantsPicture ? await pictureOf(panel.assetId as string, Math.max(rect.w, rect.h)) : null;
      if (!wantsPicture) unpictured += 1;
      // A borderless picture that touches the live area's edge runs on to the bleed edge on that side.
      const run = marginPt + bleed;
      const reach =
        image !== null && panel.border === 'none'
          ? { left: rx <= eps ? run : 0, bottom: ry + rh >= 1 - eps ? run : 0, right: rx + rw >= 1 - eps ? run : 0, top: ry <= eps ? run : 0 }
          : { left: 0, bottom: 0, right: 0, top: 0 };
      const outer = { x: rect.x - reach.left, y: rect.y - reach.bottom, w: rect.w + reach.left + reach.right, h: rect.h + reach.bottom + reach.top };
      if (image !== null) {
        const crop = isFiniteRect(panel.crop) && panel.crop[2] > 0 && panel.crop[3] > 0 ? panel.crop : ([0, 0, 1, 1] as const);
        const scale = Math.max(outer.w / (crop[2] * image.width), outer.h / (crop[3] * image.height));
        const drawnW = image.width * scale;
        const drawnH = image.height * scale;
        const centreX = outer.x + outer.w / 2;
        const centreY = outer.y + outer.h / 2;
        page.pushOperators(lib.pushGraphicsState(), lib.rectangle(outer.x, outer.y, outer.w, outer.h), lib.clip(), lib.endPath());
        page.drawImage(image, {
          x: centreX - (crop[0] + crop[2] / 2) * drawnW,
          y: centreY - (1 - (crop[1] + crop[3] / 2)) * drawnH,
          width: drawnW,
          height: drawnH,
        });
        page.pushOperators(lib.popGraphicsState());
      } else if (wantsPicture) {
        paint(page, polygonPath([[rect.x, rect.y], [rect.x + rect.w, rect.y], [rect.x + rect.w, rect.y + rect.h], [rect.x, rect.y + rect.h]]), { fill: FRAME_FILL });
        page.drawText('Picture not found', { x: rect.x + 4, y: rect.y + rect.h - 10, size: 6, font: await helvetica(), color: lib.rgb(...shade(GUIDE)) });
      }
      if (border > 0) {
        paint(page, [['M', rect.x, rect.y], ['L', rect.x + rect.w, rect.y], ['L', rect.x + rect.w, rect.y + rect.h], ['L', rect.x, rect.y + rect.h], ['Z']], { stroke: { ink: INK, width: border } });
      }
    }

    // ---- balloons, over every panel, in reading order
    if (!paper) {
      for (const [panelIndex, panel] of panels.entries()) {
        for (const [balloonIndex, balloon] of panel.balloons.entries()) {
          if (!isFiniteRect(balloon.rect)) {
            badPanels += 1;
            continue;
          }
          if (drawnKind(balloon.kind) !== balloon.kind) unknownKinds.add(String(balloon.kind));
          const geometry = balloonGeometry(balloon, { aspect: geo.aspect, panelRect: panel.rect });
          const base = balloonBaseFace(balloon);
          const box = boxOf(balloon.rect);
          const cx = box.x + box.w / 2;
          const cy = box.y + box.h / 2;
          const text = boxOf(geometry.textBox);

          const runs = balloonRuns(balloon, base, settings, language);
          const hasText = runs.some((run) => run.text.trim() !== '');
          let overflow = false;
          let setting: { size: number; lines: ReturnType<ComicTextKit['prepare']>[]; leading: number } | undefined;
          if (hasText && kit !== undefined) {
            const sizes = letteringSizesPt(base, typeof balloon.fontSize === 'number' ? balloon.fontSize : undefined);
            for (const [attempt, size] of sizes.entries()) {
              const laid = layoutLettering(balloon.text, {
                capsTransform: settings.capsTransform !== false,
                esszett: settings.esszett === true,
                language,
                maxWidth: text.w,
                measure: (part, style) => kit.measure(part, style.emphasis && base !== 'sfx' ? 'bold-italic' : base, size),
              });
              const lines = laid.map((line) => kit.prepare(line.runs.map((run) => ({ text: run.text, style: run.emphasis && base !== 'sfx' ? 'bold-italic' : base })), size));
              const leading = size * kit.leadingOf(base);
              setting = { size, lines, leading };
              const fits = lines.length * leading <= text.h + 0.01 && lines.every((line) => line.width <= text.w + 0.01);
              if (fits) break;
              if (attempt === sizes.length - 1) overflow = true;
            }
            if (overflow && setting !== undefined) {
              notes.push(
                `comic PDF: page ${pageNumber}, panel ${panelIndex + 1}, balloon ${balloonIndex + 1}: the text does not fit at ${setting.size} pt, so it runs past the ${geometry.kind === 'sfx' ? 'box' : 'outline'}, which is drawn in red; shorten the text or make the balloon larger`,
              );
            }
          }

          const lineWidth = geometry.style.stroke === 'bold' ? BALLOON_BOLD_LINE_PT : BALLOON_LINE_PT;
          const stroke = geometry.style.stroke === 'none' ? undefined : { ink: overflow ? OVERFLOW : INK, width: lineWidth, ...(geometry.style.dash === undefined ? {} : { dash: [geometry.style.dash[0] * lineWidth, geometry.style.dash[1] * lineWidth] as const }) };
          const rx = box.w / 2;
          const ry = box.h / 2;
          const shape = geometry.outline.shape;
          const outline: PathOp[] =
            shape === 'rect'
              ? [['M', box.x, box.y], ['L', box.x + box.w, box.y], ['L', box.x + box.w, box.y + box.h], ['L', box.x, box.y + box.h], ['Z']]
              : shape === 'cloud'
                ? cloudPathOps(cx, cy, rx, ry, geometry.outline.lobes ?? 12)
                : shape === 'burst' || shape === 'spiky'
                  ? polygonPath((geometry.outline.points ?? []).map(pointOf))
                  : shape === 'ellipse'
                    ? ellipsePath(cx, cy, rx, ry)
                    : [];
          if (shape !== 'none') paint(page, outline, { fill: PAPER, ...(stroke === undefined ? {} : { stroke }) });
          if (geometry.tail !== undefined && stroke !== undefined) {
            // The tail leaves the outline where the ellipse is; a star's body is smaller, so its tail is drawn from further in.
            const pull = shape === 'burst' ? 0.9 : shape === 'spiky' ? 0.97 : 1;
            const toBase = (p: Point): [number, number] => {
              const [x, y] = pointOf(p);
              return [cx + (x - cx) * pull, cy + (y - cy) * pull];
            };
            const b0 = toBase(geometry.tail.base[0]);
            const b1 = toBase(geometry.tail.base[1]);
            const tip = pointOf(geometry.tail.tip);
            const inward = (b: readonly [number, number]): [number, number] => [b[0] + (cx - b[0]) * 0.15, b[1] + (cy - b[1]) * 0.15];
            // Paper over the outline across the tail's mouth, then draw the tail's two sides.
            paint(page, polygonPath([b0, tip, b1, inward(b1), inward(b0)]), { fill: PAPER });
            paint(page, [['M', b0[0], b0[1]], ['L', tip[0], tip[1]], ['L', b1[0], b1[1]]], { stroke });
          }
          if (geometry.circles !== undefined && stroke !== undefined) {
            for (const circle of geometry.circles) {
              const [x, y] = pointOf([circle.cx, circle.cy]);
              paint(page, ellipsePath(x, y, circle.rx * liveW, circle.ry * liveH), { fill: PAPER, stroke });
            }
          }

          if (setting !== undefined && kit !== undefined) {
            const { size, lines, leading } = setting;
            const block = lines.length * leading;
            const top = text.y + text.h / 2 + block / 2;
            const ascent = kit.ascentOf(base) * size;
            // A block taller than its box is set from the box's top, so the first line is never lost off the balloon's head.
            const first = overflow && block > text.h ? text.y + text.h : top;
            for (const [lineIndex, line] of lines.entries()) {
              kit.draw(page, line, text.x + (text.w - line.width) / 2, first - lineIndex * leading - ascent, size, INK);
            }
          }
        }
      }
    }

    // ---- paper frames: the page's number at its foot, where a photograph is matched to it
    if (paper) {
      const font = await helvetica();
      const label = `PAGE ${pageNumber}`;
      const width = font.widthOfTextAtSize(label, 7);
      page.drawText(label, { x: slug + (trimW - width) / 2, y: slug + Math.max(2, marginPt / 2 - 3), size: 7, font, color: lib.rgb(...shade(GUIDE)) });
    }

    // ---- crop marks, at each corner of the trim, clear of the bleed
    if (cropMarks) {
      const gap = bleed + MARK_GAP_MM * MM;
      const length = MARK_LENGTH_MM * MM;
      const corners: [number, number, number, number][] = [
        [slug, slug, -1, -1],
        [slug + trimW, slug, 1, -1],
        [slug, slug + trimH, -1, 1],
        [slug + trimW, slug + trimH, 1, 1],
      ];
      page.pushOperators(lib.pushGraphicsState(), lib.setStrokingCmykColor(1, 1, 1, 1), lib.setLineWidth(0.25));
      for (const [x, y, sx, sy] of corners) {
        page.pushOperators(
          lib.moveTo(x + sx * gap, y),
          lib.lineTo(x + sx * (gap + length), y),
          lib.stroke(),
          lib.moveTo(x, y + sy * gap),
          lib.lineTo(x, y + sy * (gap + length)),
          lib.stroke(),
        );
      }
      page.pushOperators(lib.popGraphicsState());
    }
  }

  if (kit !== undefined) notes.push(...(await kit.finish()));

  const sizeList = [...sizesSeen.entries()].map(([label, name]) => `${name} trim ${label}`).join(', ');
  const bleedLabel = withBleed ? `${Math.round((pageGeometry([...sizesSeen.values()][0] ?? 'us-comic').bleedMm) * 100) / 100} mm bleed` : 'no bleed';
  notes.unshift(
    `comic PDF: ${pages.length} ${pages.length === 1 ? 'page' : 'pages'}, ${sizeList}, ${bleedLabel}${cropMarks ? ', crop marks' : ''}${settings.readingDirection === 'rtl' ? ', right to left' : ''}`,
  );
  if (paper) notes.push('comic PDF: paper frames, so each panel is an empty numbered frame to draw in and no picture or lettering is drawn');
  if (unknownSizes.size > 0) notes.push(`comic PDF: ${[...unknownSizes].join(', ')} is not a page size this build knows, so its pages are drawn at US comic size`);
  if (unknownKinds.size > 0) notes.push(`comic PDF: ${[...unknownKinds].join(', ')} is not a balloon kind this build knows, so those balloons are drawn as speech balloons`);
  if (badPanels > 0) notes.push(`comic PDF: ${badPanels} ${badPanels === 1 ? 'panel or balloon has' : 'panels or balloons have'} no usable rectangle and ${badPanels === 1 ? 'was' : 'were'} left out`);
  if (!paper && unpictured > 0) notes.push(`comic PDF: ${unpictured} ${unpictured === 1 ? 'panel has' : 'panels have'} no picture and ${unpictured === 1 ? 'is' : 'are'} drawn as empty ${unpictured === 1 ? 'frame' : 'frames'}`);
  if (!paper) notes.push('comic PDF: the file is RGB and its pictures are drawn as stored, with no colour conversion or resampling; check the printer\'s requirements before sending it to print');

  return { contents: await pdf.save({ useObjectStreams: false }), notes };
}
