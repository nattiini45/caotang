/**
 * Privacy stripping without re-encoding — pictures.md §6.4 step 4.
 *
 * The GPS IFD, maker notes and serial-number tags are removed from the EXIF block of a JPEG (APP1),
 * a PNG (`eXIf`) and a WebP (`EXIF`) by rewriting the TIFF structure in place: a removed entry is
 * dropped from its directory, every byte its value occupied is zeroed, and any zero tail no kept
 * entry reaches is cut off so the container's own sizes (JPEG segment length, PNG chunk length and
 * CRC, WebP chunk and RIFF sizes) are rewritten to match. Pixel data, Orientation and the ICC
 * profile are never touched. XMP and IPTC, which can carry the same facts, are cut out whole by
 * `sidecars.ts` after the EXIF pass. A file with nothing to remove is returned unchanged, byte for byte.
 *
 * Hostile input is the normal case here, so nothing throws: every offset is bounds-checked, visited
 * directories are remembered, and the number of directories, entries and zeroed bytes is capped.
 * Metadata that cannot be walked safely is refused, because the caller could not promise that the
 * location is gone.
 */

import { concatBytes, crc32, startsWith, u16, u32, writeU16, writeU32 } from './bytes.js';
import { walkJpeg, walkPng, walkWebp } from './containers.js';
import type { PictureMime } from './model.js';
import { stripSidecars } from './sidecars.js';

export type Orientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type PrivateMetadataKind = 'gps' | 'maker-note' | 'serial-number' | 'xmp' | 'iptc';

export type StripResult =
  | {
      readonly ok: true;
      /** The same array as the input when nothing was removed. */
      readonly bytes: Uint8Array;
      readonly changed: boolean;
      readonly removed: readonly PrivateMetadataKind[];
      readonly orientation?: Orientation;
    }
  | { readonly ok: false; readonly reason: 'malformed-metadata'; readonly message: string };

const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];

const TAG_GPS = 0x8825;
const TAG_EXIF_IFD = 0x8769;
const TAG_INTEROP_IFD = 0xa005;
const TAG_MAKER_NOTE = 0x927c;
const TAG_ORIENTATION = 0x0112;
const TAG_THUMB_OFFSET = 0x0201;
const TAG_THUMB_LENGTH = 0x0202;
const SERIAL_TAGS = new Set([0xa431, 0xa435, 0xc62f]);
/** Kept tags whose values are offsets this walker does not follow; their presence rules out shrinking. */
const OPAQUE_OFFSET_TAGS = new Set([0x0111, 0x0144, 0x014a]);

const MAX_IFDS = 32;
const MAX_ENTRIES = 20000;
const MAX_THUMBNAIL_DEPTH = 1;

interface Slice {
  start: number;
  end: number;
}

interface Entry {
  tag: number;
  type: number;
  count: number;
  at: number;
  blob?: Slice;
  known: boolean;
}

type IfdKind = 'ifd0' | 'exif' | 'interop' | 'ifd1' | 'gps';

interface Ifd {
  offset: number;
  kind: IfdKind;
  entries: Entry[];
  /** One past the next-IFD pointer. */
  end: number;
}

interface Forbidden {
  ifd: Ifd;
  entry: Entry;
  kind: PrivateMetadataKind;
}

interface TiffWalk {
  little: boolean;
  forbidden: Forbidden[];
  zero: Slice[];
  orientation: Orientation | undefined;
  thumbnail: Slice | undefined;
  usedEnd: number;
  shrinkUnsafe: boolean;
  ifds: Ifd[];
}

type Failable<T> = ({ ok: true } & T) | { ok: false; message: string };

function fail(message: string): { ok: false; message: string } {
  return { ok: false, message };
}

