/**
 * The manifest's picture lists as the applies change them — [pictures.md §2.1](docs/architecture/pictures.md).
 *
 * `assets[]` and `assetLinks[]` are replaced, never edited in place: every function in `@caotang/pictures` returns a new array, and
 * the applies here do the same with records. That makes the undo capture cheap (the list as it was is one reference) and exact (an
 * undo with nothing changed since puts that very list back, order and all). When something else changed the list in between, the
 * undo falls back to putting back only the entries the command touched, by id, and leaves the rest alone.
 */

import type { AssetLink, ReadAssetLink, ReadAssetRecord } from '@caotang/pictures';

import type { ProjectState } from './state.js';

type ListKey = 'assets' | 'assetLinks';

type ListItem = { readonly id: string };

/** A picture list as it was before a command and as the command left it, with the ids it touched. */
export interface ListUndo {
  readonly key: ListKey;
  /** The key was absent from the manifest before the command, so an emptied list is removed again rather than written as `[]`. */
  readonly had: boolean;
  readonly before: readonly ListItem[];
  readonly after: readonly ListItem[];
  readonly touched: ReadonlySet<string>;
}

export function recordsOf(state: ProjectState): readonly ReadAssetRecord[] {
  return state.manifest.assets ?? [];
}

export function linksOf(state: ProjectState): readonly (AssetLink | ReadAssetLink)[] {
  return state.manifest.assetLinks ?? [];
}

function write(state: ProjectState, key: ListKey, list: readonly ListItem[], had: boolean): void {
  const manifest = state.manifest as unknown as Record<string, unknown>;
  if (!had && list.length === 0) delete manifest[key];
  else manifest[key] = [...list];
}

/** Replaces a list and returns what an undo needs to put it back. */
export function replaceList(state: ProjectState, key: ListKey, next: readonly ListItem[], touched: Iterable<string>): ListUndo {
  const had = state.manifest[key] !== undefined;
  const before: readonly ListItem[] = state.manifest[key] ?? [];
  write(state, key, next, had);
  const after: readonly ListItem[] = state.manifest[key] ?? [];
  return { key, had, before, after, touched: new Set(touched) };
}

/** Puts a list back. Exact when nothing else changed it since; otherwise only the touched entries move, by id. */
export function undoList(state: ProjectState, undo: ListUndo): void {
  const current: readonly ListItem[] = state.manifest[undo.key] ?? [];
  const unchanged = state.manifest[undo.key] === undo.after || (state.manifest[undo.key] === undefined && undo.after.length === 0);
  if (unchanged) {
    write(state, undo.key, undo.before, undo.had);
    return;
  }
  const next = [...current];
  for (const id of undo.touched) {
    const beforeIndex = undo.before.findIndex((item) => item.id === id);
    const at = next.findIndex((item) => item.id === id);
    const original = beforeIndex < 0 ? undefined : undo.before[beforeIndex];
    if (original === undefined) {
      if (at >= 0) next.splice(at, 1);
    } else if (at >= 0) {
      next[at] = original;
    } else {
      next.splice(Math.min(beforeIndex, next.length), 0, original);
    }
  }
  write(state, undo.key, next, undo.had);
}
