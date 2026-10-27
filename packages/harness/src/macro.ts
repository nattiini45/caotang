/**
 * Macros at run time — [extensibility.md §10](../../../docs/architecture/extensibility.md). A macro is a writer-authored plan template
 * stored in the manifest (`ProjectMacro`, the bus's shape). This file is the half that can see the tool registry, which the bus cannot:
 *
 * - `checkMacro` says whether a macro still fits the registry: each step names a native row, and each placeholder's param can satisfy the
 *   field of the step's tool it stands in. It is pure, and it runs again every time a macro runs, so a hand-edited `caotang.json`, or a
 *   tool whose params changed since the macro was saved, is refused with a message and the macro stays there to be edited.
 * - `expandMacro` substitutes the writer's values for the placeholders (whole values only, never a string) and returns the `Plan` that goes
 *   to `submitPlan`, so a macro's steps are preflighted, carded, gated, ruled and moded as any plan's steps are.
 * - `macroRisk` is the maximum risk over the steps' tools (`read < write-auto < write-confirm`). It is derived, never declared.
 *
 * A macro is not a registry row: there is no `macro.<slug>` tool, the planner is not told of one, and `tool.search` and the MCP server do not
 * list one. Only the writer runs a macro.
 */

import {
  err,
  isMacroPlaceholder,
  ok,
  placeholdersOf,
  readMacro,
  type CommandError,
  type MacroValue,
  type ProjectMacro,
  type Result,
} from '@caotang/bus';

import { invalidParams } from './errors.js';
import type { ToolRisk } from './metadata.js';
import type { Plan, PlanStep } from './plan.js';
import type { ObjectSpec, ParamSpec } from './schema.js';
import { buildEntries } from './tools/table.js';
import { BUILTIN_COMMAND_NAMES } from './commands/slash.js';
import type { CallParams } from './types.js';
import { checkParams } from './validate.js';
import { isRecord } from './util.js';

/** What a macro needs to know of one tool: its risk and its params, as the registry declares them. */
export interface MacroTool {
  readonly name: string;
  readonly risk: ToolRisk;
  readonly params: ObjectSpec;
}

/** The tools a macro may name. The default is the registry's native rows; a test passes its own. */
export interface MacroRegistry {
  tool(name: string): MacroTool | undefined;
}

let shared: MacroRegistry | undefined;

/**
 * The registry's rows a macro may name: native and port rows, with the protocol row (`agent.plan`) and the rows served only to an external
 * host left out. A port row is a tool the app wires; whether this build has wired it is the plan preflight's answer, as for any plan step.
 */
export function registryMacroTools(): MacroRegistry {
  if (shared !== undefined) return shared;
  const entries = new Map<string, MacroTool>();
  for (const [name, entry] of buildEntries()) {
    if (entry.kind === 'protocol' || entry.meta.externalOnly === true) continue;
    entries.set(name, { name, risk: entry.meta.risk, params: entry.params });
  }
  shared = { tool: (name) => entries.get(name) };
  return shared;
}

const RISK_ORDER: Readonly<Record<'read' | 'write-auto' | 'write-confirm', number>> = { read: 0, 'write-auto': 1, 'write-confirm': 2 };

export type MacroRisk = keyof typeof RISK_ORDER;

/** What `checkMacro` knows of a macro that fits: its derived risk and the tools its steps call, in order. */
export interface MacroCheck {
  readonly risk: MacroRisk;
  readonly tools: readonly string[];
}

/** The command name a macro's turn is logged under: `macro-` and the slug, cut to the 32 characters a command name may have. */
export function macroCommandName(slug: string): string {
  return `macro-${slug}`.slice(0, 32);
}

/** Whether a logged command name is a macro's, so a turn resumed from the run log is kept out of the planner as the run that began it was. */
export function isMacroCommand(command: string | undefined): boolean {
  return command?.startsWith('macro-') === true;
}

/** The intent a macro's turn carries, which the panel, the activity list, the run log and the trace show. */
export function macroIntent(macro: Pick<ProjectMacro, 'name'>): string {
  return `Run the macro “${macro.name}”`;
}

