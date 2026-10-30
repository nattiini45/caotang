/**
 * What the Macros panel and the Save as macro dialog show, as data ([extensibility.md §10](../../../../docs/architecture/extensibility.md)).
 * Everything here is pure: the rows of the list with where each stands, the form a macro's run asks for, the steps a run would expand to,
 * and the macro a finished plan card becomes when the writer marks some of its values as params. The checks are the harness's
 * (`checkMacro`, `expandMacro`), so the panel never judges a macro by a rule of its own.
 */

import {
  MACRO_DESCRIPTION_MAX,
  MACRO_NAME_MAX,
  MACRO_PARAMS_MAX,
  MACRO_SLUG_MAX,
  isMacroParamName,
  isMacroSlug,
  type MacroDraft,
  type MacroStep,
  type MacroValue,
  type ProjectMacro,
} from '@caotang/bus';
import { checkMacro, expandMacro, macroFieldSpec, registryMacroTools, type MacroRisk, type ParamSpec, type PlanStep } from '@caotang/harness';

/** What a macro does to the project, in the words the list uses. */
export const RISK_WORDS: Readonly<Record<MacroRisk, string>> = {
  read: 'Only reads. It runs without a card.',
  'write-auto': 'Changes the project. A card shows every step first, and one undo takes it back.',
  'write-confirm': 'Changes the project in ways that need your approval. A card shows every step first, and one undo takes it back.',
};

export interface MacroRow {
  readonly macro: ProjectMacro;
  /** Why the macro cannot run now, in a sentence, or `null` when it can. */
  readonly problem: string | null;
  readonly risk: MacroRisk | null;
}

/** The list: each macro with where it stands against the tools this build has. A macro that no longer fits stays in the list, to be edited or deleted. */
export function macroRows(macros: readonly ProjectMacro[]): readonly MacroRow[] {
  return macros.map((macro) => {
    const checked = checkMacro(macro);
    return checked.ok ? { macro, problem: null, risk: checked.value.risk } : { macro, problem: checked.error.message, risk: null };
  });
}

/* ------------------------------------------------------------------ *
 * The run form
 * ------------------------------------------------------------------ */

export interface MacroField {
  readonly name: string;
  readonly label: string;
  readonly kind: 'string' | 'integer' | 'boolean' | 'enum';
  readonly required: boolean;
  readonly values: readonly string[];
  /** What the field starts with, as text: the param's default, else nothing (a switch starts off). */
  readonly initial: string;
}

/** The fields a macro's run asks for, one for each param it declares. */
export function fieldsOf(macro: ProjectMacro): readonly MacroField[] {
  return Object.entries(macro.params.properties).flatMap(([name, spec]): MacroField[] => {
    if (spec.kind !== 'string' && spec.kind !== 'integer' && spec.kind !== 'boolean' && spec.kind !== 'enum') return [];
    const def = spec.default;
    return [
      {
        name,
        label: spec.description === '' ? name : spec.description,
        kind: spec.kind,
        required: macro.params.required.includes(name),
        values: spec.kind === 'enum' ? spec.values : [],
        initial: def === undefined ? (spec.kind === 'boolean' ? 'false' : spec.kind === 'enum' ? (spec.values[0] ?? '') : '') : String(def),
      },
    ];
  });
}

/** The values a form holds, as the macro takes them. A blank optional field is left out; a number that is not a whole number is an error in words. */
export function valuesOf(fields: readonly MacroField[], text: Readonly<Record<string, string>>): { readonly values: Record<string, unknown> } | { readonly problem: string } {
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = text[field.name] ?? field.initial;
    if (field.kind === 'boolean') {
      values[field.name] = raw === 'true';
      continue;
    }
    if (raw.trim() === '') {
      if (field.required) return { problem: `“${field.label}” needs a value.` };
      continue;
    }
    if (field.kind === 'integer') {
      const number = Number(raw);
      if (!Number.isInteger(number)) return { problem: `“${field.label}” needs a whole number.` };
      values[field.name] = number;
    } else {
      values[field.name] = raw;
    }
  }
  return { values };
}

export interface StepLine {
  readonly tool: string;
  readonly expect: string;
  /** The step's params as one line of JSON, so the writer can read exactly what will be asked for. */
  readonly params: string;
}

/** The steps a run would expand to for these values, or the reason it cannot run. This is the preview the panel shows before the card. */
export function stepLines(macro: ProjectMacro, values: Record<string, unknown>): { readonly lines: readonly StepLine[] } | { readonly problem: string } {
  const plan = expandMacro(macro, values);
  if (!plan.ok) return { problem: plan.error.message };
  return { lines: plan.value.steps.map((step) => ({ tool: step.tool, expect: step.expect, params: JSON.stringify(step.params) })) };
}

