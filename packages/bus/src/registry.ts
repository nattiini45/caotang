/**
 * The registry — one lookup, descriptor and implementation side by side.
 *
 * [command-bus.md §9](docs/architecture/command-bus.md) closes the v0.1 name
 * set; docs/decisions.md decided what an entry in it
 * *is*: one record holding a descriptor and an implementation together, both
 * reachable from one lookup, with the descriptor-only state **representable**
 * because `export.compile`'s effect is seven milestones away — and made *safe*
 * by `resolveCommand` refusing that state loudly.
 *
 * Three shapes were rejected there and the reasons still hold:
 *   - `apply` inside `CommandDescriptor` — puts a stateful effect on the object
 *     the harness pre-validates, next to §2's pure `validate`.
 *   - two maps, one for descriptors and one for implementations — makes the
 *     half-built state easy to create and splits §9's 18 names into two sets
 *     that can disagree.
 *   - omitting `export.compile` until an exporter exists — makes §9's closed set a
 *     lie in the one file whose job is to be the closed set. (Both export names are
 *     in that position: `export.compile` and `export.compileSelection` — the
 *     whole-manuscript / a-part split.)
 */

import { err, ok, type CommandError, type Result } from './result.js';
import { COMMAND_NAMES, type CommandName, type CommandRegistry } from './command.js';
import * as descriptors from './descriptors.js';
import * as projectDescriptors from './descriptors-project.js';
import * as furnitureDescriptors from './descriptors-furniture.js';
import {
  coherenceAddKnowledgeFact,
  coherenceDiscardRun,
  coherenceEditKnowledgeFact,
  coherenceRemoveKnowledgeFact,
} from './descriptors-coherence.js';
import * as shotImageDescriptors from './descriptors-shot-image.js';
import * as scriptDescriptors from './descriptors-script.js';
import * as skillDescriptors from './descriptors-skills.js';
import {
  viewSetActiveDocApply,
  viewSetCorkboardScopeApply,
  viewSetExpandedApply,
  viewSetScrollApply,
  viewSetSelectionApply,
} from './view.js';
import { HINT_READ_TREE } from './params.js';

/**
 * The table. `CommandRegistry` is a mapped type over the closed set, so a name
 * in `COMMAND_NAMES` with no entry here is a **compile error** — the set cannot
 * drift open without the type system noticing, and a name here that §9 does not
 * list fails the spec-parity test in `test/registry.test.ts`.
 *
 * Every entry is `{ descriptor }` with no `apply` **except the three `view.*`
 * names**: §2 defines their effect as ephemeral view state, so
 * they are the one family that needs no store and the pipeline's non-vacuous
 * case. **The other fifteen will never have an apply in this file**, and that is
 * a property of the package rather than a phase: §1 says the bus does not own
 * project state, so a project apply needs a `state` the bus cannot be handed.
 * The five `inverse` names live in `packages/store/src/commands.ts`
 * and the store hands them over through `createProjectCommandRegistry()`, which
 * `execute()` takes as its third parameter; the `compensable` text family and
 * The `codex.upsert` + `project.deleteNode` follow the same route. So for those
 * names `resolveCommand`'s refusal below is the **correct** answer, not a gap —
 * and it is what an app that forgets to substitute the registry sees.
 */
