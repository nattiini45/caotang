/**
 * Macros: the shape and the structural rules both the bus and the store state — [command-bus.md §9](../../../docs/architecture/command-bus.md),
 * [project-format.md §2](../../../docs/architecture/project-format.md), [extensibility.md §10](../../../docs/architecture/extensibility.md).
 *
 * A macro is a writer-authored plan template: JSON data over tools the registry already has, with whole-value `{ "$param": name }`
 * placeholders. It carries no code. The bus owns this module because `macro.save` has to refuse a malformed macro before any effect, and
 * the store (which depends on the bus) reads the same checks when it loads `macros[]`. The bus cannot see the tool registry (the harness
 * depends on the bus), so everything here is structural: names, caps, which tools a macro may never name, and which placeholders the macro
 * declares. Whether a named tool exists, and whether a placeholder's type fits the step's tool, is the harness's `checkMacro`.
 */

import type { ObjectSpec, ParamSpec } from './tool-schema.js';
import { invalidError, limitExceededError, isRecord } from './params.js';
import { err, ok, type CommandError, type Result } from './result.js';

/** Steps in one macro: the same ceiling as a plan (`PLAN_STEPS_MAX`, held equal by a harness test) and `binder.restructure`. */
export const MACRO_STEPS_MAX = 30;
/** Macros in one project. */
export const MACROS_MAX = 50;
export const MACRO_NAME_MAX = 60;
/** Shown as plain text. */
export const MACRO_DESCRIPTION_MAX = 600;
export const MACRO_SLUG_MAX = 40;
export const MACRO_PARAMS_MAX = 12;
export const MACRO_PARAM_NAME_MAX = 40;
export const MACRO_EXPECT_MAX = 300;
/** One macro's JSON, in characters. */
export const MACRO_SIZE_MAX = 24_000;
/** How deep a step's params nest, and how many values one macro holds, so a hostile file cannot make a walk long. */
export const MACRO_DEPTH_MAX = 8;
export const MACRO_NODES_MAX = 2_000;

/** A whole value taken from the macro's param of that name when the macro runs. Never part of a string. */
export interface MacroPlaceholder {
  readonly $param: string;
}

export type MacroValue =
  | string
  | number
  | boolean
  | null
  | MacroPlaceholder
  | readonly MacroValue[]
  | { readonly [key: string]: MacroValue };

export interface MacroStep {
  /** A registry tool name. Never `agent.plan`, `tool.search`, `mcp__*` or `macro.*`. */
  readonly tool: string;
  readonly params: { readonly [key: string]: MacroValue };
  /** The effect the step should have, shown on the card. */
  readonly expect: string;
}

export interface ProjectMacro {
  /** "m_" + 10 Crockford base32, minted once. */
  readonly id: string;
  /** `[a-z0-9-]{1,40}`: how the macro is named in a command and a log. */
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  /** The macro's own params: an `ObjectSpec` limited to string, integer, boolean and enum fields. */
  readonly params: ObjectSpec;
  readonly steps: readonly MacroStep[];
}

/** A macro as `macro.save` takes it: the store mints the id when there is none. */
export type MacroDraft = Omit<ProjectMacro, 'id'> & { readonly id?: string };

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MACRO_KEYS = ['id', 'slug', 'name', 'description', 'params', 'steps'] as const;
/** A key that would reach an object's prototype if it were ever copied by assignment. Refused wherever a key can appear. */
const FORBIDDEN_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];
const PARAM_KINDS: readonly string[] = ['string', 'integer', 'boolean', 'enum'];
const ENUM_VALUES_MAX = 20;
const ENUM_VALUE_MAX = 80;
const SPEC_DESCRIPTION_MAX = 200;
const STRING_LENGTH_MAX = 2_000;

/** Whether `value` is a macro id: `m_` and ten Crockford characters. Scanned, not matched by a pattern. */
export function isMacroId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 12 || !value.startsWith('m_')) return false;
  for (let i = 2; i < value.length; i += 1) if (!CROCKFORD.includes(value.charAt(i))) return false;
  return true;
}

/** Whether `value` is a slug: 1 to 40 lower-case letters, digits and hyphens. */
export function isMacroSlug(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MACRO_SLUG_MAX) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const allowed = (code >= 48 && code <= 57) || (code >= 97 && code <= 122) || code === 45;
    if (!allowed) return false;
  }
  return true;
}

