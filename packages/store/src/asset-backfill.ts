/**
 * The open's backfill of the picture registry — pictures.md §6.2, "On open, every listed `assets/` file used by cover, shots,
 * `visualRefs` or an inline image gets a record (hash computed in idle time), written with the next save, the way `language` and
 * `identifier` were back-filled."
 *
 * Only a file that is **used** and **listed** gets a record: an unused file is an undo's orphan (the sweep's, A6), and a used id with
 * no file is a dangling reference the open's image check already handles. The bytes are hashed as they are stored; the backfill never
 * rewrites a file (the GPS strip is the import's, and the export strips again). A record the registry already holds is left alone.
 *
 * The reads and the hashing are awaited; the records join `assets[]` synchronously at the end, after a second look for a record that
 * arrived meanwhile (an import the writer ran while the backfill read). The caller schedules the save.
 */

import { ASSETS_DIR, parseAssetFileName, pixelSize, sha256Hex, sniffImage, usedAssetIds, IMAGE_FORMATS, type AssetRecord } from '@caotang/pictures';

import type { ProjectState } from './state.js';

/** Where the backfill reads the files: the listing of `assets/` (file names or project-relative paths) and one file's bytes. */
export interface AssetBackfillSource {
  list(): Promise<readonly string[]> | readonly string[];
  read(path: string): Promise<Uint8Array | undefined>;
}

/**
 * Gives every used, listed picture without a record one, and returns the records it added (none is the common case after the first
 * open). A file that cannot be read, or whose bytes are not a PNG, JPEG or WebP image, is skipped: it is reported nowhere, because
 * the image check and the exporter already say what they cannot show.
 */
export async function backfillAssetRecords(
  state: ProjectState,
  source: AssetBackfillSource,
  options: { readonly now?: () => number } = {},
): Promise<AssetRecord[]> {
  const recorded = new Set((state.manifest.assets ?? []).map((record) => record.id));
  const used = usedAssetIds(state);
  const wanted = [...used].filter((id) => !recorded.has(id));
  if (wanted.length === 0) return [];

  const files = new Map<string, string>();
  for (const listed of await source.list()) {
    const fileName = listed.slice(listed.lastIndexOf('/') + 1);
    const parsed = parseAssetFileName(fileName);
    if (parsed !== undefined && !files.has(parsed.assetId)) files.set(parsed.assetId, fileName);
  }

  const now = options.now ?? Date.now;
  const made: AssetRecord[] = [];
  for (const id of wanted) {
    const fileName = files.get(id);
    if (fileName === undefined) continue;
    let bytes: Uint8Array | undefined;
    try {
      bytes = await source.read(`${ASSETS_DIR}/${fileName}`);
    } catch {
      bytes = undefined;
    }
    if (bytes === undefined) continue;
    const format = sniffImage(bytes);
    const named = parseAssetFileName(fileName);
    // The record's MIME type follows the file name, which is what a reader resolves; a file whose bytes disagree with its name is skipped.
    if (format === undefined || named === undefined || named.format !== format) continue;
    const size = pixelSize(bytes);
    made.push({
      id,
      file: fileName,
      mime: IMAGE_FORMATS[format].mime,
      sha256: await sha256Hex(bytes),
      bytes: bytes.length,
      ...(size === undefined ? {} : { width: size.width, height: size.height }),
      createdAt: new Date(now()).toISOString(),
    });
  }

  // Synchronous from here: a record that arrived while the files were read is not added twice.
  const records = state.manifest.assets ?? [];
  const added = made.filter((record) => !records.some((candidate) => candidate.id === record.id));
  if (added.length > 0) state.manifest.assets = [...records, ...added];
  return added;
}
