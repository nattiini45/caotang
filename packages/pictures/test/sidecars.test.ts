import { describe, expect, it } from 'vitest';

import { concatBytes, writeU32 } from '../src/bytes.js';
import { walkJpeg, walkPng, walkWebp } from '../src/containers.js';
import { readOrientation, stripPrivateMetadata } from '../src/metadata.js';
import type { PictureMime } from '../src/model.js';
import { buildJpeg, buildPng, buildTiff, buildWebp, containsBytes, jpegSegment, pngChunk, pngProblem, riffChunk, webpProblem } from './fixtures.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const XMP_SECRET = 'xmp:SerialNumber=XMP-SECRET-0042';
const IPTC_SECRET = 'IPTC-BYLINE-SECRET';
const XMP_PACKET = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:Description exif:GPSLatitude="51,30N" ${XMP_SECRET}/></x:xmpmeta>`;

function withJpegSidecars(tiff?: Uint8Array): Uint8Array {
  const base = buildJpeg({ ...(tiff === undefined ? {} : { tiff }), icc: true });
  const xmp = jpegSegment(0xe1, enc(`http://ns.adobe.com/xap/1.0/\0${XMP_PACKET}`));
  const extended = jpegSegment(0xe1, enc(`http://ns.adobe.com/xmp/extension/\0${XMP_SECRET}`));
  const iptc = jpegSegment(0xed, enc(`Photoshop 3.0\0 8BIM ${IPTC_SECRET}`));
  return concatBytes([base.subarray(0, 2), xmp, extended, iptc, base.subarray(2)]);
}

function withPngSidecars(tiff?: Uint8Array): Uint8Array {
  const base = buildPng({ ...(tiff === undefined ? {} : { tiff }), icc: true });
  const xmp = pngChunk('iTXt', concatBytes([enc('XML:com.adobe.xmp'), new Uint8Array([0, 0, 0, 0, 0]), enc(XMP_PACKET)]));
  const iptc = pngChunk('zTXt', concatBytes([enc('Raw profile type iptc'), new Uint8Array([0, 0]), enc(IPTC_SECRET)]));
  const innocent = pngChunk('tEXt', enc('Title\0Harbour at dusk'));
  return concatBytes([base.subarray(0, 33), xmp, iptc, innocent, base.subarray(33)]);
}

function withWebpSidecars(tiff?: Uint8Array): Uint8Array {
  const base = buildWebp({ ...(tiff === undefined ? {} : { tiff }), icc: true });
  const xmp = riffChunk('XMP ', enc(XMP_PACKET));
  const out = concatBytes([base, xmp]);
  writeU32(out, 4, out.length - 8, true);
  out[20] = (out[20] ?? 0) | 0x04;
  return out;
}

const CASES: { name: string; mime: PictureMime; build: (tiff?: Uint8Array) => Uint8Array; secrets: string[] }[] = [
  { name: 'jpeg', mime: 'image/jpeg', build: withJpegSidecars, secrets: [XMP_SECRET, IPTC_SECRET, 'GPSLatitude'] },
  { name: 'png', mime: 'image/png', build: withPngSidecars, secrets: [XMP_SECRET, IPTC_SECRET, 'GPSLatitude'] },
  { name: 'webp', mime: 'image/webp', build: withWebpSidecars, secrets: [XMP_SECRET, 'GPSLatitude'] },
];

describe.each(CASES)('$name: XMP and IPTC are removed', ({ mime, build, secrets }) => {
  it('removes the sidecars and keeps orientation', () => {
    const input = build(buildTiff({ orientation: 6 }));
    for (const secret of secrets) expect(containsBytes(input, secret)).toBe(true);
    const result = stripPrivateMetadata(input, mime);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.removed).toContain('xmp');
    for (const secret of secrets) expect(containsBytes(result.bytes, secret)).toBe(false);
    expect(readOrientation(result.bytes, mime)).toBe(6);
  });

  it('removes them from a picture that has no EXIF at all', () => {
    const result = stripPrivateMetadata(build(), mime);
    expect(result.ok && result.changed).toBe(true);
    if (!result.ok) return;
    for (const secret of secrets) expect(containsBytes(result.bytes, secret)).toBe(false);
  });

  it('is idempotent and returns a clean file as the same array', () => {
    const once = stripPrivateMetadata(build(), mime);
    if (!once.ok) throw new Error('strip failed');
    const twice = stripPrivateMetadata(once.bytes, mime);
    expect(twice.ok && twice.changed).toBe(false);
    if (twice.ok) expect(twice.bytes).toBe(once.bytes);
  });
});

describe('what stays', () => {
  it('JPEG keeps the ICC profile and a valid segment table', () => {
    const result = stripPrivateMetadata(withJpegSidecars(), 'image/jpeg');
    if (!result.ok) throw new Error('strip failed');
    expect([...result.removed].sort()).toEqual(['iptc', 'xmp']);
    const walked = walkJpeg(result.bytes);
    expect(walked.ok).toBe(true);
    if (walked.ok) expect(walked.value.segments.map((s) => s.type)).toEqual([0xe0, 0xe2, 0xc0]);
  });

  it('PNG keeps ICC and unrelated text chunks, with valid CRCs and pixels', () => {
    const result = stripPrivateMetadata(withPngSidecars(), 'image/png');
    if (!result.ok) throw new Error('strip failed');
    expect(pngProblem(result.bytes, 0xff)).toBeUndefined();
    const walked = walkPng(result.bytes);
    if (!walked.ok) throw new Error('walk failed');
    expect(walked.value.chunks.map((c) => c.type)).toEqual(['IHDR', 'tEXt', 'iCCP', 'IDAT', 'IEND']);
  });

  it('WebP clears the XMP flag, keeps the others and keeps the RIFF sizes exact', () => {
    const result = stripPrivateMetadata(withWebpSidecars(), 'image/webp');
    if (!result.ok) throw new Error('strip failed');
    expect(webpProblem(result.bytes)).toBeUndefined();
    const walked = walkWebp(result.bytes);
    if (!walked.ok) throw new Error('walk failed');
    expect(walked.value.chunks.map((c) => c.type)).toEqual(['VP8X', 'ICCP', 'VP8L']);
    expect(result.bytes[20]).toBe(0x20);
  });

  it('a Photoshop APP13 block is IPTC; another APP13 is left alone', () => {
    const base = buildJpeg();
    const other = jpegSegment(0xed, enc('Something else\0data'));
    const input = concatBytes([base.subarray(0, 2), other, base.subarray(2)]);
    const result = stripPrivateMetadata(input, 'image/jpeg');
    expect(result.ok && result.changed).toBe(false);
  });
});

describe('malformed containers are still refused', () => {
  it('a JPEG whose segment table is cut', () => {
    expect(stripPrivateMetadata(withJpegSidecars().subarray(0, 30), 'image/jpeg').ok).toBe(false);
  });
});
