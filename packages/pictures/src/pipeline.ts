/**
 * The import pipeline — pictures.md §6.4 — as a pure function over bytes and an injected decoder.
 *
 * In order:
 *
 *  1. **Sniff** the leading bytes. PNG, JPEG and WebP go on. SVG is refused (§6.1, active content). PSD and EXR are named and
 *     refused. Anything else is refused as not a picture.
 *  2. **HEIC** is decoded where the host can (`createImageBitmap` in Safari) and re-encoded as JPEG at quality 0.9; otherwise it is
 *     refused with the remedy ("export it as JPEG, or use the iPhone photo picker"). There is no WASM decoder: the CSP forbids it.
 *  3. **Pixel budget.** The size is read from the header, so nothing is decoded to learn it. Above 50 MP or 16 MB the import
 *     refuses. Above 24 MP or 8 MB the photo is large, and the batch's one answer decides: keep the original, or store a working
 *     copy with a 4096 px long edge, decoded with resize so a full-size bitmap never exists, and checked for a blank result
 *     (decision D6). A working copy records the original's size.
 *  4. **Metadata.** The GPS location, maker notes and serial numbers are stripped losslessly; Orientation and the colour
 *     profile stay (decision D2).
 *  5. **Hash** the bytes as stored. The dedup against the registry is the caller's, because only it holds the records.
 *
 * Decoding is a browser's job (a canvas), so it is a port: `PictureDecoder`. A host without one (Node, a test) refuses HEIC
 * with the remedy and keeps large originals.
 */

import { isLargePhoto, pixelSize, type PixelSize } from './dimensions.js';
import { stripPrivateMetadata, type StrippedPart } from './exif.js';
import { IMAGE_FORMATS, isHeif, isSvg, sniffImage, unsupportedFormatName, type ImageFormat } from './files.js';
import { sha256Hex } from './hash.js';
import { LARGE_PHOTO_BYTES, PICTURE_MAX_BYTES, PICTURE_MAX_PIXELS, WORKING_COPY_EDGE } from './limits.js';
import type { WorkingCopyOf } from './record.js';

/** What the host can decode. Every method is optional; an absent one is a browser that cannot. */
export interface PictureDecoder {
  /** A HEIC or HEIF photo as JPEG bytes at quality 0.9, upright, or `undefined` when this browser cannot decode it. */
  heicToJpeg?(bytes: Uint8Array): Promise<Uint8Array | undefined>;
  /**
   * The picture decoded with resize so its long edge is at most `maxEdge`, upright, and re-encoded in `format`; `undefined`
   * when the result is blank even after a retry at half the size (the iOS canvas limit), or the browser cannot decode it.
   */
  workingCopy?(bytes: Uint8Array, format: ImageFormat, maxEdge: number): Promise<Uint8Array | undefined>;
}

/** The batch's one answer for large photos (D6). `keep` is the default, and what a host without a decoder gets. */
export type LargePhotoChoice = 'keep' | 'working-copies';

export interface PreparedPicture {
  readonly bytes: Uint8Array;
  readonly format: ImageFormat;
  readonly extension: 'png' | 'jpg' | 'webp';
  readonly mime: 'image/png' | 'image/jpeg' | 'image/webp';
  readonly sha256: string;
  readonly size: PixelSize | undefined;
  /** What the metadata strip took out; empty when there was nothing to take. */
  readonly stripped: readonly StrippedPart[];
  /** Set when a working copy was stored in place of the original. */
  readonly workingCopy?: WorkingCopyOf;
  /** The picture arrived as HEIC and was converted to JPEG. */
  readonly convertedFromHeic?: true;
}

export type PictureRefusalCode = 'empty' | 'format' | 'svg' | 'heic' | 'too-large' | 'too-many-pixels';

export interface PictureRefusal {
  readonly code: PictureRefusalCode;
  readonly message: string;
  readonly hint: string;
}

export type PrepareResult = { readonly ok: true; readonly picture: PreparedPicture } | { readonly ok: false; readonly refusal: PictureRefusal };

