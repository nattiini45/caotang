/**
 * The single-writer lock: one live writer per folder, a stale lock taken over, and a
 * lock never removed by a process that does not hold it.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import * as realFs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { acquireProjectLock, LOCK_FILE, LOCK_TAKEOVER_FILE, ProjectLockedError } from '../src/folder-api.js';
import type * as lockModule from '../src/lock.js';
import { removeDir, tempDir } from './support.js';

/**
 * The budget for the race below — explicit and per-test, never `vitest.config.ts`'s default.
 * The fixture is 40 rounds of eight writers taking one stale lock over, so it is 40 × 8 exclusive
 * creates, reads, markers and removals: the contention is the subject matter, not an accident.
 * Measured on one development machine: **315 ms** alone and **4 514 ms** under the full suite's
 * worker pool — within 500 ms of the default, so the default was never a budget for its claim.
 * 30 000 ms clears the recorded figures with headroom and still fails a hang. The sibling takeover
 * race in `packages/mcp-server/test/binary.test.ts` declares 180 000 ms for the same shape.
 */
const RACE_TIMEOUT = 30_000;

/**
 * The lock module with a scripted `node:fs/promises` in it. The two reads of the lock in one
 * takeover are the width of one write apart, and a write that fails is a fault of the disk, so
 * neither can be reached from outside the module: the test has to speak for the filesystem.
 */
async function withFs(overrides: Partial<typeof realFs>, run: (lock: typeof lockModule) => Promise<void>): Promise<void> {
  vi.resetModules();
  vi.doMock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof realFs>();
    return { ...actual, ...overrides };
  });
  try {
    await run(await import('../src/lock.js'));
  } finally {
    vi.doUnmock('node:fs/promises');
    vi.resetModules();
  }
}

/** A pid that belonged to a process which has exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  const pid = child.pid;
  await new Promise<void>((done) => child.once('exit', () => done()));
  if (pid === undefined) throw new Error('could not start a child process');
  return pid;
}

/** Clears the lock and the marker, whether or not they are there. */
function clearLock(root: string): void {
  for (const name of [LOCK_FILE, LOCK_TAKEOVER_FILE]) {
    const path = join(root, name);
    if (existsSync(path)) unlinkSync(path);
  }
}

