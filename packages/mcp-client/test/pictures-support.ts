/**
 * Picture bytes for the image-block tests: a real PNG the importer accepts, and a way to make one any size, since a cap is only exercised by
 * bytes that are over it.
 */

import { crc32, deflateSync } from 'node:zlib';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(enc(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function join(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A small gray 8-bit PNG. A different `sample` is a different picture. */
export function png(sample = 0x40): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, 4);
  view.setUint32(4, 4);
  ihdr.set([8, 0, 0, 0, 0], 8);
  const rows = new Uint8Array(4 * 5).fill(sample);
  return join([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', new Uint8Array(0))]);
}

/** The same leading bytes with trailing padding, so a size is exact while the sniff still reads a PNG. */
export function paddedTo(bytes: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(Math.max(size, bytes.length));
  out.set(bytes);
  return out;
}

export const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
export const SVG_BYTES = enc('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
export const GIF_BYTES = enc('GIF89a\u0001\u0000\u0001\u0000');

export const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

export function imageBlock(bytes: Uint8Array, mimeType = 'image/png'): { type: 'image'; data: string; mimeType: string } {
  return { type: 'image', data: base64(bytes), mimeType };
}