function megabytes(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

function megapixels(size: PixelSize): string {
  return `${Math.round((size.width * size.height) / 100_000) / 10} megapixels`;
}

function refuse(code: PictureRefusalCode, message: string, hint: string): PrepareResult {
  return { ok: false, refusal: { code, message, hint } };
}

/**
 * Runs the pipeline over one picture. `what` names it in a refusal ("the image", "the image for “Ferry”"). The input array
 * is never changed.
 */
export async function preparePicture(
  input: Uint8Array,
  options: { readonly decoder?: PictureDecoder; readonly largePhotos?: LargePhotoChoice; readonly what?: string } = {},
): Promise<PrepareResult> {
  const what = options.what ?? 'the image';
  if (input.length === 0) return refuse('empty', `${what} is empty`, 'choose a PNG, JPEG or WebP image');
  if (input.length > PICTURE_MAX_BYTES) {
    return refuse('too-large', `${what} is ${megabytes(input.length)}, and a picture may be at most ${PICTURE_MAX_BYTES / (1024 * 1024)} MB`, 'use a smaller image of the same picture');
  }

  // 1–2. Sniff, and convert HEIC where the host can.
  let bytes = input;
  let convertedFromHeic = false;
  if (isSvg(bytes)) {
    return refuse('svg', `${what} is an SVG drawing, and SVG is not taken because it can carry scripts into an EPUB or an MCP client`, 'export the drawing as PNG and import that');
  }
  if (isHeif(bytes)) {
    const jpeg = options.decoder?.heicToJpeg === undefined ? undefined : await options.decoder.heicToJpeg(bytes);
    if (jpeg === undefined || sniffImage(jpeg) !== 'jpeg') {
      return refuse('heic', `${what} is a HEIC photo, and this browser cannot read HEIC`, 'export it as JPEG first, or add it from the iPhone photo picker, which converts it for you');
    }
    bytes = jpeg;
    convertedFromHeic = true;
  }
  const sniffed = sniffImage(bytes);
  if (sniffed === undefined) {
    const named = unsupportedFormatName(bytes);
    return refuse(
      'format',
      named === undefined ? `${what} is not a PNG, JPEG or WebP image` : `${what} is a ${named} file, and pictures are PNG, JPEG or WebP`,
      named === undefined ? 'choose a PNG, JPEG or WebP file' : 'export it as PNG or JPEG first',
    );
  }
  let format: ImageFormat = sniffed;

  // 3. The pixel budget, from the header.
  let size = pixelSize(bytes);
  if (size !== undefined && size.width * size.height > PICTURE_MAX_PIXELS) {
    return refuse('too-many-pixels', `${what} is ${megapixels(size)}, and a picture may be at most ${PICTURE_MAX_PIXELS / 1_000_000} megapixels`, 'use a smaller copy of the picture');
  }
  let workingCopy: WorkingCopyOf | undefined;
  if (options.largePhotos === 'working-copies' && isLargePhoto(bytes) && size !== undefined && options.decoder?.workingCopy !== undefined) {
    const long = Math.max(size.width, size.height);
    if (long > WORKING_COPY_EDGE || bytes.length > LARGE_PHOTO_BYTES) {
      const copy = await options.decoder.workingCopy(bytes, format, Math.min(long, WORKING_COPY_EDGE));
      const copySize = copy === undefined ? undefined : pixelSize(copy);
      const copyFormat = copy === undefined ? undefined : sniffImage(copy);
      // A blank or unreadable result keeps the original: the writer loses nothing, and the picture is still in the project.
      if (copy !== undefined && copySize !== undefined && copyFormat !== undefined && copy.length < bytes.length) {
        workingCopy = { fromBytes: bytes.length, fromWidth: size.width, fromHeight: size.height };
        bytes = copy;
        format = copyFormat;
        size = copySize;
      }
    }
  }

  // 4. The metadata strip, lossless.
  const strip = stripPrivateMetadata(bytes, format);
  bytes = strip.bytes;

  // 5. The hash of the bytes as stored.
  const sha256 = await sha256Hex(bytes);
  const { extension, mime } = IMAGE_FORMATS[format];
  return {
    ok: true,
    picture: {
      bytes,
      format,
      extension,
      mime,
      sha256,
      size,
      stripped: strip.removed,
      ...(workingCopy === undefined ? {} : { workingCopy }),
      ...(convertedFromHeic ? { convertedFromHeic: true as const } : {}),
    },
  };
}
