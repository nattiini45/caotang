/**
 * Hand-built picture bytes for the tests: a JPEG with an EXIF block holding Orientation, a GPS IFD, a maker note and a body
 * serial number; a PNG with an `eXIf` chunk; a WebP with an `EXIF` chunk. Built here rather than checked in, so each byte a
 * test asserts on is visible next to the code that made it.
 */

/** A little-endian TIFF block: IFD0 {Orientation, ExifIFD, GPS}, Exif IFD {MakerNote, BodySerialNumber}, GPS IFD {LatRef, Lat}. */
export function exifTiff(orientation = 6): Uint8Array {
  const out: number[] = [];
  const u16 = (v: number): void => void out.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v: number): void => void out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const entry = (tag: number, type: number, count: number, value: number): void => {
    u16(tag);
    u16(type);
    u32(count);
    u32(value);
  };
  // Layout: header 8, IFD0 at 8 (3 entries: 2 + 36 + 4 = 42) → 50; Exif IFD at 50 (2 entries: 2 + 24 + 4 = 30) → 80;
  // GPS IFD at 80 (2 entries: 30) → 110; maker note (10 bytes) at 110; serial (8 bytes) at 120; latitude (24 bytes) at 128.
  out.push(0x49, 0x49);
  u16(42);
  u32(8);
  u16(3);
  out.push(0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0); // Orientation, SHORT, 1, inline
  entry(0x8769, 4, 1, 50);
  entry(0x8825, 4, 1, 80);
  u32(0);
  u16(2);
  entry(0x927c, 7, 10, 110);
  entry(0xa431, 2, 8, 120);
  u32(0);
  u16(2);
  out.push(0x01, 0x00, 2, 0, 2, 0, 0, 0, 0x4e, 0, 0, 0); // GPSLatitudeRef "N"
  entry(0x0002, 5, 3, 128);
  u32(0);
  out.push(...Array.from('CANONNOTES', (c) => c.charCodeAt(0)));
  out.push(...Array.from('SN12345', (c) => c.charCodeAt(0)), 0);
  for (const [num, den] of [[52, 1], [15, 1], [3000, 100]] as const) {
    u32(num);
    u32(den);
  }
  return Uint8Array.from(out);
}

/** A JPEG: SOI, APP1 Exif (optional), SOF0 of `width`×`height`, a token SOS and EOI. Not decodable; every header is real. */
export function jpeg(options: { exif?: Uint8Array; width?: number; height?: number; xmpGps?: boolean } = {}): Uint8Array {
  const out: number[] = [0xff, 0xd8];
  if (options.exif !== undefined) {
    const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...options.exif];
    out.push(0xff, 0xe1, ((payload.length + 2) >> 8) & 0xff, (payload.length + 2) & 0xff, ...payload);
  }
  if (options.xmpGps === true) {
    const text = 'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><rdf:Description exif:GPSLatitude="52,15.5N"/></x:xmpmeta>';
    const payload = Array.from(text, (c) => c.charCodeAt(0));
    out.push(0xff, 0xe1, ((payload.length + 2) >> 8) & 0xff, (payload.length + 2) & 0xff, ...payload);
  }
  const w = options.width ?? 640;
  const h = options.height ?? 480;
  out.push(0xff, 0xc0, 0, 17, 8, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1);
  out.push(0xff, 0xda, 0, 12, 3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0, 0x12, 0x34, 0x56, 0xff, 0xd9);
  return Uint8Array.from(out);
}

function crc32(bytes: readonly number[]): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: readonly number[]): number[] {
  const body = [...Array.from(type, (c) => c.charCodeAt(0)), ...data];
  const crc = crc32(body);
  const len = data.length;
  return [(len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff, ...body, (crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff];
}

/** A PNG of `width`×`height` with an optional `eXIf` chunk. The IDAT is a token; the chunk CRCs are real. */
export function png(options: { exif?: Uint8Array; width?: number; height?: number } = {}): Uint8Array {
  const w = options.width ?? 2;
  const h = options.height ?? 2;
  const ihdr = [(w >>> 24) & 0xff, (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff, (h >>> 24) & 0xff, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff, 8, 6, 0, 0, 0];
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...pngChunk('IHDR', ihdr),
    ...(options.exif === undefined ? [] : pngChunk('eXIf', [...options.exif])),
    ...pngChunk('IDAT', [0x78, 0x9c, 0x01, 0x02, 0x03]),
    ...pngChunk('IEND', []),
  ]);
}

/** Whether a PNG's chunk CRCs all match their contents. */
export function pngCrcsValid(bytes: Uint8Array): boolean {
  let at = 8;
  while (at + 12 <= bytes.length) {
    const len = ((bytes[at]! << 24) >>> 0) + (bytes[at + 1]! << 16) + (bytes[at + 2]! << 8) + bytes[at + 3]!;
    const crc = ((bytes[at + 8 + len]! << 24) >>> 0) + (bytes[at + 9 + len]! << 16) + (bytes[at + 10 + len]! << 8) + bytes[at + 11 + len]!;
    if (crc32([...bytes.subarray(at + 4, at + 8 + len)]) !== crc) return false;
    at += 12 + len;
  }
  return at === bytes.length;
}

/** A VP8X WebP of `width`×`height` with an `EXIF` chunk, and optionally an `XMP ` chunk naming a GPS property. */
export function webp(options: { exif?: Uint8Array; width?: number; height?: number; xmpGps?: boolean } = {}): Uint8Array {
  const w = (options.width ?? 100) - 1;
  const h = (options.height ?? 50) - 1;
  const chunk = (type: string, data: readonly number[]): number[] => {
    const len = data.length;
    return [...Array.from(type, (c) => c.charCodeAt(0)), len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >>> 24) & 0xff, ...data, ...(len % 2 === 1 ? [0] : [])];
  };
  const flags = (options.exif === undefined ? 0 : 0x08) | (options.xmpGps === true ? 0x04 : 0);
  const body = [
    ...Array.from('WEBP', (c) => c.charCodeAt(0)),
    ...chunk('VP8X', [flags, 0, 0, 0, w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff]),
    ...chunk('VP8L', [0x2f, 0, 0, 0, 0]),
    ...(options.exif === undefined ? [] : chunk('EXIF', [...options.exif])),
    ...(options.xmpGps === true ? chunk('XMP ', Array.from('<x:xmpmeta exif:GPSLongitude="7,10E"/>', (c) => c.charCodeAt(0))) : []),
  ];
  const size = body.length;
  return Uint8Array.from([0x52, 0x49, 0x46, 0x46, size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >>> 24) & 0xff, ...body]);
}

/** Whether `needle` occurs anywhere in `bytes`. */
export function contains(bytes: Uint8Array, needle: string): boolean {
  const codes = Array.from(needle, (c) => c.charCodeAt(0));
  outer: for (let at = 0; at + codes.length <= bytes.length; at += 1) {
    for (let k = 0; k < codes.length; k += 1) if (bytes[at + k] !== codes[k]) continue outer;
    return true;
  }
  return false;
}
