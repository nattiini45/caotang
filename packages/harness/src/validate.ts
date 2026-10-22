/**
 * The closed-set params validator — the runtime half of `schema.ts`.
 *
 * **In the style of `packages/bus/src/params.ts`:** an undeclared key is refused
 * before any field is read, and the refusal names the key and the accepted set,
 * so a model can fix the call in one round trip. A declared key whose value is
 * `undefined` is treated as absent (the bus's optional-key rule); an undeclared
 * key is refused even with an `undefined` value, because it is a key the caller
 * named.
 *
 * **What it enforces, stated exactly** (the JSON Schema from `toJsonSchema` states
 * the same set, minus the two rules marked below):
 *
 * - `type` for string, integer, boolean, enum, array, object, and the JSON type
 *   that selects a union option;
 * - `required`, `additionalProperties: false`, `enum`, `minItems`, `maxItems`,
 *   `uniqueItems`, `minimum`, `maximum`, `minLength` (as `nonBlank`), `maxLength`;
 * - a tagged union's tag: its value must name a variant.
 *
 * `default` is documentation only. The validator never fills a default in; each
 * tool applies its own defaults when it prepares a call, so a default is written
 * once, where it is used.
 *
 * **Limits are not shape errors.** A value over `maxLength` or `maxItems` comes
 * back as `limit-exceeded` with the split-or-shorten hint, the same split the bus
 * makes between `invalid-params` and `limit-exceeded` (command-bus §7).
 */

import { ok, type CommandError, type Result } from '@caotang/bus';

import { failure, invalidParams, limitExceeded } from './errors.js';
import type { ObjectSpec, ParamSpec } from './schema.js';
import { canonicalJson, codePointLength, describe, isRecord, plural } from './util.js';

type Checked = Result<unknown, CommandError>;

function lastSegment(path: string): string {
  const cut = Math.max(path.lastIndexOf('.'), path.lastIndexOf(']'));
  return cut === -1 ? path : path.slice(cut + 1).replace(/^\./, '');
}

function childPath(path: string, key: string): string {
  return `${path}.${key}`;
}

/**
 * Check one tool call's params against its object spec.
 *
 * `tool` is the name the refusal's first sentence uses ("meta.set takes no param
 * "x""), and the path root is always `params`, as in the bus.
 */
export function checkParams(
  tool: string,
  spec: ObjectSpec,
  input: unknown,
): Result<Record<string, unknown>, CommandError> {
  if (!isRecord(input)) {
    return failure(
      invalidParams(`params must be an object, got ${describe(input)}`, `every ${tool} call takes one flat params object — see the tool's schema`),
    ) as Result<Record<string, unknown>, CommandError>;
  }
  return checkObject(spec, input, tool, 'params');
}

/** Check a value against any spec. Used for the object root and, recursively, for every nested value. */
export function checkValue(spec: ParamSpec, value: unknown, path: string): Checked {
  switch (spec.kind) {
    case 'string': {
      if (typeof value !== 'string') {
        return failure(invalidParams(`${path} must be a string, got ${describe(value)}`, `pass ${lastSegment(path)} as a string`, path));
      }
      if (spec.nonBlank === true && value.trim().length === 0) {
        return failure(invalidParams(`${path} must not be blank`, `pass a non-blank ${lastSegment(path)}`, path));
      }
      if (spec.maxLength !== undefined && codePointLength(value) > spec.maxLength) {
        return failure(
          limitExceeded(
            `${path} is ${codePointLength(value)} characters, limit ${spec.maxLength}`,
            spec.overflowHint ?? `shorten ${lastSegment(path)} to ${spec.maxLength} characters`,
            path,
          ),
        );
      }
      return ok(value);
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        return failure(invalidParams(`${path} must be an integer, got ${describe(value)}`, `pass ${lastSegment(path)} as an integer`, path));
      }
      if (spec.minimum !== undefined && value < spec.minimum) {
        return failure(invalidParams(`${path} must be ≥ ${spec.minimum}, got ${value}`, undefined, path));
      }
      if (spec.maximum !== undefined && value > spec.maximum) {
        return failure(invalidParams(`${path} must be ≤ ${spec.maximum}, got ${value}`, `pass ${lastSegment(path)} at or below ${spec.maximum}`, path));
      }
      return ok(value);
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        return failure(invalidParams(`${path} must be a boolean, got ${describe(value)}`, `pass ${lastSegment(path)} as true or false`, path));
      }
      return ok(value);
    }
    case 'enum': {
      if (typeof value !== 'string' || !spec.values.includes(value)) {
        const got = value === undefined ? 'nothing' : JSON.stringify(value);
        return failure(
          invalidParams(
            `${path} must be one of ${spec.values.join(', ')}, got ${got}`,
            `valid ${lastSegment(path)} values: ${spec.values.join(', ')}`,
            path,
          ),
        );
      }
      return ok(value);
    }
    case 'array':
      return checkArray(spec, value, path);
    case 'object':
      // A nested object names itself by its path, so "params.range takes no param"
      // says where the stray key is.
      return checkObject(spec, value, path, path);
    case 'free-object':
      if (!isRecord(value)) {
        return failure(invalidParams(`${path} must be an object, got ${describe(value)}`, `pass ${lastSegment(path)} as an object`, path));
      }
      return ok({ ...value });
    case 'union': {
      const family = familyOf(value);
      const option = spec.options.find((candidate) => familiesOf(candidate).includes(family));
      if (option === undefined) {
        const accepted = spec.options.map((candidate) => describeSpec(candidate)).join(' or ');
        return failure(invalidParams(`${path} must be ${accepted}, got ${describe(value)}`, `pass ${lastSegment(path)} as ${accepted}`, path));
      }
      return checkValue(option, value, path);
    }
    case 'tagged': {
      const variantNames = Object.keys(spec.variants);
      if (!isRecord(value)) {
        return failure(
          invalidParams(
            `${path} must be an object with a "${spec.tag}" key, got ${describe(value)}`,
            `pass ${path} as an object whose ${spec.tag} is one of: ${variantNames.join(', ')}`,
            path,
          ),
        );
      }
      const tagValue = value[spec.tag];
      if (typeof tagValue !== 'string' || !Object.hasOwn(spec.variants, tagValue)) {
        const got = tagValue === undefined ? 'nothing' : JSON.stringify(tagValue);
        return failure(
          invalidParams(
            `${childPath(path, spec.tag)} must be one of ${variantNames.join(', ')}, got ${got}`,
            `valid ${spec.tag} values: ${variantNames.join(', ')}`,
            childPath(path, spec.tag),
          ),
        );
      }
      const variant = spec.variants[tagValue];
      if (variant === undefined) return failure(invalidParams(`${path} has no variant "${tagValue}"`, undefined, path));
      return checkObject(variant, value, path, path);
    }
  }
}

