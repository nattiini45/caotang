/**
 * The packed `.mcpb`, read as a zip by this file's own reader rather than by fflate: the archive's
 * end-of-central-directory record, each central directory entry resolved to its local header, and
 * every entry's inflated bytes checked against its stated length and CRC. A host's installer is a
 * strict zip reader, so an archive that unpacks with a lenient library is not yet a bundle that
 * installs. The reader is also given hostile names and a tampered archive, so a check that has
 * stopped failing cannot pass.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { afterAll, describe, expect, it } from 'vitest';

import { packBundle } from '../scripts/pack-mcpb.mjs';
import { removeDir, tempDir } from './support.js';

const PACKAGE_DIR = resolve(__dirname, '..');
const REPO_ROOT = resolve(PACKAGE_DIR, '..', '..');
const MANIFEST_PATH = join(PACKAGE_DIR, 'manifest.json');
const ROOT_NODE_RANGE = (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { engines: { node: string } }).engines.node;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  /** Where the entry's central directory record starts, for a test that tampers with it. */
  readonly centralOffset: number;
  /** The inflated bytes, after the length and CRC checks passed. */
  readonly bytes: Buffer;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Every entry of a zip, read strictly. Throws on a missing or inconsistent end-of-central-directory
 * record, a central entry with no local header, a name that is not the same in both, a method other
 * than stored or deflate, a length that disagrees with the bytes, and a CRC that does not match.
 */
function readZipStrict(archive: Buffer): ZipEntry[] {
  const eocd = findEocd(archive);
  const diskNumber = archive.readUInt16LE(eocd + 4);
  const centralDisk = archive.readUInt16LE(eocd + 6);
  const entriesOnDisk = archive.readUInt16LE(eocd + 8);
  const entryCount = archive.readUInt16LE(eocd + 10);
  const centralSize = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  if (diskNumber !== 0 || centralDisk !== 0) throw new Error(`a single-disk zip is required; the archive names disk ${diskNumber} of ${centralDisk}`);
  if (entriesOnDisk !== entryCount) throw new Error(`the central directory lists ${entryCount} entries but ${entriesOnDisk} on this disk`);
  if (centralOffset + centralSize !== eocd) throw new Error('the central directory does not end where its end record begins');

  const entries: ZipEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > archive.length) throw new Error(`central directory entry ${index} is cut off`);
    if (archive.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw new Error(`central directory entry ${index} has no signature`);
    const method = archive.readUInt16LE(cursor + 10);
    const statedCrc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const rawName = archive.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = rawName.toString('utf8');
    if (!Buffer.from(name, 'utf8').equals(rawName)) throw new Error(`entry ${index}'s name is not valid UTF-8`);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) throw new Error(`${name} uses zip64 sizes, which this bundle does not`);

    if (localOffset + 30 > archive.length) throw new Error(`${name} has no local header`);
    if (archive.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw new Error(`${name} has no local header signature`);
    const localMethod = archive.readUInt16LE(localOffset + 8);
    const localCrc = archive.readUInt32LE(localOffset + 14);
    const localCompressed = archive.readUInt32LE(localOffset + 18);
    const localUncompressed = archive.readUInt32LE(localOffset + 22);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const localRawName = archive.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    const localName = localRawName.toString('utf8');
    if (localName !== name) throw new Error(`${name}'s local header names ${localName}`);
    if (localMethod !== method) throw new Error(`${name} states method ${method} centrally and ${localMethod} locally`);
    if (localCrc !== statedCrc || localCompressed !== compressedSize || localUncompressed !== uncompressedSize) {
      throw new Error(`${name}'s local header and central record disagree about its size or CRC`);
    }

    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const data = archive.subarray(dataOffset, dataOffset + compressedSize);
    if (data.length !== compressedSize) throw new Error(`${name}'s bytes are cut off`);
    let bytes: Buffer;
    if (method === 0) bytes = data;
    else if (method === 8) bytes = inflateRawSync(data);
    else throw new Error(`${name} uses compression method ${method}, which this reader does not know`);
    if (bytes.length !== uncompressedSize) throw new Error(`${name} inflates to ${bytes.length} bytes, not the stated ${uncompressedSize}`);
    if (crc32(bytes) !== statedCrc) throw new Error(`${name}'s CRC does not match its bytes`);

    entries.push({ name, method, crc32: statedCrc, compressedSize, uncompressedSize, centralOffset: cursor, bytes });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== centralOffset + centralSize) throw new Error('the central directory holds more bytes than its entries account for');
  return entries;
}

function findEocd(archive: Buffer): number {
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 22 - 0xffff); offset -= 1) {
    if (archive.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    const commentLength = archive.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === archive.length) return offset;
  }
  throw new Error('the archive has no end-of-central-directory record at its end');
}

