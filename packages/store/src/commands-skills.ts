/**
 * The applies of the four skill commands — `skill.import`, `skill.write`, `skill.delete` and `skill.setEnabled`
 * ([extensibility.md §10](docs/architecture/extensibility.md)). Their descriptors are the bus's (`skillCommands`), and all four are
 * user-only (`agentRisk: 'never'`), so a refusal here is never the first place a bad value is caught.
 *
 * A skill is its folder's files held as bytes in `ProjectState.skills`. An apply changes that map and the set of paths a save must
 * remove (`removedSkillFiles`), and nothing else; the folder is written by the next save (write.ts), the browser store by the next
 * state write. The one setting a skill has, whether it is on, is the manifest's `disabledSkills`.
 *
 * Every apply reports its own undo once, after the change. A restore puts back the files it took, so an undone import or delete leaves
 * the project as it was, and a save after it removes nothing the skill holds again.
 */

import { ApplyRefusal, skillCommands, type ApplyContext, type Command, type CommandApply, type CommandName, type CommandRegistry, type SkillDeleteParams, type SkillImportParams, type SkillSetEnabledParams, type SkillWriteParams } from '@caotang/bus';
import { newId } from '@caotang/ids';
import { SKILL_FILE, SKILL_LIMITS, isSkillName, skillFilesProblem, type SkillFile } from '@caotang/skills';

import { skillFilePath } from './paths.js';
import type { ProjectState } from './state.js';

type SkillApply<P> = CommandApply<P, ProjectState>;

/** The clock seam the inverse commands are stamped from. Structural, so the store's `CommandClock` satisfies it. */
export interface ApplyClock {
  now(): number;
}

/** One skill folder a host has chosen: its name and its files, held until the one command that imports it runs. */
export interface StagedSkill {
  readonly folder: string;
  readonly files: readonly SkillFile[];
}

/** Staging is in memory and single-use, as the image staging is: `take` hands the files over and forgets them. */
export interface SkillStaging {
  stage(skill: StagedSkill): string;
  take(token: string): StagedSkill | undefined;
}

export function createSkillStaging(): SkillStaging {
  const held = new Map<string, StagedSkill>();
  return {
    stage(skill) {
      const token = `stg_${newId('c').slice(2)}`;
      held.set(token, { folder: skill.folder, files: skill.files.map((file) => ({ path: file.path, bytes: file.bytes.slice() })) });
      return token;
    },
    take(token) {
      const skill = held.get(token);
      held.delete(token);
      return skill;
    },
  };
}

const encoder = new TextEncoder();
const byPath = (a: SkillFile, b: SkillFile): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** The state's disabled list, sorted and without a name twice; the field is dropped when the list is empty, as an absent field means all on. */
function setDisabled(state: ProjectState, name: string, disabled: boolean): void {
  const names = new Set(state.manifest.disabledSkills ?? []);
  if (disabled) names.add(name);
  else names.delete(name);
  if (names.size === 0) delete state.manifest.disabledSkills;
  else state.manifest.disabledSkills = [...names].sort();
}

const isDisabled = (state: ProjectState, name: string): boolean => (state.manifest.disabledSkills ?? []).includes(name);

/** Puts a skill's files into the state, and takes their paths off the list of files a save removes. */
function holdSkill(state: ProjectState, folder: string, files: readonly SkillFile[]): void {
  state.skills.set(folder, [...files].sort(byPath));
  for (const file of files) state.removedSkillFiles.delete(skillFilePath(folder, file.path));
}

/** Takes a skill out of the state, and lists its files for the next save to remove. */
function dropSkill(state: ProjectState, folder: string): void {
  for (const file of state.skills.get(folder) ?? []) state.removedSkillFiles.add(skillFilePath(folder, file.path));
  state.skills.delete(folder);
}

const copyOf = (files: readonly SkillFile[]): SkillFile[] => files.map((file) => ({ path: file.path, bytes: file.bytes.slice() }));

function skillImportApply(staging: SkillStaging): SkillApply<SkillImportParams> {
  return (state, params, context: ApplyContext) => {
    const staged = staging.take(params.stagingId);
    if (staged === undefined) {
      throw new ApplyRefusal({ code: 'not-found', message: 'the skill is no longer held, so nothing was imported', target: 'stagingId', correctiveHint: 'choose the skill again' });
    }
    const { folder } = staged;
    if (!isSkillName(folder)) {
      throw new ApplyRefusal({
        code: 'invalid-params',
        message: `“${folder.slice(0, 80)}” is not a skill name`,
        target: 'stagingId',
        correctiveHint: `a skill folder is named with lower-case letters, digits and hyphens, up to ${SKILL_LIMITS.maxNameChars} characters`,
      });
    }
    if (state.skills.has(folder)) {
      throw new ApplyRefusal({
        code: 'invalid-params',
        message: `the project already has a skill “${folder}”`,
        target: 'stagingId',
        correctiveHint: `delete the skill “${folder}” first if the imported one should replace it`,
      });
    }
    if (state.skills.size >= SKILL_LIMITS.maxSkills) {
      throw new ApplyRefusal({ code: 'limit-exceeded', message: `a project can hold at most ${SKILL_LIMITS.maxSkills} skills`, target: 'stagingId', correctiveHint: 'delete a skill you no longer use' });
    }
    const problem = skillFilesProblem(folder, staged.files);
    if (problem !== undefined) {
      const capped = problem.code === 'too_many_files' || problem.code === 'file_too_large' || problem.code === 'skill_too_large';
      throw new ApplyRefusal({
        code: capped ? 'limit-exceeded' : 'invalid-params',
        message: problem.message.replace(/\.$/u, ''),
        target: 'stagingId',
        correctiveHint: capped ? 'cut the skill down, or import the files that matter' : 'choose a folder that has a SKILL.md and files inside it',
      });
    }
    holdSkill(state, folder, copyOf(staged.files));
    context.undo.compensate(`remove the skill “${folder}”`, () => dropSkill(state, folder));
    context.report({ affected: [], summary: `imported the skill “${folder}”` });
    return { name: folder, files: staged.files.length };
  };
}

