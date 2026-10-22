/**
 * Two reads from the project folder that the storyboard and the pack panel need, as React hooks. Both come through
 * an `ArtifactFs` the App supplies, and both resolve to nothing without one, so a view runs with no folder attached
 * and shows what it can (the cards show their alt text, the pack names no files).
 */

import { useEffect, useState } from 'react';

import type { ArtifactFs, CodexEntry } from '@caotang/store';

import type { ProjectSession } from '../app/session.js';
import { useSession } from '../components/shared.js';

import { listAssets, readImage, type AssetRecord } from './engines.js';
import { shownListingOf, type HeldListing, type PictureListing } from './shot-image-model.js';

const NO_CODEX: readonly CodexEntry[] = [];

/** The asset records of the project's `assets/` folder, and where the listing stands (see `useAssetListing`). */
export interface AssetListing {
  readonly records: ReadonlyMap<string, AssetRecord>;
  readonly listing: PictureListing;
}

/**
 * The asset records of the project's `assets/` folder, keyed by asset id. `version` is the session's assets version
 * (session.ts): it moves when the images have been listed again, so a new asset appears on the next listing and not on every change of
 * the session. `listing` says whether that list has come back: a picture that is not in it is only missing once it has. With no folder
 * the list cannot be read, so the listing is `failed`.
 *
 * `assets` must keep its identity while the project is open: the effect below runs on it. The App memoizes the one
 * `ArtifactFs` per attached folder (README, "Stable identity"). A new object each render lists the folder again.
 */
export function useAssetListing(assets: ArtifactFs | undefined, version: number): AssetListing {
  const [held, setHeld] = useState<HeldListing<ArtifactFs, AssetRecord>>({ source: undefined, version: null, map: new Map(), listing: 'pending' });

  useEffect(() => {
    let live = true;
    if (assets === undefined) return;
    listAssets(assets).then(
      (listed) => {
        if (!live) return;
        setHeld({
          source: assets,
          version,
          map: new Map(listed.map((asset) => [asset.assetId, { id: asset.assetId, fileName: asset.fileName }])),
          listing: 'listed',
        });
      },
      () => {
        if (live) setHeld({ source: assets, version, map: new Map(), listing: 'failed' });
      },
    );
    return () => {
      live = false;
    };
  }, [assets, version]);

  // With no folder there is nothing to list, the map from an earlier folder must not leak into this one, and an older list reads as pending.
  return shownListingOf(assets, version, held);
}

/** The asset records alone, for a view that does not say when the listing is missing a picture. */
export function useAssetRecords(assets: ArtifactFs | undefined, version: number): ReadonlyMap<string, AssetRecord> {
  return useAssetListing(assets, version).records;
}

/**
 * An object URL for one asset's image, or `null` while it loads, when there is no folder, or when the file is absent.
 * The URL is revoked when the asset changes or the view unmounts.
 *
 * The same identity rule as `useAssetRecords` applies: a new `assets` object each render re-reads every image, and each
 * read makes a new object URL. Memoize the `ArtifactFs` in the App (README, "Stable identity").
 */
export function useImageUrl(assets: ArtifactFs | undefined, assetId: string | null): string | null {
  const [loaded, setLoaded] = useState<{ readonly key: string; readonly url: string } | null>(null);

  useEffect(() => {
    if (assets === undefined || assetId === null) return;
    let live = true;
    let created: string | null = null;
    readImage(assets, assetId).then(
      (image) => {
        if (!live || image === undefined) return;
        created = URL.createObjectURL(new Blob([new Uint8Array(image.bytes)], { type: image.mime }));
        setLoaded({ key: assetId, url: created });
      },
      () => {
        // A file that cannot be read is shown as missing. The card's alt text says what the shot is.
      },
    );
    return () => {
      live = false;
      if (created !== null) URL.revokeObjectURL(created);
    };
  }, [assets, assetId]);

  return assets !== undefined && assetId !== null && loaded !== null && loaded.key === assetId ? loaded.url : null;
}

/**
 * The codex entries a media view reads (the speakers of a dialogue container, the cues of a scene). The store changes an entry in place,
 * so the array keeps its identity when an entry is renamed, given an alias or removed; a memo keyed on the array would keep the names it
 * read before the change. This hook returns a new array whenever the names, aliases, types or case rules change, so a memo
 * keyed on it is read again, the way the Findings scan reads the codex.
 */
export function useCodexEntries(session: ProjectSession): readonly CodexEntry[] {
  useSession(session);
  const live = session.state.manifest.codex ?? NO_CODEX;
  const key = codexKeyOf(live);
  const [held, setHeld] = useState(() => ({ key, entries: [...live] }));
  if (held.key !== key) {
    // The same render-time adjustment of state that the shot editor uses: the next render reads the new array.
    const next = { key, entries: [...live] };
    setHeld(next);
    return next.entries;
  }
  return held.entries;
}

/** What a speaker or a cue resolves against, per entry: its id, type, case rule and every name it answers to, in order. */
function codexKeyOf(entries: readonly CodexEntry[]): string {
  return entries.map((entry) => [entry.id, entry.type, entry.caseSensitive ? '1' : '0', entry.name, ...entry.aliases].join('\u001f')).join('\u001e');
}
