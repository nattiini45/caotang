/**
 * The single-writer lock: one live writer per folder, a stale lock taken over, and a
 * lock never removed by a process that does not hold it.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { acquireProjectLock, LOCK_FILE, LOCK_TAKEOVER_FILE, ProjectLockedError } from '../src/index.js';
import { removeDir, tempDir } from './support.js';

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

  it('treats an unreadable lock that was just written as a write in progress, and an old one as stale', async () => {
    const recent = join(root, LOCK_FILE);
    writeFileSync(recent, '{"pid":');
    await expect(acquireProjectLock(root)).rejects.toBeInstanceOf(ProjectLockedError);

    const old = new Date(Date.now() - 60_000);
    utimesSync(recent, old, old);
    const lock = await acquireProjectLock(root);
    await lock.release();
    expect(existsSync(recent)).toBe(false);
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
            (lock) => lock,
            () => undefined,
          ),
        ),
      );
      const held = outcomes.filter((lock) => lock !== undefined);
      expect(held, `round ${round} left ${held.length} writers holding one folder`).toHaveLength(1);
      await held[0]?.release();
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
      expect((error as ProjectLockedError).takeoverMarker).toBe(marker);
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
      expect((error as ProjectLockedError).takeoverPid).toBe(process.pid);
      expect((error as ProjectLockedError).message).toContain(`pid ${process.pid}`);
    } finally {
      clearLock(root);
    }
  });
});
