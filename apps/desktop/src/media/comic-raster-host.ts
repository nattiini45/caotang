/**
 * The browser behind the comic raster (`comic-raster.ts`): a canvas to draw on, `createImageBitmap` to decode a picture, and the lettering
 * `FontFace`s registered on the document under the families the page view and the PDF use. Everything the raster decides is in that file and
 * is tested without a browser; this file only reaches for the browser's objects, so a real canvas is the one thing here that is not unit tested.
 */

import { BANGERS_FAMILY, COMIC_NEUE_FAMILY } from '@caotang/comic';
import type { ComicLetteringFace } from '@caotang/pdf-fonts';

import { loadComicLetteringFontOverHttp } from '../app/fallback-fonts.js';
import type { ComicRasterHost, RasterImage, RasterSurface } from './comic-raster.js';

interface FaceSpec {
  readonly face: ComicLetteringFace;
  readonly family: string;
  readonly weight: string;
  readonly style: string;
}

/** The five faces, registered under descriptors that match the CSS `fontFor` writes, so a canvas font string finds each one. */
const FACES: readonly FaceSpec[] = [
  { face: 'regular', family: COMIC_NEUE_FAMILY, weight: '400', style: 'normal' },
  { face: 'italic', family: COMIC_NEUE_FAMILY, weight: '400', style: 'italic' },
  { face: 'bold', family: COMIC_NEUE_FAMILY, weight: '700', style: 'normal' },
  { face: 'bold-italic', family: COMIC_NEUE_FAMILY, weight: '700', style: 'italic' },
  { face: 'sfx', family: BANGERS_FAMILY, weight: '400', style: 'normal' },
];

let registered: Promise<void> | undefined;

async function registerFaces(): Promise<void> {
  await Promise.all(
    FACES.map(async (spec) => {
      const bytes = await loadComicLetteringFontOverHttp(spec.face);
      const font = new FontFace(spec.family, bytes as BufferSource, { weight: spec.weight, style: spec.style });
      await font.load();
      document.fonts.add(font);
    }),
  );
}

function loadFaces(signal: AbortSignal): Promise<void> {
  // One registration per page load; a failed one is tried again by the next export.
  registered ??= registerFaces().catch((error: unknown) => {
    registered = undefined;
    throw error;
  });
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason instanceof Error ? signal.reason : new Error('the comic export was cancelled'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    registered!.then(
      () => {
        signal.removeEventListener('abort', abort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function createSurface(width: number, height: number): RasterSurface {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('this browser gave no canvas to draw the comic on');
  return {
    context,
    encode: (type, quality) =>
      new Promise<Uint8Array>((resolve, reject) => {
        canvas.toBlob(
          (blob) => {
            if (blob === null) {
              reject(new Error('the browser could not encode the page as a JPEG'));
              return;
            }
            blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
          },
          type,
          quality,
        );
      }).finally(() => {
        // Releases the pixel store at once rather than when the canvas is collected: the next page draws on a new one.
        canvas.width = 0;
        canvas.height = 0;
      }),
  };
}

async function decodePicture(bytes: Uint8Array): Promise<RasterImage | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes as BlobPart]), { imageOrientation: 'from-image' });
  } catch {
    return null;
  }
  return { width: bitmap.width, height: bitmap.height, source: bitmap, close: () => bitmap.close() };
}

/** The raster's host over this window's canvas, fonts and image decoder. */
export const browserRasterHost: ComicRasterHost = { loadFaces, createSurface, decodePicture };
