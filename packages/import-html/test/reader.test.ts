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

/** A PNG with a real signature and IHDR: the reader offers only bytes the picture pipeline would take, so a fixture must be one. */
function pngOf(width = 1, height = 1, ...tail: number[]): Uint8Array {
  const be = (value: number): number[] => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
  return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be(width), ...be(height), 8, 6, 0, 0, 0, ...tail]);
}

describe('the HTML reader (#299)', () => {
  it('reads a single page, its title and a data: image', () => {
    const png = 'data:image/png;base64,' + Buffer.from(pngOf()).toString('base64');
    const read = readHtmlFile(enc(`<html><head><title>The Landing</title></head><body><h1>Chapter One</h1><p><img src="${png}" alt="cover"/></p></body></html>`), 'page.html');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.title).toBe('The Landing');
    expect(read.value.document.blocks[0]).toMatchObject({ kind: 'heading', text: 'Chapter One' });
    expect(read.value.assetData.size).toBe(1);
    expect([...read.value.assetData.values()][0]).toEqual(pngOf());
  });

  it('keeps the footnotes the shared walker extracts, out of the prose', () => {
    const read = readHtmlFile(
      enc('<html xmlns:epub="http://www.idpf.org/2007/ops"><body><p>A claim<a epub:type="noteref" href="#fn1">1</a>.</p><aside epub:type="footnote" id="fn1">The note itself.</aside></body></html>'),
      'page.html',
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.document.blocks[0]?.kind === 'para' ? read.value.document.blocks[0].md : '').toBe('A claim[^1].');
    expect(read.value.document.blocks).toHaveLength(1);
    expect(read.value.document.footnotes).toEqual([{ blockIndex: 0, label: '1', md: 'The note itself.' }]);
  });

  it('keeps footnote labels unique across the pages of a web-page archive', async () => {
    const pageWithNote = (claim: string, note: string): string =>
      `<html xmlns:epub="http://www.idpf.org/2007/ops"><body><p>${claim}<a epub:type="noteref" href="#fn1">1</a>.</p><aside epub:type="footnote" id="fn1">${note}</aside></body></html>`;
    const read = await readHtmlArchive(archiveOf({
      'one.html': pageWithNote('The first claim', 'The first note.'),
      'two.html': pageWithNote('The second claim', 'The second note.'),
    }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const bodies = read.value.document.blocks.map((block) => (block.kind === 'para' ? block.md : ''));
    expect(bodies).toEqual(['The first claim[^1].', 'The second claim[^2].']);
    expect(read.value.document.footnotes?.map((note) => [note.label, note.md])).toEqual([
      ['1', 'The first note.'],
      ['2', 'The second note.'],
    ]);
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
      'images/cover.png': pngOf(1, 1, 1, 2, 3),
    }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.title).toBe('The Landing');
    expect(read.value.assetData.size).toBe(1);
    expect([...read.value.assetData.values()][0]).toEqual(pngOf(1, 1, 1, 2, 3));
    expect(read.value.document.assets?.[0]?.name).toBe('cover.png');
  });

  it('keeps two pages’ pictures apart, each with its own bytes', async () => {
    const read = await readHtmlArchive(archiveOf({
      'one.html': '<html><body><p><img src="a.png" alt="a"/></p></body></html>',
      'two.html': '<html><body><p><img src="b.png" alt="b"/></p></body></html>',
      'a.png': pngOf(1, 1, 1),
      'b.png': pngOf(1, 1, 2),
    }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const refs = read.value.document.blocks.flatMap((block) => (block.kind === 'para' ? [block.md] : []));
    expect(refs).toHaveLength(2);
    expect(refs[0]).not.toBe(refs[1]);
    expect(read.value.assetData.size).toBe(2);
    expect(read.value.document.assets?.map((asset) => asset.name)).toEqual(['a.png', 'b.png']);
    const bytes = [...read.value.assetData.values()];
    expect(bytes[0]).toEqual(pngOf(1, 1, 1));
    expect(bytes[1]).toEqual(pngOf(1, 1, 2));
  });

  it('resolves ../ and ./ to the archive’s own folders, and names a picture the archive does not carry', async () => {
    const read = await readHtmlArchive(archiveOf({
      'docs/page.html': '<html><body><p>One. <img src="images/missing.png" alt="the missing map"/></p><p>Two. <img src="../images/present.png" alt="the lamp"/></p><p>Three. <img src="./images/present.png" alt="again"/></p></body></html>',
      'images/present.png': pngOf(1, 1, 7, 8),
    }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // The picture the archive carries is found through `../` and `./`, and the one it does not is named.
    expect(read.value.document.assets?.map((asset) => asset.name)).toEqual(['present.png', 'present.png']);
    const loss = read.value.document.losses?.find((held) => held.code === 'image-unreadable');
    expect(loss?.message).toContain('images/missing.png');
    expect(loss?.count).toBe(1);
    // No block or inline target keeps a ref with no bytes behind it.
    const md = read.value.document.blocks.map((block) => (block.kind === 'image' ? block.assetRef : 'md' in block ? block.md : '')).join('\n');
    expect(md).toContain('the missing map');
    expect(md).not.toContain('import:html-image-0-0');
  });

  it('keeps the words of an unresolved picture whose alt carries a bracket, escaped as the walker writes it', () => {
    const read = readHtmlFile(enc('<html><body><p>The chart. <img src="missing.png" alt="a]b"/></p></body></html>'), 'page.html');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const md = read.value.document.blocks.map((block) => ('md' in block ? block.md : '')).join('\n');
    expect(md).toContain('The chart. a\\]b');
    expect(md).not.toContain('import:html-image-');
    const loss = read.value.document.losses?.find((held) => held.code === 'image-unreadable');
    expect(loss?.message).toContain('missing.png');
  });

  it('refuses a picture path that climbs above the archive, even when the root carries its name', async () => {
    const read = await readHtmlArchive(archiveOf({
      'page.html': '<html><body><p>The map. <img src="../secret.png" alt="the secret"/></p></body></html>',
      'secret.png': pngOf(1, 1, 9),
    }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.assetData.size).toBe(0);
    expect(read.value.document.assets).toEqual([]);
    const md = read.value.document.blocks.map((block) => ('md' in block ? block.md : '')).join('\n');
    expect(md).toContain('The map. the secret');
    expect(md).not.toContain('import:html-image-');
    const loss = read.value.document.losses?.find((held) => held.code === 'image-unreadable');
    expect(loss?.message).toContain('../secret.png');
  });

  it('a lone page keeps the words of every relative picture it cannot resolve, and names them', () => {
    const read = readHtmlFile(enc('<html><body><p>One. <img src="images/missing.png" alt="the map"/></p><img src="other.png" alt="the lamp"/></body></html>'), 'page.html');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.document.blocks.some((block) => block.kind === 'image')).toBe(false);
    const md = read.value.document.blocks.map((block) => ('md' in block ? block.md : '')).join('\n');
    expect(md).toContain('One. the map');
    expect(md).toContain('the lamp');
    expect(md).not.toContain('import:html-image-');
    const loss = read.value.document.losses?.find((held) => held.code === 'image-unreadable');
    expect(loss?.count).toBe(2);
    expect(loss?.message).toContain('images/missing.png');
    expect(loss?.message).toContain('other.png');
  });

  it('counts form controls across the pages of a web-page zip', async () => {
    const read = await readHtmlArchive(archiveOf({
      'one.html': '<html><body><form><input name="a"/></form><p>One.</p></body></html>',
      'two.html': '<html><body><button>Go</button><p>Two.</p></body></html>',
    }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.dropped.forms).toBe(3);
    expect(JSON.stringify(read.value.document.blocks)).not.toContain('Go');
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

  it('offers no picture the store would refuse: a GIF in the page keeps its words and is named', () => {
    // The commit runs the picture pipeline strictly over the whole batch, so one GIF would refuse the entire import.
    const gif = 'data:image/gif;base64,' + Buffer.from('GIF89a').toString('base64');
    const read = readHtmlFile(enc(`<html><body><p>The chart. <img src="${gif}" alt="the chart"/></p></body></html>`), 'page.html');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.assetData.size).toBe(0);
    expect(read.value.document.assets).toEqual([]);
    const md = read.value.document.blocks.map((block) => ('md' in block ? block.md : '')).join('\n');
    expect(md).toContain('The chart. the chart');
    expect(md).not.toContain('import:html-image-');
    const loss = read.value.document.losses?.find((held) => held.code === 'image-unreadable');
    expect(loss?.message).toContain('not a PNG, JPEG or WebP');
    expect(loss?.message).toContain('an embedded picture');
    expect(loss?.message).not.toContain('base64');
  });

  it('offers no picture the store would refuse: a GIF in the zip and a picture over the pixel budget', async () => {
    const read = await readHtmlArchive(archiveOf({
      'page.html': '<html><body><img src="anim.gif" alt="the animation"/><img src="huge.png" alt="the map"/><img src="ok.png" alt="the lamp"/></body></html>',
      'anim.gif': new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]),
      // A real PNG header stating 10,000 × 10,000 pixels: 100 megapixels, over the store's 50.
      'huge.png': pngOf(10_000, 10_000),
      'ok.png': pngOf(2, 2),
    }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.document.assets?.map((asset) => asset.name)).toEqual(['ok.png']);
    expect(read.value.assetData.size).toBe(1);
    const losses = read.value.document.losses ?? [];
    expect(losses.find((loss) => loss.message?.includes('anim.gif') === true)?.message).toContain('not a PNG, JPEG or WebP');
    expect(losses.find((loss) => loss.message?.includes('huge.png') === true)?.message).toContain('larger than a picture may be');
    const md = read.value.document.blocks.map((block) => (block.kind === 'image' ? block.assetRef : 'md' in block ? block.md : '')).join('\n');
    expect(md).toContain('the animation');
    expect(md).toContain('the map');
    expect(md).not.toContain('import:html-image-0-0');
    expect(md).not.toContain('import:html-image-0-1');
  });
});
