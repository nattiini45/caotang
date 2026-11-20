/**
 * What the folder watcher's events mean for the open copy (desktop.md §External folder changes, #403): only the manifest and the
 * files whose digests the copy holds are judged, and only when their bytes differ. A program rewriting a file with the bytes the
 * copy already has, a file the project does not own, and a save of this tab's own all stay quiet.
 */

import { describe, expect, it } from 'vitest';

import { changeSummary, externalChanges, knownChanges } from '../src/app/folder-watch.js';
import type { DirectoryHandleLike } from '../src/app/fs-access.js';
import type { FolderBaseline } from '../src/app/session.js';

const folder = { name: 'Harbour folder', kind: 'directory' } as DirectoryHandleLike;

const baseline = (digests: Readonly<Record<string, string>>, manifestText = '{"project":{"name":"Harbour"}}'): FolderBaseline => ({
  folder,
  manifestText,
  documentIds: ['n_A'],
  digests: new Map(Object.entries(digests)),
  titles: new Map(),
});

/** A folder read that answers with the bytes it was given, and with nothing for a path it does not hold. */
const reader = (files: Readonly<Record<string, string>>) =>
  async (path: string): Promise<Uint8Array | null> => {
    const text = files[path];
    return text === undefined ? null : new TextEncoder().encode(text);
  };

describe('the changes an open copy can judge', () => {
  const copy = baseline({ 'docs/n_A.md': 'digest-of-first' });

  it('keeps the manifest and the project files the copy holds, once each', () => {
    expect(knownChanges(copy, ['caotang.json', 'docs/n_A.md', 'docs/n_A.md', 'docs/notes-by-hand.md', 'assets/cover.png']))
      .toEqual(['caotang.json', 'docs/n_A.md']);
  });

  it('reports a project file whose bytes moved on outside Caotang', async () => {
    const changed = await externalChanges(copy, ['docs/n_A.md'], reader({ 'docs/n_A.md': 'written elsewhere' }));
    expect(changed).toEqual(['docs/n_A.md']);
  });

  it('says nothing when the folder holds the bytes the copy already has', async () => {
    const changed = await externalChanges(copy, ['caotang.json'], reader({ 'caotang.json': '{"project":{"name":"Harbour"}}' }));
    expect(changed).toEqual([]);
  });

  it('reports the manifest when another program changed it', async () => {
    const changed = await externalChanges(copy, ['caotang.json'], reader({ 'caotang.json': '{"project":{"name":"Other"}}' }));
    expect(changed).toEqual(['caotang.json']);
  });

  it('reports a project file the folder no longer holds, so a deletion is offered too', async () => {
    const changed = await externalChanges(copy, ['docs/n_A.md'], reader({}));
    expect(changed).toEqual(['docs/n_A.md']);
  });

  it('says nothing for a file it could not read, rather than calling it deleted', async () => {
    // A read can fail for reasons that say nothing about the file (a locked handle, a folder another program holds). An offer
    // raised on that guess would ask the writer to reopen a folder that never changed (pawcommit F3).
    const changed = await externalChanges(copy, ['docs/n_A.md'], async () => {
      throw new DOMException('The file is held by another program.', 'NotReadableError');
    });
    expect(changed).toEqual([]);
  });

  it('reads nothing for a file the project does not own', async () => {
    let reads = 0;
    const changed = await externalChanges(copy, ['exports/Harbour.docx'], async () => {
      reads += 1;
      return null;
    });
    expect(changed).toEqual([]);
    expect(reads).toBe(0);
  });
});

describe('the offer’s names', () => {
  it('names three changed files and counts the rest', () => {
    const paths = ['docs/n_A.md', 'docs/n_B.md', 'codex/c_C.md', 'caotang.json'];
    const summary = changeSummary(paths, (path) => path.slice(path.lastIndexOf('/') + 1));
    expect(summary).toEqual({ names: ['n_A.md', 'n_B.md', 'c_C.md'], more: 1 });
  });
});