function walkTiff(tiff: Uint8Array): Failable<{ walk: TiffWalk }> {
  const length = tiff.length;
  if (length < 8) return fail('the EXIF block is too short');
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  const big = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!little && !big) return fail('the EXIF block has no byte-order mark');
  if (u16(tiff, 2, little) !== 42) return fail('the EXIF block has a bad header');
  const first = u32(tiff, 4, little);
  if (first < 8 || first + 2 > length) return fail('the EXIF directory starts outside the block');

  const walk: TiffWalk = {
    little,
    forbidden: [],
    zero: [],
    orientation: undefined,
    thumbnail: undefined,
    usedEnd: 8,
    shrinkUnsafe: false,
    ifds: [],
  };
  const queue: { offset: number; kind: IfdKind }[] = [{ offset: first, kind: 'ifd0' }];
  const visited = new Set<number>();
  let totalEntries = 0;
  let thumbOffset: number | undefined;
  let thumbLength: number | undefined;

  for (let q = 0; q < queue.length; q += 1) {
    const item = queue[q];
    if (item === undefined) break;
    const { offset, kind } = item;
    if (visited.has(offset)) return fail('the EXIF directories loop back on themselves');
    visited.add(offset);
    if (visited.size > MAX_IFDS) return fail('the EXIF block has too many directories');
    if (offset < 8 || offset + 2 > length) return fail('an EXIF directory starts outside the block');
    const count = u16(tiff, offset, little);
    const end = offset + 2 + count * 12 + 4;
    if (end > length) return fail('an EXIF directory runs past the end of the block');
    totalEntries += count;
    if (totalEntries > MAX_ENTRIES) return fail('the EXIF block has too many entries');

    const ifd: Ifd = { offset, kind, entries: [], end };
    walk.ifds.push(ifd);
    if (kind === 'gps') walk.zero.push({ start: offset, end });
    else walk.usedEnd = Math.max(walk.usedEnd, end);

    for (let k = 0; k < count; k += 1) {
      const at = offset + 2 + k * 12;
      const tag = u16(tiff, at, little);
      const type = u16(tiff, at + 2, little);
      const n = u32(tiff, at + 4, little);
      const size = TYPE_SIZE[type] ?? 0;
      const entry: Entry = { tag, type, count: n, at, known: size > 0 };
      const byteLength = size * n;
      if (size > 0 && byteLength > 4) {
        const start = u32(tiff, at + 8, little);
        if (start < 8 || start + byteLength > length) return fail('an EXIF value points outside the block');
        entry.blob = { start, end: start + byteLength };
      }
      ifd.entries.push(entry);

      if (kind === 'gps') {
        if (entry.blob !== undefined) walk.zero.push(entry.blob);
        continue;
      }

      let forbidden: PrivateMetadataKind | undefined;
      if (tag === TAG_GPS) forbidden = 'gps';
      else if (tag === TAG_MAKER_NOTE) forbidden = 'maker-note';
      else if (SERIAL_TAGS.has(tag)) forbidden = 'serial-number';

      if (forbidden !== undefined) {
        if (!entry.known) return fail('a private EXIF entry has a type this reader cannot size');
        walk.forbidden.push({ ifd, entry, kind: forbidden });
        if (entry.blob !== undefined) walk.zero.push(entry.blob);
        if (tag === TAG_GPS) {
          const target = u32(tiff, at + 8, little);
          if (type !== 4 || n !== 1 || target < 8 || target + 2 > length) return fail('the GPS directory pointer is invalid');
          queue.push({ offset: target, kind: 'gps' });
        }
        continue;
      }

      if (entry.blob !== undefined) walk.usedEnd = Math.max(walk.usedEnd, entry.blob.end);
      if (!entry.known || OPAQUE_OFFSET_TAGS.has(tag)) walk.shrinkUnsafe = true;

      if (tag === TAG_EXIF_IFD || tag === TAG_INTEROP_IFD) {
        if (type !== 4 || n !== 1) return fail('an EXIF directory pointer is invalid');
        queue.push({ offset: u32(tiff, at + 8, little), kind: tag === TAG_EXIF_IFD ? 'exif' : 'interop' });
      } else if (tag === TAG_ORIENTATION && kind === 'ifd0' && type === 3 && n === 1 && walk.orientation === undefined) {
        const value = u16(tiff, at + 8, little);
        if (value >= 1 && value <= 8) walk.orientation = value as Orientation;
      } else if (kind === 'ifd1' && type === 4 && n === 1) {
        if (tag === TAG_THUMB_OFFSET) thumbOffset = u32(tiff, at + 8, little);
        else if (tag === TAG_THUMB_LENGTH) thumbLength = u32(tiff, at + 8, little);
      }
    }

    if (kind === 'ifd0' || kind === 'ifd1') {
      const next = u32(tiff, end - 4, little);
      if (next !== 0) queue.push({ offset: next, kind: 'ifd1' });
    }
  }

  if (thumbOffset !== undefined && thumbLength !== undefined && thumbLength > 0) {
    if (thumbOffset < 8 || thumbOffset + thumbLength > length) return fail('the EXIF thumbnail points outside the block');
    walk.thumbnail = { start: thumbOffset, end: thumbOffset + thumbLength };
    walk.usedEnd = Math.max(walk.usedEnd, walk.thumbnail.end);
  }
  return { ok: true, walk };
}