/** A param name: a letter, then letters, digits and underscores. */
export function isMacroParamName(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MACRO_PARAM_NAME_MAX) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const digitOrUnderscore = (code >= 48 && code <= 57) || code === 95;
    if (i === 0 ? !letter : !letter && !digitOrUnderscore) return false;
  }
  return true;
}

/** Why a macro may not name this tool, or `undefined` when its name is allowed. Whether the tool exists is the harness's check. */
export function macroToolProblem(tool: string): string | undefined {
  if (tool === 'agent.plan') return '"agent.plan" is the plan protocol, not a tool a step can call';
  if (tool === 'tool.search') return '"tool.search" is the model\'s way to find tools, and a macro already names its tools';
  if (tool.startsWith('mcp__')) return `"${tool}" is an external tool, and a macro names only the app's own tools`;
  if (tool.startsWith('macro.')) return `"${tool}" is a macro, and a macro does not run another macro`;
  return undefined;
}

const codePoints = (text: string): number => [...text].length;

function invalid(message: string, hint: string, target: string): Result<never, CommandError> {
  return err(invalidError(message, hint, target));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** A closed key set: the first key outside `allowed` is the refusal. */
function unknownKey(value: Record<string, unknown>, allowed: readonly string[], at: string): Result<never, CommandError> | undefined {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.includes(key)) return invalid(`${at} has a "${key}" key, which a macro never holds`, `remove the "${key}" key`, `${at}.${key}`);
    if (!allowed.includes(key)) {
      const hint = key === 'script' ? 'script macros are not supported in this build' : `${at} carries only: ${allowed.join(', ')}`;
      return invalid(`${at}.${key} is not a macro field`, hint, `${at}.${key}`);
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * The macro's own params
 * ------------------------------------------------------------------ */

function readSpecDescription(raw: Record<string, unknown>, at: string): Result<string, CommandError> {
  const description = raw['description'];
  if (typeof description !== 'string') return invalid(`${at}.description must be a string`, 'say in a few words what the value is', `${at}.description`);
  if (codePoints(description) > SPEC_DESCRIPTION_MAX) {
    return invalid(`${at}.description is longer than ${SPEC_DESCRIPTION_MAX} characters`, 'shorten it', `${at}.description`);
  }
  return ok(description);
}

function readInteger(raw: Record<string, unknown>, key: string, at: string): Result<number | undefined, CommandError> {
  const value = raw[key];
  if (value === undefined) return ok(undefined);
  if (!Number.isSafeInteger(value)) return invalid(`${at}.${key} must be a whole number`, 'pass a whole number or leave it out', `${at}.${key}`);
  return ok(value as number);
}

function readPropertySpec(raw: unknown, at: string): Result<ParamSpec, CommandError> {
  if (!isPlainObject(raw)) return invalid(`${at} must be an object`, 'declare the param with a kind and a description', at);
  const kind = raw['kind'];
  if (typeof kind !== 'string' || !PARAM_KINDS.includes(kind)) {
    return invalid(`${at}.kind must be one of: ${PARAM_KINDS.join(', ')}`, 'a macro param is a string, a whole number, a yes/no or one of a few choices', `${at}.kind`);
  }
  const extras: Record<string, readonly string[]> = {
    string: ['kind', 'description', 'nonBlank', 'maxLength', 'default'],
    integer: ['kind', 'description', 'minimum', 'maximum', 'default'],
    boolean: ['kind', 'description', 'default'],
    enum: ['kind', 'description', 'values', 'default'],
  };
  const refused = unknownKey(raw, extras[kind] as readonly string[], at);
  if (refused !== undefined) return refused;
  const description = readSpecDescription(raw, at);
  if (!description.ok) return description;
  const def = raw['default'];

  if (kind === 'boolean') {
    if (def !== undefined && typeof def !== 'boolean') return invalid(`${at}.default must be true or false`, 'pass true or false', `${at}.default`);
    return ok({ kind: 'boolean', description: description.value, ...(def === undefined ? {} : { default: def }) });
  }
  if (kind === 'integer') {
    const minimum = readInteger(raw, 'minimum', at);
    if (!minimum.ok) return minimum;
    const maximum = readInteger(raw, 'maximum', at);
    if (!maximum.ok) return maximum;
    if (minimum.value !== undefined && maximum.value !== undefined && minimum.value > maximum.value) {
      return invalid(`${at}.minimum is above ${at}.maximum`, 'swap them', at);
    }
    if (def !== undefined && !Number.isSafeInteger(def)) return invalid(`${at}.default must be a whole number`, 'pass a whole number', `${at}.default`);
    return ok({
      kind: 'integer',
      description: description.value,
      ...(minimum.value === undefined ? {} : { minimum: minimum.value }),
      ...(maximum.value === undefined ? {} : { maximum: maximum.value }),
      ...(def === undefined ? {} : { default: def as number }),
    });
  }
  if (kind === 'string') {
    const nonBlank = raw['nonBlank'];
    if (nonBlank !== undefined && typeof nonBlank !== 'boolean') return invalid(`${at}.nonBlank must be true or false`, 'pass true or false', `${at}.nonBlank`);
    const maxLength = readInteger(raw, 'maxLength', at);
    if (!maxLength.ok) return maxLength;
    if (maxLength.value !== undefined && (maxLength.value < 1 || maxLength.value > STRING_LENGTH_MAX)) {
      return invalid(`${at}.maxLength must be from 1 to ${STRING_LENGTH_MAX}`, 'pass a smaller limit', `${at}.maxLength`);
    }
    if (def !== undefined && typeof def !== 'string') return invalid(`${at}.default must be a string`, 'pass a string', `${at}.default`);
    return ok({
      kind: 'string',
      description: description.value,
      ...(nonBlank === true ? { nonBlank: true } : {}),
      ...(maxLength.value === undefined ? {} : { maxLength: maxLength.value }),
      ...(def === undefined ? {} : { default: def as string }),
    });
  }
  const values = raw['values'];
  if (!Array.isArray(values) || values.length === 0 || values.length > ENUM_VALUES_MAX) {
    return invalid(`${at}.values must list from 1 to ${ENUM_VALUES_MAX} choices`, 'list the choices as strings', `${at}.values`);
  }
  for (const value of values as unknown[]) {
    if (typeof value !== 'string' || value === '' || value.length > ENUM_VALUE_MAX) {
      return invalid(`${at}.values holds a choice that is not a short string`, `a choice is a string of 1 to ${ENUM_VALUE_MAX} characters`, `${at}.values`);
    }
  }
  if (new Set(values as string[]).size !== values.length) return invalid(`${at}.values repeats a choice`, 'list each choice once', `${at}.values`);
  if (def !== undefined && !(values as unknown[]).includes(def)) return invalid(`${at}.default is not one of the choices`, 'pick one of the values', `${at}.default`);
  return ok({ kind: 'enum', description: description.value, values: [...(values as string[])], ...(def === undefined ? {} : { default: def as string }) });
}

function readParamSpec(raw: unknown): Result<ObjectSpec, CommandError> {
  const at = 'macro.params';
  if (!isPlainObject(raw)) return invalid(`${at} must be an object spec`, 'pass { kind: "object", description, properties, required }', at);
  const refused = unknownKey(raw, ['kind', 'description', 'properties', 'required'], at);
  if (refused !== undefined) return refused;
  if (raw['kind'] !== 'object') return invalid(`${at}.kind must be "object"`, 'the macro\'s params are one object', `${at}.kind`);
  const description = readSpecDescription(raw, at);
  if (!description.ok) return description;
  const properties = raw['properties'];
  if (!isPlainObject(properties)) return invalid(`${at}.properties must be an object`, 'pass {} for a macro with no params', `${at}.properties`);
  const names = Object.keys(properties);
  if (names.length > MACRO_PARAMS_MAX) {
    return err(limitExceededError(`a macro takes at most ${MACRO_PARAMS_MAX} params`, 'fold some into the steps', `${at}.properties`));
  }
  const out: Record<string, ParamSpec> = {};
  for (const name of names) {
    if (FORBIDDEN_KEYS.includes(name) || !isMacroParamName(name)) {
      return invalid(`"${name}" is not a param name`, `a param name starts with a letter and holds letters, digits and underscores, up to ${MACRO_PARAM_NAME_MAX}`, `${at}.properties`);
    }
    const spec = readPropertySpec(properties[name], `${at}.properties.${name}`);
    if (!spec.ok) return spec;
    out[name] = spec.value;
  }
  const required = raw['required'];
  if (!Array.isArray(required)) return invalid(`${at}.required must be a list`, 'pass [] when no param is required', `${at}.required`);
  for (const name of required as unknown[]) {
    if (typeof name !== 'string' || !names.includes(name)) {
      return invalid(`${at}.required names "${String(name)}", which is not a declared param`, 'require only the params you declare', `${at}.required`);
    }
  }
  if (new Set(required as string[]).size !== required.length) return invalid(`${at}.required repeats a name`, 'name each param once', `${at}.required`);
  return ok({ kind: 'object', description: description.value, properties: out, required: [...(required as string[])] });
}

/* ------------------------------------------------------------------ *
 * The steps
 * ------------------------------------------------------------------ */

interface Walk {
  nodes: number;
  readonly declared: ReadonlySet<string>;
}

function readValue(raw: unknown, at: string, depth: number, walk: Walk): Result<MacroValue, CommandError> {
  walk.nodes += 1;
  if (walk.nodes > MACRO_NODES_MAX) return err(limitExceededError(`a macro holds at most ${MACRO_NODES_MAX} values`, 'split it into two macros', at));
  if (raw === null || typeof raw === 'string' || typeof raw === 'boolean') return ok(raw);
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? ok(raw) : invalid(`${at} is not a finite number`, 'pass a number JSON can hold', at);
  }
  if (depth >= MACRO_DEPTH_MAX) return invalid(`${at} nests deeper than ${MACRO_DEPTH_MAX} levels`, 'flatten the step\'s params', at);
  if (Array.isArray(raw)) {
    const out: MacroValue[] = [];
    for (const [index, item] of (raw as unknown[]).entries()) {
      const value = readValue(item, `${at}[${index}]`, depth + 1, walk);
      if (!value.ok) return value;
      out.push(value.value);
    }
    return ok(out);
  }
  if (!isPlainObject(raw)) return invalid(`${at} is not a value JSON can hold`, 'use strings, numbers, true or false, null, lists and objects', at);
  if (Object.keys(raw).includes('$param')) {
    if (Object.keys(raw).length !== 1 || typeof raw['$param'] !== 'string') {
      return invalid(`${at} mixes "$param" with other keys, or names it with a non-string`, 'a placeholder is exactly { "$param": "name" }', at);
    }
    const name = raw['$param'];
    if (!walk.declared.has(name)) {
      return invalid(`${at} uses the param "${name}", which the macro does not declare`, 'declare it in params.properties, or use a fixed value', at);
    }
    return ok({ $param: name });
  }
  const out: Record<string, MacroValue> = {};
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_KEYS.includes(key)) return invalid(`${at} has a "${key}" key, which a macro never holds`, `remove the "${key}" key`, `${at}.${key}`);
    const value = readValue(raw[key], `${at}.${key}`, depth + 1, walk);
    if (!value.ok) return value;
    out[key] = value.value;
  }
  return ok(out);
}

