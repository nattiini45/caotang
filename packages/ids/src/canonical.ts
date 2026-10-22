/**
 * Canonical JSON: one byte string per JSON value, so a hash over it is stable. Object keys are sorted by UTF-16 code unit, there is no
 * insignificant whitespace, arrays keep their order and `undefined` members are dropped. The MCP tool pins (`@caotang/mcp-client`) and the
 * skill pins (`@caotang/skills`) are both SHA-256 over this text, so the function lives where both can reach it.
 */

/** One JSON value's canonical text. Throws on a value JSON cannot carry (a function, a bigint, NaN). */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonical JSON cannot carry a non-finite number');
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonical JSON cannot carry a ${typeof value}`);
  }
}
