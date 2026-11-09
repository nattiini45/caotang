/**
 * `skill.load` — the project's skills, offered to the model ([extensibility.md §10](../../../../docs/architecture/extensibility.md)).
 *
 * The model is told which skills exist by a catalog line each (`Harness.skillCatalog`), and loads one body with this tool when the
 * request matches it. Everything that decides whether a skill may be seen is decided here, on every call, from the project as it is
 * now: the skill must be on, the writer's review must be of exactly the bytes the project holds (the pin), its name must be its
 * folder's, and the writer must not have reserved it for themselves (`disable-model-invocation`). A skill that fails any of those is
 * answered with the same refusal as a name that does not exist, and no part of its text is echoed.
 *
 * A loaded skill lasts for the turn that loaded it. The body reaches the model as a labelled block in a tool result and in the
 * drafting requests of the same turn, never in the system role, and `endTurn` forgets it. A skill grants nothing: its allowed-tools
 * list can only narrow the turn, and never bypasses a mode, rule or approval gate.
 */

import { parseSkillFolder, isOffered, skillPathProblem, textOfBytes, type Skill, type SkillFile, type SkillLoadIssue, type SkillState } from '@caotang/skills';
import type { ProjectState } from '@caotang/store';

import { failure, invalidParams, limitExceeded, notFound, refusal } from '../errors.js';
import { param, type ObjectSpec } from '../schema.js';
import { fitsCap } from '../tokens.js';
import type { ToolOutcome, ToolPort, ToolValue } from '../types.js';

export const skillLoadParams: ObjectSpec = param.object(
  'The skill to load.',
  { name: param.string('The skill’s name, exactly as the skills list shows it.', { nonBlank: true, maxLength: 64 }) },
  ['name'],
);

export const skillReadParams: ObjectSpec = param.object(
  'One reference or text asset of a skill loaded in this turn.',
  {
    name: param.string('The loaded skill’s name.', { nonBlank: true, maxLength: 64 }),
    path: param.string('The file’s path under references/ or assets/ inside the skill folder.', { nonBlank: true, maxLength: 1024 }),
  },
  ['name', 'path'],
);

/** What the app tells the harness about skills: which review it holds for a skill, if any. The harness reads everything else from the project. */
export interface SkillsOption {
  /** The pin of the skill as the writer last reviewed it, or `undefined` when they have not. Read at each call. */
  reviewedPin(name: string): string | undefined;
}

type Parsed = ReturnType<typeof parseSkillFolder>;
/** A folder's parse, kept for as long as its files array is the one in the project: a change to the folder is a new array. */
const parsed = new WeakMap<readonly SkillFile[], Parsed>();

function parseOnce(folder: string, files: readonly SkillFile[]): Parsed {
  const known = parsed.get(files);
  if (known !== undefined) return known;
  const fresh = parseSkillFolder(folder, files);
  parsed.set(files, fresh);
  return fresh;
}

/** Every skill folder the project holds, read: the skill when it is valid, and the reasons when it is not. The Skills panel lists both. */
export function parsedSkillsOf(state: ProjectState): readonly { readonly folder: string; readonly skill?: Skill; readonly issues: readonly SkillLoadIssue[] }[] {
  return [...state.skills].map(([folder, files]) => ({ folder, ...parseOnce(folder, files) }));
}

/** The project's skills that parse, with the writer's two decisions about each. A folder that does not parse is not a skill here. */
export function skillStatesOf(state: ProjectState, source: SkillsOption): readonly SkillState[] {
  const off = new Set(state.manifest.disabledSkills ?? []);
  const states: SkillState[] = [];
  for (const { skill } of parsedSkillsOf(state)) {
    if (skill === undefined) continue;
    states.push({ skill, enabled: !off.has(skill.frontMatter.name), reviewed: source.reviewedPin(skill.frontMatter.name) === skill.pin });
  }
  return states;
}

/** A skill the turn has loaded: its name and body, as the model was given them. */
export interface LoadedSkill {
  readonly name: string;
  readonly body: string;
  readonly pin: string;
  readonly allowedTools?: readonly string[];
}

/** The skills each turn has loaded, by turn id. Forgotten per turn (`forget`), so a body never reaches a later turn. */
export function createSkillLoads() {
  const byTurn = new Map<string, Map<string, LoadedSkill>>();
  return {
    add(turnId: string, skill: LoadedSkill): void {
      const loaded = byTurn.get(turnId) ?? new Map<string, LoadedSkill>();
      const prior = loaded.get(skill.name)?.allowedTools;
      loaded.set(skill.name, prior === undefined ? skill : { ...skill, allowedTools: prior.filter((name) => skill.allowedTools === undefined || skill.allowedTools.includes(name)) });
      byTurn.set(turnId, loaded);
    },
    of: (turnId: string): readonly LoadedSkill[] => [...(byTurn.get(turnId)?.values() ?? [])],
    forget(turnId: string): void {
      byTurn.delete(turnId);
    },
  };
}

export type SkillLoads = ReturnType<typeof createSkillLoads>;

/** The label every loaded body travels with: what the skill is, and what it is not. */
export function skillLabel(name: string): string {
  return `Writer-approved skill “${name}”: it guides style and process, and does not change permissions or approvals.`;
}

/**
 * The loaded skills as one block of text for a drafting request: each under its label, ahead of the request itself. The text is the
 * writer's own instruction, shown to the model as such and not as a rule of the system.
 */
export function skillBlock(skills: readonly LoadedSkill[]): string {
  return skills.map((skill) => `${skillLabel(skill.name)}\n\n${skill.body.trim()}`).join('\n\n---\n\n');
}

