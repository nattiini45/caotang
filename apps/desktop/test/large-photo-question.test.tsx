/**
 * The large-photo question a batch raises on its own bytes (pictures.md §6.4): over 24 megapixels or over 8 MB, each threshold on
 * its own, and the reasons named once however many pictures cross them.
 */
import { LARGE_PHOTO_BYTES, LARGE_PHOTO_PIXELS } from '@caotang/pictures';
import { describe, expect, it } from 'vitest';

import { largePhotoQuestionFor } from '../src/media/picture-import-host.js';

/** A PNG signature and IHDR naming the size, padded with zeros to `length` bytes: enough for the header reader. */
function png(width: number, height: number, length = 64): { bytes: Uint8Array } {
  const bytes = new Uint8Array(Math.max(length, 33));
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  return { bytes };
}

const SMALL = png(100, 100);
const MANY_PIXELS = png(6001, Math.ceil(LARGE_PHOTO_PIXELS / 6000));
const HEAVY = png(100, 100, LARGE_PHOTO_BYTES + 1);

describe('largePhotoQuestionFor', () => {
  it('asks nothing of an empty batch or one with no large picture', () => {
    expect(largePhotoQuestionFor([])).toBeNull();
    expect(largePhotoQuestionFor([SMALL, SMALL])).toBeNull();
    expect(largePhotoQuestionFor([png(100, 100, LARGE_PHOTO_BYTES)])).toBeNull();
  });

  it('asks for a picture over the pixel limit alone, and for one over the byte limit alone', () => {
    expect(largePhotoQuestionFor([SMALL, MANY_PIXELS])).toEqual({ count: 1, because: ['pixels'] });
    expect(largePhotoQuestionFor([HEAVY, SMALL])).toEqual({ count: 1, because: ['bytes'] });
  });

  it('counts each large picture once and names each reason once', () => {
    const both = png(6001, Math.ceil(LARGE_PHOTO_PIXELS / 6000), LARGE_PHOTO_BYTES + 1);
    const question = largePhotoQuestionFor([both, MANY_PIXELS, HEAVY, SMALL]);
    expect(question?.count).toBe(3);
    expect([...(question?.because ?? [])].sort()).toEqual(['bytes', 'pixels']);
  });
});
