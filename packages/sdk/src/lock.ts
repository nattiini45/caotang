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
 *
 * A lock is taken over only when its body says whose it is and that holder is gone. A lock
 * whose body cannot be read says nothing, so it is never taken over: a writer that is writing
 * it right now would lose it, and the age of a file is not proof of anything. The folder is
 * refused instead, and the refusal names the file and says how to clear it. The price of that
 * rule is a writer that is killed between creating the lock and writing its body: it leaves a
 * lock that nobody may take over, and the folder is cleared by hand.
 *
 * Windows refuses an exclusive create at a name another writer is deleting with `EPERM` until
 * the delete finishes, which is contention and not a folder this process may not write. The
 * name is tried again up to six times, waiting 25 ms times the try, which spends at most 375 ms.
 * A refusal that outlasts those tries cannot be told apart from a genuine denial, so it is
 * treated as the folder's own and thrown as it is: the cost of that rule is a delete-pending
 * window longer than the bound reported as a folder that cannot be written, never a folder that
 * cannot be written reported as one another writer holds. Only `EPERM` is retried, because that
 * is the code the measured race produced; `EACCES` and `EBUSY` were not measured for that window,
 * so they are not read as contention and are thrown at once.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { open, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const LOCK_FILE = '.caotang-mcp.lock';

/** The marker a takeover of a stale lock writes beside the lock, in the same folder. */
export const LOCK_TAKEOVER_FILE = `${LOCK_FILE}.takeover`;

/**
 * A marker written this recently is a takeover that is running right now, not one left behind.
 * It decides what the refusal says about the marker, and nothing else.
 */
const MARKER_FRESH_MS = 5_000;

/**
 * How many times an exclusive create is tried while Windows is deleting the name, and how long
 * the wait grows between tries. The refusal is `EPERM` while the directory entry is in the way of
 * the delete; it says nothing about which writer is in the way — in a measured eight-writer race
 * of exclusive creates and removals, the name was already gone for 105 of 144 refusals — so the
 * create is tried again, as the folder port retries the sharing errors of a file another program
 * holds. Every measured refusal resolved within two retries; the wait grows with the try, as
 * those do. Six tries at 25 ms times the try spend at most 375 ms, and a refusal that survives
 * the last one is treated as the folder's own and rethrown, because it cannot be told apart from
 * a genuine denial.
 */
const EXCLUSIVE_CREATE_ATTEMPTS = 6;
const EXCLUSIVE_CREATE_RETRY_MS = 25;

/**
 * What the folder holds that the refusal is about: a lock that cannot be read, or a marker of a
 * takeover. They are named in the message, because a folder refused for a file nobody can read
 * is otherwise a folder nobody can open, and the file is the one thing in it that says why.
 */
export interface LockRefusal {
  /** The lock file, when its body could not be read. Nothing says whose it is, so it is not taken over. */
  readonly unreadableLock?: string;
  /** The marker of a takeover that is still marked, when the refusal is because of one. */
  readonly takeoverMarker?: string;
  /** The pid that marked it, when its body could be read. */
  readonly takeoverPid?: number;
  /** Whether the marker is being written right now, rather than one left behind by a writer that died. */
  readonly takeoverFresh?: boolean;
}

export class ProjectLockedError extends Error {
  constructor(
    readonly root: string,
    readonly holderPid: number | undefined,
    readonly refusal: LockRefusal = {},
  ) {
    const holder = holderPid === undefined ? '' : ` (pid ${holderPid})`;
    super(
      `the project folder ${root} is in use by another writer${holder}; one writer at a time, so this process did not open it${markerRecovery(refusal, holderPid !== undefined)}${unreadableRecovery(refusal)}`,
    );
    this.name = 'ProjectLockedError';
  }
}

/**
 * What the refusal says about the marker of a takeover in the folder. The marker names the writer
 * that made it, so a person can tell a takeover that is running from one that died and left it
 * behind. A marker whose body says nothing is a writer that has not said who it is yet, so the
 * age of the marker says it instead: a marker being written right now is a takeover in progress,
 * and one that has been there for a while is an orphan.
 *
 * A live pid is not proof that the takeover is running either: a pid is reused, and the process
 * that has it now may never have made the marker. So the branch that waits also names the way
 * out, guarded by the folder being free of other writers.
 */
function markerRecovery(refusal: LockRefusal, holderAlive: boolean): string {
  const marker = refusal.takeoverMarker;
  if (marker === undefined) return '';
  const pid = refusal.takeoverPid;
  const named = pid === undefined ? marker : `${marker} (pid ${pid})`;
  if (pid !== undefined && processAlive(pid)) {
    return `; a takeover of the lock is marked by ${named} in that folder, and the writer that marked it is still running: wait for it to finish — and if it does not finish, and no other Caotang or MCP process is using the folder, delete that file`;
  }
  if (refusal.takeoverFresh === true) {
    return `; a takeover of the lock is marked by ${marker} in that folder, and it is being marked right now: wait a moment for it to finish`;
  }
  // The marker is an orphan. Deleting it is what lets a writer take the lock over, but only
  // once no other writer holds it.
  const taken = holderAlive ? '' : ', and the next writer takes the lock over';
  return `; a takeover of the lock is marked by ${named} in that folder: if no other Caotang or MCP process is using the folder, delete that file${taken}`;
}

/**
 * What the refusal says about a lock whose body could not be read. Nothing says whose it is, so
 * it is not taken over, and the file is named: a folder nobody can open is a folder the person
 * has to clear by hand.
 */
function unreadableRecovery(refusal: LockRefusal): string {
  const lock = refusal.unreadableLock;
  if (lock === undefined) return '';
  return `; the lock file ${lock} could not be read: a writer may be writing it right now, so wait a moment for it; if it stays that way, and no other Caotang or MCP process is using the folder, delete that file`;
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
  for (let attempt = 1; ; attempt += 1) {
    let handle;
    try {
      handle = await open(path, 'wx');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return false;
      // A name another writer is deleting is refused with `EPERM` until the delete finishes. The
      // name is free a moment later, so the create is tried again. Only `EPERM` is retried: a
      // refusal that outlasts the tries is treated as the folder's and rethrown, and an error of
      // another code is not assumed to mean a delete.
      if (code !== 'EPERM' || attempt >= EXCLUSIVE_CREATE_ATTEMPTS) throw error;
      await new Promise((done) => setTimeout(done, EXCLUSIVE_CREATE_RETRY_MS * attempt));
      continue;
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
}

/**
 * What a takeover of a stale lock came to: the lock was removed, a takeover of it is still marked
 * and must not be started over, another writer replaced the lock first, or the lock could not be
 * read and so cannot be taken over at all.
 */
type Takeover = 'taken' | 'marker-busy' | 'replaced' | 'unreadable';

/**
 * Takes a stale lock out of the way of the writer allowed to replace it. Two writers can
 * read the same lock and both judge it stale, and both would then remove it and each
 * create a lock of its own. The removal therefore elects one of them first: a marker file
 * beside the lock is created exclusively (`wx`), which no two writers can do, and only
 * its creator removes the lock. The body is read again first, so a lock another writer
 * already replaced is never removed — that is what the marker cannot prove on its own.
 * A lock that cannot be read is not removed at all: nothing says whose it is, so the writer
 * that owns it may be writing it right now, and removing it takes the lock from that writer.
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
      // The lock cannot be read. It is either the stale one, whose body is lost, or the lock of
      // a writer that is writing it right now. Nothing says which, and the age of the file says
      // nothing either: a write that is slow looks exactly like a file left behind. The lock is
      // left alone, and the folder is refused.
      //
      // The lock may also be gone: another writer took it over already. There is nothing of the
      // stale lock left to remove, and removing whatever is at the path now would remove the
      // lock of the writer that took it over.
      if (!(await exists(path))) return 'taken';
      // The path is occupied, but the body may have become readable in the meantime: the writer
      // that won the takeover writes its own lock there. The body is read once more, so a lock
      // that is readable is never called unreadable — the refusal would tell the person to
      // delete the lock of a writer that is holding the folder.
      const again = parseBody(await readFile(path, 'utf8').catch(() => ''));
      if (again !== undefined) {
        if (again.token !== staleToken) return 'replaced';
        await unlink(path).catch(() => undefined);
        return 'taken';
      }
      return 'unreadable';
    }
    await unlink(path).catch(() => undefined);
    return 'taken';
  } finally {
    await unlink(marker).catch(() => undefined);
  }
}

/** Whether the file is there. */
async function exists(path: string): Promise<boolean> {
  return await stat(path).then(
    () => true,
    () => false,
  );
}

/** What the folder holds beside the lock: a marker of a takeover that is marked. */
interface Marker {
  readonly path: string;
  /** The pid that marked it, when its body could be read. */
  readonly pid: number | undefined;
  /** Whether it is being written right now, rather than one left behind. */
  readonly fresh: boolean;
}

/**
 * Reads the marker of a takeover, if the folder holds one. A read that failed for any reason
 * other than "it is not there" does not mean the marker is gone: a marker that cannot be read
 * is a marker whose writer may still be running, and the refusal has to say that rather than
 * send the person after a file that is not in the folder.
 */
async function readMarker(path: string): Promise<Marker | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return { path, pid: undefined, fresh: await isFresh(path) };
  }
  const pid = parseBody(text)?.pid;
  return { path, pid, fresh: pid === undefined ? await isFresh(path) : false };
}

/**
 * Whether the file was written recently. A time in the future — a clock stepped back — counts as
 * recent, because the advice to wait is the harmless one and the advice to delete a file is not.
 */
async function isFresh(path: string): Promise<boolean> {
  const mtimeMs = await stat(path).then((info) => info.mtimeMs, () => undefined);
  if (mtimeMs === undefined) return false;
  return Date.now() - mtimeMs < MARKER_FRESH_MS;
}

/**
 * Takes the project's lock. Throws {@link ProjectLockedError} when a live process
 * holds it. A lock whose holder is gone is taken over by one writer: the stale lock is
 * removed under an exclusive marker and that writer's own lock is created in its place.
 * A lock whose body cannot be read is not taken over at all, and the folder is refused.
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
    const text = await readFile(path, 'utf8').catch(() => undefined);
    let holder = text === undefined ? undefined : parseBody(text);
    if (holder === undefined) {
      // The lock cannot be read. Nothing says whose it is, so it cannot be proven stale, and a
      // writer that is writing it right now would lose it: the folder is refused, and the
      // refusal names the file and says how to clear it. A lock that is gone is one another
      // writer took over, and this one tries the lock again.
      if (!(await exists(path))) continue;
      // The path is occupied, but the body may have become readable in the meantime: a writer
      // that took the lock over writes its own body there. The body is read once more, so a
      // lock that is readable is never refused as one that cannot be read, and the advice to
      // delete it is never given for the lock of a writer that is holding the folder.
      const again = await readFile(path, 'utf8').catch(() => undefined);
      holder = again === undefined ? undefined : parseBody(again);
      if (holder === undefined) throw new ProjectLockedError(root, undefined, { unreadableLock: path });
    }
    if (processAlive(holder.pid)) {
      // The holder is alive, so the folder is refused for it. A marker of a takeover left beside
      // its lock is named as well: it is a file in the folder that a later writer would be
      // refused for, and the person has to clear it.
      const marked = await readMarker(join(root, LOCK_TAKEOVER_FILE));
      throw new ProjectLockedError(root, holder.pid, marked === undefined ? {} : {
        takeoverMarker: marked.path,
        takeoverPid: marked.pid,
        takeoverFresh: marked.fresh,
      });
    }
    const outcome = await removeStale(path, holder.token);
    if (outcome !== 'taken') {
      // Another writer took the stale lock over, or a takeover of it is still marked. A marked
      // takeover names its marker, so the person can see what is in the way and how to clear it.
      if (outcome === 'marker-busy') {
        // The writer that won the takeover may have finished it and removed the marker already:
        // a refusal that names a file that is not there sends the person after nothing. The
        // marker is read once, and the read is the answer to whether it is still there.
        const marked = await readMarker(join(root, LOCK_TAKEOVER_FILE));
        if (marked === undefined) throw new ProjectLockedError(root, undefined);
        throw new ProjectLockedError(root, undefined, {
          takeoverMarker: marked.path,
          takeoverPid: marked.pid,
          takeoverFresh: marked.fresh,
        });
      }
      // The lock of the writer that won could not be read, so it cannot be taken from it.
      if (outcome === 'unreadable') throw new ProjectLockedError(root, undefined, { unreadableLock: path });
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
