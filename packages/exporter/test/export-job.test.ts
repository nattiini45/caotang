import { describe, expect, it } from 'vitest';
import { checkMachine } from '@caotang/machine/testing';
import { MemoryArtifactFs } from '@caotang/store';
import { createEmitter, COMPILE_LOG_PATH } from '../src/emit.js';
import { exportJobMachine } from '../src/export-job.js';
import type { CompileLogEntry } from '../src/types.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const entry: Omit<CompileLogEntry, 'output'> = {
  at: '2026-11-10T00:00:00.000Z', recipe: 'manuscript', format: 'md',
  blockCount: 1, chapterCount: 1, sceneCount: 1, wordCount: 1,
  skippedDocs: [], tocIncluded: false, notes: [],
};

describe('export jobs', () => {
  it('exhaustively agrees with its published transition table', () => {
    expect(checkMachine(exportJobMachine, {
      states: [{ kind: 'queued' }, { kind: 'rendering' }, { kind: 'writing' },
        { kind: 'written', outputs: ['exports/Book.md'] }, { kind: 'failed', failures: [{ path: null, message: 'disk full' }] }],
      events: [{ type: 'render' }, { type: 'write' }, { type: 'written', outputs: ['exports/Book.md'] },
        { type: 'failed', failures: [{ path: null, message: 'disk full' }] }],
    })).toEqual([]);
  });

  it('publishes queued, rendering and writing before written, and settles only after its log', async () => {
    const fs = new MemoryArtifactFs();
    const render = deferred<string>();
    const rendering = deferred<void>();
    const writing = deferred<void>();
    const write = deferred<void>();
    const log = deferred<void>();
    const logging = deferred<void>();
    const originalWrite = fs.writeAtomic.bind(fs);
    fs.writeAtomic = async (path, contents) => {
      if (path === COMPILE_LOG_PATH) { logging.resolve(); await log.promise; }
      else { writing.resolve(); await write.promise; }
      await originalWrite(path, contents);
    };
    const emitter = createEmitter({ artifacts: fs });
    await emitter.ready();
    const job = emitter.publish({ path: emitter.reserve('Book', 'md'), format: 'md', entry,
      render: () => { rendering.resolve(); return render.promise; } });
    expect(emitter.job(job.id)?.state.kind).toBe('queued');
    await rendering.promise;
    expect(emitter.job(job.id)?.state.kind).toBe('rendering');
    render.resolve('unchanged bytes\r\n');
    await writing.promise;
    expect(emitter.job(job.id)?.state.kind).toBe('writing');
    write.resolve();
    await logging.promise;
    expect(emitter.job(job.id)?.state.kind).toBe('writing');
    log.resolve();
    expect((await emitter.settled(job.id)).state).toEqual({ kind: 'written', outputs: ['exports/Book.md'] });
    expect(fs.snapshot()['exports/Book.md']).toBe('unchanged bytes\r\n');
  });

  it('makes a rejected write a failed job, rolls back earlier files, and gives a retry its own result', async () => {
    const fs = new MemoryArtifactFs();
    const write = fs.writeAtomic.bind(fs);
    fs.writeAtomic = async (path, contents) => {
      if (path.endsWith('Second.md')) throw new Error('disk full');
      await write(path, contents);
    };
    const emitter = createEmitter({ artifacts: fs });
    await emitter.ready();
    const paths = emitter.reserveGroup([{ name: 'First.md' }, { name: 'Second.md' }]);
    const job = emitter.publishFiles({ entry, files: paths.map(({ path }) => ({ path, format: 'md', render: async () => path })) });
    const result = await emitter.settled(job.id);
    expect(result.state).toEqual({ kind: 'failed', failures: [{ path: 'exports/First.md', message: 'disk full' }] });
    expect(fs.snapshot()['exports/First.md']).toBeUndefined();
    expect(fs.snapshot()['exports/Second.md']).toBeUndefined();
    expect(JSON.parse(fs.snapshot()[COMPILE_LOG_PATH]!)).toEqual([{ ...entry, output: null, notes: ['artifact not written: disk full'] }]);
    emitter.restoreAll(paths.map(({ path }) => path));
    fs.writeAtomic = write;
    const retry = emitter.publish({ entry, path: emitter.reserve('First', 'md'), format: 'md', render: async () => 'retry' });
    expect(retry.id).not.toBe(job.id);
    expect((await emitter.settled(retry.id)).state.kind).toBe('written');
    expect(emitter.job(job.id)).toEqual(result);
  });

  it('attributes a log failure to the job even though its artifact was written', async () => {
    const fs = new MemoryArtifactFs();
    fs.putFile(COMPILE_LOG_PATH, 'corrupt evidence');
    const emitter = createEmitter({ artifacts: fs });
    await emitter.ready();
    const job = emitter.publish({ path: emitter.reserve('Book', 'md'), format: 'md', entry, render: async () => 'book' });
    const result = await emitter.settled(job.id);
    expect(result.state.kind).toBe('failed');
    if (result.state.kind === 'failed') expect(result.state.failures[0]?.path).toBe(COMPILE_LOG_PATH);
    expect(fs.snapshot()['exports/Book.md']).toBe('book');
    expect(fs.snapshot()[COMPILE_LOG_PATH]).toBe('corrupt evidence');
    expect(emitter.job('missing')).toBeUndefined();
    await expect(emitter.settled('missing')).rejects.toThrow('Unknown export job');
  });
});
