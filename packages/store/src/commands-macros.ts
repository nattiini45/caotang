/**
 * The applies of the two macro commands — `macro.save` and `macro.delete` ([extensibility.md §10](docs/architecture/extensibility.md)).
 * Their descriptors are the bus's (`macroCommands`), which check the shape, the caps and the tools a macro may never name.
 *
 * The list they write is the manifest's `macros[]`. What the store checks here is what only the whole list can show, and it checks it before
 * it writes anything (command-bus §3): the list is not full, the slug is not another macro's, and an id to delete is present.
 *
 * A macro has no timestamps, so an inverse needs nothing remembered: a created macro is undone by deleting it, a replaced or deleted one
 * by saving the macro as it was.
 */
import { CROCKFORD_ALPHABET, newId } from '@caotang/ids';
import {
  ApplyRefusal,
  MACROS_MAX,
  macroCommands,
  type ApplyContext,
  type Command,
  type CommandApply,
  type CommandName,
  type CommandParams,
  type CommandRegistry,
  type ProjectMacro,
} from '@caotang/bus';

import type { ProjectState } from './state.js';

type MacroApply<P> = CommandApply<P, ProjectState>;

/** The clock seam the inverse commands are stamped with. Structural, so the store's `CommandClock` satisfies it. */
export interface MacroClock {
  now(): number;
}

/** The inverse, minted: a new command id, issued by the user, as every inverse is. */
function inverseCommand<N extends CommandName>(name: N, params: CommandParams[N], clock: MacroClock): Command<CommandParams[N]> {
  return { id: newId('cmd'), name, params, issuedBy: 'user', createdAt: clock.now() };
}

/** A random macro id (`m_` and ten Crockford characters), unused in `taken`. Only drawn when the caller gave none. */
function mintId(taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const bytes = new Uint8Array(10);
    globalThis.crypto.getRandomValues(bytes);
    let body = '';
    for (const byte of bytes) body += CROCKFORD_ALPHABET[byte & 31] ?? '0';
    const id = `m_${body}`;
    if (!taken.has(id)) return id;
  }
  throw new Error('could not draw an unused m_ id in 16 attempts');
}

function refusal(code: 'limit-exceeded' | 'invalid-params' | 'not-found', message: string, target: string, hint: string): ApplyRefusal {
  return new ApplyRefusal({ code, message, target, correctiveHint: hint });
}

function saveApply(clock: MacroClock): MacroApply<CommandParams['macro.save']> {
  return (state, params, context: ApplyContext) => {
    const incoming = params.macro;
    const list: ProjectMacro[] = state.manifest.macros ?? [];
    const index = incoming.id === undefined ? -1 : list.findIndex((macro) => macro.id === incoming.id);
    const existing = index < 0 ? undefined : list[index];
    if (existing === undefined && list.length >= MACROS_MAX) {
      throw refusal('limit-exceeded', `a project holds at most ${MACROS_MAX} macros`, 'macro', 'delete a macro before saving another');
    }
    if (list.some((macro) => macro.slug === incoming.slug && macro.id !== existing?.id)) {
      throw refusal('invalid-params', `another macro already has the slug "${incoming.slug}"`, 'macro.slug', 'give this macro its own slug');
    }
    const id = existing?.id ?? incoming.id ?? mintId(new Set(list.map((macro) => macro.id)));
    const next: ProjectMacro = { ...structuredClone(incoming), id };
    if (existing !== undefined) {
      list[index] = next;
      context.undo.inverse(inverseCommand('macro.save', { macro: structuredClone(existing) }, clock));
    } else {
      list.push(next);
      context.undo.inverse(inverseCommand('macro.delete', { macroId: id }, clock));
    }
    state.manifest.macros = list;
    context.report({ affected: [], summary: `${existing === undefined ? 'saved' : 'changed'} the macro "${next.name}"` });
    return { macroId: id };
  };
}

function deleteApply(clock: MacroClock): MacroApply<CommandParams['macro.delete']> {
  return (state, params, context: ApplyContext) => {
    const list: ProjectMacro[] = state.manifest.macros ?? [];
    const index = list.findIndex((macro) => macro.id === params.macroId);
    const removed = index < 0 ? undefined : list[index];
    if (removed === undefined) {
      throw refusal('not-found', `no macro with id "${params.macroId}"`, params.macroId, 'the macro may already be deleted; the macros are listed in Settings');
    }
    list.splice(index, 1);
    // A project with no macros stores no key at all, as a project that never had one.
    if (list.length === 0) delete state.manifest.macros;
    else state.manifest.macros = list;
    context.undo.inverse(inverseCommand('macro.save', { macro: structuredClone(removed) }, clock));
    context.report({ affected: [], summary: `deleted the macro "${removed.name}"` });
    return { macroId: removed.id };
  };
}

/** The apply, narrowed to the registry's state type (the bus does not type project state; see `commands.ts`'s `narrow`). */
function narrow<P>(apply: MacroApply<P>): CommandApply<P, unknown> {
  return apply as CommandApply<P, unknown>;
}

/** The macro registrations, for the store's registry. */
export function macroCommandRegistrations(options: { readonly clock: MacroClock }): Partial<CommandRegistry> {
  return {
    'macro.save': { descriptor: macroCommands.macroSave, apply: narrow(saveApply(options.clock)) },
    'macro.delete': { descriptor: macroCommands.macroDelete, apply: narrow(deleteApply(options.clock)) },
  };
}
