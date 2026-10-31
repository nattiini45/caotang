/**
 * The page raster of the CBZ and the fixed-layout comic EPUB — comics.md §5, D12. It draws one comic page on a canvas at the spec's page height
 * and encodes it as a JPEG; the exporter drives it page by page through the `ComicRasterizer` port (`@caotang/exporter`, `comic-raster.ts`), which
 * owns the order, the bound and the cancel.
 *
 * Nothing here decides a layout. `drawnPageOf` (the page editor's model, which the comic PDF's numbers also come from) places every panel and balloon
 * in millimetres, `balloonGeometry` shapes the balloons, and `@caotang/comic`'s drawing rules say which face a balloon starts in, the sizes
 * its text is tried at and the weight of every line. This file turns those into canvas calls, in pixels, and makes the two decisions that
 * need the real font: the size a balloon's text fits at, and where its lines sit.
 *
 * ## Why a canvas and not the page view's SVG
 *
 * An SVG drawn through an `<img>` cannot see the document's fonts, and `document.fonts.ready` does not reach inside it, so lettering would fall
 * back to a system face and the book would differ from one machine to the next. Drawing on the canvas directly uses the `FontFace`s registered
 * here (the same Comic Neue and Bangers the page view and the PDF use), after they have loaded, so the pictures are the same everywhere.
 * Text outside the two faces' Latin letters falls back to the browser's own fonts, not to the PDF's Noto chain.
 *
 * ## One page in flight
 *
 * A page's pictures are decoded one at a time and released when the page is drawn, so memory holds a single page's bitmaps whatever the book's
 * length. A page checks for a cancel between each step and throws `ComicRasterCancelledError`, leaving no canvas behind.
 */

/* lingui-set comment="Comic raster diagnostics. Interpolated values: page, panel and balloon are numbers; sizePt is a point size; assetId is a picture id; error is a browser error name." */

import { select, t } from '@lingui/core/macro';
import {
  BANGERS_FAMILY,
  COMIC_NEUE_FAMILY,
  balloonBaseFace,
  balloonLinePt,
  balloonRuns,
  borderPt,
  cloudPathOps,
  layoutLettering,
  letteringSizesPt,
  loadComicPage,
  type Balloon,
  type ComicBookSettings,
  type LetteringFace,
  type PathOp,
} from '@caotang/comic';
import { COMIC_RASTER_MIME, COMIC_RASTER_QUALITY, ComicRasterCancelledError, type ComicRasterPage, type ComicRasterPageRequest, type ComicRasterizer } from '@caotang/exporter';

import { drawnPageOf, imagePlacementOf, type DrawnBalloon, type DrawnPanel, type DrawnRect, type PointMm } from './comic-model.js';

/** The canvas context the raster draws with: the page canvas's on the main thread, or an offscreen one. */
export type RasterContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface RasterSurface {
  readonly context: RasterContext;
  /** The canvas as encoded bytes of the given image type. */
  encode(type: string, quality: number): Promise<Uint8Array>;
}

export interface RasterImage {
  readonly width: number;
  readonly height: number;
  readonly source: CanvasImageSource;
  /** Frees the decoded pixels. */
  close(): void;
}

/** What the raster needs from the browser, so the drawing is tested without one. */
export interface ComicRasterHost {
  /** Loads the lettering faces and resolves once they can be drawn. */
  loadFaces(signal: AbortSignal): Promise<void>;
  createSurface(width: number, height: number): RasterSurface;
  /** Decodes a picture's bytes, or gives `null` when they are not an image the browser can read. */
  decodePicture(bytes: Uint8Array): Promise<RasterImage | null>;
}

const MM_PER_PT = 25.4 / 72;
const INK = '#0f0f0f';
const PAPER = '#ffffff';
const FRAME_FILL = '#e6e6e6';
const OVERFLOW = '#d91a1a';

/** The CSS font for a lettering face at a size in pixels, with a system fallback behind it for the letters the face does not have. */
export function fontFor(face: LetteringFace, sizePx: number): string {
  const size = `${Math.round(sizePx * 100) / 100}px`;
  switch (face) {
    case 'regular':
      return `400 ${size} "${COMIC_NEUE_FAMILY}", "Comic Sans MS", sans-serif`;
    case 'italic':
      return `italic 400 ${size} "${COMIC_NEUE_FAMILY}", "Comic Sans MS", sans-serif`;
    case 'bold':
      return `700 ${size} "${COMIC_NEUE_FAMILY}", "Comic Sans MS", sans-serif`;
    case 'bold-italic':
      return `italic 700 ${size} "${COMIC_NEUE_FAMILY}", "Comic Sans MS", sans-serif`;
    case 'sfx':
      return `400 ${size} "${BANGERS_FAMILY}", Impact, sans-serif`;
  }
}