describe('the project lock', () => {
  let root: string;

  beforeAll(() => {
    root = tempDir('lock');
  });

  afterAll(() => {
    removeDir(root);
  });

  it('is created while held, and removed on release', async () => {
    const lock = await acquireProjectLock(root);
    expect(existsSync(join(root, LOCK_FILE))).toBe(true);
    const holder = JSON.parse(readFileSync(join(root, LOCK_FILE), 'utf8')) as { pid: number };
    expect(holder.pid).toBe(process.pid);
    await lock.release();
    expect(existsSync(join(root, LOCK_FILE))).toBe(false);
  });

  it('refuses a second writer while the first is alive, and names the holder', async () => {
    const first = await acquireProjectLock(root);
    try {
      const error = await acquireProjectLock(root).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ProjectLockedError);
      expect((error as ProjectLockedError).holderPid).toBe(process.pid);
    } finally {
      await first.release();
    }
  });

  it('takes over a lock whose holder has exited', async () => {
    const pid = await deadPid();
    writeFileSync(join(root, LOCK_FILE), JSON.stringify({ pid, token: 'gone', startedAt: new Date().toISOString() }));
    const lock = await acquireProjectLock(root);
    const holder = JSON.parse(readFileSync(join(root, LOCK_FILE), 'utf8')) as { pid: number };
    expect(holder.pid).toBe(process.pid);
    await lock.release();
  });

  it('does not remove a lock it no longer holds', async () => {
    const lock = await acquireProjectLock(root);
    writeFileSync(join(root, LOCK_FILE), JSON.stringify({ pid: process.pid, token: 'someone-else', startedAt: 'x' }));
    await lock.release();
    expect(existsSync(join(root, LOCK_FILE))).toBe(true);
    lock.releaseSync();
    expect(existsSync(join(root, LOCK_FILE))).toBe(true);
    writeFileSync(join(root, LOCK_FILE), '');
  });

  it('refuses a lock it cannot read, and says how to clear it, because nothing proves whose it is', async () => {
    const path = join(root, LOCK_FILE);
    writeFileSync(path, '{"pid":');
    try {
      const error = await acquireProjectLock(root).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ProjectLockedError);
      expect((error as ProjectLockedError).refusal.unreadableLock).toBe(path);
      expect((error as ProjectLockedError).message).toContain(path);
      expect((error as ProjectLockedError).message).toMatch(/delete that file/);
      expect((error as ProjectLockedError).message).toMatch(/no other Caotang or MCP process is using the folder/);
      // The lock is left alone: a writer that is writing it right now would lose it.
      expect(existsSync(path)).toBe(true);
    } finally {
      clearLock(root);
    }
  });

  it('refuses a lock it cannot read whatever its age is, so no clock decides it', async () => {
    const path = join(root, LOCK_FILE);
    writeFileSync(path, '{"pid":');
    try {
      // An old lock whose body is lost, and a lock whose time is in the future because the clock
      // was stepped back. Neither is proof of a dead holder, and neither is taken over.
      const old = new Date(Date.now() - 60_000);
      utimesSync(path, old, old);
      const oldError = await acquireProjectLock(root).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(oldError).toBeInstanceOf(ProjectLockedError);
      expect((oldError as ProjectLockedError).refusal.unreadableLock).toBe(path);
      const future = new Date(Date.now() + 60_000);
      utimesSync(path, future, future);
      const futureError = await acquireProjectLock(root).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(futureError).toBeInstanceOf(ProjectLockedError);
      expect((futureError as ProjectLockedError).refusal.unreadableLock).toBe(path);
      expect(existsSync(path)).toBe(true);
    } finally {
      clearLock(root);
    }
  });

  it('gives a stale lock to exactly one of the writers that race for it', async () => {
    const pid = await deadPid();
    // Every round leaves one lock whose holder is gone, and every caller reaches the
    // takeover at the same moment, which is the window the takeover has to close.
    for (let round = 0; round < 40; round += 1) {
      const racing = join(root, LOCK_FILE);
      writeFileSync(racing, JSON.stringify({ pid, token: `gone-${round}`, startedAt: new Date().toISOString() }));
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, () =>
          acquireProjectLock(root).then(
            (lock) => ({ held: lock, refused: undefined }),
            (error: unknown) => ({ held: undefined, refused: error }),
          ),
        ),
      );
      const held = outcomes.flatMap((outcome) => (outcome.held === undefined ? [] : [outcome.held]));
      const refused = outcomes.flatMap((outcome) => (outcome.refused === undefined ? [] : [outcome.refused]));
      expect(held, `round ${round} left ${held.length} writers holding one folder`).toHaveLength(1);
      // Every other writer was refused for the lock, and not for some other failure of the takeover.
      expect(refused).toHaveLength(7);
      expect(refused.every((error) => error instanceof ProjectLockedError)).toBe(true);
      await held[0]?.release();
    }
  }, RACE_TIMEOUT);
});

