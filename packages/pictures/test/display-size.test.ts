/**
 * The display size a layout reads (pictures.md §2.1): a record keeps the size its file encodes and the EXIF Orientation beside it,
 * and every consumer that places a picture turns the size by the orientation through `displaySizeOf`.
 */

import { describe, expect, it } from 'vitest';

import { displaySize, displaySizeOf, isSideways, readOrientation, readPictureHeader, recordOrientation, validateAssetRecord } from '../src/index.js';
import { exifTiff, jpeg } from './fixtures.js';

describe('displaySize and displaySizeOf', () => {
  it('shows a sideways phone photo portrait: orientation 6 swaps a 4032 × 3024 encoding to 3024 × 4032', () => {
    const photo = jpeg({ exif: exifTiff(6), width: 4032, height: 3024 });
    const header = readPictureHeader(photo, 'image/jpeg');
    expect(header.ok && { width: header.width, height: header.height }).toEqual({ width: 4032, height: 3024 });
    const orientation = readOrientation(photo, 'image/jpeg');
    expect(orientation).toBe(6);
    expect(displaySize({ width: 4032, height: 3024 }, orientation)).toEqual({ width: 3024, height: 4032 });
    expect(displaySizeOf({ width: 4032, height: 3024, orientation: 6 })).toEqual({ width: 3024, height: 4032 });
  });

  it('swaps for every sideways orientation (5–8) and for none of the upright or mirrored ones (1–4)', () => {
    for (const o of [5, 6, 7, 8]) {
      expect(isSideways(o)).toBe(true);
      expect(displaySize({ width: 40, height: 30 }, o)).toEqual({ width: 30, height: 40 });
    }
    for (const o of [undefined, 1, 2, 3, 4]) {
      expect(isSideways(o)).toBe(false);
      expect(displaySize({ width: 40, height: 30 }, o)).toEqual({ width: 40, height: 30 });
    }
  });

  it('has no display size for a record without one, and reads a record without orientation as upright', () => {
    expect(displaySizeOf({})).toBeUndefined();
    expect(displaySizeOf({ width: 10 })).toBeUndefined();
    expect(displaySizeOf({ width: 10, height: 20 })).toEqual({ width: 10, height: 20 });
  });

  it('stores upright as absence and only 2–8 as a value', () => {
    expect(recordOrientation(1)).toBeUndefined();
    expect(recordOrientation(undefined)).toBeUndefined();
    expect(recordOrientation(9)).toBeUndefined();
    expect(recordOrientation(6)).toBe(6);
  });

  it('validates a record orientation of 2–8 and refuses 1 and anything else', () => {
    const base = { id: 'a_0R1ENT0001', file: 'a_0R1ENT0001.jpg', mime: 'image/jpeg', sha256: 'a'.repeat(64), bytes: 10, createdAt: '2026-10-31T00:00:00.000Z' };
    expect(validateAssetRecord({ ...base, orientation: 6 }).ok).toBe(true);
    expect(validateAssetRecord(base).ok).toBe(true);
    for (const bad of [1, 0, 9, 6.5, '6']) expect(validateAssetRecord({ ...base, orientation: bad }).ok, String(bad)).toBe(false);
  });
});
