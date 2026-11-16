/**
 * The machine's task state on disk (agent-harness.md §12, "The command line"): the file outside the project that remembers when each
 * task was last handled here. The shape and the recovery posture are `@caotang/tasks`'s; this is the reading, the rotating and the
 * atomic write. A corrupt file is kept under a `.corrupt-<timestamp>` name and the state starts empty; a file from a newer format, or
 * one that claims no format at all, is left as it is and refuses the run until it is renamed or removed.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { isIdWithPrefix } from '@caotang/ids';
import { corruptStateFile, emptyTaskState, parseTaskState, serializeTaskState, type TaskStateFile } from '@caotang/tasks';

/** The state file for a project, outside the project folder: one file per project id, under the user's home. */
export function defaultTaskStatePath(projectId: string, home: string = homedir()): string {
  // A project folder supplies this id, so it is checked against the generated format before it names a path: a traversal-shaped id must never reach a rename.
  if (!isIdWithPrefix('p', projectId)) throw new Error(`not a Caotang project id: ${JSON.stringify(projectId)}`);
  return join(home, '.caotang', 'task-state', `${projectId}.json`);
}

export type TaskStateLoad =
  | { readonly kind: 'ok'; readonly file: TaskStateFile; readonly notice?: string }
  | { readonly kind: 'refused'; readonly message: string };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Reads the state file. A missing file is an empty state; a corrupt one is rotated aside and reported as a notice. */
export async function loadTaskState(path: string, now: Date = new Date()): Promise<TaskStateLoad> {
  let text: string | undefined;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
    if (code !== 'ENOENT') return { kind: 'refused', message: `the task state at ${path} could not be read: ${messageOf(error)}` };
  }
  const parsed = parseTaskState(text);
  if (parsed.kind === 'ok') return { kind: 'ok', file: parsed.file };
  if (parsed.kind === 'corrupt') {
    const kept = `${path}${corruptStateFile(now)}`;
    try {
      await rename(path, kept);
    } catch (error) {
      return { kind: 'refused', message: `the task state at ${path} is corrupt and could not be kept aside: ${messageOf(error)}` };
    }
    return { kind: 'ok', file: emptyTaskState(), notice: `the task state at ${path} was corrupt (${parsed.reason}); it is kept as ${kept} and this run starts empty` };
  }
  if (parsed.kind === 'newer') return { kind: 'refused', message: `the task state at ${path} is from a newer format (${parsed.formatVersion}); rename or remove it to run tasks here` };
  return { kind: 'refused', message: `the task state at ${path} does not claim a Caotang format; rename or remove it to run tasks here` };
}

/** Writes the state whole, through a temporary file in the same directory, so a reader never sees half of it. */
export async function saveTaskState(path: string, file: TaskStateFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, serializeTaskState(file), 'utf8');
  await rename(tmp, path);
}