/** What a strict reader or extractor would refuse in these names. An empty list is a sound set. */
function namingProblems(entries: readonly { name: string }[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const { name } of entries) {
    if (seen.has(name)) problems.push(`${name} appears more than once`);
    seen.add(name);
    if (name.length === 0) problems.push('an entry has an empty name');
    if (name.startsWith('/')) problems.push(`${name} is an absolute path`);
    if (/^[A-Za-z]:/.test(name)) problems.push(`${name} is an absolute Windows path`);
    if (name.includes('\\')) problems.push(`${name} uses a backslash as a separator`);
    const segments = name.split('/');
    if (name.endsWith('/')) segments.pop();
    if (segments.includes('..')) problems.push(`${name} climbs out of the archive with ..`);
    if (segments.some((segment) => segment === '')) problems.push(`${name} has an empty path segment`);
  }
  return problems;
}

describe('the packed .mcpb read as a zip', () => {
  const outDir = tempDir('pack-strict');
  const serverBundle = join(outDir, 'caotang-mcp.mjs');
  const serverSource = '#!/usr/bin/env node\nconsole.log("caotang-mcp strict fixture");\n';
  let bundle = '';
  let entries: ZipEntry[] = [];

  afterAll(() => {
    removeDir(outDir);
  });

  it('packs, and every central directory entry resolves to a local header and its inflated bytes', () => {
    writeFileSync(serverBundle, serverSource);
    // A font and the decoder, so the archive holds the nested folders the real bundle does.
    const font = join(outDir, 'NotoSansMonoCJKsc-Regular.woff');
    const decoder = join(outDir, 'webp_dec.wasm');
    writeFileSync(font, 'fixture font');
    writeFileSync(decoder, 'fixture decoder');
    const packed = packBundle({
      outDir,
      serverBundle,
      manifestPath: MANIFEST_PATH,
      version: '0.1.0',
      nodeRange: ROOT_NODE_RANGE,
      notices: '# Third-party notices\n',
      license: join(REPO_ROOT, 'LICENSE'),
      fonts: [font],
      serverFiles: [decoder],
    });
    bundle = packed.bundle;
    expect(existsSync(bundle)).toBe(true);
    entries = readZipStrict(readFileSync(bundle));
    expect(entries.length).toBeGreaterThanOrEqual(6);
  });

  it('holds manifest.json at its root and the server exactly as the build wrote it', () => {
    const manifest = entries.filter((entry) => entry.name === 'manifest.json');
    expect(manifest).toHaveLength(1);
    expect(manifest[0]?.bytes.toString('utf8')).toBe(readFileSync(MANIFEST_PATH, 'utf8'));
    const server = entries.find((entry) => entry.name === 'server/caotang-mcp.mjs');
    expect(server).toBeDefined();
    expect(server?.uncompressedSize).toBe(statSync(serverBundle).size);
    expect(server?.bytes.toString('utf8')).toBe(serverSource);
  });

  it('names no entry above the archive, with a drive letter, a backslash, or twice', () => {
    expect(namingProblems(entries)).toEqual([]);
    expect(entries.map((entry) => entry.name)).toEqual(
      expect.arrayContaining([
        'manifest.json',
        'server/caotang-mcp.mjs',
        'server/webp_dec.wasm',
        'server/fonts/NotoSansMonoCJKsc-Regular.woff',
        'THIRD-PARTY-NOTICES.md',
        'LICENSE',
      ]),
    );
  });

  it('refuses the names a strict reader refuses, so the check above cannot pass vacuously', () => {
    const problems = namingProblems([
      { name: '../escape.txt' },
      { name: '/absolute.txt' },
      { name: 'C:/drive.txt' },
      { name: 'server\\windows.txt' },
      { name: 'twice.txt' },
      { name: 'twice.txt' },
    ]);
    expect(problems.join('\n')).toContain('../escape.txt climbs out');
    expect(problems.join('\n')).toContain('/absolute.txt is an absolute path');
    expect(problems.join('\n')).toContain('C:/drive.txt is an absolute Windows path');
    expect(problems.join('\n')).toContain('server\\windows.txt uses a backslash');
    expect(problems.join('\n')).toContain('twice.txt appears more than once');
  });

  it('refuses a tampered CRC and a truncated archive', () => {
    const tampered = Buffer.from(readFileSync(bundle));
    const first = entries[0];
    if (first === undefined) throw new Error('the archive has no entries');
    tampered.writeUInt32LE((first.crc32 ^ 0xffffffff) >>> 0, first.centralOffset + 16);
    expect(() => readZipStrict(tampered)).toThrow(/CRC|disagree/);
    expect(() => readZipStrict(readFileSync(bundle).subarray(0, 40))).toThrow(/end-of-central-directory/);
  });
});
