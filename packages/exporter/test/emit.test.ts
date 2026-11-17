/**
 * The emit stage on its own — exporter.md §2 stage 4, against an in-memory folder.
 *
 * These tests are about the three things the queue is for: that names are unique
 * against what is on disk, that the artifact and its log row land in order, and
 * that a failure is recorded rather than swallowed. The bus is not involved; the
 * integration tests in `exporter.test.ts` cover that.
 */

import { describe, expect, it } from 'vitest';
import { MemoryArtifactFs } from '@caotang/store';
import { createEmitter, COMPILE_LOG_PATH, type ByteArtifacts } from '../src/emit.js';
import { ExportNotReadyError } from '../src/errors.js';
import type { CompileLogEntry } from '../src/types.js';

function entry(overrides: Partial<Omit<CompileLogEntry, 'output'>> = {}): Omit<CompileLogEntry, 'output'> {
  return {
    at: '2026-10-08T09:30:00.000Z',
    recipe: 'manuscript',
    format: 'md',
    blockCount: 3,
    chapterCount: 1,
    sceneCount: 2,
    wordCount: 10,
    skippedDocs: [],
    tocIncluded: false,
    notes: [],
    ...overrides,
  };
}

function log(fs: MemoryArtifactFs): CompileLogEntry[] {
  return JSON.parse(fs.snapshot()[COMPILE_LOG_PATH] ?? '[]') as CompileLogEntry[];
}

