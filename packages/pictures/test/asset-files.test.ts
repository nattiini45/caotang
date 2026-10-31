import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  PICTURE_ASK_BYTES,
  PICTURE_ASK_PIXELS,
  PICTURE_MAX_BYTES,
  PICTURE_MAX_PIXELS,
  WORKING_COPY_LONG_EDGE,
  assetFileName,
  decideImportBatch,
  decideImportSize,
  isAssetId,
  mintAssetId,
  parseAssetFileName,
  readPictureHeader,
  sha256Hex,
  sniffPicture,
  workingCopySize,
} from '../src/asset-files.js';
import { writeU16, writeU32 } from '../src/bytes.js';
import { buildJpeg, buildPng, buildTiff, buildWebp } from './fixtures.js';

const MIB = 1024 * 1024;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('the import limits sit exactly where the spec puts them', () => {
  it('caps the file at 16 MiB: exactly 16 MiB passes the cap, one byte more is refused', () => {
    expect(PICTURE_MAX_BYTES).toBe(16 * MIB);
    expect(decideImportSize({ bytes: 16 * MIB }).action).not.toBe('refuse');
    expect(decideImportSize({ bytes: 16 * MIB + 1 })).toMatchObject({ action: 'refuse', reason: 'too-many-bytes' });
  });

  it('refuses over 50,000,000 pixels before any decode; exactly 50,000,000 is allowed', () => {
    expect(PICTURE_MAX_PIXELS).toBe(50_000_000);
    expect(decideImportSize({ bytes: 1000, width: 10_000, height: 5_000 }).action).not.toBe('refuse');
    expect(decideImportSize({ bytes: 1000, width: 50_000_001, height: 1 })).toMatchObject({ action: 'refuse', reason: 'too-many-pixels' });
    expect(decideImportSize({ bytes: 1000, width: 7_072, height: 7_072 }).action).toBe('refuse');
  });

  it('checks bytes first, so an oversized file is refused without a header', () => {
    expect(decideImportSize({ bytes: 16 * MIB + 1, width: 10, height: 10 })).toMatchObject({ reason: 'too-many-bytes' });
  });

  it('asks above 24,000,000 pixels, not at exactly 24,000,000', () => {
    expect(PICTURE_ASK_PIXELS).toBe(24_000_000);
    expect(decideImportSize({ bytes: 1000, width: 6_000, height: 4_000 })).toEqual({ action: 'accept' });
    expect(decideImportSize({ bytes: 1000, width: 24_000_001, height: 1 })).toEqual({ action: 'ask', because: ['pixels'] });
  });

  it('asks above 8 MiB, not at exactly 8 MiB', () => {
    expect(PICTURE_ASK_BYTES).toBe(8 * MIB);
    expect(decideImportSize({ bytes: 8 * MIB, width: 100, height: 100 })).toEqual({ action: 'accept' });
    expect(decideImportSize({ bytes: 8 * MIB + 1, width: 100, height: 100 })).toEqual({ action: 'ask', because: ['bytes'] });
  });

  it('names both reasons when both thresholds are crossed', () => {
    expect(decideImportSize({ bytes: 9 * MIB, width: 8_000, height: 6_000 })).toEqual({ action: 'ask', because: ['pixels', 'bytes'] });
  });

  it('words a refusal so the writer knows what to do', () => {
    const d = decideImportSize({ bytes: 20 * MIB });
    expect(d.action === 'refuse' && d.message).toMatch(/16 MB/);
    const p = decideImportSize({ bytes: 100, width: 9_000, height: 9_000 });
    expect(p.action === 'refuse' && p.message).toMatch(/at most 50 megapixels/);
  });

  it('asks once for a whole batch, and flags a refusal anywhere in it', () => {
    const batch = decideImportBatch([
      { bytes: 9 * MIB, width: 100, height: 100 },
      { bytes: 9 * MIB, width: 100, height: 100 },
      { bytes: 10, width: 10, height: 10 },
    ]);
    expect(batch.prompt).toBe(true);
    expect(batch.refused).toBe(false);
    expect(decideImportBatch([{ bytes: 1, width: 1, height: 1 }]).prompt).toBe(false);
    expect(decideImportBatch([{ bytes: 1, width: 1, height: 1 }, { bytes: 17 * MIB }]).refused).toBe(true);
  });

  it('sizes a working copy to a 4096 long edge and never upscales', () => {
    expect(WORKING_COPY_LONG_EDGE).toBe(4096);
    expect(workingCopySize(8000, 6000)).toEqual({ width: 4096, height: 3072 });
    expect(workingCopySize(3000, 9000)).toEqual({ width: 1365, height: 4096 });
    expect(workingCopySize(4096, 100)).toEqual({ width: 4096, height: 100 });
    expect(workingCopySize(1000, 800)).toEqual({ width: 1000, height: 800 });
    expect(workingCopySize(40_000, 1)).toEqual({ width: 4096, height: 1 });
  });
});

