/**
 * What JSON can hold, checked all the way down.
 *
 * The loader and the writer have to agree on this, or a project that loads
 * cannot be saved: the loader keeps what the writer can write back, and the
 * writer refuses what it cannot write. A number has to be finite —
 * `JSON.stringify` writes NaN and Infinity as `null`, which changes the value
 * quietly, and JSON itself parses `1e400` to Infinity — a BigInt is not JSON at
 * all, and `undefined` is not a value: JSON drops the key it is in. An object
 * that is not a plain one is not JSON either: a Map or a Set is written as
 * `{}`, and its contents are dropped without a word.
 *
 * **What this module owns is the JSON-safety rule** — the values JSON cannot
 * hold, and the values it holds by writing something else. The loader's own
 * rules are *about fields*, not about JSON: a criterion value is a scalar or a
 * list of strings, a count is a number, a citation offset is a whole number
 * (`validate.ts`, `codex-fields.ts`). Those are stricter and they add to this
 * one; they are not a second copy of it. The one half the two do share is
 * that a number has to be finite, and the loader reads it from here
 * (`isJsonNumber`), so the two halves cannot drift apart on the half they
 * share.
 */

/** The first value inside another that JSON cannot hold, and why. */
export interface JsonValueProblem {
  /** Where the offending value sits inside the one that was checked: `.key`, `[0]`. */
  readonly path: string;
  /** Why JSON cannot hold it. */
  readonly reason: string;
}

/**
 * The first value inside `value` that JSON cannot hold, or `undefined` when the
 * whole of it is JSON.
 *
 * The path names the offending part, so the loader can say which field of a
 * node it is and the writer can name it in its refusal. An empty path is the
 * value itself.
 *
 * A value that refers to itself is refused too: JSON has no way to write it,
 * and the walk would otherwise run until the stack runs out.
 */
export function jsonValueProblem(value: unknown, path = ''): JsonValueProblem | undefined {
  return problemIn(value, path, new Set());
}

/**
 * A number JSON can hold: a finite one. `JSON.stringify` writes NaN and
 * Infinity as `null`, which changes the value quietly, so the writer refuses
 * them and the loader drops them.
 */
export function isJsonNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** The walk, with the values on the path above it — a value that refers to itself is caught there. */
function problemIn(value: unknown, path: string, above: ReadonlySet<object>): JsonValueProblem | undefined {
  if (value === undefined) {
    return { path, reason: 'the value is not there, and a field that is not there cannot be written as JSON' };
  }
  if (typeof value === 'bigint') {
    return { path, reason: 'a BigInt is not JSON' };
  }
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return undefined;
    return { path, reason: `${String(value)} is not a JSON number` };
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    return { path, reason: `a ${typeof value} is not JSON` };
  }
  if (Array.isArray(value)) {
    if (above.has(value)) return { path, reason: 'the value refers to itself, and JSON cannot write that' };
    const inside = new Set(above).add(value);
    for (const [index, item] of value.entries()) {
      const problem = problemIn(item, `${path}[${index}]`, inside);
      if (problem !== undefined) return problem;
    }
    return undefined;
  }
  if (typeof value === 'object' && value !== null) {
    if (above.has(value)) return { path, reason: 'the value refers to itself, and JSON cannot write that' };
    if (!isPlainObject(value)) return { path, reason: notPlainReason(value) };
    const inside = new Set(above).add(value);
    for (const [key, item] of Object.entries(value)) {
      const problem = problemIn(item, `${path}.${key}`, inside);
      if (problem !== undefined) return problem;
    }
  }
  return undefined;
}

/**
 * A plain object: one JSON writes as the object it is. `Object.create(null)`
 * counts, because JSON writes it as an object too.
 */
function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/** Why JSON cannot write this object as the object it is. */
function notPlainReason(value: object): string {
  const name = value.constructor?.name ?? 'object';
  if (value instanceof Map || value instanceof Set) {
    return `a ${name} is written as {} by JSON, and its contents are dropped`;
  }
  if (value instanceof Date) {
    return 'a Date is written as a string by JSON, which changes its value';
  }
  return `a ${name} is not a plain object, and JSON writes only the fields it has`;
}
