/**
 * The `assets/` folder's file names and what a file's leading bytes say it is (pictures.md §0, §6.1; storyboard.md §2.2).
 *
 * Moved here from `@caotang/storyboard`, which re-exports them, so the store's import pipeline and the storyboard read one
 * definition. A name is `a_XXXXXXXXXX.<png|jpg|webp>`; the format is decided by the bytes, never by the name, because a file
 * renamed to `.png` is still whatever it is. Unknown files in `assets/` are ignored, not errors (project-format §1).
 */

import { isAssetId } from './ids.js';

/** The folder the pictures live in, project-root-relative. */
export const ASSETS_DIR = 'assets';

export type ImageFormat = 'png' | 'jpeg' | 'webp';

/** The MIME types a stored picture can be (pictures.md §2.1, `AssetRecord.mime`). */
export type PictureMime = 'image/png' | 'image/jpeg' | 'image/webp';

/** The stored formats, with the extension each is stored under and the MIME type it serves as. */
export const IMAGE_FORMATS: Readonly<Record<ImageFormat, { readonly extension: 'png' | 'jpg' | 'webp'; readonly mime: PictureMime }>> = {
  png: { extension: 'png', mime: 'image/png' },
  jpeg: { extension: 'jpg', mime: 'image/jpeg' },
  webp: { extension: 'webp', mime: 'image/webp' },
};

const EXTENSION_FORMATS: Readonly<Record<string, ImageFormat>> = { png: 'png', jpg: 'jpeg', webp: 'webp' };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46];
const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50];
const PSD_SIGNATURE = [0x38, 0x42, 0x50, 0x53];
const EXR_SIGNATURE = [0x76, 0x2f, 0x31, 0x01];
const FTYP = [0x66, 0x74, 0x79, 0x70];

/** The ISO-BMFF brands an iPhone's HEIC or HEIF photo carries in its `ftyp` box. */
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

/** The stored format a file's leading bytes name, or `undefined` for anything else. */
export function sniffImage(bytes: Uint8Array): ImageFormat | undefined {
  if (startsWith(bytes, PNG_SIGNATURE)) return 'png';
  if (startsWith(bytes, JPEG_SIGNATURE)) return 'jpeg';
  if (startsWith(bytes, RIFF_SIGNATURE) && startsWith(bytes, WEBP_SIGNATURE, 8)) return 'webp';
  return undefined;
}

/** Whether the bytes are a HEIC or HEIF photo (an ISO-BMFF `ftyp` box with a HEIF brand), which the import decodes or refuses (§6.4). */
export function isHeif(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || !startsWith(bytes, FTYP, 4)) return false;
  const brand = String.fromCharCode(bytes[8] ?? 0, bytes[9] ?? 0, bytes[10] ?? 0, bytes[11] ?? 0);
  return HEIF_BRANDS.has(brand);
}

/**
 * Whether the bytes look like an SVG drawing. SVG is refused (§6.1): it carries active content into EPUB and MCP. The check
 * reads the first kilobyte as text, past a byte-order mark, an XML declaration and comments, for an `<svg` element.
 */
export function isSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 1024)).replace(/^\uFEFF/, '').trimStart();
  if (!head.startsWith('<')) return false;
  return /<svg[\s>]/i.test(head);
}

/**
 * A name for a format the store refuses, so the refusal can say what the file is. PSD and EXR are deferred (storyboard.md
 * §2.2); HEIC and SVG have their own refusals in the import pipeline, and are named here for the messages that list them.
 */
export function unsupportedFormatName(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, PSD_SIGNATURE)) return 'Photoshop (PSD)';
  if (startsWith(bytes, EXR_SIGNATURE)) return 'OpenEXR';
  if (isHeif(bytes)) return 'HEIC';
  if (isSvg(bytes)) return 'SVG';
  return undefined;
}

export function assetFileName(assetId: string, format: ImageFormat): string {
  return `${assetId}.${IMAGE_FORMATS[format].extension}`;
}

/** An asset id and the format its file name carries. */
export interface AssetName {
  readonly assetId: string;
  readonly format: ImageFormat;
}

/** The asset a file name names, or `undefined` for a name that is not `a_XXXXXXXXXX.<png|jpg|webp>`. */
export function parseAssetFileName(fileName: string): AssetName | undefined {
  const match = /^([^.]+)\.(png|jpg|webp)$/.exec(fileName);
  if (match === null) return undefined;
  const assetId = match[1];
  const extension = match[2];
  if (assetId === undefined || extension === undefined || !isAssetId(assetId)) return undefined;
  const format = EXTENSION_FORMATS[extension];
  return format === undefined ? undefined : { assetId, format };
}

/** The format a MIME type names, or `undefined` for one the store does not keep. */
export function formatOfMime(mime: string): ImageFormat | undefined {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg') return 'jpeg';
  if (mime === 'image/webp') return 'webp';
  return undefined;
}
