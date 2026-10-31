/**
 * The decisions both `ProcessPicture` hosts share (process.ts): refuse a profile that makes no sense, read the header before any
 * pixel is allocated, hold the 50,000,000-pixel line exactly, fit the long edge without upscaling, and hand back the bytes
 * of a profile that asks for nothing, with the private metadata removed.
 */

import { describe, expect, it } from 'vitest';

import { PictureRefusal, checkHeic, checkOutput, finishPassthrough, fitLongEdge, planPicture, readHeicSize, validateProfile } from '../src/index.js';
import type { PicturePlan, PictureProfile } from '../src/index.js';
import { SECRETS, buildJpeg, buildPng, buildTiff, containsBytes } from './fixtures.js';

const profile = (patch: Partial<PictureProfile> = {}): PictureProfile => ({
  maxEdge: 1600,
  output: 'jpeg',
  jpegQuality: 0.85,
  flattenAlpha: true,
  stripMetadata: true,
  ...patch,
});

function refusalOf(run: () => unknown): PictureRefusal {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PictureRefusal);
    return error as PictureRefusal;
  }
  throw new Error('expected a refusal');
}

describe('validateProfile', () => {
  it('accepts a sensible profile and refuses a nonsensical one with a code', () => {
    expect(() => validateProfile(profile())).not.toThrow();
    for (const bad of [{ maxEdge: 0 }, { maxEdge: -4 }, { maxEdge: 1.5 }, { maxEdge: Number.NaN }, { jpegQuality: 0 }, { jpegQuality: 1.01 }, { jpegQuality: Number.NaN }]) {
      expect(refusalOf(() => validateProfile(profile(bad))).code).toBe('bad-profile');
    }
  });
});

describe('fitLongEdge', () => {
  it('shrinks the longer side to the edge and the other by the same ratio, and never grows a picture', () => {
    expect(fitLongEdge(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200, resized: true });
    expect(fitLongEdge(3000, 4000, 1600)).toEqual({ width: 1200, height: 1600, resized: true });
    expect(fitLongEdge(1600, 900, 1600)).toEqual({ width: 1600, height: 900, resized: false });
    expect(fitLongEdge(300, 200, 1600)).toEqual({ width: 300, height: 200, resized: false });
    expect(fitLongEdge(10000, 3, 100)).toEqual({ width: 100, height: 1, resized: true });
  });
});

describe('planPicture', () => {
  it('holds the pixel line exactly: 50,000,000 passes, one more row is refused, before any decoding', () => {
    expect(planPicture(buildPng({ width: 10_000, height: 5_000 }), profile()).kind).toBe('transcode');
    const error = refusalOf(() => planPicture(buildPng({ width: 10_000, height: 5_001 }), profile()));
    expect(error.code).toBe('too-many-pixels');
    expect(error.remedy).not.toBe('');
    expect(refusalOf(() => planPicture(buildJpeg({ width: 60_000, height: 60_000 }), profile())).code).toBe('too-many-pixels');
  });

  it('plans the display size, with the orientation applied before the edge is measured', () => {
    const on_its_side = buildJpeg({ width: 3000, height: 2000, tiff: buildTiff({ orientation: 6 }) });
    const plan = planPicture(on_its_side, profile({ maxEdge: 1000 })) as Extract<PicturePlan, { kind: 'transcode' }>;
    expect(plan).toMatchObject({ kind: 'transcode', output: 'image/jpeg', width: 667, height: 1000, resized: true });
    expect(plan.source).toMatchObject({ mime: 'image/jpeg', width: 3000, height: 2000, orientation: 6 });
  });

  it('chooses the output format from the profile, and the source format for preserve', () => {
    const png = buildPng({ width: 40, height: 40 });
    const outputs = (output: PictureProfile['output'], maxEdge: number): string => {
      const plan = planPicture(png, profile({ output, maxEdge }));
      return plan.kind === 'passthrough' ? 'passthrough' : plan.output;
    };
    expect(outputs('jpeg', 1600)).toBe('image/jpeg');
    expect(outputs('png', 1600)).toBe('image/png');
    expect(outputs('preserve', 20)).toBe('image/png');
  });

  it('hands back the stored picture when a preserve profile has nothing to change', () => {
    expect(planPicture(buildJpeg({ width: 800, height: 600 }), profile({ output: 'preserve' })).kind).toBe('passthrough');
    expect(planPicture(buildPng({ width: 800, height: 600 }), profile({ output: 'preserve', flattenAlpha: false })).kind).toBe('passthrough');
    expect(planPicture(buildPng({ width: 800, height: 600 }), profile({ output: 'preserve', flattenAlpha: true })).kind).toBe('transcode');
    expect(planPicture(buildJpeg({ width: 800, height: 600 }), profile({ output: 'preserve', maxEdge: 400 })).kind).toBe('transcode');
  });

  it('refuses what is not a PNG, JPEG or WebP, naming a remedy; HEIC has its own code', () => {
    expect(refusalOf(() => planPicture(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), profile())).code).toBe('unsupported-format');
    expect(refusalOf(() => planPicture(new Uint8Array(), profile())).code).toBe('unsupported-format');
    const heic = Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 0x6d, 0x69, 0x66, 0x31]);
    const error = refusalOf(() => planPicture(heic, profile()));
    expect(error.code).toBe('heic-unavailable');
    expect(error.remedy).toMatch(/JPEG/);
  });

  it('refuses a header it cannot read', () => {
    expect(refusalOf(() => planPicture(buildPng().subarray(0, 20), profile())).code).toBe('unreadable');
  });
});

