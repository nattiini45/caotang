/**
 * The WebP transcoder for the contact sheet's PDF, in the browser: the browser decodes the WebP, a canvas scales it, and the
 * canvas writes it as a PNG for the PDF to embed (the PDF library embeds PNG and JPEG only). It needs no dependency and no
 * WebAssembly, so the Content-Security-Policy stays as it is. Node has its own, over `@jsquash/webp`
 * (`@caotang/exporter/picture-transcoder-node`); this file is the app's side of the same `PictureTranscoder` port.
 *
 * `createImageBitmap` gives the first frame of an animated WebP. Colours are the canvas's: a picture with an embedded colour
 * profile is drawn as the browser converts it to sRGB.
 */

import type { PictureTranscoder } from '@caotang/exporter';

/** The canvas as a PNG: an off-screen canvas where the browser has one, a canvas element where it does not. */
async function pngOf(width: number, height: number, draw: (context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D) => void): Promise<Blob> {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('the browser gave no 2D canvas');
    draw(context);
    return canvas.convertToBlob({ type: 'image/png' });
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('the browser gave no 2D canvas');
  draw(context);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob === null ? reject(new Error('the browser could not write the picture as a PNG')) : resolve(blob)), 'image/png');
  });
}

export const transcodePictureInBrowser: PictureTranscoder = async (bytes, _format, maxPixels) => {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/webp' }));
  try {
    const longer = Math.max(bitmap.width, bitmap.height);
    // Scaled down to the cap, never up.
    const ratio = maxPixels !== undefined && maxPixels >= 1 && longer > maxPixels ? maxPixels / longer : 1;
    const width = Math.max(1, Math.round(bitmap.width * ratio));
    const height = Math.max(1, Math.round(bitmap.height * ratio));
    const png = await pngOf(width, height, (context) => {
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, 0, 0, width, height);
    });
    return new Uint8Array(await png.arrayBuffer());
  } finally {
    bitmap.close();
  }
};
