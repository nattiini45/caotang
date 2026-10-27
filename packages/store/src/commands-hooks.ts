/**
 * The applies of the two hook commands — `hook.save` and `hook.delete` ([hooks.md §6](docs/architecture/hooks.md)). Their descriptors are
 * the bus's (`hookCommands`), which check the shape, the caps and the one handler kind a project file may hold.
 *
 * The list they write is the manifest's `agent.hooks`. The `agent` object is created by the first hook and removed with the last, unless
 * it holds something else (the writer's `rules`, or a key a newer build wrote). What the store checks here is what only the whole list can
 * show, and it checks it before it writes anything (command-bus §3): the list is not full, and an id to delete is present.
 *
 * A hook has no timestamps, so an inverse needs nothing remembered: a created hook is undone by deleting it, a replaced or deleted one by
 * saving the hook as it was.
 */
import { CROCKFORD_ALPHABET, newId } from '@caotang/ids';
import {
  ApplyRefusal,
  HOOKS_MAX,
  hookCommands,
  type ApplyContext,
  type Command,
  type CommandApply,
  type CommandName,
  type CommandParams,
  type CommandRegistry,
  type ProjectHook,
} from '@caotang/bus';

import type { ProjectState } from './state.js';

type HookApply<P> = CommandApply<P, ProjectState>;

/** The clock seam the inverse commands are stamped with. Structural, so the store's `CommandClock` satisfies it. */
export interface HookClock {
  now(): number;
}

/** The inverse, minted: a new command id, issued by the user, as every inverse is. */
function inverseCommand<N extends CommandName>(name: N, params: CommandParams[N], clock: HookClock): Command<CommandParams[N]> {
  return { id: newId('cmd'), name, params, issuedBy: 'user', createdAt: clock.now() };
}

/** A random hook id (`h_` and ten Crockford characters), unused in `taken`. Only drawn when the caller gave none. */
function mintId(taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const bytes = new Uint8Array(10);
    globalThis.crypto.getRandomValues(bytes);
    let body = '';
    for (const byte of bytes) body += CROCKFORD_ALPHABET[byte & 31] ?? '0';
    const id = `h_${body}`;
    if (!taken.has(id)) return id;
  }
  throw new Error('could not draw an unused h_ id in 16 attempts');
}

function refusal(code: 'limit-exceeded' | 'not-found', message: string, target: string, hint: string): ApplyRefusal {
  return new ApplyRefusal({ code, message, target, correctiveHint: hint });
}

/** Writes the list back under `agent`, and leaves no `agent` object behind when it would be empty. */
function keep(state: ProjectState, list: ProjectHook[]): void {
  if (list.length > 0) {
    state.manifest.agent = { ...state.manifest.agent, hooks: list };
    return;
  }
  const agent = state.manifest.agent;
  if (agent === undefined) return;
  delete agent.hooks;
  if (Object.keys(agent).length === 0) delete state.manifest.agent;
}

function saveApply(clock: HookClock): HookApply<CommandParams['hook.save']> {
  return (state, params, context: ApplyContext) => {
    const incoming = params.hook;
    const list: ProjectHook[] = [...(state.manifest.agent?.hooks ?? [])];
    const index = incoming.id === undefined ? -1 : list.findIndex((hook) => hook.id === incoming.id);
    const existing = index < 0 ? undefined : list[index];
    if (existing === undefined && list.length >= HOOKS_MAX) {
      throw refusal('limit-exceeded', `a project holds at most ${HOOKS_MAX} hooks`, 'hook', 'delete a hook before saving another');
    }
    const id = existing?.id ?? incoming.id ?? mintId(new Set(list.map((hook) => hook.id)));
    const next: ProjectHook = { ...structuredClone(incoming), id };
    if (existing !== undefined) {
      list[index] = next;
      context.undo.inverse(inverseCommand('hook.save', { hook: structuredClone(existing) }, clock));
    } else {
      list.push(next);
      context.undo.inverse(inverseCommand('hook.delete', { hookId: id }, clock));
    }
    keep(state, list);
    context.report({ affected: [], summary: `${existing === undefined ? 'saved' : 'changed'} the hook "${next.name}"` });
    return { hookId: id };
  };
}

function deleteApply(clock: HookClock): HookApply<CommandParams['hook.delete']> {
  return (state, params, context: ApplyContext) => {
    const list: ProjectHook[] = [...(state.manifest.agent?.hooks ?? [])];
    const index = list.findIndex((hook) => hook.id === params.hookId);
    const removed = index < 0 ? undefined : list[index];
    if (removed === undefined) {
      throw refusal('not-found', `no hook with id "${params.hookId}"`, params.hookId, 'the hook may already be deleted; the hooks are listed in Settings');
    }
    list.splice(index, 1);
    keep(state, list);
    context.undo.inverse(inverseCommand('hook.save', { hook: structuredClone(removed) }, clock));
    context.report({ affected: [], summary: `deleted the hook "${removed.name}"` });
    return { hookId: removed.id };
  };
}

/** The apply, narrowed to the registry's state type (the bus does not type project state; see `commands.ts`'s `narrow`). */
function narrow<P>(apply: HookApply<P>): CommandApply<P, unknown> {
  return apply as CommandApply<P, unknown>;
}

/** The hook registrations, for the store's registry. */
export function hookCommandRegistrations(options: { readonly clock: HookClock }): Partial<CommandRegistry> {
  return {
    'hook.save': { descriptor: hookCommands.hookSave, apply: narrow(saveApply(options.clock)) },
    'hook.delete': { descriptor: hookCommands.hookDelete, apply: narrow(deleteApply(options.clock)) },
  };
}
