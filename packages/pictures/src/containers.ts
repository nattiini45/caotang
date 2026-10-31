/**
 * Structural walkers for the three picture containers. They read headers and chunk tables only, never
 * pixel data, and every loop advances by at least the size of the header it just read, so hostile
 * input ends the walk with a refusal instead of looping.
 */

import { ascii, startsWith, u16, u32 } from './bytes.js';

export interface Segment {
  /** JPEG: the marker byte. PNG and WebP: the four-character chunk type. */
  readonly type: number | string;
  /** Offset of the first byte of the segment or chunk header. */
  readonly start: number;
  /** First and one-past-last byte of the payload. */
  readonly dataStart: number;
  readonly dataEnd: number;
  /** One past the last byte the segment or chunk occupies, padding included. */
  readonly end: number;
}

export type WalkResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface JpegWalk {
  readonly segments: readonly Segment[];
  /** Offset of the SOS marker that starts the entropy-coded data, or of EOI. */
  readonly scanStart: number;
}

export function walkJpeg(bytes: Uint8Array): WalkResult<JpegWalk> {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return { ok: false, message: 'the file does not start like a JPEG' };
  const segments: Segment[] = [];
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) return { ok: false, message: 'the JPEG has data where a marker should be' };
    while (bytes[i] === 0xff) i += 1;
    if (i >= bytes.length) break;
    const marker = bytes[i] ?? 0;
    const start = i - 1;
    i += 1;
    if (marker === 0xd9 || marker === 0xda) return { ok: true, value: { segments, scanStart: start } };
    if (marker === 0x00) return { ok: false, message: 'the JPEG has an invalid marker' };
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (i + 2 > bytes.length) return { ok: false, message: 'the JPEG ends inside a segment header' };
    const length = u16(bytes, i, false);
    if (length < 2 || i + length > bytes.length) return { ok: false, message: 'a JPEG segment is longer than the file' };
    segments.push({ type: marker, start, dataStart: i + 2, dataEnd: i + length, end: i + length });
    i += length;
  }
  return { ok: false, message: 'the JPEG ends before its image data' };
}

export interface PngWalk {
  readonly chunks: readonly Segment[];
}

export function walkPng(bytes: Uint8Array): WalkResult<PngWalk> {
  if (!startsWith(bytes, PNG_SIGNATURE)) return { ok: false, message: 'the file does not start like a PNG' };
  const chunks: Segment[] = [];
  let i = 8;
  while (i < bytes.length) {
    if (i + 12 > bytes.length) return { ok: false, message: 'the PNG ends inside a chunk header' };
    const length = u32(bytes, i, false);
    const end = i + 12 + length;
    if (length > 0x7fffffff || end > bytes.length) return { ok: false, message: 'a PNG chunk is longer than the file' };
    const type = ascii(bytes, i + 4, 4);
    chunks.push({ type, start: i, dataStart: i + 8, dataEnd: i + 8 + length, end });
    i = end;
    if (type === 'IEND') break;
  }
  return { ok: true, value: { chunks } };
}

export interface WebpWalk {
  readonly chunks: readonly Segment[];
  /** One past the last byte the RIFF size declares. */
  readonly riffEnd: number;
}

export function walkWebp(bytes: Uint8Array): WalkResult<WebpWalk> {
  if (!startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) || !startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return { ok: false, message: 'the file does not start like a WebP' };
  }
  const riffEnd = 8 + u32(bytes, 4, true);
  if (riffEnd > bytes.length || riffEnd < 12) return { ok: false, message: 'the WebP size field does not match the file' };
  const chunks: Segment[] = [];
  let i = 12;
  while (i < riffEnd) {
    if (i + 8 > riffEnd) return { ok: false, message: 'the WebP ends inside a chunk header' };
    const size = u32(bytes, i + 4, true);
    const dataEnd = i + 8 + size;
    if (dataEnd > riffEnd) return { ok: false, message: 'a WebP chunk is longer than the file' };
    const end = Math.min(dataEnd + (size & 1), riffEnd);
    chunks.push({ type: ascii(bytes, i, 4), start: i, dataStart: i + 8, dataEnd, end });
    i = end;
  }
  return { ok: true, value: { chunks, riffEnd } };
}
