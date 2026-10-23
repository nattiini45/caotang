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
 * The shot number a photograph's file name starts with (storyboard.md §6, the paper-photo round trip): the run of digits at the start of
 * the name, read before the extension, so `007.jpg`, `7.jpg`, `007-ferry.jpg` and `7 (1).jpeg` name shot 7. The digits must end at the end
 * of the name or at a character that is not a letter or a number, so `7a.jpg` names no shot, and a camera's `IMG_0007.jpg` names none
 * either, because a camera counts its own pictures. `undefined` when the name starts with no digit.
 */
export function shotNumberOfFileName(name: string): number | undefined {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  let end = 0;
  while (end < stem.length && stem.charCodeAt(end) >= 48 && stem.charCodeAt(end) <= 57) end += 1;
  if (end === 0) return undefined;
  const next = stem.codePointAt(end);
  if (next !== undefined && /^[\p{L}\p{N}]$/u.test(String.fromCodePoint(next))) return undefined;
  return Number(stem.slice(0, end));
}

/** A shot of the board a drop lands on: its id, the number its card shows (storyboard.md §2.2) and its title. */
export interface BoardShot {
  readonly id: string;
  readonly number: number;
  readonly title: string;
}

/** What one dropped file comes to: a picture for a shot, or a file left out with the reason, in words for the writer. */
export type DropVerdict =
  | { readonly kind: 'import'; readonly file: number; readonly name: string; readonly shot: BoardShot }
  | { readonly kind: 'left-out'; readonly file: number; readonly name: string; readonly reason: string; readonly beyond?: number };

/**
 * Matches the files of a drop on the board to the board's shots by name. A file is left out when it is not a PNG, JPEG or WebP picture,
 * when its name starts with no shot number (or with 0), when its number is past the board's last shot, or when another file of the same
 * drop names the same shot: neither of two files is imported then, since the app cannot know which one the writer meant.
 */
export function planPictureDrop(files: readonly { readonly name: string; readonly type: string }[], shots: readonly BoardShot[]): readonly DropVerdict[] {
  const byNumber = new Map(shots.map((shot) => [shot.number, shot]));
  const claims = new Map<number, number>();
  for (const file of files) {
    const number = isPictureFile(file) ? shotNumberOfFileName(file.name) : undefined;
    if (number !== undefined && byNumber.has(number)) claims.set(number, (claims.get(number) ?? 0) + 1);
  }
  return files.map((file, index): DropVerdict => {
    const out = (reason: string, beyond?: number): DropVerdict => ({ kind: 'left-out', file: index, name: file.name, reason, ...(beyond === undefined ? {} : { beyond }) });
    if (!isPictureFile(file)) return out('it is not a PNG, JPEG or WebP picture');
    const number = shotNumberOfFileName(file.name);
    if (number === undefined || number < 1) return out('its name does not start with a shot number (name a photograph like 007.jpg)');
    const shot = byNumber.get(number);
    if (shot === undefined) return out(`the board has ${shots.length === 1 ? '1 shot' : `${shots.length} shots`} and none is numbered ${number}`, number);
    if ((claims.get(number) ?? 0) > 1) return out(`another file in this drop is also named for shot ${number}, so neither was imported`);
    return { kind: 'import', file: index, name: file.name, shot };
  });
}

/** How a drop's batch came out: the command's answer, for the notice. */
export type DropCommit = { readonly ok: true } | { readonly ok: false; readonly message: string };

/** The notice after a drop on the board: one sentence, then a line for every file that says where it went or why it did not. */
export function dropReportOf(
  verdicts: readonly DropVerdict[],
  shotCount: number,
  commit: DropCommit,
): { readonly summary: string; readonly lines: readonly string[] } {
  const imports = verdicts.filter((verdict) => verdict.kind === 'import');
  const left = verdicts.length - imports.length;
  const lines = verdicts.map((verdict) => {
    if (verdict.kind === 'left-out') return `${verdict.name}: not imported, ${verdict.reason}`;
    const where = `shot ${verdict.shot.number}, ${verdict.shot.title}`;
    return commit.ok ? `${verdict.name}: ${where}` : `${verdict.name}: not imported (it was for ${where})`;
  });
  const beyond = verdicts.some((verdict) => verdict.kind === 'left-out' && verdict.beyond !== undefined);
  const hint = beyond
    ? ` The board has ${shotCount === 1 ? '1 shot' : `${shotCount} shots`}; a sheet printed from a longer board does not match it, so check that this is the board the sheet was printed from.`
    : '';
  if (!commit.ok) return { summary: `Nothing was imported: ${commit.message}${hint}`, lines };
  if (imports.length === 0) return { summary: `Nothing was imported.${hint}`, lines };
  const put = imports.length === 1 ? 'Put 1 picture on its shot' : `Put ${imports.length} pictures on their shots`;
  const rest = left === 0 ? '.' : `; ${left === 1 ? '1 file was' : `${left} files were`} not imported.`;
  return { summary: `${put}${rest}${hint} One Undo takes ${imports.length === 1 ? 'it' : 'them all'} back.`, lines };
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