describe('a name Windows refuses while another writer is deleting it', () => {
  let root: string;

  beforeAll(() => {
    root = tempDir('lock-deleting');
  });

  afterAll(() => {
    removeDir(root);
  });

  /**
   * The lock's exclusive create, refused on every attempt with `code`. `attempts` reads the
   * number of tries, so a test can pin the bound or its absence.
   */
  function createRefusedWith(code: string): { readonly open: typeof realFs.open; readonly attempts: () => number } {
    const lock = join(root, LOCK_FILE);
    let attempts = 0;
    return {
      attempts: () => attempts,
      open: (async (target: string, flags: string) => {
        if (String(target) !== lock) return realFs.open(target, flags as never);
        attempts += 1;
        throw Object.assign(new Error(`${code}: refused, open '${lock}'`), { code });
      }) as unknown as typeof realFs.open,
    };
  }

  /**
   * An exclusive create at a name another writer is deleting: Windows keeps the directory entry
   * until the delete completes and refuses the create with `EPERM`. Whoever loses the takeover
   * has to be refused for the lock, not fail with the operating system's words.
   */
  it('refuses the folder for the marked takeover, and does not fail with the refusal of the name', async () => {
    const pid = await deadPid();
    const lock = join(root, LOCK_FILE);
    const marker = join(root, LOCK_TAKEOVER_FILE);
    // A stale lock, and the marker of a takeover of it that died and left the marker behind.
    writeFileSync(lock, JSON.stringify({ pid, token: 'gone', startedAt: new Date().toISOString() }));
    writeFileSync(marker, JSON.stringify({ pid, token: 'marker', startedAt: new Date().toISOString() }));
    let attempts = 0;
    try {
      await withFs(
        {
          open: (async (target: string, flags: string) => {
            if (String(target) !== marker || flags !== 'wx') return realFs.open(target, flags as never);
            attempts += 1;
            // The marker is being removed at that moment: the first create is refused, and the
            // name is still there when the writer looks again.
            if (attempts === 1) {
              throw Object.assign(new Error(`EPERM: operation not permitted, open '${marker}'`), { code: 'EPERM' });
            }
            return realFs.open(target, flags as never);
          }) as unknown as typeof realFs.open,
        },
        async (lockModule) => {
          const error = await lockModule.acquireProjectLock(root).then(
            () => undefined,
            (caught: unknown) => caught,
          );
          expect(error).toBeInstanceOf(lockModule.ProjectLockedError);
          expect((error as ProjectLockedError).refusal.takeoverMarker).toBe(marker);
          expect((error as ProjectLockedError).message).toContain(marker);
        },
      );
      // The create was tried once more: the first refusal was the delete in progress, not the folder.
      expect(attempts).toBe(2);
      // Neither file was the loser's to remove.
      expect(existsSync(lock)).toBe(true);
      expect(existsSync(marker)).toBe(true);
    } finally {
      clearLock(root);
    }
  });

  it('takes the lock when its own name is refused for a moment while it is being removed', async () => {
    const lock = join(root, LOCK_FILE);
    let attempts = 0;
    try {
      await withFs(
        {
          open: (async (target: string, flags: string) => {
            if (String(target) !== lock || flags !== 'wx') return realFs.open(target, flags as never);
            attempts += 1;
            // The lock of a writer that has only the release left to do: its name is refused
            // for a moment, and the next attempt creates this writer's lock.
            if (attempts === 1) {
              throw Object.assign(new Error(`EPERM: operation not permitted, open '${lock}'`), { code: 'EPERM' });
            }
            return realFs.open(target, flags as never);
          }) as unknown as typeof realFs.open,
        },
        async (lockModule) => {
          const held = await lockModule.acquireProjectLock(root);
          const holder = JSON.parse(readFileSync(lock, 'utf8')) as { pid: number };
          expect(holder.pid).toBe(process.pid);
          await held.release();
        },
      );
      expect(attempts).toBe(2);
      expect(existsSync(lock)).toBe(false);
    } finally {
      clearLock(root);
    }
  });

  it("reports a refusal that outlasts the tries as the folder's, rather than as lock contention", async () => {
    const refusal = createRefusedWith('EPERM');
    await withFs({ open: refusal.open }, async (lockModule) => {
      const error = await lockModule.acquireProjectLock(root).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).not.toBeInstanceOf(lockModule.ProjectLockedError);
      expect((error as NodeJS.ErrnoException).code).toBe('EPERM');
    });
    // Every attempt was refused: a refusal that outlasts the tries cannot be told apart from a
    // genuine denial, so it is rethrown as the folder's own, not as lock contention. The bound is
    // exact — the first try and five retries — because the spec promises six tries in all.
    expect(refusal.attempts()).toBe(6);
  });

  it('does not retry a refusal that is not Windows deleting the name', async () => {
    // Only `EPERM` is retried: an error the operating system reports as another code is not
    // assumed to mean a delete, and is thrown at once.
    for (const code of ['EACCES', 'EBUSY', 'ENOSPC']) {
      const refusal = createRefusedWith(code);
      await withFs({ open: refusal.open }, async (lockModule) => {
        const error = await lockModule.acquireProjectLock(root).then(
          () => undefined,
          (caught: unknown) => caught,
        );
        expect((error as NodeJS.ErrnoException).code).toBe(code);
      });
      expect(refusal.attempts(), `${code} was retried`).toBe(1);
    }
  });
});

