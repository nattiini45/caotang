/**
 * Colour profiles for the Node picture transcoder: find the ICC profile a picture carries and, when it is not sRGB, convert the
 * pixels to sRGB so the bytes written are what they claim to be (the writer's JPEG and PNG carry no profile of their own).
 *
 * What is converted: grey profiles and RGB matrix/TRC profiles (Display P3, Adobe RGB, ProPhoto, most camera and monitor profiles),
 * through XYZ at the D50 connection space, relative colorimetric, out-of-gamut colours clipped. What is refused, never guessed:
 * a CMYK profile, a lookup-table RGB profile that does not call itself sRGB, and a profile that cannot be read. A profile whose
 * description names sRGB, or whose primaries and curves match sRGB, is left as it is. Pure TypeScript; no codec.
 */

import { inflateSync } from 'node:zlib';

import { PictureRefusal } from '@caotang/pictures';

const MAX_PROFILE_BYTES = 8 * 1024 * 1024;

function u16(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
}

function u32(bytes: Uint8Array, at: number): number {
  return (((bytes[at] ?? 0) << 24) | ((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0)) >>> 0;
}

function s15Fixed16(bytes: Uint8Array, at: number): number {
  return (u32(bytes, at) | 0) / 65536;
}

function fourcc(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0);
}

/** The ICC profile a JPEG carries in APP2 segments, joined in sequence order. */
export function iccOfJpeg(bytes: Uint8Array): Uint8Array | undefined {
  const parts = new Map<number, Uint8Array>();
  let count = 0;
  let at = 2;
  while (at + 4 <= bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    const length = u16(bytes, at + 2);
    if (length < 2 || at + 2 + length > bytes.length) break;
    // "ICC_PROFILE\0", the chunk's number and the number of chunks, then the data.
    if (marker === 0xe2 && length >= 16 && fourcc(bytes, at + 4) === 'ICC_' && fourcc(bytes, at + 8) === 'PROF') {
      parts.set(bytes[at + 16] ?? 0, bytes.subarray(at + 18, at + 2 + length));
      count = bytes[at + 17] ?? 0;
    }
    at += 2 + length;
  }
  if (parts.size === 0 || parts.size !== count) return undefined;
  const chunks: Uint8Array[] = [];
  for (let n = 1; n <= count; n += 1) {
    const part = parts.get(n);
    if (part === undefined) return undefined;
    chunks.push(part);
  }
  const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let to = 0;
  for (const chunk of chunks) {
    out.set(chunk, to);
    to += chunk.length;
  }
  return out;
}

/** The ICC profile of a WebP, from its `ICCP` chunk. */
export function iccOfWebp(bytes: Uint8Array): Uint8Array | undefined {
  let at = 12;
  while (at + 8 <= bytes.length) {
    const size = (bytes[at + 4] ?? 0) | ((bytes[at + 5] ?? 0) << 8) | ((bytes[at + 6] ?? 0) << 16) | ((bytes[at + 7] ?? 0) << 24);
    if (size < 0 || at + 8 + size > bytes.length) return undefined;
    if (fourcc(bytes, at) === 'ICCP') return bytes.subarray(at + 8, at + 8 + size);
    at += 8 + size + (size & 1);
  }
  return undefined;
}

/** The profile in a PNG `iCCP` chunk: a name, a NUL, a method byte (0), then the zlib-compressed profile. */
export function iccOfPngChunk(data: Uint8Array): Uint8Array | undefined {
  const nul = data.indexOf(0);
  if (nul < 1 || nul > 80 || data[nul + 1] !== 0) return undefined;
  try {
    return new Uint8Array(inflateSync(data.subarray(nul + 2), { maxOutputLength: MAX_PROFILE_BYTES }));
  } catch {
    return undefined;
  }
}

/** Linear sRGB from XYZ at the D50 connection space (Bradford-adapted, Lindbloom). */
const XYZ_D50_TO_SRGB = [3.1338561, -1.6168667, -0.4906146, -0.9787684, 1.9161415, 0.033454, 0.0719453, -0.2289914, 1.4052427] as const;

function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

const ENCODE_STEPS = 16384;
let encodeTable: Uint8Array | undefined;

