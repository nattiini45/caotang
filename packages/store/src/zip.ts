/**
 * Portable zip bundle — [project-format.md §7](docs/architecture/project-format.md).
 *
 * §7 in full: "**Zip bundle:** `<project-name>.caotang`, a zip with `caotang.json`
 * at zip-root (never nested under a directory). Import accepts zip or directory;
 * export is lossless both ways. The extension is `.caotang`, not `.zip`, so an OS
 * opens it with Caotang rather than an archive tool. **ToC.md** (generated on export): human-readable map
 * `order — title — status — filename`, so an opaque-id folder is navigable
 * without Caotang. Cheap, addresses the hex-name ergonomic cost; goes in
 * `exports/`, not the tree."
 *
 * ## The one design decision everything else follows from
 *
 * **The zip is a projection of the ordinary write path, not a second
 * serializer.** {@link exportProjectZip} runs the real {@link writeProject}
 * into a {@link MemoryArtifactFs} — §4's "assemble the full folder in memory" —
 * and then archives whatever that produced. So there is exactly one place in
 * this codebase that knows what a Caotang artifact *is*, and it is the one the
 * folder write already uses. A zip written by a second serializer is a second
 * dialect of the same format, and the two drift the first time a field is
 * added; §1's "single canonical layout" is a statement about bytes, and this is
 * how it stays one.
 *
 * The mirror of that on the way in: {@link importProjectZip} unzips into a
 * `MemoryArtifactFs` and hands it back **unread**, so import goes through the
 * ordinary `readProject` / `recoverProject` path. §2's validation order, §2
 * step 4's orphan import, the §5 recovery ladder and the front-matter/manifest
 * divergence notices all apply to a zip for free, because a zip is handed to
 * the same loader a folder is.
 *
 * ## Why `fflate/browser` and not `fflate`
 *
 * The spec's own §3a records the mechanism, and it is a fallthrough rather than
 * a declared condition: `fflate`'s `exports` map is `node` → `import` →
 * `require`, with **no `browser` key**, so the browser build is what you get by
 * *not* matching `node`. That makes the guarantee "no resolver sets the `node`
 * condition" — and this repository's test environment sets it (`vitest.config.ts`
 * is `environment: 'node'`, because the mock provider must be importable
 * headless).
 *
 * Measured here rather than assumed, on fflate 0.8.3:
 *
 * | import | resolves to (CJS condition) | `node:` references |
 * |---|---|---|
 * | `fflate` | `lib/node.cjs` — the **Node** build | 4 |
 * | `fflate/browser` | `lib/browser.cjs` — the **browser** build | 0 |
 *
 * So a bare `import { zipSync } from 'fflate'` in a unit test tests the Node
 * build while the browser app bundles `esm/browser.js`, and the tested file is
 * not the shipped file. Naming the subpath closes it: `fflate/browser` is an
 * **explicitly declared** export entry with no `node` condition of its own, so
 * every resolver — vitest, Vite, Node, a bundler's ESM path — lands on the
 * browser build. {@link ZIP_ENGINE} is exported so the test can assert *which*
 * module the code actually bound rather than trusting the import line, and
 * `zip.test.ts` does exactly that.
 */

// Types only. The functions are loaded on first use (`loadZipEngine`), so this module
// never statically imports `fflate` and the app's main bundle does not carry it.
import type { unzipSync as UnzipSync, zipSync as ZipSync } from 'fflate/browser';
import { skillPathProblem } from '@caotang/skills';
import { MemoryArtifactFs, type ArtifactFs } from './artifact-fs.js';
import {
  CODEX_DIR,
  DOCS_DIR,
  EXPORTS_DIR,
  GITIGNORE_FILE,
  MANIFEST_FILE,
  SESSIONS_FILE,
  SKILLS_DIR,
  bodyFile,
  isBodyType,
} from './paths.js';
import { writeProject } from './write.js';
import { parseSessionsLog, writeSessionsFile, type SessionRecord } from './sessions.js';
import { cloneProjectState, type ProjectState } from './state.js';
import type { LoadResult } from './read.js';

