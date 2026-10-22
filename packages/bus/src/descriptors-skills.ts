/**
 * Skills: the descriptors of the four commands that change a project's skills (extensibility.md §10). Their applies are the store's
 * (`packages/store/src/commands-skills.ts`), reached through the same registry as the rest of the closed set (`registry.ts`).
 *
 * **All four are `agentRisk: 'never'`.** A skill is an instruction the agent will read later, so an agent that could install, edit,
 * enable or delete one would be writing its own instructions (extensibility §4 rule 7). The writer does all four from the Skills panel,
 * and the agent may suggest a skill in its report and nothing more. The harness's allowlist of primitives does not name them.
 *
 * Validation is pure and total (command-bus §2): it checks the key set, the name, the path and the caps against the snapshot. What a
 * staged import holds is the apply's to check, before it writes anything, because only the host holds the staged files.
 */

import { SKILL_FILE, SKILL_LIMITS, isSkillName, sizeInWords, skillPathProblem } from '@caotang/skills';

import type { CommandDescriptor, SkillDeleteParams, SkillImportParams, SkillSetEnabledParams, SkillWriteParams } from './command.js';
import { invalid, limitExceeded, notFound, changesNothing, requireDeclaredParams, requireNonBlankString, showValue } from './params.js';
import { ok } from './result.js';

const encoder = new TextEncoder();

function nameOf(params: Record<string, unknown>) {
  const name = params['name'];
  if (typeof name !== 'string' || !isSkillName(name)) {
    return invalid(
      `${showValue(name)} is not a skill name`,
      `use lower-case letters, digits and hyphens, up to ${SKILL_LIMITS.maxNameChars} characters, with no hyphen at either end`,
      'name',
    );
  }
  return ok(name);
}

export const skillImport: CommandDescriptor<SkillImportParams> = {
  mutates: 'project',
  agentRisk: 'never',
  undo: 'compensable',
  validate: (params) => {
    const p = requireDeclaredParams('skill.import', params);
    if (!p.ok) return p;
    const stagingId = requireNonBlankString(p.value, 'stagingId', { maxChars: 64 });
    if (!stagingId.ok) return stagingId;
    return ok({ stagingId: stagingId.value });
  },
};

export const skillWrite: CommandDescriptor<SkillWriteParams> = {
  mutates: 'project',
  agentRisk: 'never',
  undo: 'compensable',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('skill.write', params);
    if (!p.ok) return p;
    const name = nameOf(p.value);
    if (!name.ok) return name;
    const path = p.value['path'];
    if (typeof path !== 'string') return invalid(`params.path must be a string, got ${showValue(path)}`, undefined, 'path');
    const bad = skillPathProblem(path);
    if (bad !== undefined) return invalid(`“${path.slice(0, 80)}” is not a path inside a skill: ${bad}`, 'name a file inside the skill folder, such as SKILL.md or references/style.md', 'path');
    const text = p.value['text'];
    if (typeof text !== 'string') return invalid(`params.text must be a string, got ${showValue(text)}`, undefined, 'text');
    const size = encoder.encode(text).length;
    if (size > SKILL_LIMITS.maxFileBytes) {
      return limitExceeded(
        `the file is ${sizeInWords(size)}, and a skill file may be at most ${sizeInWords(SKILL_LIMITS.maxFileBytes)}`,
        'move part of it into a second file, such as references/more.md',
        'text',
      );
    }
    const files = snapshot.skills?.get(name.value);
    if (files === undefined) {
      if (path !== SKILL_FILE) return invalid(`a new skill starts with its ${SKILL_FILE}`, `write ${SKILL_FILE} first`, 'path');
      if ((snapshot.skills?.size ?? 0) >= SKILL_LIMITS.maxSkills) {
        return limitExceeded(`a project can hold at most ${SKILL_LIMITS.maxSkills} skills`, 'delete a skill you no longer use', 'name');
      }
    } else {
      const held = files.find((file) => file.path === path);
      if (held === undefined && files.length >= SKILL_LIMITS.maxFilesPerSkill) {
        return limitExceeded(`a skill may have at most ${SKILL_LIMITS.maxFilesPerSkill} files`, 'remove a file you no longer need', 'path');
      }
      const total = files.reduce((sum, file) => sum + (file.path === path ? 0 : file.bytes.length), 0) + size;
      if (total > SKILL_LIMITS.maxSkillBytes) {
        return limitExceeded(`the skill would be ${sizeInWords(total)}, and a skill may be at most ${sizeInWords(SKILL_LIMITS.maxSkillBytes)}`, 'shorten the files', 'text');
      }
    }
    return ok({ name: name.value, path, text });
  },
};

export const skillDelete: CommandDescriptor<SkillDeleteParams> = {
  mutates: 'project',
  agentRisk: 'never',
  undo: 'compensable',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('skill.delete', params);
    if (!p.ok) return p;
    const name = nameOf(p.value);
    if (!name.ok) return name;
    if (snapshot.skills?.get(name.value) === undefined) {
      return notFound(`the project has no skill “${name.value}”`, 'the skills are listed in the Skills panel', 'name');
    }
    return ok({ name: name.value });
  },
};

export const skillSetEnabled: CommandDescriptor<SkillSetEnabledParams> = {
  mutates: 'project',
  agentRisk: 'never',
  undo: 'inverse',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('skill.setEnabled', params);
    if (!p.ok) return p;
    const name = nameOf(p.value);
    if (!name.ok) return name;
    const enabled = p.value['enabled'];
    if (typeof enabled !== 'boolean') return invalid(`params.enabled must be true or false, got ${showValue(enabled)}`, undefined, 'enabled');
    if (snapshot.skills?.get(name.value) === undefined) {
      return notFound(`the project has no skill “${name.value}”`, 'the skills are listed in the Skills panel', 'name');
    }
    const now = !(snapshot.manifest.disabledSkills ?? []).includes(name.value);
    if (now === enabled) {
      return changesNothing(`the skill “${name.value}” is already ${enabled ? 'on' : 'off'}`, 'nothing to change', 'enabled');
    }
    return ok({ name: name.value, enabled });
  },
};

/** The skill descriptors by name, for the registry and for a test that reads them as a set. */
export const SKILL_DESCRIPTORS = {
  'skill.import': skillImport,
  'skill.write': skillWrite,
  'skill.delete': skillDelete,
  'skill.setEnabled': skillSetEnabled,
} as const;
