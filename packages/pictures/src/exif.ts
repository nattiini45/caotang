/**
 * The import's metadata strip (pictures.md §6.4 step 4, decision D2): the GPS location, the maker notes and the serial numbers
 * leave a picture **losslessly**, by rewriting its metadata segment, never by re-encoding the pixels. The Orientation tag and
 * the colour profile stay, so a phone photo still stands the right way up and keeps its colours.
 *
 * Where the metadata sits, per format:
 *
 * - JPEG: the `Exif` APP1 segment. An XMP APP1 segment that names a GPS property is dropped whole.
 * - PNG: the `eXIf` chunk (its CRC is recomputed). An XMP `iTXt` chunk that names a GPS property is dropped whole.
 * - WebP: the `EXIF` chunk. An `XMP ` chunk that names a GPS property is dropped, and the RIFF size and the VP8X flag follow.
 *
 * Inside the EXIF block (a TIFF structure) the GPS IFD's pointer is taken out of IFD0 and every byte of the GPS IFD and its
 * values is zeroed; the maker note and the serial-number tags are taken out of their IFD the same way, their values zeroed.
 * Offsets elsewhere in the block do not move, which is what keeps the rewrite safe for readers that follow them. An EXIF block
 * this code cannot walk is dropped whole: the location is the one thing that must not survive, and an unreadable block is
 * one no reader can take the Orientation from either.
 */

/** What the strip took out, in words the import's report can use. */
export type StrippedPart = 'location' | 'maker notes' | 'serial numbers' | 'unreadable metadata';

export interface StripResult {
  readonly bytes: Uint8Array;
  readonly removed: readonly StrippedPart[];
}

const TAG_GPS_IFD = 0x8825;
const TAG_EXIF_IFD = 0x8769;
const TAG_MAKER_NOTE = 0x927c;
const TAG_BODY_SERIAL = 0xa431;
const TAG_LENS_SERIAL = 0xa435;
const TAG_CAMERA_SERIAL = 0xc62f;

/** Bytes per value of each TIFF field type (1 BYTE … 13 IFD). */
const TYPE_SIZES: Readonly<Record<number, number>> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };

class Malformed extends Error {}

/** A TIFF block, edited in place. */
class Tiff {
  private readonly little: boolean;