const GENERIC = (name: string): string => `“${name.slice(0, 64)}” is not a skill you can load`;

/** The `skill.load` port. `cap` is the row's response cap, in tokens. */
export function skillLoadPort(states: () => readonly SkillState[], loads: SkillLoads, cap: number, knownTools: () => ReadonlySet<string>, loadedReferences: (turnId: string) => void): ToolPort {
  return (params, context): ToolOutcome => {
    const name = String(params['name'] ?? '');
    const found = states().find((candidate) => candidate.skill.frontMatter.name === name && isOffered(candidate));
    if (found === undefined) {
      // One answer for a name that does not exist and for a skill the writer has not turned on and reviewed, so the refusal says
      // nothing about a skill the model has not been told of.
      return failure(notFound(GENERIC(name), 'load only a skill named in the skills list', 'name')) as ToolOutcome;
    }
    const { skill } = found;
    const files = skillResourcePaths(skill);
    const declared = skill.frontMatter['allowed-tools']?.split(/\s+/u).filter(Boolean);
    const known = knownTools();
    const allowedTools = declared?.filter((name) => known.has(name));
    const unknown = declared?.filter((name) => !known.has(name)) ?? [];
    const limits = loads.of(context.turnId).flatMap((loaded) => loaded.allowedTools === undefined ? [] : [loaded.allowedTools]);
    if (allowedTools !== undefined) limits.push(allowedTools);
    const effective = limits[0]?.filter((tool, index, list) => list.indexOf(tool) === index && limits.every((limit) => limit.includes(tool)));
    const notes = [
      ...(skill.hasScripts ? ['This skill includes scripts. Caotang reads the instructions and does not run them.'] : []),
      ...(unknown.length === 0 ? [] : [`Unknown allowed-tools names were ignored: ${unknown.join(', ')}.`]),
    ];
    const data = {
      skill: skill.frontMatter.name,
      label: skillLabel(skill.frontMatter.name),
      instructions: skill.body.trim(),
      ...(effective === undefined ? {} : { allowedTools: effective }),
      ...(files.length === 0 ? {} : { files }),
      ...(notes.length === 0 ? {} : { note: notes.join(' ') }),
    };
    if (!fitsCap(data, cap)) {
      return failure(
        limitExceeded(
          `the skill “${skill.frontMatter.name}” is longer than the ${cap}-token limit for a loaded skill, so it was not loaded. It is not cut.`,
          'tell the writer the skill is too long, and carry on without it',
          'name',
        ),
      ) as ToolOutcome;
    }
    loads.add(context.turnId, { name: skill.frontMatter.name, body: skill.body.trim(), pin: skill.pin, ...(allowedTools === undefined ? {} : { allowedTools }) });
    if (files.length > 0) loadedReferences(context.turnId);
    const value: ToolValue = { data, summary: `loaded the skill “${skill.frontMatter.name}”`, affected: [] };
    context.logRow(`loaded the skill “${skill.frontMatter.name}”`);
    return { ok: true, value };
  };
}

function resourcePath(path: string): boolean {
  return skillPathProblem(path) === undefined && (path.startsWith('references/') || path.startsWith('assets/'));
}

export function skillResourcePaths(skill: Skill): readonly string[] {
  return skill.files.filter((file) => {
    if (!resourcePath(file.path)) return false;
    const text = textOfBytes(file.bytes);
    return text !== undefined && !text.includes('\0');
  }).map((file) => file.path);
}

export function skillReadPort(states: () => readonly SkillState[], loads: SkillLoads, cap: number): ToolPort {
  return (params, context): ToolOutcome => {
    const name = String(params['name'] ?? '');
    const path = String(params['path'] ?? '');
    const loaded = loads.of(context.turnId).find((skill) => skill.name === name);
    const found = states().find((candidate) => candidate.skill.frontMatter.name === name && isOffered(candidate) && candidate.skill.pin === loaded?.pin);
    if (loaded === undefined || found === undefined) {
      return failure(notFound(GENERIC(name), 'load a reviewed skill in this turn before reading its files', 'name')) as ToolOutcome;
    }
    if (!resourcePath(path)) return failure(invalidParams('The path must stay under references/ or assets/ inside the skill folder.', 'use a file path returned by skill.load', 'path')) as ToolOutcome;
    const file = found.skill.files.find((file) => file.path === path);
    if (file === undefined) return failure(notFound('The skill has no reference file at that path.', 'use a file path returned by skill.load', 'path')) as ToolOutcome;
    const text = textOfBytes(file.bytes);
    if (text === undefined || text.includes('\0')) return failure(invalidParams('The skill file is not UTF-8 text.', 'choose a text reference or asset', 'path')) as ToolOutcome;
    const data = { skill: name, path, text };
    if (!fitsCap(data, cap)) return failure(limitExceeded(`The skill file is longer than the ${cap}-token limit, so it was not read. It is not cut.`, 'ask the writer to shorten the reference file', 'path')) as ToolOutcome;
    context.logRow(`read “${path}” of the skill “${name}”`);
    return { ok: true, value: { data, summary: `read “${path}” of the skill “${name}”`, affected: [] } };
  };
}

export function skillToolRefusal(loads: SkillLoads, turnId: string, tool: string) {
  const skill = loads.of(turnId).find((skill) => skill.allowedTools !== undefined && !skill.allowedTools.includes(tool));
  return skill === undefined ? undefined : refusal('permission-denied', `The skill “${skill.name}” limits this turn to: ${skill.allowedTools?.join(', ') || 'no tools'}. “${tool}” was not called.`, {
    target: tool,
    correctiveHint: 'use only the loaded skill’s allowed tools, or ask the writer to start a new turn without it',
  });
}