/** The folder the bundle carries binary files in: the storyboard's image store (storyboard.md §2.2). */
const ASSETS_DIR = 'assets';

const encoder = new TextEncoder();
/**
 * ⚠ **The bundle is a text bundle, and this decoder is why.**
 *
 * `fatal: false` is deliberate for the *content* case — §2's load-time validation
 * has to report a damaged `caotang.json` as a divergence notice rather than throw
 * from inside an unzip — but it has a consequence that is not visible from here:
 * an entry whose bytes are **not valid UTF-8** is not rejected, it is *replaced*.
 * Each invalid byte becomes U+FFFD, and `ArtifactFs` stores `string`, so the
 * change is permanent and silent.
 *
 * Measured, which pinned the boundary in
 * `zip.test.ts`: ASCII and multi-byte/astral UTF-8 round-trip byte-exactly; a PNG
 * header, a latin-1 `café` and a NUL/`0xFF` pair all come back changed and
 * longer. **No v0.1 file has any of those shapes** — §1–§9 are JSON, Markdown and
 * `.jsonl` — so this is a documented limit, not a live bug. It becomes one the
 * moment the tree admits a binary file (the media track's `assets/` store is the
 * first candidate, post-v0.1), and the fix is to carry `Uint8Array` through
 * `ArtifactFs`, **not** to flip `fatal` — flipping it would refuse a bundle
 * instead of carrying it, which is a different and worse failure.
 */
const decoder = new TextDecoder('utf-8', { fatal: false });

/**
 * The import's entry decoder, and the fix the note above asked for.
 *
 * An entry that is valid UTF-8 is text and goes in as text; one that is not is
 * binary and goes in as its bytes, so nothing is replaced. `ignoreBOM` keeps a
 * leading byte-order mark in the text, where the encoder will write it back.
 */
const strictDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Text when the bytes are valid UTF-8, `undefined` when they are binary. */
function textOf(contents: Uint8Array): string | undefined {
  try {
    return strictDecoder.decode(contents);
  } catch {
    return undefined;
  }
}

/** The two ZIP functions a bundle needs, as the browser build exports them. */
export interface ZipEngine {
  readonly zipSync: typeof ZipSync;
  readonly unzipSync: typeof UnzipSync;
}

/**
 * Loads the ZIP functions on first use, from the browser build.
 *
 * `fflate` is needed only when a writer exports or imports a bundle, so a static
 * import would carry it in the app's main bundle for every session. A dynamic
 * `import()` lets the bundler put it in its own chunk, which is the same
 * lazy-import-at-the-module-edge posture the exporter uses for DOCX and EPUB.
 * Both entry points are already `async`, so the load adds no new await point to
 * anything that could not wait before.
 */
export async function loadZipEngine(): Promise<ZipEngine> {
  const engine = await import('fflate/browser');
  return { zipSync: engine.zipSync, unzipSync: engine.unzipSync };
}

/**
 * The ZIP engine this module loads, and the subpath it loads it from.
 *
 * Exported so the resolution hazard above is *checkable* rather than a comment:
 * `zip.test.ts` loads it, compares the functions with both `fflate` and
 * `fflate/browser`, and reads this file's source to confirm `fflate` is never
 * statically imported. A hazard documented in prose and unguarded by a test is
 * the exact residue class this repo keeps finding in review.
 */
export const ZIP_ENGINE = {
  subpath: 'fflate/browser',
  load: loadZipEngine,
} as const;

/**
 * The bundle's file extension, §7: `<project-name>.caotang` (docs/decisions.md).
 */
export const BUNDLE_EXTENSION = '.caotang';

/** coherence.md §3's file name, at the bundle root. The coherence module's own constant has the same value (model.ts). */
export const COHERENCE_FILE_NAME = 'coherence.json';

/** agent-harness.md §12's file name, at the bundle root. The tasks module's own constant has the same value. */
export const TASKS_FILE_NAME = 'tasks.json';

