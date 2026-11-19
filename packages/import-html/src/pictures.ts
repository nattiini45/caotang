/**
 * The pictures a page names but the import cannot resolve (#299). A ref with no bytes behind it would be written into the
 * writer's manuscript as `![alt](import:html-image-0-3)`, a target that resolves to nothing, so the words beside it are kept
 * instead and the target is named as a loss. The block count does not change, so the splitter's indexes and the losses that
 * point at a block still line up.
 */

import type { ImportBlock, LossWarning } from '@caotang/import-core';

/** How many targets the report names before it counts the rest. */
const NAMED_LIMIT = 20;

/**
 * What the picture pipeline stores (pictures.md §6.4, `packages/pictures/src/limits.ts`): a PNG, JPEG or WebP of at most 16 MB and
 * 50 megapixels. The commit runs that pipeline in strict mode over the whole batch, so one picture it refuses refuses the entire
 * import. The reader therefore offers only bytes the pipeline will take, and everything else keeps its alt text and is named.
 * The header parsing below follows `packages/pictures/src/dimensions.ts`, so the two agree on what a file's size is.
 */
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_PIXELS = 50_000_000;

export type PictureRefusal = 'format' | 'size';

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  signature.every((byte, index) => bytes[offset + index] === byte);

const u16be = (bytes: Uint8Array, at: number): number => ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
const u32be = (bytes: Uint8Array, at: number): number =>
  (((bytes[at] ?? 0) << 24) >>> 0) + ((bytes[at + 1] ?? 0) << 16) + ((bytes[at + 2] ?? 0) << 8) + (bytes[at + 3] ?? 0);
const u16le = (bytes: Uint8Array, at: number): number => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
const u24le = (bytes: Uint8Array, at: number): number => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16);

const isStartOfFrame = (marker: number): boolean =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

function jpegSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = u16be(bytes, at + 2);
    if (length < 2) return undefined;
    if (isStartOfFrame(marker)) {
      if (at + 9 > bytes.length) return undefined;
      return { height: u16be(bytes, at + 5), width: u16be(bytes, at + 7) };
    }
    at += 2 + length;
  }
  return undefined;
}

function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 24 || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return undefined;
  return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

function webpSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 30) return undefined;
  const chunk = String.fromCharCode(...bytes.subarray(12, 16));
  if (chunk === 'VP8X') return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
  if (chunk === 'VP8 ') {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return undefined;
    return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) return undefined;
    const b1 = bytes[21] ?? 0;
    const b2 = bytes[22] ?? 0;
    const b3 = bytes[23] ?? 0;
    const b4 = bytes[24] ?? 0;
    return { width: 1 + (((b2 & 0x3f) << 8) | b1), height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)) };
  }
  return undefined;
}

/**
 * Why these bytes cannot be stored as a picture, or `undefined` when they can. A size the header does not state is not held
 * against the picture: only a size actually read above the budget refuses it.
 */
export function pictureRefusal(bytes: Uint8Array): PictureRefusal | undefined {
  if (bytes.length === 0) return 'format';
  if (bytes.length > MAX_BYTES) return 'size';
  const png = startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpeg = startsWith(bytes, [0xff, 0xd8, 0xff]);
  const webp = startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8);
  if (!png && !jpeg && !webp) return 'format';
  const size = png ? pngSize(bytes) : jpeg ? jpegSize(bytes) : webpSize(bytes);
  if (size !== undefined && size.width > 0 && size.height > 0 && size.width * size.height > MAX_PIXELS) return 'size';
  return undefined;
}

/** An inline picture whose target is one of the reader's own refs. The alt may carry escaped brackets (`\]`, `\\`), as the walker writes them. */
const INLINE_IMAGE = /!\[((?:\\.|[^\]\\])*)\]\((import:[A-Za-z0-9._/-]+)\)/g;

/**
 * The relative target as paths to try inside the archive: its own folder first, then the archive root, `..` climbing. A path that
 * climbs above the archive root offers nothing: not beside the page, and not at the root either, even when the root carries its name.
 */
