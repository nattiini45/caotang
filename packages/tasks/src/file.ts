/**
 * `tasks.json` on disk — [agent-harness.md §12](../../../docs/architecture/agent-harness.md), [project-format §1, §4](../../../docs/architecture/project-format.md).
 *
 * Every write goes through the {@link ArtifactFs} port's `writeAtomic`. The recovery posture is `coherence.json`'s: before a
 * changed save replaces the file, the previous file rotates into `tasks.json.bak.1`, down to `.bak.3`; a load that finds the live
 * file unreadable keeps the damaged copy under a timestamped name and restores the newest snapshot that reads. Only when no
 * snapshot reads is the list of tasks lost, and the load says so.
 */

import type { ArtifactFs } from '@caotang/store';

import { parseTasksFile, serializeTasksFile, type LoadNotice } from './codec.js';
import { TASKS_FILE, TASKS_SNAPSHOT_COUNT, emptyTasksFile, type TasksFile } from './model.js';

/** `tasks.json.corrupt-<timestamp>`, colons and dots replaced so the name is a path on every system. */
export function corruptTasksFile(when: Date): string {
  return `${TASKS_FILE}.corrupt-${when.toISOString().replace(/[:.]/g, '-')}`;
}

/** Generation `n` is `tasks.json.bak.<n>`. */
export function tasksSnapshotFile(n: number): string {
  return `${TASKS_FILE}.bak.${n}`;
}

export class TasksError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'TasksError';
    this.code = code;
  }
}

export type LoadStatus =
  /** No file yet. The first save creates it. */
  | 'absent'
  /** Read as written. */
  | 'loaded'
  /** Unreadable; the original is kept and the file was restored from a snapshot, or started empty. */
  | 'recovered'
  /** Written by a newer Caotang, or not a Caotang tasks file at all. Shown, never overwritten. */
  | 'read-only';

export interface LoadResult {
  readonly status: LoadStatus;
  readonly file: TasksFile;
  readonly notices: LoadNotice[];
  /** False only for `read-only`: a save would destroy a newer format, or a file that is not ours. */
  readonly writable: boolean;
  /** Set on `recovered`: the name the unreadable file was kept under. */
  readonly preservedAs?: string;
}

/** The newest snapshot that reads, in ladder order (`.bak.1` first). A newer-format or damaged one is skipped. */
async function newestReadableSnapshot(fs: ArtifactFs): Promise<{ path: string; file: TasksFile; notices: LoadNotice[] } | undefined> {
  for (let n = 1; n <= TASKS_SNAPSHOT_COUNT; n += 1) {
    const path = tasksSnapshotFile(n);
    if (!(await fs.exists(path))) continue;
    let text: string;
    try {
      text = await fs.read(path);
    } catch {
      continue;
    }
    const outcome = parseTasksFile(text);
    if (outcome.kind === 'ok') return { path, file: outcome.file, notices: outcome.notices };
  }
  return undefined;
}

/** Reads the project's tasks file. Never throws on content; it throws only when the port itself fails. */
export async function loadTasks(fs: ArtifactFs, options: { readonly now?: Date } = {}): Promise<LoadResult> {
  if (!(await fs.exists(TASKS_FILE))) return { status: 'absent', file: emptyTasksFile(), notices: [], writable: true };
  const text = await fs.read(TASKS_FILE);
  const outcome = parseTasksFile(text);
  if (outcome.kind === 'ok') return { status: 'loaded', file: outcome.file, notices: outcome.notices, writable: true };
  if (outcome.kind === 'foreign') {
    return {
      status: 'read-only',
      file: emptyTasksFile(),
      notices: [
        {
          code: 'foreign-file',
          message:
            'tasks.json in this folder is not a Caotang tasks file (it has no formatVersion). It is left as it is, and tasks are not saved to it until it is renamed or removed.',
        },
      ],
      writable: false,
    };
  }
  if (outcome.kind === 'newer') {
    return {
      status: 'read-only',
      file: emptyTasksFile(),
      notices: [
        {
          code: 'newer-format',
          message: `tasks.json was written by a newer Caotang (format ${outcome.formatVersion}). Tasks are not shown and the file is not changed.`,
        },
      ],
      writable: false,
    };
  }

  const preservedAs = corruptTasksFile(options.now ?? new Date());
  await fs.writeAtomic(preservedAs, text);
  const snapshot = await newestReadableSnapshot(fs);
  if (snapshot !== undefined) {
    await fs.writeAtomic(TASKS_FILE, serializeTasksFile(snapshot.file));
    return {
      status: 'recovered',
      file: snapshot.file,
      notices: [
        ...snapshot.notices,
        {
          code: 'restored-from-snapshot',
          message:
            `tasks.json could not be read (${outcome.reason}). The unreadable file is kept as ${preservedAs}, and the file was restored from ` +
            `${snapshot.path}, the newest earlier version that reads. Changes made after that version was saved are not in it.`,
        },
      ],
      writable: true,
      preservedAs,
    };
  }

  const file = emptyTasksFile();
  await fs.writeAtomic(TASKS_FILE, serializeTasksFile(file));
  return {
    status: 'recovered',
    file,
    notices: [
      {
        code: 'corrupt-file',
        message:
          `tasks.json could not be read (${outcome.reason}). The unreadable file is kept as ${preservedAs}, and no earlier version of it reads, ` +
          'so the list of tasks starts empty. The tasks are in the kept copy and nowhere else.',
      },
    ],
    writable: true,
    preservedAs,
  };
}

/**
 * Moves the live file one generation down before a changed save. A save that changes nothing makes no generation. A live file that
 * does not read is kept under its corrupt name and never enters the ladder, so a snapshot is always a file that reads.
 */
async function rotateTasks(fs: ArtifactFs, next: string, now: Date): Promise<void> {
  if (!(await fs.exists(TASKS_FILE))) return;
  const current = await fs.read(TASKS_FILE);
  if (current === next) return;
  const outcome = parseTasksFile(current);
  if (outcome.kind === 'newer') {
    throw new TasksError('read-only', 'tasks.json was written by a newer Caotang while this one was open, and it cannot be saved over.');
  }
  if (outcome.kind === 'foreign') {
    throw new TasksError('read-only', 'tasks.json is not a Caotang tasks file (it has no formatVersion), and it cannot be saved over.');
  }
  if (outcome.kind === 'corrupt') {
    await fs.writeAtomic(corruptTasksFile(now), current);
    return;
  }
  const oldest = tasksSnapshotFile(TASKS_SNAPSHOT_COUNT);
  if (await fs.exists(oldest)) await fs.remove(oldest);
  for (let n = TASKS_SNAPSHOT_COUNT - 1; n >= 1; n -= 1) {
    const from = tasksSnapshotFile(n);
    if (!(await fs.exists(from))) continue;
    await fs.writeAtomic(tasksSnapshotFile(n + 1), await fs.read(from));
  }
  await fs.writeAtomic(tasksSnapshotFile(1), current);
}

/** Writes the file atomically after rotating the previous generation. Refuses a read-only load, so a newer file is never overwritten. */
export async function saveTasks(fs: ArtifactFs, load: LoadResult, file: TasksFile, options: { readonly now?: Date } = {}): Promise<void> {
  if (!load.writable) throw new TasksError('read-only', 'tasks.json was written by a newer Caotang, or is not a Caotang tasks file, and cannot be saved by this one.');
  const text = serializeTasksFile(file);
  await rotateTasks(fs, text, options.now ?? new Date());
  await fs.writeAtomic(TASKS_FILE, text);
}