interface ScrubOk {
  ok: true;
  bytes: Uint8Array;
  changed: boolean;
  removed: PrivateMetadataKind[];
  orientation: Orientation | undefined;
}

function scrubTiff(tiff: Uint8Array, shrink: boolean, depth: number): ScrubOk | { ok: false; message: string } {
  const walked = walkTiff(tiff);
  if (!walked.ok) return walked;
  const { walk } = walked;
  const removed = walk.forbidden.map((f) => f.kind);

  let thumbnail: Uint8Array | undefined;
  if (walk.thumbnail !== undefined) {
    if (depth >= MAX_THUMBNAIL_DEPTH) return fail('the EXIF thumbnail nests another thumbnail');
    const inner = stripJpeg(tiff.subarray(walk.thumbnail.start, walk.thumbnail.end), false, depth + 1);
    if (!inner.ok) return fail(`the EXIF thumbnail is not a clean JPEG: ${inner.message}`);
    if (inner.changed) {
      if (inner.bytes.length !== walk.thumbnail.end - walk.thumbnail.start) return fail('the EXIF thumbnail changed size');
      thumbnail = inner.bytes;
      for (const kind of inner.removed) removed.push(kind);
    }
  }

  if (walk.forbidden.length === 0 && thumbnail === undefined) {
    return { ok: true, bytes: tiff, changed: false, removed: [], orientation: walk.orientation };
  }

  let zeroed = 0;
  for (const slice of walk.zero) zeroed += slice.end - slice.start;
  if (zeroed > 2 * tiff.length + 1024) return fail('the EXIF block points at the same bytes too many times');

  const out = tiff.slice();
  for (const slice of walk.zero) out.fill(0, slice.start, slice.end);

  const byIfd = new Map<Ifd, Set<Entry>>();
  for (const f of walk.forbidden) {
    const set = byIfd.get(f.ifd) ?? new Set<Entry>();
    set.add(f.entry);
    byIfd.set(f.ifd, set);
  }
  for (const [ifd, drop] of byIfd) {
    const keep = ifd.entries.filter((entry) => !drop.has(entry));
    writeU16(out, ifd.offset, keep.length, walk.little);
    let at = ifd.offset + 2;
    for (const entry of keep) {
      out.set(tiff.subarray(entry.at, entry.at + 12), at);
      at += 12;
    }
    out.set(tiff.subarray(ifd.end - 4, ifd.end), at);
    at += 4;
    out.fill(0, at, ifd.end);
  }
  if (thumbnail !== undefined && walk.thumbnail !== undefined) out.set(thumbnail, walk.thumbnail.start);

  const audit = walkTiff(out);
  if (!audit.ok) return fail(`the EXIF block could not be cleaned safely: ${audit.message}`);
  if (audit.walk.forbidden.length > 0 || audit.walk.orientation !== walk.orientation) {
    return fail('the EXIF block overlaps itself and could not be cleaned safely');
  }

  let result = out;
  if (shrink && !audit.walk.shrinkUnsafe) {
    let last = out.length;
    while (last > 0 && out[last - 1] === 0) last -= 1;
    const end = Math.max(audit.walk.usedEnd, last, 8);
    if (end < out.length) result = out.slice(0, end);
  }
  return { ok: true, bytes: result, changed: true, removed, orientation: walk.orientation };
}

