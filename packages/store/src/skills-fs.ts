/**
 * A project's skills on disk — [project-format.md §1](docs/architecture/project-format.md), [extensibility.md §10](docs/architecture/extensibility.md).
 *
 * `.agents/skills/<folder>/` holds an Agent Skills folder: `SKILL.md` and the files beside it, to any depth. The load reads every file
 * as bytes and keeps them in `ProjectState.skills`; it does not parse them, so a skill that does not parse is carried all the same. A
 * save writes only the files whose bytes changed and removes only the files the writer removed. The caps and the path rules are the
 * skills package's (`SKILL_LIMITS`, `skillPathProblem`): a folder over a cap, or with a path that leaves it, is not taken, is named in a
 * notice, and is left on disk as it is.
 */

import { SKILL_FILE, SKILL_LIMITS, isSkillJunk, isSkillName, skillFilesProblem, skillPathProblem, textOfBytes, type SkillFile } from '@caotang/skills';

import { ArtifactNotFoundError, joinPath, type ArtifactFs } from './artifact-fs.js';
import { SKILLS_DIR, skillFilePath } from './paths.js';

/** How deep a skill folder is read. Real skills are two levels (`references/x.md`); more is a folder that is not a skill. */
const MAX_DEPTH = 8;

export interface SkillsNotice {
  /** The skill folder's project path. */
  readonly path: string;
  readonly message: string;
  readonly say: string;
}

export interface ReadSkills {
  readonly skills: Map<string, SkillFile[]>;
  readonly notices: SkillsNotice[];
}

/** Every file under `dir`, as paths relative to `base`, skipping what an operating system leaves behind. Stops past `limit` files. */
async function listTree(fs: ArtifactFs, base: string, dir: string, depth: number, out: string[], limit: number): Promise<boolean> {
  const here = dir === '' ? base : joinPath(base, dir);
  for (const name of (await fs.listFiles(here)).sort()) {
    if (isSkillJunk(name)) continue;
    out.push(dir === '' ? name : `${dir}/${name}`);
    if (out.length > limit) return false;
  }
  if (depth >= MAX_DEPTH) return true;
  for (const name of (await fs.listDirs(here)).sort()) {
    const next = dir === '' ? name : `${dir}/${name}`;
    if (!(await listTree(fs, base, next, depth + 1, out, limit))) return false;
  }
  return true;
}

/**
 * The project paths of every skill file the folder holds, whether or not the load took its skill: the files a save must not overwrite
 * unseen, so the folder-save check counts them (folder-digests.ts).
 */
export async function listSkillFilePaths(fs: ArtifactFs): Promise<string[]> {
  if (!(await fs.exists(SKILLS_DIR))) return [];
  const out: string[] = [];
  for (const folder of await fs.listDirs(SKILLS_DIR)) {
    if (!isSkillName(folder)) continue;
    const paths: string[] = [];
    // Past the cap the rest is not listed: the load did not take the folder, and no save writes into it.
    await listTree(fs, `${SKILLS_DIR}/${folder}`, '', 0, paths, SKILL_LIMITS.maxFilesPerSkill);
    for (const path of paths) out.push(skillFilePath(folder, path));
  }
  return out;
}

/** Whether `path` is a file of a skill: `.agents/skills/<folder>/<file>`, with a skill name and a path that stays in the folder. */
export function isSkillFilePath(path: string): boolean {
  const prefix = `${SKILLS_DIR}/`;
  if (!path.startsWith(prefix)) return false;
  const rest = path.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return false;
  return isSkillName(rest.slice(0, slash)) && skillPathProblem(rest.slice(slash + 1)) === undefined;
}

