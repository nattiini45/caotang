/**
 * `@caotang/pictures`: the metadata strip (D2), the sizes, the sniff, the record's load rules, `usesOf` and the pipeline.
 */
import { describe, expect, it } from 'vitest';

import {
  PICTURE_MAX_BYTES,
  inlineAssetIds,
  isHeif,
  isLargePhoto,
  isSvg,
  jpegHasGps,
  jpegOrientation,
  pixelSize,
  readAssetRecord,
  sha256Hex,
  sniffImage,
  usesOf,
  type PictureDecoder,
} from '../src/index.js';
import { preparePicture, stripPrivateMetadata } from '../src/prepare.js';
import { contains, exifTiff, jpeg, png, pngCrcsValid, webp } from './fixtures.js';

describe('the metadata strip keeps Orientation and takes the location (pictures.md §6.4, D2)', () => {
  it('a JPEG loses its GPS IFD, maker note and serial number, and keeps Orientation and its size', () => {
    const input = jpeg({ exif: exifTiff(6), width: 4032, height: 3024 });
    expect(jpegHasGps(input)).toBe(true);
    expect(contains(input, 'CANONNOTES')).toBe(true);
    const { bytes, removed } = stripPrivateMetadata(input, 'jpeg');
    expect(jpegHasGps(bytes)).toBe(false);
    expect(jpegOrientation(bytes)).toBe(6);
    expect(contains(bytes, 'CANONNOTES')).toBe(false);
    expect(contains(bytes, 'SN12345')).toBe(false);
    expect([...removed].sort()).toEqual(['location', 'maker notes', 'serial numbers']);
    // Lossless: the segment is rewritten in place, so the file keeps its length and every byte after the EXIF segment.
    expect(bytes.length).toBe(input.length);
    expect(pixelSize(bytes)).toEqual({ width: 4032, height: 3024 });
    const tail = input.indexOf(0xc0, 20) - 1;
    expect([...bytes.subarray(tail)]).toEqual([...input.subarray(tail)]);
    // The latitude's rational values are zeroed, not just unlinked.
    expect(contains(bytes, '\u0034\u0000\u0000\u0000\u0001\u0000\u0000\u0000')).toBe(false);
  });

  it('a JPEG with nothing to strip comes back as the same array', () => {
    const input = jpeg();
    const result = stripPrivateMetadata(input, 'jpeg');
    expect(result.bytes).toBe(input);
    expect(result.removed).toEqual([]);
  });

  it('an XMP segment that names a GPS property is dropped whole', () => {
    const input = jpeg({ xmpGps: true });
    const { bytes, removed } = stripPrivateMetadata(input, 'jpeg');
    expect(removed).toEqual(['location']);
    expect(contains(bytes, 'GPSLatitude')).toBe(false);
    expect(sniffImage(bytes)).toBe('jpeg');
    expect(pixelSize(bytes)).toEqual({ width: 640, height: 480 });
  });

  it('an EXIF block that cannot be walked is dropped whole', () => {
    const broken = exifTiff();
    broken[2] = 0; // the TIFF magic
    const { bytes, removed } = stripPrivateMetadata(jpeg({ exif: broken }), 'jpeg');
    expect(removed).toEqual(['unreadable metadata']);
    expect(contains(bytes, 'Exif')).toBe(false);
  });

  it("a PNG's eXIf chunk loses the location and keeps a valid CRC", () => {
    const input = png({ exif: exifTiff(3) });
    const { bytes, removed } = stripPrivateMetadata(input, 'png');
    expect(removed).toContain('location');
    expect(pngCrcsValid(bytes)).toBe(true);
    expect(contains(bytes, 'SN12345')).toBe(false);
  });

  it("a WebP's EXIF chunk is scrubbed, and an XMP chunk with a location goes, with the RIFF size and the flag", () => {
    const input = webp({ exif: exifTiff(), xmpGps: true });
    const { bytes, removed } = stripPrivateMetadata(input, 'webp');
    expect(removed).toContain('location');
    expect(contains(bytes, 'GPSLongitude')).toBe(false);
    expect(contains(bytes, 'XMP ')).toBe(false);
    const riff = bytes[4]! | (bytes[5]! << 8) | (bytes[6]! << 16) | (bytes[7]! << 24);
    expect(riff).toBe(bytes.length - 8);
    expect(bytes[20]! & 0x04).toBe(0);
    expect(pixelSize(bytes)).toEqual({ width: 100, height: 50 });
  });
});

