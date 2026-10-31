/**
 * Bus primitives exposed as tools — [agent-harness.md §3](../../../../docs/architecture/agent-harness.md), "Primitives as
 * deferred tools". The rule that "a primitive is never exposed one-to-one" has one exception: a short allowlist of primitives the
 * agent could not otherwise reach, each a `surface: 'extension'`, `load: 'deferred'` row (docs/decisions.md, owner).
 *
 * **Nothing about a tool's class is written here.** `primitiveTool` reads the command's descriptor, so the tool's risk is the
 * command's `agentRisk` and its undo is the command's `undo`. A tool whose command is `never`, or hard-denied, cannot be built,
 * and `NeverExposed` stops the type from naming one at all. Every call dispatches through the ordinary path (the permission
 * gate, the bus `validate`, the plan card's preview), never through a port's inherited grant.
 */

import {
  COMMAND_REGISTRY,
  VIEW_COMMAND_NAMES,
  hardDenyClass,
  ok,
  type CommandError,
  type CommandName,
  type ExecutionOutcome,
  type Result,
} from '@caotang/bus';

import { failure } from '../errors.js';
import type { ToolRow } from '../metadata.js';
import type { ObjectSpec } from '../schema.js';
import type { CallParams, PrepareContext, PrepareFn } from '../types.js';
import { checkCommand } from './common.js';

/**
 * The commands no tool may stand for: deletes, the document-body writes, the view commands, the staging commands, the external
 * call, the skill and macro commands and the hard-denied names. The list is the source of the type, so naming one in a spec is a compile error
 * (`test/primitive.test.ts` holds the `@ts-expect-error`), and the runtime guard reads the same list.
 */
export const NEVER_EXPOSED = [
  'project.deleteNode',
  'binder.deleteFilter',
  'project.deleteGoal',
  'recipe.delete',
  'vocabulary.remove',
  'coherence.discardRun',
  'coherence.removeKnowledgeFact',
  'doc.write',
  'editor.insert',
  'editor.replaceRange',
  'view.setSelection',
  'view.setActiveDoc',
  'view.setScroll',
  'view.setExpanded',
  'view.setCorkboardScope',
  'project.importAsset',
  'shot.importImage',
  'shot.importImages',
  // The picture registry's imports take bytes the host staged (pictures.md §2.4); the agent's pictures arrive through its own tools (§8).
  'asset.import',
  'asset.importBatch',
  'mcp.invoke',
  // A resource is read when the writer picks it, so no tool stands for the read (extensibility §4 rule 8).
  'mcp.readResource',
  // A skill is an instruction the agent will read later, so the agent never writes one (extensibility §4 rule 7).
  'skill.import',
  'skill.write',
  'skill.delete',
  'skill.setEnabled',
  // A macro is a plan the writer will run later, so the agent never saves or deletes one (extensibility §4 rule 7).
  'macro.save',
  'macro.delete',
  // A hook is a rule the agent is held to, so the agent never saves or deletes one (extensibility §4 rule 7).
  'hook.save',
  'hook.delete',
  // The writer's codex import from the app (codex.md §7.1) lifts codex.import's 20-entry cap; the agent imports through codex.import.
  'codex.importBatch',
  // A memory note is the writer's to forget: hard-denied for an agent as a deletion (command-bus §4).
  'memory.forget',
] as const satisfies readonly CommandName[];

export type NeverExposed = (typeof NEVER_EXPOSED)[number];

/** A command a spec may name. Being exposable is necessary, not sufficient: a spec is still on the allowlist or it is not a tool. */
export type ExposablePrimitive = Exclude<CommandName, NeverExposed>;

/**
 * The first wave (issue #56, owner decision) and the two rows issue #71 names, `memory.write` and `instructions.propose`. A tool joins the
 * allowlist by an owner decision, never by being exposable.
 */
export const PRIMITIVE_TOOL_NAMES = ['notes.replace', 'synopsis.set', 'vocabulary.upsert', 'filter.save', 'goal.save', 'memory.write', 'instructions.propose'] as const;