function readStep(raw: unknown, index: number, walk: Walk): Result<MacroStep, CommandError> {
  const at = `macro.steps[${index}]`;
  if (!isPlainObject(raw)) return invalid(`${at} must be an object`, 'a step is { tool, params, expect }', at);
  const refused = unknownKey(raw, ['tool', 'params', 'expect'], at);
  if (refused !== undefined) return refused;
  const tool = raw['tool'];
  if (typeof tool !== 'string' || tool.trim() === '' || tool.length > 100) {
    return invalid(`${at}.tool must name a tool`, 'a step names a tool by its registry name', `${at}.tool`);
  }
  const forbidden = macroToolProblem(tool);
  if (forbidden !== undefined) return invalid(`${at}: ${forbidden}`, 'drop the step, or use a tool of the app\'s own', `${at}.tool`);
  const expect = raw['expect'];
  if (typeof expect !== 'string' || expect.trim() === '') return invalid(`${at}.expect must say what the step should do`, 'write one short sentence', `${at}.expect`);
  if (codePoints(expect) > MACRO_EXPECT_MAX) return invalid(`${at}.expect is longer than ${MACRO_EXPECT_MAX} characters`, 'shorten it', `${at}.expect`);
  const params = raw['params'];
  if (!isPlainObject(params) || Object.keys(params).includes('$param')) {
    return invalid(`${at}.params must be an object of the tool's params`, 'a placeholder stands for one value inside params, never for params itself', `${at}.params`);
  }
  const value = readValue(params, `${at}.params`, 0, walk);
  if (!value.ok) return value;
  return ok({ tool, params: value.value as MacroStep['params'], expect });
}

