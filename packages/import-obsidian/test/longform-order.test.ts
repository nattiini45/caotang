/**
 * The Longform index orders the manuscript (#281): scenes follow the index's list, a Part nests its scenes as a folder
 * (decision 2), the highest draft wins, and the index's title is the book title. Synthetic fixtures only.
 */
import { describe, expect, it } from 'vitest';
import { openFolder } from '@caotang/import-read/zip';
import { splitImport } from '@caotang/import-core';
import { readObsidianVault } from '../src/reader.js';

const enc = new TextEncoder();
const file = (path: string, text: string) => ({ path, size: text.length, read: async () => enc.encode(text) });

const INDEX = '---\nlongform:\n  format: scenes\n  title: My Novel\n  draftNumber: 1\n  sceneFolder: Scenes\n  scenes:\n    - Part One:\n      - Scene B\n      - Scene A\n    - Scene C\n---\n';

describe('the Longform index', () => {
  it('orders scenes by the index and nests a Part as a folder', async () => {
    const archive = openFolder([
      file('Index.md', INDEX),
      file('Scenes/Scene A.md', 'Alpha text.'),
      file('Scenes/Scene B.md', 'Beta text.'),
      file('Scenes/Scene C.md', 'Gamma text.'),
    ]);
    if (!archive.ok) throw new Error('open failed');
    const result = await readObsidianVault(archive.value);
    if (!result.ok) throw new Error('read failed');
    expect(result.value.longform?.title).toBe('My Novel');
    const split = splitImport(result.value.document);
    const part = split.tree.find((node) => node.role === 'part');
    expect(part?.title).toBe('Part One');
    expect(part?.kind === 'folder' ? part.children.map((child) => child.title) : []).toEqual(['Scene B', 'Scene A']);
    expect(split.tree.filter((node) => node.role === 'chapter').map((node) => node.title)).toEqual(['Scene C']);
  });

  it('keeps the highest draft when a vault holds two indexes', async () => {
    const older = INDEX.replace('draftNumber: 1', 'draftNumber: 1').replace('Scene B', 'Old Scene');
    const newer = INDEX.replace('draftNumber: 1', 'draftNumber: 2');
    const archive = openFolder([
      file('Old.md', older),
      file('Index.md', newer),
      file('Scenes/Scene A.md', 'Alpha text.'),
      file('Scenes/Scene B.md', 'Beta text.'),
      file('Scenes/Scene C.md', 'Gamma text.'),
    ]);
    if (!archive.ok) throw new Error('open failed');
    const result = await readObsidianVault(archive.value);
    if (!result.ok) throw new Error('read failed');
    expect(result.value.longform?.draftNumber).toBe(2);
    const split = splitImport(result.value.document);
    const part = split.tree.find((node) => node.role === 'part');
    expect(part?.kind === 'folder' ? part.children.map((child) => child.title) : []).toEqual(['Scene B', 'Scene A']);
  });
});
