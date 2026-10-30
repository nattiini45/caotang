/**
 * The browser's half of the picture import (pictures.md §6.4): decoding, which the pure pipeline in `@caotang/pictures` cannot do.
 *
 * - **HEIC** is decoded where the browser can (`createImageBitmap` reads it in Safari 17 and later) and re-encoded as JPEG at
 *   quality 0.9. Elsewhere the decode throws, the decoder answers `undefined`, and the import refuses with the remedy.
 * - **Working copies** are decoded with resize (`resizeWidth`/`resizeHeight` and `imageOrientation: 'from-image'`), so a full-size
 *   bitmap of a 48-megapixel photo never exists, and drawn upright. The result is checked for blank pixels, the failure an iOS canvas
 *   over its area cap produces; a blank result is tried once at half the size, then given up on, and the original is kept.
 *
 * Canvas only: the CSP forbids WASM, so there is no other decoder. Nothing here runs outside a browser; a host without
 * `createImageBitmap` gets no decoder at all.
 */

import { jpegOrientation, pixelSize, type ImageFormat, type PictureDecoder } from '@caotang/pictures';

const MIME: Readonly<Record<ImageFormat, string>> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

interface Canvas2D {
  readonly canvas: { convertToBlob?: (options: { type: string; quality?: number }) => Promise<Blob> };
  drawImage(image: ImageBitmap, x: number, y: number): void;
  getImageData(x: number, y: number, w: number, h: number): { readonly data: Uint8ClampedArray };
}

function canvasOf(width: number, height: number): Canvas2D | undefined {
  if (typeof OffscreenCanvas === 'undefined') return undefined;
  const canvas = new OffscreenCanvas(width, height);
  return (canvas.getContext('2d') as unknown as Canvas2D | null) ?? undefined;
}

/** Whether the drawn pixels are all fully transparent black, which is what an over-cap iOS canvas draws. Sampled on a grid. */
function isBlank(context: Canvas2D, width: number, height: number): boolean {
  const step = Math.max(1, Math.floor(Math.min(width, height) / 16));
  for (let y = 0; y < height; y += step) {
    const row = context.getImageData(0, y, width, 1).data;
    for (let x = 0; x < width; x += step) {
      const at = x * 4;
      if ((row[at] ?? 0) !== 0 || (row[at + 1] ?? 0) !== 0 || (row[at + 2] ?? 0) !== 0 || (row[at + 3] ?? 0) !== 0) return false;
    }
  }
  return true;
}

/**
 * The size the picture stands at once its EXIF Orientation is applied, read from the header without decoding. Orientations 5 to 8
 * turn it on its side. `undefined` for a file whose header states no size (HEIC).
 */
function uprightSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const size = pixelSize(bytes);
  if (size === undefined) return undefined;
  const orientation = jpegOrientation(bytes) ?? 1;
  return orientation >= 5 ? { width: size.height, height: size.width } : size;
}

async function encode(bytes: Uint8Array, longEdge: number | undefined, type: string, quality?: number): Promise<Uint8Array | undefined> {
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>]);
  const size = uprightSize(bytes);
  let bitmap: ImageBitmap;
  try {
    if (longEdge === undefined || size === undefined || Math.max(size.width, size.height) <= longEdge) {
      bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } else {
      // Decoded with resize, so the full-size bitmap never exists (§6.4, the iOS canvas cap).
      const scale = longEdge / Math.max(size.width, size.height);
      bitmap = await createImageBitmap(blob, {
        imageOrientation: 'from-image',
        resizeWidth: Math.max(1, Math.round(size.width * scale)),
        resizeHeight: Math.max(1, Math.round(size.height * scale)),
        resizeQuality: 'high',
      });
    }
  } catch {
    return undefined;
  }
  try {
    const context = canvasOf(bitmap.width, bitmap.height);
    if (context?.canvas.convertToBlob === undefined) return undefined;
    context.drawImage(bitmap, 0, 0);
    if (isBlank(context, bitmap.width, bitmap.height)) return undefined;
    const out = await context.canvas.convertToBlob({ type, ...(quality === undefined ? {} : { quality }) });
    if (out.type !== type) return undefined;
    return new Uint8Array(await out.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

/** The browser's decoder, or `undefined` where there is no `createImageBitmap` (a headless run). */
export function browserPictureDecoder(): PictureDecoder | undefined {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return undefined;
  return {
    heicToJpeg: (bytes) => encode(bytes, undefined, 'image/jpeg', 0.9),
    workingCopy: async (bytes, format, maxEdge) => {
      // The working copy keeps its format, so a PNG drawing keeps its transparency; a photo is a JPEG at quality 0.9.
      const type = MIME[format];
      const quality = format === 'png' ? undefined : 0.9;
      return (await encode(bytes, maxEdge, type, quality)) ?? (await encode(bytes, Math.floor(maxEdge / 2), type, quality));
    },
  };
}