/** The refusal for a macro that no longer fits: it names the macro and the step, and says the macro was not run. */
function stale(macro: ProjectMacro, message: string, hint: string, target: string): Result<never, CommandError> {
  return err(invalidParams(`The macro “${macro.name}” cannot run: ${message}`, hint, target));
}

type Fit = { readonly ok: true } | { readonly ok: false; readonly why: string };

const WHERE_FIXED = 'the macro keeps this value fixed, or declares the param as a choice with the same values';

/** Whether one value of the macro's param can satisfy a field of a tool. A param is one string, number, yes/no or choice, never a list or an object. */
function fits(param: ParamSpec, target: ParamSpec): Fit {
  switch (target.kind) {
    case 'string':
      return param.kind === 'string' || param.kind === 'enum' ? { ok: true } : { ok: false, why: `the field takes text and the param is ${describeKind(param)}` };
    case 'enum': {
      if (param.kind === 'enum') {
        const outside = param.values.filter((value) => !target.values.includes(value));
        return outside.length === 0 ? { ok: true } : { ok: false, why: `the field takes one of ${target.values.join(', ')}, and the param also allows ${outside.join(', ')}` };
      }
      return { ok: false, why: `the field takes one of ${target.values.join(', ')}, so declare the param as a choice with some of those values` };
    }
    case 'number':
      return param.kind === 'integer' || param.kind === 'number' ? { ok: true } : { ok: false, why: `the field takes a number and the param is ${describeKind(param)}` };
    case 'integer':
      return param.kind === 'integer' ? { ok: true } : { ok: false, why: `the field takes a whole number and the param is ${describeKind(param)}` };
    case 'boolean':
      return param.kind === 'boolean' ? { ok: true } : { ok: false, why: `the field takes true or false and the param is ${describeKind(param)}` };
    case 'union': {
      const reasons: string[] = [];
      for (const option of target.options) {
        const one = fits(param, option);
        if (one.ok) return one;
        reasons.push(one.why);
      }
      return { ok: false, why: reasons[0] ?? 'the field takes something else' };
    }
    case 'array':
    case 'object':
    case 'free-object':
    case 'tagged':
      return { ok: false, why: `the field takes ${target.kind === 'array' ? 'a list' : 'an object'}, and a param is one value` };
  }
}

function describeKind(param: ParamSpec): string {
  switch (param.kind) {
    case 'string':
      return 'text';
    case 'integer':
      return 'a whole number';
    case 'boolean':
      return 'true or false';
    case 'enum':
      return `a choice (${param.values.join(', ')})`;
    default:
      return 'another kind';
  }
}

/**
 * The spec of the field `value` fills, one level down: the property of an object, the items of a list, the variant a tagged object names
 * with a fixed tag. `undefined` when the spec cannot say (free-form params, or a union with no option of that shape).
 */
function childSpec(spec: ParamSpec | undefined, value: MacroValue, key: string | number): ParamSpec | undefined | 'tag-placeholder' {
  if (spec === undefined) return undefined;
  switch (spec.kind) {
    case 'object':
      return typeof key === 'string' && Object.hasOwn(spec.properties, key) ? spec.properties[key] : undefined;
    case 'array':
      return typeof key === 'number' ? spec.items : undefined;
    case 'tagged': {
      if (typeof key !== 'string' || !isRecord(value)) return undefined;
      const tag = (value as Record<string, MacroValue>)[spec.tag];
      if (isMacroPlaceholder(tag)) return 'tag-placeholder';
      const variant = typeof tag === 'string' && Object.hasOwn(spec.variants, tag) ? spec.variants[tag] : undefined;
      return variant !== undefined && Object.hasOwn(variant.properties, key) ? variant.properties[key] : undefined;
    }
    case 'union': {
      const wanted = Array.isArray(value) ? 'array' : 'object';
      const option = spec.options.find((candidate) => (wanted === 'array' ? candidate.kind === 'array' : candidate.kind === 'object' || candidate.kind === 'tagged'));
      return option === undefined ? undefined : childSpec(option, value, key);
    }
    default:
      return undefined;
  }
}

