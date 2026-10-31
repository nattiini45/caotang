/**
 * A picture's EXIF Orientation, read from its metadata without decoding it — pictures.md §6.4.
 *
 * The orientation decides the display size a record keeps (a phone photo stored on its side is shown upright). The TIFF block is
 * found in a JPEG's `Exif` APP1 segment, a PNG's `eXIf` chunk or a WebP's `EXIF` chunk, and read with the same TIFF reader the
 * import's metadata strip uses (`tiff.ts`). The strip itself is `exif.ts`'s, the one every import runs.
 *
 * Hostile input is the normal case: nothing here throws, and metadata that cannot be walked has no orientation.
 */

import { startsWith } from './bytes.js';
import { walkJpeg, walkPng, walkWebp } from './containers.js';
import type { PictureMime } from './model.js';
import { EXIF_HEADER, Tiff } from './tiff.js';

export type Orientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

const TAG_ORIENTATION = 0x0112;

/** The orientations that turn a picture on its side (EXIF 5–8): its displayed width is its encoded height, and the other way round. */
export function isSideways(orientation: number | undefined): boolean {
  return orientation !== undefined && orientation >= 5 && orientation <= 8;
}

/**
 * The size a picture is shown at, from the size its file encodes and its EXIF orientation (pictures.md §2.1). A record keeps the
 * encoded size, as an import reads it from the header, and the orientation beside it; every layout that places the picture reads the
 * display size through this, so a phone photo stored on its side is laid out portrait. An absent orientation is 1 (upright).
 */
export function displaySize(size: { readonly width: number; readonly height: number }, orientation?: number): { width: number; height: number } {
  return isSideways(orientation) ? { width: size.height, height: size.width } : { width: size.width, height: size.height };
}

/** {@link displaySize} for a record: `undefined` when the record states no size. */
export function displaySizeOf(record: { readonly width?: number; readonly height?: number; readonly orientation?: number }): { width: number; height: number } | undefined {
  if (record.width === undefined || record.height === undefined) return undefined;
  return displaySize({ width: record.width, height: record.height }, record.orientation);
}

/** The orientation a record stores: 2–8, or `undefined` for upright (1) and for none, so an upright picture's record is unchanged. */
export function recordOrientation(orientation: number | undefined): RecordOrientation | undefined {
  return orientation !== undefined && Number.isInteger(orientation) && orientation >= 2 && orientation <= 8 ? (orientation as RecordOrientation) : undefined;
}

/** An orientation a record keeps: every value but upright, which is stored as absence. */
export type RecordOrientation = Exclude<Orientation, 1>;

/** The TIFF blocks a picture's metadata holds. */
function tiffBlocks(bytes: Uint8Array, mime: PictureMime): Uint8Array[] {
  const tiffs: Uint8Array[] = [];
  if (mime === 'image/jpeg') {
    const walked = walkJpeg(bytes);
    if (!walked.ok) return tiffs;
    for (const seg of walked.value.segments) {
      if (seg.type === 0xe1 && startsWith(bytes, EXIF_HEADER, seg.dataStart)) tiffs.push(bytes.subarray(seg.dataStart + EXIF_HEADER.length, seg.dataEnd));
    }
  } else if (mime === 'image/png') {
    const walked = walkPng(bytes);
    if (!walked.ok) return tiffs;
    for (const chunk of walked.value.chunks) if (chunk.type === 'eXIf') tiffs.push(bytes.subarray(chunk.dataStart, chunk.dataEnd));
  } else {
    const walked = walkWebp(bytes);
    if (!walked.ok) return tiffs;
    for (const chunk of walked.value.chunks) {
      if (chunk.type !== 'EXIF') continue;
      const prefix = startsWith(bytes, EXIF_HEADER, chunk.dataStart) ? EXIF_HEADER.length : 0;
      tiffs.push(bytes.subarray(chunk.dataStart + prefix, chunk.dataEnd));
    }
  }
  return tiffs;
}

/** The EXIF Orientation of a picture (1–8), or `undefined` when it has none or its metadata is unreadable. */
export function readOrientation(bytes: Uint8Array, mime: PictureMime): Orientation | undefined {
  for (const block of tiffBlocks(bytes, mime)) {
    try {
      const tiff = new Tiff(block);
      const entry = tiff.entries(tiff.ifd0()).find((candidate) => candidate.tag === TAG_ORIENTATION);
      if (entry === undefined) continue;
      const value = tiff.u16(entry.at + 8);
      if (value >= 1 && value <= 8) return value as Orientation;
    } catch {
      // An unreadable block states no orientation; the next one may.
    }
  }
  return undefined;
}
