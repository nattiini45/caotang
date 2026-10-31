/**
 * The comic lettering fonts (vendor/comic-lettering, @caotang/font-comic-lettering): every file against the SHA-256 its
 * SHA256SUMS pins, the WOFF structure the loaders rely on, the licence texts, and the finding that decides whether the
 * crossbar-I rule can be drawn (docs/architecture/comics.md §4). Vendored folders are outside the collected package
 * globs, so this guard lives here, like the other repository-level checks.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { VENDORED_WORKSPACE_PACKAGES } from '../tools/third-party-notices.mjs';

const dir = resolve(__dirname, '../vendor/comic-lettering');
const read = (name: string): Buffer => readFileSync(resolve(dir, name));

const WOFF_FILES = [
  'ComicNeue-Regular.woff',
  'ComicNeue-Italic.woff',
  'ComicNeue-Bold.woff',
  'ComicNeue-BoldItalic.woff',
  'Bangers-Regular.woff',
] as const;

const sums = new Map(
  read('SHA256SUMS')
    .toString('utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line): [string, string] => {
      const [digest = '', name = ''] = line.split(/\s+(.*)/s);
      return [name.trim(), digest];
    }),
);

interface WoffTable {
  readonly data: Buffer;
}

/** The tables of a WOFF 1.0 file, inflated where they are compressed. */
function woffTables(file: Buffer): { flavor: number; numTables: number; length: number; tables: Map<string, WoffTable> } {
  expect(file.toString('latin1', 0, 4)).toBe('wOFF');
  const numTables = file.readUInt16BE(12);
  const tables = new Map<string, WoffTable>();
  for (let index = 0; index < numTables; index += 1) {
    const entry = 44 + index * 20;
    const tag = file.toString('latin1', entry, entry + 4);
    const offset = file.readUInt32BE(entry + 4);
    const compressed = file.readUInt32BE(entry + 8);
    const original = file.readUInt32BE(entry + 12);
    const raw = file.subarray(offset, offset + compressed);
    tables.set(tag, { data: compressed < original ? inflateSync(raw) : raw });
  }
  return { flavor: file.readUInt32BE(4), numTables, length: file.readUInt32BE(8), tables };
}

/** The feature tags a GSUB table declares. */
function gsubFeatures(gsub: Buffer): string[] {
  const featureList = gsub.readUInt16BE(6);
  const count = gsub.readUInt16BE(featureList);
  return Array.from({ length: count }, (_, index) => gsub.toString('latin1', featureList + 2 + index * 6, featureList + 6 + index * 6));
}

describe('vendor/comic-lettering', () => {
  it.each(WOFF_FILES)('%s is the file SHA256SUMS pins, byte for byte', (file) => {
    const digest = sums.get(file);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash('sha256').update(read(file)).digest('hex')).toBe(digest);
  });

  it('pins every source file it was built from', () => {
    for (const source of ['ComicNeue-Regular.ttf', 'ComicNeue-Italic.ttf', 'ComicNeue-Bold.ttf', 'ComicNeue-BoldItalic.ttf', 'Bangers-Regular.ttf']) {
      expect(sums.get(`${source} (source)`), source).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it.each(WOFF_FILES)('%s is a TrueType WOFF with its layout tables and no signature', (file) => {
    const woff = woffTables(read(file));
    expect(woff.flavor).toBe(0x00010000);
    expect(woff.length).toBe(read(file).length);
    for (const table of ['glyf', 'loca', 'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'GSUB', 'GPOS', 'GDEF']) {
      expect(woff.tables.has(table), table).toBe(true);
    }
    expect(woff.tables.has('DSIG')).toBe(false);
  });

  it.each(WOFF_FILES)('%s pads every glyph to 4 bytes, as fontkit’s subsetter expects', (file) => {
    const { tables } = woffTables(read(file));
    const head = tables.get('head')?.data;
    const loca = tables.get('loca')?.data;
    if (head === undefined || loca === undefined) throw new Error('head or loca missing');
    const long = head.readInt16BE(50) === 1;
    const step = long ? 4 : 2;
    for (let offset = 0; offset < loca.length; offset += step) {
      const location = (long ? loca.readUInt32BE(offset) : loca.readUInt16BE(offset) * 2);
      expect(location % 4).toBe(0);
    }
  });

  it('keeps no crossbar-I alternate in Comic Neue: its GSUB has no stylistic set, character variant or alternate feature', () => {
    for (const file of WOFF_FILES.filter((name) => name.startsWith('ComicNeue'))) {
      const gsub = woffTables(read(file)).tables.get('GSUB')?.data;
      if (gsub === undefined) throw new Error(`${file} has no GSUB`);
      expect(gsubFeatures(gsub).sort(), file).toEqual(['aalt', 'case', 'ccmp', 'frac', 'ordn', 'sups']);
    }
  });

  it('carries each family’s OFL 1.1 text with its copyright line', () => {
    const comicNeue = read('LICENSE-ComicNeue.txt').toString('utf8');
    const bangers = read('LICENSE-Bangers.txt').toString('utf8');
    expect(comicNeue).toContain('Copyright 2014 The Comic Neue Project Authors (https://github.com/crozynski/comicneue)');
    expect(bangers).toContain('Copyright 2010 The Bangers Project Authors (https://github.com/googlefonts/bangers)');
    for (const text of [comicNeue, bangers]) {
      expect(text).toContain('SIL OPEN FONT LICENSE Version 1.1');
      expect(text).not.toMatch(/with Reserved Font Name/);
    }
  });

  it('exports each font file and ships the files its README and build script name', () => {
    const manifest = JSON.parse(read('package.json').toString('utf8')) as { name: string; license: string; exports: Record<string, string>; files: string[] };
    expect(manifest.name).toBe('@caotang/font-comic-lettering');
    expect(manifest.license).toBe('OFL-1.1');
    for (const file of WOFF_FILES) expect(manifest.exports[`./${file}`]).toBe(`./${file}`);
    for (const file of manifest.files) expect(existsSync(resolve(dir, file)), file).toBe(true);
  });

  it('is listed in the third-party notices tool as a vendored workspace package', () => {
    expect(VENDORED_WORKSPACE_PACKAGES).toContain('@caotang/font-comic-lettering');
  });
});
