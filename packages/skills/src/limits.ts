/**
 * The caps and the path rules every way into a project's skills shares — a folder load, an import, a bundle import and the `skill.*`
 * commands (extensibility.md §10). A skill is text the model will read, so a folder the app has to hold is bounded, and a path that
 * leaves the skill's folder is refused rather than cleaned.
 */

import type { SkillFile, SkillName } from './types.js';

export const SKILL_LIMITS = {
  /** Skills in one project. */
  maxSkills: 50,
  /** Files in one skill folder. */
  maxFilesPerSkill: 64,
  /** Bytes in one file. */
  maxFileBytes: 256 * 1024,
  /** Bytes in one skill folder, all files together. */
  maxSkillBytes: 2 * 1024 * 1024,
  /** A skill's name. */
  maxNameChars: 64,
  /** The spec's description limit. */
  maxDescriptionChars: 1024,
  /** The spec's compatibility limit. */
  maxCompatibilityChars: 500,
} as const;

/** The file every skill has. */
export const SKILL_FILE = 'SKILL.md';

/** The folder a skill's scripts live in. Caotang lists them, shows them on the review card and never runs them. */
export const SKILL_SCRIPTS_DIR = 'scripts';

/** Files an operating system leaves in a folder; they are not part of a skill and are not carried. */
const OS_JUNK: ReadonlySet<string> = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/** Whether a file name is operating-system litter rather than a file of the skill. */
export function isSkillJunk(name: string): boolean {
  return OS_JUNK.has(name);
}

const isNameChar = (code: number): boolean => (code >= 97 && code <= 122) || (code >= 48 && code <= 57);

/** Whether `name` is a valid skill name: 1 to 64 lower-case letters, digits and hyphens, with no hyphen at either end. */
export function isSkillName(name: string): name is SkillName {
  if (name.length === 0 || name.length > SKILL_LIMITS.maxNameChars) return false;
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i);
    if (isNameChar(code)) continue;
    if (code === 45 && i > 0 && i < name.length - 1) continue;
    return false;
  }
  return true;
}

/**
 * Why `path` cannot be a file inside a skill folder, or `undefined` when it can. The path is relative to the folder: no leading slash,
 * no drive letter, no backslash, no `.` or `..` segment, no empty segment, no control character.
 */
export function skillPathProblem(path: string): string | undefined {
  if (path === '') return 'the path is empty';
  if (path.startsWith('/')) return 'the path is absolute';
  if (path.length >= 2 && path.charCodeAt(1) === 58) return 'the path starts with a drive letter';
  if (path.includes('\\')) return 'the path has a backslash';
  for (let i = 0; i < path.length; i += 1) {
    if (path.charCodeAt(i) < 32 || path.charCodeAt(i) === 127) return 'the path has a control character';
  }
  for (const segment of path.split('/')) {
    if (segment === '') return 'the path has an empty segment';
    if (segment === '.' || segment === '..') return 'the path leaves the skill folder';
  }
  return undefined;
}

/** A refusal of a set of files, in words, with the cap it names. */
export interface SkillFilesProblem {
  readonly code: 'bad_path' | 'duplicate_path' | 'no_skill_md' | 'too_many_files' | 'file_too_large' | 'skill_too_large';
  readonly message: string;
}

/** A size in words: KB under a megabyte and MB above, rounded up to a tenth so a size over a cap never reads as equal to it. */
export function sizeInWords(bytes: number): string {
  const unit = bytes >= 1024 * 1024 ? 1024 * 1024 : 1024;
  const tenths = Math.ceil((bytes / unit) * 10) / 10;
  return `${Number.isInteger(tenths) ? tenths : tenths.toFixed(1)} ${unit === 1024 ? 'KB' : 'MB'}`;
}

/**
 * The first reason a skill folder's files cannot be taken, or `undefined`. It checks the paths, that `SKILL.md` is there, and the
 * three caps, and names the cap it hit, so the writer is told what to cut.
 */
export function skillFilesProblem(folder: string, files: readonly SkillFile[]): SkillFilesProblem | undefined {
  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    const bad = skillPathProblem(file.path);
    if (bad !== undefined) return { code: 'bad_path', message: `“${file.path}” in the skill “${folder}” cannot be taken: ${bad}.` };
    if (seen.has(file.path)) return { code: 'duplicate_path', message: `the skill “${folder}” holds “${file.path}” twice.` };
    seen.add(file.path);
    if (file.bytes.length > SKILL_LIMITS.maxFileBytes) {
      return {
        code: 'file_too_large',
        message: `“${file.path}” in the skill “${folder}” is ${sizeInWords(file.bytes.length)}, and a skill file may be at most ${sizeInWords(SKILL_LIMITS.maxFileBytes)}.`,
      };
    }
    total += file.bytes.length;
  }
  if (!seen.has(SKILL_FILE)) return { code: 'no_skill_md', message: `the skill “${folder}” has no ${SKILL_FILE}.` };
  if (files.length > SKILL_LIMITS.maxFilesPerSkill) {
    return { code: 'too_many_files', message: `the skill “${folder}” has ${files.length} files, and a skill may have at most ${SKILL_LIMITS.maxFilesPerSkill}.` };
  }
  if (total > SKILL_LIMITS.maxSkillBytes) {
    return { code: 'skill_too_large', message: `the skill “${folder}” is ${sizeInWords(total)} in all, and a skill may be at most ${sizeInWords(SKILL_LIMITS.maxSkillBytes)}.` };
  }
  return undefined;
}
