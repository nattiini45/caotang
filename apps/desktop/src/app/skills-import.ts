/**
 * Taking skills into a project from files the writer picked: a folder, or a zip ([extensibility.md §10](../../../../docs/architecture/extensibility.md)).
 *
 * Nothing here is fetched or run. The picked files are read as bytes, the skills among them are found and checked against the caps and the
 * path rules before any byte is read (`findCandidates`), and each skill that passes goes in through the `skill.import` command. A zip
 * is unpacked here under the same caps, entry by entry: an entry larger than a skill file may be is never unpacked, and an entry whose
 * path leaves the skill folder refuses the whole zip.
 */

import { SKILL_LIMITS, skillPathProblem, type SkillFile } from '@caotang/skills';
import { loadZipEngine } from '@caotang/store';

import { findCandidates, importSummary, type OfferedFile } from './skills-model.js';
import type { ProjectSession } from './session.js';

/** A file the writer picked: where it was picked from, how big it is, and a way to read it. */
export interface PickedFile extends OfferedFile {
  read(): Promise<Uint8Array>;
}

/** A zip bigger than this is refused before it is opened: a skill is text, and the caps hold a project to 50 of them. */
export const ZIP_MAX_BYTES = 16 * 1024 * 1024;
/** More entries than this is not a skill or a folder of skills. */
const ZIP_MAX_ENTRIES = 2000;

/** A skill name made from a file's name: lower-case words joined by hyphens, with the extension dropped. */
export function nameFromFile(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  let out = '';
  let gap = false;
  for (const ch of stem.toLowerCase()) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) {
      if (gap && out !== '') out += '-';
      gap = false;
      out += ch;
    } else gap = true;
  }
  out = out.slice(0, SKILL_LIMITS.maxNameChars);
  while (out.endsWith('-')) out = out.slice(0, -1);
  return out;
}

/** A refusal's message as a sentence, with its hint after it. */
function sentence(error: { readonly message: string; readonly correctiveHint?: string }): string {
  const end = (text: string): string => (/[.!?]$/u.test(text) ? text : `${text}.`);
  const hint = error.correctiveHint;
  return hint === undefined ? end(error.message) : `${end(error.message)} ${end(hint.charAt(0).toUpperCase() + hint.slice(1))}`;
}

/**
 * The files of a zip, unpacked under the caps. Resolves with the reason in words when the zip cannot be taken: it is too large, it is not
 * a zip, it holds too many entries, or an entry's path leaves the folder it is in.
 */
export async function pickedFromZip(bytes: Uint8Array): Promise<{ readonly files: readonly PickedFile[] } | { readonly problem: string }> {
  if (bytes.length > ZIP_MAX_BYTES) return { problem: `That zip is larger than ${ZIP_MAX_BYTES / (1024 * 1024)} MB, which is more than skills need.` };
  const { unzipSync } = await loadZipEngine();
  const seen = new Map<string, number>();
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      // Called with each entry before it is unpacked: an entry over the cap is noted and left packed, and the check below refuses its skill.
      filter: (entry) => {
        seen.set(entry.name, entry.originalSize);
        return !entry.name.endsWith('/') && entry.originalSize <= SKILL_LIMITS.maxFileBytes && seen.size <= ZIP_MAX_ENTRIES;
      },
    });
  } catch {
    return { problem: 'That file is not a zip that can be opened.' };
  }
  if (seen.size > ZIP_MAX_ENTRIES) return { problem: `That zip holds more than ${ZIP_MAX_ENTRIES} files, which is not a skill or a folder of skills.` };
  const files: PickedFile[] = [];
  for (const [name, size] of seen) {
    if (name.endsWith('/')) continue;
    const bad = skillPathProblem(name);
    if (bad !== undefined) return { problem: `That zip was not opened: a file in it has a path that does not stay inside its folder (${bad.replace('the path ', '')}).` };
    const data = entries[name];
    files.push({ path: name, size, read: async () => data ?? new Uint8Array(0) });
  }
  return { files };
}

/** What an import did: the line to say, and whether anything went wrong. */
export interface ImportOutcome {
  readonly text: string;
  readonly tone: 'info' | 'error';
}

/**
 * Finds the skills among the picked files and takes each into the project. The picked files are checked as a set first, so a skill over a
 * cap is named and nothing of it is read; a skill the command refuses (its name is taken) is named with the command's own words.
 */
export async function importPicked(session: ProjectSession, picked: readonly PickedFile[], fallback: string): Promise<ImportOutcome> {
  const found = findCandidates(picked, fallback);
  const bySource = new Map(picked.map((file) => [file.path, file]));
  const taken: string[] = [];
  const refused: string[] = found.refused.map((entry) => entry.text);
  for (const candidate of found.candidates) {
    const files: SkillFile[] = [];
    for (const file of candidate.files) {
      const source = bySource.get(file.source);
      files.push({ path: file.path, bytes: source === undefined ? new Uint8Array(0) : await source.read() });
    }
    const result = session.importSkill(candidate.folder, files);
    if (result.ok) taken.push(candidate.folder);
    else refused.push(`The skill “${candidate.folder}” was not taken: ${sentence(result.error)}`);
  }
  if (found.candidates.length === 0 && found.refused.length === 0) {
    return { text: 'No skill was found there. A skill is a folder with its instructions file in it.', tone: 'error' };
  }
  return { text: importSummary(taken, refused), tone: refused.length === 0 ? 'info' : 'error' };
}
