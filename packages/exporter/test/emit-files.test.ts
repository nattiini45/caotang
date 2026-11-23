/**
 * The multi-file half of the emitter: a set of names reserved together, a compile's files written together or not
 * at all, and a restore that removes every file a compile wrote. The single-file behaviour is in `emit.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { MemoryArtifactFs } from '@caotang/store';
import { COMPILE_LOG_PATH, createEmitter, type Emitter } from '../src/emit.js';
import { ExportNotReadyError } from '../src/errors.js';
import type { CompileLogEntry } from '../src/types.js';

const entry = (over: Partial<Omit<CompileLogEntry, 'output' | 'outputs'>> = {}): Omit<CompileLogEntry, 'output' | 'outputs'> => ({
  at: '2026-10-08T09:30:00.000Z',
  recipe: 'manuscript',
  format: 'promptpack',
  blockCount: 1,
  chapterCount: 0,
  sceneCount: 0,
  wordCount: 0,
  skippedDocs: [],
  tocIncluded: false,
  notes: [],
  ...over,
});

/** A store whose text writes to one named file fail, so a write can fail after its siblings have landed. */
class FailingFs extends MemoryArtifactFs {
  constructor(private readonly failing: string) {
    super();
  }

  override async writeAtomic(path: string, contents: string): Promise<void> {
    if (path.endsWith(this.failing)) throw new Error(`the disk refused ${path}`);
    return super.writeAtomic(path, contents);
  }
}

async function ready(fs: MemoryArtifactFs): Promise<Emitter> {
  const emitter = createEmitter({ artifacts: fs });
  await emitter.ready();
  return emitter;
}

function logRows(fs: MemoryArtifactFs): Array<Record<string, unknown>> {
  return JSON.parse(fs.snapshot()[COMPILE_LOG_PATH] ?? '[]') as Array<Record<string, unknown>>;
}

describe('reserveGroup — a set of names is reserved together', () => {
  it('reserves each name as it stands when the folder has none of them', async () => {
    const emitter = await ready(new MemoryArtifactFs());
    const placed = emitter.reserveGroup([{ name: 'Book.json' }, { name: 'Book.md' }]);
    expect(placed.map((file) => file.path)).toEqual(['exports/Book.json', 'exports/Book.md']);
  });

  it('takes the next suffix on every name when one of them is taken, so the set stays paired', async () => {
    const emitter = await ready(new MemoryArtifactFs());
    emitter.reserve('Book', 'md');
    const placed = emitter.reserveGroup([{ name: 'Book.json' }, { name: 'Book.md' }]);
    // `Book.json` was free, but the set moves together: a half-suffixed set would pair the wrong files.
    expect(placed.map((file) => file.path)).toEqual(['exports/Book-2.json', 'exports/Book-2.md']);
  });

  it('puts the suffix before the extension of a name that has a dot in its stem', async () => {
    const emitter = await ready(new MemoryArtifactFs());
    emitter.reserveGroup([{ name: 'Book.ink.json' }]);
    expect(emitter.reserveGroup([{ name: 'Book.ink.json' }]).map((file) => file.path)).toEqual(['exports/Book.ink-2.json']);
  });

  it('keeps the files it was given, with their own fields, next to the path', async () => {
    const emitter = await ready(new MemoryArtifactFs());
    const placed = emitter.reserveGroup([{ name: 'Book.csv', mimeType: 'text/csv' }]);
    expect(placed).toEqual([{ name: 'Book.csv', mimeType: 'text/csv', path: 'exports/Book.csv' }]);
  });

  it('refuses two files of one set with the same name, because the set could not be reserved without an overwrite', async () => {
    const emitter = await ready(new MemoryArtifactFs());
    expect(() => emitter.reserveGroup([{ name: 'Book.md' }, { name: 'Book.md' }])).toThrow('named two of its files the same');
  });

  it('refuses two names of one set that differ only in case — a synced folder holds just one of them', async () => {
    const emitter = await ready(new MemoryArtifactFs());
    expect(() => emitter.reserveGroup([{ name: 'post.html' }, { name: 'Post.html' }])).toThrow('named two of its files the same');
  });

  it('moves past a file that is already in exports/ under a different case', async () => {
    const fs = new MemoryArtifactFs();
    fs.putFile('exports/Post.html', 'old');
    const emitter = await ready(fs);
    expect(emitter.reserveGroup([{ name: 'post.html' }]).map((file) => file.path)).toEqual(['exports/post-2.html']);
  });

  it('refuses before exports/ has been listed, as the single reservation does', () => {
    const emitter = createEmitter({ artifacts: new MemoryArtifactFs() });
    expect(() => emitter.reserveGroup([{ name: 'Book.md' }])).toThrow(ExportNotReadyError);
  });
});