export function buildRegistry(): CommandRegistry {
  return {
    'binder.create': { descriptor: descriptors.binderCreate },
    'binder.move': { descriptor: descriptors.binderMove },
    'binder.rename': { descriptor: descriptors.binderRename },
    'binder.setMeta': { descriptor: descriptors.binderSetMeta },
    'binder.setSynopsis': { descriptor: descriptors.binderSetSynopsis },
    'notes.set': { descriptor: descriptors.notesSet },
    'notes.append': { descriptor: descriptors.notesAppend },
    'doc.write': { descriptor: descriptors.docWrite },
    'editor.insert': { descriptor: descriptors.editorInsert },
    'editor.replaceRange': { descriptor: descriptors.editorReplaceRange },
    'codex.upsert': { descriptor: descriptors.codexUpsert },
    'codex.attach': { descriptor: descriptors.codexAttach },
    'export.compile': { descriptor: descriptors.exportCompile },
    'export.compileSelection': { descriptor: descriptors.exportCompileSelection },
    'project.deleteNode': { descriptor: descriptors.projectDeleteNode },
    'view.setSelection': { descriptor: descriptors.viewSetSelection, apply: viewSetSelectionApply },
    'view.setActiveDoc': { descriptor: descriptors.viewSetActiveDoc, apply: viewSetActiveDocApply },
    'view.setScroll': { descriptor: descriptors.viewSetScroll, apply: viewSetScrollApply },
    'view.setExpanded': { descriptor: descriptors.viewSetExpanded, apply: viewSetExpandedApply },
    'view.setCorkboardScope': {
      descriptor: descriptors.viewSetCorkboardScope,
      apply: viewSetCorkboardScopeApply,
    },
    // The coherence file is project state, so its two applies live in the store with the
    // rest of the project's (`createProjectCommandRegistry`), and this file carries only the descriptors.
    'coherence.setSceneMeta': { descriptor: descriptors.coherenceSetSceneMeta },
    'coherence.setFindingStatus': { descriptor: descriptors.coherenceSetFindingStatus },
    // The run history's removal. Its descriptor is in descriptors-coherence.ts, its apply in the store (commands-coherence.ts).
    'coherence.discardRun': { descriptor: coherenceDiscardRun },
    // The knowledge facts. Descriptors in descriptors-coherence.ts, applies in the store (commands-coherence.ts).
    'coherence.addKnowledgeFact': { descriptor: coherenceAddKnowledgeFact },
    'coherence.editKnowledgeFact': { descriptor: coherenceEditKnowledgeFact },
    'coherence.removeKnowledgeFact': { descriptor: coherenceRemoveKnowledgeFact },
    // The external-call command. Descriptor only: its apply reaches a server, so the store
    // registry injects it with the client's own descriptor (`ProjectCommandOptions.mcpInvoke`).
    'mcp.invoke': { descriptor: descriptors.mcpInvoke },
    // The storyboard module's shot commands (storyboard.md §3.1). Descriptors here; the applies are
    // the store registry's, injected with the storyboard module's guards (`ProjectCommandOptions.shots`).
    'storyboard.create': { descriptor: descriptors.storyboardCreate },
    'shot.create': { descriptor: descriptors.shotCreate },
    'shot.setMeta': { descriptor: descriptors.shotSetMeta },
    // The project block, the saved recipes, the vocabulary and the cover import. Descriptors here; the applies are
    // the store's (`createProjectCommandRegistry`, commands-project.ts), and `project.importAsset` needs its staged bytes.
    'project.rename': { descriptor: projectDescriptors.projectRename },
    'project.setMetadata': { descriptor: projectDescriptors.projectSetMetadata },
    'project.importAsset': { descriptor: projectDescriptors.projectImportAsset },
    'vocabulary.upsert': { descriptor: projectDescriptors.vocabularyUpsert },
    'vocabulary.remove': { descriptor: projectDescriptors.vocabularyRemove },
    'recipe.save': { descriptor: projectDescriptors.recipeSave },
    'recipe.delete': { descriptor: projectDescriptors.recipeDelete },
    // The saved-filter and project-goal descriptors (binder-filters §5, goals-progress §4). The applies
    // are the store's, injected through `createProjectCommandRegistry`, so these are descriptor-only here.
    'binder.saveFilter': { descriptor: furnitureDescriptors.binderSaveFilter },
    'binder.deleteFilter': { descriptor: furnitureDescriptors.binderDeleteFilter },
    'project.saveGoal': { descriptor: furnitureDescriptors.projectSaveGoal },
    'project.deleteGoal': { descriptor: furnitureDescriptors.projectDeleteGoal },
    // Storyboard: the shot's image import. Descriptor only; its apply is the store's (`commands-shot-image.ts`).
    'shot.importImage': { descriptor: shotImageDescriptors.shotImportImage },
    // The two imports and the container settings (screenplay.md §2.2, dialogue-narrative.md §2.1, §4). The applies
    // are the store's (`commands-script.ts`), injected through `createProjectCommandRegistry`, so these are descriptor-only here.
    'screenplay.import': { descriptor: scriptDescriptors.screenplayImport },
    'dialogue.importInk': { descriptor: scriptDescriptors.dialogueImportInk },
    'dialogue.setMeta': { descriptor: scriptDescriptors.dialogueSetMeta },
    // The project's skills (extensibility.md §10). User-only: every descriptor is `agentRisk: 'never'`. The applies are the store's
    // (`commands-skills.ts`), and `skill.import` is registered only when the host injects its staging.
    'skill.import': { descriptor: skillDescriptors.skillImport },
    'skill.write': { descriptor: skillDescriptors.skillWrite },
    'skill.delete': { descriptor: skillDescriptors.skillDelete },
    'skill.setEnabled': { descriptor: skillDescriptors.skillSetEnabled },
  };
}

