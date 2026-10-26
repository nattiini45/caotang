/**
 * Where a project's `tasks.json` lives, and how it is loaded and saved (agent-harness.md §12, project-format §1 and §4).
 *
 * The file sits beside `caotang.json`, so two places can hold it in this build, the way `coherence.json` has them (coherence-io.ts):
 * - **The project's row in the browser store**, the working copy of every project in this browser: the file, its three snapshots and
 *   any kept corrupt copy, under the project's own row (`readTaskFiles` / `writeTaskFiles`).
 * - **The open project folder**, when one is attached. A folder that already holds a `tasks.json` is the copy that is read at open, and
 *   every save is written to both places. The folder's file is written only while it is still the one this session last read or wrote
 *   (its digest), so a file another program changed is not replaced; the browser's copy is saved either way.
 *
 * Every write goes through the tasks module's own `saveTasks`, so the rotation and the atomic write are the module's. A stored set that
 * cannot be read is never written over: the tasks are shown empty and the file is read-only until the project is opened again, since a
 * save would replace the stored set with a partial one.
 */

import {
  TASKS_FILE,
  loadTasks,
  saveTasks,
  serializeTasksFile,
  type LoadResult,
  type TasksFile,
} from '@caotang/tasks';
import {
  MemoryArtifactFs,
  ProjectNotFoundError,
  digestOfBytes,
  digestOfFile,
  readTaskFiles,
  writeTaskFiles,
  type ArtifactFs,
  type RuntimeStore,
} from '@caotang/store';

import { StoreArtifactFs } from './coherence-io.js';
import { folderArtifactFs, isSameFolder, type DirectoryHandleLike } from './fs-access.js';

/** What the Tasks panel says about the file: whether it can be saved, what the load noticed, and why the last save did not land. */
export interface TasksStatus {
  readonly writable: boolean;
  readonly notices: readonly string[];
  readonly saveFailure: string | null;
}

interface FolderCopy {
  readonly root: DirectoryHandleLike;
  readonly fs: ArtifactFs;
  readonly load: LoadResult;
  /** The digest of the folder's `tasks.json` as this session last read or wrote it, or `undefined` when the folder held none. */
  digest: string | undefined;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Only the folder's copy was not written; the browser's was. */
export class FolderTasksError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FolderTasksError';
  }
}

/** The folder's copy of the tasks file, read. A read that fails is thrown with the file named, and the folder is not touched. */
async function readFolderCopy(root: DirectoryHandleLike): Promise<FolderCopy> {
  const fs = folderArtifactFs(root);
  try {
    // The digest is taken before the read, so a file written in between is a change at the next save and never taken as already held.
    const seen = await digestOfFile(fs, TASKS_FILE);
    const load = await loadTasks(fs);
    return { root, fs, load, digest: load.status === 'recovered' ? await digestOfFile(fs, TASKS_FILE) : seen };
  } catch (error) {
    throw new Error(`tasks.json in the project folder could not be read: ${messageOf(error)}. The folder's copy is left as it is.`, { cause: error });
  }
}

/** Writes `file` into the folder's copy while the folder still holds the `tasks.json` this copy read or wrote last. */
async function saveToFolder(copy: FolderCopy, file: TasksFile): Promise<void> {
  if ((await digestOfFile(copy.fs, TASKS_FILE)) !== copy.digest) {
    throw new FolderTasksError('tasks.json in the project folder was changed by another program since Caotang last read or saved it, so it was not replaced.');
  }
  await saveTasks(copy.fs, copy.load, file);
  copy.digest = await digestOfBytes(new TextEncoder().encode(serializeTasksFile(file)));
}

/** A project's tasks file as the open session holds it, with the places it is saved to. */
export class TasksHome {
  private file: TasksFile;
  private chain: Promise<void> = Promise.resolve();
  /** The saves that were asked for and have not settled: the save indicator reads saving while there is one (`pending`). */
  private inFlight = 0;
  private readonly listeners = new Set<() => void>();
  private failure: string | null = null;
  private folderFailure: string | null = null;

  constructor(
    initial: TasksFile,
    private readonly writable: boolean,
    private readonly notices: readonly string[],
    private readonly mirror: { readonly fs: ArtifactFs; readonly load: LoadResult; readonly readable: boolean },
    private folder: FolderCopy | null,
  ) {
    this.file = initial;
  }

  /** The tasks as the session holds them now. */
  current(): TasksFile {
    return this.file;
  }

  status(): TasksStatus {
    return { writable: this.writable && this.mirror.readable, notices: this.notices, saveFailure: this.failure ?? this.folderFailure };
  }

