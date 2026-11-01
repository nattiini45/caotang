/**
 * The per-target picture profiles of pictures.md §4 — one transcoder path, a profile per compile
 * target, all sizes in pixels and all DPI metadata ignored.
 *
 * The rules every profile shares live in `@caotang/pictures` (`planPicture`, `finishPassthrough`),
 * so the browser canvas and the Node codecs decide the same plan from the same bytes. What this
 * module adds is the choice of output per source format, which is a target's decision, not a
 * host's:
 *
 * - **EPUB** (pictures.md §4, the EPUB row): JPEG at quality 0.85 for photographs, PNG for a
 *   source with alpha or a lossless WebP; alpha flattened onto white (Kindle has no
 *   transparency); the long edge at most `epubImageMaxPx` (1600 by default), never upscaled; WebP
 *   kept only when the writer opted in ("Apple Books only"), because Kobo renders it blank (C1).
 * - **DOCX** (the DOCX row): the same WebP→JPEG/PNG conversion, but no flattening (Word reads
 *   PNG alpha) and no 1600 px limit — Word sizes by extent, so the pixel cap is 2× the text
 *   width at 300 ppi instead (render-docx.ts's `DOCX_IMAGE_MAX_EDGE`).
 * - **Markdown copy** (the Markdown row): the stored bytes are copied as they are, with only the
 *   private metadata stripped, so the profile is `preserve` with no size limit.
 */

import type { PictureMime, PictureProfile } from '@caotang/pictures';

/** What a compile target asks of its pictures (pictures.md §4). */
export interface FigureTargetSpec {
  /** The long edge in pixels; `preserve` copies pass `Number.MAX_SAFE_INTEGER` so nothing is resized. */
  readonly maxEdge: number;
  /** The JPEG quality for photo output (EPUB and DOCX use 0.85). */
  readonly jpegQuality: number;
  /** Flatten alpha onto white (EPUB; JPEG output always flattens, whatever this says). */
  readonly flattenAlpha: boolean;
  /** Strip the private metadata (GPS, maker notes, serials, XMP, IPTC) on export. */
  readonly stripMetadata: boolean;
  /** Keep WebP as WebP (EPUB's "Apple Books only" opt-in). */
  readonly keepWebp: boolean;
  /**
   * Name the payload after the stored file rather than the converted extension (the Markdown copy does:
   * the exported destination keeps the project's own file name, `a_….png`).
   */
  readonly keepStoredName?: boolean;
}

/** The EPUB profile: 1600 px by default (`epubImageMaxPx`), JPEG 0.85, flattened, stripped. */
export const EPUB_IMAGE_MAX_PX = 1600;
export const PICTURE_JPEG_QUALITY = 0.85;

export function epubSpec(options: { maxPx?: number; keepWebp?: boolean; keepMetadata?: boolean }): FigureTargetSpec {
  return {
    maxEdge: options.maxPx ?? EPUB_IMAGE_MAX_PX,
    jpegQuality: PICTURE_JPEG_QUALITY,
    flattenAlpha: true,
    stripMetadata: !options.keepMetadata,
    keepWebp: options.keepWebp ?? false,
  };
}

/**
 * The cover's own cap: 2560 px on the long edge, not the figure limit. A retail cover is 1600 × 2560 (epub-metadata.md's
 * KDP recommendation), so capping it like an interior figure would downscale every printable cover to 1600 px and push its
 * short side under the 1400 px minimum the compile log warns about — the note would then be unavoidable rather than a
 * statement about the writer's file. The rest of the profile is the EPUB profile's: same flatten, strip and WebP rule.
 */
export const EPUB_COVER_MAX_PX = 2560;

export function epubCoverSpec(options: { keepWebp?: boolean; keepMetadata?: boolean } = {}): FigureTargetSpec {
  return { ...epubSpec({ maxPx: EPUB_COVER_MAX_PX, ...options }) };
}

/**
 * The DOCX pixel cap: twice the text width at 300 ppi. The renderer's page is the `docx`
 * library's default — A4 (11906 twips) with 1-inch (1440 twip) margins — so the text width is
 * 9026 twips, 6.27 in, 1880 px at 300 ppi, and the cap is 3761 px (pictures.md §4, the DOCX row).
 */
export const DOCX_TEXT_WIDTH_TWIPS = 11906 - 2 * 1440;
export const DOCX_IMAGE_MAX_EDGE = Math.round((2 * DOCX_TEXT_WIDTH_TWIPS * 300) / 1440);

export function docxSpec(options: { keepMetadata?: boolean }): FigureTargetSpec {
  return {
    maxEdge: DOCX_IMAGE_MAX_EDGE,
    jpegQuality: PICTURE_JPEG_QUALITY,
    flattenAlpha: false,
    stripMetadata: !options.keepMetadata,
    keepWebp: false,
  };
}

/** The Markdown-copy profile: the stored bytes, unresized, under the stored file name, with only the private metadata stripped. */
export function copySpec(options: { keepMetadata?: boolean }): FigureTargetSpec {
  return {
    maxEdge: Number.MAX_SAFE_INTEGER,
    jpegQuality: PICTURE_JPEG_QUALITY,
    flattenAlpha: false,
    stripMetadata: !options.keepMetadata,
    keepWebp: true,
    keepStoredName: true,
  };
}

/** A WebP's coding, from its first chunk: `VP8L` is lossless, a `VP8X` alpha flag means transparency. */
export type WebpKind = 'lossy' | 'lossless' | 'alpha';

export function webpKindOf(bytes: Uint8Array): WebpKind {
  const asciiAt = (at: number, length: number): string => String.fromCharCode(...bytes.subarray(at, at + length));
  if (bytes.length < 21 || asciiAt(0, 4) !== 'RIFF' || asciiAt(8, 4) !== 'WEBP') return 'lossy';
  const chunk = asciiAt(12, 4);
  if (chunk === 'VP8L') return 'lossless';
  if (chunk === 'VP8X' && (bytes[20] ?? 0) & 0x10) return 'alpha';
  return 'lossy';
}

/**
 * The profile one source gets under a target's spec. A PNG or JPEG keeps its format
 * (`preserve`: a picture already within the limit is not re-encoded, only stripped), and a WebP
 * is converted — to JPEG for a lossy photo, to PNG when it has alpha or is lossless — unless the
 * target keeps WebP, in which case a WebP larger than the limit is refused by `planPicture`
 * rather than passed through unscaled.
 */
export function profileForSource(mime: PictureMime, bytes: Uint8Array, spec: FigureTargetSpec): PictureProfile {
  if (mime === 'image/webp') {
    if (spec.keepWebp) {
      return {
        maxEdge: spec.maxEdge,
        output: 'preserve',
        jpegQuality: spec.jpegQuality,
        flattenAlpha: false,
        stripMetadata: spec.stripMetadata,
      };
    }
    return {
      maxEdge: spec.maxEdge,
      output: webpKindOf(bytes) === 'lossy' ? 'jpeg' : 'png',
      jpegQuality: spec.jpegQuality,
      flattenAlpha: spec.flattenAlpha,
      stripMetadata: spec.stripMetadata,
    };
  }
  return {
    maxEdge: spec.maxEdge,
    output: 'preserve',
    jpegQuality: spec.jpegQuality,
    flattenAlpha: spec.flattenAlpha,
    stripMetadata: spec.stripMetadata,
  };
}
