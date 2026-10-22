/**
 * Artifact filesystem port — [project-format.md §1/§4](docs/architecture/project-format.md).
 *
 * The write path in §4 is deliberately expressed as a port rather than a
 * concrete binding, because v0.1 runs in a browser where the "folder" may be a
 * real directory (File System Access API), a staged zip, or — in tests and
 * headless use — memory. What the *spec* fixes is not the binding but the
 * contract, so the contract is what lives here:
 *
 *   - every write is atomic: temp name, then rename (§4)
 *   - paths are project-root-relative, POSIX-separated, never escaping the root
 *   - readers ignore unknown files and never fail on them (§1)
 *
 * `writeAtomic` is the only mutation entry point. There is deliberately no
 * plain `write`: making the torn-write class unrepresentable in the port is
 * cheaper than remembering to avoid it at each call site.
 */

export class ArtifactNotFoundError extends Error {
  constructor(path: string) {
    super(`artifact path not found: ${path}`);
    this.name = 'ArtifactNotFoundError';
  }
}

export interface ArtifactFs {
  /** UTF-8 text read. Throws {@link ArtifactNotFoundError} when absent. */
  read(path: string): Promise<string>;
  /**
   * Atomic write: write to a temp name in the same directory, then rename over
   * the target (§4 — the novelWriter temp-fsync-rename pattern).
   */
  writeAtomic(path: string, contents: string): Promise<void>;
  /** File basenames directly inside `dir` (not recursive, not directories). */
  listFiles(dir: string): Promise<string[]>;
  /** Directory basenames directly inside `dir` (not recursive, not files). */
  listDirs(dir: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  ensureDir(dir: string): Promise<void>;
  /** Removes a file, text or binary. No-op when absent; refuses to remove directories. */
  remove(path: string): Promise<void>;
  /**
   * Binary read. Throws {@link ArtifactNotFoundError} when absent. A text file reads
   * back as its UTF-8 bytes, so a caller need not know which kind a path holds.
   */
  readBytes(path: string): Promise<Uint8Array>;
  /**
   * Atomic binary write, with the same temp-then-rename contract as
   * {@link writeAtomic}. The DOCX and EPUB renderers write their output under
   * `exports/` through this; nothing else in the store writes bytes.
   */
  writeBytesAtomic(path: string, bytes: Uint8Array): Promise<void>;
}

export function joinPath(dir: string, name: string): string {
  if (dir === '' || dir === '.') return name;
  // A scan, not `/\/+$/` — that regex is quadratic on a long run of slashes
  // followed by anything else.
  let end = dir.length;
  while (end > 0 && dir.charCodeAt(end - 1) === 47) end--;
  return `${dir.slice(0, end)}/${name}`;
}

export function dirName(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx < 0 ? '' : path.slice(0, idx);
}

/** Reject absolute paths and `..` escapes — a project root is the whole world. */
function assertContained(path: string): void {
  if (path === '') return;
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    throw new Error(`artifact path must be project-relative: ${path}`);
  }
  if (path.split('/').some((segment) => segment === '..')) {
    throw new Error(`artifact path must not escape the project root: ${path}`);
  }
}

/**
 * In-memory artifact filesystem.
 *
 * This is the default binding for tests, headless tools and the browser's
 * "assemble the full folder in memory" step of §4, which every real binding
 * implements anyway before it is allowed to touch a disk.
 */
export class MemoryArtifactFs implements ArtifactFs {
  /** A text file is a string and a binary file is its bytes; one namespace, one path. */
  private readonly files = new Map<string, string | Uint8Array>();
  private readonly dirs = new Set<string>(['']);
  private tempCounter = 0;

  /**
   * Path → text for every text file, sorted. Used by tests to diff a whole project.
   * A binary file is not here; {@link snapshotBytes} is its view. The two are kept
   * apart because the text view is typed as strings, and a caller that parses it
   * (the exporter's compile log, for one) must not be handed a value that might be
   * bytes.
   */
  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of [...this.files.keys()].sort()) {
      const value = this.files.get(key);
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  }

  /** Path → bytes for every binary file, sorted. The binary counterpart of {@link snapshot}. */
  snapshotBytes(): Record<string, Uint8Array> {
    const out: Record<string, Uint8Array> = {};
    for (const key of [...this.files.keys()].sort()) {
      const value = this.files.get(key);
      if (value instanceof Uint8Array) out[key] = value.slice();
    }
    return out;
  }

  async read(path: string): Promise<string> {
    assertContained(path);
    const contents = this.files.get(path);
    if (contents === undefined) throw new ArtifactNotFoundError(path);
    // A binary file read as text must be valid UTF-8, or the caller is holding
    // something other than the text it asked for.
    return typeof contents === 'string' ? contents : new TextDecoder('utf-8', { fatal: true }).decode(contents);
  }

  async readBytes(path: string): Promise<Uint8Array> {
    assertContained(path);
    const contents = this.files.get(path);
    if (contents === undefined) throw new ArtifactNotFoundError(path);
    // A copy either way, so a caller that edits what it read cannot edit the artifact.
    return typeof contents === 'string' ? new TextEncoder().encode(contents) : contents.slice();
  }

  async writeAtomic(path: string, contents: string): Promise<void> {
    assertContained(path);
    this.tempCounter += 1;
    const temp = `${path}.tmp-${this.tempCounter}`;
    this.files.set(temp, contents);
    // A rename over an existing path is replace-by-unlink-then-link on every
    // real filesystem we care about; do the same here so the semantics match.
    this.files.delete(path);
    this.files.set(path, contents);
    this.files.delete(temp);
  }

  async writeBytesAtomic(path: string, bytes: Uint8Array): Promise<void> {
    assertContained(path);
    this.tempCounter += 1;
    const temp = `${path}.tmp-${this.tempCounter}`;
    this.files.set(temp, bytes.slice());
    this.files.delete(path);
    this.files.set(path, bytes.slice());
    this.files.delete(temp);
  }

  async listFiles(dir: string): Promise<string[]> {
    assertContained(dir);
    const prefix = dir === '' ? '' : `${dir}/`;
    const names = new Set<string>();
    for (const path of this.files.keys()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (rest === '' || rest.includes('/')) continue;
      names.add(rest);
    }
    return [...names].sort();
  }

  async listDirs(dir: string): Promise<string[]> {
    assertContained(dir);
    const prefix = dir === '' ? '' : `${dir}/`;
    const names = new Set<string>();
    for (const path of this.dirs) {
      if (path === '' || !path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (rest === '' || rest.includes('/')) continue;
      names.add(rest);
    }
    return [...names].sort();
  }

  async exists(path: string): Promise<boolean> {
    assertContained(path);
    return this.files.has(path) || this.dirs.has(path);
  }

  async ensureDir(dir: string): Promise<void> {
    assertContained(dir);
    let cursor = '';
    for (const segment of dir.split('/').filter(Boolean)) {
      cursor = joinPath(cursor, segment);
      this.dirs.add(cursor);
    }
  }

  async remove(path: string): Promise<void> {
    assertContained(path);
    if (this.dirs.has(path)) {
      throw new Error(`refusing to remove a directory through remove(): ${path}`);
    }
    this.files.delete(path);
  }

  /** Test seam: plant a file without going through the atomic write path. */
  putFile(path: string, contents: string): void {
    assertContained(path);
    this.files.set(path, contents);
  }

  /** Test seam: plant a corrupt or truncated file to drive a recovery path. */
  putFileRaw(path: string, contents: string): void {
    this.putFile(path, contents);
  }
}