  /**
   * Whether a save is queued or running. A save is several writes (the snapshots, then the file) and none of it is in the store until it
   * lands, so the session's save indicator reads saving meanwhile, and a reload begun when it read saved cannot lose the writer's task.
   */
  pending(): boolean {
    return this.inFlight > 0;
  }

  /** Calls `listener` when a save is asked for and when every save so far has settled. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The file as it is written, for a bundle; `undefined` when the project has no task, so a bundle carries none. */
  text(): string | undefined {
    return this.file.tasks.length === 0 ? undefined : serializeTasksFile(this.file);
  }

  /**
   * Holds `next` and saves it, after the saves before it. Resolves with why it could not be saved, or `null`. The tasks stay held in
   * memory when a save fails, and the next save tries again.
   */
  save(next: TasksFile): Promise<string | null> {
    if (!this.writable || !this.mirror.readable) {
      return Promise.resolve('tasks.json cannot be saved here: it was written by a newer Caotang, is not a Caotang tasks file, or could not be read when the project opened.');
    }
    this.file = next;
    return this.enqueue(async () => {
      try {
        await saveTasks(this.mirror.fs, this.mirror.load, next);
        this.failure = null;
      } catch (error) {
        this.failure = `Your tasks could not be saved in this browser: ${messageOf(error)}`;
        return this.failure;
      }
      if (this.folder !== null) {
        try {
          await saveToFolder(this.folder, next);
          this.folderFailure = null;
        } catch (error) {
          this.folderFailure = `Your tasks could not be saved to the folder: ${messageOf(error)}`;
          return this.folderFailure;
        }
      }
      return null;
    });
  }

  /**
   * Makes a folder a place the file is saved to from now on, and writes the file into it now. The folder's own copy is read first, and a
   * copy that cannot be read is not written over. A project with no tasks writes no file.
   */
  attachFolder(root: DirectoryHandleLike): Promise<void> {
    if (!this.writable || !this.mirror.readable) return Promise.resolve();
    return this.enqueue(async () => {
      try {
        if (this.folder !== null && (await isSameFolder(this.folder.root, root))) {
          if (this.file.tasks.length > 0) await saveToFolder(this.folder, this.file);
        } else {
          const copy = await readFolderCopy(root);
          // The folder's own file, when it holds one, is not replaced by an empty list.
          if (this.file.tasks.length > 0) await saveToFolder(copy, this.file);
          this.folder = copy;
        }
        this.folderFailure = null;
      } catch (error) {
        this.folderFailure = `Your tasks could not be saved to the folder: ${messageOf(error)}`;
      }
      return null;
    }).then(() => undefined);
  }

  private announce(): void {
    for (const listener of this.listeners) listener();
  }

  /** Resolves when every save made so far has settled. */
  settled(): Promise<void> {
    return this.chain.then(() => undefined);
  }

  private enqueue(work: () => Promise<string | null>): Promise<string | null> {
    this.inFlight += 1;
    this.announce();
    const run = this.chain.then(work).finally(() => {
      this.inFlight -= 1;
      this.announce();
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/**
 * Loads a project's tasks file: the browser's copy, and the folder's when one is attached and holds a file (that one wins, as it is the
 * copy the writer put there). Neither read stops a project from opening; each failure is a notice.
 */
export async function openTasksHome(projectId: string, store: RuntimeStore, folder: DirectoryHandleLike | null = null): Promise<TasksHome> {
  const files = new MemoryArtifactFs();
  const notices: string[] = [];
  let readable = true;
  try {
    for (const [path, text] of Object.entries(await readTaskFiles(store, projectId))) await files.writeAtomic(path, text);
  } catch (error) {
    if (!(error instanceof ProjectNotFoundError)) {
      readable = false;
      notices.push(
        `The tasks file could not be read from this browser: ${messageOf(error)}. Tasks are shown empty, and nothing is saved over the stored file until the project is opened again.`,
      );
    }
  }
  const mirrorFs = new StoreArtifactFs(files, async () => {
    if (readable) await writeTaskFiles(store, projectId, files.snapshot());
  });
  const mirrorLoad = await loadTasks(mirrorFs);
  let load: LoadResult = mirrorLoad;
  let folderCopy: FolderCopy | null = null;
  if (folder !== null) {
    try {
      folderCopy = await readFolderCopy(folder);
      if (folderCopy.load.status !== 'absent') load = folderCopy.load;
    } catch (error) {
      notices.push(`${messageOf(error)} Tasks are kept in this browser.`);
    }
  }
  notices.push(...load.notices.map((notice) => notice.message));
  return new TasksHome(load.file, load.writable, notices, { fs: mirrorFs, load: mirrorLoad, readable }, folderCopy);
}
