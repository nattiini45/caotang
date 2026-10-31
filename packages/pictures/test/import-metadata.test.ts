import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { concatBytes, writeU16, writeU32 } from '../src/bytes.js';
import { walkJpeg } from '../src/containers.js';
import { readOrientation, stripPrivateMetadata } from '../src/metadata.js';
import { sha256Hex } from '../src/asset-files.js';
import type { PictureMime } from '../src/model.js';
import {
  EXIF_HEADER,
  ICC_PAYLOAD,
  JPEG_SCAN,
  SECRETS,
  WEBP_IMAGE_PAYLOAD,
  buildJpeg,
  buildPng,
  buildTiff,
  buildWebp,
  containsBytes,
  exifOf,
  jpegSegment,
  listTags,
  pngProblem,
  webpProblem,
  type TiffSpec,
} from './fixtures.js';

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

describe.each(CONTAINERS)('%s: GPS, maker notes and serial numbers are removed', (container) => {
  const mime = MIME[container];

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('keeps orientation %i and removes the private entries', (orientation) => {
    for (const order of ['II', 'MM'] as const) {
      const input = wrap(container, buildTiff({ order, orientation }));
      expect(containsBytes(input, SECRETS.gps)).toBe(true);
      const result = stripPrivateMetadata(input, mime);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.changed).toBe(true);
      expect([...result.removed].sort()).toEqual(['gps', 'maker-note', 'serial-number']);
      expect(result.orientation).toBe(orientation);
      expect(readOrientation(result.bytes, mime)).toBe(orientation);
      expectNoSecrets(result.bytes);

      const tags = listTags(exifOf(result.bytes, container) ?? new Uint8Array());
      expect(tags.orientation).toBe(orientation);
      expect(tags.all.has(0x8825)).toBe(false);
      expect(tags.all.has(0x927c)).toBe(false);
      expect(tags.all.has(0xa431)).toBe(false);
      expect(tags.all.has(0x010f)).toBe(true);
      expect(tags.all.has(0x9003)).toBe(true);
      expect(containsBytes(result.bytes, SECRETS.kept)).toBe(true);
      validContainer(container, result.bytes);
    }
  });

  it('shrinks the file and rewrites the container sizes', () => {
    const input = wrap(container, buildTiff({ orientation: 6 }));
    const result = stripPrivateMetadata(input, mime);
    expect(result.ok && result.bytes.length < input.length).toBe(true);
    if (result.ok) validContainer(container, result.bytes);
  });

  it('keeps every size when shrinking is off', () => {
    const input = wrap(container, buildTiff({ orientation: 3 }));
    const result = stripPrivateMetadata(input, mime, { shrink: false });
    expect(result.ok && result.bytes.length === input.length).toBe(true);
    if (result.ok) {
      expectNoSecrets(result.bytes);
      validContainer(container, result.bytes);
    }
  });

  it('leaves a hole, not a shorter file, when the maker note sits before data that stays', () => {
    const thumbnail = buildJpeg({ tiff: buildTiff({ orientation: 1 }) });
    const input = wrap(container, buildTiff({ orientation: 8, makerNoteFirst: true, thumbnail }));
    const result = stripPrivateMetadata(input, mime);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expectNoSecrets(result.bytes);
    expect(result.orientation).toBe(8);
    expect(containsBytes(result.bytes, 'JFIF')).toBe(true);
    validContainer(container, result.bytes);
  });

  it('scrubs a thumbnail that carries its own GPS', () => {
    const thumbnail = buildJpeg({ tiff: buildTiff({ orientation: 1 }) });
    expect(containsBytes(thumbnail, SECRETS.gps)).toBe(true);
    const input = wrap(container, buildTiff({ orientation: 1, gps: false, makerNote: false, serial: false, thumbnail }));
    const result = stripPrivateMetadata(input, mime);
    expect(result.ok && result.changed).toBe(true);
    if (result.ok) expectNoSecrets(result.bytes);
  });

  it('returns the very same bytes when there is nothing to remove', () => {
    const input = wrap(container, buildTiff({ orientation: 5, gps: false, makerNote: false, serial: false }));
    const result = stripPrivateMetadata(input, mime);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
    expect(result.bytes).toBe(input);
    expect(result.orientation).toBe(5);
  });

  it('passes a picture with no EXIF through untouched', () => {
    const input = container === 'jpeg' ? buildJpeg() : container === 'png' ? buildPng() : buildWebp();
    const result = stripPrivateMetadata(input, mime);
    expect(result).toMatchObject({ ok: true, changed: false });
    if (result.ok) expect(result.bytes).toBe(input);
  });

  it('keeps the colour profile', () => {
    const result = stripPrivateMetadata(wrap(container, buildTiff({}), { icc: true }), mime);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const marker = container === 'jpeg' ? ICC_PAYLOAD : container === 'png' ? new TextEncoder().encode('iCCP') : new TextEncoder().encode('ICCP');
    expect(containsBytes(result.bytes, new TextDecoder().decode(marker))).toBe(true);
    if (container === 'webp') expect(containsBytes(result.bytes, 'FAKE-ICC-DATA!')).toBe(true);
  });

  it('is stable: stripping twice changes nothing the second time', () => {
    const once = stripPrivateMetadata(wrap(container, buildTiff({ orientation: 2 })), mime);
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    const twice = stripPrivateMetadata(once.bytes, mime);
    expect(twice).toMatchObject({ ok: true, changed: false });
  });

  it.each<[string, TiffSpec]>([
    ['gps only', { makerNote: false, serial: false }],
    ['serial only', { gps: false, makerNote: false }],
    ['maker note only', { gps: false, serial: false }],
    ['big-endian with everything', { order: 'MM' }],
  ])('every size stays consistent: %s', (_name, spec) => {
    const result = stripPrivateMetadata(wrap(container, buildTiff({ orientation: 4, ...spec })), mime);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expectNoSecrets(result.bytes);
      validContainer(container, result.bytes);
    }
  });
});

