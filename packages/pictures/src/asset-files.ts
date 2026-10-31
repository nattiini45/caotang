/**
 * Picture files: sniffing, headers, import limits, file names and the content hash — pictures.md §6.
 *
 * Everything here reads bytes and answers; nothing decodes pixels. A host that can decode (the
 * browser's canvas) uses these answers to decide *before* it allocates a bitmap, which is what the
 * pixel budget is for.
 */

import { newId, type RandomBytes } from '@caotang/ids';

import { ascii, startsWith, toHex, u16, u32 } from './bytes.js';
import { walkJpeg, walkWebp } from './containers.js';
import { readOrientation, type Orientation } from './metadata.js';
import type { PictureExtension, PictureMime } from './model.js';

/** The largest picture file an import takes: the cover limit, unchanged (16 MiB). */
export const PICTURE_MAX_BYTES = 16 * 1024 * 1024;
/** More pixels than this is refused before any decode (strictly greater than). */
export const PICTURE_MAX_PIXELS = 50_000_000;
/** More pixels than this, or more bytes than {@link PICTURE_ASK_BYTES}, asks once per batch (strictly greater than). */
export const PICTURE_ASK_PIXELS = 24_000_000;
export const PICTURE_ASK_BYTES = 8 * 1024 * 1024;
/** The long edge of a working copy. */
export const WORKING_COPY_LONG_EDGE = 4096;

export const ASSETS_DIR = 'assets';

/** `a_` followed by ten Crockford base32 characters (no I, L, O or U). */
export const ASSET_ID_PATTERN = /^a_[0-9A-HJKMNP-TV-Z]{10}$/;

export function isAssetId(value: unknown): value is string {
  return typeof value === 'string' && ASSET_ID_PATTERN.test(value);
}

/**
 * Mints a random asset id not in `taken`. The id is never derived from the bytes: a content hash in a
 * file name would leak equality between files and break the moment a working copy replaces the bytes.
 */
