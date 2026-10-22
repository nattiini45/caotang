/**
 * The Skills panel's view model — pure ([extensibility.md §10](../../../../docs/architecture/extensibility.md)).
 *
 * Skills are the writer's reusable instructions to the agent, and the panel speaks of them in those words: "Skills", "review", "on" and
 * "off". The folder format (the main file, the pin) is the docs' vocabulary, not the panel's, so the main file is "Instructions" here
 * and a review is "approved", never "pinned".
 */

import {
  SKILL_FILE,
  SKILL_LIMITS,
  isSkillJunk,
  isSkillName,
  parseSkillFolder,
  findHidden,
  revealHidden,
  skillFilesProblem,
  skillIssueText,
  skillPathProblem,
  textOfBytes,
  type Skill,
  type SkillFile,
} from '@caotang/skills';
import { parsedSkillsOf } from '@caotang/harness';
import type { ProjectState } from '@caotang/store';

/** Where a skill stands with the writer's review. `changed` is a skill reviewed once whose files are not what was reviewed. */
export type ReviewState = 'unreviewed' | 'reviewed' | 'changed';

export interface SkillRow {
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly review: ReviewState;
  /** The folder has files under `scripts/`: Caotang reads the instructions and does not run them. */
  readonly hasScripts: boolean;
  /** The writer keeps this skill for themselves (`disable-model-invocation`): the agent is never told of it. */
  readonly writerOnly: boolean;
  /** The agent is told of it: on, reviewed and not kept for the writer. */
  readonly offered: boolean;
  readonly skill: Skill;
}

/** A skill folder that could not be read, with what to change. */
export interface SkillProblem {
  readonly folder: string;
  readonly text: string;
}

export interface SkillsView {
  readonly rows: readonly SkillRow[];
  readonly problems: readonly SkillProblem[];
  /** Skills the agent could be told of once the writer has read them. */
  readonly waiting: number;
}

/** The project's skills as the panel lists them, name order, with the folders that are not skills beside them. */
export function skillsView(state: ProjectState, pinOf: (name: string) => string | undefined): SkillsView {
  const off = new Set(state.manifest.disabledSkills ?? []);
  const rows: SkillRow[] = [];
  const problems: SkillProblem[] = [];
  for (const { folder, skill, issues } of parsedSkillsOf(state)) {
    if (skill === undefined) {
      for (const issue of issues) problems.push({ folder, text: skillIssueText(issue) });
      continue;
    }
    const reviewed = pinOf(skill.frontMatter.name);
    const review: ReviewState = reviewed === undefined ? 'unreviewed' : reviewed === skill.pin ? 'reviewed' : 'changed';
    const enabled = !off.has(skill.frontMatter.name);
    const writerOnly = skill.frontMatter['disable-model-invocation'] === true;
    rows.push({
      name: skill.frontMatter.name,
      description: skill.frontMatter.description,
      enabled,
      review,
      hasScripts: skill.hasScripts,
      writerOnly,
      offered: enabled && review === 'reviewed' && !writerOnly,
      skill,
    });
  }
  rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  problems.sort((a, b) => (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0));
  return { rows, problems, waiting: rows.filter((row) => row.enabled && !row.writerOnly && row.review !== 'reviewed').length };
}

/** The line that says where a skill stands, in words. */
export function reviewLine(row: SkillRow): string {
  if (row.review === 'changed') return 'Changed since you approved it. The agent does not see it until you approve it again.';
  if (row.review === 'unreviewed') return 'Not approved yet. The agent does not see it until you have read it and approved it.';
  if (row.writerOnly) return 'Approved. It is kept for you, so the agent is not told about it.';
  return row.enabled ? 'Approved. The agent is told about it.' : 'Approved, and turned off.';
}

/* ------------------------------------------------------------------ *
 * The review
 * ------------------------------------------------------------------ */

