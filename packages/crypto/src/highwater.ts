import { RollbackError } from './errors.js';

/**
 * The highest version of each file (and of the manifest) this device has seen. A server that later serves a
 * lower one is replaying old ciphertext: it authenticates, because it was sealed once, so only this device-held
 * memory can tell. Keys are opaque hashes, so the marks hold no file name. Keep them with the device, not the account.
 */
export class HighWaterMarks {
  readonly #marks = new Map<string, number>();

  constructor(entries: Iterable<readonly [string, number]> = []) {
    for (const [key, version] of entries) this.#marks.set(key, version);
  }

  get(key: string): number | undefined {
    return this.#marks.get(key);
  }

  /** Throws {@link RollbackError} when `version` is below the mark. Equal is fine: it is the same version read again. */
  check(key: string, version: number): void {
    const seen = this.#marks.get(key);
    if (seen !== undefined && version < seen) throw new RollbackError(key, version, seen);
  }

  /** Checks, then raises the mark to `version`. */
  advance(key: string, version: number): void {
    this.check(key, version);
    this.#marks.set(key, version);
  }

  /** `[key, version]` pairs, sorted, for the caller to persist. */
  entries(): [string, number][] {
    return [...this.#marks].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }
}