describe('sniffPicture', () => {
  it('names PNG, JPEG and WebP by their bytes', () => {
    expect(sniffPicture(buildPng())).toEqual({ ok: true, mime: 'image/png', extension: 'png' });
    expect(sniffPicture(buildJpeg())).toEqual({ ok: true, mime: 'image/jpeg', extension: 'jpg' });
    expect(sniffPicture(buildWebp())).toEqual({ ok: true, mime: 'image/webp', extension: 'webp' });
  });

  it('does not take other RIFF files for WebP', () => {
    const wave = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    expect(sniffPicture(wave)).toMatchObject({ ok: false, format: 'unknown' });
  });

  it('refuses HEIC with the spec remedy', () => {
    for (const brand of ['heic', 'heix', 'mif1', 'heif']) {
      const bytes = Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, ...enc(brand), 0, 0, 0, 0]);
      const result = sniffPicture(bytes);
      expect(result).toMatchObject({ ok: false, format: 'heic' });
      expect(!result.ok && result.reason).toMatch(/Export it as JPEG, or use the iPhone photo picker/);
    }
  });

  it('refuses AVIF as its own format', () => {
    expect(sniffPicture(Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, ...enc('avif')]))).toMatchObject({ ok: false, format: 'avif' });
  });

  it('refuses SVG however it opens', () => {
    const variants = [
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      '  \n<svg\nwidth="1"></svg>',
      '<?xml version="1.0"?>\n<svg></svg>',
      '<?xml version="1.0"?><!-- c --><!DOCTYPE svg PUBLIC "x" "y"><svg></svg>',
      '<SVG></SVG>',
    ];
    for (const text of variants) expect(sniffPicture(enc(text))).toMatchObject({ ok: false, format: 'svg' });
    expect(sniffPicture(Uint8Array.from([0xef, 0xbb, 0xbf, ...enc('<svg></svg>')]))).toMatchObject({ ok: false, format: 'svg' });
    expect(sniffPicture(enc('<html><svg></svg></html>'))).toMatchObject({ ok: false, format: 'unknown' });
  });

  it('says what other refused files are, and handles an empty file', () => {
    expect(sniffPicture(enc('GIF89a....'))).toMatchObject({ ok: false, format: 'gif' });
    expect(sniffPicture(Uint8Array.from([0x49, 0x49, 0x2a, 0]))).toMatchObject({ format: 'tiff' });
    expect(sniffPicture(enc('BM....'))).toMatchObject({ format: 'bmp' });
    expect(sniffPicture(enc('8BPS....'))).toMatchObject({ format: 'psd' });
    expect(sniffPicture(new Uint8Array())).toMatchObject({ ok: false, format: 'empty' });
    expect(sniffPicture(enc('hello world'))).toMatchObject({ format: 'unknown' });
  });
});

describe('readPictureHeader reads sizes without decoding', () => {
  it('reads a PNG', () => {
    expect(readPictureHeader(buildPng({ width: 13, height: 7 }), 'image/png')).toMatchObject({ ok: true, width: 13, height: 7, displayWidth: 13, displayHeight: 7, orientation: 1, pixels: 91 });
  });

  it('reads a JPEG from its frame header, skipping the segments before it', () => {
    expect(readPictureHeader(buildJpeg({ width: 640, height: 480, icc: true }), 'image/jpeg')).toMatchObject({ ok: true, width: 640, height: 480 });
  });

  it('reads all three WebP layouts', () => {
    for (const kind of ['vp8', 'vp8l', 'vp8x'] as const) {
      expect(readPictureHeader(buildWebp({ kind, width: 300, height: 200 }), 'image/webp')).toMatchObject({ ok: true, width: 300, height: 200 });
    }
    expect(readPictureHeader(buildWebp({ kind: 'vp8x', width: 16384, height: 16384 }), 'image/webp')).toMatchObject({ ok: true, pixels: 16384 * 16384 });
  });

  it.each([1, 2, 3, 4])('orientation %i keeps the display size', (orientation) => {
    const bytes = buildJpeg({ width: 600, height: 400, tiff: buildTiff({ orientation }) });
    expect(readPictureHeader(bytes, 'image/jpeg')).toMatchObject({ orientation, displayWidth: 600, displayHeight: 400 });
  });

  it.each([5, 6, 7, 8])('orientation %i turns the picture on its side', (orientation) => {
    for (const bytes of [
      buildJpeg({ width: 600, height: 400, tiff: buildTiff({ orientation }) }),
      buildPng({ width: 600, height: 400, tiff: buildTiff({ orientation }) }),
      buildWebp({ width: 600, height: 400, tiff: buildTiff({ orientation }) }),
    ]) {
      const mime = bytes[0] === 0xff ? 'image/jpeg' : bytes[0] === 0x89 ? 'image/png' : 'image/webp';
      expect(readPictureHeader(bytes, mime)).toMatchObject({ ok: true, width: 600, height: 400, orientation, displayWidth: 400, displayHeight: 600, pixels: 240_000 });
    }
  });

  it('feeds the pixel budget from the header alone', () => {
    const huge = buildPng({ width: 8, height: 8 }).slice(0, 33);
    writeU32(huge, 16, 10_000, false);
    writeU32(huge, 20, 10_000, false);
    const header = readPictureHeader(huge, 'image/png');
    expect(header.ok && decideImportSize({ bytes: huge.length, width: header.width, height: header.height }).action).toBe('refuse');
  });

  it('refuses headers it cannot trust', () => {
    const zero = buildPng({ width: 8, height: 8 });
    writeU32(zero, 16, 0, false);
    expect(readPictureHeader(zero, 'image/png').ok).toBe(false);
    expect(readPictureHeader(buildPng().subarray(0, 20), 'image/png').ok).toBe(false);
    expect(readPictureHeader(buildJpeg().subarray(0, 12), 'image/jpeg').ok).toBe(false);
    const noFrame = buildJpeg();
    const sof = noFrame.indexOf(0xc0, 2);
    noFrame[sof] = 0xc4;
    expect(readPictureHeader(noFrame, 'image/jpeg').ok).toBe(false);
    const badStart = buildWebp({ kind: 'vp8' });
    badStart[12 + 8 + 3] = 0;
    expect(readPictureHeader(badStart, 'image/webp').ok).toBe(false);
    expect(readPictureHeader(new Uint8Array(), 'image/webp').ok).toBe(false);
    const lying = buildWebp();
    writeU32(lying, 4, 9999, true);
    expect(readPictureHeader(lying, 'image/webp').ok).toBe(false);
  });

  it('survives a JPEG whose zero-sized frame would divide a layout by zero', () => {
    const jpeg = buildJpeg({ width: 5, height: 5 });
    const sof = jpeg.indexOf(0xc0, 2);
    writeU16(jpeg, sof + 5, 0, false);
    expect(readPictureHeader(jpeg, 'image/jpeg').ok).toBe(false);
  });
});