/** §7: "export is lossless both ways" — the round-trip the module exists for. */
export interface ExportZipOptions {
  /** Stamped on `project.modifiedAt` and on every zip entry's mtime. */
  now?: Date;
  /**
   * The session log to carry, in full — `readSessions(store, projectId)` from
   * the runtime store, per `sessions.ts`'s projection contract.
   *
   * **The full log, never a tail.** §4 ranks `sessions.jsonl` as append-only
   * history that "survives everything except full folder loss", and a zip *is*
   * a full-folder event, so a bundle that carried only the recent sessions would
   * be the one export that loses history. `writeSessionsFile` enforces the
   * other half independently: it raises `SessionsShrinkError` rather than
   * truncate, and that error is allowed to propagate (see the test that pins
   * it).
   */
  sessions?: readonly SessionRecord[];
  /**
   * The project's coherence file, as text (coherence.md §3): `coherence.json` at the zip root, beside `caotang.json`. It
   * is the live file only; its `.bak.N` generations are recovery copies and stay out of the bundle, as the manifest's do.
   * Absent means the project has no findings file, and the bundle carries none.
   */
  coherence?: string;
  /**
   * The project's recurring tasks, as text (agent-harness.md §12): `tasks.json` at the zip root, beside `caotang.json`. Definitions only,
   * so a bundle carries what to do and when, and never when a task last ran or whether the writer let it start by itself. Its `.bak.N`
   * generations stay out, as the findings file's do. Absent means the project has none.
   */
  tasks?: string;
  /** Override the bundle filename stem. Defaults to `manifest.project.name`. */
  projectName?: string;
  /** Override the snapshot depth (tests). Defaults to {@link SNAPSHOT_COUNT}. */
  snapshotCount?: number;
  /** Line ending for files this writer creates. Bodies are never touched. */
  newline?: '\n' | '\r\n';
  /**
   * The project's image files, keyed by their project-relative path (`assets/a_XXXXXXXXXX.png`), carried into the bundle
   * byte-for-byte. The folder write does not own them: they live beside the document files and the caller holds the bytes.
   * A key outside `assets/` is refused, because an asset is the one binary file the bundle is defined to carry.
   */
  assets?: Readonly<Record<string, Uint8Array>>;
  /**
   * Who this bundle is for, which decides what it does with a file the load
   * declined because its bytes are not UTF-8 text — `write.ts`
   * `WriteOptions.copyFor`, and the same rule.
   *
   * A **`user`** bundle (the default) is the one the writer takes home, so it
   * refuses rather than leaving such a file out of it.
   *
   * An **`internal`** bundle is the one the app keeps for itself: the desktop's
   * safety bundle, which holds a browser's copy in memory so that a failed
   * adopt can put it back. It leaves the file out and says so in the report.
   */
  copyFor?: 'user' | 'internal';
}

export interface ExportZipResult {
  /** The archive. */
  bytes: Uint8Array;
  /** `<project-name>.caotang`, sanitized. */
  filename: string;
  /** Every path in the archive, sorted — what actually got zipped. */
  entries: string[];
  /** The assembled folder the archive was built from. */
  fs: MemoryArtifactFs;
  /** §4's snapshot rotation, for the caller's report. */
  rotated: string[];
  /** Manifest snapshots deliberately left out of the bundle — see below. */
  excluded: string[];
  /**
   * Files whose text this bundle does not carry, because the load declined them
   * and their bytes are not text, and which this bundle does not hold at all.
   * Only an `internal` bundle has any; a `user` bundle refuses instead of
   * making one.
   */
  omitted: string[];
  /**
   * Files this bundle holds as an empty shell in place of the author's text:
   * the load declined them because their bytes are not text, and a bundle that
   * left them out would name a document it does not hold.
   */
  emptied: string[];
}