/**
 * The spec of the field at `path` in a step's params, or `undefined` when the tool does not say (free-form params, a field it does not
 * name, an operation a param would choose). The Save as macro dialog reads it to see what a value the writer marks can be a param of.
 */
export function macroFieldSpec(tool: MacroTool, params: MacroValue, path: readonly (string | number)[]): ParamSpec | undefined {
  let spec: ParamSpec | undefined = tool.params;
  let value: MacroValue = params;
  for (const key of path) {
    const next = childSpec(spec, value, key);
    if (next === 'tag-placeholder') return undefined;
    spec = next;
    const inner: unknown = Array.isArray(value)
      ? (value as readonly MacroValue[])[key as number]
      : isRecord(value) && Object.hasOwn(value, key) ? (value as Record<string, MacroValue>)[key as string] : undefined;
    if (inner === undefined) return undefined;
    value = inner as MacroValue;
  }
  return spec;
}

/** Walks a step's params beside the tool's spec and checks each placeholder where it stands. */
function checkValue(
  value: MacroValue,
  spec: ParamSpec | undefined,
  macro: ProjectMacro,
  where: string,
  index: number,
): Result<null, CommandError> {
  if (isMacroPlaceholder(value)) {
    const param = Object.hasOwn(macro.params.properties, value.$param) ? macro.params.properties[value.$param] : undefined;
    if (param === undefined) {
      return stale(macro, `step ${index + 1} uses the param “${value.$param}”, which the macro does not declare`, 'declare the param, or use a fixed value', where);
    }
    if (spec === undefined) {
      return stale(
        macro,
        `step ${index + 1} puts the param “${value.$param}” in ${where}, where the tool does not say what it takes`,
        'use a fixed value there, or put the param in a field the tool names',
        where,
      );
    }
    const fit = fits(param, spec);
    if (!fit.ok) return stale(macro, `step ${index + 1} puts the param “${value.$param}” in ${where}, but ${fit.why}`, WHERE_FIXED, where);
    return ok(null);
  }
  if (placeholdersOf(value).length === 0 || value === null || typeof value !== 'object') return ok(null);
  const entries: [string | number, MacroValue][] = Array.isArray(value)
    ? (value as readonly MacroValue[]).map((item, at) => [at, item])
    : Object.entries(value as Record<string, MacroValue>);
  for (const [key, child] of entries) {
    const next = childSpec(spec, value, key);
    if (next === 'tag-placeholder') {
      return stale(macro, `step ${index + 1} lets a param choose the operation in ${where}`, 'the operation is fixed in the macro; only the values may be params', where);
    }
    const checked = checkValue(child, next, macro, typeof key === 'number' ? `${where}[${key}]` : `${where}.${key}`, index);
    if (!checked.ok) return checked;
  }
  return ok(null);
}

/**
 * Whether a macro fits the registry now. Pure, and run again by every `expandMacro`.
 *
 * It first reads the macro with the bus's own structural reader, so a macro that was edited by hand and slipped past the load (or never
 * went through it) is refused for what the bus refuses. Then, for each step: the tool exists and is a native row, and each placeholder's
 * param can satisfy the field it stands in. A slug that is a built-in slash command's name is refused, so a macro never shadows `/draft`.
 */