describe('a valid uniform-white picture', () => {
  it('stays valid: CRCs hold and the pixels are untouched', () => {
    const input = buildPng({ tiff: buildTiff({ orientation: 6 }), white: true, width: 16, height: 9 });
    expect(pngProblem(input, 0xff)).toBeUndefined();
    const result = stripPrivateMetadata(input, 'image/png');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(pngProblem(result.bytes, 0xff)).toBeUndefined();
    expect(result.bytes.length).toBeLessThan(input.length);
  });

  it('does not treat a white image as damaged: the same file with other pixels is also left valid', () => {
    const input = buildPng({ tiff: buildTiff({}), white: false });
    const result = stripPrivateMetadata(input, 'image/png');
    expect(result.ok && pngProblem(result.bytes, 0x40) === undefined).toBe(true);
  });
});

describe('WebP details', () => {
  it('handles an EXIF chunk written with the Exif header prefix', () => {
    const prefixed = concatBytes([new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0]), buildTiff({ orientation: 7 })]);
    const result = stripPrivateMetadata(buildWebp({ tiff: prefixed }), 'image/webp');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expectNoSecrets(result.bytes);
    expect(result.orientation).toBe(7);
    expect(webpProblem(result.bytes)).toBeUndefined();
  });

  it('keeps the image payload byte for byte', () => {
    const result = stripPrivateMetadata(buildWebp({ tiff: buildTiff({}) }), 'image/webp');
    expect(result.ok && containsBytes(result.bytes, String.fromCharCode(...WEBP_IMAGE_PAYLOAD))).toBe(true);
  });

  it('works for the lossy and lossless layouts without a VP8X header', () => {
    for (const kind of ['vp8', 'vp8l'] as const) {
      const result = stripPrivateMetadata(buildWebp({ kind, tiff: buildTiff({}) }), 'image/webp');
      expect(result.ok && webpProblem(result.bytes) === undefined).toBe(true);
    }
  });

  it('pads an odd-sized EXIF chunk and counts the pad in the RIFF size', () => {
    let sawOdd = false;
    for (let extra = 0; extra < 6 && !sawOdd; extra += 1) {
      const tiff = concatBytes([buildTiff({ orientation: 1 }), new Uint8Array(extra).fill(1)]);
      const result = stripPrivateMetadata(buildWebp({ tiff }), 'image/webp');
      expect(result.ok && webpProblem(result.bytes) === undefined).toBe(true);
      if (result.ok) {
        const out = exifOf(result.bytes, 'webp');
        sawOdd = out !== undefined && out.length % 2 === 1;
      }
    }
    expect(sawOdd).toBe(true);
  });
});

