/**
 * The pictures a stored comic page names — comics.md §2: a panel's `assetId` is a picture-registry record, so each is a typed use.
 *
 * Read from the raw stored value rather than the tolerant loader, because a use is a fact about what is stored: a panel the loader
 * would drop for a bad rectangle still names its picture until a save rewrites it, and deleting that picture would break the
 * panel the writer can still see in the manifest.
 */

import { isRecord } from './model.js';

export interface PanelPictureRef {
  assetId: string;
  panelId?: string;
}

export function panelPictureRefs(storedPage: unknown): PanelPictureRef[] {
  if (!isRecord(storedPage) || !Array.isArray(storedPage['panels'])) return [];
  const refs: PanelPictureRef[] = [];
  for (const panel of storedPage['panels'] as unknown[]) {
    if (!isRecord(panel)) continue;
    const assetId = panel['assetId'];
    if (typeof assetId !== 'string' || assetId === '') continue;
    const id = panel['id'];
    refs.push({ assetId, ...(typeof id === 'string' && id !== '' ? { panelId: id } : {}) });
  }
  return refs;
}