export function checkMacro(macro: ProjectMacro, tools: MacroRegistry = registryMacroTools()): Result<MacroCheck, CommandError> {
  const read = readMacro(macro, true);
  if (!read.ok) return err({ ...read.error, message: `The macro “${String((macro as { name?: unknown }).name ?? 'macro')}” cannot run: ${read.error.message}` });
  if ((BUILTIN_COMMAND_NAMES as readonly string[]).includes(macro.slug)) {
    return stale(macro, `its slug “${macro.slug}” is the name of a built-in command`, 'give the macro another slug', 'slug');
  }
  let risk: MacroRisk = 'read';
  const names: string[] = [];
  for (const [index, step] of macro.steps.entries()) {
    const tool = tools.tool(step.tool);
    if (tool === undefined) {
      return stale(macro, `step ${index + 1} names “${step.tool}”, which is not a tool in this build`, 'change the step to a tool this build has, or drop it', `steps[${index}].tool`);
    }
    if (tool.risk === 'meta') {
      return stale(macro, `step ${index + 1} names “${step.tool}”, which is not a tool a step can call`, 'drop the step', `steps[${index}].tool`);
    }
    const checked = checkValue(step.params, tool.params, macro, `steps[${index}].params`, index);
    if (!checked.ok) return checked;
    if (RISK_ORDER[tool.risk] > RISK_ORDER[risk]) risk = tool.risk;
    names.push(step.tool);
  }
  return ok({ risk, tools: names });
}

/** The maximum risk over the steps' tools, or the refusal `checkMacro` gives. */
export function macroRisk(macro: ProjectMacro, tools: MacroRegistry = registryMacroTools()): Result<MacroRisk, CommandError> {
  const checked = checkMacro(macro, tools);
  return checked.ok ? ok(checked.value.risk) : checked;
}

/** The values a run is given, with each param's default filled in where the writer gave none. */
function withDefaults(macro: ProjectMacro, given: CallParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(macro.params.properties)) {
    const spec = macro.params.properties[name] as ParamSpec;
    const value = Object.hasOwn(given, name) ? given[name] : undefined;
    if (value !== undefined) out[name] = value;
    else if ('default' in spec && spec.default !== undefined) out[name] = spec.default;
  }
  // A key the macro does not declare is kept, so the closed-set check names it.
  for (const name of Object.keys(given)) if (!Object.hasOwn(macro.params.properties, name) && given[name] !== undefined) out[name] = given[name];
  return out;
}

/** A copy of a value the writer gave, so the plan holds no reference into the form that made it. */
function copyOf(value: unknown): unknown {
  return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown);
}

/** Fills the placeholders of one step's params. An optional param the writer left out drops its key. */
function substitute(value: MacroValue, given: Record<string, unknown>, macro: ProjectMacro, where: string): Result<unknown, CommandError> {
  if (isMacroPlaceholder(value)) return ok(copyOf(given[value.$param]));
  if (value === null || typeof value !== 'object') return ok(value);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const [at, item] of (value as readonly MacroValue[]).entries()) {
      const filled = substitute(item, given, macro, `${where}[${at}]`);
      if (!filled.ok) return filled;
      if (filled.value === undefined) {
        return err(invalidParams(`The macro “${macro.name}” cannot run: ${where}[${at}] needs the param “${(item as { $param: string }).$param}”, and none was given`, 'give the param a value', where));
      }
      out.push(filled.value);
    }
    return ok(out);
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, MacroValue>)) {
    const filled = substitute(item, given, macro, `${where}.${key}`);
    if (!filled.ok) return filled;
    if (filled.value !== undefined) out[key] = filled.value;
  }
  return ok(out);
}

/**
 * The plan a macro runs as, for the values the writer gave. Pure. It re-runs `checkMacro` and checks the values against the macro's own
 * param spec (a missing required param, a value of the wrong kind, a key the macro does not declare), so nothing reaches `submitPlan`
 * that a save-time check alone vouched for. The steps' own params are checked later, by each tool's `prepare`, in the plan's preflight.
 */
export function expandMacro(macro: ProjectMacro, params: CallParams = {}, tools: MacroRegistry = registryMacroTools()): Result<Plan, CommandError> {
  const checked = checkMacro(macro, tools);
  if (!checked.ok) return checked;
  const given = checkParams(`the macro “${macro.name}”`, macro.params, withDefaults(macro, params));
  if (!given.ok) return given;
  const steps: PlanStep[] = [];
  for (const [index, step] of macro.steps.entries()) {
    const filled = substitute(step.params, given.value, macro, `steps[${index}].params`);
    if (!filled.ok) return filled;
    steps.push({ tool: step.tool, params: filled.value as CallParams, expect: step.expect });
  }
  return ok({ steps });
}