describe('a takeover marker left behind by a writer that died', () => {
  let root: string;

  beforeAll(() => {
    root = tempDir('lock-takeover');
  });

  afterAll(() => {
    removeDir(root);
  });

  it('refuses the folder while a takeover is marked, and says which file is in the way and how to clear it', async () => {
    const pid = await deadPid();
    // A stale lock, and the marker of a takeover of it that will never finish.
    writeFileSync(join(root, LOCK_FILE), JSON.stringify({ pid, token: 'gone', startedAt: new Date().toISOString() }));
    const marker = join(root, LOCK_TAKEOVER_FILE);
    writeFileSync(marker, JSON.stringify({ pid, token: 'marker', startedAt: new Date().toISOString() }));
    try {
      const error = await acquireProjectLock(root).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ProjectLockedError);
      expect((error as ProjectLockedError).refusal.takeoverMarker).toBe(marker);
      expect((error as ProjectLockedError).message).toContain(marker);
      expect((error as ProjectLockedError).message).toMatch(/delete that file/);
      expect((error as ProjectLockedError).message).toMatch(/no other Caotang or MCP process is using the folder/);
      // The marker in the way is left where it is: it is not the writer's to remove.
      expect(existsSync(marker)).toBe(true);
    } finally {
      clearLock(root);
    }
  });

  it('names the writer that marked a takeover, so the person can tell a live takeover from one that died', async () => {
    const pid = await deadPid();
    writeFileSync(join(root, LOCK_FILE), JSON.stringify({ pid, token: 'gone', startedAt: new Date().toISOString() }));
    const marker = join(root, LOCK_TAKEOVER_FILE);
    writeFileSync(marker, JSON.stringify({ pid: process.pid, token: 'marker', startedAt: new Date().toISOString() }));
    try {
      const error = await acquireProjectLock(root).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ProjectLockedError);
      expect((error as ProjectLockedError).refusal.takeoverPid).toBe(process.pid);
      expect((error as ProjectLockedError).message).toContain(`pid ${process.pid}`);
      // The writer that marked it is still running, so the advice is to wait for it. The way out
      // is named as well, because a pid is reused and the process that made the marker may have
      // been gone for a long time.
      expect((error as ProjectLockedError).message).toMatch(/still running/);
      expect((error as ProjectLockedError).message).toMatch(/wait for it to finish/);
      expect((error as ProjectLockedError).message).toMatch(/no other Caotang or MCP process is using the folder/);
      expect((error as ProjectLockedError).message).not.toMatch(/the next writer takes the lock over/);
    } finally {
      clearLock(root);
    }
  });

  it('waits for a takeover whose marker is still being written, and does not tell the person to delete it', async () => {
    const pid = await deadPid();
    writeFileSync(join(root, LOCK_FILE), JSON.stringify({ pid, token: 'gone', startedAt: new Date().toISOString() }));
    const marker = join(root, LOCK_TAKEOVER_FILE);
    // The marker of a takeover that has created the file and not written its body yet.
    writeFileSync(marker, '');
    // The marker is pinned to a time in the future, so the refusal says it is being marked right
    // now however long this test takes: a marker read five seconds after it was written looks
    // like an orphan, and then the clock would decide the outcome instead of the code.
    const beingMarked = new Date(Date.now() + 60_000);
    utimesSync(marker, beingMarked, beingMarked);
    try {
      const error = await acquireProjectLock(root).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ProjectLockedError);
      expect((error as ProjectLockedError).refusal.takeoverMarker).toBe(marker);
      expect((error as ProjectLockedError).refusal.takeoverPid).toBeUndefined();
      // The takeover may be running right now, so the refusal does not hand out the advice to
      // delete the file it is using.
      expect((error as ProjectLockedError).message).toMatch(/being marked right now/);
      expect((error as ProjectLockedError).message).not.toMatch(/delete that file/);
    } finally {
      clearLock(root);
    }
  });

  it('names a marker whose body says nothing and that has been there for a while, and says how to clear it', async () => {
    const pid = await deadPid();
    writeFileSync(join(root, LOCK_FILE), JSON.stringify({ pid, token: 'gone', startedAt: new Date().toISOString() }));
    const marker = join(root, LOCK_TAKEOVER_FILE);
    writeFileSync(marker, '{"pid":');
    const old = new Date(Date.now() - 60_000);
    utimesSync(marker, old, old);
    try {
      const error = await acquireProjectLock(root).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ProjectLockedError);
      expect((error as ProjectLockedError).refusal.takeoverMarker).toBe(marker);
      expect((error as ProjectLockedError).refusal.takeoverPid).toBeUndefined();
      // The marker has been there for a while, so it is an orphan, and the way out is named.
      expect((error as ProjectLockedError).message).not.toMatch(/being marked right now/);
      expect((error as ProjectLockedError).message).toMatch(/delete that file/);
      expect((error as ProjectLockedError).message).toMatch(/no other Caotang or MCP process is using the folder/);
    } finally {
      clearLock(root);
    }
  });

  it('takes the lock in a folder that holds only a marker, and leaves the marker where it is', async () => {
    const pid = await deadPid();
    const marker = join(root, LOCK_TAKEOVER_FILE);
    // A folder with a marker of a takeover that died, and no lock: there is nothing to take over,
    // so the lock is taken and the marker is left where it is.
    writeFileSync(marker, JSON.stringify({ pid, token: 'marker', startedAt: new Date().toISOString() }));
    const lock = await acquireProjectLock(root);
    const holder = JSON.parse(readFileSync(join(root, LOCK_FILE), 'utf8')) as { pid: number };
    expect(holder.pid).toBe(process.pid);
    // The marker is left where it is: it is not the writer's to remove.
    expect(existsSync(marker)).toBe(true);
    await lock.release();
  });

  it('names a marker left beside the lock of a live holder, because a later writer would be refused for it', async () => {
    const pid = await deadPid();
    const marker = join(root, LOCK_TAKEOVER_FILE);
    writeFileSync(marker, JSON.stringify({ pid, token: 'marker', startedAt: new Date().toISOString() }));
    const lock = await acquireProjectLock(root);
    try {
      const error = await acquireProjectLock(root).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ProjectLockedError);
      expect((error as ProjectLockedError).holderPid).toBe(process.pid);
      // The refusal names the marker as well: it is in the folder, and it is what the person has
      // to clear once the holder is gone.
      expect((error as ProjectLockedError).refusal.takeoverMarker).toBe(marker);
      expect((error as ProjectLockedError).message).toContain(marker);
      expect((error as ProjectLockedError).message).toMatch(/no other Caotang or MCP process is using the folder/);
    } finally {
      await lock.release();
      clearLock(root);
    }
  });
  it('names a marker it could not read, because a read that failed is not a marker that is gone', async () => {
    const pid = await deadPid();
    writeFileSync(join(root, LOCK_FILE), JSON.stringify({ pid, token: 'gone', startedAt: new Date().toISOString() }));
    const marker = join(root, LOCK_TAKEOVER_FILE);
    writeFileSync(marker, JSON.stringify({ pid: process.pid, token: 'marker', startedAt: new Date().toISOString() }));
    // The marker is pinned to a time in the future, so the unreadable branch is the one that is
    // reported however long this test takes.
    const beingMarked = new Date(Date.now() + 60_000);
    utimesSync(marker, beingMarked, beingMarked);
    try {
      await withFs(
        {
          readFile: (async (target: string, options?: unknown) => {
            if (String(target).endsWith(LOCK_TAKEOVER_FILE)) {
              throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
            }
            return realFs.readFile(target, options as never);
          }) as unknown as typeof realFs.readFile,
        },
        async (lock) => {
          const error = await lock.acquireProjectLock(root).then(
            () => undefined,
            (caught: unknown) => caught,
          );
          expect(error).toBeInstanceOf(lock.ProjectLockedError);
          // The marker is still in the folder, and the refusal names it: a read that failed is
          // not a marker that is gone.
          expect((error as ProjectLockedError).refusal.takeoverMarker).toBe(marker);
          expect((error as ProjectLockedError).message).toContain(marker);
          // The marker on disk names this process, so a read that went through would report its
          // pid and say that the writer that marked it is still running. The pid is undefined and
          // the refusal is the unreadable branch, so the read that failed is what is reported.
          expect((error as ProjectLockedError).refusal.takeoverPid).toBeUndefined();
          expect((error as ProjectLockedError).message).toMatch(/being marked right now/);
          expect((error as ProjectLockedError).message).not.toMatch(/still running/);
        },
      );
    } finally {
      clearLock(root);
    }
  });
});

