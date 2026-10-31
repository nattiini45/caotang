/**
 * The TIFF reader under the metadata strip (`exif.ts`), and the two reads the app and the tests make of a JPEG's EXIF block:
 * its Orientation and whether it still names a GPS IFD. Kept apart from the strip so the app's first load carries only these
 * reads; the strip and the import pipeline load with the first import (`@caotang/pictures/prepare`).
 */

export const TAG_GPS_IFD = 0x8825;
export const TAG_EXIF_IFD = 0x8769;
export const TAG_MAKER_NOTE = 0x927c;
export const TAG_BODY_SERIAL = 0xa431;
export const TAG_LENS_SERIAL = 0xa435;
export const TAG_CAMERA_SERIAL = 0xc62f;

/** Bytes per value of each TIFF field type (1 BYTE … 13 IFD). */
const TYPE_SIZES: Readonly<Record<number, number>> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };

export class Malformed extends Error {}

/** A TIFF block, read. The strip's editor (`exif.ts`) extends it. */
export class Tiff {
  protected readonly little: boolean;

  constructor(protected readonly bytes: Uint8Array) {
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
}

export const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"

export function hasPrefix(bytes: Uint8Array, prefix: readonly number[], at = 0): boolean {
  return prefix.every((byte, index) => bytes[at + index] === byte);
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
