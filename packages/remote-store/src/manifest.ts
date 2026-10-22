import { RemoteIntegrityError } from './errors.js';

export interface FileEntry {
  /** HMAC of the path (crypto `hashPath`); what the sealed file is bound to and the rollback mark is keyed by. */
  readonly hash: string;
  /** Rises by one on every write and on a delete. Never reused, so a tombstone still raises the mark. */
  readonly version: number;
  /** The name of the live blob on the server. Random per write; empty for a tombstone. */
  readonly blob: string;
  readonly deleted: boolean;
}

/**
 * The encrypted index that lets the server hold nothing but hashed names: every path, its version, and the
 * explicit directories. Paths are kept in a Map because a path is writer-chosen text and `__proto__` is one.
 */
export class Manifest {
  constructor(
    readonly counter = 0,
    readonly files: ReadonlyMap<string, FileEntry> = new Map(),
    readonly dirs: ReadonlySet<string> = new Set(),
  ) {}

  next(files: Map<string, FileEntry>, dirs: Set<string>): Manifest {
    return new Manifest(this.counter + 1, files, dirs);
  }

  serialize(): Uint8Array {
    const files = [...this.files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, e]) => [path, e.hash, e.version, e.blob, e.deleted ? 1 : 0]);
    return new TextEncoder().encode(JSON.stringify({ format: 1, files, dirs: [...this.dirs].sort() }));
  }

  static parse(counter: number, bytes: Uint8Array): Manifest {
    const fail = (detail: string): never => {
      throw new RemoteIntegrityError(null, detail);
    };
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (cause) {
      return fail(`the index is not readable: ${String(cause)}`);
    }
    if (typeof raw !== 'object' || raw === null || !('format' in raw) || raw.format !== 1) return fail('the index has an unknown format');
    const rows: unknown = 'files' in raw ? raw.files : undefined;
    const dirList: unknown = 'dirs' in raw ? raw.dirs : undefined;
    if (!Array.isArray(rows) || !Array.isArray(dirList)) return fail('the index is malformed');
    const files = new Map<string, FileEntry>();
    for (const row of rows as unknown[]) {
      if (!Array.isArray(row) || row.length !== 5) return fail('the index holds a malformed file row');
      const [path, hash, version, blob, deleted] = row as unknown[];
      if (typeof path !== 'string' || typeof hash !== 'string' || typeof blob !== 'string' || !Number.isSafeInteger(version) || (deleted !== 0 && deleted !== 1)) {
        return fail('the index holds a malformed file row');
      }
      files.set(path, { hash, version: version as number, blob, deleted: deleted === 1 });
    }
    const dirs = new Set<string>();
    for (const dir of dirList as unknown[]) {
      if (typeof dir !== 'string') return fail('the index holds a malformed directory');
      dirs.add(dir);
    }
    return new Manifest(counter, files, dirs);
  }
}
