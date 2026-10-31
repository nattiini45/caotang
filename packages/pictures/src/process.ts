/**
 * What every `ProcessPicture` host decides the same way (pictures.md §6.4, §6.4.1): refuse a profile it makes no sense to run,
 * read the header before any pixel is allocated, refuse more than 50,000,000 pixels, and work out the output size and format.
 * The browser (canvas) and Node (JPEG/PNG/WebP codecs) differ only in how they decode, resize and encode, so the rules that must not
 * drift between them live here, as pure functions over bytes.
 *
 * A refusal is a typed {@link PictureRefusal}: a code a caller can branch on, the reason, and the remedy the writer can act on.
 * Nothing in this file decodes a picture.
 */

import { startsWith, u32 } from './bytes.js';
import { decideImportSize, readPictureHeader, sniffPicture } from './asset-files.js';
import { stripPrivateMetadata } from './metadata.js';
import type { Orientation } from './metadata.js';
import type { PictureBytes, PictureMime, PictureProfile } from './model.js';

export type PictureRefusalCode =
  | 'bad-profile'
  | 'unsupported-format'
  | 'heic-unavailable'
  | 'unreadable'
  | 'too-many-pixels'
  | 'unsupported-profile'
  | 'unsupported-colour'
  | 'animated'
  | 'decode-failed'
  | 'encode-failed'
  | 'malformed-metadata';

/** A picture or a profile a host will not run, with what the writer can do about it. */
export class PictureRefusal extends Error {
  readonly code: PictureRefusalCode;
  readonly remedy: string;

  constructor(code: PictureRefusalCode, reason: string, remedy: string) {
    super(`${reason} ${remedy}`);
    this.name = 'PictureRefusal';
    this.code = code;
    this.remedy = remedy;
  }
}

export function isPictureRefusal(value: unknown): value is PictureRefusal {
  return value instanceof PictureRefusal;
}

export type PicturePlan =
  | {
      readonly kind: 'passthrough';
      /** The display size: orientation applied, as the registry records it. */
      readonly width: number;
      readonly height: number;
      readonly mime: PictureMime;
    }
  | {
      readonly kind: 'transcode';
      readonly source: {
        readonly mime: PictureMime;
        /** As stored in the file. */
        readonly width: number;
        readonly height: number;
        readonly orientation: Orientation;
      };
      readonly output: 'image/jpeg' | 'image/png';
      /** The display size of the result. */
      readonly width: number;
      readonly height: number;
      readonly resized: boolean;
    };

export function validateProfile(profile: PictureProfile): void {
  if (!Number.isInteger(profile.maxEdge) || profile.maxEdge < 1) {
    throw new PictureRefusal('bad-profile', `The longest edge must be a whole number of pixels, at least 1; this profile asks for ${String(profile.maxEdge)}.`, 'Use a positive whole number.');
  }
  if (!Number.isFinite(profile.jpegQuality) || profile.jpegQuality <= 0 || profile.jpegQuality > 1) {
    throw new PictureRefusal('bad-profile', `The JPEG quality must be above 0 and at most 1; this profile asks for ${String(profile.jpegQuality)}.`, 'Use a value such as 0.85.');
  }
}

/** The display size of a picture after a long-edge limit; never larger than the picture itself. */
export function fitLongEdge(width: number, height: number, maxEdge: number): { width: number; height: number; resized: boolean } {
  const long = Math.max(width, height);
  if (long <= maxEdge) return { width, height, resized: false };
  const ratio = maxEdge / long;
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)), resized: true };
}

function tooManyPixels(width: number, height: number): PictureRefusal | undefined {
  const decision = decideImportSize({ bytes: 0, width, height });
  return decision.action === 'refuse' ? new PictureRefusal('too-many-pixels', decision.message, 'Export a smaller copy from the program that made it.') : undefined;
}

/**
 * Decides what to do with the bytes before anything is decoded: refuse, hand back the bytes (a `preserve` profile that has nothing
 * to change), or transcode to a size and a format. The header is read first, so a 50,000,000-pixel picture is refused without a
 * bitmap ever being allocated.
 */
