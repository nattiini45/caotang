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
 * drafting requests of the same turn, never in the system role, and `endTurn` forgets it. A skill grants nothing: the block says so,
 * and no gate looks at it.
 */

import { parseSkillFolder, isOffered, type Skill, type SkillFile, type SkillLoadIssue, type SkillState } from '@caotang/skills';
import type { ProjectState } from '@caotang/store';

import { failure, limitExceeded, notFound } from '../errors.js';
import { param, type ObjectSpec } from '../schema.js';
import { fitsCap } from '../tokens.js';
import type { ToolOutcome, ToolPort, ToolValue } from '../types.js';

export const skillLoadParams: ObjectSpec = param.object(
  'The skill to load.',
  { name: param.string('The skill’s name, exactly as the skills list shows it.', { nonBlank: true, maxLength: 64 }) },
  ['name'],
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
}

/** The skills each turn has loaded, by turn id. Forgotten per turn (`forget`), so a body never reaches a later turn. */
export function createSkillLoads() {
  const byTurn = new Map<string, Map<string, LoadedSkill>>();
  return {
    add(turnId: string, skill: LoadedSkill): void {
      const loaded = byTurn.get(turnId) ?? new Map<string, LoadedSkill>();
      loaded.set(skill.name, skill);
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
export function skillLoadPort(states: () => readonly SkillState[], loads: SkillLoads, cap: number): ToolPort {
  return (params, context): ToolOutcome => {
    const name = String(params['name'] ?? '');
    const found = states().find((candidate) => candidate.skill.frontMatter.name === name && isOffered(candidate));
    if (found === undefined) {
      // One answer for a name that does not exist and for a skill the writer has not turned on and reviewed, so the refusal says
      // nothing about a skill the model has not been told of.
      return failure(notFound(GENERIC(name), 'load only a skill named in the skills list', 'name')) as ToolOutcome;
    }
    const { skill } = found;
    const others = skill.files.filter((file) => file.path !== 'SKILL.md').length;
    const data = {
      skill: skill.frontMatter.name,
      label: skillLabel(skill.frontMatter.name),
      instructions: skill.body.trim(),
      ...(others === 0 ? {} : { note: `The files beside SKILL.md (${others}) are kept with the skill and cannot be read in this build.` }),
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
    loads.add(context.turnId, { name: skill.frontMatter.name, body: skill.body.trim() });
    const value: ToolValue = { data, summary: `loaded the skill “${skill.frontMatter.name}”`, affected: [] };
    context.logRow(`loaded the skill “${skill.frontMatter.name}”`);
    return { ok: true, value };
  };
}