describe('file names and ids', () => {
  it('derives the file from the id and the sniffed type', () => {
    expect(assetFileName('a_7K2QX9M4A1', 'image/png')).toBe('a_7K2QX9M4A1.png');
    expect(assetFileName('a_7K2QX9M4A1', 'image/jpeg')).toBe('a_7K2QX9M4A1.jpg');
    expect(assetFileName('a_7K2QX9M4A1', 'image/webp')).toBe('a_7K2QX9M4A1.webp');
  });

  it('parses only the exact shape', () => {
    expect(parseAssetFileName('a_7K2QX9M4A1.jpg')).toEqual({ assetId: 'a_7K2QX9M4A1', mime: 'image/jpeg', extension: 'jpg' });
    for (const name of ['a_7K2QX9M4A1.jpeg', 'a_7K2QX9M4A1.gif', 'a_7K2QX9M4A1.png.tmp-3', 'notes.txt', 'n_7K2QX9M4A1.png', 'a_7K2QX9M4A1', 'a_short.png']) {
      expect(parseAssetFileName(name)).toBeUndefined();
    }
  });

  it('never accepts a content-hash file name', () => {
    const hash = createHash('sha256').update('x').digest('hex');
    expect(parseAssetFileName(`${hash}.png`)).toBeUndefined();
    expect(isAssetId(hash)).toBe(false);
  });

  it('mints random ids unrelated to the bytes, and re-rolls a taken one', () => {
    const fixed = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const first = mintAssetId(new Set(), () => fixed);
    expect(isAssetId(first)).toBe(true);
    let calls = 0;
    const second = mintAssetId(new Set([first]), (n) => {
      calls += 1;
      return calls === 1 ? fixed : Uint8Array.from({ length: n }, (_, i) => i * 31 + 7);
    });
    expect(second).not.toBe(first);
    expect(isAssetId(second)).toBe(true);
    const ids = new Set(Array.from({ length: 50 }, () => mintAssetId(new Set())));
    expect(ids.size).toBe(50);
  });

  it('throws rather than hand back a duplicate when randomness is stuck', () => {
    const stuck = new Uint8Array(8);
    const taken = new Set([mintAssetId(new Set(), () => stuck)]);
    expect(() => mintAssetId(taken, () => stuck)).toThrow();
  });
});

describe('sha256Hex', () => {
  it('matches the known digest of empty input through WebCrypto', async () => {
    expect(await sha256Hex(new Uint8Array())).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('accepts any host digest, returning an ArrayBuffer or a Uint8Array', async () => {
    const bytes = enc('abc');
    const want = createHash('sha256').update(bytes).digest('hex');
    expect(await sha256Hex(bytes, async (b) => new Uint8Array(createHash('sha256').update(b).digest()))).toBe(want);
    expect(await sha256Hex(bytes, async (b) => new Uint8Array(createHash('sha256').update(b).digest()).buffer)).toBe(want);
  });
});
