/**
 * Picture files, as the registry's commands read them: the sniff, the header, the size decision and the file names — pictures.md §6.
 *
 * The bytes are read by the low-level helpers this package shares with every import (`files.ts`, `dimensions.ts`, `tiff.ts`,
 * `limits.ts`, `ids.ts`, `hash.ts`); this module only puts their answers into the shapes the commands, the exporter and the hosts
 * use (a sniff that says why a file is refused, a header with the display size, one size decision for a batch). Nothing here
 * decodes pixels.
 */

import { formatOfMime, IMAGE_FORMATS, isHeif, isSvg, sniffImage } from './files.js';
import { walkJpeg, walkWebp } from './containers.js';
import { pixelSize } from './dimensions.js';
import { LARGE_PHOTO_BYTES, LARGE_PHOTO_PIXELS, PICTURE_MAX_BYTES, PICTURE_MAX_PIXELS, WORKING_COPY_EDGE } from './limits.js';
import { readOrientation, type Orientation } from './metadata.js';
import type { PictureExtension, PictureMime } from './model.js';

/** The large-photo thresholds under the names the commands use: above either, the batch asks once (strictly greater than). */
export const PICTURE_ASK_PIXELS = LARGE_PHOTO_PIXELS;
export const PICTURE_ASK_BYTES = LARGE_PHOTO_BYTES;
/** The long edge of a working copy. */
export const WORKING_COPY_LONG_EDGE = WORKING_COPY_EDGE;

export function extensionOfMime(mime: PictureMime): PictureExtension {
  return IMAGE_FORMATS[formatOfMime(mime) ?? 'png'].extension;
}

export function mimeOfExtension(extension: string): PictureMime | undefined {
  return extension === 'png' ? 'image/png' : extension === 'jpg' ? 'image/jpeg' : extension === 'webp' ? 'image/webp' : undefined;
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

export type RefusedFormat = 'empty' | 'heic' | 'avif' | 'svg' | 'gif' | 'tiff' | 'bmp' | 'psd' | 'exr' | 'unknown';

export type SniffResult =
  | { readonly ok: true; readonly mime: PictureMime; readonly extension: PictureExtension }
  | { readonly ok: false; readonly format: RefusedFormat; readonly reason: string };

/** The format a file's leading bytes name. The bytes decide, never the file name. */
export function sniffPicture(bytes: Uint8Array): SniffResult {
  if (bytes.length === 0) return { ok: false, format: 'empty', reason: 'The file is empty. Choose a PNG, JPEG or WebP picture.' };
  const format = sniffImage(bytes);
  if (format !== undefined) return { ok: true, mime: IMAGE_FORMATS[format].mime, extension: IMAGE_FORMATS[format].extension };
  if (isHeif(bytes)) {
    return { ok: false, format: 'heic', reason: 'This is a HEIC photo, which this app cannot open here. Export it as JPEG, or use the iPhone photo picker.' };
  }
  if (startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = String.fromCharCode(bytes[8] ?? 0, bytes[9] ?? 0, bytes[10] ?? 0, bytes[11] ?? 0);
    if (brand === 'avif' || brand === 'avis') {
      return { ok: false, format: 'avif', reason: 'AVIF pictures are not supported. Export the picture as PNG, JPEG or WebP.' };
    }
  }
  if (isSvg(bytes)) {
    return { ok: false, format: 'svg', reason: 'SVG pictures are not accepted because they can contain scripts. Export it as PNG, JPEG or WebP.' };
  }
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return { ok: false, format: 'gif', reason: 'GIF pictures are not supported. Export the picture as PNG, JPEG or WebP.' };
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
    return { ok: false, format: 'tiff', reason: 'TIFF pictures are not supported. Export the picture as PNG, JPEG or WebP.' };
  }
  if (startsWith(bytes, [0x42, 0x4d])) return { ok: false, format: 'bmp', reason: 'BMP pictures are not supported. Export the picture as PNG, JPEG or WebP.' };
  if (startsWith(bytes, [0x38, 0x42, 0x50, 0x53])) {
    return { ok: false, format: 'psd', reason: 'Photoshop (PSD) files are not supported. Export the picture as PNG, JPEG or WebP.' };
  }
  if (startsWith(bytes, [0x76, 0x2f, 0x31, 0x01])) {
    return { ok: false, format: 'exr', reason: 'OpenEXR files are not supported. Export the picture as PNG, JPEG or WebP.' };
  }
  return { ok: false, format: 'unknown', reason: 'This file is not a PNG, JPEG or WebP picture.' };
}