/** Reads one skill folder's files, or says why it is not taken. */
async function readFolder(fs: ArtifactFs, folder: string): Promise<{ files: SkillFile[] } | { problem: string } | undefined> {
  const base = `${SKILLS_DIR}/${folder}`;
  const paths: string[] = [];
  // A folder with one file over the file cap is read to its end, so the problem names the right file.
  const complete = await listTree(fs, base, '', 0, paths, SKILL_LIMITS.maxFilesPerSkill + 1);
  if (!paths.includes(SKILL_FILE)) return undefined;
  if (!complete) return { problem: `the skill “${folder}” has more than ${SKILL_LIMITS.maxFilesPerSkill} files, and a skill may have at most ${SKILL_LIMITS.maxFilesPerSkill}.` };
  const files: SkillFile[] = [];
  let total = 0;
  for (const path of paths.sort()) {
    const bad = skillPathProblem(path);
    if (bad !== undefined) return { problem: `“${path}” in the skill “${folder}” cannot be taken: ${bad}.` };
    const bytes = await fs.readBytes(skillFilePath(folder, path));
    total += bytes.length;
    files.push({ path, bytes });
    // Stop reading a folder that is already over its cap: the problem is the same however much more is read.
    if (bytes.length > SKILL_LIMITS.maxFileBytes || total > SKILL_LIMITS.maxSkillBytes) break;
  }
  const problem = skillFilesProblem(folder, files);
  return problem === undefined ? { files } : { problem: problem.message };
}

/**
 * Reads the project's skills. A project with no `.agents/skills/` has none. Past {@link SKILL_LIMITS.maxSkills} folders the rest are not
 * taken; a folder with no `SKILL.md` is not a skill and is ignored; a name that is not a skill name is left alone, since a skill by
 * that name could never be offered.
 */
export async function readSkills(fs: ArtifactFs): Promise<ReadSkills> {
  const skills = new Map<string, SkillFile[]>();
  const notices: SkillsNotice[] = [];
  if (!(await fs.exists(SKILLS_DIR))) return { skills, notices };
  const folders = (await fs.listDirs(SKILLS_DIR)).sort();
  for (const folder of folders) {
    if (!isSkillName(folder)) continue;
    const path = `${SKILLS_DIR}/${folder}`;
    if (skills.size >= SKILL_LIMITS.maxSkills) {
      notices.push({
        path,
        message: `the project holds more than ${SKILL_LIMITS.maxSkills} skills, so the skill “${folder}” was not taken and is left as it is`,
        say: `A project can hold at most ${SKILL_LIMITS.maxSkills} skills, so the skill “${folder}” was not opened. Its files are left as they are.`,
      });
      continue;
    }
    const read = await readFolder(fs, folder);
    if (read === undefined) continue;
    if ('problem' in read) {
      notices.push({
        path,
        message: `${read.problem} It was not taken and is left as it is`,
        say: `${read.problem.charAt(0).toUpperCase()}${read.problem.slice(1)} It was not opened, and its files are left as they are.`,
      });
      continue;
    }
    skills.set(folder, read.files);
  }
  return { skills, notices };
}

const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, index) => byte === b[index]);

/** Whether `path` already holds exactly `bytes`. A file that cannot be read is not held, so the writer writes it. */
async function holdsBytes(fs: ArtifactFs, path: string, bytes: Uint8Array): Promise<boolean> {
  try {
    return same(await fs.readBytes(path), bytes);
  } catch {
    return false;
  }
}

export interface SkillsWrite {
  readonly guard: (path: string) => Promise<void>;
  readonly written: string[];
  readonly pruned: string[];
}

/** Writes the skill files whose bytes the folder does not already hold. A text file is written as text, so any file system keeps it so. */
export async function writeSkillFiles(fs: ArtifactFs, skills: ReadonlyMap<string, readonly SkillFile[]>, out: SkillsWrite): Promise<void> {
  for (const [folder, files] of skills) {
    for (const file of files) {
      const path = skillFilePath(folder, file.path);
      if (await holdsBytes(fs, path, file.bytes)) continue;
      await out.guard(path);
      const slash = path.lastIndexOf('/');
      await fs.ensureDir(path.slice(0, slash));
      const text = textOfBytes(file.bytes);
      if (text === undefined) await fs.writeBytesAtomic(path, file.bytes);
      else await fs.writeAtomic(path, text);
      out.written.push(path);
    }
  }
}

/**
 * Removes the skill files the writer removed. A path a skill holds again (an undone delete) is not removed. The set is emptied of each
 * path handled, so the next save does not look at it again.
 */
export async function removeSkillFiles(
  fs: ArtifactFs,
  skills: ReadonlyMap<string, readonly SkillFile[]>,
  removed: Set<string>,
  out: SkillsWrite,
): Promise<void> {
  const held = new Set<string>();
  for (const [folder, files] of skills) for (const file of files) held.add(skillFilePath(folder, file.path));
  for (const path of [...removed].sort()) {
    if (!held.has(path) && (await fs.exists(path))) {
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
