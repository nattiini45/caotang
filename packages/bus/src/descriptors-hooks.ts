/**
 * Hooks: the descriptors of the two commands that change a project's `agent.hooks` (hooks.md §6). Their applies are the store's
 * (`packages/store/src/commands-hooks.ts`), reached through the same registry as the rest of the closed set (`registry.ts`).
 *
 * **Both are `agentRisk: 'never'`.** A hook is a rule the writer holds the agent to, so an agent that could save, edit, enable or delete
 * one could lift the rule it is held to (extensibility §4 rule 7). The writer does both from Settings, and the harness's allowlist of
 * primitives does not name them.
 *
 * Validation is structural (`hook-rules.ts`): the shape, the caps and the one handler kind a project file may hold. That a coherence
 * check id exists, and that a status is in the project's vocabulary, is the harness's, when the hook runs.
 */

import type { CommandDescriptor, HookDeleteParams, HookSaveParams } from './command.js';
import { HOOKS_MAX, isHookId, readHook } from './hook-rules.js';
import { invalid, limitExceeded, notFound, requireDeclaredParams, showValue } from './params.js';
import { ok } from './result.js';

export const hookSave: CommandDescriptor<HookSaveParams> = {
  mutates: 'project',
  agentRisk: 'never',
  undo: 'inverse',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('hook.save', params);
    if (!p.ok) return p;
    const read = readHook(p.value['hook'], false);
    if (!read.ok) return read;
    const held = snapshot.manifest.agent?.hooks ?? [];
    const replaces = read.value.id !== undefined && held.some((hook) => hook.id === read.value.id);
    if (!replaces && held.length >= HOOKS_MAX) {
      return limitExceeded(`a project holds at most ${HOOKS_MAX} hooks`, 'delete a hook before saving another', 'hook');
    }
    return ok({ hook: read.value });
  },
};

export const hookDelete: CommandDescriptor<HookDeleteParams> = {
  mutates: 'project',
  agentRisk: 'never',
  undo: 'inverse',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('hook.delete', params);
    if (!p.ok) return p;
    const hookId = p.value['hookId'];
    if (!isHookId(hookId)) {
      return invalid(`${showValue(hookId)} is not a hook id`, 'a hook id is h_ followed by 10 base32 characters; the hooks are listed in Settings', 'hookId');
    }
    if (!(snapshot.manifest.agent?.hooks ?? []).some((hook) => hook.id === hookId)) {
      return notFound(`no hook with id "${hookId}"`, 'the hook may already be deleted; the hooks are listed in Settings', 'hookId');
    }
    return ok({ hookId });
  },
};

/** The hook descriptors by name, for the registry and for a test that reads them as a set. */
export const HOOK_DESCRIPTORS = {
  'hook.save': hookSave,
  'hook.delete': hookDelete,
} as const;
