/**
 * The image slot of a shot card (storyboard.md §3.1–3.2): which files a card takes, and the commands that point a shot at an
 * image already in the project. Nothing here applies anything. An import is the bus's `shot.importImage` (commit.ts), and an
 * assignment or a removal is a `shot.setMeta` the storyboard engine checks before it is built.
 */

import { nodeById, type ProjectState } from '@caotang/store';

import { isShotNode, readShotMeta, shotFieldOf, storedValueOf, type ShotCommand, type StoryboardResult } from './engines.js';

/** The file types a card takes (storyboard.md §2.2: PNG, JPEG and WebP in v1). */
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp';

/**
 * Whether a file is one of the three picture types. The browser's declared type decides; a file with no declared type is judged
 * by its name. The store checks the leading bytes again on import, so this only keeps obvious non-pictures off the drop target.
 */
export function isPictureFile(file: { readonly type: string; readonly name: string }): boolean {
  if (file.type === 'image/png' || file.type === 'image/jpeg' || file.type === 'image/webp') return true;
  return file.type === '' && /\.(png|jpe?g|webp)$/i.test(file.name);
}

/** The first picture among a list of files, as a drop or a paste offers them. */
export function firstPicture<F extends { readonly type: string; readonly name: string }>(files: Iterable<F>): F | undefined {
  for (const file of files) if (isPictureFile(file)) return file;
  return undefined;
}

/**
 * Where the project's list of pictures stands: still loading, listed, or failed to list. A picture is only known to be missing once
 * the list has come back without it, so the note below waits for `listed`.
 */
export type PictureListing = 'pending' | 'listed' | 'failed';

/**
 * The words the image picker shows for a shot's picture that the project's list does not hold. The sentence that says the picture is
 * gone is shown only once the list has settled, because while the list loads the picture is not yet known to be missing.
 */
export function missingPictureLabelOf(listing: PictureListing): string {
  if (listing === 'listed') return 'This picture is no longer in the project';
  if (listing === 'failed') return 'This picture could not be checked';
  return 'Checking the project’s pictures';
}

/** A listing the asset hook holds: the folder it was taken from, the version it was taken at, its records and its state. */
export interface HeldListing<Source, Item> {
  readonly source: Source | undefined;
  readonly version: number | null;
  readonly map: ReadonlyMap<string, Item>;
  readonly listing: PictureListing;
}

/**
 * What the asset hook (`useAssetListing`) shows, from the listing it holds. With no folder nothing can be listed, so it is `failed`. A
 * listing of another folder is not shown, and reads as `pending`. A listing taken at an earlier version is shown, but reads as
 * `pending`, so a picture added since is not called missing before the new listing has it.
 */
export function shownListingOf<Source, Item>(
  source: Source | undefined,
  version: number,
  held: HeldListing<Source, Item>,
): { readonly records: ReadonlyMap<string, Item>; readonly listing: PictureListing } {
  if (source === undefined) return { records: new Map(), listing: 'failed' };
  if (held.source !== source) return { records: new Map(), listing: 'pending' };
  return { records: held.map, listing: held.version === version ? held.listing : 'pending' };
}

/** The `shot.setMeta` that removes a shot's image reference, and leaves every other field as it is. */
export function clearImageCommand(state: ProjectState, shotId: string): StoryboardResult<ShotCommand> {
  return rewriteImage(state, shotId, undefined);
}

/** The `shot.setMeta` that points a shot at an image already in the project's `assets/` folder. */
export function assignImageCommand(state: ProjectState, shotId: string, assetId: string): StoryboardResult<ShotCommand> {
  return rewriteImage(state, shotId, assetId);
}

function rewriteImage(state: ProjectState, shotId: string, assetId: string | undefined): StoryboardResult<ShotCommand> {
  const node = nodeById(state, shotId);
  if (node === undefined || !isShotNode(node)) {
    return { ok: false, refusal: { code: 'not-a-shot', message: `no shot "${shotId}" to give a picture` } };
  }
  const raw = shotFieldOf(node);
  const base: Record<string, unknown> = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  if (assetId === undefined) delete base.image;
  else base.image = assetId;
  const stored = storedValueOf(readShotMeta(base));
  const empty = stored === null || typeof stored !== 'object' || Object.keys(stored).length === 0;
  return {
    ok: true,
    value: {
      name: 'shot.setMeta',
      params: {
        nodeId: shotId,
        stored: empty ? null : (stored as Readonly<Record<string, unknown>>),
        expect: raw === undefined ? null : raw,
      },
    },
  };
}
