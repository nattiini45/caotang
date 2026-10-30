/**
 * The `assets/` folder — [storyboard.md](../../../docs/architecture/storyboard.md) §2.2's image store,
 * held through the store's byte port.
 *
 * What the spec fixes, and what this file keeps: a flat folder beside `docs/`, opaque-id filenames
 * (`a_XXXXXXXXXX.<ext>`), PNG, JPEG and WebP only in v1, and images that never leave the project
 * folder. A manifest refers to an image by id and never by path, so the folder can be moved, zipped
 * or synced without a reference breaking.
 *
 * The file names, the formats and the sniff live in `@caotang/pictures` (pictures.md §2.1) and are re-exported here.
 *
 * Bytes move through `readBytes` and `writeBytesAtomic` (the port's byte methods, added for the
 * exporter's DOCX and EPUB output). The format is decided by the file's leading bytes, never by its
 * name, because a file renamed to `.png` is still whatever it is. A file that is not an image is
 * refused on import and treated as absent on read.
 *
 * Unknown files in `assets/` are ignored, not errors (project-format §1). A temp file a
 * crashed atomic write can leave behind is one of them, which is why a name must match the
 * pattern exactly to count as an asset.
 */

import { ArtifactNotFoundError, nodeById, type ArtifactFs, type ProjectState, type TreeNode } from '@caotang/store';
import type { RandomBytes } from '@caotang/ids';

import {
  ASSETS_DIR,
  IMAGE_FORMATS,
  assetFileName,
  isAssetId,
  mintAssetId,
  parseAssetFileName,
  sniffImage,
  unsupportedFormatName,
  type AssetName,
  type ImageFormat,
} from '@caotang/pictures';
import { isShotNode } from './model.js';
import { shotFieldOf } from './nodes.js';
import { isPlainObject, storedOf } from './shot-meta.js';
import { ok, refuse, type StoryboardResult } from './result.js';

export {
  ASSETS_DIR,
  IMAGE_FORMATS,
  assetFileName,
  parseAssetFileName,
  sniffImage,
  unsupportedFormatName,
  type AssetName,
  type ImageFormat,
} from '@caotang/pictures';

/** An asset file found in `assets/`, with the path the byte port reads it from. */
export interface StoredAsset extends AssetName {
  readonly fileName: string;
  readonly path: string;
  readonly mime: string;
}

/** Every asset file in `assets/`, sorted by id. Files that do not match the name pattern are not assets. */
export async function listAssets(fs: ArtifactFs): Promise<StoredAsset[]> {
  const names = await fs.listFiles(ASSETS_DIR);
  const assets: StoredAsset[] = [];
  for (const fileName of names) {
    const parsed = parseAssetFileName(fileName);
    if (parsed === undefined) continue;
    assets.push({
      ...parsed,
      fileName,
      path: `${ASSETS_DIR}/${fileName}`,
      mime: IMAGE_FORMATS[parsed.format].mime,
    });
  }
  return assets.sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
}

/** The ids of every asset present, as a set the shot checks take. */
export async function presentAssetIds(fs: ArtifactFs): Promise<Set<string>> {
  return new Set((await listAssets(fs)).map((asset) => asset.assetId));
}

export interface ImportedImage extends StoredAsset {
  /** Byte length of the file as written. */
  readonly bytes: number;
}

/**
 * Writes an image into `assets/` under a fresh id, through `writeBytesAtomic`. The format comes from
 * the bytes; the id is minted against every asset already present, so an import never overwrites.
 * The caller then sets the shot's `image` to the returned `assetId`, as one undo group, so this
 * function writes the file and nothing else.
 */
export async function importImage(
  fs: ArtifactFs,
  bytes: Uint8Array,
  options: { readonly taken?: ReadonlySet<string>; readonly randomBytes?: RandomBytes } = {},
): Promise<StoryboardResult<ImportedImage>> {
  if (bytes.length === 0) return refuse('image-empty', 'the file is empty; choose a PNG, JPEG or WebP image');
  const format = sniffImage(bytes);
  if (format === undefined) {
    const named = unsupportedFormatName(bytes);
    return refuse(
      'image-format',
      named === undefined
        ? 'the file is not a PNG, JPEG or WebP image, which are the v1 formats'
        : `the file is a ${named} file; v1 takes PNG, JPEG or WebP, so export the frame in one of those first`,
    );
  }

  const existing = await listAssets(fs);
  const taken = new Set<string>([...(options.taken ?? []), ...existing.map((asset) => asset.assetId)]);
  const assetId = mintAssetId(taken, options.randomBytes);
  const fileName = assetFileName(assetId, format);
  const path = `${ASSETS_DIR}/${fileName}`;

  await fs.ensureDir(ASSETS_DIR);
  await fs.writeBytesAtomic(path, bytes);
  return ok({ assetId, format, fileName, path, mime: IMAGE_FORMATS[format].mime, bytes: bytes.length });
}

/** An image read back from `assets/`, with the format its bytes actually are. */
export interface LoadedImage {
  readonly assetId: string;
  readonly bytes: Uint8Array;
  readonly format: ImageFormat;
  readonly mime: string;
}

/**
 * The bytes of one asset, or `undefined` when there is no such asset or its file is not an image.
 * A missing image is a state the contact sheet draws a placeholder for, not an error, so the
 * absence is returned rather than thrown.
 */
export async function readImage(fs: ArtifactFs, assetId: string): Promise<LoadedImage | undefined> {
  if (!isAssetId(assetId)) return undefined;
  const asset = (await listAssets(fs)).find((candidate) => candidate.assetId === assetId);
  if (asset === undefined) return undefined;
  let bytes: Uint8Array;
  try {
    bytes = await fs.readBytes(asset.path);
  } catch (error) {
    if (error instanceof ArtifactNotFoundError) return undefined;
    throw error;
  }
  const format = sniffImage(bytes);
  if (format === undefined) return undefined;
  return { assetId, bytes, format, mime: IMAGE_FORMATS[format].mime };
}

/** A shot whose `image` names an asset that is not in `assets/`. */
export interface DanglingImage {
  readonly nodeId: string;
  readonly assetId: string;
}

/** The shots whose image reference points at no file. §2.2: a dangling id is a warning, never a load failure. */
export function danglingImages(nodes: readonly TreeNode[], present: ReadonlySet<string>): DanglingImage[] {
  const out: DanglingImage[] = [];
  for (const node of nodes) {
    if (!isShotNode(node)) continue;
    const image = storedOf(shotFieldOf(node))?.image;
    if (typeof image === 'string' && !present.has(image)) out.push({ nodeId: node.id, assetId: image });
  }
  return out;
}

/**
 * Drops the dangling image references in place, and returns one notice per drop. This is the load
 * step §2.2 names: "`image` dangling id → field dropped with load warning". Only the `image` key is
 * removed; the rest of the shot's metadata is untouched.
 */
export function dropDanglingImages(state: ProjectState, present: ReadonlySet<string>): string[] {
  const notices: string[] = [];
  for (const dangling of danglingImages(state.manifest.tree, present)) {
    const node = nodeById(state, dangling.nodeId);
    const stored = node === undefined ? undefined : shotFieldOf(node);
    if (!isPlainObject(stored)) continue;
    delete stored.image;
    notices.push(`shot ${dangling.nodeId}: image ${dangling.assetId} is not in assets/; the reference was dropped`);
  }
  return notices;
}
