import { describe, expect, it } from 'vitest';

import {
  ARCHIVE_LIMITS,
  ImportArchiveError,
  decodeEntryName,
  isArchiveResidue,
  normaliseArchivePath,
  openFolder,
  openZip,
  type ArchiveLimits,
  type ArchiveResult,
  type FolderFile,
  type ImportArchive,
} from '../src/zip.js';
import { deflateSync, rawZip, textZip } from './zip-fixtures.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

async function opened(bytes: Uint8Array, limits?: Partial<ArchiveLimits>): Promise<ImportArchive> {
  const result = await openZip(bytes, limits);
  if (!result.ok) throw result.error;
  return result.value;
}

async function refused(bytes: Uint8Array, limits?: Partial<ArchiveLimits>): Promise<ImportArchiveError> {
  const result = await openZip(bytes, limits);
  if (result.ok) throw new Error('expected a refusal');
  expect(result.error).toBeInstanceOf(ImportArchiveError);
  expect(result.error.name).toBe('ImportArchiveError');
  return result.error;
}

function value<T>(result: ArchiveResult<T>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

describe('openZip — the manifest first, the rest on demand', () => {
  it('lists the entries without inflating, then reads the ones asked for', async () => {
    const zip = textZip({ 'Book.scriv/Book.scrivx': '<ScrivenerProject/>', 'Book.scriv/Files/Data/1/content.rtf': '{\\rtf1 Hi}', 'empty/': '' });
    const archive = await opened(zip);
    expect(archive.kind).toBe('zip');
    expect(archive.entries.map((e) => e.path)).toEqual(['Book.scriv/Book.scrivx', 'Book.scriv/Files/Data/1/content.rtf']);
    expect(archive.ignored).toEqual(['empty']);
    expect(archive.entry('Book.scriv/Book.scrivx')?.size).toBe(19);
    expect(dec.decode(value(await archive.read('Book.scriv/Book.scrivx')))).toBe('<ScrivenerProject/>');
    const many = value(await archive.readMany(['Book.scriv/Files/Data/1/content.rtf', 'Book.scriv/Book.scrivx']));
    expect([...many.keys()].sort()).toEqual(['Book.scriv/Book.scrivx', 'Book.scriv/Files/Data/1/content.rtf']);
    expect(await archive.read('missing.txt')).toMatchObject({ ok: false, error: { code: 'not-found' } });
  });

  it('ignores __MACOSX, AppleDouble ._ files and .DS_Store', async () => {
    const archive = await opened(textZip({ 'a.txt': 'a', '__MACOSX/._a.txt': 'x', 'dir/._b.txt': 'x', 'dir/.DS_Store': 'x', 'dir/b.txt': 'b' }));
    expect(archive.entries.map((e) => e.path)).toEqual(['a.txt', 'dir/b.txt']);
    expect(archive.ignored).toEqual(['__MACOSX/._a.txt', 'dir/._b.txt', 'dir/.DS_Store']);
  });

  it('decodes names as UTF-8 when valid, flagged or not, and as code page 437 otherwise', async () => {
    // "Größe.txt" as DOS writes it in CP437: ö is 0x94, ß is 0xE1.
    const cp437 = new Uint8Array([0x47, 0x72, 0x94, 0xe1, 0x65, 0x2e, 0x74, 0x78, 0x74]);
    const archive = await opened(
      rawZip([
        { name: cp437, data: enc.encode('dos') },
        { name: '草堂.txt', data: enc.encode('flagged'), flags: 0x800 },
        { name: 'Café.txt', data: enc.encode('unflagged utf-8') },
      ]),
    );
    expect(archive.entries.map((e) => e.path)).toEqual(['Größe.txt', '草堂.txt', 'Café.txt']);
    expect(dec.decode(value(await archive.read('Größe.txt')))).toBe('dos');
    expect(dec.decode(value(await archive.read('Café.txt')))).toBe('unflagged utf-8');
    expect(decodeEntryName(new Uint8Array([0x80, 0xff]))).toBe('Ç\u00a0');
    // A name flagged UTF-8 whose bytes are not UTF-8 is read as code page 437, never with U+FFFD in it.
    const flagged = await opened(rawZip([{ name: new Uint8Array([0x82, 0x61]), data: enc.encode('x'), flags: 0x800 }]));
    expect(flagged.entries.map((e) => e.path)).toEqual(['éa']);
  });

  it('turns backslashes into separators and drops . segments', async () => {
    const archive = await opened(rawZip([{ name: 'Book\\Files\\.\\a.txt', data: enc.encode('a') }]));
    expect(archive.entries.map((e) => e.path)).toEqual(['Book/Files/a.txt']);
  });
});

describe('openZip — refusals, by name, before anything is inflated', () => {
  it('refuses something that is not a zip', async () => {
    expect((await refused(enc.encode('not a zip at all, just some text that is long enough'))).code).toBe('not-a-zip');
    expect((await refused(new Uint8Array(3))).code).toBe('not-a-zip');
  });

  it('reads a zip that writes the zip64 records, and refuses a damaged directory by its own name', async () => {
    const text = enc.encode('草堂 zip64');
    const packed = deflateSync(enc.encode('a'.repeat(5000)));
    const entries = [
      { name: 'Draft/one.txt', data: text },
      { name: 'Draft/two.txt', data: packed, method: 8, size: 5000 },
    ];
    const archive = await opened(rawZip(entries, { zip64: true }));
    expect(archive.entries).toEqual([
      { path: 'Draft/one.txt', size: text.length, compressedSize: text.length },
      { path: 'Draft/two.txt', size: 5000, compressedSize: packed.length },
    ]);
    expect(dec.decode(value(await archive.read('Draft/one.txt')))).toBe('草堂 zip64');
    expect(value(await archive.read('Draft/two.txt'))).toHaveLength(5000);
    // With the zip64 end record damaged, the plain end record's 0xFFFF entries are too many; with that cap raised, its
    // 0xFFFFFFFF directory offset points past the file, and the directory is reported damaged, not "not a zip".
    expect((await refused(rawZip(entries, { zip64: true, breakZip64Record: true }))).code).toBe('too-many-entries');
    expect((await refused(rawZip(entries, { zip64: true, breakZip64Record: true }), { maxEntries: 70_000 })).code).toBe('corrupt-directory');
  });

  it('keeps every cap when an override is NaN, Infinity or negative, and the default caps cannot be changed', async () => {
    const zip = rawZip([{ name: 'a.txt', data: enc.encode('abc') }]);
    expect((await refused(zip, { maxArchiveBytes: 10, maxEntryBytes: Number.NaN })).code).toBe('archive-too-large');
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const bomb = rawZip([{ name: 'bomb.bin', data: deflateSync(new Uint8Array(2 * 1024 * 1024)), method: 8, size: 2 * 1024 * 1024 }]);
      expect((await refused(bomb, { maxRatio: bad })).code).toBe('zip-bomb');
    }
    expect(Object.isFrozen(ARCHIVE_LIMITS)).toBe(true);
  });

  it('refuses path traversal anywhere in the archive', async () => {
    for (const name of ['../evil.txt', 'a/../../evil.txt', '/etc/passwd', 'C:/Windows/evil.txt', '..\\evil.txt']) {
      const error = await refused(rawZip([{ name: 'ok.txt', data: enc.encode('ok') }, { name, data: enc.encode('x') }]));
      expect(error.code).toBe('path-traversal');
      expect(error.path).toBe(name);
    }
    expect(normaliseArchivePath('a/./b//c')).toEqual({ path: 'a/b/c' });
  });

  it('refuses a zip bomb by its ratio, and by its sizes', async () => {
    const zeros = deflateSync(new Uint8Array(20 * 1024 * 1024));
    const bomb = rawZip([{ name: 'bomb.bin', data: zeros, method: 8, size: 20 * 1024 * 1024 }]);
    expect(zeros.length).toBeLessThan(100_000);
    const error = await refused(bomb);
    expect(error.code).toBe('zip-bomb');
    expect(error.path).toBe('bomb.bin');
    // The same file under an entry cap it exceeds, and under a total cap.
    expect((await refused(bomb, { maxRatio: 1e9, maxEntryBytes: 1024 * 1024 })).code).toBe('entry-too-large');
    expect((await refused(bomb, { maxRatio: 1e9, maxTotalBytes: 1024 * 1024 })).code).toBe('total-too-large');
    expect((await refused(bomb, { maxArchiveBytes: 1000 })).code).toBe('archive-too-large');
    // A small run of spaces is not a bomb.
    const spaces = deflateSync(enc.encode(' '.repeat(500_000)));
    expect((await opened(rawZip([{ name: 's.txt', data: spaces, method: 8, size: 500_000 }]))).entries).toHaveLength(1);
  });

  it('never inflates past what an entry declares, even when the header lies', async () => {
    const real = deflateSync(new Uint8Array(1024 * 1024).fill(0x41));
    const archive = await opened(rawZip([{ name: 'liar.txt', data: real, method: 8, size: 10 }]));
    const bytes = value(await archive.read('liar.txt'));
    expect(bytes.length).toBeLessThanOrEqual(10);
  });

  it('refuses 2,001 entries and takes 2,000', async () => {
    const files = (n: number): Record<string, string> => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}.txt`, '']));
    expect(ARCHIVE_LIMITS.maxEntries).toBe(2000);
    expect((await opened(textZip(files(2000)))).entries).toHaveLength(2000);
    expect((await refused(textZip(files(2001)))).code).toBe('too-many-entries');
    expect((await opened(textZip(files(2001)), { maxEntries: 5000 })).entries).toHaveLength(2001);
  });

  it('refuses two entries with one path, an encrypted entry and an unknown method', async () => {
    expect((await refused(rawZip([{ name: 'a.txt', data: enc.encode('1') }, { name: 'a.txt', data: enc.encode('2') }]))).code).toBe('duplicate-entry');
    const locked = await opened(rawZip([{ name: 'secret.txt', data: enc.encode('x'), flags: 1 }]));
    expect(await locked.read('secret.txt')).toMatchObject({ ok: false, error: { code: 'encrypted' } });
    const bzip = await opened(rawZip([{ name: 'b.txt', data: enc.encode('x'), method: 12 }]));
    expect(await bzip.read('b.txt')).toMatchObject({ ok: false, error: { code: 'unsupported-compression' } });
  });

  it('reports a damaged entry rather than throwing', async () => {
    const archive = await opened(rawZip([{ name: 'bad.txt', data: new Uint8Array([0xff, 0xff, 0xff, 0xff]), method: 8, size: 100 }]));
    expect(await archive.read('bad.txt')).toMatchObject({ ok: false, error: { code: 'corrupt-entry' } });
  });
});

describe('openFolder — the folder-upload equivalent', () => {
  const file = (path: string, text: string): FolderFile => {
    const bytes = enc.encode(text);
    return { path, size: bytes.length, read: async () => bytes };
  };

  it('keeps the same rules and the same interface as a zip', async () => {
    const archive = value(openFolder([file('Book.scriv/Book.scrivx', '<x/>'), file('Book.scriv/.DS_Store', ''), file('Book.scriv\\Files\\a.rtf', 'a')]));
    expect(archive.kind).toBe('folder');
    expect(archive.entries.map((e) => e.path)).toEqual(['Book.scriv/Book.scrivx', 'Book.scriv/Files/a.rtf']);
    expect(archive.ignored).toEqual(['Book.scriv/.DS_Store']);
    expect(dec.decode(value(await archive.read('Book.scriv/Files/a.rtf')))).toBe('a');
    expect(value(await archive.readMany(['Book.scriv/Book.scrivx'])).size).toBe(1);
  });

  it('refuses traversal, too many files, a file over the cap, and a file that reads back larger than it said', async () => {
    expect(openFolder([file('../x', '')])).toMatchObject({ ok: false, error: { code: 'path-traversal' } });
    expect(openFolder(Array.from({ length: 3 }, (_, i) => file(`${i}`, '')), { maxEntries: 2 })).toMatchObject({ ok: false, error: { code: 'too-many-entries' } });
    expect(openFolder([file('big', 'abc')], { maxEntryBytes: 2 })).toMatchObject({ ok: false, error: { code: 'entry-too-large' } });
    const liar = value(openFolder([{ path: 'liar', size: 1, read: async () => enc.encode('longer') }]));
    expect(await liar.read('liar')).toMatchObject({ ok: false, error: { code: 'entry-too-large' } });
    const broken = value(openFolder([{ path: 'gone', size: 1, read: async () => Promise.reject(new Error('NotReadableError')) }]));
    expect(await broken.read('gone')).toMatchObject({ ok: false, error: { code: 'unreadable' } });
  });
});

describe('residue', () => {
  it('names what macOS leaves in an archive', () => {
    expect(['__MACOSX', '__MACOSX/a', 'a/._b', '.DS_Store', 'x/.DS_Store'].every(isArchiveResidue)).toBe(true);
    expect(['a', '_b', 'a/.b', 'MACOSX/a'].some(isArchiveResidue)).toBe(false);
  });
});
