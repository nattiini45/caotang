import { describe, expect, it } from 'vitest';

import { walkJpeg } from '../src/containers.js';
import { stripPrivateMetadata } from '../src/exif.js';
import { formatOfMime } from '../src/files.js';
import { readOrientation } from '../src/metadata.js';
import type { PictureMime } from '../src/model.js';
import {
  JPEG_SCAN,
  SECRETS,
  buildJpeg,
  buildPng,
  buildTiff,
  buildWebp,
  containsBytes,
  exifOf,
  listTags,
  pngProblem,
  webpProblem,
} from './byte-fixtures.js';

type Container = 'jpeg' | 'png' | 'webp';

const MIME: Record<Container, PictureMime> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function wrap(container: Container, tiff: Uint8Array, extra: { icc?: boolean; white?: boolean } = {}): Uint8Array {
  if (container === 'jpeg') return buildJpeg({ tiff, ...(extra.icc ? { icc: true } : {}) });
  if (container === 'png') return buildPng({ tiff, ...extra });
  return buildWebp({ tiff, ...(extra.icc ? { icc: true } : {}) });
}

function validContainer(container: Container, bytes: Uint8Array): void {
  if (container === 'png') expect(pngProblem(bytes, 0xff)).toBeUndefined();
  if (container === 'webp') expect(webpProblem(bytes)).toBeUndefined();
  if (container === 'jpeg') {
    const walked = walkJpeg(bytes);
    expect(walked.ok).toBe(true);
    if (walked.ok) expect(bytes.subarray(walked.value.scanStart + 10, walked.value.scanStart + 10 + JPEG_SCAN.length)).toEqual(JPEG_SCAN);
  }
}

function expectNoSecrets(bytes: Uint8Array): void {
  expect(containsBytes(bytes, SECRETS.gps)).toBe(false);
  expect(containsBytes(bytes, SECRETS.maker)).toBe(false);
  expect(containsBytes(bytes, SECRETS.serial)).toBe(false);
}

const CONTAINERS: Container[] = ['jpeg', 'png', 'webp'];

/**
 * The import's one metadata strip (`exif.ts`, pictures.md §6.4 step 4, D2) over every container and both byte orders: the GPS IFD,
 * the maker note and the serial numbers leave, and the Orientation, the camera make and the capture time stay, read back by the
 * orientation reader the registry's header uses (`metadata.ts`).
 */
describe.each(CONTAINERS)('%s: GPS, maker notes and serial numbers are removed', (container) => {
  const mime = MIME[container];

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('keeps orientation %i and removes the private entries', (orientation) => {
    for (const order of ['II', 'MM'] as const) {
      const input = wrap(container, buildTiff({ order, orientation }));
      expect(containsBytes(input, SECRETS.gps)).toBe(true);
      const result = stripPrivateMetadata(input, formatOfMime(mime) ?? 'png');
      expect(result.removed).toEqual(expect.arrayContaining(['location', 'maker notes', 'serial numbers']));
      expect(readOrientation(result.bytes, mime)).toBe(orientation);
      expectNoSecrets(result.bytes);

      const tags = listTags(exifOf(result.bytes, container) ?? new Uint8Array());
      expect(tags.orientation).toBe(orientation);
      expect(tags.all.has(0x8825)).toBe(false);
      expect(tags.all.has(0x927c)).toBe(false);
      expect(tags.all.has(0xa431)).toBe(false);
      expect(tags.all.has(0x010f)).toBe(true);
      validContainer(container, result.bytes);
    }
  });

  it('reads no orientation from a picture without EXIF', () => {
    expect(readOrientation(wrap(container, new Uint8Array()).subarray(0, 8), mime)).toBeUndefined();
  });
});
