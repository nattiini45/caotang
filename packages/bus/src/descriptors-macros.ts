/**
 * Macros: the descriptors of the two commands that change a project's `macros[]` (extensibility.md §10). Their applies are the store's
 * (`packages/store/src/commands-macros.ts`), reached through the same registry as the rest of the closed set (`registry.ts`).
 *
 * **Both are `agentRisk: 'never'`.** A macro is a plan the writer will run later, so an agent that could save or delete one would be
 * writing its own plans (extensibility §4 rule 7). The writer does both from the Macros panel or a plan card, and the harness's
 * allowlist of primitives does not name them.
 *
 * Validation is structural, because the bus cannot see the tool registry (the harness depends on the bus): the shape, the caps, the tools
 * a macro may never name, and the placeholders it declares (`macro-rules.ts`). That the named tools exist, and that a placeholder's type
 * fits a step's tool, is the harness's `checkMacro`, which the Macros panel runs before it dispatches `macro.save`.
 */

import type { CommandDescriptor, MacroDeleteParams, MacroSaveParams } from './command.js';
import { MACROS_MAX, isMacroId, readMacro } from './macro-rules.js';
import { invalid, limitExceeded, notFound, requireDeclaredParams, showValue } from './params.js';
import { ok } from './result.js';

export const macroSave: CommandDescriptor<MacroSaveParams> = {
  mutates: 'project',
  agentRisk: 'never',
  undo: 'inverse',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('macro.save', params);
    if (!p.ok) return p;
    const read = readMacro(p.value['macro'], false);
    if (!read.ok) return read;
    const held = snapshot.manifest.macros ?? [];
    const taken = held.find((macro) => macro.slug === read.value.slug && macro.id !== read.value.id);
    if (taken !== undefined) {
      return invalid(`another macro already has the slug "${read.value.slug}"`, 'give this macro its own slug, or change the other one', 'macro.slug');
    }
    if (!held.some((macro) => macro.id === read.value.id) && held.length >= MACROS_MAX) {
      return limitExceeded(`a project holds at most ${MACROS_MAX} macros`, 'delete a macro before saving another', 'macro');
    }
    return ok({ macro: read.value });
  },
};

export const macroDelete: CommandDescriptor<MacroDeleteParams> = {
  mutates: 'project',
  agentRisk: 'never',
  undo: 'inverse',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('macro.delete', params);
    if (!p.ok) return p;
    const macroId = p.value['macroId'];
    if (!isMacroId(macroId)) {
      return invalid(`${showValue(macroId)} is not a macro id`, 'a macro id is m_ followed by 10 base32 characters; the macros are listed in Settings', 'macroId');
    }
    if (!(snapshot.manifest.macros ?? []).some((macro) => macro.id === macroId)) {
      return notFound(`no macro with id "${macroId}"`, 'the macro may already be deleted; the macros are listed in Settings', 'macroId');
    }
    return ok({ macroId });
  },
};

/** The macro descriptors by name, for the registry and for a test that reads them as a set. */
export const MACRO_DESCRIPTORS = {
  'macro.save': macroSave,
  'macro.delete': macroDelete,
} as const;