  constructor(private readonly bytes: Uint8Array) {
    if (bytes.length < 8) throw new Malformed('short');
    const order = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0);
    if (order !== 'II' && order !== 'MM') throw new Malformed('byte order');
    this.little = order === 'II';
    if (this.u16(2) !== 42) throw new Malformed('magic');
  }

  u16(at: number): number {
    if (at < 0 || at + 2 > this.bytes.length) throw new Malformed('u16 out of range');
    const a = this.bytes[at] ?? 0;
    const b = this.bytes[at + 1] ?? 0;
    return this.little ? a | (b << 8) : (a << 8) | b;
  }

  u32(at: number): number {
    if (at < 0 || at + 4 > this.bytes.length) throw new Malformed('u32 out of range');
    const b = [this.bytes[at] ?? 0, this.bytes[at + 1] ?? 0, this.bytes[at + 2] ?? 0, this.bytes[at + 3] ?? 0];
    return this.little ? ((b[3]! << 24) >>> 0) + (b[2]! << 16) + (b[1]! << 8) + b[0]! : ((b[0]! << 24) >>> 0) + (b[1]! << 16) + (b[2]! << 8) + b[3]!;
  }

  private setU16(at: number, value: number): void {
    if (this.little) {
      this.bytes[at] = value & 0xff;
      this.bytes[at + 1] = (value >> 8) & 0xff;
    } else {
      this.bytes[at] = (value >> 8) & 0xff;
      this.bytes[at + 1] = value & 0xff;
    }
  }

  private zero(from: number, length: number): void {
    const start = Math.max(0, from);
    const end = Math.min(this.bytes.length, from + length);
    if (end > start) this.bytes.fill(0, start, end);
  }

  ifd0(): number {
    return this.u32(4);
  }

  /** The entries of the IFD at `offset`: tag, value-or-offset position, and the byte length of the value. */
  entries(offset: number): { tag: number; at: number; valueBytes: number }[] {
    const count = this.u16(offset);
    if (offset + 2 + count * 12 + 4 > this.bytes.length) throw new Malformed('IFD out of range');
    const out: { tag: number; at: number; valueBytes: number }[] = [];
    for (let index = 0; index < count; index += 1) {
      const at = offset + 2 + index * 12;
      const type = this.u16(at + 2);
      const n = this.u32(at + 4);
      out.push({ tag: this.u16(at), at, valueBytes: (TYPE_SIZES[type] ?? 1) * n });
    }
    return out;
  }

  pointer(offset: number, tag: number): number | undefined {
    const entry = this.entries(offset).find((candidate) => candidate.tag === tag);
    return entry === undefined ? undefined : this.u32(entry.at + 8);
  }

  /** Zeroes an entry's value when it lives outside the entry, then takes the entry out of the IFD, shifting the rest left. */
  removeEntry(offset: number, tag: number): boolean {
    const entries = this.entries(offset);
    const index = entries.findIndex((entry) => entry.tag === tag);
    const entry = entries[index];
    if (entry === undefined) return false;
    if (entry.valueBytes > 4) this.zero(this.u32(entry.at + 8), entry.valueBytes);
    const count = entries.length;
    const tailStart = entry.at + 12;
    const tailEnd = offset + 2 + count * 12 + 4; // the following entries and the next-IFD offset
    this.bytes.copyWithin(entry.at, tailStart, tailEnd);
    this.zero(tailEnd - 12, 12);
    this.setU16(offset, count - 1);
    return true;
  }

  /** Zeroes a whole IFD: its entries, its out-of-line values and its next-IFD offset. */
  zeroIfd(offset: number): void {
    const entries = this.entries(offset);
    for (const entry of entries) if (entry.valueBytes > 4) this.zero(this.u32(entry.at + 8), entry.valueBytes);
    this.zero(offset, 2 + entries.length * 12 + 4);
  }
}

/** Scrubs one TIFF block in place. Throws `Malformed` when the block cannot be walked. */
function scrubTiff(block: Uint8Array): StrippedPart[] {
  const tiff = new Tiff(block);
  const removed = new Set<StrippedPart>();
  const ifd0 = tiff.ifd0();
  const gps = tiff.pointer(ifd0, TAG_GPS_IFD);
  if (gps !== undefined) {
    // A pointer that leads nowhere readable is still removed; its target is zeroed only when it can be walked.
    try {
      tiff.zeroIfd(gps);
    } catch (error) {
      if (!(error instanceof Malformed)) throw error;
    }
    tiff.removeEntry(ifd0, TAG_GPS_IFD);
    removed.add('location');
  }
  if (tiff.removeEntry(ifd0, TAG_CAMERA_SERIAL)) removed.add('serial numbers');
  const exif = tiff.pointer(ifd0, TAG_EXIF_IFD);
  if (exif !== undefined) {
    if (tiff.removeEntry(exif, TAG_MAKER_NOTE)) removed.add('maker notes');
    if (tiff.removeEntry(exif, TAG_BODY_SERIAL)) removed.add('serial numbers');
    if (tiff.removeEntry(exif, TAG_LENS_SERIAL)) removed.add('serial numbers');
  }
  return [...removed];
}

const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
const XMP_JPEG_HEADER = 'http://ns.adobe.com/xap/1.0/\0';

function hasPrefix(bytes: Uint8Array, prefix: readonly number[], at = 0): boolean {
  return prefix.every((byte, index) => bytes[at + index] === byte);
}

function latin1(bytes: Uint8Array): string {
  let out = '';
  for (let at = 0; at < bytes.length; at += 8192) out += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return out;
}