const RTL_LETTER = /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;

/** Whether a line's first letter is from a right-to-left script, which sets the direction the line is drawn in. */
export function startsRightToLeft(text: string): boolean {
  for (const char of text) if (/\p{L}/u.test(char)) return RTL_LETTER.test(char);
  return false;
}

/** The pixels a size in points is at a scale of `pxPerMm`. */
export const ptToPx = (pt: number, pxPerMm: number): number => pt * MM_PER_PT * pxPerMm;

interface LineSetting {
  readonly runs: readonly { readonly text: string; readonly face: LetteringFace; readonly width: number }[];
  readonly width: number;
}

interface TextSetting {
  readonly sizePx: number;
  readonly sizePt: number;
  readonly lines: readonly LineSetting[];
  readonly leading: number;
  readonly ascent: number;
  readonly fits: boolean;
}

function applyOps(ctx: RasterContext, ops: readonly PathOp[]): void {
  for (const op of ops) {
    if (op[0] === 'M') ctx.moveTo(op[1], op[2]);
    else if (op[0] === 'L') ctx.lineTo(op[1], op[2]);
    else if (op[0] === 'C') ctx.bezierCurveTo(op[1], op[2], op[3], op[4], op[5], op[6]);
    else ctx.closePath();
  }
}

function polygonOps(points: readonly (readonly [number, number])[]): PathOp[] {
  const [first, ...rest] = points;
  if (first === undefined) return [];
  return [['M', first[0], first[1]], ...rest.map((p): PathOp => ['L', p[0], p[1]]), ['Z']];
}

/** The text of one balloon set at the largest size that fits its box, down to the floor, as the PDF does. */
export function setBalloonText(
  ctx: RasterContext,
  balloon: Balloon,
  base: LetteringFace,
  settings: ComicBookSettings,
  language: string,
  box: DrawnRect,
  pxPerMm: number,
): TextSetting | undefined {
  if (!balloonRuns(balloon, base, settings, language).some((run) => run.text.trim() !== '')) return undefined;
  const sizes = letteringSizesPt(base, typeof balloon.fontSize === 'number' ? balloon.fontSize : undefined);
  const boxW = box.width * pxPerMm;
  const boxH = box.height * pxPerMm;
  let last: TextSetting | undefined;
  for (const sizePt of sizes) {
    const sizePx = ptToPx(sizePt, pxPerMm);
    const widthOf = (text: string, face: LetteringFace): number => {
      ctx.font = fontFor(face, sizePx);
      return ctx.measureText(text).width;
    };
    const laid = layoutLettering(balloon.text, {
      capsTransform: settings.capsTransform !== false,
      esszett: settings.esszett === true,
      language,
      maxWidth: boxW,
      measure: (text, style) => widthOf(text, style.emphasis && base !== 'sfx' ? 'bold-italic' : base),
    });
    const lines: LineSetting[] = laid.map((line) => {
      const runs = line.runs.map((run) => {
        const face: LetteringFace = run.emphasis && base !== 'sfx' ? 'bold-italic' : base;
        return { text: run.text, face, width: widthOf(run.text, face) };
      });
      return { runs, width: runs.reduce((sum, run) => sum + run.width, 0) };
    });
    ctx.font = fontFor(base, sizePx);
    const metrics = ctx.measureText('Hg');
    const ascent = metrics.fontBoundingBoxAscent ?? sizePx * 0.92;
    const descent = metrics.fontBoundingBoxDescent ?? sizePx * 0.28;
    const leading = ascent + descent;
    const fits = lines.length * leading <= boxH + 0.5 && lines.every((line) => line.width <= boxW + 0.5);
    last = { sizePx, sizePt, lines, leading, ascent, fits };
    if (fits) break;
  }
  return last;
}