export function planPicture(bytes: Uint8Array, profile: PictureProfile): PicturePlan {
  validateProfile(profile);
  const sniffed = sniffPicture(bytes);
  if (!sniffed.ok) {
    if (sniffed.format === 'heic') {
      throw new PictureRefusal('heic-unavailable', 'This is a HEIC photo, and this host cannot open it as a picture.', 'Export it as JPEG, or use the iPhone photo picker.');
    }
    throw new PictureRefusal('unsupported-format', sniffed.reason, 'Choose a PNG, JPEG or WebP picture.');
  }
  const header = readPictureHeader(bytes, sniffed.mime);
  if (!header.ok) throw new PictureRefusal('unreadable', header.reason, 'Choose another file, or export the picture again.');
  const heavy = tooManyPixels(header.width, header.height);
  if (heavy !== undefined) throw heavy;

  const display = fitLongEdge(header.displayWidth, header.displayHeight, profile.maxEdge);
  const mime = sniffed.mime;

  // A profile that asks for nothing is not a reason to re-encode: that would only cost the writer quality.
  const needsFlatten = profile.flattenAlpha && mime !== 'image/jpeg';
  if (profile.output === 'preserve' && !display.resized && !needsFlatten) {
    return { kind: 'passthrough', width: display.width, height: display.height, mime };
  }
  if (profile.output === 'preserve' && mime === 'image/webp') {
    throw new PictureRefusal('unsupported-profile', 'A WebP picture cannot be resized or flattened and kept as WebP here.', 'Choose a JPEG or PNG output for this picture.');
  }
  const output = profile.output === 'jpeg' ? 'image/jpeg' : profile.output === 'png' ? 'image/png' : (mime as 'image/jpeg' | 'image/png');
  return {
    kind: 'transcode',
    source: { mime, width: header.width, height: header.height, orientation: header.orientation },
    output,
    width: display.width,
    height: display.height,
    resized: display.resized,
  };
}

/**
 * The bytes of a passthrough plan, with GPS, maker notes and serial numbers removed when the profile says so. The picture is not
 * re-encoded, so Orientation and the colour profile stay and the stored size is the input's. Metadata that cannot be walked
 * safely is refused, because the host could not promise it is gone.
 */
export function finishPassthrough(bytes: Uint8Array, plan: Extract<PicturePlan, { kind: 'passthrough' }>, profile: PictureProfile): PictureBytes {
  if (!profile.stripMetadata) return { bytes, mime: plan.mime, width: plan.width, height: plan.height };
  const stripped = stripPrivateMetadata(bytes, plan.mime);
  if (!stripped.ok) throw new PictureRefusal('malformed-metadata', stripped.message, 'Export the picture again from the program that made it.');
  return { bytes: stripped.bytes, mime: plan.mime, width: plan.width, height: plan.height };
}

/** What a result must be for a host to hand it back: the bytes sniff as the format asked for, at the size planned. */
export function checkOutput(bytes: Uint8Array, mime: PictureMime, width: number, height: number): void {
  const sniffed = sniffPicture(bytes);
  const header = sniffed.ok && sniffed.mime === mime ? readPictureHeader(bytes, mime) : undefined;
  if (header === undefined || !header.ok || header.width !== width || header.height !== height) {
    throw new PictureRefusal('encode-failed', 'The picture could not be written in the format asked for.', 'Try again, or choose another picture.');
  }
}

const HEIC_SCAN_BYTES = 64 * 1024;

/**
 * The largest picture size a HEIC file states, from its `ispe` (image spatial extents) boxes in the first 64 KiB, before the
 * browser is asked to decode it. `undefined` when there is none: a size that cannot be bounded is a size that cannot be allowed.
 * The size is as coded; a rotation box can turn it on its side, which a pixel budget does not care about.
 */
export function readHeicSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  let best: { width: number; height: number } | undefined;
  const end = Math.min(bytes.length, HEIC_SCAN_BYTES) - 15;
  for (let at = 4; at < end; at += 1) {
    if (!startsWith(bytes, [0x69, 0x73, 0x70, 0x65], at) || u32(bytes, at - 4, false) !== 20) continue;
    const width = u32(bytes, at + 8, false);
    const height = u32(bytes, at + 12, false);
    if (width < 1 || height < 1) continue;
    if (best === undefined || width * height > best.width * best.height) best = { width, height };
  }
  return best;
}

/** The size a HEIC photo states; refuses one that has none, or more pixels than a picture may hold. */
export function checkHeic(bytes: Uint8Array): { width: number; height: number } {
  const size = readHeicSize(bytes);
  if (size === undefined) throw new PictureRefusal('unreadable', 'The HEIC photo\'s size could not be read, so it was not opened.', 'Export it as JPEG, or use the iPhone photo picker.');
  const heavy = tooManyPixels(size.width, size.height);
  if (heavy !== undefined) throw heavy;
  return size;
}
