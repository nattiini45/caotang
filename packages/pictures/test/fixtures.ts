/**
 * Tiny synthetic pictures for the metadata and header tests. They are structurally valid containers
 * (PNG with a real deflate stream and CRCs; JPEG and WebP with correct segment and chunk tables)
 * carrying an EXIF block built here, so a test can plant GPS, a maker note and a serial number and
 * look for them in the bytes afterwards.
 */

import { deflateSync, inflateSync } from 'node:zlib';

import { ascii, concatBytes, crc32, u16, u32, writeU16, writeU32 } from '../src/bytes.js';
import { walkPng, walkWebp } from '../src/containers.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

export const SECRETS = {
  gps: 'GPS-PROCESSING-SECRET',
  maker: 'MAKERNOTE-SECRET-BLOB',
  serial: 'SN-0042-BODY',
  kept: '2024:05:06 07:08:09',
} as const;

interface RawEntry {
  tag: number;
  type: number;
  count: number;
  data?: Uint8Array;
  /** An IFD name or blob key whose offset becomes this LONG value. */
  ptr?: string;
  /** Placed after every other blob, so removing it leaves a zero tail. */
  late?: boolean;
}

export interface TiffSpec {
  order?: 'II' | 'MM';
  orientation?: number;
  gps?: boolean;
  makerNote?: boolean;
  serial?: boolean;
  thumbnail?: Uint8Array;
  /** Place the maker note before the other blobs, so zeroing it leaves a hole and no tail. */
  makerNoteFirst?: boolean;
  /** Replaces the GPS processing-method text (same length), so two photos can differ only in location. */
  gpsText?: string;
}

