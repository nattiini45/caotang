import { describe, expect, it } from 'vitest';

import { ImportArchiveError, type ImportArchive } from '@caotang/import-read/zip';
import { rewritePictureRefs } from '@caotang/store';
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

  it('resolves a codex thumbnail into the picture bytes, under a token the commit really replaces', async () => {
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const read = await readNovelCrafterExport(exportOf({
      'characters/Elena Vance/entry.md': ELENA_ENTRY,
      'characters/Elena Vance/Elena portrait.png': png,
    }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const entry = read.value.codex[0];
    expect(entry?.thumbnail).toBeDefined();
    expect(read.value.assetData.get(entry?.thumbnail ?? '')).toEqual(png);
    expect(buildResearchPage(entry!)).toContain(`![Elena](${entry?.thumbnail})`);
    // The archive path stays the picture's name; the ref is a token, so a folder or file name with a space is no obstacle.
    expect(entry?.thumbnail).toMatch(/^import:[A-Za-z0-9._/-]{1,120}$/);
    expect(read.value.document.assets?.map((asset) => asset.name)).toContain('Elena portrait.png');
    // The store's own commit rewrite, not this reader's idea of it: the research page must end up pointing at the stored picture.
    const stored = rewritePictureRefs(buildResearchPage(entry!), new Map([[entry?.thumbnail ?? '', 'assets/elena-portrait.png']]));
    expect(stored.body).toContain('![Elena](assets/elena-portrait.png)');
    expect(stored.body).not.toContain('import:');
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

/** NovelCrafter exports the manuscript and the codex separately, so the writer picks the two together. */
const CODEX_ONLY = {
  'characters/Elena/entry.md': ELENA_ENTRY,
  'characters/Elena/metadata.json': JSON.stringify({ relations: [{ name: 'Mara', type: 'first mate' }] }),
};

const picked = (path: string, text: string) => ({ path, bytes: new TextEncoder().encode(text) });

describe('a manuscript picked beside the codex zip (#292)', () => {
  it('imports the picked manuscript and the zip’s codex as one read', async () => {
    const read = await readNovelCrafterExport(
      exportOf(CODEX_ONLY),
      picked('novel.md', '# Chapter 1: The Landing\n\nThe ferry came at noon.\n\n# Chapter 2: Salt\n\nNight fell.'),
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.codex).toHaveLength(1);
    expect(read.value.document.blocks.map((block) => block.text ?? '').join(' ')).toContain('The ferry came at noon.');
    expect(read.value.document.blocks.filter((block) => block.kind === 'heading')).toHaveLength(2);
    expect(read.value.leftOut).toEqual([]);
  });

  it('keeps the picked file’s front matter under its own name', async () => {
    const read = await readNovelCrafterExport(
      exportOf(CODEX_ONLY),
      picked('novel.md', '---\nsynopsis: The ferry comes in.\nstatus: Draft\n---\n# Chapter 1\n\nThe ferry came at noon.'),
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.frontMatter['novel.md']?.scene.synopsis).toBe('The ferry comes in.');
    expect(read.value.frontMatter['novel.md']?.scene.status).toBe('Draft');
  });

  it('names the export’s own manuscript instead of dropping it silently', async () => {
    const read = await readNovelCrafterExport(
      exportOf({ ...CODEX_ONLY, 'old-novel.md': '# Old\n\nAn earlier draft.' }),
      picked('novel.md', '# Chapter 1\n\nThe ferry came at noon.'),
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.leftOut).toEqual(['old-novel.md']);
    const text = read.value.document.blocks.map((block) => block.text ?? '').join(' ');
    expect(text).toContain('The ferry came at noon.');
    expect(text).not.toContain('An earlier draft.');
  });

  it('still resolves a picture the manuscript references from the export', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const read = await readNovelCrafterExport(
      exportOf({ ...CODEX_ONLY, 'images/harbour.png': png }),
      picked('novel.md', '# Chapter 1\n\n![The harbour](images/harbour.png)'),
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const image = read.value.document.blocks.find((block) => block.kind === 'image');
    expect(image).toBeDefined();
    expect(read.value.assetData.size).toBeGreaterThan(0);
  });

  it('reads the export’s own manuscript when no file is picked beside it', async () => {
    const read = await readNovelCrafterExport(exportOf({ ...CODEX_ONLY, 'novel.md': '# Chapter 1\n\nThe ferry came at noon.' }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.leftOut).toEqual([]);
    expect(read.value.document.blocks.map((block) => block.text ?? '').join(' ')).toContain('The ferry came at noon.');
  });
});
