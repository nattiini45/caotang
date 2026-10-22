/**
 * The digests a folder save checks against — project-format §4, and the save guard of the Caotang MCP server and of the desktop's Save to folder.
 *
 * A project folder can be written by more than one program: the desktop, the Caotang MCP server, and anything else that opens the folder. So a
 * writer keeps a SHA-256 digest of every project file it may write or remove, and checks the folder against those digests before it saves
 * ({@link driftOf}), and again just before it writes each file (`writeProject`'s `expectedDigests`). The project files are the document
 * bodies (`docs/<id>.<ext>`) and the codex redundancy files (`codex/c_<id>.md`). The manifest has its own check, since its text is the one a
 * save replaces.
 *
 * Digests are taken over the file's bytes, so a file another program re-encoded is a change even when its text reads the same.
 */

import { isIdWithPrefix } from '@caotang/ids';

import { ArtifactNotFoundError, type ArtifactFs } from './artifact-fs.js';
import { CODEX_DIR, DOCS_DIR, bodyStemOf, isBodyFileName, isBodyType } from './paths.js';
import { isSkillFilePath, listSkillFilePaths } from './skills-fs.js';
import { SKILLS_DIR } from './paths.js';
import type { ProjectState } from './state.js';

/**
 * Reads the digest of one project file, or `undefined` when the folder does not hold it. {@link digestOfFile} reads it once; a caller whose
 * file system can report a brief hold by another program (the MCP server's, on Windows) passes a reader that retries one.
 */
export type DigestReader = (path: string) => Promise<string | undefined>;

/** The SHA-256 of `bytes`, as lowercase hex. */
export async function digestOfBytes(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Whether `path` is a project file: a document body whose stem is a document id, a codex redundancy file whose stem is a codex id, or a file of
 * a skill (`.agents/skills/<name>/…`). Anything else in `docs/` or `codex/` is the author's, and no save writes or removes it (project-format §1).
 */
export function isProjectFile(path: string): boolean {
  if (isSkillFilePath(path)) return true;
  const slash = path.lastIndexOf('/');
  if (slash < 0) return false;
  const dir = path.slice(0, slash);
  const name = path.slice(slash + 1);
  if (dir === DOCS_DIR) return isBodyFileName(name) && isIdWithPrefix('n', bodyStemOf(name));
  if (dir === CODEX_DIR) return name.endsWith('.md') && isIdWithPrefix('c', name.slice(0, -3));
  return false;
}

/** The paths of the project files in `fs`, sorted. */
export async function projectFilePaths(fs: ArtifactFs): Promise<string[]> {
  const documents = (await fs.listFiles(DOCS_DIR))
    .filter((name) => isBodyFileName(name) && isIdWithPrefix('n', bodyStemOf(name)))
    .map((name) => `${DOCS_DIR}/${name}`);
  const codex = (await fs.listFiles(CODEX_DIR))
    .filter((name) => name.endsWith('.md') && isIdWithPrefix('c', name.slice(0, -3)))
    .map((name) => `${CODEX_DIR}/${name}`);
  return [...documents, ...codex, ...(await listSkillFilePaths(fs))].sort();
}

/** The codes a file system reports for a brief hold by another program (a sync client, or the Caotang MCP server, on Windows). */
const TRANSIENT_CODES: ReadonlySet<string> = new Set(['EBUSY', 'EPERM', 'EACCES']);

/** How many times a digest read tries a file another program briefly holds, before the error is passed on. */
const DIGEST_ATTEMPTS = 6;

/** Whether an error is a transient sharing error, the kind a read of a file another program holds can fail with. */
export function isTransientFileError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return TRANSIENT_CODES.has(String(error.code));
}

/**
 * The digest of one file, or `undefined` when the folder does not hold it. A transient sharing error is retried a few times with a short
 * pause, so another program's brief hold on a file is not read as a change or as a failed save. Any other read failure is thrown,
 * and so is a transient one that outlasts the retries.
 */
export async function digestOfFile(fs: ArtifactFs, path: string): Promise<string | undefined> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await digestOfBytes(await fs.readBytes(path));
    } catch (error) {
      if (error instanceof ArtifactNotFoundError) return undefined;
      if (!isTransientFileError(error) || attempt >= DIGEST_ATTEMPTS) throw error;
      await new Promise((done) => setTimeout(done, 25 * attempt));
    }
  }
}

/** The digest of every project file in `fs`, by path, each read through `read` (by default {@link digestOfFile}). */
export async function projectFileDigests(fs: ArtifactFs, read: DigestReader = (path) => digestOfFile(fs, path)): Promise<Map<string, string>> {
  const digests = new Map<string, string>();
  for (const path of await projectFilePaths(fs)) {
    const digest = await read(path);
    if (digest !== undefined) digests.set(path, digest);
  }
  return digests;
}

/** What differs between the digests a writer holds and what a folder holds now, by path, each list sorted. */
export interface FolderDrift {
  /** A file the writer holds whose bytes are not the bytes it held. */
  readonly changed: string[];
  /** A file the writer holds that the folder no longer has. */
  readonly removed: string[];
  /** A project file the folder has that the writer does not hold: one a program added. */
  readonly added: string[];
}