export function buildTiff(spec: TiffSpec = {}): Uint8Array {
  const little = (spec.order ?? 'II') === 'II';
  const s16 = (n: number): Uint8Array => {
    const a = new Uint8Array(2);
    writeU16(a, 0, n, little);
    return a;
  };
  const s32 = (n: number): Uint8Array => {
    const a = new Uint8Array(4);
    writeU32(a, 0, n, little);
    return a;
  };
  const rationals = (pairs: number[][]): Uint8Array => concatBytes(pairs.flatMap(([n, d]) => [s32(n ?? 0), s32(d ?? 1)]));
  const ascii0 = (s: string): Uint8Array => concatBytes([enc(s), new Uint8Array(1)]);

  const ifds: Record<string, RawEntry[]> = {};
  ifds['ifd0'] = [
    { tag: 0x010f, type: 2, count: 8, data: ascii0('TestCam') },
    { tag: 0x0112, type: 3, count: 1, data: s16(spec.orientation ?? 1) },
    { tag: 0x8769, type: 4, count: 1, ptr: 'exif' },
    ...(spec.gps === false ? [] : [{ tag: 0x8825, type: 4, count: 1, ptr: 'gps' }]),
  ];
  const exif: RawEntry[] = [
    { tag: 0x9003, type: 2, count: SECRETS.kept.length + 1, data: ascii0(SECRETS.kept) },
    { tag: 0xa001, type: 3, count: 1, data: s16(1) },
  ];
  if (spec.serial !== false) exif.push({ tag: 0xa431, type: 2, count: SECRETS.serial.length + 1, data: ascii0(SECRETS.serial) });
  if (spec.makerNote !== false) {
    const note = enc(SECRETS.maker);
    exif.push({ tag: 0x927c, type: 7, count: note.length, data: note, late: spec.makerNoteFirst !== true });
  }
  ifds['exif'] = exif;
  if (spec.gps !== false) {
    ifds['gps'] = [
      { tag: 0x0001, type: 2, count: 2, data: ascii0('N') },
      { tag: 0x0002, type: 5, count: 3, data: rationals([[51, 1], [30, 1], [1234, 100]]) },
      { tag: 0x001b, type: 7, count: SECRETS.gps.length, data: enc(spec.gpsText ?? SECRETS.gps) },
    ];
  }
  if (spec.thumbnail !== undefined) {
    ifds['ifd1'] = [
      { tag: 0x0201, type: 4, count: 1, ptr: 'thumb' },
      { tag: 0x0202, type: 4, count: 1, data: s32(spec.thumbnail.length) },
    ];
  }

  const names = ['ifd0', 'exif', 'gps', 'ifd1'].filter((n) => ifds[n] !== undefined);
  const offsets = new Map<string, number>();
  let cursor = 8;
  for (const name of names) {
    offsets.set(name, cursor);
    cursor += 2 + (ifds[name]?.length ?? 0) * 12 + 4;
  }
  const blobAt = new Map<RawEntry, number>();
  const blobList: { entry: RawEntry; data: Uint8Array }[] = [];
  for (const name of names) {
    for (const entry of ifds[name] ?? []) {
      if (entry.data !== undefined && entry.data.length > 4) blobList.push({ entry, data: entry.data });
    }
  }
  const ordered = [...blobList.filter((b) => b.entry.late !== true), ...blobList.filter((b) => b.entry.late === true)];
  const nonLate = ordered.filter((b) => b.entry.late !== true);
  const late = ordered.filter((b) => b.entry.late === true);
  const layout: { data: Uint8Array; entry?: RawEntry; key?: string }[] = [
    ...nonLate,
    ...(spec.thumbnail !== undefined ? [{ data: spec.thumbnail, key: 'thumb' }] : []),
    ...late,
  ];
  for (const item of layout) {
    if (cursor % 2 === 1) cursor += 1;
    if (item.entry !== undefined) blobAt.set(item.entry, cursor);
    if (item.key !== undefined) offsets.set(item.key, cursor);
    cursor += item.data.length;
  }

  const out = new Uint8Array(cursor);
  out.set(enc(little ? 'II' : 'MM'), 0);
  writeU16(out, 2, 42, little);
  writeU32(out, 4, 8, little);
  for (const name of names) {
    const entries = ifds[name] ?? [];
    const base = offsets.get(name) ?? 0;
    writeU16(out, base, entries.length, little);
    entries.forEach((entry, k) => {
      const at = base + 2 + k * 12;
      writeU16(out, at, entry.tag, little);
      writeU16(out, at + 2, entry.type, little);
      writeU32(out, at + 4, entry.count, little);
      if (entry.ptr !== undefined) writeU32(out, at + 8, offsets.get(entry.ptr) ?? 0, little);
      else if (entry.data !== undefined && entry.data.length <= 4) out.set(entry.data, at + 8);
      else if (entry.data !== undefined) writeU32(out, at + 8, blobAt.get(entry) ?? 0, little);
    });
    const next = name === 'ifd0' && offsets.has('ifd1') ? (offsets.get('ifd1') ?? 0) : 0;
    writeU32(out, base + 2 + entries.length * 12, next, little);
  }
  for (const item of layout) {
    const at = item.entry !== undefined ? blobAt.get(item.entry) : offsets.get(item.key ?? '');
    if (at !== undefined) out.set(item.data, at);
  }
  return out;
}

/** The tags present in each directory of a TIFF block, read independently of the code under test. */
export function listTags(tiff: Uint8Array): { all: Set<number>; orientation?: number } {
  const little = tiff[0] === 0x49;
  const all = new Set<number>();
  let orientation: number | undefined;
  const seen = new Set<number>();
  const visit = (offset: number, top: boolean): void => {
    if (seen.has(offset) || offset + 2 > tiff.length) return;
    seen.add(offset);
    const count = u16(tiff, offset, little);
    for (let k = 0; k < count; k += 1) {
      const at = offset + 2 + k * 12;
      if (at + 12 > tiff.length) return;
      const tag = u16(tiff, at, little);
      all.add(tag);
      if (top && tag === 0x0112) orientation = u16(tiff, at + 8, little);
      if (tag === 0x8769 || tag === 0x8825 || tag === 0xa005) visit(u32(tiff, at + 8, little), false);
    }
    if (top) {
      const next = u32(tiff, offset + 2 + count * 12, little);
      if (next !== 0) visit(next, false);
    }
  };
  visit(u32(tiff, 4, little), true);
  return { all, ...(orientation === undefined ? {} : { orientation }) };
}

