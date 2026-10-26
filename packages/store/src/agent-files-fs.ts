/**
 * The agent files on disk — [project-format.md §1](docs/architecture/project-format.md), [context-assembly.md §2](docs/architecture/context-assembly.md) (LI).
 *
 * `CAOTANG.md` and `memory/` ride the project like `.agents/skills/` does: the load reads them into `ProjectState.agentFiles`, a save writes
 * the files whose text the folder does not already hold, and removes only the files the writer forgot (`removedAgentFiles`). A project with none
 * writes none, so its folder is as it was before these files existed. A file whose bytes are not UTF-8 text is held back whole: the state has no
 * text for it, it stays on disk untouched, and no save writes over it.
 */

import { ArtifactNotFoundError, type ArtifactFs } from './artifact-fs.js';
import {
  INSTRUCTIONS_FALLBACK,
  INSTRUCTIONS_FILE,
  MEMORY_DIR,
  MEMORY_INDEX,
  agentFileTexts,
  hasAgentFiles,
  isAgentFilePath,
  memorySlugOfPath,
  parseAgentFiles,
  type AgentFiles,
  type ParsedAgentFiles,
} from './agent-files.js';

/** The paths of the agent files the folder holds, sorted. `AGENTS.md` only counts when `CAOTANG.md` is absent, since only then is it read. */
export async function listAgentFilePaths(fs: ArtifactFs): Promise<string[]> {
  const out: string[] = [];
  if (await fs.exists(INSTRUCTIONS_FILE)) out.push(INSTRUCTIONS_FILE);
  else if (await fs.exists(INSTRUCTIONS_FALLBACK)) out.push(INSTRUCTIONS_FALLBACK);
  if (await fs.exists(MEMORY_DIR)) {
    for (const name of await fs.listFiles(MEMORY_DIR)) {
      const path = `${MEMORY_DIR}/${name}`;
      if (path === MEMORY_INDEX || memorySlugOfPath(path) !== undefined) out.push(path);
    }
  }
  return out.sort();
}

/** A file's text, `undefined` when its bytes are not UTF-8 (held back), `null` when the folder does not hold it. */
async function readText(fs: ArtifactFs, path: string): Promise<string | undefined | null> {
  let bytes: Uint8Array;
  try {
    bytes = await fs.readBytes(path);
  } catch (cause) {
    if (cause instanceof ArtifactNotFoundError) return null;
    throw cause;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export interface ReadAgentFiles extends ParsedAgentFiles {
  /** The files held back for their bytes, with what each plausibly is (the load turns these into encoding issues). */
  readonly held: readonly { readonly path: string; readonly bytes: Uint8Array }[];
}

/** Reads the project's agent files. A folder with none gives the empty set. */
export async function readAgentFiles(fs: ArtifactFs): Promise<ReadAgentFiles> {
  const texts: Record<string, string> = {};
  const held: { path: string; bytes: Uint8Array }[] = [];
  for (const path of await listAgentFilePaths(fs)) {
    const text = await readText(fs, path);
    if (text === null) continue;
    if (text === undefined) {
      held.push({ path, bytes: await fs.readBytes(path) });
      continue;
    }
    texts[path] = text;
  }
  const parsed = parseAgentFiles(texts, held.map((file) => file.path));
  const notices = [
    ...parsed.notices,
    ...held.map((file) => ({
      path: file.path,
      message: `the agent file “${file.path}” is not UTF-8 text; it is left as it is and the agent does not see it`,
      say: `“${file.path}” is not UTF-8 text, so it was not opened and the agent does not see it. It is left as it is.`,
    })),
  ];
  return { files: parsed.files, notices, held };
}

export interface AgentFilesWrite {
  readonly guard: (path: string) => Promise<void>;
  readonly written: string[];
  readonly pruned: string[];
  readonly newline?: '\n' | '\r\n';
}

async function holdsText(fs: ArtifactFs, path: string, text: string): Promise<boolean> {
  try {
    return (await fs.read(path)) === text;
  } catch {
    return false;
  }
}

/** Whether the target holds `path` as something that is not UTF-8 text. Such a file is never written over. */
async function holdsNonText(fs: ArtifactFs, path: string): Promise<boolean> {
  return (await readText(fs, path)) === undefined;
}

/**
 * Writes the agent files whose text the folder does not already hold. `AGENTS.md` is read-only: it is written only into a target that has no
 * file by that name (a copy of the project), never over one. A file a target holds as non-UTF-8 text is left alone.
 */
export async function writeAgentFiles(fs: ArtifactFs, files: AgentFiles, out: AgentFilesWrite): Promise<void> {
  if (!hasAgentFiles(files)) return;
  const texts = agentFileTexts(files);
  for (const path of Object.keys(texts).sort()) {
    const raw = texts[path] as string;
    if (files.declined.has(path)) {
      // A declined topic file is the writer's as found: a target that has it keeps its bytes, and one that does not gets the text.
      if (await fs.exists(path)) continue;
    } else if (path === INSTRUCTIONS_FALLBACK) {
      if (await fs.exists(path)) continue;
    }
    const text = out.newline === '\r\n' && !files.declined.has(path) ? raw.replace(/\r?\n/g, '\r\n') : raw;
    if (await holdsText(fs, path, text)) continue;
    if (await holdsNonText(fs, path)) continue;
    await out.guard(path);
    if (path.startsWith(`${MEMORY_DIR}/`)) await fs.ensureDir(MEMORY_DIR);
    await fs.writeAtomic(path, text);
    out.written.push(path);
  }
}

/**
 * Removes the agent files the writer forgot or cleared. A path the state holds again (an undone forget) is not removed. The set is emptied of each
 * path handled, so the next save does not look at it again.
 */
export async function removeAgentFiles(fs: ArtifactFs, files: AgentFiles, removed: Set<string>, out: AgentFilesWrite): Promise<void> {
  const held = new Set(Object.keys(agentFileTexts(files)));
  for (const path of [...removed].sort()) {
    if (isAgentFilePath(path) && !held.has(path) && (await fs.exists(path)) && !(await holdsNonText(fs, path))) {
      await out.guard(path);
      try {
        await fs.remove(path);
        out.pruned.push(path);
      } catch (cause) {
        if (!(cause instanceof ArtifactNotFoundError)) throw cause;
      }
    }
    removed.delete(path);
  }
}