/** Linear light in 0..1 to an sRGB byte, through a table: the per-pixel cost stays a lookup. */
function srgbByte(linear: number): number {
  if (encodeTable === undefined) {
    const table = new Uint8Array(ENCODE_STEPS + 1);
    for (let i = 0; i <= ENCODE_STEPS; i += 1) {
      const l = i / ENCODE_STEPS;
      table[i] = Math.round((l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055) * 255);
    }
    encodeTable = table;
  }
  return encodeTable[linear <= 0 ? 0 : linear >= 1 ? ENCODE_STEPS : Math.round(linear * ENCODE_STEPS)] ?? 0;
}

interface Tags {
  readonly bytes: Uint8Array;
  readonly find: (signature: string) => { offset: number; size: number } | undefined;
}

function readTags(bytes: Uint8Array): Tags | undefined {
  if (bytes.length < 132 || bytes.length > MAX_PROFILE_BYTES || fourcc(bytes, 36) !== 'acsp') return undefined;
  const count = u32(bytes, 128);
  if (count > 200 || 132 + count * 12 > bytes.length) return undefined;
  const tags = new Map<string, { offset: number; size: number }>();
  for (let i = 0; i < count; i += 1) {
    const at = 132 + i * 12;
    const offset = u32(bytes, at + 4);
    const size = u32(bytes, at + 8);
    if (offset + size > bytes.length || size < 8) return undefined;
    tags.set(fourcc(bytes, at), { offset, size });
  }
  return { bytes, find: (signature) => tags.get(signature) };
}

/** The profile's description, for the one question asked of it: does it call itself sRGB. */
function describes(tags: Tags, text: string): boolean {
  const tag = tags.find('desc');
  if (tag === undefined) return false;
  const body = tags.bytes.subarray(tag.offset, tag.offset + tag.size);
  let ascii = '';
  for (const byte of body) ascii += byte === 0 ? '' : String.fromCharCode(byte);
  return ascii.toLowerCase().includes(text.toLowerCase());
}

function xyzOf(tags: Tags, signature: string): readonly [number, number, number] | undefined {
  const tag = tags.find(signature);
  if (tag === undefined || tag.size < 20 || fourcc(tags.bytes, tag.offset) !== 'XYZ ') return undefined;
  return [s15Fixed16(tags.bytes, tag.offset + 8), s15Fixed16(tags.bytes, tag.offset + 12), s15Fixed16(tags.bytes, tag.offset + 16)];
}

/** A tone curve as 256 linear values, one per 8-bit input. */
function curveOf(tags: Tags, signature: string): Float32Array | undefined {
  const tag = tags.find(signature);
  if (tag === undefined) return undefined;
  const { bytes } = tags;
  const at = tag.offset;
  const type = fourcc(bytes, at);
  const table = new Float32Array(256);
  if (type === 'curv') {
    const count = u32(bytes, at + 8);
    if (12 + count * 2 > tag.size) return undefined;
    for (let i = 0; i < 256; i += 1) {
      const x = i / 255;
      if (count === 0) table[i] = x;
      else if (count === 1) table[i] = x ** (u16(bytes, at + 12) / 256);
      else {
        const position = x * (count - 1);
        const low = Math.floor(position);
        const high = Math.min(count - 1, low + 1);
        const a = u16(bytes, at + 12 + low * 2) / 65535;
        const b = u16(bytes, at + 12 + high * 2) / 65535;
        table[i] = a + (b - a) * (position - low);
      }
    }
    return table;
  }
  if (type === 'para') {
    const kind = u16(bytes, at + 8);
    const counts = [1, 3, 4, 5, 7];
    const needed = counts[kind];
    if (needed === undefined || 12 + needed * 4 > tag.size) return undefined;
    const p = (n: number): number => s15Fixed16(bytes, at + 12 + n * 4);
    const g = p(0);
    for (let i = 0; i < 256; i += 1) {
      const x = i / 255;
      let y: number;
      if (kind === 0) y = x ** g;
      else {
        const a = p(1);
        const b = p(2);
        if (kind === 1) y = x >= -b / a ? (a * x + b) ** g : 0;
        else if (kind === 2) y = x >= -b / a ? (a * x + b) ** g + p(3) : p(3);
        else if (kind === 3) y = x >= p(4) ? (a * x + b) ** g : p(3) * x;
        else y = x >= p(4) ? (a * x + b) ** g + p(5) : p(3) * x + p(6);
      }
      table[i] = Number.isFinite(y) ? Math.min(1, Math.max(0, y)) : 0;
    }
    return table;
  }
  return undefined;
}