/* ------------------------------------------------------------------ *
 * Save as macro
 * ------------------------------------------------------------------ */

/** One value inside a step's params that can become a param. */
export interface Leaf {
  /** Which step, and where in its params. */
  readonly step: number;
  readonly path: readonly (string | number)[];
  readonly value: string | number | boolean;
}

/** `targets[0]` or `criteria.statusId`: where a leaf sits, as the dialog words it. */
export function pathLabel(path: readonly (string | number)[]): string {
  return path.map((part, at) => (typeof part === 'number' ? `[${part + 1}]` : at === 0 ? part : `.${part}`)).join('');
}

/** The key a leaf is marked under. */
export const leafKey = (leaf: Pick<Leaf, 'step' | 'path'>): string => `${leaf.step}:${leaf.path.join('/')}`;

/** Every string, number and yes/no value in a plan's steps, in order. A value inside a list or an object is found; a null is not a value to mark. */
export function leavesOf(steps: readonly { readonly params: Readonly<Record<string, unknown>> }[]): readonly Leaf[] {
  const out: Leaf[] = [];
  const visit = (value: unknown, step: number, path: readonly (string | number)[]): void => {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      if (path.length > 0) out.push({ step, path, value });
      return;
    }
    if (Array.isArray(value)) value.forEach((item, at) => visit(item, step, [...path, at]));
    else if (value !== null && typeof value === 'object') for (const [key, item] of Object.entries(value)) visit(item, step, [...path, key]);
  };
  steps.forEach((entry, index) => visit(entry.params, index, []));
  return out;
}

