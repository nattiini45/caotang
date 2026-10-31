/**
 * The archive reader every import shares (issue #268; research: scrivener.md §5, doc-formats.md §1).
 *
 * A Scrivener project arrives as a zip (a Mac `.scriv` is a package that Chrome's folder picker cannot select) or as a folder
 * (Windows and Linux); DOCX, ODT, EPUB, XLSX and TextPack are zips. Both shapes come out as one {@link ImportArchive}: a list of
 * entries read first, and each entry's bytes pulled on demand, so a reader looks at the manifest (`*.scrivx`, `[Content_Types].xml`,
 * `META-INF/container.xml`) before it unpacks anything else.
 *
 * **Why `unzipSync` and nothing else from fflate.** The app's CSP is `script-src 'self'; worker-src 'self'` with no `blob:`.
 * fflate's async API builds its workers from `blob:` URLs and function source, which that policy refuses, so this module calls
 * only `unzipSync`, and a caller that wants it off the main thread runs this module in its own `'self'` Worker. fflate is loaded
 * on first use from `fflate/browser` (the same subpath `@caotang/store` uses, for the reason its zip.ts gives), so importing this
 * module costs nothing until an archive is opened.
 *
 * **What it refuses, before any byte is inflated** (each a named {@link ImportArchiveError}):
 * - an archive over `maxArchiveBytes`, more than `maxEntries` entries, an entry over `maxEntryBytes`, a total over `maxTotalBytes`;
 * - a zip bomb: an entry whose declared size is more than `maxRatio` times its compressed size (once it is over
 *   `ratioFloorBytes`, so a small run of spaces is not a bomb). fflate inflates into a buffer of exactly the declared size and
 *   never grows it, so an entry whose header lies about its size cannot write past the caps either: it comes back short;
 * - a path that leaves the archive (`..`, a leading `/`, a drive letter), two entries with one path, and encryption.
 *
 * **What it leaves out without refusing:** directories, `__MACOSX/` and AppleDouble `._*` files, and `.DS_Store`; their paths are
 * listed in `ignored`. Entry names are decoded as UTF-8 when the zip says so (flag bit 11) or when the bytes are valid UTF-8, and
 * as code page 437 otherwise, which is what Windows' and older macOS archivers write.
 */

import type { unzipSync as UnzipSync } from 'fflate/browser';

/** The caps an archive is opened under. Every one has a default in {@link ARCHIVE_LIMITS}. */
export interface ArchiveLimits {
  /** The largest archive file accepted, in bytes. */
  readonly maxArchiveBytes: number;
  /** The most entries, directories and ignored entries included. The skills import's 2,000 is the precedent. */
  readonly maxEntries: number;
  /** The largest single entry, uncompressed. */
  readonly maxEntryBytes: number;
  /** The most bytes all kept entries add up to, uncompressed. */
  readonly maxTotalBytes: number;
  /** The highest uncompressed-to-compressed ratio an entry may have once it is over `ratioFloorBytes`. */
  readonly maxRatio: number;
  /** Entries at or under this size are not ratio-checked. */
  readonly ratioFloorBytes: number;
}

const MB = 1024 * 1024;

/**
 * The defaults. A research-heavy Scrivener project can be hundreds of megabytes, so a reader that expects one raises
 * `maxArchiveBytes`, `maxTotalBytes` and `maxEntries` for that format; the defaults suit a document format.
 */
export const ARCHIVE_LIMITS: ArchiveLimits = {
  maxArchiveBytes: 512 * MB,
  maxEntries: 2000,
  maxEntryBytes: 256 * MB,
  maxTotalBytes: 1024 * MB,
  maxRatio: 200,
  ratioFloorBytes: 1 * MB,
};

export type ArchiveErrorCode =
  | 'not-a-zip'
  | 'archive-too-large'
  | 'too-many-entries'
  | 'entry-too-large'
  | 'total-too-large'
  | 'zip-bomb'
  | 'path-traversal'
  | 'duplicate-entry'
  | 'encrypted'
  | 'unsupported-compression'
  | 'corrupt-entry'
  | 'not-found';

