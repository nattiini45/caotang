import { describe, expect, it } from 'vitest';

import { ImportArchiveError, type ImportArchive } from '@caotang/import-read/zip';
import { readNovelCrafterExport } from '../src/reader.js';
import { buildResearchPage } from '../src/codex.js';

function exportOf(files: Record<string, string | Uint8Array>): ImportArchive {
  const bytesOf = (value: string | Uint8Array): Uint8Array => (typeof value === 'string' ? new TextEncoder().encode(value) : value);
  const entries = Object.entries(files).map(([path, value]) => ({
    path,
    size: bytesOf(value).length,
    isDirectory: false,
    compressedSize: bytesOf(value).length,
  }));
  return {
    kind: 'folder',
    entries,
    ignored: [],
    entry: (path) => entries.find((entry) => entry.path === path),
    read: async (path) => {
      const value = files[path];
      if (value === undefined) return { ok: false, error: new ImportArchiveError('not-found', `no entry ${path}`, path) };
      return { ok: true, value: bytesOf(value) };
    },
    readMany: async (paths) => {
      const map = new Map<string, Uint8Array>();
      for (const path of paths) {
        const value = files[path];
        if (value === undefined) return { ok: false, error: new ImportArchiveError('not-found', `no entry ${path}`, path) };
        map.set(path, bytesOf(value));
      }
      return { ok: true, value: map };
    },
  };
}

const ELENA_ENTRY = '---\nname: Elena\naliases: [El, Lena]\ntags: [captain, ferry]\nrole: protagonist\nage: 34\n---\nElena is the ferry captain.';

describe('the NovelCrafter export reader (#292)', () => {
  it('reads a codex entry with its aliases, keywords, fields, relations and notes', async () => {
    const read = await readNovelCrafterExport(exportOf({
      'characters/Elena/entry.md': ELENA_ENTRY,
      'characters/Elena/metadata.json': JSON.stringify({ relations: [{ name: 'Mara', type: 'first mate' }], progressions: [{ arc: 'trust' }] }),
      'characters/Elena/notes.md': 'She keeps the ledger.',
    }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.codex).toHaveLength(1);
    const entry = read.value.codex[0];
    expect(entry).toMatchObject({ name: 'Elena', type: 'character', aliases: ['El', 'Lena'], keywords: ['captain', 'ferry'] });
    expect(entry?.fields).toMatchObject({ role: 'protagonist', age: '34' });
    expect(entry?.relations).toEqual([{ name: 'Mara', kind: 'first mate' }]);
    expect(entry?.notes).toBe('She keeps the ledger.');
    expect(entry?.description).toBe('Elena is the ferry captain.');
    expect(read.value.lost.progressions).toBe(1);
    // A codex-only export has no manuscript.
    expect(read.value.document.blocks).toHaveLength(0);
  });

  it('maps the type folders to codex types', async () => {
    const read = await readNovelCrafterExport(exportOf({
      'characters/Elena/entry.md': 'Elena.',
      'locations/Harbour/entry.md': 'The harbour.',
      'objects/Lantern/entry.md': 'A lantern.',
      'lore/The Tide/entry.md': 'The tide.',
      'misc/Thing/entry.md': 'A thing.',
    }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const byName = new Map(read.value.codex.map((entry) => [entry.name, entry.type]));
    expect(byName.get('Elena')).toBe('character');
    expect(byName.get('Harbour')).toBe('location');
    expect(byName.get('Lantern')).toBe('object');
    expect(byName.get('The Tide')).toBe('lore');
    expect(byName.get('Thing')).toBe('other');
  });

  it('reads the manuscript outside the codex folders and keeps entry.md out of it', async () => {
    const read = await readNovelCrafterExport(exportOf({
      'novel.md': '# Chapter One\n\nThe ferry came.\n\n* * *\n\nThe letter arrived.',
      'characters/Elena/entry.md': ELENA_ENTRY,
      'characters/Elena/notes.md': 'Her notes.',
    }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const text = JSON.stringify(read.value.document.blocks);
    expect(text).toContain('The ferry came.');
    expect(text).toContain('The letter arrived.');
    expect(text).not.toContain('ferry captain');
    expect(text).not.toContain('Her notes.');
    expect(read.value.codex).toHaveLength(1);
  });

  it('maps a manuscript scene’s front-matter synopsis', async () => {
    const read = await readNovelCrafterExport(exportOf({
      'novel.md': '---\nsynopsis: The crossing begins.\n---\n# Chapter One\n\nThe ferry came.',
    }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const facts = Object.values(read.value.frontMatter)[0];
    expect(facts?.scene.synopsis).toBe('The crossing begins.');
  });

  it('resolves a codex thumbnail into the picture bytes', async () => {
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const read = await readNovelCrafterExport(exportOf({
      'characters/Elena/entry.md': ELENA_ENTRY,
      'characters/Elena/thumbnail.png': png,
    }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const entry = read.value.codex[0];
    expect(entry?.thumbnail).toBeDefined();
    expect(read.value.assetData.get(entry?.thumbnail ?? '')).toEqual(png);
    expect(buildResearchPage(entry!)).toContain(`![Elena](${entry?.thumbnail})`);
  });

  it('renders the research page with description, Connections, notes and fields', async () => {
    const read = await readNovelCrafterExport(exportOf({
      'characters/Elena/entry.md': ELENA_ENTRY,
      'characters/Elena/metadata.json': JSON.stringify({ relations: [{ name: 'Mara', type: 'first mate' }] }),
      'characters/Elena/notes.md': 'She keeps the ledger.',
    }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const page = buildResearchPage(read.value.codex[0]!);
    expect(page).toContain('# Elena');
    expect(page).toContain('Elena is the ferry captain.');
    expect(page).toContain('## Connections');
    expect(page).toContain('- Mara (first mate)');
    expect(page).toContain('## Notes');
    expect(page).toContain('She keeps the ledger.');
    expect(page).toContain('## Fields');
    expect(page).toContain('- role: protagonist');
  });

  it('refuses an export with neither manuscript nor codex', async () => {
    const read = await readNovelCrafterExport(exportOf({ 'readme.txt': 'nothing here' }));
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error.kind).toBe('empty');
  });
});
