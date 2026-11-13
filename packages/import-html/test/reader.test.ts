import { describe, expect, it } from 'vitest';

import { ImportArchiveError, type ImportArchive } from '@caotang/import-read/zip';
import { readHtmlFile, readHtmlArchive } from '../src/reader.js';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

function archiveOf(files: Record<string, string | Uint8Array>): ImportArchive {
  const bytesOf = (value: string | Uint8Array): Uint8Array => (typeof value === 'string' ? enc(value) : value);
  const entries = Object.entries(files).map(([path, value]) => ({ path, size: bytesOf(value).length, isDirectory: false, compressedSize: bytesOf(value).length }));
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

describe('the HTML reader (#299)', () => {
  it('reads a single page, its title and a data: image', () => {
    const png = 'data:image/png;base64,' + Buffer.from([137, 80, 78, 71]).toString('base64');
    const read = readHtmlFile(enc(`<html><head><title>The Landing</title></head><body><h1>Chapter One</h1><p><img src="${png}" alt="cover"/></p></body></html>`), 'page.html');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.title).toBe('The Landing');
    expect(read.value.document.blocks[0]).toMatchObject({ kind: 'heading', text: 'Chapter One' });
    expect(read.value.assetData.size).toBe(1);
    expect([...read.value.assetData.values()][0]).toEqual(new Uint8Array([137, 80, 78, 71]));
  });

  it('lists a remote image instead of fetching it', () => {
    const read = readHtmlFile(enc('<html><body><p><img src="https://example.com/x.png" alt="x"/></p></body></html>'), 'page.html');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.remoteImages).toEqual(['https://example.com/x.png']);
    expect(read.value.assetData.size).toBe(0);
  });

  it('reads a web-page folder and resolves its relative images', async () => {
    const read = await readHtmlArchive(archiveOf({
      'page.html': '<html><head><title>The Landing</title></head><body><h1>Chapter One</h1><p><img src="images/cover.png" alt="cover"/></p></body></html>',
      'images/cover.png': new Uint8Array([1, 2, 3]),
    }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.title).toBe('The Landing');
    expect(read.value.assetData.size).toBe(1);
    expect([...read.value.assetData.values()][0]).toEqual(new Uint8Array([1, 2, 3]));
    expect(read.value.document.assets?.[0]?.name).toBe('cover.png');
  });

  it('refuses an archive with no HTML page', async () => {
    const read = await readHtmlArchive(archiveOf({ 'readme.txt': 'nothing' }));
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error.kind).toBe('no-html');
  });

  it('reads a well-formed page without a title as the file name', () => {
    const read = readHtmlFile(enc('<html><body><p>Only text.</p></body></html>'), 'my-page.html');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.title).toBe('my-page');
  });
});