/**
 * §7's ToC: `order — title — status — filename`, depth-first, one line per
 * node, indented by depth.
 *
 * It exists because of §1's cost note — "filenames are meaningless to humans" —
 * and it is the whole answer to that cost for anyone opening the folder without
 * Caotang. Folders carry no filename, so their line ends in an em-dash; a
 * body node's is its body file: `docs/<id>.md`, or `.fountain` / `.ink` by kind (paths.ts `bodyFile`).
 *
 * Generated from the **state**, not by re-walking the filesystem, so it cannot
 * describe a document the manifest does not own.
 */
export function buildToc(state: ProjectState, projectName?: string): string {
  const byParent = new Map<string | null, typeof state.manifest.tree>();
  for (const node of state.manifest.tree) {
    const siblings = byParent.get(node.parentId) ?? [];
    siblings.push(node);
    byParent.set(node.parentId, siblings);
  }
  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }

  const lines: string[] = [];
  if (projectName) lines.push(`# ${projectName}`, '');

  const walk = (parentId: string | null, depth: number): void => {
    for (const node of byParent.get(parentId) ?? []) {
      const indent = '  '.repeat(depth);
      const status = node.status ?? '—';
      const file = isBodyType(node.type) ? bodyFile(node) : '—';
      lines.push(`${indent}${node.order} — ${node.title} — ${status} — ${file}`);
      walk(node.id, depth + 1);
    }
  };
  walk('root', 0);

  return `${lines.join('\n')}\n`;
}

/**
 * A filename-safe stem for the project name.
 *
 * §7 puts `<project-name>` in a filename, and `project.name` is free text
 * (§2 constrains its length, not its characters). A name carrying a slash or a
 * drive letter would write outside the download directory, so the stem is
 * reduced to characters that are legal in a filename on every platform Caotang
 * targets, and a name that reduces to nothing falls back to the project id.
 */
export function bundleStem(name: string, projectId: string): string {
  let cleaned = name
    // The class is control characters and `no-control-regex` flags the escapes
    // exactly as it flags the literal bytes — measured, both forms, ESLint
    // 10.11.0, docs/decisions.md. It is a true positive, so the
    // suppression stays and says why; the alternative spellings that silence it
    // are recorded in the same entry. The regex is
    // written in escapes, because the literal-byte spelling made this whole
    // file binary-classified and therefore invisible to `rg` and to the Grep
    // tool — see test/searchable-sources.test.ts.
    //
    // What the rule actually *reports*, which
    // the lines above do not say: it names only `\x00, \x1f`, and a class of
    // `\u007f` alone is clean in both spellings. So the suppression is justified
    // by the C0 members alone, and **DEL is in this class on no lint's
    // authority** — nothing in the lint layer can see it missing, because a
    // class without it produces the identical message. DEL is pinned by
    // `zip.test.ts` and by nothing else. Both claims above re-measured on ESLint
    // 10.12.0 and still true, which is why they stand.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  cleaned = trimDotsAndSpace(cleaned).slice(0, 80).trim();
  return cleaned === '' ? projectId : cleaned;
}

/**
 * Strips leading and trailing dots and whitespace. A scan, not
 * `/^[.\s]+|[.\s]+$/g` — that regex is quadratic on a long run of dots and
 * spaces followed by anything else.
 */
function trimDotsAndSpace(text: string): string {
  const isTrim = (ch: string): boolean => ch === '.' || ch.trim() === '';
  let start = 0;
  let end = text.length;
  while (start < end && isTrim(text[start]!)) start++;
  while (end > start && isTrim(text[end - 1]!)) end--;
  return text.slice(start, end);
}

export function bundleFilename(name: string, projectId: string): string {
  return `${bundleStem(name, projectId)}${BUNDLE_EXTENSION}`;
}

