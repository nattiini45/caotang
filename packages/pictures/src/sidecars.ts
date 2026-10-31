/**
 * XMP and IPTC removal — pictures.md §6.4 step 4. Both are whole segments or chunks beside the EXIF
 * block, so they are cut out rather than rewritten; the container's own sizes are then repaired. They
 * can carry the same private facts as EXIF (GPS, camera serials, owner names), so the privacy gate
 * is not met by the EXIF strip alone. ICC profiles and the EXIF Orientation are never touched.
 */

import { ascii, concatBytes, startsWith, u32, writeU32 } from './bytes.js';
import { walkJpeg, walkPng, walkWebp, type Segment } from './containers.js';
import type { PictureMime } from './model.js';

export type SidecarKind = 'xmp' | 'iptc';

export type SidecarResult =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly removed: readonly SidecarKind[] }
  | { readonly ok: false; readonly message: string };

const XMP_JPEG_HEADER = 'http://ns.adobe.com/xap/1.0/\0';
const XMP_EXTENSION_HEADER = 'http://ns.adobe.com/xmp/extension/\0';
const PHOTOSHOP_HEADER = 'Photoshop 3.0\0';

const PNG_TEXT_TYPES = new Set(['tEXt', 'zTXt', 'iTXt']);
const PNG_XMP_KEYWORDS = new Set(['xml:com.adobe.xmp', 'raw profile type xmp']);
const PNG_IPTC_KEYWORDS = new Set(['raw profile type iptc']);

function startsWithText(bytes: Uint8Array, at: number, text: string): boolean {
  return startsWith(bytes, Array.from(text, (ch) => ch.charCodeAt(0)), at);
}

function jpegKind(bytes: Uint8Array, seg: Segment): SidecarKind | undefined {
  if (seg.type === 0xe1 && (startsWithText(bytes, seg.dataStart, XMP_JPEG_HEADER) || startsWithText(bytes, seg.dataStart, XMP_EXTENSION_HEADER))) return 'xmp';
  if (seg.type === 0xed && startsWithText(bytes, seg.dataStart, PHOTOSHOP_HEADER)) return 'iptc';
  return undefined;
}

function pngKind(bytes: Uint8Array, chunk: Segment): SidecarKind | undefined {
  if (typeof chunk.type !== 'string' || !PNG_TEXT_TYPES.has(chunk.type)) return undefined;
  let end = chunk.dataStart;
  while (end < chunk.dataEnd && end - chunk.dataStart < 80 && bytes[end] !== 0) end += 1;
  const keyword = ascii(bytes, chunk.dataStart, end - chunk.dataStart).toLowerCase();
  if (PNG_XMP_KEYWORDS.has(keyword)) return 'xmp';
  if (PNG_IPTC_KEYWORDS.has(keyword)) return 'iptc';
  return undefined;
}

function cut(bytes: Uint8Array, drop: readonly Segment[]): Uint8Array {
  const parts: Uint8Array[] = [];
  let from = 0;
  for (const seg of drop) {
    parts.push(bytes.subarray(from, seg.start));
    from = seg.end;
  }
  parts.push(bytes.subarray(from));
  return concatBytes(parts);
}

/** Removes XMP and IPTC from a picture; a file with neither is returned as the same array. */
export function stripSidecars(bytes: Uint8Array, mime: PictureMime): SidecarResult {
  const drop: Segment[] = [];
  const kinds = new Set<SidecarKind>();
  const note = (seg: Segment, kind: SidecarKind | undefined): void => {
    if (kind === undefined) return;
    drop.push(seg);
    kinds.add(kind);
  };

  if (mime === 'image/jpeg') {
    const walked = walkJpeg(bytes);
    if (!walked.ok) return walked;
    for (const seg of walked.value.segments) note(seg, jpegKind(bytes, seg));
  } else if (mime === 'image/png') {
    const walked = walkPng(bytes);
    if (!walked.ok) return walked;
    for (const chunk of walked.value.chunks) note(chunk, pngKind(bytes, chunk));
  } else {
    const walked = walkWebp(bytes);
    if (!walked.ok) return walked;
    for (const chunk of walked.value.chunks) note(chunk, chunk.type === 'XMP ' ? 'xmp' : undefined);
  }
  if (drop.length === 0) return { ok: true, bytes, removed: [] };

  const out = cut(bytes, drop);
  if (mime === 'image/webp') {
    writeU32(out, 4, u32(bytes, 4, true) - (bytes.length - out.length), true);
    // 'VP8X' is the first chunk when present; its XMP flag must not promise a chunk that is gone.
    if (ascii(out, 12, 4) === 'VP8X') out[20] = (out[20] ?? 0) & ~0x04;
  }
  return { ok: true, bytes: out, removed: [...kinds] };
}