export const COMMAND_REGISTRY: CommandRegistry = buildRegistry();

/** What `resolveIn` hands back: the entry, with the `apply` its own check proved is there. */
export type ResolvedRegistration<K extends CommandName> = CommandRegistry[K] & {
  readonly apply: NonNullable<CommandRegistry[K]['apply']>;
};

export function isCommandName(value: string): value is CommandName {
  return (COMMAND_NAMES as readonly string[]).includes(value);
}

/** The registered names, in §9's order. */
export function registeredNames(): CommandName[] {
  return [...COMMAND_NAMES];
}

/**
 * One lookup, for anything that needs to *know* a command: the harness
 * pre-validating a plan reads descriptors only, and an entry is returned whether
 * or not its effect has landed.
 *
 * The registry is a parameter so `execute()` can run the same pipeline over
 * a registration that exists; the returned type is `CommandRegistry[K]`, which
 * carries **the state type that name's own apply takes** — `ViewState` for a
 * `view.*` name, `unknown` for the fifteen the bus does not type.
 */
export function lookupIn<K extends CommandName>(
  registry: CommandRegistry,
  name: K,
): Result<CommandRegistry[K], CommandError> {
  if (!isCommandName(name)) {
    return err({
      code: 'not-found',
      message: `"${name}" is not a v0.1 command`,
      target: name,
      correctiveHint: `valid v0.1 commands: ${COMMAND_NAMES.join(', ')}`,
    });
  }
  return ok(registry[name]);
}

export function lookupCommand<K extends CommandName>(
  name: K,
): Result<CommandRegistry[K], CommandError> {
  return lookupIn(COMMAND_REGISTRY, name);
}

/**
 * The dispatch gate. A dispatch must go through here, and a registered name with
 * no implementation is **refused with a model-facing error** rather than
 * dispatched, crashed on, or half-run (docs/decisions.md
 * acceptance criterion; Delegated 3 for `export.compile`).
 *
 * §7's two rules are load-bearing on this path and are tested as such: the
 * message is prose naming the command, never a bare code, and it states that
 * nothing was written — §3's "failure at any step aborts with zero partial
 * effects", which is the property a caller actually has to trust.
 *
 * **`ResolvedRegistration` rather than the bare entry**, because the whole point
 * of resolving is that an `apply` exists: returning the optional field as-is
 * would force every caller — `execute()` included — to re-check what this
 * function just checked.
 */
export function resolveIn<K extends CommandName>(
  registry: CommandRegistry,
  name: K,
): Result<ResolvedRegistration<K>, CommandError> {
  const found = lookupIn(registry, name);
  if (!found.ok) return found;
  if (found.value.apply === undefined) {
    return err({
      code: 'internal',
      message: `"${name}" is registered but has no implementation in this build, so the bus refused it. It was not dispatched and nothing was written.`,
      target: name,
      correctiveHint: `do not retry ${name} — tell the user this action is not available in this build, and report what you set out to do instead`,
    });
  }
  return ok(found.value as ResolvedRegistration<K>);
}

export function resolveCommand<K extends CommandName>(
  name: K,
): Result<ResolvedRegistration<K>, CommandError> {
  return resolveIn(COMMAND_REGISTRY, name);
}

export { HINT_READ_TREE };
