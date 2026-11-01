/**
 * The WebP transcoder for the contact sheet's PDF, in the browser: the browser decodes the WebP, a canvas scales it, and the
 * canvas writes it as a PNG for the PDF to embed (the PDF library embeds PNG and JPEG only). It needs no dependency and no
 * WebAssembly, so the Content-Security-Policy stays as it is. Node has its own, over `@jsquash/webp`
 * (`@caotang/exporter/picture-transcoder-node`); this file is the app's side of the same `PictureTranscoder` port.
 *
 * `createImageBitmap` gives the first frame of an animated WebP. Colours are the canvas's: a picture with an embedded colour
 * profile is drawn as the browser converts it to sRGB.
 *
 * The same canvas is the app's `ProcessPicture` (`processPictureInBrowser`, below) and its HEIC conversion (`convertHeicInBrowser`).
 */

import { t } from '@lingui/core/macro';

import type { PictureTranscoder } from '@caotang/exporter';
import { PictureRefusal, checkHeic, checkOutput, finishPassthrough, planPicture, sniffPicture } from '@caotang/pictures';
import type { PictureBytes, PictureMime, PicturePlan, PictureProfile, ProcessPicture } from '@caotang/pictures';

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

type Context2d = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/** What the canvas probe draws and expects back, give or take the noise a privacy-minded browser adds to a read-back. */
const PROBE = [254, 1, 127] as const;
const PROBE_TOLERANCE = 12;

function canvasFailed(reason: string): PictureRefusal {
  return new PictureRefusal('decode-failed', reason, t`Close other tabs and try again, or choose a smaller picture.`);
}

/**
 * A canvas of this size, proven to be one. Over a browser's canvas limit (iOS Safari before 18 stops near 16.7 million pixels) a
 * canvas is allocated and then silently blank, so a known pixel is drawn and read back before the picture is: a canvas that
 * cannot hold it is a failure, and a picture that really is white is not.
 */
function makeCanvas(width: number, height: number): { context: Context2d; finish: (type: 'image/png' | 'image/jpeg', quality: number) => Promise<Blob> } {
  const settings: CanvasRenderingContext2DSettings = { colorSpace: 'srgb', alpha: true };
  let context: Context2d | null;
  let finish: (type: 'image/png' | 'image/jpeg', quality: number) => Promise<Blob>;
  try {
    if (typeof OffscreenCanvas === 'function') {
      const canvas = new OffscreenCanvas(width, height);
      context = canvas.getContext('2d', settings);
      finish = (type, quality) => canvas.convertToBlob({ type, quality });
    } else {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      context = canvas.getContext('2d', settings);
      finish = (type, quality) =>
        new Promise((resolve, reject) => {
          canvas.toBlob((blob) => (blob === null ? reject(new Error('no blob')) : resolve(blob)), type, quality);
        });
    }
  } catch {
    throw canvasFailed(t`The browser could not make a canvas big enough for this picture.`);
  }
  if (context === null) throw canvasFailed(t`The browser gave no 2D canvas.`);
  context.fillStyle = `rgb(${PROBE.join(',')})`;
  context.fillRect(0, 0, 1, 1);
  let seen: Uint8ClampedArray;
  try {
    seen = context.getImageData(0, 0, 1, 1).data;
  } catch {
    throw canvasFailed(t`The browser would not let the canvas be read.`);
  }
  if (PROBE.some((expected, i) => Math.abs((seen[i] ?? 0) - expected) > PROBE_TOLERANCE) || (seen[3] ?? 0) < 250) {
    throw canvasFailed(t`The browser made a canvas that does not hold a picture of this size.`);
  }
  context.clearRect(0, 0, 1, 1);
  return { context, finish };
}

/**
 * The picture as a bitmap at its display size. With a size to reach, the browser is asked to decode straight to it, so a full-size
 * bitmap never exists; a browser that answers at another size (it resized before it turned the picture, or not at all) is asked
 * again with no resize and the canvas scales it. A browser that decoded a picture stored on its side without turning it is refused.
 */
async function decodeBitmap(blob: Blob, width: number, height: number, resized: boolean): Promise<ImageBitmap> {
  const base: ImageBitmapOptions = { imageOrientation: 'from-image', colorSpaceConversion: 'default' };
  const open = async (options: ImageBitmapOptions): Promise<ImageBitmap> => {
    try {
      return await createImageBitmap(blob, options);
    } catch {
      throw new PictureRefusal('decode-failed', t`The browser could not decode this picture.`, t`Choose another file, or export the picture again from the program that made it.`);
    }
  };
  let bitmap = await open(resized ? { ...base, resizeWidth: width, resizeHeight: height, resizeQuality: 'high' } : base);
  if (resized && (Math.abs(bitmap.width - width) > 1 || Math.abs(bitmap.height - height) > 1)) {
    bitmap.close();
    bitmap = await open(base);
  }
  if (bitmap.width < 1 || bitmap.height < 1) {
    bitmap.close();
    throw new PictureRefusal('decode-failed', t`The browser decoded this picture to nothing.`, t`Choose another file, or export the picture again from the program that made it.`);
  }
  const aspect = bitmap.width / bitmap.height;
  const wanted = width / height;
  const onItsSide = Math.abs(wanted - 1) > 0.05 && Math.abs(aspect - 1 / wanted) < Math.abs(aspect - wanted);
  if (onItsSide) {
    bitmap.close();
    throw new PictureRefusal('decode-failed', t`This browser did not turn the picture the right way up.`, t`Open the project in a current Chrome, Edge, Firefox or Safari, or export the picture turned.`);
  }
  return bitmap;
}

