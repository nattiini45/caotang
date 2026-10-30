/**
 * A picture's pixel size, read from its header without decoding it (pictures.md §6.4, the pixel budget). The import reads
 * the size before anything decodes the picture, so a 100-megapixel photo is refused, or sent to a working copy, without a
 * full-size bitmap ever existing. The size is the one the file encodes; an EXIF Orientation that turns the picture on its
 * side does not swap it.
 */

import { sniffImage } from './files.js';

export interface PixelSize {
  readonly width: number;
  readonly height: number;
}

function u16be(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
}

function u32be(bytes: Uint8Array, at: number): number {
  return (((bytes[at] ?? 0) << 24) >>> 0) + ((bytes[at + 1] ?? 0) << 16) + ((bytes[at + 2] ?? 0) << 8) + (bytes[at + 3] ?? 0);
}

function u16le(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
}

function u24le(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16);
}

/** The JPEG start-of-frame markers that carry the frame's size (every SOFn but DHT, JPG and DAC). */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function jpegSize(bytes: Uint8Array): PixelSize | undefined {
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = u16be(bytes, at + 2);
    if (length < 2) return undefined;
    if (isStartOfFrame(marker)) {
      if (at + 9 > bytes.length) return undefined;
      return { height: u16be(bytes, at + 5), width: u16be(bytes, at + 7) };
    }
    at += 2 + length;
  }
  return undefined;
}

function pngSize(bytes: Uint8Array): PixelSize | undefined {
  // The IHDR chunk is first: length (4), "IHDR" (4), width (4), height (4).
  if (bytes.length < 24 || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return undefined;
  return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

function webpSize(bytes: Uint8Array): PixelSize | undefined {
  if (bytes.length < 30) return undefined;
  const chunk = String.fromCharCode(...bytes.subarray(12, 16));
  if (chunk === 'VP8X') return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
  if (chunk === 'VP8 ') {
    // The key frame's start code, then two 14-bit sizes.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return undefined;
    return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) return undefined;
    const b1 = bytes[21] ?? 0;
    const b2 = bytes[22] ?? 0;
    const b3 = bytes[23] ?? 0;
    const b4 = bytes[24] ?? 0;
    return { width: 1 + (((b2 & 0x3f) << 8) | b1), height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)) };
  }
  return undefined;
}

/** The pixel size a PNG, JPEG or WebP file's header states, or `undefined` when the header cannot be read. */
export function pixelSize(bytes: Uint8Array): PixelSize | undefined {
  const format = sniffImage(bytes);
  const size = format === 'png' ? pngSize(bytes) : format === 'jpeg' ? jpegSize(bytes) : format === 'webp' ? webpSize(bytes) : undefined;
  if (size === undefined || size.width <= 0 || size.height <= 0) return undefined;
  return size;
}
