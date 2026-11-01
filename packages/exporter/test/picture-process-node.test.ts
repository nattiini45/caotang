/**
 * `processPictureInNode` (picture-process-node.ts) and the decoders under it: EXIF orientation 1 to 8 on a picture whose corners
 * differ, the long-edge limit and its never-upscale rule, alpha flattening, the colour profile rules, the refusals, and the PNG
 * decoder against hand-built files of every colour type, bit depth, filter and Adam7 interlacing.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { sniffPicture, readPictureHeader, type PictureBytes, type PictureProfile } from '@caotang/pictures';
import { PictureRefusal } from '@caotang/pictures';
import { decode as decodeJpeg, encode as encodeJpeg } from 'jpeg-js';
import { describe, expect, it } from 'vitest';

import { applyOrientation, flattenOnWhite, processPictureInNode } from '../src/picture-process-node.js';
import { decodePng } from '../src/png-decode.js';
import { encodePng } from '../src/png-encode.js';
import type { Pixels } from '../src/png-encode.js';
import { webpFixture } from './webp-fixtures.js';

const profile = (patch: Partial<PictureProfile> = {}): PictureProfile => ({
  maxEdge: 4096,
  output: 'png',
  jpegQuality: 0.85,
  flattenAlpha: false,
  stripMetadata: true,
  ...patch,
});

const input = (bytes: Uint8Array, mime: PictureBytes['mime'] = 'image/png'): PictureBytes => ({ bytes, mime, width: 1, height: 1 });

async function refusal(promise: Promise<unknown>): Promise<PictureRefusal> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(PictureRefusal);
  return error as PictureRefusal;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The chunk goes straight after IHDR, which is 33 bytes in. */
function withPngChunk(png: Uint8Array, type: string, data: Uint8Array): Uint8Array {
  return concat(png.subarray(0, 33), chunk(type, data), png.subarray(33));
}

function exifTiff(orientation: number): Uint8Array {
  return Uint8Array.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0, 0, 0, 0, 0]);
}

function withJpegSegment(jpeg: Uint8Array, marker: number, payload: Uint8Array): Uint8Array {
  const segment = new Uint8Array(4 + payload.length);
  segment.set([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]);
  segment.set(payload, 4);
  return concat(jpeg.subarray(0, 2), segment, jpeg.subarray(2));
}

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

type Rgb = readonly [number, number, number];
const RED: Rgb = [255, 0, 0];
const GREEN: Rgb = [0, 255, 0];
const BLUE: Rgb = [0, 0, 255];
const YELLOW: Rgb = [255, 255, 0];
const GRAY: Rgb = [128, 128, 128];