async function drawn(bitmap: ImageBitmap, width: number, height: number, type: 'image/png' | 'image/jpeg', quality: number, flatten: boolean): Promise<Uint8Array> {
  const { context, finish } = makeCanvas(width, height);
  // A JPEG has no alpha, and a canvas writes transparent pixels as black there.
  if (flatten || type === 'image/jpeg') {
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
  }
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, width, height);
  let blob: Blob;
  try {
    blob = await finish(type, quality);
  } catch {
    throw new PictureRefusal('encode-failed', t`The browser could not write the picture.`, t`Try again, or choose a smaller picture.`);
  }
  // A browser that cannot write a format answers in PNG, so the type it reports is part of the answer.
  if (blob.type !== type || blob.size === 0) {
    const format = type === 'image/jpeg' ? 'JPEG' : 'PNG';
    throw new PictureRefusal('encode-failed', t({ message: `This browser cannot write ${{ format }} pictures.`, comment: 'The value is the image format name, JPEG or PNG.' }), t`Open the project in a current Chrome, Edge, Firefox or Safari.`);
  }
  return new Uint8Array(await blob.arrayBuffer());
}

async function transcodeOnCanvas(bytes: Uint8Array, plan: Extract<PicturePlan, { kind: 'transcode' }>, profile: PictureProfile): Promise<PictureBytes> {
  const bitmap = await decodeBitmap(new Blob([bytes as BlobPart], { type: plan.source.mime }), plan.width, plan.height, plan.resized);
  try {
    const out = await drawn(bitmap, plan.width, plan.height, plan.output, profile.jpegQuality, profile.flattenAlpha);
    checkOutput(out, plan.output, plan.width, plan.height);
    return { bytes: out, mime: plan.output, width: plan.width, height: plan.height };
  } finally {
    bitmap.close();
  }
}

/**
 * The app's `ProcessPicture`: `createImageBitmap` decodes, turns the picture by its EXIF orientation, converts its colour
 * profile to sRGB and resizes on decode; a canvas flattens and writes JPEG or PNG. The rules before any of that (the header
 * read, the 50,000,000-pixel refusal, the size and format) are `planPicture`, shared with Node. A canvas result carries no
 * metadata at all, and an animated WebP gives its first frame. Refusals are `PictureRefusal`s.
 */
export const processPictureInBrowser: ProcessPicture = async (input, profile) => {
  const plan = planPicture(input.bytes, profile);
  if (plan.kind === 'passthrough') return finishPassthrough(input.bytes, plan, profile);
  return transcodeOnCanvas(input.bytes, plan, profile);
};

/**
 * The browser side of `pictures.view`: decode once at the requested display size and write a transient PNG or JPEG.
 * WebP becomes PNG on resize; the stored file is untouched. The view port checks the returned dimensions and bytes again.
 */
export async function resizePictureInBrowser(picture: PictureBytes, longEdge: number): Promise<PictureBytes> {
  const edge = Math.max(picture.width, picture.height);
  const ratio = edge > longEdge ? longEdge / edge : 1;
  const width = Math.max(1, Math.round(picture.width * ratio));
  const height = Math.max(1, Math.round(picture.height * ratio));
  const output = picture.mime === 'image/jpeg' ? ('image/jpeg' as const) : ('image/png' as const);
  const bitmap = await decodeBitmap(new Blob([picture.bytes as BlobPart], { type: picture.mime }), width, height, ratio < 1);
  try {
    const bytes = await drawn(bitmap, width, height, output, 0.9, false);
    checkOutput(bytes, output, width, height);
    return { bytes, mime: output, width, height };
  } finally {
    bitmap.close();
  }
}

const HEIC_QUALITY = 0.9;

/**
 * A HEIC photo as JPEG at quality 0.9 (pictures.md §6.4 step 2), where this browser decodes HEIC (Safari). Nothing in a page can
 * ask whether a codec is there before using it, so the browser is asked to decode, and a browser that cannot gives the refusal
 * with its remedy. The stated size is checked first, so a photo over 50,000,000 pixels is never handed to the decoder.
 */
export async function convertHeicInBrowser(bytes: Uint8Array): Promise<PictureBytes> {
  const sniffed = sniffPicture(bytes);
  if (sniffed.ok || sniffed.format !== 'heic') {
    throw new PictureRefusal('unsupported-format', t`This is not a HEIC photo.`, t`Choose a HEIC, PNG, JPEG or WebP picture.`);
  }
  checkHeic(bytes);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/heic' }), { imageOrientation: 'from-image', colorSpaceConversion: 'default' });
  } catch {
    throw new PictureRefusal('heic-unavailable', t`This browser cannot open HEIC photos.`, t`Export it as JPEG, or use the iPhone photo picker.`);
  }
  try {
    const { width, height } = bitmap;
    if (width < 1 || height < 1 || width * height > 50_000_000) {
      throw new PictureRefusal('too-many-pixels', t`The HEIC photo is larger than a picture may be.`, t`Export a smaller copy from the program that made it.`);
    }
    const out = await drawn(bitmap, width, height, 'image/jpeg', HEIC_QUALITY, true);
    checkOutput(out, 'image/jpeg', width, height);
    return { bytes: out, mime: 'image/jpeg' satisfies PictureMime, width, height };
  } finally {
    bitmap.close();
  }
}