/**
 * Is this path one of §5's manifest snapshot generations?
 *
 * A bundle must never carry them. They are the recovery ladder for a folder
 * someone is *actively editing*; shipping them in a hand-off file would put a
 * writer's abandoned drafts into the artefact they send to someone else. The
 * current manifest is always in the bundle, so nothing the ladder could recover
 * is lost from the project itself — only the ability to walk *back* to a draft
 * the writer has already replaced, which is local to their machine.
 *
 * This is a filter over the assembled file set rather than a `remove` loop, and
 * that is deliberate: {@link exportProjectZip} assembles into a **fresh**
 * `MemoryArtifactFs`, so `writeProject` finds no previous manifest to rotate
 * and no `caotang.json.bak.N` is ever created here. A `remove` loop would have
 * been unreachable code that *looked* like a guarantee. Filtering is not
 * unreachable — it holds whatever the write path does in future, including a
 * resumed folder or a `writeProject` that gains a "seed from existing" mode.
 */
export function isRecoverySnapshot(path: string): boolean {
  return /^caotang\.json\.bak\.\d+$/.test(path);
}

/**
 * Export the project as a portable zip.
 *
 * §7's "export is lossless both ways" is the contract, and it is met by
 * composition rather than by care: the folder is produced by the ordinary write
 * path, so anything that write path knows how to serialize is in the bundle for
 * free, and anything it does not is a bug in one place instead of two.
 */