export function relativeCandidates(pagePath: string, target: string): readonly string[] {
  const clean = target.replace(/[?#].*$/, '');
  const parts = pagePath.split('/').slice(0, -1);
  const out: string[] = [];
  const walk = clean.split('/');
  const stack = [...parts];
  let above = false;
  for (const piece of walk) {
    if (piece === '' || piece === '.') continue;
    if (piece === '..') {
      if (stack.length === 0) above = true;
      else stack.pop();
      continue;
    }
    stack.push(piece);
  }
  if (above) return out;
  out.push(stack.join('/'));
  const root = walk.filter((piece) => piece !== '' && piece !== '.' && piece !== '..').join('/');
  if (root !== '' && !out.includes(root)) out.push(root);
  return out;
}

/** The blocks with every unresolved picture turned into its alt text, and one loss naming the targets. */
export function dropUnresolvedPictures(
  blocks: readonly ImportBlock[],
  resolved: ReadonlySet<string>,
  targets: ReadonlyMap<string, string>,
  refused: ReadonlyMap<string, PictureRefusal> = new Map(),
): { readonly blocks: ImportBlock[]; readonly losses: LossWarning[] } {
  const missing = new Map<string, string>();
  const unusable = new Map<string, PictureRefusal>();
  const note = (ref: string): void => {
    if (resolved.has(ref) || !targets.has(ref)) return;
    const why = refused.get(ref);
    if (why !== undefined) unusable.set(targets.get(ref) as string, why);
    else missing.set(targets.get(ref) as string, ref);
  };
  const inline = (text: string): string =>
    text.replace(INLINE_IMAGE, (whole, alt: string, ref: string) => {
      if (resolved.has(ref) || !targets.has(ref)) return whole;
      note(ref);
      return alt;
    });

  const out = blocks.map((block, index): ImportBlock => {
    if (block.kind === 'image') {
      if (resolved.has(block.assetRef) || !targets.has(block.assetRef)) return block;
      note(block.assetRef);
      const alt = block.alt.trim();
      return alt === '' ? { kind: 'para', md: '', text: '' } : { kind: 'para', md: alt, text: alt };
    }
    if (block.kind === 'para') return { ...block, md: inline(block.md), text: inline(block.text) };
    if (block.kind === 'heading') return { ...block, md: inline(block.md), text: inline(block.text) };
    if (block.kind === 'other') return { ...block, md: inline(block.md) };
    void index;
    return block;
  });

  if (missing.size === 0 && unusable.size === 0) return { blocks: out, losses: [] };
  const listOf = (names: readonly string[]): string => {
    // A `data:` URI is not a name a writer can read; every embedded picture answers to the same words.
    const shown = [...new Set(names.map((name) => (name.startsWith('data:') ? 'an embedded picture' : name)))];
    const named = shown.slice(0, NAMED_LIMIT);
    const rest = shown.length - named.length;
    return `${named.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}`;
  };
  const losses: LossWarning[] = [];
  if (missing.size > 0) {
    losses.push({
      code: 'image-unreadable',
      message: `${listOf([...missing.keys()])} could not be read from the file; the words beside each picture are kept.`,
      count: missing.size,
    });
  }
  if (unusable.size > 0) {
    const byFormat = [...unusable.entries()].filter(([, why]) => why === 'format').map(([name]) => name);
    const bySize = [...unusable.entries()].filter(([, why]) => why === 'size').map(([name]) => name);
    if (byFormat.length > 0) {
      losses.push({
        code: 'image-unreadable',
        message: `${listOf(byFormat)} is not a PNG, JPEG or WebP picture, so it is not imported; the words beside each picture are kept.`,
        count: byFormat.length,
      });
    }
    if (bySize.length > 0) {
      losses.push({
        code: 'image-unreadable',
        message: `${listOf(bySize)} is larger than a picture may be (16 MB and 50 megapixels), so it is not imported; the words beside each picture are kept.`,
        count: bySize.length,
      });
    }
  }
  return { blocks: out, losses };
}
