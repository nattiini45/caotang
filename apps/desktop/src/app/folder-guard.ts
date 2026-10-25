/**
 * What a folder save does around `writeProject`, so that a change another program makes to the folder is kept or reported and never
 * replaced without a trace (extensibility.md §9, project-format §4).
 *
 * The File System Access API has no compare-and-swap, so the instant between a check and a rename cannot be closed. This file makes it as
 * short as the API allows and reports what is left:
 *
 * - **Kept.** Before the save replaces or removes a project file whose bytes it did not last write, it copies those bytes to
 *   `.caotang-backup/<time>/<path>` (`watchSave`). A save that could not keep them stops before that file. The newest
 *   {@link FOLDER_BACKUP_KEEP} copies are kept (`pruneFolderBackups`). `.caotang-backup/` is no project file: it is in no digest and no export.
 * - **Checked again.** The digest the write checked is read once more just before the file is replaced, from the same bytes the backup
 *   keeps; a file that changed in between stops the save before it, as the write's own check does.
 * - **Reported.** After the write, the folder's files are digested again and compared with what the save should have left
 *   (`changedDuringSave`), and the lock is read again. A file another program changed or added meanwhile is named, and the copy the next
 *   save is checked against does not take it as its own.
 */

import {
  ArtifactNotFoundError,
  FolderDriftError,
  digestOfBytes,
  digestOfFile,
  driftOf,
  isProjectFile,
  projectFileDigests,
  MANIFEST_FILE,
  type ArtifactFs,
  type FolderDrift,
  type WriteReport,
} from '@caotang/store';

import { ENCODING_BACKUP_DIR } from './encoding-review.js';

/** How many saves' worth of replaced files `.caotang-backup/` keeps. The oldest is removed first. */
export const FOLDER_BACKUP_KEEP = 20;

/** The name a save's copies go under: the save's time as an ISO string with the colons and the dot replaced, so it sorts by time. */
export function backupStamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

/** Whether a name in `.caotang-backup/` is a save's folder (`backupStamp`), and not the encoding review's own `docs/` or `codex/`. */
export function isBackupStamp(name: string): boolean {
  if (name.length !== 24 || !name.endsWith('Z')) return false;
  const digits = name.replace(/\d/g, '0');
  return digits === '0000-00-00T00-00-00-000Z';
}

/** Removes a folder and what is in it, one entry at a time: the browser's `removeEntry` takes only an empty folder. */
async function removeTree(fs: ArtifactFs, dir: string): Promise<void> {
  for (const name of await fs.listFiles(dir)) await fs.remove(`${dir}/${name}`);
  for (const name of await fs.listDirs(dir)) await removeTree(fs, `${dir}/${name}`);
  await fs.remove(dir);
}

/**
 * Removes the oldest saves' copies in `.caotang-backup/` beyond `keep`. Only a folder named for a save (`isBackupStamp`) is counted or
 * removed, so the encoding review's copies, which sit beside them, stay. A copy that cannot be removed is left: it costs room, not words.
 */
export async function pruneFolderBackups(fs: ArtifactFs, keep: number = FOLDER_BACKUP_KEEP): Promise<void> {
  try {
    const saves = (await fs.listDirs(ENCODING_BACKUP_DIR)).filter(isBackupStamp).sort();
    for (const name of saves.slice(0, Math.max(0, saves.length - keep))) await removeTree(fs, `${ENCODING_BACKUP_DIR}/${name}`);
  } catch {
    // Left on purpose: see above.
  }
}

/** What a save wrote and kept, as the watch saw it (`watchSave`). */
export interface SaveWatch {
  /** The file system `writeProject` is given. It is `fs`, with the checks above on the writes and removals of project files. */
  readonly fs: ArtifactFs;
  /** The digest of the bytes each project file this save wrote now holds, by path. */
  readonly written: ReadonlyMap<string, string>;
  /** The project files this save removed. */
  readonly removed: ReadonlySet<string>;
  /** The text this save wrote to `caotang.json`, or `undefined` when it wrote none. */
  manifestText(): string | undefined;
  /** The folder the replaced files were copied to, or `undefined` when none was replaced. */
  backup(): string | undefined;
}

export interface WatchOptions {
  readonly now: Date;
  /** The digests `writeProject` checks each file against (`WriteOptions.expectedDigests`). */
  readonly expected: ReadonlyMap<string, string>;
  /** The digests of the files this session last held. A file with another digest is another program's and is kept. `null` holds nothing: every file replaced is kept. */
  readonly held: ReadonlyMap<string, string> | null;
  /** The report `writeProject` fills, which a stopped save hands on in its error. */
  readonly report: WriteReport;
}