type Stripped = ScrubOk | { ok: false; message: string };

function stripJpeg(bytes: Uint8Array, shrink: boolean, depth: number): Stripped {
  const walked = walkJpeg(bytes);
  if (!walked.ok) return fail(walked.message);
  const parts: Uint8Array[] = [];
  let copyFrom = 0;
  const removed: PrivateMetadataKind[] = [];
  let orientation: Orientation | undefined;
  let changed = false;
  for (const seg of walked.value.segments) {
    if (seg.type !== 0xe1 || seg.dataEnd - seg.dataStart < EXIF_HEADER.length || !startsWith(bytes, EXIF_HEADER, seg.dataStart)) continue;
    const result = scrubTiff(bytes.subarray(seg.dataStart + EXIF_HEADER.length, seg.dataEnd), shrink, depth);
    if (!result.ok) return result;
    orientation ??= result.orientation;
    if (!result.changed) continue;
    const length = 2 + EXIF_HEADER.length + result.bytes.length;
    if (length > 0xffff) return fail('the cleaned EXIF segment is too long');
    const segment = new Uint8Array(2 + length);
    segment[0] = 0xff;
    segment[1] = 0xe1;
    writeU16(segment, 2, length, false);
    segment.set(EXIF_HEADER, 4);
    segment.set(result.bytes, 4 + EXIF_HEADER.length);
    parts.push(bytes.subarray(copyFrom, seg.start), segment);
    copyFrom = seg.end;
    changed = true;
    for (const kind of result.removed) removed.push(kind);
  }
  if (!changed) return { ok: true, bytes, changed: false, removed: [], orientation };
  parts.push(bytes.subarray(copyFrom));
  return { ok: true, bytes: concatBytes(parts), changed: true, removed, orientation };
}

function stripPng(bytes: Uint8Array, shrink: boolean): Stripped {
  const walked = walkPng(bytes);
  if (!walked.ok) return fail(walked.message);
  const parts: Uint8Array[] = [];
  let copyFrom = 0;
  const removed: PrivateMetadataKind[] = [];
  let orientation: Orientation | undefined;
  let changed = false;
  for (const chunk of walked.value.chunks) {
    if (chunk.type !== 'eXIf') continue;
    const result = scrubTiff(bytes.subarray(chunk.dataStart, chunk.dataEnd), shrink, 0);
    if (!result.ok) return result;
    orientation ??= result.orientation;
    if (!result.changed) continue;
    const out = new Uint8Array(12 + result.bytes.length);
    writeU32(out, 0, result.bytes.length, false);
    out.set([0x65, 0x58, 0x49, 0x66], 4);
    out.set(result.bytes, 8);
    writeU32(out, 8 + result.bytes.length, crc32(out.subarray(4, 8 + result.bytes.length)), false);
    parts.push(bytes.subarray(copyFrom, chunk.start), out);
    copyFrom = chunk.end;
    changed = true;
    for (const kind of result.removed) removed.push(kind);
  }
  if (!changed) return { ok: true, bytes, changed: false, removed: [], orientation };
  parts.push(bytes.subarray(copyFrom));
  return { ok: true, bytes: concatBytes(parts), changed: true, removed, orientation };
}