/** The difference between the digests a writer holds and the folder's current ones. An empty result means the folder is as the writer left it. */
export function driftOf(held: ReadonlyMap<string, string>, now: ReadonlyMap<string, string>): FolderDrift {
  const changed: string[] = [];
  const removed: string[] = [];
  const added: string[] = [];
  for (const [path, digest] of held) {
    const current = now.get(path);
    if (current === undefined) removed.push(path);
    else if (current !== digest) changed.push(path);
  }
  for (const path of now.keys()) {
    if (!held.has(path)) added.push(path);
  }
  return { changed: changed.sort(), removed: removed.sort(), added: added.sort() };
}

/** Whether a drift names any file at all. */
export function hasDrift(drift: FolderDrift): boolean {
  return drift.changed.length > 0 || drift.removed.length > 0 || drift.added.length > 0;
}

/**
 * The digests a writer holds after a write it made: the digests it held before, with each project file the write named digested again, and
 * each file the write removed dropped. A file the write did not name keeps the digest it had, so a change another program made to it during
 * the write is still a change at the next save. Only the paths in `report` are read again.
 */
export async function digestsAfterWrite(
  fs: ArtifactFs,
  held: ReadonlyMap<string, string>,
  report: { readonly written: readonly string[]; readonly pruned: readonly string[] },
  read: DigestReader = (path) => digestOfFile(fs, path),
): Promise<Map<string, string>> {
  const next = new Map(held);
  for (const path of report.written) {
    if (!isProjectFile(path)) continue;
    const digest = await read(path);
    if (digest === undefined) next.delete(path);
    else next.set(path, digest);
  }
  for (const path of report.pruned) next.delete(path);
  return next;
}

/**
 * The titles a state holds for its project files, by the id each file's name carries: a document's (or dialogue container's) title, and a
 * codex entry's name. A refusal names a changed file by these, so no node id and no file name reaches the writer.
 */
export function projectFileTitles(state: ProjectState): Map<string, string> {
  const titles = new Map<string, string>();
  for (const node of state.manifest.tree) {
    if (isBodyType(node.type)) titles.set(node.id, node.title);
  }
  for (const entry of state.manifest.codex ?? []) titles.set(entry.id, entry.name);
  return titles;
}

/** One project file another program changed, removed or added, in words. */
export interface ProjectFileChange {
  /** The file in words: `the document “The Landing”`, `the codex entry “Elena Voss”`, or a description when the writer does not hold it. */
  readonly label: string;
  /** What the other program did to it. */
  readonly change: 'changed' | 'removed' | 'added';
}

/**
 * A project file in words: `the document “The Landing”` or `the codex entry “Elena Voss”`. The title is the one in `current`, or else the one
 * in `held` (the titles the writer held when it last loaded or saved, so a document it deleted since is still named). A file neither names is
 * described with `holder`, the writer's own name for itself: `a document this copy does not hold`.
 */
export function projectFileLabel(
  path: string,
  current: ReadonlyMap<string, string>,
  held: ReadonlyMap<string, string>,
  holder: string,
): string {
  if (isSkillFilePath(path)) return `the skill “${path.slice(SKILLS_DIR.length + 1, path.indexOf('/', SKILLS_DIR.length + 1))}”`;
  const id = path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
  const title = current.get(id) ?? held.get(id);
  const codex = path.startsWith(`${CODEX_DIR}/`);
  if (title === undefined) return codex ? `a codex entry ${holder} does not hold` : `a document ${holder} does not hold`;
  return codex ? `the codex entry “${title}”` : `the document “${title}”`;
}

/**
 * The changes a drift names, in words, in the order a refusal lists them: changed, removed, then added. Titles come from `state` now, or else
 * from `heldTitles` ({@link projectFileLabel}).
 */
export function projectFileChanges(
  drift: FolderDrift,
  state: ProjectState,
  heldTitles: ReadonlyMap<string, string>,
  holder: string,
): ProjectFileChange[] {
  const current = projectFileTitles(state);
  const label = (path: string): string => projectFileLabel(path, current, heldTitles, holder);
  const all = [
    ...drift.changed.map((path) => ({ label: label(path), change: 'changed' as const })),
    ...drift.removed.map((path) => ({ label: label(path), change: 'removed' as const })),
    ...drift.added.map((path) => ({ label: label(path), change: 'added' as const })),
  ];
  // A skill is several files, and the writer is told about the skill once.
  return all.filter((item, index) => all.findIndex((other) => other.label === item.label && other.change === item.change) === index);
}

/** Items joined for a sentence: `a`, `a and b`, `a, b and c`. */
export function joinWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * What another program did, in one sentence's words, from a drift: each file changed, removed or added, named by {@link projectFileLabel}.
 * The desktop's folder question and the MCP server's refusals both say a change this way, so the words are one function.
 */
export function changesInWords(
  drift: FolderDrift,
  state: ProjectState,
  heldTitles: ReadonlyMap<string, string>,
  holder: string,
): string {
  return joinWords(projectFileChanges(drift, state, heldTitles, holder).map(({ change, label }) => `${change} ${label}`));
}
