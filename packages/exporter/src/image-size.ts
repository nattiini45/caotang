/**
 * The pixel size of a cover image, read from its header (epub-metadata.md, the retail note). No decoder: the size is in the
 * first bytes of a PNG, a JPEG or a WebP, and a cover is read whole anyway. The format is sniffed from the bytes, not taken
 * from the file name, so a `.png` that holds a JPEG is still measured as the JPEG it is.
 *
 * `undefined` means the bytes are none of the three, or the header is cut short. A caller that cannot read a size says nothing
 * about it, rather than guessing a size and warning on it.
 */

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

export function imageSizeOf(bytes: Uint8Array): ImageSize | undefined {
  return pngSize(bytes) ?? jpegSize(bytes) ?? webpSize(bytes);
}

const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The first chunk is IHDR, and its data begins at byte 16: the width, then the height, each four bytes, big-endian. */
function pngSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 24 || !PNG_SIGNATURE.every((byte, at) => bytes[at] === byte)) return undefined;
  if (asciiAt(bytes, 12, 4) !== 'IHDR') return undefined;
  return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

/**
 * JPEG segments are a marker, then a two-byte length that counts itself. The size is in the first frame header, a
 * SOF marker: its precision is one byte, then the height and the width, two bytes each, big-endian.
 */
function jpegSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let at = 2;
  while (at + 1 < bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1] ?? 0;
    // Fill bytes may come before a marker, and a few markers stand alone with no length.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      at += 2;
      continue;
    }
    if (at + 3 >= bytes.length) return undefined;
    const length = u16be(bytes, at + 2);
    if (length < 2) return undefined;
    // SOF0 to SOF15, except DHT (C4), JPG (C8) and DAC (CC), which share the range but carry no frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 9 > bytes.length) return undefined;
      return { width: u16be(bytes, at + 7), height: u16be(bytes, at + 5) };
    }
    // Start of scan: the image data begins, and no frame header came before it.
    if (marker === 0xda) return undefined;
    at += 2 + length;
  }
  return undefined;
}

/**
 * A WebP is a RIFF container whose first chunk says how it is coded. A lossy frame (`VP8 `) stores its size after a three-byte
 * frame tag and a start code, as 14-bit numbers, little-endian. A lossless one (`VP8L`) packs both minus one into 28 bits. An
 * extended one (`VP8X`) keeps the canvas size minus one, as 24-bit numbers.
 */
function webpSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 30 || asciiAt(bytes, 0, 4) !== 'RIFF' || asciiAt(bytes, 8, 4) !== 'WEBP') return undefined;
  const chunk = asciiAt(bytes, 12, 4);
  const data = 20;
  if (chunk === 'VP8 ') {
    if (bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a) return undefined;
    return { width: u16le(bytes, data + 6) & 0x3fff, height: u16le(bytes, data + 8) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (bytes[data] !== 0x2f) return undefined;
    const packed = u32le(bytes, data + 1);
    return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    return { width: u24le(bytes, data + 4) + 1, height: u24le(bytes, data + 7) + 1 };
  }
  return undefined;
}

function asciiAt(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length));
}

function u16be(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
}

function u32be(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) * 0x1000000) + (((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0));
}

function u16le(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
}

function u24le(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16);
}

function u32le(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16) | ((bytes[at + 3] ?? 0) << 24)) >>> 0;
}

/** Whether a WebP is an animation: an extended file (`VP8X`) whose flags set the animation bit. A still, or not a WebP, is not. */
export function isAnimatedWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 21 || asciiAt(bytes, 0, 4) !== 'RIFF' || asciiAt(bytes, 8, 4) !== 'WEBP' || asciiAt(bytes, 12, 4) !== 'VP8X') return false;
  return ((bytes[20] ?? 0) & 0x02) !== 0;
}