/** A slug from a macro's name: lower-case letters and digits, the rest a hyphen, within the slug's length. Empty when the name has neither. */
export function slugFromName(name: string): string {
  let out = '';
  let pending = false;
  for (const char of name.toLowerCase()) {
    const code = char.charCodeAt(0);
    const keep = (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
    if (keep) {
      if (pending && out !== '') out += '-';
      pending = false;
      out += char;
    } else {
      pending = true;
    }
    if (out.length >= MACRO_SLUG_MAX) break;
  }
  return out;
}

/** A param name from the last part of where a leaf sits: `status`, `text`, `doc`. A list item takes its list's name. */
export function paramNameFor(path: readonly (string | number)[]): string {
  const named = [...path].reverse().find((part): part is string => typeof part === 'string') ?? 'value';
  let out = '';
  for (const char of named) {
    const code = char.charCodeAt(0);
    const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    if (letter || (out !== '' && ((code >= 48 && code <= 57) || char === '_'))) out += char;
    else if (out !== '') out += '_';
  }
  return isMacroParamName(out) ? out : 'value';
}

export interface MacroForm {
  readonly name: string;
  readonly description: string;
  /** The slug, or blank to take one from the name. */
  readonly slug: string;
}

/** What the dialog sends back: the form, and the param each marked leaf becomes (its name), by `leafKey`. */
export interface MarkedLeaves {
  readonly [key: string]: string;
}

function fail(problem: string): { readonly problem: string } {
  return { problem };
}

/** The spec a marked value's param takes from the field it fills, so a param always fits where it stands. */
function paramSpecFor(field: ParamSpec | undefined, leaf: Leaf, description: string): ParamSpec | { readonly problem: string } {
  const options = field === undefined ? [] : field.kind === 'union' ? field.options : [field];
  const fit = options.find((option) => {
    if (option.kind === 'enum') return typeof leaf.value === 'string' && option.values.includes(leaf.value);
    if (option.kind === 'string') return typeof leaf.value === 'string';
    if (option.kind === 'integer') return typeof leaf.value === 'number' && Number.isInteger(leaf.value);
    if (option.kind === 'boolean') return typeof leaf.value === 'boolean';
    return false;
  });
  if (fit === undefined) return fail(`“${pathLabel(leaf.path)}” in step ${leaf.step + 1} cannot be a param: the tool does not take one value there that a macro can fill.`);
  if (fit.kind === 'enum') return { kind: 'enum', description, values: [...fit.values], default: leaf.value as string };
  if (fit.kind === 'boolean') return { kind: 'boolean', description, default: leaf.value as boolean };
  if (fit.kind === 'integer') {
    return {
      kind: 'integer',
      description,
      ...(fit.minimum === undefined ? {} : { minimum: fit.minimum }),
      ...(fit.maximum === undefined ? {} : { maximum: fit.maximum }),
      default: leaf.value as number,
    };
  }
  if (fit.kind !== 'string') return fail(`“${pathLabel(leaf.path)}” in step ${leaf.step + 1} cannot be a param.`);
  return {
    kind: 'string',
    description,
    ...(fit.nonBlank === true ? { nonBlank: true } : {}),
    // A limit the marked value itself is over is left out: the macro's limit is for the values a writer types, and the tool checks the rest.
    ...(fit.maxLength === undefined || [...(leaf.value as string)].length > Math.min(fit.maxLength, 2_000) ? {} : { maxLength: Math.min(fit.maxLength, 2_000) }),
    default: leaf.value as string,
  };
}

function setAt(root: Record<string, unknown>, path: readonly (string | number)[], value: unknown): void {
  let at: Record<string | number, unknown> = root;
  for (const part of path.slice(0, -1)) at = at[part] as Record<string | number, unknown>;
  at[path[path.length - 1] as string | number] = value;
}

/**
 * The macro a plan card becomes when the writer marks some of its values as params. Each marked value is replaced by `{ "$param": name }`
 * and the param gets the kind the field it stood in takes, with the marked value as its default. So the macro, run with no changes,
 * expands to exactly the plan the card held, and that is checked here: a draft whose expansion differs from the card is refused.
 */
export function macroFromPlan(
  steps: readonly PlanStep[],
  form: MacroForm,
  marks: MarkedLeaves,
  descriptions: Readonly<Record<string, string>> = {},
): { readonly draft: MacroDraft } | { readonly problem: string } {
  const name = form.name.trim();
  if (name === '') return fail('Give the macro a name.');
  if ([...name].length > MACRO_NAME_MAX) return fail(`A name is at most ${MACRO_NAME_MAX} characters.`);
  if ([...form.description].length > MACRO_DESCRIPTION_MAX) return fail(`A description is at most ${MACRO_DESCRIPTION_MAX} characters.`);
  const slug = form.slug.trim() === '' ? slugFromName(name) : form.slug.trim();
  if (!isMacroSlug(slug)) return fail(`A slug is 1 to ${MACRO_SLUG_MAX} lower-case letters, digits and hyphens.`);

  const tools = registryMacroTools();
  const copies = steps.map((entry) => structuredClone(entry.params) as Record<string, unknown>);
  const params: Record<string, ParamSpec> = {};
  for (const leaf of leavesOf(steps)) {
    const param = marks[leafKey(leaf)];
    if (param === undefined || param.trim() === '') continue;
    if (!isMacroParamName(param)) return fail(`“${param}” is not a param name: use letters, digits and underscores, starting with a letter.`);
    const tool = tools.tool((steps[leaf.step] as PlanStep).tool);
    if (tool === undefined) return fail(`Step ${leaf.step + 1} is a tool a macro cannot call.`);
    const field = macroFieldSpec(tool, (steps[leaf.step] as PlanStep).params as MacroValue, leaf.path);
    const spec = paramSpecFor(field, leaf, descriptions[param] ?? param);
    if ('problem' in spec) return spec;
    const held = params[param];
    if (held !== undefined) {
      if (JSON.stringify({ ...held, description: '' }) !== JSON.stringify({ ...spec, description: '' })) {
        return fail(`The param “${param}” would hold two different values or kinds. Give them different names.`);
      }
    } else {
      params[param] = spec;
    }
    setAt(copies[leaf.step] as Record<string, unknown>, leaf.path, { $param: param });
  }
  if (Object.keys(params).length > MACRO_PARAMS_MAX) return fail(`A macro takes at most ${MACRO_PARAMS_MAX} params.`);

  const draft: MacroDraft = {
    slug,
    name,
    description: form.description,
    params: { kind: 'object', description: `The values “${name}” takes.`, properties: params, required: [] },
    steps: steps.map((entry, at): MacroStep => ({ tool: entry.tool, params: copies[at] as MacroStep['params'], expect: entry.expect })),
  };
  const probe: ProjectMacro = { id: 'm_0000000000', ...draft };
  const checked = checkMacro(probe);
  if (!checked.ok) return fail(checked.error.message);
  const expanded = expandMacro(probe, {});
  if (!expanded.ok) return fail(expanded.error.message);
  if (JSON.stringify(expanded.value.steps) !== JSON.stringify(steps.map((entry) => ({ tool: entry.tool, params: entry.params, expect: entry.expect })))) {
    return fail('The macro would not reproduce this plan, so it was not saved. Mark fewer values, or keep them fixed.');
  }
  return { draft };
}