describe('PNG details', () => {
  it('rewrites the eXIf chunk length and CRC', () => {
    const result = stripPrivateMetadata(buildPng({ tiff: buildTiff({ orientation: 2 }) }), 'image/png');
    expect(result.ok).toBe(true);
    if (result.ok) expect(pngProblem(result.bytes, 0xff)).toBeUndefined();
  });
});

describe('JPEG details', () => {
  it('rewrites the APP1 length and leaves the entropy-coded data alone', () => {
    const input = buildJpeg({ tiff: buildTiff({ orientation: 3 }), width: 10, height: 20 });
    const result = stripPrivateMetadata(input, 'image/jpeg');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const walked = walkJpeg(result.bytes);
    expect(walked.ok).toBe(true);
    if (!walked.ok) return;
    const app1 = walked.value.segments.find((s) => s.type === 0xe1);
    expect(app1).toBeDefined();
    expect(result.bytes.subarray(result.bytes.length - 2 - JPEG_SCAN.length, result.bytes.length - 2)).toEqual(JPEG_SCAN);
  });

  it('cleans every Exif segment when a file carries two', () => {
    const base = buildJpeg({ tiff: buildTiff({ orientation: 3 }) });
    const second = jpegSegment(0xe1, concatBytes([EXIF_HEADER, buildTiff({ orientation: 3 })]));
    const input = concatBytes([base.subarray(0, 2), second, base.subarray(2)]);
    const result = stripPrivateMetadata(input, 'image/jpeg');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expectNoSecrets(result.bytes);
    expect(result.bytes.length).toBeLessThan(input.length - 100);
  });
});

