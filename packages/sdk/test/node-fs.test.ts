/**
 * The store's ArtifactFs port on node:fs: atomic writes, root containment and the
 * readers' rules for what is absent. Every case runs against a real folder.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ArtifactNotFoundError } from '@caotang/store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ArtifactPathError, NodeArtifactFs, byteArtifactsOver, resolveWithin } from '../src/folder-api.js';
import { removeDir, tempDir } from './support.js';

describe('resolveWithin', () => {
  const root = join('/project', 'root');

  it('resolves a project-relative POSIX path under the root', () => {
    expect(resolveWithin(root, 'docs/n_X.md')).toBe(join(root, 'docs', 'n_X.md'));
    expect(resolveWithin(root, '')).toBe(root);
  });

  it.each([
    ['an absolute path', '/etc/passwd'],
    ['a drive path', 'C:/Windows/x'],
    ['a parent escape', '../outside.md'],
    ['a parent escape in the middle', 'docs/../../outside.md'],
    ['a backslash path', 'docs\\n_X.md'],
    ['an empty segment', 'docs//n_X.md'],
    ['a dot segment', 'docs/./n_X.md'],
    ['a NUL byte', 'docs/n_X\0.md'],
  ])('refuses %s', (_label, path) => {
    expect(() => resolveWithin(root, path)).toThrow(ArtifactPathError);
  });
});

describe('NodeArtifactFs', () => {
  let root: string;
  let fs: NodeArtifactFs;

  beforeAll(() => {
    root = tempDir('node-fs');
    fs = new NodeArtifactFs(root);
  });

  afterAll(() => {
    removeDir(root);
  });

  it('writes a file atomically and leaves no temp file behind', async () => {
    await fs.ensureDir('docs');
    await fs.writeAtomic('docs/n_ATOMIC0001.md', 'first\n');
    await fs.writeAtomic('docs/n_ATOMIC0001.md', 'second, and longer\n');
    expect(readFileSync(join(root, 'docs', 'n_ATOMIC0001.md'), 'utf8')).toBe('second, and longer\n');
    expect(readdirSync(join(root, 'docs'))).toEqual(['n_ATOMIC0001.md']);
    expect(await fs.listFiles('docs')).toEqual(['n_ATOMIC0001.md']);
  });

  it('writes the bytes it is given, unchanged, for a binary artifact', async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    await byteArtifactsOver(fs).writeBytes('exports/out.bin', bytes);
    expect([...readFileSync(join(root, 'exports', 'out.bin'))]).toEqual([...bytes]);
    await byteArtifactsOver(fs).removeBytes('exports/out.bin');
    expect(existsSync(join(root, 'exports', 'out.bin'))).toBe(false);
  });

  it('reads back what it wrote, and reports an absent path as ArtifactNotFoundError', async () => {
    await fs.writeAtomic('notes.txt', 'héllo ✓');
    expect(await fs.read('notes.txt')).toBe('héllo ✓');
    await expect(fs.read('missing.txt')).rejects.toBeInstanceOf(ArtifactNotFoundError);
    await expect(fs.read('docs/missing/deeper.md')).rejects.toBeInstanceOf(ArtifactNotFoundError);
  });

  it('lists a missing directory as empty, and lists only names, never directories or links', async () => {
    expect(await fs.listFiles('no-such-dir')).toEqual([]);
    expect(await fs.listDirs('no-such-dir')).toEqual([]);
    mkdirSync(join(root, 'codex', 'subfolder'), { recursive: true });
    await fs.writeAtomic('codex/c_LISTED0001.md', 'x');
    expect(await fs.listFiles('codex')).toEqual(['c_LISTED0001.md']);
    expect(await fs.listDirs('codex')).toEqual(['subfolder']);
  });

  it('refuses a path that is not project-relative, before touching the disk', async () => {
    await expect(fs.writeAtomic('/tmp/escape.md', 'x')).rejects.toBeInstanceOf(ArtifactPathError);
    await expect(fs.writeAtomic('../escape.md', 'x')).rejects.toBeInstanceOf(ArtifactPathError);
    await expect(fs.read('..\\escape.md')).rejects.toBeInstanceOf(ArtifactPathError);
    expect(existsSync(join(root, '..', 'escape.md'))).toBe(false);
  });

  it('refuses to write through a directory link that leads out of the folder', async () => {
    const outside = tempDir('node-fs-outside');
    try {
      // A junction needs no privilege on Windows, and it is the directory-link form every platform's symlink call accepts.
      symlinkSync(outside, join(root, 'linked'), 'junction');
      await expect(fs.writeAtomic('linked/planted.md', 'x')).rejects.toBeInstanceOf(ArtifactPathError);
      expect(existsSync(join(outside, 'planted.md'))).toBe(false);
      await expect(fs.read('linked/anything.md')).rejects.toBeInstanceOf(ArtifactPathError);
    } finally {
      removeDir(outside);
    }
  });

  it('removes a file, is a no-op for an absent one, and refuses a directory', async () => {
    await fs.writeAtomic('gone.md', 'bye');
    await fs.remove('gone.md');
    expect(existsSync(join(root, 'gone.md'))).toBe(false);
    await expect(fs.remove('gone.md')).resolves.toBeUndefined();
    mkdirSync(join(root, 'keep'), { recursive: true });
    await expect(fs.remove('keep')).rejects.toThrow(/refusing to remove a directory/);
    expect(existsSync(join(root, 'keep'))).toBe(true);
  });

  it('reports existence for files and directories, and creates a directory on request', async () => {
    expect(await fs.exists('notes.txt')).toBe(true);
    expect(await fs.exists('exports')).toBe(true);
    expect(await fs.exists('never-there')).toBe(false);
    await fs.ensureDir('made/deep/down');
    expect(existsSync(join(root, 'made', 'deep', 'down'))).toBe(true);
  });

  it('keeps a file it did not write, untouched, when it writes a neighbour', async () => {
    writeFileSync(join(root, 'docs', 'notes-by-hand.md'), 'written by hand');
    await fs.writeAtomic('docs/n_NEIGHBOR01.md', 'neighbour');
    expect(readFileSync(join(root, 'docs', 'notes-by-hand.md'), 'utf8')).toBe('written by hand');
  });
});