export function containsBytes(haystack: Uint8Array, needle: string): boolean {
  const n = enc(needle);
  outer: for (let i = 0; i + n.length <= haystack.length; i += 1) {
    for (let j = 0; j < n.length; j += 1) if (haystack[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
}

export const EXIF_HEADER = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0]);

export interface JpegSpec {
  tiff?: Uint8Array;
  width?: number;
  height?: number;
  icc?: boolean;
}

export const JPEG_SCAN = new Uint8Array([0x12, 0x34, 0xff, 0x00, 0x56, 0x78, 0x9a]);
export const ICC_PAYLOAD = enc('ICC_PROFILE\0\x01\x01FAKE-ICC-DATA');

export function jpegSegment(marker: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  out[0] = 0xff;
  out[1] = marker;
  writeU16(out, 2, payload.length + 2, false);
  out.set(payload, 4);
  return out;
}

export function buildJpeg(spec: JpegSpec = {}): Uint8Array {
  const sof = new Uint8Array([8, 0, 0, 0, 0, 1, 1, 0x11, 0]);
  writeU16(sof, 1, spec.height ?? 4, false);
  writeU16(sof, 3, spec.width ?? 6, false);
  return concatBytes([
    new Uint8Array([0xff, 0xd8]),
    jpegSegment(0xe0, enc('JFIF\0\x01\x01\0\0\x01\0\x01\0\0')),
    ...(spec.tiff === undefined ? [] : [jpegSegment(0xe1, concatBytes([EXIF_HEADER, spec.tiff]))]),
    ...(spec.icc === true ? [jpegSegment(0xe2, ICC_PAYLOAD)] : []),
    jpegSegment(0xc0, sof),
    jpegSegment(0xda, new Uint8Array([1, 1, 0, 0, 0x3f, 0])),
    JPEG_SCAN,
    new Uint8Array([0xff, 0xd9]),
  ]);
}

export interface PngSpec {
  tiff?: Uint8Array;
  width?: number;
  height?: number;
  /** Gray 8-bit, every sample 0xFF. */
  white?: boolean;
  icc?: boolean;
}

export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  writeU32(out, 0, data.length, false);
  out.set(enc(type), 4);
  out.set(data, 8);
  writeU32(out, 8 + data.length, crc32(out.subarray(4, 8 + data.length)), false);
  return out;
}

export function buildPng(spec: PngSpec = {}): Uint8Array {
  const width = spec.width ?? 8;
  const height = spec.height ?? 8;
  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, width, false);
  writeU32(ihdr, 4, height, false);
  ihdr.set([8, 0, 0, 0, 0], 8);
  const rows = new Uint8Array(height * (1 + width));
  for (let y = 0; y < height; y += 1) rows.fill(spec.white === false ? 0x40 : 0xff, y * (1 + width) + 1, (y + 1) * (1 + width));
  return concatBytes([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    ...(spec.icc === true ? [pngChunk('iCCP', concatBytes([enc('icc\0'), new Uint8Array([0]), deflateSync(enc('fake-profile'))]))] : []),
    ...(spec.tiff === undefined ? [] : [pngChunk('eXIf', spec.tiff)]),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

/** Every chunk CRC must match and the pixels must inflate to the expected uniform sample. Returns a reason, or undefined when valid. */
export function pngProblem(bytes: Uint8Array, expectSample: number): string | undefined {
  const walked = walkPng(bytes);
  if (!walked.ok) return walked.message;
  const idat: Uint8Array[] = [];
  for (const chunk of walked.value.chunks) {
    const want = u32(bytes, chunk.end - 4, false);
    if (crc32(bytes.subarray(chunk.start + 4, chunk.end - 4)) !== want) return `bad CRC on ${String(chunk.type)}`;
    if (chunk.type === 'IDAT') idat.push(bytes.subarray(chunk.dataStart, chunk.dataEnd));
  }
  const width = u32(bytes, 16, false);
  const height = u32(bytes, 20, false);
  const raw = inflateSync(concatBytes(idat));
  if (raw.length !== height * (1 + width)) return 'wrong pixel byte count';
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) if (raw[y * (1 + width) + 1 + x] !== expectSample) return 'pixels changed';
  }
  return undefined;
}

export type WebpKind = 'vp8' | 'vp8l' | 'vp8x';

export interface WebpSpec {
  tiff?: Uint8Array;
  width?: number;
  height?: number;
  kind?: WebpKind;
  icc?: boolean;
}

export const WEBP_IMAGE_PAYLOAD = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);

