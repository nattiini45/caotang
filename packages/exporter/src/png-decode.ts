/**
 * A PNG decoder for the Node picture transcoder: every colour type and bit depth, Adam7 interlacing and `tRNS` transparency, to
 * straight 8-bit RGBA. The caller has read the header and refused an oversize picture; this still checks every chunk's length and
 * CRC and the inflated size, so a damaged file is refused and never half-read. Node only (`node:zlib`).
 */

import { crc32, inflateSync } from 'node:zlib';

import { iccOfPngChunk } from './icc-srgb.js';

export interface DecodedPng {
  readonly width: number;
  readonly height: number;
  /** Straight RGBA, 8 bits a channel. */
  readonly data: Uint8Array;
  readonly profile?: Uint8Array;
  /** The file says it is sRGB (an `sRGB` chunk), so a stray profile or none changes nothing. */
  readonly srgb: boolean;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
/** Adam7: x start, y start, x step, y step. */
const PASSES = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;

function u32(bytes: Uint8Array, at: number): number {
  return (((bytes[at] ?? 0) << 24) | ((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0)) >>> 0;
}

function bad(why: string): Error {
  return new Error(`the PNG is damaged: ${why}`);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Undoes the row filter in place; `previous` is the already unfiltered row above, or zeros. */
function unfilter(type: number, row: Uint8Array, previous: Uint8Array, bpp: number): void {
  for (let i = 0; i < row.length; i += 1) {
    const left = i >= bpp ? (row[i - bpp] ?? 0) : 0;
    const up = previous[i] ?? 0;
    const upLeft = i >= bpp ? (previous[i - bpp] ?? 0) : 0;
    const raw = row[i] ?? 0;
    if (type === 1) row[i] = raw + left;
    else if (type === 2) row[i] = raw + up;
    else if (type === 3) row[i] = raw + ((left + up) >> 1);
    else if (type === 4) row[i] = raw + paeth(left, up, upLeft);
  }
}

export function decodePng(bytes: Uint8Array): DecodedPng {
  if (bytes.length < 45 || !SIGNATURE.every((b, i) => bytes[i] === b)) throw bad('it does not start with the PNG signature');
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = -1;
  let interlace = 0;
  let palette: Uint8Array | undefined;
  let trns: Uint8Array | undefined;
  let profile: Uint8Array | undefined;
  let srgb = false;
  let seenHeader = false;
  let ended = false;
  const idat: Uint8Array[] = [];
  let at = 8;
  while (at + 12 <= bytes.length && !ended) {
    const length = u32(bytes, at);
    const type = String.fromCharCode(bytes[at + 4] ?? 0, bytes[at + 5] ?? 0, bytes[at + 6] ?? 0, bytes[at + 7] ?? 0);
    if (length > 0x7fffffff || at + 12 + length > bytes.length) throw bad('a chunk runs past the end of the file');
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (crc32(bytes.subarray(at + 4, at + 8 + length)) !== u32(bytes, at + 8 + length)) throw bad(`the ${type} chunk fails its checksum`);
    if (type === 'IHDR') {
      if (length !== 13 || seenHeader) throw bad('the header is wrong');
      seenHeader = true;
      width = u32(data, 0);
      height = u32(data, 4);
      depth = data[8] ?? 0;
      colorType = data[9] ?? -1;
      interlace = data[12] ?? 0;
      if (width < 1 || height < 1 || DEPTHS[colorType]?.includes(depth) !== true || data[10] !== 0 || data[11] !== 0 || interlace > 1) {
        throw bad('its header describes a picture that cannot exist');
      }
    } else if (!seenHeader) throw bad('the header is not first');
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'sRGB') srgb = true;
    else if (type === 'iCCP') profile = iccOfPngChunk(data) ?? profile;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') ended = true;
    at += 12 + length;
  }
  if (!seenHeader || !ended || idat.length === 0) throw bad('it is cut short');
  if (colorType === 3 && (palette === undefined || palette.length === 0 || palette.length % 3 !== 0)) throw bad('its palette is missing');

  const channels = CHANNELS[colorType] ?? 1;
  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const rowBytes = (w: number): number => Math.ceil((w * bitsPerPixel) / 8);
  const passes = interlace === 1 ? PASSES : ([[0, 0, 1, 1]] as const);
  const sizes = passes.map(([x0, y0, dx, dy]) => ({ x0, y0, dx, dy, w: Math.ceil((width - x0) / dx), h: Math.ceil((height - y0) / dy) }));
  const expected = sizes.reduce((sum, p) => (p.w > 0 && p.h > 0 ? sum + p.h * (1 + rowBytes(p.w)) : sum), 0);
  let raw: Uint8Array;
  try {
    const joined = new Uint8Array(idat.reduce((sum, part) => sum + part.length, 0));
    let to = 0;
    for (const part of idat) {
      joined.set(part, to);
      to += part.length;
    }
    raw = new Uint8Array(inflateSync(joined, { maxOutputLength: expected }));
  } catch {
    throw bad('its pixel data cannot be unpacked');
  }
  if (raw.length !== expected) throw bad('its pixel data is the wrong size');

  const out = new Uint8Array(width * height * 4);
  const full = (1 << Math.min(depth, 8)) - 1;
  const trnsGrey = colorType === 0 && trns !== undefined && trns.length >= 2 ? ((trns[0] ?? 0) << 8) | (trns[1] ?? 0) : -1;
  const trnsRgb = colorType === 2 && trns !== undefined && trns.length >= 6 ? [0, 2, 4].map((i) => ((trns?.[i] ?? 0) << 8) | (trns?.[i + 1] ?? 0)) : undefined;
  let cursor = 0;
  for (const pass of sizes) {
    if (pass.w < 1 || pass.h < 1) continue;
    const stride = rowBytes(pass.w);
    let previous: Uint8Array = new Uint8Array(stride);
    for (let ry = 0; ry < pass.h; ry += 1) {
      const filter = raw[cursor] ?? 0;
      if (filter > 4) throw bad('a row names a filter that does not exist');
      const row = raw.subarray(cursor + 1, cursor + 1 + stride);
      cursor += 1 + stride;
      unfilter(filter, row, previous, bpp);
      previous = row;
      let to = ((pass.y0 + ry * pass.dy) * width + pass.x0) * 4;
      const step = pass.dx * 4;
      for (let x = 0; x < pass.w; x += 1, to += step) {
        let r: number;
        let g: number;
        let b: number;
        let a = 255;
        if (depth === 16) {
          // Sixteen bits to eight, rounded, not truncated.
          const s = (i: number): number => ((row[x * channels * 2 + i * 2] ?? 0) << 8) | (row[x * channels * 2 + i * 2 + 1] ?? 0);
          const to8 = (v: number): number => Math.round((v * 255) / 65535);
          if (colorType === 0) {
            r = g = b = to8(s(0));
            if (s(0) === trnsGrey) a = 0;
          } else if (colorType === 2) {
            r = to8(s(0));
            g = to8(s(1));
            b = to8(s(2));
            if (trnsRgb !== undefined && s(0) === trnsRgb[0] && s(1) === trnsRgb[1] && s(2) === trnsRgb[2]) a = 0;
          } else if (colorType === 4) {
            r = g = b = to8(s(0));
            a = to8(s(1));
          } else {
            r = to8(s(0));
            g = to8(s(1));
            b = to8(s(2));
            a = to8(s(3));
          }
        } else if (depth === 8) {
          const i = x * channels;
          if (colorType === 0) {
            r = g = b = row[i] ?? 0;
            if (r === trnsGrey) a = 0;
          } else if (colorType === 2) {
            r = row[i] ?? 0;
            g = row[i + 1] ?? 0;
            b = row[i + 2] ?? 0;
            if (trnsRgb !== undefined && r === trnsRgb[0] && g === trnsRgb[1] && b === trnsRgb[2]) a = 0;
          } else if (colorType === 3) {
            const index = row[i] ?? 0;
            r = palette?.[index * 3] ?? 0;
            g = palette?.[index * 3 + 1] ?? 0;
            b = palette?.[index * 3 + 2] ?? 0;
            a = trns?.[index] ?? 255;
          } else if (colorType === 4) {
            r = g = b = row[i] ?? 0;
            a = row[i + 1] ?? 0;
          } else {
            r = row[i] ?? 0;
            g = row[i + 1] ?? 0;
            b = row[i + 2] ?? 0;
            a = row[i + 3] ?? 0;
          }
        } else {
          const bit = x * depth;
          const sample = ((row[bit >> 3] ?? 0) >> (8 - depth - (bit & 7))) & full;
          if (colorType === 3) {
            r = palette?.[sample * 3] ?? 0;
            g = palette?.[sample * 3 + 1] ?? 0;
            b = palette?.[sample * 3 + 2] ?? 0;
            a = trns?.[sample] ?? 255;
          } else {
            r = g = b = Math.round((sample * 255) / full);
            if (sample === trnsGrey) a = 0;
          }
        }
        out[to] = r;
        out[to + 1] = g;
        out[to + 2] = b;
        out[to + 3] = a;
      }
    }
  }
  return { width, height, data: out, ...(profile === undefined ? {} : { profile }), srgb };
}