/** Wraps `fs` for one save. See the file comment. */
export function watchSave(fs: ArtifactFs, options: WatchOptions): SaveWatch {
  const written = new Map<string, string>();
  const removed = new Set<string>();
  let manifest: string | undefined;
  let backupDir: string | undefined;

  const keep = async (path: string, bytes: Uint8Array): Promise<void> => {
    const dir = backupDir ?? `${ENCODING_BACKUP_DIR}/${backupStamp(options.now)}`;
    try {
      await fs.writeBytesAtomic(`${dir}/${path}`, bytes);
    } catch (cause) {
      throw new Error(
        `A copy of a file the folder holds could not be kept in ${ENCODING_BACKUP_DIR}, so Caotang did not replace it: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
    backupDir = dir;
  };

  // Before a project file is replaced or removed: the file must still be as the write checked it, and what it holds, if it is not what this
  // session last held, is kept. The bytes kept are the bytes digested, so the copy is the file that was checked.
  const beforeReplace = async (path: string): Promise<void> => {
    if (!isProjectFile(path)) return;
    const current = await digestOfFile(fs, path);
    if (current !== options.expected.get(path)) throw new FolderDriftError([path], options.report);
    if (current === undefined || options.held?.get(path) === current) return;
    let bytes: Uint8Array;
    try {
      bytes = await fs.readBytes(path);
    } catch (error) {
      if (error instanceof ArtifactNotFoundError) throw new FolderDriftError([path], options.report);
      throw error;
    }
    if ((await digestOfBytes(bytes)) !== current) throw new FolderDriftError([path], options.report);
    await keep(path, bytes);
  };

  const watched: ArtifactFs = {
    read: (path) => fs.read(path),
    readBytes: (path) => fs.readBytes(path),
    listFiles: (dir) => fs.listFiles(dir),
    listDirs: (dir) => fs.listDirs(dir),
    exists: (path) => fs.exists(path),
    ensureDir: (dir) => fs.ensureDir(dir),
    async writeAtomic(path, contents) {
      await beforeReplace(path);
      await fs.writeAtomic(path, contents);
      if (path === MANIFEST_FILE) manifest = contents;
      if (isProjectFile(path)) written.set(path, await digestOfBytes(new TextEncoder().encode(contents)));
    },
    async writeBytesAtomic(path, bytes) {
      await beforeReplace(path);
      await fs.writeBytesAtomic(path, bytes);
      if (isProjectFile(path)) written.set(path, await digestOfBytes(bytes));
    },
    async remove(path) {
      await beforeReplace(path);
      await fs.remove(path);
      if (isProjectFile(path)) {
        removed.add(path);
        written.delete(path);
      }
    },
  };

  return { fs: watched, written, removed, manifestText: () => manifest, backup: () => backupDir };
}

/** What a finished save left that it did not mean to: the folder's files against what the save should have left. */
export interface SaveSettled {
  /** The files another program changed, removed or added while the save wrote, against what the save left. */
  readonly drift: FolderDrift;
  /**
   * The digests the next save is checked against: what the save left, except that a file named in `drift` keeps the digest it had before the
   * save (and none, if it had none), so the next save still sees that file as one another program changed.
   */
  readonly digests: Map<string, string>;
  /** The exact digests currently read from the folder, including files that drifted during the save. */
  readonly currentDigests: Map<string, string>;
}

/**
 * Digests the folder's project files again after a save and compares them with what the save should have left: each file it wrote with the
 * bytes it wrote, each file it removed gone, and every other file as it was before. `before` is the folder's digests the save checked.
 */
export async function changedDuringSave(fs: ArtifactFs, before: ReadonlyMap<string, string>, watch: SaveWatch): Promise<SaveSettled> {
  const left = new Map(before);
  for (const [path, digest] of watch.written) left.set(path, digest);
  for (const path of watch.removed) left.delete(path);
  const currentDigests = await projectFileDigests(fs);
  const drift = driftOf(left, currentDigests);
  const digests = new Map(left);
  // A file that changed keeps its earlier digest, so the next save sees it changed. One removed after the save wrote it stays held as
  // written, so the next save sees the removal; one added is not held, so the next save sees it added.
  for (const path of drift.changed) {
    const earlier = before.get(path);
    if (earlier === undefined) digests.delete(path);
    else digests.set(path, earlier);
  }
  return { drift, digests, currentDigests };
}
