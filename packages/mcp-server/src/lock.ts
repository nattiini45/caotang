/**
 * The single-writer lock — one writer per project folder at a time.
 *
 * A project folder is written by Caotang's desktop app and by this server, and a
 * second writer on the same folder would interleave manifest rotations and lose
 * one side's edits. The lock is a file in the folder, created exclusively
 * (`wx`) and removed on exit. It records the holder's pid so that a lock left
 * by a process that died is recognised and taken over, not honoured forever:
 * the server never sleeps on a stale lock, and it never removes a lock whose
 * holder is still alive.
 *
 * The file is `.caotang-mcp.lock` at the folder root. It is not one of §1's
 * artifact files, so the loader ignores it, and it is not in `docs/` or `codex/`,
 * so no save prunes it.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { open, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const LOCK_FILE = '.caotang-mcp.lock';

/** The marker a takeover of a stale lock writes beside the lock, in the same folder. */
export const LOCK_TAKEOVER_FILE = `${LOCK_FILE}.takeover`;

/** A lock younger than this, with no readable holder, is a write in progress and not a stale lock. */
const FRESH_MS = 5_000;

export class ProjectLockedError extends Error {
  constructor(
    readonly root: string,
    readonly holderPid: number | undefined,
    /**
     * The marker of a takeover that is still marked, when the refusal is because of one, and
     * the pid that marked it when it can be read. They are named in the message, because a
     * folder refused for a marker left by a writer that died is otherwise a folder nobody can
     * open, and the marker is the one thing in it that says why.
     */
    readonly takeoverMarker: string | undefined = undefined,
    readonly takeoverPid: number | undefined = undefined,
  ) {
    const holder = holderPid === undefined ? '' : ` (pid ${holderPid})`;
    const recovery =
      takeoverMarker === undefined
        ? ''
        : takeoverPid !== undefined && processAlive(takeoverPid)
          ? `; a takeover of the lock is marked by ${takeoverMarker} (pid ${takeoverPid}) in that folder, and the writer that marked it is still running: wait for it to finish`
          : `; a takeover of the lock is marked by ${takeoverMarker}${takeoverPid === undefined ? '' : ` (pid ${takeoverPid})`} in that folder: if no other Caotang or MCP process is using the folder, delete that file and the next writer takes the lock over`;
    super(`the project folder ${root} is in use by another writer${holder}; one writer at a time, so this process did not open it${recovery}`);
    this.name = 'ProjectLockedError';
  }
}

export interface ProjectLock {
  readonly path: string;
  /** Removes the lock if this process still holds it. */
  release(): Promise<void>;
  /** The same, synchronously, for an `exit` handler, which cannot await. */
  releaseSync(): void;
}

interface LockBody {
  readonly pid: number;
  readonly token: string;
  readonly startedAt: string;
}

/** Whether a pid names a live process. `EPERM` means it exists but belongs to someone else. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseBody(text: string): LockBody | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return undefined;
    const { pid, token, startedAt } = value as Record<string, unknown>;
    if (typeof pid !== 'number' || typeof token !== 'string' || typeof startedAt !== 'string') return undefined;
    return { pid, token, startedAt };
  } catch {
    return undefined;
  }
}

/** Creates the lock file exclusively. `false` when it already exists. */
async function createExclusive(path: string, body: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    await handle.writeFile(body, 'utf8');
  } catch (error) {
    // The file was created but could not be filled: it is removed here, because a file that
    // cannot be read is a file the folder is refused on, and a lock or a marker left behind
    // is one that nobody else cleans up.
    await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return true;
}

/**
 * What a takeover of a stale lock came to: the lock was removed, a takeover of it is still marked
 * and must not be started over, or another writer replaced the lock first.
 */
type Takeover = 'taken' | 'marker-busy' | 'replaced';

/**
 * Takes a stale lock out of the way of the writer allowed to replace it. Two writers can
 * read the same lock and both judge it stale, and both would then remove it and each
 * create a lock of its own. The removal therefore elects one of them first: a marker file
 * beside the lock is created exclusively (`wx`), which no two writers can do, and only
 * its creator removes the lock. The body is read again first, so a lock another writer
 * already replaced is never removed — that is what the marker cannot prove on its own.
 * A lock that cannot be read is removed only when it is old: a fresh one is a writer that
 * is writing it now, and removing it would take the lock from the writer that won.
 *
 * The marker is a takeover in progress, not a project artifact, so it lives beside the
 * lock only for the length of that one removal and is never left behind. A writer that
 * finds one takes it as a lock that is in use, and does not start a takeover of its own:
 * the marker is the record of a writer whose own lock is on its way, and it must not be
 * turned into a lock that a second writer can take over. The marker names the writer that
 * made it, so that a writer refused because of one can say which file is in the way.
 */