function checkObject(spec: ObjectSpec, value: unknown, where: string, path: string): Result<Record<string, unknown>, CommandError> {
  if (!isRecord(value)) {
    return failure(
      invalidParams(
        `${path} must be an object, got ${describe(value)}`,
        `pass ${path} as an object with: ${Object.keys(spec.properties).join(', ')}`,
        path,
      ),
    ) as Result<Record<string, unknown>, CommandError>;
  }
  const accepted = Object.keys(spec.properties);
  // Unknown keys first, before any field is read: the misspelling is what the
  // caller needs to hear, not the cascade of missing-field errors it causes.
  const unexpected = Object.keys(value).filter((key) => !accepted.includes(key));
  if (unexpected.length > 0) {
    const named = unexpected.map((key) => `"${key}"`).join(', ');
    return failure(
      invalidParams(
        `${where} takes no ${unexpected.length === 1 ? 'param' : 'params'} ${named}`,
        `${where} accepts only: ${accepted.join(', ')} — drop ${unexpected.length === 1 ? 'that key' : 'those keys'} and resend`,
        childPath(path, unexpected[0] ?? ''),
      ),
    ) as Result<Record<string, unknown>, CommandError>;
  }
  for (const key of spec.required) {
    if (value[key] === undefined) {
      return failure(invalidParams(`${childPath(path, key)} is required`, `pass ${key}`, childPath(path, key))) as Result<
        Record<string, unknown>,
        CommandError
      >;
    }
  }
  const out: Record<string, unknown> = {};
  for (const key of accepted) {
    const child = value[key];
    if (child === undefined) continue;
    const checked = checkValue(spec.properties[key] as ParamSpec, child, childPath(path, key));
    if (!checked.ok) return checked as Result<Record<string, unknown>, CommandError>;
    out[key] = checked.value;
  }
  return ok(out);
}

function checkArray(spec: Extract<ParamSpec, { kind: 'array' }>, value: unknown, path: string): Checked {
  if (!Array.isArray(value)) {
    return failure(invalidParams(`${path} must be an array, got ${describe(value)}`, `pass ${lastSegment(path)} as an array`, path));
  }
  if (spec.maxItems !== undefined && value.length > spec.maxItems) {
    return failure(
      limitExceeded(
        `${path} has ${plural(value.length, 'entry')}, at most ${spec.maxItems} allowed`,
        `send at most ${spec.maxItems} per call — split the rest into another call`,
        path,
      ),
    );
  }
  if (spec.minItems !== undefined && value.length < spec.minItems) {
    return failure(
      invalidParams(
        `${path} must have at least ${plural(spec.minItems, 'entry')}, got ${value.length}`,
        `pass at least ${plural(spec.minItems, 'entry')} in ${lastSegment(path)}`,
        path,
      ),
    );
  }
  const out: unknown[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    const checked = checkValue(spec.items, item, itemPath);
    if (!checked.ok) return checked;
    if (spec.unique === true) {
      const key = canonicalJson(checked.value);
      if (seen.has(key)) {
        return failure(invalidParams(`${itemPath} repeats an entry already in ${lastSegment(path)}`, `remove the duplicate from ${lastSegment(path)}`, itemPath));
      }
      seen.add(key);
    }
    out.push(checked.value);
  }
  return ok(out);
}

/* ------------------------------------------------------------------ *
 * Union selection by JSON type
 * ------------------------------------------------------------------ */

type Family = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'other';

function familyOf(value: unknown): Family {
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (isRecord(value)) return 'object';
  return 'other';
}

function familiesOf(spec: ParamSpec): readonly Family[] {
  switch (spec.kind) {
    case 'string':
    case 'enum':
      return ['string'];
    case 'integer':
      return ['number'];
    case 'boolean':
      return ['boolean'];
    case 'array':
      return ['array'];
    case 'object':
    case 'free-object':
    case 'tagged':
      return ['object'];
    case 'union':
      return spec.options.flatMap((option) => [...familiesOf(option)]);
  }
}

function describeSpec(spec: ParamSpec): string {
  switch (spec.kind) {
    case 'string':
      return 'a string';
    case 'enum':
      return `one of ${spec.values.join(', ')}`;
    case 'integer':
      return 'an integer';
    case 'boolean':
      return 'true or false';
    case 'array':
      return 'an array';
    case 'object':
    case 'free-object':
    case 'tagged':
      return 'an object';
    case 'union':
      return spec.options.map((option) => describeSpec(option)).join(' or ');
  }
}
