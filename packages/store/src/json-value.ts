/**
 * What JSON can hold, checked all the way down.
 *
 * The loader and the writer have to agree on this, or a project that loads
 * cannot be saved: the loader keeps what the writer can write back, and the
 * writer refuses what it cannot write. A number has to be finite —
 * `JSON.stringify` writes NaN and Infinity as `null`, which changes the value
 * quietly, and JSON itself parses `1e400` to Infinity — a BigInt is not JSON at
 * all, and `undefined` is not a value: JSON drops the key it is in.
 *
 * One home for the rule, so the two halves cannot drift apart: the loader drops
 * a value this refuses, and the writer refuses the same value by name.
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
 */
export function jsonValueProblem(value: unknown, path = ''): JsonValueProblem | undefined {
  if (value === undefined) {
    return { path, reason: 'the value is not there, and a field that is not there cannot be written as JSON' };
  }
  if (typeof value === 'bigint') {
    return { path, reason: 'a BigInt is not JSON' };
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { path, reason: `${String(value)} is not a JSON number` };
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    return { path, reason: `a ${typeof value} is not JSON` };
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const problem = jsonValueProblem(item, `${path}[${index}]`);
      if (problem !== undefined) return problem;
    }
    return undefined;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      const problem = jsonValueProblem(item, `${path}.${key}`);
      if (problem !== undefined) return problem;
    }
  }
  return undefined;
}