export function riffChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.length + (data.length & 1));
  out.set(enc(type), 0);
  writeU32(out, 4, data.length, true);
  out.set(data, 8);
  return out;
}

export function buildWebp(spec: WebpSpec = {}): Uint8Array {
  const width = spec.width ?? 6;
  const height = spec.height ?? 4;
  const kind = spec.kind ?? 'vp8x';
  const chunks: Uint8Array[] = [];
  const vp8l = new Uint8Array(5 + WEBP_IMAGE_PAYLOAD.length);
  vp8l[0] = 0x2f;
  writeU32(vp8l, 1, ((height - 1) << 14) | (width - 1), true);
  vp8l.set(WEBP_IMAGE_PAYLOAD, 5);
  if (kind === 'vp8x') {
    const flags = (spec.tiff !== undefined ? 0x08 : 0) | (spec.icc === true ? 0x20 : 0);
    const head = new Uint8Array(10);
    head[0] = flags;
    head[4] = (width - 1) & 0xff;
    head[5] = ((width - 1) >> 8) & 0xff;
    head[6] = ((width - 1) >> 16) & 0xff;
    head[7] = (height - 1) & 0xff;
    head[8] = ((height - 1) >> 8) & 0xff;
    head[9] = ((height - 1) >> 16) & 0xff;
    chunks.push(riffChunk('VP8X', head));
    if (spec.icc === true) chunks.push(riffChunk('ICCP', enc('FAKE-ICC-DATA!')));
    chunks.push(riffChunk('VP8L', vp8l));
  } else if (kind === 'vp8l') {
    chunks.push(riffChunk('VP8L', vp8l));
  } else {
    const frame = new Uint8Array(10 + WEBP_IMAGE_PAYLOAD.length);
    frame.set([0x10, 0, 0, 0x9d, 0x01, 0x2a], 0);
    writeU16(frame, 6, width, true);
    writeU16(frame, 8, height, true);
    frame.set(WEBP_IMAGE_PAYLOAD, 10);
    chunks.push(riffChunk('VP8 ', frame));
  }
  if (spec.tiff !== undefined) chunks.push(riffChunk('EXIF', spec.tiff));
  const body = concatBytes(chunks);
  const out = new Uint8Array(12 + body.length);
  out.set(enc('RIFF'), 0);
  writeU32(out, 4, 4 + body.length, true);
  out.set(enc('WEBP'), 8);
  out.set(body, 12);
  return out;
}

/** The RIFF size must equal the file length minus 8, and chunks must tile the file exactly. */
export function webpProblem(bytes: Uint8Array): string | undefined {
  if (u32(bytes, 4, true) !== bytes.length - 8) return 'RIFF size does not match the file';
  if (bytes.length % 2 === 1) return 'odd file length';
  const walked = walkWebp(bytes);
  if (!walked.ok) return walked.message;
  let at = 12;
  for (const chunk of walked.value.chunks) {
    if (chunk.start !== at) return 'chunks do not tile the file';
    at = chunk.end;
  }
  return at === bytes.length ? undefined : 'trailing bytes after the last chunk';
}

/** The payload of the first chunk or segment of a given type, for byte-for-byte comparisons of what must not change. */
export function exifOf(bytes: Uint8Array, container: 'jpeg' | 'png' | 'webp'): Uint8Array | undefined {
  if (container === 'jpeg') {
    for (let i = 2; i + 10 < bytes.length; i += 1) {
      if (bytes[i] === 0xff && bytes[i + 1] === 0xe1 && ascii(bytes, i + 4, 4) === 'Exif') {
        return bytes.subarray(i + 10, i + 2 + u16(bytes, i + 2, false));
      }
    }
    return undefined;
  }
  if (container === 'png') {
    const walked = walkPng(bytes);
    const chunk = walked.ok ? walked.value.chunks.find((c) => c.type === 'eXIf') : undefined;
    return chunk === undefined ? undefined : bytes.subarray(chunk.dataStart, chunk.dataEnd);
  }
  const walked = walkWebp(bytes);
  const chunk = walked.ok ? walked.value.chunks.find((c) => c.type === 'EXIF') : undefined;
  return chunk === undefined ? undefined : bytes.subarray(chunk.dataStart, chunk.dataEnd);
}