/** Whether an XMP packet names a GPS property (`exif:GPSLatitude` and its kin). */
function xmpHasLocation(bytes: Uint8Array): boolean {
  return /GPS(Latitude|Longitude|Altitude|Position|DestLatitude|DestLongitude|Coordinates)/i.test(latin1(bytes));
}

/** Scrubs a TIFF block that may carry the `Exif\0\0` header in front, in place; `undefined` means drop the block. */
function scrubExifPayload(payload: Uint8Array): StrippedPart[] | undefined {
  const start = hasPrefix(payload, EXIF_HEADER) ? EXIF_HEADER.length : 0;
  try {
    return scrubTiff(payload.subarray(start));
  } catch (error) {
    if (error instanceof Malformed) return undefined;
    throw error;
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function stripJpeg(input: Uint8Array): StripResult {
  const bytes = input.slice();
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  const removed = new Set<StrippedPart>();
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) break;
    const marker = bytes[at + 1] ?? 0;
    // Start of scan or end of image: everything after is image data, copied as is.
    if (marker === 0xda || marker === 0xd9) break;
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) {
      parts.push(bytes.subarray(at, at + 2));
      at += 2;
      continue;
    }
    const length = ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0);
    const end = at + 2 + length;
    if (length < 2 || end > bytes.length) break;
    const segment = bytes.subarray(at, end);
    const payload = bytes.subarray(at + 4, end);
    if (marker === 0xe1 && hasPrefix(payload, EXIF_HEADER)) {
      const stripped = scrubExifPayload(payload);
      if (stripped === undefined) removed.add('unreadable metadata');
      else {
        for (const part of stripped) removed.add(part);
        parts.push(segment);
      }
    } else if (marker === 0xe1 && latin1(payload.subarray(0, XMP_JPEG_HEADER.length)) === XMP_JPEG_HEADER && xmpHasLocation(payload)) {
      removed.add('location');
    } else {
      parts.push(segment);
    }
    at = end;
  }
  parts.push(bytes.subarray(at));
  return removed.size === 0 ? { bytes: input, removed: [] } : { bytes: concat(parts), removed: [...removed] };
}

let crcTable: Uint32Array | undefined;

function crc32(bytes: Uint8Array): number {
  if (crcTable === undefined) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function writeU32be(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = (value >>> 24) & 0xff;
  bytes[at + 1] = (value >>> 16) & 0xff;
  bytes[at + 2] = (value >>> 8) & 0xff;
  bytes[at + 3] = value & 0xff;
}

function stripPng(input: Uint8Array): StripResult {
  const bytes = input.slice();
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  const removed = new Set<StrippedPart>();
  let at = 8;
  while (at + 12 <= bytes.length) {
    const length = (((bytes[at] ?? 0) << 24) >>> 0) + ((bytes[at + 1] ?? 0) << 16) + ((bytes[at + 2] ?? 0) << 8) + (bytes[at + 3] ?? 0);
    const end = at + 12 + length;
    if (end > bytes.length) break;
    const type = latin1(bytes.subarray(at + 4, at + 8));
    const chunk = bytes.subarray(at, end);
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'eXIf') {
      const stripped = scrubExifPayload(data);
      if (stripped === undefined) removed.add('unreadable metadata');
      else {
        for (const part of stripped) removed.add(part);
        if (stripped.length > 0) writeU32be(bytes, at + 8 + length, crc32(bytes.subarray(at + 4, at + 8 + length)));
        parts.push(chunk);
      }
    } else if (type === 'iTXt' && latin1(data.subarray(0, 17)) === 'XML:com.adobe.xmp' && xmpHasLocation(data)) {
      removed.add('location');
    } else {
      parts.push(chunk);
    }
    at = end;
    if (type === 'IEND') break;
  }
  parts.push(bytes.subarray(at));
  return removed.size === 0 ? { bytes: input, removed: [] } : { bytes: concat(parts), removed: [...removed] };
}

