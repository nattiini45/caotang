/**
 * `ProcessPicture` for Node (the SDK, the command line, the MCP server, the tests): a PNG, a JPEG or a still WebP in; a JPEG or
 * a PNG out, at most `maxEdge` pixels on its longer side, never larger than it came, with EXIF orientation applied, transparency
 * flattened onto white where the profile (or JPEG, which has none) needs it, and the colours in sRGB. The browser has its own
 * (apps/desktop/src/app/picture-transcoder.ts); the rules both follow before a pixel is touched are `planPicture` in
 * `@caotang/pictures`. A subpath of its own, `@caotang/exporter/picture-process-node`, so the app bundle never sees it.
 *
 * Codecs: `jpeg-js` (BSD-3-Clause, pure JavaScript) decodes and encodes JPEG; PNG is decoded by ./png-decode.ts and written by
 * ./png-encode.ts; a WebP is decoded by the same WebAssembly decoder the contact sheet uses (./picture-transcoder-node.ts), a still
 * image only. The pictures are held as 8-bit RGBA, so a 16-bit PNG is rounded to 8 bits.
 *
 * What is refused, with a remedy, and never approximated: HEIC, SVG and every format but PNG, JPEG and WebP; more than 50,000,000
 * pixels (read from the header, before any pixel is allocated); a CMYK JPEG; an animated WebP; a colour profile that is neither
 * sRGB nor a grey or RGB matrix profile this file can convert (./icc-srgb.ts); a `preserve` profile that would need a WebP
 * encoder. A `preserve` profile with nothing to change returns the stored bytes, with the private metadata removed when asked,
 * and Orientation and the colour profile intact. Any other result is re-encoded, so it carries no EXIF, no XMP and no profile:
 * orientation is baked into the pixels and the colours are sRGB, which is what a profile-less file means.
 */

import { PictureRefusal, checkOutput, finishPassthrough, planPicture } from '@caotang/pictures';
import type { PictureBytes, PictureMime, PicturePlan, ProcessPicture } from '@caotang/pictures';
import { decode as decodeJpeg, encode as encodeJpeg } from 'jpeg-js';

import { iccOfJpeg, iccOfWebp, srgbConversionFor } from './icc-srgb.js';
import { decodePng } from './png-decode.js';
import { decodeWebp } from './picture-transcoder-node.js';
import { encodePng, scaleToFit } from './png-encode.js';
import type { Pixels } from './png-encode.js';
import { isAnimatedWebp } from './image-size.js';

type Orientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/**
 * Display pixel (x, y) takes the stored pixel this returns, for each EXIF orientation: 2 mirrors, 3 turns half way, 4 flips,
 * 5 transposes, 6 turns a quarter clockwise, 7 transverses, 8 turns a quarter counter-clockwise.
 */
function sourceOf(orientation: Orientation, x: number, y: number, w: number, h: number): [number, number] {
  switch (orientation) {
    case 2:
      return [w - 1 - x, y];
    case 3:
      return [w - 1 - x, h - 1 - y];
    case 4:
      return [x, h - 1 - y];
    case 5:
      return [y, x];
    case 6:
      return [y, h - 1 - x];
    case 7:
      return [w - 1 - y, h - 1 - x];
    case 8:
      return [w - 1 - y, x];
    default:
      return [x, y];
  }
}

export function applyOrientation(pixels: Pixels, orientation: Orientation): Pixels {
  if (orientation === 1) return pixels;
  const { width: w, height: h, data } = pixels;
  const width = orientation >= 5 ? h : w;
  const height = orientation >= 5 ? w : h;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [sx, sy] = sourceOf(orientation, x, y, w, h);
      const from = (sy * w + sx) * 4;
      const to = (y * width + x) * 4;
      out[to] = data[from] ?? 0;
      out[to + 1] = data[from + 1] ?? 0;
      out[to + 2] = data[from + 2] ?? 0;
      out[to + 3] = data[from + 3] ?? 0;
    }
  }
  return { width, height, data: out };
}

/** Composites onto white, in place: a transparent pixel becomes white and a half-transparent one is mixed with it. */
export function flattenOnWhite(pixels: Pixels): void {
  const { data } = pixels;
  for (let at = 0; at < data.length; at += 4) {
    const a = data[at + 3] ?? 255;
    if (a === 255) continue;
    for (let c = 0; c < 3; c += 1) data[at + c] = Math.round(((data[at + c] ?? 0) * a + 255 * (255 - a)) / 255);
    data[at + 3] = 255;
  }
}