export function mintAssetId(taken: ReadonlySet<string>, randomBytes?: RandomBytes): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = `a_${newId('c', randomBytes ? { randomBytes } : {}).slice(2)}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error('could not mint a unique a_ id after 8 attempts');
}

export function extensionOfMime(mime: PictureMime): PictureExtension {
  return mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : 'webp';
}

export function mimeOfExtension(extension: string): PictureMime | undefined {
  return extension === 'png' ? 'image/png' : extension === 'jpg' ? 'image/jpeg' : extension === 'webp' ? 'image/webp' : undefined;
}

export function assetFileName(assetId: string, mime: PictureMime): string {
  return `${assetId}.${extensionOfMime(mime)}`;
}

export interface AssetFileName {
  assetId: string;
  mime: PictureMime;
  extension: PictureExtension;
}

/** The asset a file name names, or `undefined` for anything that is not `a_XXXXXXXXXX.<png|jpg|webp>`. */
export function parseAssetFileName(fileName: string): AssetFileName | undefined {
  const match = /^([^.]+)\.(png|jpg|webp)$/.exec(fileName);
  const assetId = match?.[1];
  const extension = match?.[2];
  if (assetId === undefined || extension === undefined || !isAssetId(assetId)) return undefined;
  const mime = mimeOfExtension(extension);
  return mime === undefined ? undefined : { assetId, mime, extension: extension as PictureExtension };
}

export type RefusedFormat = 'empty' | 'heic' | 'avif' | 'svg' | 'gif' | 'tiff' | 'bmp' | 'psd' | 'exr' | 'unknown';

export type SniffResult =
  | { readonly ok: true; readonly mime: PictureMime; readonly extension: PictureExtension }
  | { readonly ok: false; readonly format: RefusedFormat; readonly reason: string };

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'heif']);

function looksLikeSvg(bytes: Uint8Array): boolean {
  let text = '';
  const limit = Math.min(bytes.length, 1024);
  for (let i = startsWith(bytes, [0xef, 0xbb, 0xbf]) ? 3 : 0; i < limit; i += 1) text += String.fromCharCode(bytes[i] ?? 0);
  return /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[^>]*-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>/]/i.test(text);
}

/** The format a file's leading bytes name. The bytes decide, never the file name. */
export function sniffPicture(bytes: Uint8Array): SniffResult {
  if (bytes.length === 0) return { ok: false, format: 'empty', reason: 'The file is empty. Choose a PNG, JPEG or WebP picture.' };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ok: true, mime: 'image/png', extension: 'png' };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { ok: true, mime: 'image/jpeg', extension: 'jpg' };
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return { ok: true, mime: 'image/webp', extension: 'webp' };
  }
  if (startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = ascii(bytes, 8, 4);
    if (HEIC_BRANDS.has(brand)) {
      return { ok: false, format: 'heic', reason: 'This is a HEIC photo, which this app cannot open here. Export it as JPEG, or use the iPhone photo picker.' };
    }
    if (brand === 'avif' || brand === 'avis') {
      return { ok: false, format: 'avif', reason: 'AVIF pictures are not supported. Export the picture as PNG, JPEG or WebP.' };
    }
  }
  if (looksLikeSvg(bytes)) {
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

function sizeOf(bytes: Uint8Array, mime: PictureMime): { width: number; height: number } | undefined {
  if (mime === 'image/png') {
    if (bytes.length < 33 || u32(bytes, 8, false) !== 13 || ascii(bytes, 12, 4) !== 'IHDR') return undefined;
    return { width: u32(bytes, 16, false), height: u32(bytes, 20, false) };
  }
  if (mime === 'image/jpeg') {
    const walked = walkJpeg(bytes);
    if (!walked.ok) return undefined;
    for (const seg of walked.value.segments) {
      const marker = seg.type as number;
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame && seg.dataEnd - seg.dataStart >= 5) return { height: u16(bytes, seg.dataStart + 1, false), width: u16(bytes, seg.dataStart + 3, false) };
    }
    return undefined;
  }
  const walked = walkWebp(bytes);
  if (!walked.ok) return undefined;
  const chunks = walked.value.chunks;
  const canvas = chunks.find((c) => c.type === 'VP8X');
  if (canvas !== undefined) {
    if (canvas.dataEnd - canvas.dataStart < 10) return undefined;
    const at = canvas.dataStart + 4;
    const w = (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16);
    const h = (bytes[at + 3] ?? 0) | ((bytes[at + 4] ?? 0) << 8) | ((bytes[at + 5] ?? 0) << 16);
    return { width: w + 1, height: h + 1 };
  }
  for (const chunk of chunks) {
    if (chunk.type === 'VP8 ') {
      if (chunk.dataEnd - chunk.dataStart < 10 || !startsWith(bytes, [0x9d, 0x01, 0x2a], chunk.dataStart + 3)) return undefined;
      return { width: u16(bytes, chunk.dataStart + 6, true) & 0x3fff, height: u16(bytes, chunk.dataStart + 8, true) & 0x3fff };
    }
    if (chunk.type === 'VP8L') {
      if (chunk.dataEnd - chunk.dataStart < 5 || bytes[chunk.dataStart] !== 0x2f) return undefined;
      const bits = u32(bytes, chunk.dataStart + 1, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
  }
  return undefined;
}

/** Reads the pixel size and EXIF orientation from the header alone; no pixel data is decoded. */
export function readPictureHeader(bytes: Uint8Array, mime: PictureMime): HeaderResult {
  const size = sizeOf(bytes, mime);
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
  if (pixels !== undefined && pixels > PICTURE_ASK_PIXELS) because.push('pixels');
  if (input.bytes > PICTURE_ASK_BYTES) because.push('bytes');
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
  if (long <= WORKING_COPY_LONG_EDGE) return { width, height };
  const scale = WORKING_COPY_LONG_EDGE / long;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** A host's digest: WebCrypto's `crypto.subtle.digest('SHA-256', …)` fits, and so does any other SHA-256. */
export type Sha256Digest = (bytes: Uint8Array) => Promise<ArrayBuffer | Uint8Array>;

interface SubtleHost {
  crypto?: { subtle?: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } };
}

const webCryptoDigest: Sha256Digest = (bytes) => {
  const subtle = (globalThis as SubtleHost).crypto?.subtle;
  if (subtle === undefined) return Promise.reject(new Error('this host has no WebCrypto; pass a SHA-256 digest'));
  return subtle.digest('SHA-256', bytes);
};

/** Lower-case hex SHA-256 of the bytes as stored. Hash after the metadata strip, so privacy-normalised duplicates match. */
export async function sha256Hex(bytes: Uint8Array, digest: Sha256Digest = webCryptoDigest): Promise<string> {
  const out = await digest(bytes);
  return toHex(out instanceof Uint8Array ? out : new Uint8Array(out));
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