function stripWebp(input: Uint8Array): StripResult {
  const bytes = input.slice();
  const parts: Uint8Array[] = [bytes.subarray(0, 12)];
  const removed = new Set<StrippedPart>();
  let dropped = false;
  let vp8xFlagsAt: number | undefined;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const type = latin1(bytes.subarray(at, at + 4));
    const length = (bytes[at + 4] ?? 0) | ((bytes[at + 5] ?? 0) << 8) | ((bytes[at + 6] ?? 0) << 16) | (((bytes[at + 7] ?? 0) << 24) >>> 0);
    const end = Math.min(bytes.length, at + 8 + length + (length % 2));
    const chunk = bytes.subarray(at, end);
    const data = bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + length));
    if (type === 'VP8X') vp8xFlagsAt = at + 8;
    if (type === 'EXIF') {
      const stripped = scrubExifPayload(data);
      if (stripped === undefined) {
        removed.add('unreadable metadata');
        dropped = true;
        if (vp8xFlagsAt !== undefined) bytes[vp8xFlagsAt] = (bytes[vp8xFlagsAt] ?? 0) & ~0x08;
      } else {
        for (const part of stripped) removed.add(part);
        parts.push(chunk);
      }
    } else if (type === 'XMP ' && xmpHasLocation(data)) {
      removed.add('location');
      dropped = true;
      if (vp8xFlagsAt !== undefined) bytes[vp8xFlagsAt] = (bytes[vp8xFlagsAt] ?? 0) & ~0x04;
    } else {
      parts.push(chunk);
    }
    at = end;
  }
  if (removed.size === 0) return { bytes: input, removed: [] };
  const out = concat(parts);
  if (dropped) {
    const riffSize = out.length - 8;
    out[4] = riffSize & 0xff;
    out[5] = (riffSize >>> 8) & 0xff;
    out[6] = (riffSize >>> 16) & 0xff;
    out[7] = (riffSize >>> 24) & 0xff;
  }
  return { bytes: out, removed: [...removed] };
}

/**
 * Takes the GPS location, the maker notes and the serial numbers out of a PNG, JPEG or WebP file, losslessly. A file with
 * none of them comes back as the same bytes (the same array), so the caller can tell nothing changed.
 */
export function stripPrivateMetadata(bytes: Uint8Array, format: 'png' | 'jpeg' | 'webp'): StripResult {
  if (format === 'jpeg') return stripJpeg(bytes);
  if (format === 'png') return stripPng(bytes);
  return stripWebp(bytes);
}

/** The EXIF Orientation (1–8) a JPEG states, or `undefined`. Exposed for the tests that pin the strip keeps it. */
export function jpegOrientation(bytes: Uint8Array): number | undefined {
  let at = 2;
  while (at + 4 <= bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xda || marker === 0xd9) return undefined;
    const length = ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0);
    const payload = bytes.subarray(at + 4, at + 2 + length);
    if (marker === 0xe1 && hasPrefix(payload, EXIF_HEADER)) {
      try {
        const tiff = new Tiff(payload.subarray(EXIF_HEADER.length));
        const entry = tiff.entries(tiff.ifd0()).find((candidate) => candidate.tag === 0x0112);
        return entry === undefined ? undefined : tiff.u16(entry.at + 8);
      } catch {
        return undefined;
      }
    }
    at += 2 + length;
  }
  return undefined;
}

/** Whether a JPEG's EXIF block still holds a GPS IFD pointer. Exposed for the tests. */
export function jpegHasGps(bytes: Uint8Array): boolean {
  let at = 2;
  while (at + 4 <= bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xda || marker === 0xd9) return false;
    const length = ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0);
    const payload = bytes.subarray(at + 4, at + 2 + length);
    if (marker === 0xe1 && hasPrefix(payload, EXIF_HEADER)) {
      try {
        const tiff = new Tiff(payload.subarray(EXIF_HEADER.length));
        return tiff.pointer(tiff.ifd0(), TAG_GPS_IFD) !== undefined;
      } catch {
        return false;
      }
    }
    at += 2 + length;
  }
  return false;
}
