import { describe, expect, it } from 'vitest';

import type { ImportArchive } from '@caotang/import-read/zip';
import { readObsidianVault } from '../src/reader.js';

function vaultOf(files: Record<string, string>): ImportArchive {
  const entries = Object.entries(files).map(([path, text]) => ({
    path,
    size: new TextEncoder().encode(text).length,
    isDirectory: false,
    compressedSize: new TextEncoder().encode(text).length,
  }));
  return {
    kind: 'folder',
    entries,
    ignored: [],
    entry: (path) => entries.find((entry) => entry.path === path),
    read: async (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`no entry ${path}`);
      return { ok: true, value: new TextEncoder().encode(text) };
    },
    readMany: async (paths) => {
      const map = new Map<string, Uint8Array>();
      for (const path of paths) {
        const text = files[path];
        if (text === undefined) throw new Error(`no entry ${path}`);
        map.set(path, new TextEncoder().encode(text));
      }
      return { ok: true, value: map };
    },
  };
}

describe('the Obsidian vault reader (#281)', () => {
  it('imports manuscript notes and resolves wikilinks and comments', async () => {
    const read = await readObsidianVault(vaultOf({
      'Chapter One.md': '# Chapter One\n\nThe ferry came. %% a note %%\n\nSee [[Chapter Two]].',
      'Chapter Two.md': '# Chapter Two\n\nThe letter arrived.',
    }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.codex).toHaveLength(0);
    const text = JSON.stringify(read.value.document.blocks);
    expect(text).toContain('The ferry came.');
    expect(text).toContain('Chapter Two');
    expect(text).not.toContain('a note');
  });

  it('classifies codex notes by folder and keeps their aliases', async () => {
    const read = await readObsidianVault(vaultOf({
      'Characters/Elena.md': '---\naliases: [El, Lena]\n---\nElena is the ferry captain.',
      'Chapter One.md': '# Chapter One\n\nThe ferry came.',
    }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.codex).toHaveLength(1);
    expect(read.value.codex[0]).toMatchObject({ name: 'Elena', type: 'character', aliases: ['El', 'Lena'] });
  });

  it('names the Longform index and skips config and trash', async () => {
    const read = await readObsidianVault(vaultOf({
      'Index.md': '---\nlongform:\n  format: scenes\n  title: The Landing\n  draftNumber: 1\n  scenes:\n    - Chapter One\n---\n',
      'Chapter One.md': '# Chapter One\n\nThe ferry came.',
      '.obsidian/app.json': '{"attachmentFolderPath":"assets"}',
      '.trash/Old.md': 'old',
    }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.longform?.title).toBe('The Landing');
    expect(read.value.skipped).toContain('.obsidian/app.json');
    expect(read.value.skipped).toContain('.trash/Old.md');
  });

  it('resolves an image embed through the attachment folder', async () => {
    const read = await readObsidianVault(vaultOf({
      'Chapter One.md': '# Chapter One\n\n![[cover.png]]',
      'assets/cover.png': 'fake-png-bytes',
      '.obsidian/app.json': '{"attachmentFolderPath":"assets"}',
    }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.assetData.size).toBe(1);
    expect(read.value.document.assets?.[0]?.name).toBe('cover.png');
  });

  it('refuses a vault with no notes', async () => {
    const read = await readObsidianVault(vaultOf({ '.obsidian/app.json': '{}' }));
    expect(read.ok).toBe(false);
  });
});
