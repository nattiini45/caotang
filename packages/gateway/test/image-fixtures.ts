/**
 * Image bytes for the part tests. Not a test file: vitest collects `*.test.ts` only.
 *
 * Only the headers are real: the gateway reads magic numbers and dimensions, never pixels, so a
 * handful of header bytes is a complete fixture and a size is whatever padding the test asks for.
 */

import { createHash } from 'node:crypto';

import type { ImageMime, ImagePart } from '../src/index.js';

export const MIB = 1024 * 1024;

export const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** A PNG header carrying `width` x `height`, padded with zeros to `size` bytes. */
export function pngBytes(width: number, height: number, size = 64): Uint8Array {
  const bytes = new Uint8Array(Math.max(size, 24));
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

/** A JPEG with one SOF0 frame header carrying `width` x `height`. */
export function jpegBytes(width: number, height: number, size = 64): Uint8Array {
  const bytes = new Uint8Array(Math.max(size, 16));
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]);
  return bytes;
}

/** A GIF header: the signature and the two little-endian 16-bit dimensions. */
export function gifBytes(width: number, height: number): Uint8Array {
  return Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, width & 0xff, width >> 8, height & 0xff, height >> 8, 0, 0]);
}

/** A lossless-extended WebP header: dimensions are stored minus one, as three little-endian bytes. */
export function webpBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x52, 0x49, 0x46, 0x46, 24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58]);
  const w = width - 1;
  const h = height - 1;
  bytes.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 24);
  return bytes;
}

/** A well-formed image part over `bytes`: hash and size are the bytes' own. */
export function imagePart(bytes: Uint8Array, mime: ImageMime = 'image/png', caption?: string): ImagePart {
  return { type: 'image', mime, bytes, hash: sha256Of(bytes), size: bytes.length, ...(caption === undefined ? {} : { caption }) };
}

export const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

const MARKER = new TextEncoder().encode('SECRET-PIXELS-DO-NOT-LOG');

/**
 * A distinctive run of bytes inside `marked` images, and its base64 form. The run starts on a multiple of three and is a
 * multiple of three long, so those characters appear verbatim inside the whole image's base64: a test can search for them
 * even where a provider echoed only part of the body.
 */
export const MARKER_BASE64 = Buffer.from(MARKER).toString('base64');

export function marked(width: number, height: number): Uint8Array {
  const bytes = pngBytes(width, height, 96);
  bytes.set(MARKER, 30);
  return bytes;
}