function skillWriteApply(): SkillApply<SkillWriteParams> {
  return (state, params, context) => {
    const { name, path } = params;
    const created = !state.skills.has(name);
    const files = copyOf(state.skills.get(name) ?? []);
    const index = files.findIndex((file) => file.path === path);
    const before = index < 0 ? undefined : files[index];
    const next: SkillFile = { path, bytes: encoder.encode(params.text) };
    if (index < 0) files.push(next);
    else files[index] = next;
    holdSkill(state, name, files);
    context.undo.compensate(`restore the skill “${name}”`, () => {
      if (created) {
        dropSkill(state, name);
        return;
      }
      const current = copyOf(state.skills.get(name) ?? []);
      const at = current.findIndex((file) => file.path === path);
      if (before === undefined) {
        if (at >= 0) current.splice(at, 1);
      } else if (at >= 0) current[at] = { path, bytes: before.bytes.slice() };
      else current.push({ path, bytes: before.bytes.slice() });
      holdSkill(state, name, current);
      if (before === undefined) state.removedSkillFiles.add(skillFilePath(name, path));
    });
    context.report({ affected: [], summary: path === SKILL_FILE ? `${created ? 'added' : 'changed'} the skill “${name}”` : `${before === undefined ? 'added' : 'changed'} ${path} in the skill “${name}”` });
    return { name, path };
  };
}

function skillDeleteApply(): SkillApply<SkillDeleteParams> {
  return (state, params, context) => {
    const { name } = params;
    const files = copyOf(state.skills.get(name) ?? []);
    const wasDisabled = isDisabled(state, name);
    dropSkill(state, name);
    // A skill that is gone has no setting to keep; a skill imported under the name later starts on.
    setDisabled(state, name, false);
    context.undo.compensate(`restore the skill “${name}”`, () => {
      holdSkill(state, name, files);
      if (wasDisabled) setDisabled(state, name, true);
    });
    context.report({ affected: [], summary: `deleted the skill “${name}”` });
    return { name };
  };
}

function skillSetEnabledApply(clock: ApplyClock): SkillApply<SkillSetEnabledParams> {
  return (state, params, context) => {
    setDisabled(state, params.name, !params.enabled);
    context.undo.inverse(inverseCommand('skill.setEnabled', { name: params.name, enabled: !params.enabled }, clock));
    context.report({ affected: [], summary: `turned the skill “${params.name}” ${params.enabled ? 'on' : 'off'}` });
    return { name: params.name, enabled: params.enabled };
  };
}

/** The inverse command, minted as the user's own gesture (command-bus §4: an undo is never refused by the gate). */
function inverseCommand<P>(name: CommandName, params: P, clock: ApplyClock): Command<P> {
  return { id: newId('cmd'), name, params, issuedBy: 'user', createdAt: clock.now() };
}

/** The apply, narrowed to the registry's state type (the bus does not type project state; see `commands.ts`'s `narrow`). */
function narrow<P>(apply: SkillApply<P>): CommandApply<P, unknown> {
  return apply as CommandApply<P, unknown>;
}

/**
 * The skill registrations, for the store's registry. `skill.import` is registered only when the host injects its staging, the way
 * `project.importAsset` is: without it the name stays descriptor-only and the bus refuses it as not wired.
 */
export function skillCommandRegistrations(options: { readonly clock: ApplyClock; readonly staging?: SkillStaging }): Partial<CommandRegistry> {
  const registrations: Partial<CommandRegistry> = {
    'skill.write': { descriptor: skillCommands.skillWrite, apply: narrow(skillWriteApply()) },
    'skill.delete': { descriptor: skillCommands.skillDelete, apply: narrow(skillDeleteApply()) },
    'skill.setEnabled': { descriptor: skillCommands.skillSetEnabled, apply: narrow(skillSetEnabledApply(options.clock)) },
  };
  if (options.staging !== undefined) {
    registrations['skill.import'] = { descriptor: skillCommands.skillImport, apply: narrow(skillImportApply(options.staging)) };
  }
  return registrations;
}