async function removeStale(path: string, staleToken: string): Promise<Takeover> {
  const marker = `${path}.takeover`;
  const body = `${JSON.stringify({ pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString() }, null, 2)}\n`;
  if (!(await createExclusive(marker, body))) return 'marker-busy';
  try {
    // The body is read again first: the lock removed is the one judged stale, and a lock
    // another writer already replaced in the meantime is left to that writer.
    const text = await readFile(path, 'utf8').catch(() => '');
    const current = parseBody(text);
    if (current !== undefined) {
      if (current.token !== staleToken) return 'replaced';
    } else {
      // The lock cannot be read. It is either the stale one, and it is old, or it is the lock of
      // a writer that is writing it right now: the file exists but its body is not in it yet.
      // An unreadable lock that is fresh belongs to that writer, and removing it would take the
      // lock away from the writer that won the takeover.
      const mtimeMs = await stat(path).then((info) => info.mtimeMs, () => undefined);
      if (mtimeMs === undefined) {
        // The lock is gone: another writer took it over already. There is nothing of the stale
        // lock left to remove, and removing whatever is at the path now would remove the lock
        // of the writer that took it over.
        return 'taken';
      }
      if (Date.now() - mtimeMs < FRESH_MS) return 'replaced';
    }
    await unlink(path).catch(() => undefined);
    return 'taken';
  } finally {
    await unlink(marker).catch(() => undefined);
  }
}

/**
 * Takes the project's lock. Throws {@link ProjectLockedError} when a live process
 * holds it. A lock whose holder is gone is taken over by one writer: the stale lock is
 * removed under an exclusive marker and that writer's own lock is created in its place.
 */
export async function acquireProjectLock(root: string, now: Date = new Date()): Promise<ProjectLock> {
  const path = join(root, LOCK_FILE);
  const token = randomUUID();
  const body = `${JSON.stringify({ pid: process.pid, token, startedAt: now.toISOString() }, null, 2)}\n`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await createExclusive(path, body)) {
      return {
        path,
        release: () => releaseOwned(path, token),
        releaseSync: () => releaseOwnedSync(path, token),
      };
    }
    const holder = parseBody(await readFile(path, 'utf8').catch(() => ''));
    if (holder !== undefined) {
      if (processAlive(holder.pid)) throw new ProjectLockedError(root, holder.pid);
    } else if (Date.now() - (await stat(path).then((info) => info.mtimeMs).catch(() => 0)) < FRESH_MS) {
      // Unreadable and recent: another writer is between creating the file and writing it.
      throw new ProjectLockedError(root, undefined);
    }
    const outcome = await removeStale(path, holder?.token ?? '');
    if (outcome !== 'taken') {
      // Another writer took the stale lock over, or a takeover of it is still marked. A marked
      // takeover names its marker, so the person can see what is in the way and how to clear it.
      if (outcome === 'marker-busy') {
        const marker = join(root, LOCK_TAKEOVER_FILE);
        // The writer that won the takeover may have finished it and removed the marker already:
        // a refusal that names a file that is not there sends the person after nothing. The
        // marker is read once, and the read is the answer to whether it is still there.
        const marked = await readFile(marker, 'utf8').catch(() => undefined);
        if (marked === undefined) throw new ProjectLockedError(root, undefined);
        throw new ProjectLockedError(root, undefined, marker, parseBody(marked)?.pid);
      }
      throw new ProjectLockedError(root, undefined);
    }
  }
  throw new ProjectLockedError(root, undefined);
}

async function releaseOwned(path: string, token: string): Promise<void> {
  const holder = parseBody(await readFile(path, 'utf8').catch(() => ''));
  if (holder?.token !== token) return;
  await unlink(path).catch(() => undefined);
}

function releaseOwnedSync(path: string, token: string): void {
  let holder: LockBody | undefined;
  try {
    holder = parseBody(readFileSync(path, 'utf8'));
  } catch {
    return;
  }
  if (holder?.token !== token) return;
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or the folder is no longer there: nothing left to remove.
  }
}