function stripWebp(bytes: Uint8Array, shrink: boolean): Stripped {
  const walked = walkWebp(bytes);
  if (!walked.ok) return fail(walked.message);
  const parts: Uint8Array[] = [];
  let copyFrom = 0;
  let delta = 0;
  const removed: PrivateMetadataKind[] = [];
  let orientation: Orientation | undefined;
  let changed = false;
  for (const chunk of walked.value.chunks) {
    if (chunk.type !== 'EXIF') continue;
    const prefix = startsWith(bytes, EXIF_HEADER, chunk.dataStart) ? EXIF_HEADER.length : 0;
    const result = scrubTiff(bytes.subarray(chunk.dataStart + prefix, chunk.dataEnd), shrink, 0);
    if (!result.ok) return result;
    orientation ??= result.orientation;
    if (!result.changed) continue;
    const size = prefix + result.bytes.length;
    const out = new Uint8Array(8 + size + (size & 1));
    out.set([0x45, 0x58, 0x49, 0x46], 0);
    writeU32(out, 4, size, true);
    out.set(EXIF_HEADER.slice(0, prefix), 8);
    out.set(result.bytes, 8 + prefix);
    parts.push(bytes.subarray(copyFrom, chunk.start), out);
    delta += out.length - (chunk.end - chunk.start);
    copyFrom = chunk.end;
    changed = true;
    for (const kind of result.removed) removed.push(kind);
  }
  if (!changed) return { ok: true, bytes, changed: false, removed: [], orientation };
  parts.push(bytes.subarray(copyFrom));
  const joined = concatBytes(parts);
  writeU32(joined, 4, u32(bytes, 4, true) + delta, true);
  return { ok: true, bytes: joined, changed: true, removed, orientation };
}

/**
 * Removes GPS, maker notes and serial numbers from a picture's EXIF block without decoding or
 * re-encoding it. `shrink: false` keeps every size as it was (the removed bytes become zeros).
 */
export function stripPrivateMetadata(bytes: Uint8Array, mime: PictureMime, options: { shrink?: boolean } = {}): StripResult {
  const shrink = options.shrink ?? true;
  const result = mime === 'image/jpeg' ? stripJpeg(bytes, shrink, 0) : mime === 'image/png' ? stripPng(bytes, shrink) : stripWebp(bytes, shrink);
  const refused = (message: string): StripResult => ({
    ok: false,
    reason: 'malformed-metadata',
    message: `The picture's metadata could not be read safely, so it was not imported: ${message}.`,
  });
  if (!result.ok) return refused(result.message);
  const sidecars = stripSidecars(result.bytes, mime);
  if (!sidecars.ok) return refused(sidecars.message);
  return {
    ok: true,
    bytes: sidecars.bytes,
    changed: result.changed || sidecars.removed.length > 0,
    removed: [...result.removed, ...sidecars.removed],
    ...(result.orientation === undefined ? {} : { orientation: result.orientation }),
  };
}

/** The EXIF Orientation of a picture (1–8), or `undefined` when it has none or its metadata is unreadable. */
export function readOrientation(bytes: Uint8Array, mime: PictureMime): Orientation | undefined {
  const tiffs: Uint8Array[] = [];
  if (mime === 'image/jpeg') {
    const walked = walkJpeg(bytes);
    if (!walked.ok) return undefined;
    for (const seg of walked.value.segments) {
      if (seg.type === 0xe1 && startsWith(bytes, EXIF_HEADER, seg.dataStart)) tiffs.push(bytes.subarray(seg.dataStart + EXIF_HEADER.length, seg.dataEnd));
    }
  } else if (mime === 'image/png') {
    const walked = walkPng(bytes);
    if (!walked.ok) return undefined;
    for (const chunk of walked.value.chunks) if (chunk.type === 'eXIf') tiffs.push(bytes.subarray(chunk.dataStart, chunk.dataEnd));
  } else {
    const walked = walkWebp(bytes);
    if (!walked.ok) return undefined;
    for (const chunk of walked.value.chunks) {
      if (chunk.type !== 'EXIF') continue;
      const prefix = startsWith(bytes, EXIF_HEADER, chunk.dataStart) ? EXIF_HEADER.length : 0;
      tiffs.push(bytes.subarray(chunk.dataStart + prefix, chunk.dataEnd));
    }
  }
  for (const tiff of tiffs) {
    const walked = walkTiff(tiff);
    if (walked.ok && walked.walk.orientation !== undefined) return walked.walk.orientation;
  }
  return undefined;
}