/** A promise the test resolves by hand, so a job can be held open while the next one is queued. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('name reservation', () => {
  it('refuses to reserve a name before exports/ has been listed', () => {
    const emitter = createEmitter({ artifacts: new MemoryArtifactFs() });
    expect(() => emitter.reserve('Book', 'md')).toThrow(ExportNotReadyError);
  });

  it('reserves the plain name first, then auto-versions a collision as -2, -3', async () => {
    const emitter = createEmitter({ artifacts: new MemoryArtifactFs() });
    await emitter.ready();
    expect(emitter.reserve('Book', 'md')).toBe('exports/Book.md');
    expect(emitter.reserve('Book', 'md')).toBe('exports/Book-2.md');
    expect(emitter.reserve('Book', 'md')).toBe('exports/Book-3.md');
  });

  it('respects a file already in exports/ from an earlier session', async () => {
    const fs = new MemoryArtifactFs();
    fs.putFile('exports/Book.md', 'old');
    const emitter = createEmitter({ artifacts: fs });
    await emitter.ready();
    expect(emitter.reserve('Book', 'md')).toBe('exports/Book-2.md');
  });

  it('respects a file already in exports/ under a different case — a synced folder cannot hold both', async () => {
    const fs = new MemoryArtifactFs();
    fs.putFile('exports/Post.html', 'old');
    const emitter = createEmitter({ artifacts: fs });
    await emitter.ready();
    expect(emitter.reserve('post', 'html')).toBe('exports/post-2.html');
  });

  it('respects a binary file in the byte binding, which the string folder cannot see', async () => {
    const bytesFiles = ['Book.docx'];
    const bytes: ByteArtifacts = {
      writeBytes: async () => {},
      removeBytes: async () => {},
      listFiles: async () => bytesFiles,
    };
    const emitter = createEmitter({ artifacts: new MemoryArtifactFs(), bytes });
    await emitter.ready();
    expect(emitter.reserve('Book', 'docx')).toBe('exports/Book-2.docx');
  });

  it('records a failed listing, refuses to reserve, and keeps idle() from rejecting', async () => {
    const fs = new MemoryArtifactFs();
    fs.listFiles = async () => {
      throw new Error('disk gone');
    };
    const emitter = createEmitter({ artifacts: fs });
    await expect(emitter.ready()).rejects.toThrow('disk gone');
    await expect(emitter.idle()).resolves.toBeUndefined();
    expect(emitter.failures()).toEqual([{ path: 'exports', message: 'disk gone' }]);
    expect(() => emitter.reserve('Book', 'md')).toThrow(ExportNotReadyError);
  });

  it('frees a name when its artifact is restored, so the next compile can take it', async () => {
    const emitter = createEmitter({ artifacts: new MemoryArtifactFs() });
    await emitter.ready();
    const first = emitter.reserve('Book', 'md');
    emitter.restore(first);
    expect(emitter.reserve('Book', 'md')).toBe(first);
  });
});

describe('the artifact and the compile log', () => {
  it('writes the artifact and appends one row for it', async () => {
    const fs = new MemoryArtifactFs();
    const emitter = createEmitter({ artifacts: fs });
    await emitter.ready();
    const path = emitter.reserve('Book', 'md');
    emitter.publish({ path, format: 'md', render: async () => '# Book\n', entry: entry() });
    await emitter.idle();

    expect(fs.snapshot()[path]).toBe('# Book\n');
    expect(log(fs)).toEqual([{ ...entry(), output: path, notes: [] }]);
  });

  it('keeps every earlier row, unchanged, when a later compile appends', async () => {
    const fs = new MemoryArtifactFs();
    const emitter = createEmitter({ artifacts: fs });
    await emitter.ready();
    const a = emitter.reserve('A', 'md');
    const b = emitter.reserve('B', 'md');
    emitter.publish({ path: a, format: 'md', render: async () => 'a', entry: entry({ recipe: 'first' }) });
    emitter.publish({ path: b, format: 'md', render: async () => 'b', entry: entry({ recipe: 'second' }) });
    await emitter.idle();

    const rows = log(fs);
    expect(rows.map((row) => row.recipe)).toEqual(['first', 'second']);
    expect(rows[0]?.output).toBe(a);
  });

  it('records a render failure in the log, with no output and the reason as a note, and goes on to the next job', async () => {
    const fs = new MemoryArtifactFs();
    const emitter = createEmitter({ artifacts: fs });
    await emitter.ready();
    const broken = emitter.reserve('Broken', 'md');
    const fine = emitter.reserve('Fine', 'md');
    emitter.publish({ path: broken, format: 'md', render: async () => { throw new Error('boom'); }, entry: entry({ recipe: 'broken' }) });
    emitter.publish({ path: fine, format: 'md', render: async () => 'ok', entry: entry({ recipe: 'fine' }) });
    await emitter.idle();

    expect(fs.snapshot()[broken]).toBeUndefined();
    expect(fs.snapshot()[fine]).toBe('ok');
    const rows = log(fs);
    expect(rows[0]).toMatchObject({ recipe: 'broken', output: null, notes: ['artifact not written: boom'] });
    expect(rows[1]).toMatchObject({ recipe: 'fine', output: fine });
    expect(emitter.failures()).toEqual([{ path: broken, message: 'boom' }]);
  });

  it('refuses to append to a log that is not a JSON array, and does not overwrite it', async () => {
    const fs = new MemoryArtifactFs();
    fs.putFile(COMPILE_LOG_PATH, '{"not":"an array"}');
    const emitter = createEmitter({ artifacts: fs });
    await emitter.ready();
    const path = emitter.reserve('Book', 'md');
    emitter.publish({ path, format: 'md', render: async () => 'x', entry: entry() });
    await emitter.idle();

    expect(fs.snapshot()[COMPILE_LOG_PATH]).toBe('{"not":"an array"}');
    expect(emitter.failures().some((failure) => failure.path === COMPILE_LOG_PATH)).toBe(true);
    // The artifact itself was still written: the log is evidence, the book is the work.
    expect(fs.snapshot()[path]).toBe('x');
  });
});

describe('restore — the undo of a compile', () => {
  it('removes the artifact, and leaves its log row in place (the log is append-only)', async () => {
    const fs = new MemoryArtifactFs();
    const emitter = createEmitter({ artifacts: fs });
    await emitter.ready();
    const path = emitter.reserve('Book', 'md');
    emitter.publish({ path, format: 'md', render: async () => 'x', entry: entry() });
    emitter.restore(path);
    await emitter.idle();

    expect(fs.snapshot()[path]).toBeUndefined();
    expect(log(fs)).toHaveLength(1);
    expect(log(fs)[0]?.output).toBe(path);
  });

  it('runs the removal after the write it undoes, even when the write has not started', async () => {
    const fs = new MemoryArtifactFs();
    const emitter = createEmitter({ artifacts: fs });
    await emitter.ready();
    const path = emitter.reserve('Book', 'md');
    const gate = deferred<string>();
    emitter.publish({ path, format: 'md', render: () => gate.promise, entry: entry() });
    // Undone while the render is still pending: the write must land and then be removed.
    emitter.restore(path);
    gate.resolve('late');
    await emitter.idle();

    expect(fs.snapshot()[path]).toBeUndefined();
  });

  it('removes a file it restores by name, even one this session never reserved', async () => {
    const fs = new MemoryArtifactFs();
    const emitter = createEmitter({ artifacts: fs });
    await emitter.ready();
    fs.putFile('exports/Taken.md', 'x');
    emitter.restore('exports/Taken.md');
    await emitter.idle();
    expect(fs.snapshot()['exports/Taken.md']).toBeUndefined();
    expect(emitter.failures()).toEqual([]);
  });
});

describe('binary artifacts, through a byte binding', () => {
  it('writes a binary artifact through the byte binding, not the string folder', async () => {
    const fs = new MemoryArtifactFs();
    const written = new Map<string, Uint8Array>();
    const bytes: ByteArtifacts = {
      writeBytes: async (path, data) => void written.set(path, data),
      removeBytes: async (path) => void written.delete(path),
    };
    const emitter = createEmitter({ artifacts: fs, bytes });
    await emitter.ready();
    const path = emitter.reserve('Book', 'docx');
    emitter.publish({ path, format: 'docx', render: async () => new Uint8Array([0x50, 0x4b]), entry: entry({ format: 'docx' }) });
    await emitter.idle();

    expect([...(written.get(path) ?? [])]).toEqual([0x50, 0x4b]);
    expect(fs.snapshot()[path]).toBeUndefined();
    expect(log(fs)[0]?.output).toBe(path);
  });

  it('records a binary artifact that has nowhere to go as a failed write, not a success', async () => {
    const fs = new MemoryArtifactFs();
    const emitter = createEmitter({ artifacts: fs });
    await emitter.ready();
    const path = emitter.reserve('Book', 'epub');
    emitter.publish({ path, format: 'epub', render: async () => new Uint8Array([1]), entry: entry({ format: 'epub' }) });
    await emitter.idle();

    expect(log(fs)[0]).toMatchObject({ output: null });
    expect(log(fs)[0]?.notes[0]).toMatch(/^artifact not written: no byte binding/);
  });
});