describe('a takeover that finds a lock another writer is writing', () => {
  let root: string;

  beforeAll(() => {
    root = tempDir('lock-winner');
  });

  afterAll(() => {
    removeDir(root);
  });

  it('leaves the lock of the writer that won alone, and refuses the folder instead', async () => {
    const pid = await deadPid();
    const path = join(root, LOCK_FILE);
    const stale = JSON.stringify({ pid, token: 'gone', startedAt: new Date().toISOString() });
    writeFileSync(path, stale);
    let reads = 0;
    await withFs(
      {
        readFile: (async (target: string, options?: unknown) => {
          if (String(target) !== path) return realFs.readFile(target, options as never);
          reads += 1;
          // The first read is the judgment, and sees the stale lock. The second is the
          // takeover's re-read, and sees the winner's lock: created, and not yet written.
          return reads === 1 ? stale : '';
        }) as unknown as typeof realFs.readFile,
      },
      async (lock) => {
        const error = await lock.acquireProjectLock(root).then(
          () => undefined,
          (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(lock.ProjectLockedError);
        // The winner's lock is still there: the loser refused the folder rather than take it.
        expect(existsSync(path)).toBe(true);
      },
    );
  });

  it('does not call a lock unreadable once it can be read, so the refusal does not tell the person to delete it', async () => {
    const pid = await deadPid();
    const path = join(root, LOCK_FILE);
    const stale = JSON.stringify({ pid, token: 'gone', startedAt: new Date().toISOString() });
    const winner = JSON.stringify({ pid: process.pid, token: 'winner', startedAt: new Date().toISOString() });
    writeFileSync(path, stale);
    let reads = 0;
    await withFs(
      {
        readFile: (async (target: string, options?: unknown) => {
          if (String(target) !== path) return realFs.readFile(target, options as never);
          reads += 1;
          // The first read is the judgment, and sees the stale lock. The second is the takeover's
          // re-read, and fails: the winner's lock is being written at that moment. The third is
          // the read that follows it, and sees the winner's lock, whole.
          if (reads === 1) return stale;
          if (reads === 2) return '';
          return winner;
        }) as unknown as typeof realFs.readFile,
      },
      async (lock) => {
        const error = await lock.acquireProjectLock(root).then(
          () => undefined,
          (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(lock.ProjectLockedError);
        // The lock can be read, so the refusal does not say it cannot: the advice to delete the
        // file is not given for the lock of a writer that is holding the folder.
        expect((error as ProjectLockedError).refusal.unreadableLock).toBeUndefined();
        expect((error as ProjectLockedError).message).not.toMatch(/could not be read/);
        // The winner's lock is still there: the loser refused the folder rather than take it.
        expect(existsSync(path)).toBe(true);
      },
    );
  });

  it('leaves no marker behind when the marker cannot be written, so the folder is not refused for good', async () => {
    const pid = await deadPid();
    const path = join(root, LOCK_FILE);
    const marker = join(root, LOCK_TAKEOVER_FILE);
    writeFileSync(path, JSON.stringify({ pid, token: 'gone', startedAt: new Date().toISOString() }));
    const full = async (target: string, flags: string): Promise<FileHandle> => realFs.open(target, flags as never);
    let failed = false;
    await withFs(
      {
        open: (async (target: string, flags: string) => {
          const handle = await full(target, flags);
          if (failed || !String(target).endsWith(LOCK_TAKEOVER_FILE)) return handle;
          failed = true;
          // The marker is created and then filled: a write that fails leaves the file behind.
          return {
            writeFile: async () => {
              throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
            },
            close: () => handle.close(),
          } as unknown as FileHandle;
        }) as unknown as typeof realFs.open,
      },
      async (lock) => {
        const error = await lock.acquireProjectLock(root).then(
          () => undefined,
          (caught: unknown) => caught,
        );
        expect((error as Error).message).toContain('ENOSPC');
        // The marker that could not be written is gone: it refuses every later writer.
        expect(existsSync(marker)).toBe(false);
        // The stale lock is still there: the takeover never happened.
        expect(existsSync(path)).toBe(true);
        // And the next writer takes the folder over, because nothing is in the way.
        const taken = await lock.acquireProjectLock(root);
        await taken.release();
        expect(existsSync(path)).toBe(false);
      },
    );
  });
});