/** What a picture's pixels need, in place, to become sRGB; `undefined` from {@link srgbConversionFor} means nothing. */
export type SrgbConversion = (rgba: Uint8Array) => void;

function refuse(reason: string): PictureRefusal {
  return new PictureRefusal('unsupported-colour', reason, 'Export the picture as sRGB from the program that made it.');
}

/**
 * The conversion to sRGB that a profile calls for: `undefined` when the pixels already are sRGB (no profile, or one that is),
 * a function that converts RGBA bytes in place, or a {@link PictureRefusal} when the profile cannot be converted here.
 */
export function srgbConversionFor(profile: Uint8Array | undefined): SrgbConversion | undefined {
  if (profile === undefined) return undefined;
  const tags = readTags(profile);
  if (tags === undefined) throw refuse('The picture carries a colour profile that could not be read, so its colours cannot be made sRGB.');
  const space = fourcc(profile, 16);
  if (describes(tags, 'srgb')) return undefined;
  if (space === 'GRAY') {
    const curve = curveOf(tags, 'kTRC');
    if (curve === undefined) throw refuse('The picture carries a grey colour profile that could not be read, so its colours cannot be made sRGB.');
    const lut = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) lut[i] = srgbByte(curve[i] ?? 0);
    if (lut.every((v, i) => Math.abs(v - i) <= 1)) return undefined;
    return (rgba) => {
      for (let at = 0; at < rgba.length; at += 4) {
        const v = lut[rgba[at] ?? 0] ?? 0;
        rgba[at] = v;
        rgba[at + 1] = v;
        rgba[at + 2] = v;
      }
    };
  }
  if (space !== 'RGB ') throw refuse(`The picture carries a ${space.trim()} colour profile, which cannot be converted to sRGB here.`);
  if (fourcc(profile, 20) !== 'XYZ ') throw refuse('The picture carries a colour profile this host cannot convert to sRGB.');
  const r = xyzOf(tags, 'rXYZ');
  const g = xyzOf(tags, 'gXYZ');
  const b = xyzOf(tags, 'bXYZ');
  const rc = curveOf(tags, 'rTRC');
  const gc = curveOf(tags, 'gTRC');
  const bc = curveOf(tags, 'bTRC');
  if (r === undefined || g === undefined || b === undefined || rc === undefined || gc === undefined || bc === undefined) {
    throw refuse('The picture carries a lookup-table colour profile, which cannot be converted to sRGB here.');
  }
  // Linear source RGB to XYZ, then XYZ to linear sRGB: one 3 x 3 matrix.
  const toXyz = [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]];
  const m = new Float64Array(9);
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      let sum = 0;
      for (let k = 0; k < 3; k += 1) sum += (XYZ_D50_TO_SRGB[row * 3 + k] ?? 0) * (toXyz[k * 3 + col] ?? 0);
      m[row * 3 + col] = sum;
    }
  }
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const matrixIsSrgb = identity.every((v, i) => Math.abs((m[i] ?? 0) - v) < 0.004);
  const curvesAreSrgb = [rc, gc, bc].every((curve) => curve.every((v, i) => Math.abs(v - srgbToLinear(i / 255)) < 0.004));
  if (matrixIsSrgb && curvesAreSrgb) return undefined;
  return (rgba) => {
    for (let at = 0; at < rgba.length; at += 4) {
      const lr = rc[rgba[at] ?? 0] ?? 0;
      const lg = gc[rgba[at + 1] ?? 0] ?? 0;
      const lb = bc[rgba[at + 2] ?? 0] ?? 0;
      rgba[at] = srgbByte((m[0] ?? 0) * lr + (m[1] ?? 0) * lg + (m[2] ?? 0) * lb);
      rgba[at + 1] = srgbByte((m[3] ?? 0) * lr + (m[4] ?? 0) * lg + (m[5] ?? 0) * lb);
      rgba[at + 2] = srgbByte((m[6] ?? 0) * lr + (m[7] ?? 0) * lg + (m[8] ?? 0) * lb);
    }
  };
}