/* ------------------------------------------------------------------ *
 * The macro
 * ------------------------------------------------------------------ */

/**
 * Reads one macro, strictly, and returns it in its canonical field order. The refusal names the first thing wrong. `requireId` is false for
 * a draft `macro.save` takes (the store mints the id) and true for a stored macro.
 */
export function readMacro(raw: unknown, requireId: boolean): Result<ProjectMacro | MacroDraft, CommandError> {
  const at = 'macro';
  if (!isPlainObject(raw)) return invalid('params.macro must be an object', 'pass { macro: { slug, name, description, params, steps } }', at);
  const refused = unknownKey(raw, MACRO_KEYS, at);
  if (refused !== undefined) return refused;

  const id = raw['id'];
  if (id === undefined ? requireId : !isMacroId(id)) {
    return invalid(`${id === undefined ? 'a stored macro needs an id' : `"${String(id)}" is not a macro id`}`, 'a macro id is m_ followed by 10 base32 characters', `${at}.id`);
  }
  const slug = raw['slug'];
  if (!isMacroSlug(slug)) {
    return invalid(`${typeof slug === 'string' ? `"${slug}"` : 'the slug'} is not a macro slug`, `a slug is 1 to ${MACRO_SLUG_MAX} lower-case letters, digits and hyphens`, `${at}.slug`);
  }
  const name = raw['name'];
  if (typeof name !== 'string' || name.trim() === '') return invalid('a macro needs a name', `give it a name of up to ${MACRO_NAME_MAX} characters`, `${at}.name`);
  if (codePoints(name.trim()) > MACRO_NAME_MAX) return invalid(`the macro name is ${codePoints(name.trim())} characters`, `a name is at most ${MACRO_NAME_MAX} characters`, `${at}.name`);
  const description = raw['description'];
  if (typeof description !== 'string') return invalid('a macro needs a description, which may be empty', 'pass a string', `${at}.description`);
  if (codePoints(description) > MACRO_DESCRIPTION_MAX) {
    return invalid(`the description is ${codePoints(description)} characters`, `a description is at most ${MACRO_DESCRIPTION_MAX} characters`, `${at}.description`);
  }

  const params = readParamSpec(raw['params']);
  if (!params.ok) return params;
  const steps = raw['steps'];
  if (!Array.isArray(steps) || steps.length === 0) return invalid('a macro needs at least one step', 'a step is { tool, params, expect }', `${at}.steps`);
  if (steps.length > MACRO_STEPS_MAX) {
    return err(limitExceededError(`a macro has ${steps.length} steps, and the limit is ${MACRO_STEPS_MAX}`, 'split it into two macros', `${at}.steps`));
  }
  const walk: Walk = { nodes: 0, declared: new Set(Object.keys(params.value.properties)) };
  const read: MacroStep[] = [];
  for (const [index, step] of (steps as unknown[]).entries()) {
    const one = readStep(step, index, walk);
    if (!one.ok) return one;
    read.push(one.value);
  }

  const macro = {
    ...(id === undefined ? {} : { id }),
    slug,
    name: name.trim(),
    description,
    params: params.value,
    steps: read,
  } as ProjectMacro | MacroDraft;
  if (JSON.stringify(macro).length > MACRO_SIZE_MAX) {
    return err(limitExceededError(`the macro is longer than ${MACRO_SIZE_MAX} characters of JSON`, 'split it into two macros', at));
  }
  return ok(macro);
}

/** Every `$param` name a value uses, in the order first met. */
export function placeholdersOf(value: MacroValue): readonly string[] {
  const found: string[] = [];
  const visit = (v: MacroValue): void => {
    if (v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const item of v as readonly MacroValue[]) visit(item);
      return;
    }
    const record = v as { readonly [key: string]: MacroValue };
    const name = record['$param'];
    if (typeof name === 'string') {
      if (!found.includes(name)) found.push(name);
      return;
    }
    for (const key of Object.keys(record)) visit(record[key] as MacroValue);
  };
  visit(value);
  return found;
}

/** Whether a value is a placeholder (`{ $param: name }`). */
export function isMacroPlaceholder(value: unknown): value is MacroPlaceholder {
  return isRecord(value) && typeof value['$param'] === 'string' && Object.keys(value).length === 1;
}
