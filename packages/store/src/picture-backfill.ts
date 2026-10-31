/**
 * The backfill — [pictures.md §6.2](docs/architecture/pictures.md). A project made before the registry has image files that the cover, a
 * shot, a codex entry's visual references or an inline image name and no record for. This gives each of them a record, so the library
 * lists them and a later import of the same bytes finds them.
 *
 * It is safe to run any number of times: a second run over a project it already backfilled finds nothing to add. It never removes
 * anything. A record whose file is absent from an authoritative listing is kept with its caption and tags (the bytes may be coming back from
 * a folder, a bundle or a sync), and a use that names a file that is not there gets no record at all, because there is nothing to hash;
 * the reference itself is untouched. The records are added to the open project's manifest and travel with the next save, the way
 * `language` and `identifier` were back-filled.
 *
 * The host calls it when a project opens and the picture listing is known, in idle time, because it reads and hashes each file once.
 */

import { picturesUsesSnapshot } from '@caotang/bus';
import {
  parseAssetFileName,
  planBackfill,
  readPictureHeader,
  sha256Hex,
  usedAssetIds,
  type BackfillPlan,
  type ListedFile,
  type ReadAssetRecord,
} from '@caotang/pictures';

import type { ProjectAssetPort } from './commands-project.js';
import { recordsOf, replaceList } from './picture-registry.js';
import type { ProjectState } from './state.js';

export interface BackfillResult {
  /** The records added to the manifest this run. */
  readonly created: readonly string[];
  /** Used and listed, but the file could not be read this time, so it is left for the next run. */
  readonly unread: readonly string[];
  /** Named by a use, but absent from an authoritative listing. No record was made. */
  readonly missingFiles: readonly string[];
  /** Records whose file is absent from an authoritative listing. Kept as they are. */
  readonly missingRecords: readonly string[];
}

const NOTHING: BackfillResult = { created: [], unread: [], missingFiles: [], missingRecords: [] };

export async function backfillAssetRecords(state: ProjectState, port: Required<Pick<ProjectAssetPort, 'list' | 'readBytes'>>, now: Date): Promise<BackfillResult> {
  const listing = await port.list();
  const used = usedAssetIds(picturesUsesSnapshot(state));
  const records = recordsOf(state);
  const recorded = new Set(records.map((record) => record.id));

  // Only the files a use names and no record covers are read. Everything else is a file nobody asked about.
  const files: ListedFile[] = [];
  const unread: string[] = [];
  for (const name of listing.files) {
    const parsed = parseAssetFileName(name);
    if (parsed === undefined) continue;
    if (!used.has(parsed.assetId) || recorded.has(parsed.assetId)) {
      files.push({ file: name });
      continue;
    }
    const bytes = await port.readBytes(`assets/${name}`);
    if (bytes === undefined || bytes === null) {
      unread.push(parsed.assetId);
      files.push({ file: name });
      continue;
    }
    const header = readPictureHeader(bytes, parsed.mime);
    files.push({
      file: name,
      bytes: bytes.length,
      sha256: await sha256Hex(bytes),
      ...(header.ok ? { width: header.displayWidth, height: header.displayHeight } : {}),
    });
  }

  const plan: BackfillPlan = planBackfill({
    records: records.map((record) => ({ id: record.id, file: record.file })),
    used,
    listing: { authoritative: listing.authoritative, files },
    now: now.toISOString(),
  });
  if (plan.create.length === 0) {
    return { ...NOTHING, unread, missingFiles: plan.missingFiles, missingRecords: plan.missingRecords };
  }
  const added: ReadAssetRecord[] = plan.create.map((record) => ({ ...record }));
  replaceList(state, 'assets', [...records, ...added], added.map((record) => record.id));
  return {
    created: added.map((record) => record.id),
    unread,
    missingFiles: plan.missingFiles,
    missingRecords: plan.missingRecords,
  };
}