/** A JPEG's component count, from its frame header: 1 grey, 3 colour, 4 CMYK or YCCK. */
function jpegComponents(bytes: Uint8Array): number | undefined {
  let at = 2;
  while (at + 4 <= bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      at += 2;
      continue;
    }
    const length = ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return bytes[at + 9];
    if (marker === 0xda || length < 2) return undefined;
    at += 2 + length;
  }
  return undefined;
}

function decodeFailed(reason: string): PictureRefusal {
  return new PictureRefusal('decode-failed', reason, 'Choose another file, or export the picture again from the program that made it.');
}

interface Decoded {
  readonly pixels: Pixels;
  readonly profile?: Uint8Array;
  readonly srgb: boolean;
}

async function decodeAny(bytes: Uint8Array, mime: PictureMime): Promise<Decoded> {
  try {
    if (mime === 'image/png') {
      const png = decodePng(bytes);
      return { pixels: { width: png.width, height: png.height, data: png.data }, ...(png.profile === undefined ? {} : { profile: png.profile }), srgb: png.srgb };
    }
    if (mime === 'image/jpeg') {
      const image = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true, tolerantDecoding: false, maxResolutionInMP: 51, maxMemoryUsageInMB: 1024 });
      const profile = iccOfJpeg(bytes);
      return { pixels: { width: image.width, height: image.height, data: image.data }, ...(profile === undefined ? {} : { profile }), srgb: false };
    }
    const pixels = await decodeWebp(bytes);
    const profile = iccOfWebp(bytes);
    return { pixels, ...(profile === undefined ? {} : { profile }), srgb: false };
  } catch (error) {
    throw decodeFailed(error instanceof Error ? `The picture could not be decoded: ${error.message}.` : 'The picture could not be decoded.');
  }
}

async function transcode(bytes: Uint8Array, plan: Extract<PicturePlan, { kind: 'transcode' }>, profile: Parameters<ProcessPicture>[1]): Promise<PictureBytes> {
  const { mime } = plan.source;
  if (mime === 'image/webp' && isAnimatedWebp(bytes)) {
    throw new PictureRefusal('animated', 'This WebP is animated, and this host reads a still image only.', 'Export one frame as PNG or JPEG.');
  }
  if (mime === 'image/jpeg' && jpegComponents(bytes) === 4) {
    throw new PictureRefusal('unsupported-colour', 'This JPEG is CMYK, which cannot be converted to sRGB here.', 'Export the picture as sRGB from the program that made it.');
  }
  const decoded = await decodeAny(bytes, mime);
  let { pixels } = decoded;
  if (pixels.width !== plan.source.width || pixels.height !== plan.source.height) {
    throw decodeFailed('The picture is not the size its header says.');
  }
  // An sRGB chunk outranks a profile in the same PNG, and a profile that cannot be converted refuses before pixels are touched.
  const conversion = decoded.srgb ? undefined : srgbConversionFor(decoded.profile);

  // Shrink in the stored orientation, then turn the small result: the turn is the expensive step.
  if (plan.resized) pixels = scaleToFit(pixels, profile.maxEdge);
  conversion?.(pixels.data);
  pixels = applyOrientation(pixels, plan.source.orientation);
  if (pixels.width !== plan.width || pixels.height !== plan.height) throw decodeFailed('The picture came out at an unexpected size.');

  // JPEG has no alpha, so it is always flattened; a PNG keeps its transparency unless the profile asks.
  if (plan.output === 'image/jpeg' || profile.flattenAlpha) flattenOnWhite(pixels);

  let out: Uint8Array;
  if (plan.output === 'image/jpeg') {
    const quality = Math.min(100, Math.max(1, Math.round(profile.jpegQuality * 100)));
    out = new Uint8Array(encodeJpeg({ width: pixels.width, height: pixels.height, data: pixels.data }, quality).data);
  } else {
    out = encodePng(pixels);
  }
  checkOutput(out, plan.output, plan.width, plan.height);
  return { bytes: out, mime: plan.output, width: plan.width, height: plan.height };
}

export const processPictureInNode: ProcessPicture = async (input, profile) => {
  const plan = planPicture(input.bytes, profile);
  if (plan.kind === 'passthrough') return finishPassthrough(input.bytes, plan, profile);
  return transcode(input.bytes, plan, profile);
};
