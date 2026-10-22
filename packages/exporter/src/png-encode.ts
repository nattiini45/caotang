/**
 * A small PNG writer and a box-filter resampler, for the Node picture transcoder (./picture-transcoder-node.ts): decoded
 * WebP pixels in, PNG bytes out for `pdf-lib` to embed. No browser API and no native binary, only `fflate`, which the exporter
 * already depends on.
 */

import { zlibSync } from 'fflate/browser';

/** Straight (not premultiplied) RGBA pixels, row by row from the top left. */
export interface Pixels {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

let crcTable: Uint32Array | undefined;

function crc32(bytes: Uint8Array): number {
  if (crcTable === undefined) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: the length, the type and data (which the CRC covers), and the CRC. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * The pixels as a PNG, 8 bits a channel. A picture with no transparent pixel is written as RGB, a quarter smaller than RGBA and
 * without an alpha plane for the PDF to carry; one with any is written as RGBA. Rows are stored unfiltered.
 */
export function encodePng(pixels: Pixels): Uint8Array {
  const { width, height, data } = pixels;
  let opaque = true;
  for (let at = 3; at < data.length; at += 4) {
    if (data[at] !== 255) {
      opaque = false;
      break;
    }
  }
  const channels = opaque ? 3 : 4;
  const stride = width * channels;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const row = y * (stride + 1);
    if (opaque) {
      for (let x = 0; x < width; x += 1) {
        const from = (y * width + x) * 4;
        raw.set(data.subarray(from, from + 3), row + 1 + x * 3);
      }
    } else {
      raw.set(data.subarray(y * stride, (y + 1) * stride), row + 1);
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = opaque ? 2 : 6;
  const parts = [Uint8Array.from(PNG_SIGNATURE), chunk('IHDR', header), chunk('IDAT', zlibSync(raw)), chunk('IEND', new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }
  return png;
}

/**
 * The pixels scaled down so the longer side is at most `maxPixels`, by averaging the source pixels each new pixel covers
 * (a box filter, in premultiplied alpha so a transparent pixel adds no colour). A picture already that small, or with no limit
 * given, is returned as it is: a picture is never scaled up.
 */
export function scaleToFit(pixels: Pixels, maxPixels?: number): Pixels {
  const { width, height, data } = pixels;
  const longer = Math.max(width, height);
  if (maxPixels === undefined || !(maxPixels >= 1) || longer <= maxPixels) return pixels;
  const ratio = maxPixels / longer;
  const outWidth = Math.max(1, Math.round(width * ratio));
  const outHeight = Math.max(1, Math.round(height * ratio));
  const out = new Uint8Array(outWidth * outHeight * 4);
  for (let y = 0; y < outHeight; y += 1) {
    const y0 = Math.floor((y * height) / outHeight);
    const y1 = Math.min(height, Math.max(y0 + 1, Math.ceil(((y + 1) * height) / outHeight)));
    for (let x = 0; x < outWidth; x += 1) {
      const x0 = Math.floor((x * width) / outWidth);
      const x1 = Math.min(width, Math.max(x0 + 1, Math.ceil(((x + 1) * width) / outWidth)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const at = (sy * width + sx) * 4;
          const alpha = data[at + 3] ?? 0;
          r += (data[at] ?? 0) * alpha;
          g += (data[at + 1] ?? 0) * alpha;
          b += (data[at + 2] ?? 0) * alpha;
          a += alpha;
        }
      }
      const to = (y * outWidth + x) * 4;
      if (a > 0) {
        out[to] = Math.round(r / a);
        out[to + 1] = Math.round(g / a);
        out[to + 2] = Math.round(b / a);
      }
      out[to + 3] = Math.round(a / ((y1 - y0) * (x1 - x0)));
    }
  }
  return { width: outWidth, height: outHeight, data: out };
}