describe('finishPassthrough', () => {
  const plan = (bytes: Uint8Array): Extract<PicturePlan, { kind: 'passthrough' }> => {
    const planned = planPicture(bytes, profile({ output: 'preserve' }));
    if (planned.kind !== 'passthrough') throw new Error('expected a passthrough');
    return planned;
  };

  it('returns the same bytes when the profile keeps metadata', () => {
    const jpeg = buildJpeg({ tiff: buildTiff({ orientation: 6 }), width: 30, height: 20 });
    const result = finishPassthrough(jpeg, plan(jpeg), profile({ output: 'preserve', stripMetadata: false }));
    expect(result.bytes).toBe(jpeg);
    expect([result.width, result.height]).toEqual([20, 30]);
  });

  it('removes GPS, the maker note and the serial number without touching Orientation, and reports the display size', () => {
    const jpeg = buildJpeg({ tiff: buildTiff({ orientation: 6 }), width: 30, height: 20 });
    for (const secret of [SECRETS.gps, SECRETS.maker, SECRETS.serial]) expect(containsBytes(jpeg, secret)).toBe(true);
    const result = finishPassthrough(jpeg, plan(jpeg), profile({ output: 'preserve' }));
    for (const secret of [SECRETS.gps, SECRETS.maker, SECRETS.serial]) expect(containsBytes(result.bytes, secret)).toBe(false);
    expect(containsBytes(result.bytes, SECRETS.kept)).toBe(true);
    expect([result.mime, result.width, result.height]).toEqual(['image/jpeg', 20, 30]);
  });

  it('refuses metadata it cannot walk safely, rather than claim it is gone', () => {
    const jpeg = buildJpeg({ tiff: new Uint8Array([0x49, 0x49, 0x2a, 0, 0xff, 0xff, 0xff, 0x7f]), width: 30, height: 20 });
    expect(refusalOf(() => finishPassthrough(jpeg, plan(jpeg), profile({ output: 'preserve' }))).code).toBe('malformed-metadata');
  });
});

describe('checkOutput', () => {
  it('accepts bytes that are the format and size planned, and refuses anything else', () => {
    const png = buildPng({ width: 12, height: 8 });
    expect(() => checkOutput(png, 'image/png', 12, 8)).not.toThrow();
    for (const wrong of [() => checkOutput(png, 'image/jpeg', 12, 8), () => checkOutput(png, 'image/png', 8, 12), () => checkOutput(new Uint8Array(4), 'image/png', 12, 8)]) {
      expect(refusalOf(wrong).code).toBe('encode-failed');
    }
  });
});

describe('HEIC size', () => {
  const ispe = (width: number, height: number): number[] => [0, 0, 0, 20, 0x69, 0x73, 0x70, 0x65, 0, 0, 0, 0, width >>> 24, (width >> 16) & 255, (width >> 8) & 255, width & 255, height >>> 24, (height >> 16) & 255, (height >> 8) & 255, height & 255];
  const heic = (...sizes: [number, number][]): Uint8Array =>
    Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 0x6d, 0x69, 0x66, 0x31, 0x68, 0x65, 0x69, 0x63, ...sizes.flatMap(([w, h]) => ispe(w, h))]);

  it('reads the largest stated size, thumbnails included, from the header', () => {
    expect(readHeicSize(heic([320, 240], [4032, 3024]))).toEqual({ width: 4032, height: 3024 });
    expect(readHeicSize(Uint8Array.from([0, 1, 2, 3]))).toBeUndefined();
  });

  it('refuses a HEIC with no readable size, or over the pixel line, before a browser is asked to decode it', () => {
    expect(checkHeic(heic([4032, 3024]))).toEqual({ width: 4032, height: 3024 });
    expect(refusalOf(() => checkHeic(heic([10_000, 5_001]))).code).toBe('too-many-pixels');
    expect(refusalOf(() => checkHeic(Uint8Array.from([0, 0, 0, 24]))).code).toBe('unreadable');
  });
});