export interface ReviewFile {
  readonly path: string;
  /** What the panel calls it: the main file is "Instructions". */
  readonly label: string;
  readonly size: number;
  /** The file's text exactly as it is, with each character that draws nothing shown as its code point. `undefined` for a file that is not text. */
  readonly text: string | undefined;
  readonly invisible: number;
  readonly comments: number;
}

export interface ReviewCard {
  readonly name: string;
  readonly description: string;
  readonly files: readonly ReviewFile[];
  /** The files under `scripts/`, named. */
  readonly scripts: readonly string[];
  readonly allowedTools: string | undefined;
  /** The files beside the main one: kept with the skill, and not readable by the agent in this build. */
  readonly otherFiles: number;
  readonly invisible: number;
  readonly comments: number;
}

export const SCRIPTS_NOTICE =
  'This skill includes scripts. Caotang reads the instructions and does not run them. Other programs that read the same folder, such as Claude Code or Codex, may run them.';

export const ALLOWED_TOOLS_NOTICE = 'Not enforced in this build: it does not limit what the agent can do here.';

export const OTHER_FILES_NOTICE = 'These files are kept with the skill. The agent cannot read them in this build.';

/** Everything a writer must read before the agent is told of the skill: every file, as it is, in plain text. */
export function reviewCardOf(skill: Skill): ReviewCard {
  const files: ReviewFile[] = skill.files.map((file) => {
    const text = textOfBytes(file.bytes);
    const found = text === undefined ? { invisible: 0, comments: 0 } : findHidden(text);
    return {
      path: file.path,
      label: file.path === SKILL_FILE ? 'Instructions' : file.path,
      size: file.bytes.length,
      text: text === undefined ? undefined : revealHidden(text),
      invisible: found.invisible,
      comments: found.comments,
    };
  });
  return {
    name: skill.frontMatter.name,
    description: skill.frontMatter.description,
    files,
    scripts: skill.files.filter((file) => file.path.startsWith('scripts/')).map((file) => file.path),
    allowedTools: skill.frontMatter['allowed-tools'],
    otherFiles: skill.files.length - 1,
    invisible: files.reduce((sum, file) => sum + file.invisible, 0),
    comments: files.reduce((sum, file) => sum + file.comments, 0),
  };
}

/** A size in words for the review card. */
export function sizeLabel(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : `${(Math.ceil((bytes / 1024) * 10) / 10).toString()} KB`;
}

/* ------------------------------------------------------------------ *
 * Writing a skill
 * ------------------------------------------------------------------ */

/** A new skill's instructions: front matter that parses, and a body that says where to begin. */
export function skillTemplate(name: string): string {
  return ['---', `name: ${name}`, 'description: Say when the agent should use this skill, in a sentence or two.', '---', '', 'Write the instructions here, in plain sentences.', ''].join('\n');
}

/** Why `name` cannot be a skill's name, in words, or `undefined`. */
export function nameProblem(name: string, taken: readonly string[]): string | undefined {
  if (name === '') return 'Give the skill a name.';
  if (!isSkillName(name)) return `A name uses lower-case letters, digits and hyphens, up to ${SKILL_LIMITS.maxNameChars} characters, and does not start or end with a hyphen.`;
  if (taken.includes(name)) return `There is already a skill called “${name}”.`;
  return undefined;
}

/**
 * What the editor says about a draft of a skill's instructions: whether the skill, with this text in place of its main file, is one the
 * agent could be offered. `undefined` when it is.
 */
export function draftProblem(name: string, files: readonly SkillFile[], draft: string): string | undefined {
  const bytes = new TextEncoder().encode(draft);
  if (bytes.length > SKILL_LIMITS.maxFileBytes) return `The instructions are longer than ${SKILL_LIMITS.maxFileBytes / 1024} KB. Move part of them into a second file.`;
  const next = files.map((file) => (file.path === SKILL_FILE ? { path: SKILL_FILE, bytes } : file));
  const { skill, issues } = parseSkillFolder(name, next);
  if (skill !== undefined) return undefined;
  return issues.map(skillIssueText).join(' ');
}