describe('malformed metadata is refused', () => {
  const tiff = (): Uint8Array => buildTiff({ orientation: 1 });

  function ifd0Next(): number {
    return 8 + 2 + 4 * 12;
  }

  const mutations: [string, (t: Uint8Array) => Uint8Array][] = [
    ['a truncated block', (t) => t.subarray(0, 30)],
    ['no byte-order mark', (t) => Uint8Array.from(t, (b, i) => (i < 2 ? 0x41 : b))],
    ['a bad magic number', (t) => {
      const c = t.slice();
      writeU16(c, 2, 43, true);
      return c;
    }],
    ['an IFD0 offset past the block', (t) => {
      const c = t.slice();
      writeU32(c, 4, t.length + 100, true);
      return c;
    }],
    ['an IFD chain that loops', (t) => {
      const c = t.slice();
      writeU32(c, ifd0Next(), 8, true);
      return c;
    }],
    ['an entry count that runs off the end', (t) => {
      const c = t.slice();
      writeU16(c, 8, 0xffff, true);
      return c;
    }],
    ['a GPS pointer outside the block', (t) => {
      const c = t.slice();
      writeU32(c, 8 + 2 + 3 * 12 + 8, t.length + 50, true);
      return c;
    }],
    ['an Exif pointer back to IFD0', (t) => {
      const c = t.slice();
      writeU32(c, 8 + 2 + 2 * 12 + 8, 8, true);
      return c;
    }],
    ['a value offset outside the block', (t) => {
      const c = t.slice();
      writeU32(c, 8 + 2 + 0 * 12 + 8, t.length + 50, true);
      return c;
    }],
  ];

  it.each(mutations)('%s', (_name, mutate) => {
    for (const container of CONTAINERS) {
      const result = stripPrivateMetadata(wrap(container, mutate(tiff())), MIME[container]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('malformed-metadata');
        expect(result.message.length).toBeGreaterThan(10);
      }
    }
  });

  it('refuses a block whose entries all point at one huge value', () => {
    const entries = 4000;
    const blob = 60_000;
    const size = 8 + 2 + entries * 12 + 4 + blob;
    const t = new Uint8Array(size);
    t.set([0x49, 0x49], 0);
    writeU16(t, 2, 42, true);
    writeU32(t, 4, 8, true);
    writeU16(t, 8, entries, true);
    for (let k = 0; k < entries; k += 1) {
      const at = 10 + k * 12;
      writeU16(t, at, 0x927c, true);
      writeU16(t, at + 2, 7, true);
      writeU32(t, at + 4, blob, true);
      writeU32(t, at + 8, 10 + entries * 12 + 4, true);
    }
    const result = stripPrivateMetadata(buildJpeg({ tiff: t }), 'image/jpeg');
    expect(result.ok).toBe(false);
  });

  it('refuses garbage after an Exif header', () => {
    const jpeg = concatBytes([new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 20, 0x45, 0x78, 0x69, 0x66, 0, 0]), new Uint8Array(12).fill(7), new Uint8Array([0xff, 0xd9])]);
    expect(stripPrivateMetadata(jpeg, 'image/jpeg').ok).toBe(false);
  });

  it('refuses containers whose own tables are broken', () => {
    const jpeg = buildJpeg({ tiff: tiff() });
    expect(stripPrivateMetadata(jpeg.subarray(0, 40), 'image/jpeg').ok).toBe(false);
    const png = buildPng({ tiff: tiff() });
    expect(stripPrivateMetadata(png.subarray(0, png.length - 20), 'image/png').ok).toBe(false);
    const webp = buildWebp({ tiff: tiff() });
    expect(stripPrivateMetadata(webp.subarray(0, webp.length - 5), 'image/webp').ok).toBe(false);
    expect(stripPrivateMetadata(new Uint8Array(), 'image/png').ok).toBe(false);
    expect(stripPrivateMetadata(new Uint8Array([0xff, 0xd8]), 'image/jpeg').ok).toBe(false);
  });

  it('never throws and never hangs on randomly damaged files', () => {
    let seed = 12345;
    const rand = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    const bases = CONTAINERS.map((c) => [c, wrap(c, buildTiff({ orientation: 6 }))] as const);
    let accepted = 0;
    const started = Date.now();
    for (let round = 0; round < 600; round += 1) {
      const [container, base] = bases[round % bases.length] ?? bases[0] ?? ['jpeg', new Uint8Array()];
      const mutated = base.slice();
      for (let k = 0; k < 1 + rand(6); k += 1) mutated[rand(mutated.length)] = rand(256);
      const cut = rand(5) === 0 ? mutated.subarray(0, rand(mutated.length)) : mutated;
      const result = stripPrivateMetadata(cut, MIME[container]);
      readOrientation(cut, MIME[container]);
      if (result.ok) accepted += 1;
    }
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(accepted).toBeGreaterThan(0);
  });
});

describe('hashing what is stored', () => {
  const digest = async (bytes: Uint8Array): Promise<Uint8Array> => new Uint8Array(createHash('sha256').update(bytes).digest());

  it('gives two photos that differ only in location the same hash once stripped', async () => {
    const a = buildJpeg({ tiff: buildTiff({ orientation: 6, gpsText: 'GPS-PROCESSING-SECRET' }) });
    const b = buildJpeg({ tiff: buildTiff({ orientation: 6, gpsText: 'GPS-PROCESSING-SECRE2' }) });
    expect(await sha256Hex(a, digest)).not.toBe(await sha256Hex(b, digest));
    const sa = stripPrivateMetadata(a, 'image/jpeg');
    const sb = stripPrivateMetadata(b, 'image/jpeg');
    expect(sa.ok && sb.ok).toBe(true);
    if (sa.ok && sb.ok) expect(await sha256Hex(sa.bytes, digest)).toBe(await sha256Hex(sb.bytes, digest));
  });
});