export async function exportProjectZip(
  state: ProjectState,
  options: ExportZipOptions = {},
): Promise<ExportZipResult> {
  const now = options.now ?? new Date();
  const fs = new MemoryArtifactFs();
  // The bundle is written from a copy. `writeProject` stamps `project.modifiedAt` on the state it writes from, and the state an export
  // is given is the open project's own: stamping it would make the next save write caotang.json for an edit nobody made.
  const report = await writeProject(fs, cloneProjectState(state), {
    now,
    snapshotCount: options.snapshotCount,
    newline: options.newline,
    copyFor: options.copyFor,
  });

  // The assets go in before the snapshot is taken, so they are archived with the rest of the folder. Only `assets/` is
  // accepted: the bundle carries binary files by this route and no other.
  for (const [path, bytes] of Object.entries(options.assets ?? {})) {
    if (!path.startsWith(`${ASSETS_DIR}/`) || path.split('/').some((segment) => segment === '..')) {
      throw new Error(`a bundle carries only ${ASSETS_DIR}/ files as binary, so "${path}" is not written into it`);
    }
    await fs.writeBytesAtomic(path, bytes);
  }

  // §7's ToC. It lives in `exports/` — outside the tree, so it is never a
  // document — and it is generated *after* the write so `order` and the
  // document set are the ones the bundle actually carries.
  const projectName = options.projectName ?? state.manifest.project.name;
  await fs.writeAtomic(`${EXPORTS_DIR}/ToC.md`, buildToc(state, projectName));

  // §4's log projection, in full. Allowed to throw `SessionsShrinkError` rather
  // than truncate: a caller that hands a short log to a project whose file
  // already holds more lines has found the one case where the bundle would
  // quietly delete history, and the refusal is the only thing that stops it.
  if (options.sessions !== undefined) {
    await writeSessionsFile(fs, options.sessions, { newline: options.newline });
  }

  // The findings file rides at the root, beside `caotang.json` (coherence.md §3). It is written as the module serialised it,
  // so a bundle round-trips the bytes the writer's own save would have written.
  if (options.coherence !== undefined) {
    await fs.writeAtomic(COHERENCE_FILE_NAME, options.coherence);
  }
  if (options.tasks !== undefined) {
    await fs.writeAtomic(TASKS_FILE_NAME, options.tasks);
  }

  // Text and binary are read apart, because the text view is typed as strings and a binary file is carried as its bytes.
  // A binary file (an export's bytes, or an asset) goes into the archive as it is; a text one is encoded.
  const text = fs.snapshot();
  const binary = fs.snapshotBytes();
  const paths = [...new Set([...Object.keys(text), ...Object.keys(binary)])].sort();
  const files: Record<string, Uint8Array> = {};
  const excluded: string[] = [];
  for (const path of paths) {
    if (isRecoverySnapshot(path)) {
      excluded.push(path);
      continue;
    }
    const bytes = binary[path];
    files[path] = bytes ?? encoder.encode(text[path] ?? '');
  }

  // `mtime` is pinned rather than left to the library default so that exporting
  // an unchanged project twice produces the same bytes — the same
  // byte-stability the folder write already has, carried across the archive
  // boundary. Verified by a test that would fail if the pin were dropped.
  const { zipSync } = await loadZipEngine();
  const bytes = zipSync(files, { mtime: now });

  return {
    bytes,
    filename: bundleFilename(projectName, state.manifest.project.id),
    entries: paths.filter((path) => !isRecoverySnapshot(path)),
    fs,
    rotated: report.rotated,
    excluded,
    omitted: report.omitted ?? [],
    emptied: report.emptied ?? [],
  };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** A zip entry that is not safe to write into a project root. */
export class UnsafeZipEntryError extends Error {
  constructor(
    readonly entry: string,
    reason: string,
  ) {
    super(`refusing zip entry "${entry}": ${reason}`);
    this.name = 'UnsafeZipEntryError';
  }
}

/**
 * §7's "`caotang.json` at zip-root (never nested under a directory)".
 *
 * Refused rather than unwrapped. The alternative — accept
 * `MyProject/caotang.json` and strip the prefix — is what a *reader* would want,
 * but §1's rule that the layout is single and canonical is a statement about
 * what Caotang writes, and silently accepting a nested layout means the importer
 * is now a second dialect too. The error names the fix, so a user who zipped a
 * folder by hand knows exactly what to do.
 */
export class NestedManifestError extends Error {
  constructor(readonly found: string) {
    super(
      `this archive has no ${MANIFEST_FILE} at its root — found "${found}". ` +
        `${MANIFEST_FILE} sits at the zip-root, never under a directory: open the folder and zip its contents, not the folder itself.`,
    );
    this.name = 'NestedManifestError';
  }
}

export class MissingManifestError extends Error {
  constructor(readonly searched: readonly string[]) {
    super(
      `this archive has no ${MANIFEST_FILE} at its root, so it is not a Caotang bundle ` +
        `(looked for "${MANIFEST_FILE}" among ${searched.length} entries: ${searched.join(', ') || 'none'})`,
    );
    this.name = 'MissingManifestError';
  }
}

/** What {@link importProjectZip} hands back, before anything has read it. */
export interface ImportZipResult {
  /** The unzipped project folder. Feed it to `readProject` / `recoverProject`. */
  fs: MemoryArtifactFs;
  /** Every path written, sorted. */
  entries: string[];
  /**
   * The session log carried by the bundle, parsed. §8's "import creates a fresh
   * working copy" — this is what the caller seeds the runtime store with, and it
   * is why the exporter has to carry the log in full.
   */
  sessions: SessionRecord[];
  /** Lines in the bundle's log that no reader accepts. Counted, never silent. */
  sessionsSkipped: number;
  /**
   * The bundle's image files, by project-relative path (`assets/a_XXXXXXXXXX.png`), byte-for-byte. They are also in `fs`;
   * this is the same set as a map, which is what the project's asset store takes back on import (epub-metadata.md, cover).
   */
  assets: Record<string, Uint8Array>;
}

/**
 * Zip-slip guard.
 *
 * An archive is untrusted input and its entry names are attacker-chosen, so a
 * name that escapes the project root is refused rather than sanitised: there is
 * no version of "../" that means something legitimate inside a zip entry. Also
 * refuses absolute paths and Windows drive letters, because a bundle written on
 * one platform must be refused for the same reason on another.
 */
function assertSafeEntry(entry: string): void {
  if (entry === '' || entry.endsWith('/')) return; // directory entry
  // A skill's files get the stricter rules a skill folder has (a backslash, an empty segment and a control character are refused too).
  if (entry.startsWith(`${SKILLS_DIR}/`)) {
    const problem = skillPathProblem(entry.slice(SKILLS_DIR.length + 1));
    if (problem !== undefined) throw new UnsafeZipEntryError(entry, problem);
  }
  if (entry.startsWith('/')) {
    throw new UnsafeZipEntryError(entry, 'absolute paths are not project-relative');
  }
  if (/^[A-Za-z]:/.test(entry)) {
    throw new UnsafeZipEntryError(entry, 'a drive letter is not a project-relative path');
  }
  if (entry.split('/').some((segment) => segment === '..')) {
    throw new UnsafeZipEntryError(entry, 'the path escapes the project root');
  }
}

/**
 * Import a zip bundle into a fresh working copy (§8).
 *
 * Returns the **unread** folder rather than a loaded `ProjectState`, because the
 * load has three legitimate answers — clean, migrated, or recovered — and
 * collapsing them here would take that choice away from the caller. §5's ladder
 * is the interesting case: a bundle whose `caotang.json` is corrupt is exactly the
 * situation the ladder exists for, and it is reachable here because the folder
 * is handed back rather than forced through one loader.
 */
export async function importProjectZip(bytes: Uint8Array): Promise<ImportZipResult> {
  const { unzipSync } = await loadZipEngine();
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (cause) {
    // The writer reads this line, so it names the file, not the archive format. The engine's own reason
    // (`invalid zip data`) stays on `cause` for a developer, and is not shown.
    throw new Error('This file is not a Caotang bundle.', { cause });
  }

  const names = Object.keys(entries).sort();
  for (const name of names) {
    assertSafeEntry(name);
  }

  if (!Object.prototype.hasOwnProperty.call(entries, MANIFEST_FILE)) {
    // A nested manifest is a different mistake from a missing one, and the fix
    // differs, so it gets its own error rather than a generic "not a bundle".
    const nested = names.find((name) => name.endsWith(`/${MANIFEST_FILE}`));
    if (nested) throw new NestedManifestError(nested);
    throw new MissingManifestError(names);
  }

  const fs = new MemoryArtifactFs();
  const assets: Record<string, Uint8Array> = {};
  for (const name of names) {
    if (name.endsWith('/')) continue; // directory entry: the files carry the shape
    const contents = entries[name];
    if (contents === undefined) continue;
    if (name === SESSIONS_FILE) continue; // projected through writeSessionsFile below
    // An asset is an image, so it is written as its bytes whatever they happen to decode to.
    const isAsset = name.startsWith(`${ASSETS_DIR}/`);
    if (isAsset) assets[name] = contents.slice();
    const text = isAsset ? undefined : textOf(contents);
    if (text !== undefined) await fs.writeAtomic(name, text);
    else await fs.writeBytesAtomic(name, contents);
  }

  // The log goes back through the one writer that owns it, so an import cannot
  // introduce a `sessions.jsonl` no reader would accept. But the import is a copy:
  // the bytes it was given are the bytes it keeps. The file is written verbatim
  // first — a damaged line and a hand-written key order included — and the
  // projection then finds it already holds these records and appends nothing.
  // Projecting the parsed records into the empty folder instead dropped every line
  // it could not read, which is the loss the projection's rule 1 exists to prevent.
  const raw = entries[SESSIONS_FILE];
  const parsed = parseSessionsLog(raw ? decoder.decode(raw) : '');
  if (raw !== undefined) {
    const text = textOf(raw);
    if (text !== undefined) {
      await fs.writeAtomic(SESSIONS_FILE, text);
      await writeSessionsFile(fs, parsed.records, {});
    } else {
      // A binary log has no lines the projection can read or verify, so the bytes
      // are kept as they are and the projection is not run over them.
      await fs.writeBytesAtomic(SESSIONS_FILE, raw);
    }
  }

  return {
    fs,
    entries: names.filter((name) => !name.endsWith('/')),
    sessions: parsed.records,
    sessionsSkipped: parsed.skipped,
    assets,
  };
}

/** Re-exported so a caller can stage a directory write without importing paths. */
export { CODEX_DIR, DOCS_DIR, EXPORTS_DIR, GITIGNORE_FILE, MANIFEST_FILE, SESSIONS_FILE };
export type { ArtifactFs, LoadResult };
