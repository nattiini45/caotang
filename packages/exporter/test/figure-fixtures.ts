/**
 * The picture fixtures of the figure corpus: asset ids, small real PNGs and JPEGs built in the test, a way to hide a marker
 * in a picture's XMP so a test can see whether an export kept it, and a `FigureHost` over a map of files. Not a test file.
 */

import { crc32 } from 'node:zlib';
import type { PictureBytes, PictureProfile, ProcessPicture } from '@caotang/pictures';
import { encode as encodeJpeg } from 'jpeg-js';

import type { FigureHost, FigureRecord } from '../src/figures.js';
import { encodePng } from '../src/png-encode.js';
import type { ImageRef } from '../src/prose.js';

export const ID_A = 'a_8K3QZ2M7RD';
export const ID_B = 'a_9K3QZ2M7RD';
export const ID_C = 'a_AK3QZ2M7RD';
export const ID_D = 'a_BK3QZ2M7RD';
export const ID_E = 'a_CK3QZ2M7RD';
export const ID_F = 'a_DK3QZ2M7RD';

export const pngFile = (id: string): string => `${id}.png`;
export const jpgFile = (id: string): string => `${id}.jpg`;
export const urlOf = (file: string): string => `../assets/${file}`;

/** A real PNG of one colour, `width` by `height`. */
export function solidPng(width: number, height: number, rgba: readonly [number, number, number, number] = [200, 40, 40, 255]): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let at = 0; at < data.length; at += 4) data.set(rgba, at);
  return encodePng({ width, height, data });
}

/** A real JPEG of one colour. */
export function solidJpeg(width: number, height: number, rgb: readonly [number, number, number] = [40, 40, 200]): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let at = 0; at < data.length; at += 4) data.set([...rgb, 255], at);
  return new Uint8Array(encodeJpeg({ width, height, data }, 90).data);
}

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** The marker a test hides in a picture's XMP; an export that kept the metadata still carries it. */
export const XMP_MARKER = 'PRIVATE-OWNER-NAME';

/** `png` with an XMP block holding {@link XMP_MARKER}, which a metadata strip removes. */
export function withPngXmp(png: Uint8Array): Uint8Array {
  const xmp = pngChunk('iTXt', concat(ascii('XML:com.adobe.xmp'), Uint8Array.from([0, 0, 0, 0, 0]), ascii(`<x:xmpmeta>${XMP_MARKER}</x:xmpmeta>`)));
  return concat(png.subarray(0, 33), xmp, png.subarray(33));
}

/** `jpeg` with an XMP segment holding {@link XMP_MARKER}. */
export function withJpegXmp(jpeg: Uint8Array): Uint8Array {
  const payload = ascii(`http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>${XMP_MARKER}</x:xmpmeta>`);
  const segment = new Uint8Array(4 + payload.length);
  segment.set([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]);
  segment.set(payload, 4);
  return concat(jpeg.subarray(0, 2), segment, jpeg.subarray(2));
}

/** `png` with a harmless comment chunk of `extra` bytes, so pictures of one size can be made to weigh different amounts. */
export function paddedPng(png: Uint8Array, extra: number): Uint8Array {
  const comment = pngChunk('tEXt', concat(ascii('Comment\0'), ascii('x'.repeat(extra))));
  return concat(png.subarray(0, 33), comment, png.subarray(33));
}

export const hasMarker = (bytes: Uint8Array): boolean => new TextDecoder('latin1').decode(bytes).includes(XMP_MARKER);

/** A placement as `prose.ts` reads it from `![alt](url "title")`. */
export const placement = (url: string, alt = '', title: string | null = null): ImageRef => ({ url, alt, title });

export interface RecordingHost {
  readonly host: FigureHost;
  /** The paths `readAsset` was asked for, in order. */
  readonly reads: string[];
  /** The profiles `process` was called with, in order. */
  readonly processed: { readonly input: PictureBytes; readonly profile: PictureProfile }[];
}

/** A `FigureHost` over files keyed by their `assets/` path, recording what it was asked. */
export function hostOf(
  files: Readonly<Record<string, Uint8Array>>,
  options: { readonly records?: readonly FigureRecord[]; readonly process?: ProcessPicture | undefined } = {},
): RecordingHost {
  const reads: string[] = [];
  const processed: RecordingHost['processed'] = [];
  const process = options.process;
  const host: FigureHost = {
    readAsset: async (path) => {
      reads.push(path);
      return files[path] ?? null;
    },
    ...(process === undefined
      ? {}
      : {
          process: async (input, profile) => {
            processed.push({ input, profile });
            return process(input, profile);
          },
        }),
    records: new Map((options.records ?? []).map((record) => [record.id, record])),
  };
  return { host, reads, processed };
}

/** A `ProcessPicture` that answers with a fixed PNG, whatever it is asked. */
export function stubProcess(width = 12, height = 8): ProcessPicture {
  return async () => ({ bytes: solidPng(width, height, [10, 20, 30, 255]), mime: 'image/png', width, height });
}
