/**
 * The board's small thumbnail (pictures.md §6.5): one bounded size, made with the canvas path the app already has, kept only in this
 * browser's thumbnail store and never in the project folder, the manifest, the app database or a bundle.
 *
 * A thumbnail that fails, or comes back empty, is made once more at half the size; a second failure is the placeholder. An empty or
 * unreadable output is the failure the retry is for. A uniform picture, white included, is content and is kept: nothing here treats
 * "it is all one colour" as a sign of a broken decode, because the canvas itself is proven before anything is drawn on it
 * (picture-transcoder.ts `makeCanvas`).
 */

import { readPictureHeader, sniffPicture } from '@caotang/pictures';
import type { PictureBytes, ProcessPicture } from '@caotang/pictures';

/** The long edge of the board's S thumbnail. The one thumbnail size: a second size would be a second store row per picture. */
export const THUMB_EDGE = 256;

/** The smallest edge a retry shrinks to, so a tiny request never asks for a zero-pixel canvas. */
const THUMB_FLOOR = 16;

function thumbProfile(edge: number): Parameters<ProcessPicture>[1] {
  return { maxEdge: edge, output: 'jpeg', jpegQuality: 0.8, flattenAlpha: true, stripMetadata: true };
}

/** Whether the bytes are a picture a browser can show: they sniff as one and their header reads at a size above zero. */
export function isUsableThumbnail(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  const sniffed = sniffPicture(bytes);
  if (!sniffed.ok) return false;
  const header = readPictureHeader(bytes, sniffed.mime);
  return header.ok && header.width > 0 && header.height > 0;
}

/**
 * A thumbnail of the picture at {@link THUMB_EDGE}, retried once at half that size when the first attempt throws or comes back
 * unusable. Rejects when the retry fails too, and the caller shows the placeholder.
 */
export async function makeThumbnail(process: ProcessPicture, input: PictureBytes, edge: number = THUMB_EDGE): Promise<Uint8Array> {
  const attempt = async (size: number): Promise<Uint8Array | null> => {
    try {
      const out = await process(input, thumbProfile(size));
      return isUsableThumbnail(out.bytes) ? out.bytes : null;
    } catch {
      return null;
    }
  };
  const first = await attempt(edge);
  if (first !== null) return first;
  const second = await attempt(Math.max(THUMB_FLOOR, Math.floor(edge / 2)));
  if (second !== null) return second;
  throw new Error('the thumbnail could not be made at either size');
}