export type PrimitiveToolName = (typeof PRIMITIVE_TOOL_NAMES)[number];

/** A model-facing tool over one bus command. */
export interface PrimitiveToolSpec<C extends ExposablePrimitive> {
  readonly tool: PrimitiveToolName;
  readonly command: C;
  /** The tool's text. The class sentence ("Requires user confirmation.") is added from the command's risk, never written here. */
  readonly description: string;
  readonly descriptionVersion: number;
  readonly keywords: readonly string[];
  readonly response_token_cap: number;
  /** The model-facing params, closed. Their names are the model's; `toCommand` maps them onto the command's. */
  readonly params: ObjectSpec;
  /** Model params to command params: resolves a title to an id and renames. Pure. The bus `validate` still runs on the result. */
  readonly toCommand: (params: CallParams, context: PrepareContext) => Result<Readonly<Record<string, unknown>>, CommandError>;
  /** What the plan card shows before the command runs, from the command's params. */
  readonly preview?: (command: CallParams, context: PrepareContext) => unknown;
  /** The call's answer from what the bus reported. */
  readonly report: (command: CallParams, outcome: ExecutionOutcome, context: PrepareContext) => { readonly data: Readonly<Record<string, unknown>>; readonly summary: string };
}

export interface PrimitiveTool {
  readonly command: CommandName;
  readonly meta: ToolRow;
  readonly params: ObjectSpec;
  readonly prepare: PrepareFn;
}

const CONFIRM_SENTENCE = 'Requires user confirmation.';
const AUTO_SENTENCE = 'Applies automatically within an approved turn.';

/**
 * Builds a tool from its spec. Throws for a command that is `never`-class, hard-denied or a read, because a tool built on one
 * would either never run or be a different kind of tool. The risk and the undo are the descriptor's.
 */
export function primitiveTool<C extends ExposablePrimitive>(spec: PrimitiveToolSpec<C>): PrimitiveTool {
  const descriptor = COMMAND_REGISTRY[spec.command].descriptor;
  const risk = descriptor.agentRisk;
  if (risk === 'never' || risk === 'read' || hardDenyClass(spec.command) !== undefined) {
    throw new Error(`"${spec.command}" is ${risk}-class or hard-denied, so it cannot be a primitive tool`);
  }
  if ((NEVER_EXPOSED as readonly string[]).includes(spec.command) || (VIEW_COMMAND_NAMES as readonly string[]).includes(spec.command)) {
    throw new Error(`"${spec.command}" is never exposed as a tool`);
  }

  const meta: ToolRow = {
    name: spec.tool,
    risk,
    undoable: descriptor.undo !== 'none',
    response_token_cap: spec.response_token_cap,
    descriptionVersion: spec.descriptionVersion,
    description: `${spec.description} ${risk === 'write-confirm' ? CONFIRM_SENTENCE : AUTO_SENTENCE}`,
    surface: 'extension',
    load: 'deferred',
    keywords: spec.keywords,
  };

  const prepare: PrepareFn = (params, context) => {
    const mapped = spec.toCommand(params, context);
    if (!mapped.ok) return mapped;
    // The bus's own validate, before any effect: a refusal comes back as the bus said it.
    const checked = checkCommand(context, spec.command, mapped.value);
    if (!checked.ok) return failure(checked.error) as Result<never, CommandError>;
    const preview = spec.preview?.(checked.value, context);
    return ok({
      commands: [{ name: spec.command, params: mapped.value }],
      ...(preview === undefined ? {} : { preview }),
      finish: (done) => {
        const outcome = done[0]?.outcome;
        if (outcome === undefined) return failure({ code: 'internal', message: `"${spec.tool}" dispatched nothing`, correctiveHint: 'report this as a defect' });
        const reported = spec.report(checked.value, outcome, context);
        return ok({
          data: reported.data,
          summary: reported.summary,
          affected: [...outcome.affected],
          ...(outcome.undoGroupId === undefined ? {} : { undoGroupId: outcome.undoGroupId }),
        });
      },
    });
  };

  return { command: spec.command, meta, params: spec.params, prepare };
}