/** A named reason an archive, or one entry of it, could not be read. `path` names the entry when it is about one. */
export class ImportArchiveError extends Error {
  override readonly name = 'ImportArchiveError';
  constructor(
    readonly code: ArchiveErrorCode,
    message: string,
    readonly path?: string,
  ) {
    super(message);
  }
}

/** One file in an archive or folder. */
export interface ArchiveEntry {
  /** The path inside the archive, `/`-separated, with no leading `/`, `./` or `..`. */
  readonly path: string;
  /** Uncompressed size in bytes, as the archive declares it (a folder's file size). */
  readonly size: number;
  /** Compressed size in bytes; equal to `size` for a folder. */
  readonly compressedSize: number;
}

export type ArchiveResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ImportArchiveError };

/**
 * A zip or a folder, opened. The entry list is known at once; bytes are read on demand. Nothing here throws for anything about
 * the input: a refusal is `{ ok: false, error }`.
 */
export interface ImportArchive {
  readonly kind: 'zip' | 'folder';
  /** Every kept file, in archive order. */
  readonly entries: readonly ArchiveEntry[];
  /** Paths left out without refusing: directories, `__MACOSX/`, `._*`, `.DS_Store`. */
  readonly ignored: readonly string[];
  /** The entry at `path`, or undefined. */
  entry(path: string): ArchiveEntry | undefined;
  /** One entry's bytes. */
  read(path: string): Promise<ArchiveResult<Uint8Array>>;
  /** Several entries' bytes in one pass, keyed by path. Fails as a whole when any one fails. */
  readMany(paths: readonly string[]): Promise<ArchiveResult<ReadonlyMap<string, Uint8Array>>>;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Paths and names
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * An archive path made safe, or the reason it is refused. Backslashes are separators (Windows archivers write them), `.` and
 * empty segments go, and a path that names `..`, starts at a root, or names a drive is refused: it would leave the folder.
 */
export function normaliseArchivePath(raw: string): { readonly path: string } | { readonly problem: string } {
  const slashed = raw.replaceAll('\\', '/');
  if (slashed.startsWith('/')) return { problem: `${raw} starts at the root of a disk` };
  if (/^[A-Za-z]:/.test(slashed)) return { problem: `${raw} names a drive` };
  if (slashed.includes('\0')) return { problem: `${raw} holds a NUL character` };
  const parts: string[] = [];
  for (const part of slashed.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') return { problem: `${raw} climbs out of its folder` };
    parts.push(part);
  }
  return { path: parts.join('/') };
}

/** Whether an entry is macOS or Finder residue that no reader wants: `__MACOSX/…`, an AppleDouble `._name`, or `.DS_Store`. */
export function isArchiveResidue(path: string): boolean {
  if (path === '__MACOSX' || path.startsWith('__MACOSX/')) return true;
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.startsWith('._') || base === '.DS_Store';
}

/** Code page 437's upper half, 0x80–0xFF: what DOS, Windows' "Compressed folder" and older macOS Archive Utility write. */
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0';

const utf8Strict = new TextDecoder('utf-8', { fatal: true });

/** An entry name's bytes as text: UTF-8 when the flag says so or the bytes are valid UTF-8, code page 437 otherwise. */
export function decodeEntryName(bytes: Uint8Array, utf8Flag: boolean): string {
  if (utf8Flag) return new TextDecoder('utf-8').decode(bytes);
  try {
    return utf8Strict.decode(bytes);
  } catch {
    let out = '';
    for (const b of bytes) out += b < 0x80 ? String.fromCharCode(b) : (CP437_HIGH[b - 0x80] ?? '?');
    return out;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// The central directory
// ---------------------------------------------------------------------------------------------------------------------------

interface CentralRecord {
  /** The name as fflate keys it: UTF-8 when flagged, latin-1 otherwise. Used to check the two walks agree. */
  readonly fflateName: string;
  readonly name: string;
  readonly flags: number;
  readonly method: number;
  readonly compressedSize: number;
  readonly size: number;
}

const u16 = (d: Uint8Array, at: number): number => (d[at] ?? 0) | ((d[at + 1] ?? 0) << 8);
const u32 = (d: Uint8Array, at: number): number => (u16(d, at) | (u16(d, at + 2) << 16)) >>> 0;
const u64 = (d: Uint8Array, at: number): number => u32(d, at) + u32(d, at + 4) * 2 ** 32;

function latin1(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

/**
 * Walks the central directory the way fflate's `unzipSync` does (same end-record search, same zip64 rules), so record `i` here
 * is the `i`-th entry its filter sees. Reads only headers; inflates nothing.
 */
function readCentralDirectory(d: Uint8Array, maxEntries: number): ArchiveResult<CentralRecord[]> {
  const bad = (message: string): ArchiveResult<CentralRecord[]> => ({ ok: false, error: new ImportArchiveError('not-a-zip', message) });
  if (d.length < 22) return bad('The file is too short to be a zip');
  let e = d.length - 22;
  while (u32(d, e) !== 0x06054b50) {
    e -= 1;
    if (e < 0 || d.length - e > 65558) return bad('The file has no zip directory');
  }
  let count = u16(d, e + 10);
  let offset = u32(d, e + 16);
  let zip64 = e >= 20 && u32(d, e - 20) === 0x07064b50;
  if (zip64) {
    const z = u64(d, e - 12);
    zip64 = u32(d, z) === 0x06064b50;
    if (zip64) {
      count = u64(d, z + 32);
      offset = u64(d, z + 48);
    }
  }
  if (count > maxEntries) {
    return { ok: false, error: new ImportArchiveError('too-many-entries', `The zip holds ${count} entries, more than the ${maxEntries} this import takes`) };
  }
  const records: CentralRecord[] = [];
  let at = offset;
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > d.length || u32(d, at) !== 0x02014b50) return bad('The zip directory is damaged');
    const flags = u16(d, at + 8);
    const method = u16(d, at + 10);
    let compressedSize = u32(d, at + 20);
    let size = u32(d, at + 24);
    const nameLength = u16(d, at + 28);
    const extraLength = u16(d, at + 30);
    const commentLength = u16(d, at + 32);
    const nameBytes = d.subarray(at + 46, at + 46 + nameLength);
    const utf8 = (flags & 0x800) !== 0;
    if (zip64 && (size === 0xffffffff || compressedSize === 0xffffffff)) {
      // The zip64 extended-information field holds the sizes that overflowed, uncompressed first.
      const extraEnd = at + 46 + nameLength + extraLength;
      for (let x = at + 46 + nameLength; x + 4 < extraEnd; x += 4 + u16(d, x + 2)) {
        if (u16(d, x) !== 1) continue;
        let y = x + 4;
        if (size === 0xffffffff) {
          size = u64(d, y);
          y += 8;
        }
        if (compressedSize === 0xffffffff) compressedSize = u64(d, y);
        break;
      }
    }
    records.push({
      fflateName: utf8 ? new TextDecoder('utf-8').decode(nameBytes) : latin1(nameBytes),
      name: decodeEntryName(nameBytes, utf8),
      flags,
      method,
      compressedSize,
      size,
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return { ok: true, value: records };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Shared checks
// ---------------------------------------------------------------------------------------------------------------------------

interface Candidate {
  readonly raw: string;
  readonly size: number;
  readonly compressedSize: number;
  readonly isDirectory: boolean;
}

interface Kept {
  readonly entry: ArchiveEntry;
  readonly index: number;
}

/** Applies the path, residue, duplicate and size rules to a list of candidates. Shared by the zip and the folder. */
function admit(candidates: readonly Candidate[], limits: ArchiveLimits, checkRatio: boolean): ArchiveResult<{ kept: Kept[]; ignored: string[] }> {
  const fail = (code: ArchiveErrorCode, message: string, path?: string): ArchiveResult<never> => ({ ok: false, error: new ImportArchiveError(code, message, path) });
  if (candidates.length > limits.maxEntries) return fail('too-many-entries', `It holds ${candidates.length} entries, more than the ${limits.maxEntries} this import takes`);
  const kept: Kept[] = [];
  const ignored: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const [index, c] of candidates.entries()) {
    const normal = normaliseArchivePath(c.raw);
    if ('problem' in normal) return fail('path-traversal', `It was not opened: the path ${normal.problem}`, c.raw);
    const path = normal.path;
    if (c.isDirectory || path === '' || isArchiveResidue(path)) {
      ignored.push(path === '' ? c.raw : path);
      continue;
    }
    if (seen.has(path)) return fail('duplicate-entry', `It holds ${path} twice`, path);
    seen.add(path);
    if (c.size > limits.maxEntryBytes) return fail('entry-too-large', `${path} is ${c.size} bytes, more than the ${limits.maxEntryBytes} one file may be`, path);
    if (checkRatio && c.size > limits.ratioFloorBytes && c.size > c.compressedSize * limits.maxRatio) {
      return fail('zip-bomb', `${path} would grow from ${c.compressedSize} to ${c.size} bytes, which is how a zip bomb is built`, path);
    }
    total += c.size;
    if (total > limits.maxTotalBytes) return fail('total-too-large', `Its files add up to more than ${limits.maxTotalBytes} bytes`, path);
    kept.push({ entry: { path, size: c.size, compressedSize: c.compressedSize }, index });
  }
  return { ok: true, value: { kept, ignored } };
}

function limitsOf(overrides: Partial<ArchiveLimits> | undefined): ArchiveLimits {
  return { ...ARCHIVE_LIMITS, ...overrides };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Zip
// ---------------------------------------------------------------------------------------------------------------------------

let unzipSyncLoaded: typeof UnzipSync | undefined;

/** fflate's `unzipSync`, from `fflate/browser`, loaded on first use. */
async function loadUnzipSync(): Promise<typeof UnzipSync> {
  unzipSyncLoaded ??= (await import('fflate/browser')).unzipSync;
  return unzipSyncLoaded;
}

/**
 * Opens a zip: reads its directory, applies the caps, and returns the archive without inflating anything. `read` and
 * `readMany` inflate only the entries they are asked for.
 */
export async function openZip(bytes: Uint8Array, overrides?: Partial<ArchiveLimits>): Promise<ArchiveResult<ImportArchive>> {
  const limits = limitsOf(overrides);
  if (bytes.length > limits.maxArchiveBytes) {
    return { ok: false, error: new ImportArchiveError('archive-too-large', `The zip is ${bytes.length} bytes, more than the ${limits.maxArchiveBytes} this import takes`) };
  }
  const directory = readCentralDirectory(bytes, limits.maxEntries);
  if (!directory.ok) return directory;
  const records = directory.value;
  const admitted = admit(
    records.map((r) => ({ raw: r.name, size: r.size, compressedSize: r.compressedSize, isDirectory: r.name.endsWith('/') || r.name.endsWith('\\') })),
    limits,
    true,
  );
  if (!admitted.ok) return admitted;
  const unzipSync = await loadUnzipSync();
  const byPath = new Map<string, Kept>(admitted.value.kept.map((k) => [k.entry.path, k]));

  const readMany = async (paths: readonly string[]): Promise<ArchiveResult<ReadonlyMap<string, Uint8Array>>> => {
    const wanted = new Map<number, string>();
    for (const path of paths) {
      const kept = byPath.get(path);
      if (kept === undefined) return { ok: false, error: new ImportArchiveError('not-found', `The archive holds no ${path}`, path) };
      const record = records[kept.index];
      if (record === undefined) return { ok: false, error: new ImportArchiveError('not-found', `The archive holds no ${path}`, path) };
      if ((record.flags & 0x1) !== 0) return { ok: false, error: new ImportArchiveError('encrypted', `${path} is encrypted`, path) };
      if (record.method !== 0 && record.method !== 8) {
        return { ok: false, error: new ImportArchiveError('unsupported-compression', `${path} is compressed with method ${record.method}, which this reader does not know`, path) };
      }
      wanted.set(kept.index, path);
    }
    const out = new Map<string, Uint8Array>();
    if (wanted.size === 0) return { ok: true, value: out };
    let index = -1;
    let mismatch: string | undefined;
    const keyOf = new Map<string, string>();
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(bytes, {
        filter: (file) => {
          index += 1;
          const path = wanted.get(index);
          if (path === undefined) return false;
          // The two walks must agree; if they do not, the directory is not what it seemed.
          if (records[index]?.fflateName !== file.name) {
            mismatch = path;
            return false;
          }
          keyOf.set(path, file.name);
          return true;
        },
      });
    } catch (cause) {
      return { ok: false, error: new ImportArchiveError('corrupt-entry', `The zip could not be unpacked: ${cause instanceof Error ? cause.message : String(cause)}`) };
    }
    if (mismatch !== undefined) return { ok: false, error: new ImportArchiveError('corrupt-entry', `The zip directory does not match its entries at ${mismatch}`, mismatch) };
    for (const path of wanted.values()) {
      const data = files[keyOf.get(path) ?? ''];
      if (data === undefined) return { ok: false, error: new ImportArchiveError('corrupt-entry', `${path} could not be unpacked`, path) };
      out.set(path, data);
    }
    return { ok: true, value: out };
  };

  const archive: ImportArchive = {
    kind: 'zip',
    entries: admitted.value.kept.map((k) => k.entry),
    ignored: admitted.value.ignored,
    entry: (path) => byPath.get(path)?.entry,
    read: async (path) => {
      const many = await readMany([path]);
      if (!many.ok) return many;
      const data = many.value.get(path);
      return data === undefined ? { ok: false, error: new ImportArchiveError('not-found', `The archive holds no ${path}`, path) } : { ok: true, value: data };
    },
    readMany,
  };
  return { ok: true, value: archive };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Folder
// ---------------------------------------------------------------------------------------------------------------------------

/** One file of a picked or dropped folder: its path inside the folder (`webkitRelativePath`, or a walked handle), size and bytes. */
export interface FolderFile {
  readonly path: string;
  readonly size: number;
  read(): Promise<Uint8Array>;
}

/**
 * The folder-upload equivalent of {@link openZip}: the same paths, residue, duplicate, entry and total rules over files the
 * writer picked or dropped, so a reader takes a Windows `.scriv` folder and a zipped Mac package through one interface. There is
 * no ratio check, since nothing is inflated; a file that reads back larger than its size or the entry cap is refused.
 */
export function openFolder(files: readonly FolderFile[], overrides?: Partial<ArchiveLimits>): ArchiveResult<ImportArchive> {
  const limits = limitsOf(overrides);
  const admitted = admit(
    files.map((f) => ({ raw: f.path, size: f.size, compressedSize: f.size, isDirectory: false })),
    limits,
    false,
  );
  if (!admitted.ok) return admitted;
  const byPath = new Map<string, Kept>(admitted.value.kept.map((k) => [k.entry.path, k]));

  const read = async (path: string): Promise<ArchiveResult<Uint8Array>> => {
    const kept = byPath.get(path);
    const file = kept === undefined ? undefined : files[kept.index];
    if (kept === undefined || file === undefined) return { ok: false, error: new ImportArchiveError('not-found', `The folder holds no ${path}`, path) };
    let data: Uint8Array;
    try {
      data = await file.read();
    } catch (cause) {
      return { ok: false, error: new ImportArchiveError('corrupt-entry', `${path} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`, path) };
    }
    if (data.length > limits.maxEntryBytes || data.length > kept.entry.size) {
      return { ok: false, error: new ImportArchiveError('entry-too-large', `${path} read back larger than it said it was`, path) };
    }
    return { ok: true, value: data };
  };

  return {
    ok: true,
    value: {
      kind: 'folder',
      entries: admitted.value.kept.map((k) => k.entry),
      ignored: admitted.value.ignored,
      entry: (path) => byPath.get(path)?.entry,
      read,
      readMany: async (paths) => {
        const out = new Map<string, Uint8Array>();
        for (const path of paths) {
          const one = await read(path);
          if (!one.ok) return one;
          out.set(path, one.value);
        }
        return { ok: true, value: out };
      },
    },
  };
}