/** `columns` x `rows` blocks of `cell` pixels: red top left, green top right, blue bottom left, yellow bottom right, grey between. */
function cornerPicture(columns: number, rows: number, cell: number): Pixels {
  const width = columns * cell;
  const height = rows * cell;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const top = y < cell;
      const bottom = y >= height - cell;
      const left = x < cell;
      const right = x >= width - cell;
      const color = top && left ? RED : top && right ? GREEN : bottom && left ? BLUE : bottom && right ? YELLOW : GRAY;
      data.set([...color, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

function pixelAt(pixels: Pixels, x: number, y: number): number[] {
  const at = (y * pixels.width + x) * 4;
  return [...pixels.data.subarray(at, at + 4)];
}

/** Where each stored corner lands (top left, top right, bottom left of the stored picture) for each EXIF orientation. */
const CORNER_HOMES: Record<number, { swapped: boolean; tl: string; tr: string; bl: string }> = {
  1: { swapped: false, tl: 'TL', tr: 'TR', bl: 'BL' },
  2: { swapped: false, tl: 'TR', tr: 'TL', bl: 'BR' },
  3: { swapped: false, tl: 'BR', tr: 'BL', bl: 'TR' },
  4: { swapped: false, tl: 'BL', tr: 'BR', bl: 'TL' },
  5: { swapped: true, tl: 'TL', tr: 'BL', bl: 'TR' },
  6: { swapped: true, tl: 'TR', tr: 'BR', bl: 'TL' },
  7: { swapped: true, tl: 'BR', tr: 'TR', bl: 'BL' },
  8: { swapped: true, tl: 'BL', tr: 'TL', bl: 'BR' },
};

function cornerOf(pixels: Pixels, home: string, near = 0): number[] {
  const x = home.endsWith('L') ? near : pixels.width - 1 - near;
  const y = home.startsWith('T') ? near : pixels.height - 1 - near;
  return pixelAt(pixels, x, y);
}

function close(actual: readonly number[], expected: Rgb, tolerance: number): void {
  for (let i = 0; i < 3; i += 1) expect(Math.abs((actual[i] ?? 0) - (expected[i] ?? 0))).toBeLessThanOrEqual(tolerance);
}

function decodedJpeg(bytes: Uint8Array): Pixels {
  const image = decodeJpeg(bytes, { useTArray: true });
  return { width: image.width, height: image.height, data: image.data };
}

describe('processPictureInNode: EXIF orientation', () => {
  const stored = cornerPicture(3, 2, 8);

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('turns a PNG with orientation %i the right way up, at the display size', async (orientation) => {
    const png = withPngChunk(encodePng(stored), 'eXIf', exifTiff(orientation));
    const result = await processPictureInNode(input(png), profile());
    const home = CORNER_HOMES[orientation]!;
    expect(result.mime).toBe('image/png');
    expect([result.width, result.height]).toEqual(home.swapped ? [16, 24] : [24, 16]);
    const out = decodePng(result.bytes);
    expect([out.width, out.height]).toEqual([result.width, result.height]);
    const pixels = { width: out.width, height: out.height, data: out.data };
    expect(cornerOf(pixels, home.tl)).toEqual([...RED, 255]);
    expect(cornerOf(pixels, home.tr)).toEqual([...GREEN, 255]);
    expect(cornerOf(pixels, home.bl)).toEqual([...BLUE, 255]);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('turns a JPEG with orientation %i the right way up', async (orientation) => {
    const cell = 16;
    const picture = cornerPicture(3, 2, cell);
    const jpeg = withJpegSegment(new Uint8Array(encodeJpeg(picture, 95).data), 0xe1, concat(ascii('Exif\0\0'), exifTiff(orientation)));
    const result = await processPictureInNode(input(jpeg, 'image/jpeg'), profile({ output: 'jpeg' }));
    const home = CORNER_HOMES[orientation]!;
    expect(result.mime).toBe('image/jpeg');
    expect([result.width, result.height]).toEqual(home.swapped ? [32, 48] : [48, 32]);
    const out = decodedJpeg(result.bytes);
    expect([out.width, out.height]).toEqual([result.width, result.height]);
    close(cornerOf(out, home.tl, 6), RED, 40);
    close(cornerOf(out, home.tr, 6), GREEN, 40);
    close(cornerOf(out, home.bl, 6), BLUE, 40);
  });

  it('is its own inverse for the quarter turns (6 then 8 restores the picture)', () => {
    const picture = cornerPicture(3, 2, 2);
    const there = applyOrientation(picture, 6);
    expect([there.width, there.height]).toEqual([picture.height, picture.width]);
    expect([...applyOrientation(there, 8).data]).toEqual([...picture.data]);
  });
});

describe('processPictureInNode: size', () => {
  it('scales the longer edge to maxEdge and keeps the proportions', async () => {
    const result = await processPictureInNode(input(encodePng(cornerPicture(10, 5, 10))), profile({ maxEdge: 40 }));
    expect([result.width, result.height]).toEqual([40, 20]);
    const out = decodePng(result.bytes);
    expect([out.width, out.height]).toEqual([40, 20]);
  });

  it('measures the edge after the turn: a portrait photo stored on its side is limited by its height', async () => {
    const png = withPngChunk(encodePng(cornerPicture(10, 5, 10)), 'eXIf', exifTiff(6));
    const result = await processPictureInNode(input(png), profile({ maxEdge: 25 }));
    expect([result.width, result.height]).toEqual([13, 25]);
  });

  it('never makes a picture larger', async () => {
    const small = encodePng(cornerPicture(3, 2, 5));
    const result = await processPictureInNode(input(small), profile({ maxEdge: 4096 }));
    expect([result.width, result.height]).toEqual([15, 10]);
    const jpeg = await processPictureInNode(input(small), profile({ output: 'jpeg', maxEdge: 1600 }));
    expect([jpeg.width, jpeg.height]).toEqual([15, 10]);
  });

  it('averages when it shrinks: a picture of two halves keeps both', async () => {
    const width = 64;
    const data = new Uint8Array(width * 8 * 4);
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < width; x += 1) data.set(x < 32 ? [0, 0, 0, 255] : [255, 255, 255, 255], (y * width + x) * 4);
    }
    const result = await processPictureInNode(input(encodePng({ width, height: 8, data })), profile({ maxEdge: 8 }));
    const out = decodePng(result.bytes);
    expect(pixelAt(out, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(pixelAt(out, 7, 0)).toEqual([255, 255, 255, 255]);
  });
});

describe('processPictureInNode: alpha', () => {
  const picture: Pixels = { width: 3, height: 1, data: Uint8Array.from([200, 0, 0, 255, 255, 0, 0, 0, 0, 0, 200, 128]) };

  it('keeps transparency in a PNG when the profile does not flatten', async () => {
    const out = decodePng((await processPictureInNode(input(encodePng(picture)), profile())).bytes);
    expect(pixelAt(out, 1, 0)[3]).toBe(0);
    expect(pixelAt(out, 2, 0)[3]).toBe(128);
  });

  it('flattens onto white when the profile says so: transparent is white, half-transparent is mixed', async () => {
    const out = decodePng((await processPictureInNode(input(encodePng(picture)), profile({ flattenAlpha: true }))).bytes);
    expect(pixelAt(out, 0, 0)).toEqual([200, 0, 0, 255]);
    expect(pixelAt(out, 1, 0)).toEqual([255, 255, 255, 255]);
    const mixed = pixelAt(out, 2, 0);
    expect(mixed[3]).toBe(255);
    expect(mixed[0]).toBeGreaterThan(120);
    expect(mixed[2]).toBeGreaterThan(220);
  });

  it('always flattens for JPEG, which has no alpha', async () => {
    const result = await processPictureInNode(input(encodePng(picture)), profile({ output: 'jpeg' }));
    const out = decodedJpeg(result.bytes);
    expect(pixelAt(out, 1, 0).slice(0, 3).every((v) => v > 230)).toBe(true);
  });

  it('flattenOnWhite leaves opaque pixels exactly as they are', () => {
    const pixels = { width: 1, height: 1, data: Uint8Array.from([1, 2, 3, 255]) };
    flattenOnWhite(pixels);
    expect([...pixels.data]).toEqual([1, 2, 3, 255]);
  });
});

describe('processPictureInNode: output', () => {
  it.each([
    ['png', 'image/png'],
    ['jpeg', 'image/jpeg'],
  ] as const)('writes %s that sniffs and measures as what it is', async (output, mime) => {
    const result = await processPictureInNode(input(encodePng(cornerPicture(4, 3, 6))), profile({ output }));
    expect(result.mime).toBe(mime);
    const sniffed = sniffPicture(result.bytes);
    expect(sniffed).toMatchObject({ ok: true, mime });
    expect(readPictureHeader(result.bytes, mime)).toMatchObject({ ok: true, width: 24, height: 18, orientation: 1 });
  });

  it('turns a JPEG into a PNG and a PNG into a JPEG', async () => {
    const jpeg = new Uint8Array(encodeJpeg(cornerPicture(2, 2, 8), 90).data);
    const asPng = await processPictureInNode(input(jpeg, 'image/jpeg'), profile({ output: 'png' }));
    expect(sniffPicture(asPng.bytes)).toMatchObject({ ok: true, mime: 'image/png' });
    const asJpeg = await processPictureInNode(input(asPng.bytes), profile({ output: 'jpeg' }));
    expect(sniffPicture(asJpeg.bytes)).toMatchObject({ ok: true, mime: 'image/jpeg' });
  });

  it('a higher JPEG quality writes more bytes', async () => {
    const noisy = new Uint8Array(64 * 64 * 4);
    for (let i = 0; i < noisy.length; i += 1) noisy[i] = i % 4 === 3 ? 255 : (i * 2654435761) >>> 24;
    const png = encodePng({ width: 64, height: 64, data: noisy });
    const low = await processPictureInNode(input(png), profile({ output: 'jpeg', jpegQuality: 0.3 }));
    const high = await processPictureInNode(input(png), profile({ output: 'jpeg', jpegQuality: 0.95 }));
    expect(high.bytes.length).toBeGreaterThan(low.bytes.length);
  });

  it('carries no metadata out of a re-encode', async () => {
    const jpeg = withJpegSegment(new Uint8Array(encodeJpeg(cornerPicture(2, 2, 8), 90).data), 0xe1, concat(ascii('Exif\0\0'), exifTiff(1), ascii('SECRET-GPS')));
    const result = await processPictureInNode(input(jpeg, 'image/jpeg'), profile({ output: 'jpeg' }));
    expect(new TextDecoder('latin1').decode(result.bytes)).not.toContain('SECRET-GPS');
    expect(new TextDecoder('latin1').decode(result.bytes)).not.toContain('Exif');
  });
});

describe('processPictureInNode: preserve', () => {
  it('returns the stored bytes when there is nothing to change', async () => {
    const jpeg = new Uint8Array(encodeJpeg(cornerPicture(2, 2, 8), 90).data);
    const result = await processPictureInNode(input(jpeg, 'image/jpeg'), profile({ output: 'preserve', stripMetadata: false }));
    expect(result.bytes).toBe(jpeg);
    expect([result.width, result.height, result.mime]).toEqual([16, 16, 'image/jpeg']);
  });

  it('reports the display size of a picture stored on its side, and keeps its Orientation', async () => {
    const png = withPngChunk(encodePng(cornerPicture(3, 2, 4)), 'eXIf', exifTiff(6));
    const result = await processPictureInNode(input(png), profile({ output: 'preserve', stripMetadata: false }));
    expect([result.width, result.height]).toEqual([8, 12]);
    expect(result.bytes).toBe(png);
  });

  it('keeps a PNG a PNG when it has to shrink', async () => {
    const result = await processPictureInNode(input(encodePng(cornerPicture(10, 5, 10))), profile({ output: 'preserve', maxEdge: 50 }));
    expect([result.mime, result.width, result.height]).toEqual(['image/png', 50, 25]);
  });

  it('refuses a WebP that would have to be resized, since it cannot write WebP', async () => {
    const error = await refusal(processPictureInNode(input(webpFixture('large'), 'image/webp'), profile({ output: 'preserve', maxEdge: 100 })));
    expect(error.code).toBe('unsupported-profile');
    expect(error.remedy).toMatch(/JPEG or PNG/);
  });
});

describe('processPictureInNode: WebP', () => {
  it('decodes a still WebP and writes a JPEG or a PNG', async () => {
    const asJpeg = await processPictureInNode(input(webpFixture('lossy'), 'image/webp'), profile({ output: 'jpeg' }));
    expect([asJpeg.width, asJpeg.height]).toEqual([96, 64]);
    expect(sniffPicture(asJpeg.bytes)).toMatchObject({ ok: true, mime: 'image/jpeg' });
    const asPng = await processPictureInNode(input(webpFixture('alpha'), 'image/webp'), profile({ output: 'png' }));
    expect(decodePng(asPng.bytes).data[3]).not.toBeUndefined();
  });

  it('shrinks a large WebP to the edge', async () => {
    const result = await processPictureInNode(input(webpFixture('large'), 'image/webp'), profile({ maxEdge: 200 }));
    expect(Math.max(result.width, result.height)).toBe(200);
  });

  it('refuses an animated WebP and a corrupt one', async () => {
    expect((await refusal(processPictureInNode(input(webpFixture('animated'), 'image/webp'), profile()))).code).toBe('animated');
    expect((await refusal(processPictureInNode(input(webpFixture('corrupt'), 'image/webp'), profile()))).code).toMatch(/decode-failed|unreadable/);
  });
});

describe('processPictureInNode: refusals', () => {
  const png = encodePng(cornerPicture(4, 4, 4));

  it('refuses bytes that are not a picture, with a remedy', async () => {
    const error = await refusal(processPictureInNode(input(new Uint8Array([1, 2, 3, 4, 5])), profile()));
    expect(error.code).toBe('unsupported-format');
    expect(error.remedy).not.toBe('');
  });

  it('refuses SVG, GIF and an empty file', async () => {
    for (const bytes of [ascii('<svg xmlns="http://www.w3.org/2000/svg"/>'), ascii('GIF89a......'), new Uint8Array()]) {
      expect((await refusal(processPictureInNode(input(bytes), profile()))).code).toBe('unsupported-format');
    }
  });

  it('refuses HEIC, which this host cannot decode, naming the remedy', async () => {
    const heic = Uint8Array.from([0, 0, 0, 24, ...ascii('ftypheic'), 0, 0, 0, 0, ...ascii('mif1heic')]);
    const error = await refusal(processPictureInNode(input(heic), profile()));
    expect(error.code).toBe('heic-unavailable');
    expect(error.remedy).toMatch(/JPEG/);
  });

  it('refuses a truncated PNG, a PNG with a damaged chunk, and a truncated JPEG', async () => {
    expect((await refusal(processPictureInNode(input(png.subarray(0, png.length - 20)), profile()))).code).toBe('decode-failed');
    const damaged = png.slice();
    damaged[damaged.length - 20] = (damaged[damaged.length - 20] ?? 0) ^ 0xff;
    expect((await refusal(processPictureInNode(input(damaged), profile()))).code).toBe('decode-failed');
    const jpeg = new Uint8Array(encodeJpeg(cornerPicture(4, 4, 16), 90).data);
    for (const cut of [Math.floor(jpeg.length / 2), jpeg.length - 40]) {
      expect((await refusal(processPictureInNode(input(jpeg.subarray(0, cut), 'image/jpeg'), profile()))).code).toMatch(/^(?:unreadable|decode-failed)$/);
    }
  });

  it('refuses more than 50,000,000 pixels from the header, before it decodes anything', async () => {
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, 10_000);
    view.setUint32(4, 5_001);
    header.set([8, 2, 0, 0, 0], 8);
    const huge = concat(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IEND', new Uint8Array()));
    const error = await refusal(processPictureInNode(input(huge), profile()));
    expect(error.code).toBe('too-many-pixels');
    view.setUint32(4, 5_000);
    const atTheLimit = concat(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IEND', new Uint8Array()));
    // Exactly 50,000,000 passes the size rule; this file then fails to decode because it holds no pixels.
    expect((await refusal(processPictureInNode(input(atTheLimit), profile()))).code).toBe('decode-failed');
  });

  it('refuses a profile it cannot run', async () => {
    expect((await refusal(processPictureInNode(input(png), profile({ maxEdge: 0 })))).code).toBe('bad-profile');
    expect((await refusal(processPictureInNode(input(png), profile({ maxEdge: 10.5 })))).code).toBe('bad-profile');
    expect((await refusal(processPictureInNode(input(png), profile({ jpegQuality: 0 })))).code).toBe('bad-profile');
    expect((await refusal(processPictureInNode(input(png), profile({ jpegQuality: 1.5 })))).code).toBe('bad-profile');
  });

  it('refuses a CMYK JPEG rather than guess its colours', async () => {
    const jpeg = new Uint8Array(encodeJpeg(cornerPicture(2, 2, 8), 90).data);
    const at = jpeg.findIndex((byte, i) => byte === 0xff && jpeg[i + 1] === 0xc0);
    const cmyk = jpeg.slice();
    cmyk[at + 9] = 4;
    const error = await refusal(processPictureInNode(input(cmyk, 'image/jpeg'), profile()));
    expect(error.code).toBe('unsupported-colour');
  });
});

/** A minimal ICC profile: a 128-byte header, a tag table, and the tags given. */
function iccProfile(parts: { space?: string; description?: string; primaries?: readonly (readonly [number, number, number])[]; curve?: 'srgb' | number }): Uint8Array {
  const s15 = (n: number): number[] => {
    const v = Math.round(n * 65536) >>> 0;
    return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  };
  const tags: [string, number[]][] = [];
  if (parts.description !== undefined) tags.push(['desc', [...ascii('desc'), 0, 0, 0, 0, ...ascii(parts.description), 0]]);
  if (parts.primaries !== undefined) {
    ['rXYZ', 'gXYZ', 'bXYZ'].forEach((name, i) => tags.push([name, [...ascii('XYZ '), 0, 0, 0, 0, ...(parts.primaries?.[i] ?? [0, 0, 0]).flatMap(s15)]]));
  }
  if (parts.curve !== undefined) {
    const curve =
      parts.curve === 'srgb'
        ? [...ascii('para'), 0, 0, 0, 0, 0, 3, 0, 0, ...[2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045].flatMap(s15)]
        : [...ascii('curv'), 0, 0, 0, 0, 0, 0, 0, 1, Math.round(parts.curve * 256) >> 8, Math.round(parts.curve * 256) & 255, 0, 0];
    for (const name of ['rTRC', 'gTRC', 'bTRC', 'kTRC']) tags.push([name, curve]);
  }
  let offset = 132 + tags.length * 12;
  const table: number[] = [0, 0, 0, tags.length];
  const body: number[] = [];
  for (const [name, data] of tags) {
    table.push(...ascii(name), ...[offset >>> 24, (offset >>> 16) & 255, (offset >>> 8) & 255, offset & 255], 0, 0, 0, data.length);
    body.push(...data);
    offset += data.length;
  }
  const out = new Uint8Array(132 + tags.length * 12 + body.length);
  out.set(ascii(parts.space ?? 'RGB '), 16);
  out.set(ascii('XYZ '), 20);
  out.set(ascii('acsp'), 36);
  out.set(table, 128);
  out.set(body, 132 + tags.length * 12);
  new DataView(out.buffer).setUint32(0, out.length);
  return out;
}

const P3_PRIMARIES = [
  [0.5151, 0.2412, -0.0011],
  [0.292, 0.6922, 0.0419],
  [0.1571, 0.0666, 0.7841],
] as const;
const SRGB_PRIMARIES = [
  [0.4360747, 0.2225045, 0.0139322],
  [0.3850649, 0.7168786, 0.0971045],
  [0.1430804, 0.0606169, 0.7141733],
] as const;

function pngIccp(profileBytes: Uint8Array): Uint8Array {
  return concat(ascii('icc'), Uint8Array.from([0, 0]), new Uint8Array(deflateSync(profileBytes)));
}

function swatch(rgb: Rgb): Pixels {
  const data = new Uint8Array(2 * 2 * 4);
  for (let i = 0; i < 4; i += 1) data.set([...rgb, 255], i * 4);
  return { width: 2, height: 2, data };
}

async function throughProfile(rgb: Rgb, icc: Uint8Array, container: 'png' | 'jpeg'): Promise<number[]> {
  if (container === 'png') {
    const png = withPngChunk(encodePng(swatch(rgb)), 'iCCP', pngIccp(icc));
    return pixelAt(decodePng((await processPictureInNode(input(png), profile())).bytes), 0, 0);
  }
  const half = Math.ceil(icc.length / 2);
  let jpeg: Uint8Array = new Uint8Array(encodeJpeg(swatch(rgb), 100).data);
  // Two APP2 segments, to join; the later one is inserted first so they end up in order.
  jpeg = withJpegSegment(jpeg, 0xe2, concat(ascii('ICC_PROFILE\0'), Uint8Array.from([2, 2]), icc.subarray(half)));
  jpeg = withJpegSegment(jpeg, 0xe2, concat(ascii('ICC_PROFILE\0'), Uint8Array.from([1, 2]), icc.subarray(0, half)));
  return pixelAt(decodePng((await processPictureInNode(input(jpeg, 'image/jpeg'), profile())).bytes), 0, 0);
}

describe('processPictureInNode: colour profiles', () => {
  const p3 = iccProfile({ description: 'Display P3', primaries: P3_PRIMARIES, curve: 'srgb' });

  it.each(['png', 'jpeg'] as const)('converts a Display P3 %s to sRGB: more saturated, grey and white unchanged', async (container) => {
    const tolerance = container === 'png' ? 1 : 3;
    close(await throughProfile([128, 128, 128], p3, container), GRAY, tolerance);
    close(await throughProfile([255, 255, 255], p3, container), [255, 255, 255], tolerance);
    const [r, g, b] = await throughProfile([200, 100, 100], p3, container);
    expect(r).toBeGreaterThan(210);
    expect(g).toBeLessThan(100);
    expect(b).toBeLessThan(100);
  });

  it('clips what sRGB cannot show', async () => {
    close(await throughProfile([0, 255, 0], p3, 'png'), [0, 255, 0], 1);
  });

  it('matches the arithmetic: Display P3 (0.5, 0.5, 0.5) to (0.5, 0.5, 0.5) and (0.8, 0.4, 0.4) to its sRGB value', async () => {
    const linear = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const encode = (l: number): number => Math.round(255 * (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055));
    const [r, g, b] = [200, 100, 100].map((v) => linear(v / 255)) as [number, number, number];
    // Display P3 to XYZ (D50), then XYZ to sRGB.
    const x = 0.5151 * r + 0.292 * g + 0.1571 * b;
    const y = 0.2412 * r + 0.6922 * g + 0.0666 * b;
    const z = -0.0011 * r + 0.0419 * g + 0.7841 * b;
    const expected: Rgb = [
      encode(3.1338561 * x - 1.6168667 * y - 0.4906146 * z),
      encode(-0.9787684 * x + 1.9161415 * y + 0.033454 * z),
      encode(0.0719453 * x - 0.2289914 * y + 1.4052427 * z),
    ];
    close(await throughProfile([200, 100, 100], p3, 'png'), expected, 1);
  });

  it('leaves a profile that is sRGB alone, by name or by its primaries and curves', async () => {
    const named = iccProfile({ description: 'sRGB IEC61966-2.1', primaries: P3_PRIMARIES, curve: 'srgb' });
    const byValue = iccProfile({ primaries: SRGB_PRIMARIES, curve: 'srgb' });
    for (const icc of [named, byValue]) expect((await throughProfile([200, 100, 50], icc, 'png')).slice(0, 3)).toEqual([200, 100, 50]);
  });

  it('converts a grey profile with a 2.2 curve to sRGB grey', async () => {
    const grey = iccProfile({ space: 'GRAY', curve: 2.2 });
    const [r, g, b] = await throughProfile([128, 128, 128], grey, 'png');
    expect(r).toBe(g);
    expect(g).toBe(b);
    expect(Math.abs((r ?? 0) - 128)).toBeLessThan(4);
  });

  it('refuses a CMYK profile, a lookup-table profile and an unreadable one, with the remedy', async () => {
    for (const icc of [iccProfile({ space: 'CMYK' }), iccProfile({ description: 'Printer' }), Uint8Array.from([1, 2, 3, 4])]) {
      const png = withPngChunk(encodePng(swatch(RED)), 'iCCP', pngIccp(icc));
      const error = await refusal(processPictureInNode(input(png), profile()));
      expect(error.code).toBe('unsupported-colour');
      expect(error.remedy).toMatch(/sRGB/);
    }
  });

  it('trusts an sRGB chunk over a profile in the same PNG', async () => {
    const png = withPngChunk(withPngChunk(encodePng(swatch([200, 100, 50])), 'iCCP', pngIccp(p3)), 'sRGB', Uint8Array.from([0]));
    expect(pixelAt(decodePng((await processPictureInNode(input(png), profile())).bytes), 0, 0).slice(0, 3)).toEqual([200, 100, 50]);
  });
});

interface PngSpec {
  width: number;
  height: number;
  depth: number;
  colorType: number;
  /** One array of channel samples (at the file's depth) per pixel, row by row. */
  samples: number[][];
  interlace?: boolean;
  filters?: boolean;
  palette?: number[];
  trns?: number[];
}

const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;

function filterRow(type: number, row: Uint8Array, previous: Uint8Array, bpp: number): Uint8Array {
  const out = new Uint8Array(row.length + 1);
  out[0] = type;
  for (let i = 0; i < row.length; i += 1) {
    const left = i >= bpp ? (row[i - bpp] ?? 0) : 0;
    const up = previous[i] ?? 0;
    const upLeft = i >= bpp ? (previous[i - bpp] ?? 0) : 0;
    const p = left + up - upLeft;
    const pa = Math.abs(p - left);
    const pb = Math.abs(p - up);
    const pc = Math.abs(p - upLeft);
    const predictor = [0, left, up, (left + up) >> 1, pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft][type] ?? 0;
    out[i + 1] = (row[i] ?? 0) - predictor;
  }
  return out;
}

function buildPng(spec: PngSpec): Uint8Array {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[spec.colorType] ?? 1;
  const bitsPerPixel = channels * spec.depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const passes = spec.interlace === true ? ADAM7 : ([[0, 0, 1, 1]] as const);
  const rows: Uint8Array[] = [];
  let rowIndex = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((spec.width - x0) / dx);
    const ph = Math.ceil((spec.height - y0) / dy);
    if (pw < 1 || ph < 1) continue;
    let previous = new Uint8Array(Math.ceil((pw * bitsPerPixel) / 8));
    for (let ry = 0; ry < ph; ry += 1) {
      const row = new Uint8Array(previous.length);
      for (let rx = 0; rx < pw; rx += 1) {
        const sample = spec.samples[(y0 + ry * dy) * spec.width + x0 + rx * dx] ?? [];
        sample.forEach((value, c) => {
          if (spec.depth === 16) {
            row[(rx * channels + c) * 2] = value >> 8;
            row[(rx * channels + c) * 2 + 1] = value & 255;
          } else if (spec.depth === 8) row[rx * channels + c] = value;
          else {
            const bit = rx * spec.depth;
            row[bit >> 3] = (row[bit >> 3] ?? 0) | (value << (8 - spec.depth - (bit & 7)));
          }
        });
      }
      rows.push(filterRow(spec.filters === true ? rowIndex % 5 : 0, row, previous, bpp));
      previous = row;
      rowIndex += 1;
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, spec.width);
  view.setUint32(4, spec.height);
  header.set([spec.depth, spec.colorType, 0, 0, spec.interlace === true ? 1 : 0], 8);
  return concat(
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    ...(spec.palette === undefined ? [] : [chunk('PLTE', Uint8Array.from(spec.palette))]),
    ...(spec.trns === undefined ? [] : [chunk('tRNS', Uint8Array.from(spec.trns))]),
    chunk('IDAT', new Uint8Array(deflateSync(concat(...rows)))),
    chunk('IEND', new Uint8Array()),
  );
}

function grid(width: number, height: number, make: (x: number, y: number) => number[]): number[][] {
  return Array.from({ length: width * height }, (_, i) => make(i % width, Math.floor(i / width)));
}

describe('decodePng', () => {
  it.each([false, true])('reads 8-bit RGB through every row filter (interlaced: %s)', (interlace) => {
    const samples = grid(9, 11, (x, y) => [(x * 29 + y * 7) & 255, (x * 3 + y * 41) & 255, (x * y * 5) & 255]);
    const png = decodePng(buildPng({ width: 9, height: 11, depth: 8, colorType: 2, samples, interlace, filters: true }));
    expect([png.width, png.height]).toEqual([9, 11]);
    expect([...png.data]).toEqual(samples.flatMap(([r, g, b]) => [r!, g!, b!, 255]));
  });

  it.each([false, true])('reads 16-bit RGBA (interlaced: %s)', (interlace) => {
    const samples = grid(5, 3, (x, y) => [x * 257 * 20, y * 257 * 60, 257 * 255, 257 * (x * 50)]);
    const png = decodePng(buildPng({ width: 5, height: 3, depth: 16, colorType: 6, samples, interlace, filters: true }));
    expect([...png.data]).toEqual(samples.flatMap(([r, g, b, a]) => [r! / 257, g! / 257, b! / 257, a! / 257]));
  });

  it('reads 8-bit RGBA, grey and grey with alpha', () => {
    const rgba = grid(4, 2, (x, y) => [x * 60, y * 100, 7, 255 - x * 30]);
    expect([...decodePng(buildPng({ width: 4, height: 2, depth: 8, colorType: 6, samples: rgba })).data]).toEqual(rgba.flat());
    const grey = grid(4, 2, (x, y) => [x * 50 + y]);
    expect([...decodePng(buildPng({ width: 4, height: 2, depth: 8, colorType: 0, samples: grey })).data]).toEqual(grey.flatMap(([v]) => [v!, v!, v!, 255]));
    const ga = grid(4, 2, (x, y) => [x * 50 + y, 200 - x * 10]);
    expect([...decodePng(buildPng({ width: 4, height: 2, depth: 8, colorType: 4, samples: ga })).data]).toEqual(ga.flatMap(([v, a]) => [v!, v!, v!, a!]));
  });

  it('reads 1, 2 and 4-bit grey scaled to 8 bits, and a transparent grey value', () => {
    for (const depth of [1, 2, 4]) {
      const max = (1 << depth) - 1;
      const samples = grid(7, 3, (x, y) => [(x + y) % (max + 1)]);
      const png = decodePng(buildPng({ width: 7, height: 3, depth, colorType: 0, samples, trns: [0, 1] }));
      expect([...png.data]).toEqual(samples.flatMap(([v]) => [Math.round((v! * 255) / max), Math.round((v! * 255) / max), Math.round((v! * 255) / max), v === 1 ? 0 : 255]));
    }
  });

  it('reads palette pictures at 1, 2, 4 and 8 bits with a per-entry alpha', () => {
    const palette = [255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9];
    for (const depth of [2, 4, 8]) {
      const samples = grid(5, 4, (x, y) => [(x + y) % 4]);
      const png = decodePng(buildPng({ width: 5, height: 4, depth, colorType: 3, samples, palette, trns: [255, 128] }));
      expect([...png.data]).toEqual(samples.flatMap(([i]) => [palette[i! * 3]!, palette[i! * 3 + 1]!, palette[i! * 3 + 2]!, [255, 128, 255, 255][i!]!]));
    }
  });

  it('applies a colour key to RGB pixels', () => {
    const samples = grid(2, 1, (x) => (x === 0 ? [1, 2, 3] : [4, 5, 6]));
    const png = decodePng(buildPng({ width: 2, height: 1, depth: 8, colorType: 2, samples, trns: [0, 1, 0, 2, 0, 3] }));
    expect([...png.data]).toEqual([1, 2, 3, 0, 4, 5, 6, 255]);
  });

  it('reads the iCCP profile and the sRGB flag', () => {
    const icc = iccProfile({ description: 'Display P3', primaries: P3_PRIMARIES, curve: 'srgb' });
    const base = buildPng({ width: 1, height: 1, depth: 8, colorType: 2, samples: [[1, 2, 3]] });
    expect(decodePng(withPngChunk(base, 'iCCP', pngIccp(icc))).profile).toEqual(icc);
    expect(decodePng(withPngChunk(base, 'sRGB', Uint8Array.from([0]))).srgb).toBe(true);
  });

  it('refuses damage: a bad signature, a cut-off file, a bad checksum, a row filter that does not exist, and a zip bomb', () => {
    const good = buildPng({ width: 4, height: 4, depth: 8, colorType: 2, samples: grid(4, 4, () => [1, 2, 3]) });
    expect(() => decodePng(good.subarray(1))).toThrow(/signature/);
    expect(() => decodePng(good.subarray(0, good.length - 12))).toThrow(/cut short/);
    const flipped = good.slice();
    flipped[50] = (flipped[50] ?? 0) ^ 1;
    expect(() => decodePng(flipped)).toThrow(/checksum|unpacked/);
    const badFilter = concat(good.subarray(0, 33), chunk('IDAT', new Uint8Array(deflateSync(Uint8Array.from({ length: 4 * 13 }, (_, i) => (i % 13 === 0 ? 9 : 0))))), chunk('IEND', new Uint8Array()));
    expect(() => decodePng(badFilter)).toThrow(/filter/);
    const bomb = concat(good.subarray(0, 33), chunk('IDAT', new Uint8Array(deflateSync(new Uint8Array(4_000_000)))), chunk('IEND', new Uint8Array()));
    expect(() => decodePng(bomb)).toThrow(/unpacked/);
  });
});

describe('the Node-only subpath', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const sources = (dir: string): string[] =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !/[\\/]node_modules[\\/]/.test(entry.parentPath))
      .map((entry) => join(entry.parentPath, entry.name));

  it('is imported by neither the exporter index nor any file of the app, so jpeg-js and node:zlib never reach the browser bundle', () => {
    const offenders = [...sources(resolve(here, '../../../apps/desktop/src')), resolve(here, '../src/index.ts')].filter((file) =>
      /picture-process-node|png-decode|icc-srgb|jpeg-js/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