function drawBalloonShape(ctx: RasterContext, balloon: DrawnBalloon, pxPerMm: number, overflow: boolean): void {
  const px = (mm: number): number => mm * pxPerMm;
  const point = (p: PointMm): [number, number] => [px(p[0]), px(p[1])];
  const cx = px(balloon.x + balloon.width / 2);
  const cy = px(balloon.y + balloon.height / 2);
  const rx = px(balloon.width / 2);
  const ry = px(balloon.height / 2);
  const widthPx = px(balloonLinePt(balloon.stroke) * MM_PER_PT);
  const stroked = widthPx > 0;
  const ink = overflow ? OVERFLOW : INK;

  const paint = (ops: () => void, fill: boolean, dashed = false): void => {
    ctx.save();
    ctx.beginPath();
    ops();
    if (fill) {
      ctx.fillStyle = PAPER;
      ctx.fill();
    }
    if (stroked) {
      ctx.strokeStyle = ink;
      ctx.lineWidth = widthPx;
      ctx.lineJoin = 'miter';
      ctx.lineCap = 'round';
      if (dashed && balloon.dash !== undefined) ctx.setLineDash([balloon.dash[0] * widthPx, balloon.dash[1] * widthPx]);
      ctx.stroke();
    }
    ctx.restore();
  };

  const shape = balloon.shape;
  if (shape === 'ellipse') paint(() => ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2), true, true);
  else if (shape === 'rect') paint(() => ctx.rect(px(balloon.x), px(balloon.y), px(balloon.width), px(balloon.height)), true, true);
  else if (shape === 'cloud') paint(() => applyOps(ctx, cloudPathOps(cx, cy, rx, ry, balloon.lobes ?? 12)), true, true);
  else if (shape === 'burst' || shape === 'spiky') paint(() => applyOps(ctx, polygonOps((balloon.points ?? []).map(point))), true, true);

  if (balloon.tail !== undefined && stroked) {
    // The tail leaves the outline where the ellipse is; a star's body is smaller, so its tail is drawn from further in.
    const pull = shape === 'burst' ? 0.9 : shape === 'spiky' ? 0.97 : 1;
    const toBase = (p: PointMm): [number, number] => {
      const [x, y] = point(p);
      return [cx + (x - cx) * pull, cy + (y - cy) * pull];
    };
    const b0 = toBase(balloon.tail.base[0]);
    const b1 = toBase(balloon.tail.base[1]);
    const tip = point(balloon.tail.tip);
    const inward = (b: readonly [number, number]): [number, number] => [b[0] + (cx - b[0]) * 0.15, b[1] + (cy - b[1]) * 0.15];
    // Paper over the outline across the tail's mouth, then draw the tail's two sides.
    ctx.save();
    ctx.beginPath();
    ctx.fillStyle = PAPER;
    applyOps(ctx, polygonOps([b0, tip, b1, inward(b1), inward(b0)]));
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(b0[0], b0[1]);
    ctx.lineTo(tip[0], tip[1]);
    ctx.lineTo(b1[0], b1[1]);
    ctx.strokeStyle = ink;
    ctx.lineWidth = widthPx;
    ctx.lineJoin = 'miter';
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.restore();
  }
  for (const circle of balloon.circles ?? []) {
    if (!stroked) break;
    paint(() => ctx.ellipse(px(circle.cx), px(circle.cy), px(circle.rx), px(circle.ry), 0, 0, Math.PI * 2), true);
  }
}

function drawBalloonText(ctx: RasterContext, setting: TextSetting, box: DrawnRect, pxPerMm: number, overflow: boolean): void {
  const boxX = box.x * pxPerMm;
  const boxY = box.y * pxPerMm;
  const boxW = box.width * pxPerMm;
  const boxH = box.height * pxPerMm;
  const block = setting.lines.length * setting.leading;
  // A block taller than its box is set from the box's top, so the first line is never lost off the balloon's head.
  const top = overflow && block > boxH ? boxY : boxY + boxH / 2 - block / 2;
  ctx.save();
  ctx.fillStyle = INK;
  ctx.textBaseline = 'alphabetic';
  for (const [index, line] of setting.lines.entries()) {
    const baseline = top + index * setting.leading + setting.ascent;
    const rtl = startsRightToLeft(line.runs.map((run) => run.text).join(''));
    ctx.direction = rtl ? 'rtl' : 'ltr';
    ctx.textAlign = rtl ? 'right' : 'left';
    let at = rtl ? boxX + boxW / 2 + line.width / 2 : boxX + boxW / 2 - line.width / 2;
    for (const run of line.runs) {
      ctx.font = fontFor(run.face, setting.sizePx);
      ctx.fillText(run.text, at, baseline);
      at += rtl ? -run.width : run.width;
    }
  }
  ctx.restore();
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new ComicRasterCancelledError();
}

const nameOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The rasterizer over a host. The page is drawn in pixels at `heightPx` tall, the trim size with no bleed and no marks. */
export function createComicRasterizer(host: ComicRasterHost): ComicRasterizer {
  return {
    ready: (signal) => host.loadFaces(signal),

    async drawPage(request: ComicRasterPageRequest): Promise<ComicRasterPage> {
      const { page, settings, signal, number } = request;
      throwIfCancelled(signal);
      const drawn = drawnPageOf(page, settings);
      const loaded = loadComicPage(page).value;
      const pxPerMm = request.heightPx / drawn.height;
      const width = Math.max(1, Math.round(drawn.width * pxPerMm));
      const height = Math.max(1, Math.round(request.heightPx));
      const surface = host.createSurface(width, height);
      const ctx = surface.context;
      const px = (mm: number): number => mm * pxPerMm;
      const notes: string[] = [];
      const images: RasterImage[] = [];
      const decoded = new Map<string, RasterImage | null>();
      try {
        ctx.fillStyle = PAPER;
        ctx.fillRect(0, 0, width, height);

        for (const [panelIndex, panel] of drawn.panels.entries()) {
          throwIfCancelled(signal);
          await drawPanel(panel, panelIndex);
        }
        for (const [panelIndex, panel] of drawn.panels.entries()) {
          const source = loaded.panels[panelIndex];
          if (source === undefined) continue;
          for (const [balloonIndex, balloon] of panel.balloons.entries()) {
            throwIfCancelled(signal);
            const stored = source.balloons[balloonIndex];
            if (stored === undefined) continue;
            const base = balloonBaseFace(stored);
            const setting = setBalloonText(ctx, stored, base, settings, request.language, balloon.textBox, pxPerMm);
            const overflow = setting !== undefined && !setting.fits;
            if (overflow) {
              notes.push(
                t`comic page ${{ page: number }}, panel ${{ panel: panelIndex + 1 }}, balloon ${{ balloon: balloonIndex + 1 }}: the text does not fit at ${{ sizePt: setting.sizePt }} pt, so it runs past the ${select({ boundary: balloon.kind }, { sfx: `box`, other: `outline` })}, which is drawn in red; shorten the text or make the balloon larger`,
              );
            }
            drawBalloonShape(ctx, balloon, pxPerMm, overflow);
            if (setting !== undefined) drawBalloonText(ctx, setting, balloon.textBox, pxPerMm, overflow);
          }
        }

        throwIfCancelled(signal);
        const bytes = await surface.encode(COMIC_RASTER_MIME, COMIC_RASTER_QUALITY);
        throwIfCancelled(signal);
        if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
          throw new Error('this browser did not encode the page as a JPEG, so the comic cannot be exported here');
        }
        return { number, width, height, bytes, notes };
      } finally {
        for (const image of images) image.close();
      }

      async function drawPanel(panel: DrawnPanel, panelIndex: number): Promise<void> {
        const rect = { x: px(panel.x), y: px(panel.y), width: px(panel.width), height: px(panel.height) };
        const source = loaded.panels[panelIndex];
        if (panel.assetId !== undefined && panel.assetId !== '') {
          const image = await pictureOf(panel.assetId);
          throwIfCancelled(signal);
          if (image === null) {
            ctx.fillStyle = FRAME_FILL;
            ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
          } else {
            const placement = imagePlacementOf(panel, panel.crop, image.width, image.height);
            ctx.save();
            ctx.beginPath();
            ctx.rect(rect.x, rect.y, rect.width, rect.height);
            ctx.clip();
            ctx.drawImage(image.source, px(placement.x), px(placement.y), px(placement.width), px(placement.height));
            ctx.restore();
          }
        }
        const border = borderPt(source?.border ?? panel.border);
        if (border > 0) {
          ctx.save();
          ctx.strokeStyle = INK;
          ctx.lineWidth = px(border * MM_PER_PT);
          ctx.lineJoin = 'miter';
          ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
          ctx.restore();
        }
      }

      /** One picture, decoded once for the page however many panels use it, or `null` with a note when it cannot be drawn. */
      async function pictureOf(assetId: string): Promise<RasterImage | null> {
        if (decoded.has(assetId)) return decoded.get(assetId) ?? null;
        let image: RasterImage | null = null;
        let bytes: Uint8Array | null = null;
        let readError = '';
        try {
          bytes = await request.readPicture(assetId);
        } catch (error) {
          readError = ` (${nameOf(error)})`;
        }
        if (bytes === null) {
          notes.push(t`comic page ${{ page: number }}: image ${{ assetId }} could not be read${{ error: readError }}, so its panels are drawn as grey frames`);
        } else {
          try {
            image = await host.decodePicture(bytes);
          } catch (error) {
            readError = ` (${nameOf(error)})`;
          }
          if (image === null) notes.push(t`comic page ${{ page: number }}: image ${{ assetId }} is not a picture this browser can read${{ error: readError }}, so its panels are drawn as grey frames`);
          else images.push(image);
        }
        decoded.set(assetId, image);
        return image;
      }
    },
  };
}