describe('the sniff and the header sizes', () => {
  it('reads PNG, JPEG and WebP sizes from the header', () => {
    expect(pixelSize(png({ width: 300, height: 200 }))).toEqual({ width: 300, height: 200 });
    expect(pixelSize(jpeg({ width: 8000, height: 6000 }))).toEqual({ width: 8000, height: 6000 });
    expect(pixelSize(webp({ width: 1600, height: 900 }))).toEqual({ width: 1600, height: 900 });
    expect(pixelSize(Uint8Array.from([1, 2, 3]))).toBeUndefined();
  });

  it('knows HEIC and SVG by their bytes', () => {
    const heic = Uint8Array.from([0, 0, 0, 0x18, ...Array.from('ftypheic', (c) => c.charCodeAt(0)), 0, 0, 0, 0]);
    expect(isHeif(heic)).toBe(true);
    expect(isHeif(png())).toBe(false);
    expect(isSvg(new TextEncoder().encode('<?xml version="1.0"?>\n<!-- x -->\n<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(true);
    expect(isSvg(new TextEncoder().encode('<html><body/></html>'))).toBe(false);
  });

  it('a large photo is above 24 megapixels or 8 MB', () => {
    expect(isLargePhoto(jpeg({ width: 6000, height: 4000 }))).toBe(false);
    expect(isLargePhoto(jpeg({ width: 6000, height: 4001 }))).toBe(true);
    expect(isLargePhoto(new Uint8Array(8 * 1024 * 1024 + 1))).toBe(true);
  });
});

describe('the record and its load rules (pictures.md §2.1)', () => {
  const base = {
    id: 'a_0123456789',
    file: 'a_0123456789.png',
    mime: 'image/png',
    sha256: 'a'.repeat(64),
    bytes: 120,
    createdAt: '2026-10-30T10:00:00.000Z',
  };

  it('reads a full record and keeps an unknown source kind as its string', () => {
    const read = readAssetRecord({ ...base, width: 2, height: 2, caption: 'Ferry', alt: 'A ferry', decorative: true, tags: ['sea'], source: { kind: 'scanner', label: 'x.png' } });
    expect(read.ok && read.record.source?.kind).toBe('scanner');
    expect(read.ok && read.record.tags).toEqual(['sea']);
  });

  it('refuses a record whose file is not its id, whose mime does not match, or whose hash is not hex', () => {
    expect(readAssetRecord({ ...base, file: 'a_ZZZZZZZZZZ.png' }).ok).toBe(false);
    expect(readAssetRecord({ ...base, mime: 'image/jpeg' }).ok).toBe(false);
    expect(readAssetRecord({ ...base, sha256: 'xyz' }).ok).toBe(false);
    expect(readAssetRecord({ ...base, tags: ['a', 'a'] }).ok).toBe(false);
    expect(readAssetRecord({ ...base, alt: 'x'.repeat(501) }).ok).toBe(false);
  });
});

describe('usesOf: uses are derived, never stored', () => {
  it('finds the cover, a shot, a visual reference and an inline image', () => {
    const project = {
      manifest: {
        project: { coverAssetId: 'a_0123456789' },
        tree: [
          { id: 'n_SHOT000001', type: 'shot', title: 'Shot 1', shot: { image: 'a_0123456789' } },
          { id: 'n_DOC0000001', type: 'document', title: 'Chapter 1' },
        ],
        codex: [{ id: 'c_0000000001', name: 'Mara', visualRefs: ['a_0123456789'] }],
      },
      documents: new Map([['n_DOC0000001', { body: 'Text.\n\n![A ferry](../assets/a_0123456789.png "The ferry")\n' }]]),
    };
    expect(usesOf('a_0123456789', project).map((use) => use.kind)).toEqual(['cover', 'shot', 'visualRef', 'inline']);
    expect(usesOf('a_ABCDEFGHJK', project)).toEqual([]);
  });

  it('reads only images under assets/', () => {
    expect(inlineAssetIds('![x](../assets/a_0123456789.jpg) ![y](https://example.com/a_0123456789.png) ![z](assets/a_ABCDEFGHJK.webp)')).toEqual([
      'a_0123456789',
      'a_ABCDEFGHJK',
    ]);
  });

  it('stays linear on a body of unclosed image openers', () => {
    const body = `${'!['.repeat(50_000)}![x](../assets/a_0123456789.png)`;
    const started = performance.now();
    expect(inlineAssetIds(body)).toEqual(['a_0123456789']);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('the import pipeline (pictures.md §6.4)', () => {
  it('strips, sizes and hashes a JPEG', async () => {
    const result = await preparePicture(jpeg({ exif: exifTiff(8), width: 1200, height: 800 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.picture.extension).toBe('jpg');
    expect(result.picture.size).toEqual({ width: 1200, height: 800 });
    expect(jpegHasGps(result.picture.bytes)).toBe(false);
    expect(jpegOrientation(result.picture.bytes)).toBe(8);
    expect(result.picture.sha256).toBe(await sha256Hex(result.picture.bytes));
  });

  it('refuses SVG, an unknown file, an empty file, a file over 16 MB and a picture over 50 megapixels', async () => {
    const codes = await Promise.all(
      [
        new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        Uint8Array.from([1, 2, 3, 4]),
        new Uint8Array(),
        new Uint8Array(PICTURE_MAX_BYTES + 1),
        png({ width: 10000, height: 5001 }),
      ].map(async (bytes) => {
        const result = await preparePicture(bytes);
        return result.ok ? 'ok' : result.refusal.code;
      }),
    );
    expect(codes).toEqual(['svg', 'format', 'empty', 'too-large', 'too-many-pixels']);
  });

  it('refuses HEIC without a decoder, with the remedy, and converts it with one', async () => {
    const heic = Uint8Array.from([0, 0, 0, 0x18, ...Array.from('ftypheic', (c) => c.charCodeAt(0)), 0, 0, 0, 0]);
    const refused = await preparePicture(heic);
    expect(!refused.ok && refused.refusal.hint).toMatch(/JPEG/);
    const decoder: PictureDecoder = { heicToJpeg: () => Promise.resolve(jpeg({ width: 400, height: 300 })) };
    const converted = await preparePicture(heic, { decoder });
    expect(converted.ok && converted.picture.convertedFromHeic).toBe(true);
    expect(converted.ok && converted.picture.mime).toBe('image/jpeg');
  });

  it('stores a working copy of a large photo only when the batch chose it, and records the original size', async () => {
    const big = jpeg({ width: 8064, height: 6048 });
    const decoder: PictureDecoder = {
      workingCopy: (_bytes, _format, edge) => {
        expect(edge).toBe(4096);
        return Promise.resolve(jpeg({ width: 4096, height: 3072 }).subarray(0, big.length - 1));
      },
    };
    const kept = await preparePicture(big, { decoder, largePhotos: 'keep' });
    expect(kept.ok && kept.picture.workingCopy).toBeUndefined();
    const copied = await preparePicture(big, { decoder, largePhotos: 'working-copies' });
    expect(copied.ok && copied.picture.workingCopy).toEqual({ fromBytes: big.length, fromWidth: 8064, fromHeight: 6048 });
    expect(copied.ok && copied.picture.size).toEqual({ width: 4096, height: 3072 });
    // A blank result keeps the original.
    const blank = await preparePicture(big, { decoder: { workingCopy: () => Promise.resolve(undefined) }, largePhotos: 'working-copies' });
    expect(blank.ok && blank.picture.workingCopy).toBeUndefined();
  });
});