/* ------------------------------------------------------------------ *
 * Importing a skill
 * ------------------------------------------------------------------ */

/** One file offered for import: its path where it was picked, and how big it is. */
export interface OfferedFile {
  readonly path: string;
  readonly size: number;
}

export interface Candidate {
  /** The folder the skill will be called, which is its name. */
  readonly folder: string;
  /** Each file by its path inside the skill and the path it was offered under. */
  readonly files: readonly { readonly path: string; readonly size: number; readonly source: string }[];
}

export interface Candidates {
  readonly candidates: readonly Candidate[];
  /** Skills that were found and cannot be taken, with the reason in words. */
  readonly refused: readonly { readonly folder: string; readonly text: string }[];
  /** Files that belong to no skill, which were left out. */
  readonly ignored: number;
}

const dirOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));

/**
 * Finds the skills in a set of picked files: every directory that holds a main file and has no such directory above it. A folder picked
 * as one skill, a folder of skills (`.agents/skills`), and a zip with a skill at its root all come out the same way. A skill at the root
 * of the pick takes `fallback` for its name (the zip's name, without its extension).
 */
export function findCandidates(offered: readonly OfferedFile[], fallback: string): Candidates {
  const usable = offered.filter((file) => {
    const segments = file.path.split('/');
    return !segments.some((segment) => segment === '.git') && !isSkillJunk(segments[segments.length - 1] ?? '');
  });
  const roots = new Set<string>();
  for (const file of usable) if (file.path === SKILL_FILE || file.path.endsWith(`/${SKILL_FILE}`)) roots.add(dirOf(file.path));
  const top = [...roots].filter((root) => ![...roots].some((other) => other !== root && (other === '' || root.startsWith(`${other}/`))));
  const candidates: Candidate[] = [];
  const refused: { folder: string; text: string }[] = [];
  const used = new Set<string>();
  for (const root of top.sort()) {
    const folder = root === '' ? fallback : (root.split('/').pop() ?? fallback);
    const prefix = root === '' ? '' : `${root}/`;
    const inside = usable.filter((file) => file.path.startsWith(prefix));
    for (const file of inside) used.add(file.path);
    const files = inside.map((file) => ({ path: file.path.slice(prefix.length), size: file.size, source: file.path }));
    const bad = files.map((file) => skillPathProblem(file.path)).find((problem) => problem !== undefined);
    if (bad !== undefined) {
      refused.push({ folder, text: `The skill “${folder}” was not taken: a file in it has an unsafe path (${bad.replace('the path ', '')}).` });
      continue;
    }
    if (!isSkillName(folder)) {
      refused.push({ folder, text: `“${folder.slice(0, 64)}” cannot be the name of a skill. ${nameProblem(folder, [])}` });
      continue;
    }
    const problem = skillFilesProblem(folder, files.map((file) => ({ path: file.path, bytes: { length: file.size } })));
    if (problem !== undefined) {
      refused.push({ folder, text: `The skill “${folder}” was not taken: ${problem.message.replace(/^the skill “[^”]*” /u, '')}` });
      continue;
    }
    candidates.push({ folder, files });
  }
  if (candidates.length + refused.length > SKILL_LIMITS.maxSkills) {
    const kept = candidates.slice(0, SKILL_LIMITS.maxSkills);
    return { candidates: kept, refused: [...refused, { folder: '', text: `Only ${SKILL_LIMITS.maxSkills} skills can be taken at once; the rest were left out.` }], ignored: usable.length - used.size };
  }
  return { candidates, refused, ignored: usable.length - used.size };
}

/** The line a finished import says: how many skills came in, and why any did not. */
export function importSummary(taken: readonly string[], refused: readonly string[]): string {
  const head = taken.length === 0 ? 'No skill was imported.' : taken.length === 1 ? `Imported the skill “${taken[0]}”. Read it and approve it before the agent can use it.` : `Imported ${taken.length} skills. Read each one and approve it before the agent can use it.`;
  return [head, ...refused].join(' ');
}