describe('publishFiles — a compile writes all of its files, or none', () => {
  it('writes every file, and logs one row with the first as output and all of them as outputs', async () => {
    const fs = new MemoryArtifactFs();
    const emitter = await ready(fs);
    const placed = emitter.reserveGroup([{ name: 'Book.json' }, { name: 'Book.md' }]);
    emitter.publishFiles({
      files: placed.map((file) => ({ path: file.path, format: 'md', render: async () => `contents of ${file.name}` })),
      entry: entry(),
    });
    await emitter.idle();

    expect(fs.snapshot()['exports/Book.json']).toBe('contents of Book.json');
    expect(fs.snapshot()['exports/Book.md']).toBe('contents of Book.md');
    expect(logRows(fs)).toHaveLength(1);
    expect(logRows(fs)[0]).toMatchObject({ output: 'exports/Book.json', outputs: ['exports/Book.json', 'exports/Book.md'] });
  });

  it('writes nothing when a later file fails to render, and logs the compile as not written', async () => {
    const fs = new MemoryArtifactFs();
    const emitter = await ready(fs);
    emitter.publishFiles({
      files: [
        { path: 'exports/Book.json', format: 'md', render: async () => '{}' },
        {
          path: 'exports/Book.md',
          format: 'md',
          render: async () => {
            throw new Error('the markdown renderer broke');
          },
        },
      ],
      entry: entry(),
    });
    await emitter.idle();

    expect(fs.snapshot()['exports/Book.json']).toBeUndefined();
    expect(fs.snapshot()['exports/Book.md']).toBeUndefined();
    const [row] = logRows(fs);
    expect(row).toMatchObject({ output: null });
    expect(row?.['notes']).toContain('artifact not written: the markdown renderer broke');
    expect(emitter.failures().map((failure) => failure.message)).toEqual(['the markdown renderer broke']);
  });

  it('removes the files it already wrote when a later write fails, so the set is never half on disk', async () => {
    const fs = new FailingFs('Book-broken.md');
    const emitter = await ready(fs);
    emitter.publishFiles({
      files: [
        { path: 'exports/Book.json', format: 'md', render: async () => '{}' },
        { path: 'exports/Book-broken.md', format: 'md', render: async () => '# Book' },
      ],
      entry: entry(),
    });
    await emitter.idle();

    expect(fs.snapshot()['exports/Book.json']).toBeUndefined();
    expect(fs.snapshot()['exports/Book-broken.md']).toBeUndefined();
    expect(logRows(fs)[0]).toMatchObject({ output: null });
    expect(emitter.failures().some((failure) => failure.message.includes('the disk refused'))).toBe(true);
  });

  it('keeps the single-file publish as it was: one path, one output, no outputs key', async () => {
    const fs = new MemoryArtifactFs();
    const emitter = await ready(fs);
    const path = emitter.reserve('Book', 'md');
    emitter.publish({ path, format: 'md', render: async () => '# Book\n', entry: entry({ format: 'md' }) });
    await emitter.idle();
    expect(logRows(fs)[0]).toMatchObject({ output: 'exports/Book.md' });
    expect(logRows(fs)[0]).not.toHaveProperty('outputs');
  });
});

describe('restoreAll — undo removes every file a compile wrote', () => {
  it('removes each path, and frees its reservation so the name can be used again', async () => {
    const fs = new MemoryArtifactFs();
    const emitter = await ready(fs);
    const placed = emitter.reserveGroup([{ name: 'Book.json' }, { name: 'Book.md' }]);
    emitter.publishFiles({
      files: placed.map((file) => ({ path: file.path, format: 'md', render: async () => 'x' })),
      entry: entry(),
    });
    await emitter.idle();

    emitter.restoreAll(placed.map((file) => file.path));
    await emitter.idle();

    expect(fs.snapshot()['exports/Book.json']).toBeUndefined();
    expect(fs.snapshot()['exports/Book.md']).toBeUndefined();
    expect(emitter.reserveGroup([{ name: 'Book.json' }, { name: 'Book.md' }]).map((file) => file.path)).toEqual([
      'exports/Book.json',
      'exports/Book.md',
    ]);
  });
});