export type HeaderResult =
  | {
      readonly ok: true;
      /** As stored in the file. */
      readonly width: number;
      readonly height: number;
      readonly orientation: Orientation;
      /** What the writer sees: width and height swapped when the orientation turns the picture on its side. */
      readonly displayWidth: number;
      readonly displayHeight: number;
      readonly pixels: number;
    }
  | { readonly ok: false; readonly reason: string };

const UNREADABLE = 'The picture\'s header could not be read, so it was not imported.';

/** Reads the pixel size and EXIF orientation from the header alone; no pixel data is decoded. */
export function readPictureHeader(bytes: Uint8Array, mime: PictureMime): HeaderResult {
  // A container whose own table does not hold together (a RIFF size past the end, a JPEG segment that overruns) is not trusted
  // for a size either, whatever its first frame says.
  const walks = mime === 'image/jpeg' ? walkJpeg(bytes).ok : mime === 'image/webp' ? walkWebp(bytes).ok : true;
  const size = walks && sniffImage(bytes) === formatOfMime(mime) ? pixelSize(bytes) : undefined;
  if (size === undefined || size.width < 1 || size.height < 1) return { ok: false, reason: UNREADABLE };
  const orientation = readOrientation(bytes, mime) ?? 1;
  const turned = orientation >= 5;
  return {
    ok: true,
    width: size.width,
    height: size.height,
    orientation,
    displayWidth: turned ? size.height : size.width,
    displayHeight: turned ? size.width : size.height,
    pixels: size.width * size.height,
  };
}

export type ImportDecision =
  | { readonly action: 'refuse'; readonly reason: 'too-many-bytes' | 'too-many-pixels'; readonly message: string }
  | { readonly action: 'ask'; readonly because: readonly ('pixels' | 'bytes')[] }
  | { readonly action: 'accept' };

function mib(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

/**
 * The size rules, as one pure decision. The byte cap is checked first, so a file over 16 MiB is refused
 * without reading its header; `width` and `height` are optional for that reason. Every threshold is
 * strictly greater-than: a file of exactly 16 MiB, 50,000,000 pixels, 24,000,000 pixels or 8 MiB passes.
 */
export function decideImportSize(input: { bytes: number; width?: number; height?: number }): ImportDecision {
  if (input.bytes > PICTURE_MAX_BYTES) {
    return {
      action: 'refuse',
      reason: 'too-many-bytes',
      message: `This picture is ${mib(input.bytes)}, and a picture may be at most ${PICTURE_MAX_BYTES / (1024 * 1024)} MB. Shrink or export it smaller first.`,
    };
  }
  const pixels = input.width !== undefined && input.height !== undefined ? input.width * input.height : undefined;
  if (pixels !== undefined && pixels > PICTURE_MAX_PIXELS) {
    return {
      action: 'refuse',
      reason: 'too-many-pixels',
      message: `This picture is ${Math.round(pixels / 100_000) / 10} megapixels, and a picture may be at most ${PICTURE_MAX_PIXELS / 1_000_000} megapixels. Export it smaller first.`,
    };
  }
  const because: ('pixels' | 'bytes')[] = [];
  if (pixels !== undefined && pixels > LARGE_PHOTO_PIXELS) because.push('pixels');
  if (input.bytes > LARGE_PHOTO_BYTES) because.push('bytes');
  return because.length > 0 ? { action: 'ask', because } : { action: 'accept' };
}

export interface BatchDecision {
  readonly decisions: readonly ImportDecision[];
  /** True when any item asks: the writer is asked once for the whole batch, never once per picture. */
  readonly prompt: boolean;
  readonly refused: boolean;
}

export function decideImportBatch(items: readonly { bytes: number; width?: number; height?: number }[]): BatchDecision {
  const decisions = items.map(decideImportSize);
  return {
    decisions,
    prompt: decisions.some((d) => d.action === 'ask'),
    refused: decisions.some((d) => d.action === 'refuse'),
  };
}

/** The size of a 4096-long-edge working copy; a picture already within the edge keeps its size (no upscaling). */
export function workingCopySize(width: number, height: number): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= WORKING_COPY_EDGE) return { width, height };
  const scale = WORKING_COPY_EDGE / long;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
