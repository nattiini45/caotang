/**
 * The WebP transcoder for Node: the MCP server, and the tests. The app has its own, on a canvas
 * (apps/desktop/src/app/picture-transcoder.ts), because its CSP refuses WebAssembly. So this file is a subpath of its own
 * (`@caotang/exporter/picture-transcoder-node`) and the package's index never imports it: the browser bundle never sees
 * `node:fs`, `@jsquash/webp` or the decoder's `.wasm`.
 *
 * A {@link PictureTranscoder}: `@jsquash/webp` (Apache-2.0, libwebp's decoder) reads the WebP to RGBA, the pixels are scaled
 * down to the sheet's 300 dpi cap (./png-encode.ts), and a PNG is written for `pdf-lib` to embed. The decoder reads a still
 * image only: an animated WebP is refused, and its cards show the caption.
 *
 * Where the decoder's `webp_dec.wasm` is read from, in order:
 *
 * 1. Beside the running module. The MCPB bundle stages it there, beside `caotang-mcp.mjs`, so the installed server needs no
 *    `node_modules`.
 * 2. The `@jsquash/webp` package, resolved from the running module: a checkout, and the built bundle run in place.
 *
 * `decodeWebp` is also the WebP reader of the Node `ProcessPicture` (./picture-process-node.ts).
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { imageSizeOf, isAnimatedWebp } from './image-size.js';
import { encodePng, scaleToFit } from './png-encode.js';
import type { Pixels } from './png-encode.js';
import type { PictureTranscoder } from './render-contact-sheet.js';

/** The decoder's file name, and where its package keeps it. */
export const WEBP_DECODER_FILE = 'webp_dec.wasm';
const WEBP_DECODER_SPECIFIER = `@jsquash/webp/codec/dec/${WEBP_DECODER_FILE}`;

/**
 * The most pixels a WebP may hold to be decoded: 64 million, 256 MB of RGBA. A WebP can state up to 268 million (16383 square),
 * and the file limit (16 MB) does not bound that.
 */
export const MAX_DECODED_PIXELS = 64_000_000;

/** The places the decoder is read from, in the order they are tried. */
export function webpDecoderCandidates(moduleUrl: string = import.meta.url): string[] {
  const candidates = [join(dirname(fileURLToPath(moduleUrl)), WEBP_DECODER_FILE)];
  try {
    candidates.push(createRequire(moduleUrl).resolve(WEBP_DECODER_SPECIFIER));
  } catch {
    // Not resolvable from here: the staged copy, if any, is the only place.
  }
  return candidates;
}

async function readDecoder(candidates: readonly string[]): Promise<Uint8Array<ArrayBuffer>> {
  for (const path of candidates) {
    try {
      return new Uint8Array(await readFile(path));
    } catch {
      // Try the next place.
    }
  }
  throw new Error(`${WEBP_DECODER_FILE} is not at ${candidates.join(' or ')}`);
}

type Decode = (buffer: ArrayBuffer) => Promise<{ readonly width: number; readonly height: number; readonly data: Uint8ClampedArray }>;

let decoder: Promise<Decode> | undefined;

/** The decoder, compiled and started the first time a WebP needs it. A failure is not kept: the next picture tries again. */
function decoderOf(): Promise<Decode> {
  if (decoder === undefined) {
    const started = (async (): Promise<Decode> => {
      const wasm = await WebAssembly.compile(await readDecoder(webpDecoderCandidates()));
      const decode = await import('@jsquash/webp/decode.js');
      await (decode.init as unknown as (module: WebAssembly.Module) => Promise<void>)(wasm);
      return decode.default as unknown as Decode;
    })();
    decoder = started;
    started.catch(() => {
      if (decoder === started) decoder = undefined;
    });
  }
  return decoder;
}

/** A still WebP as straight RGBA. Throws, with the reason, for a file it cannot read, an animated one, or one over {@link MAX_DECODED_PIXELS}. */
export async function decodeWebp(bytes: Uint8Array): Promise<Pixels> {
  if (isAnimatedWebp(bytes)) throw new Error('the WebP is animated, and this decoder reads a still image only');
  const size = imageSizeOf(bytes);
  if (size !== undefined && size.width * size.height > MAX_DECODED_PIXELS) {
    throw new Error(`the WebP is ${size.width} × ${size.height} pixels, more than the ${MAX_DECODED_PIXELS / 1_000_000} million this compile decodes`);
  }
  const decode = await decoderOf();
  let image;
  try {
    image = await decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  } catch {
    throw new Error('the WebP data could not be decoded');
  }
  return { width: image.width, height: image.height, data: new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength) };
}

/** Decodes a WebP to PNG, scaled down to `maxPixels` on its longer side. Throws, with the reason, for a file it cannot read. */
export const transcodePictureInNode: PictureTranscoder = async (bytes, _format, maxPixels) => {
  return encodePng(scaleToFit(await decodeWebp(bytes), maxPixels));
};
