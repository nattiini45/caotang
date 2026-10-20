/**
 * Ids for the coherence module — the same Crockford base32 family as node and
 * codex ids ([project-format.md](../../../docs/architecture/project-format.md)),
 * with three prefixes of its own: `f_` finding, `r_` run, `w_` world rule (coherence.md §3, §4.1, §4.3).
 *
 * `@caotang/ids` owns the prefix union, and this module mints through it with its own
 * prefix (the union carries these three, rather than
 * borrowing `c` and swapping the prefix afterwards). The body is ten Crockford
 * characters from the family's randomness, and the spec's uniqueness rule still
 * applies: a minted id is never one `taken` already holds.
 */

import { newId, type RandomBytes } from '@caotang/ids';

export type CoherenceIdPrefix = 'f' | 'r' | 'w';

const BODY_PATTERN = '[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}';

/** True when `value` is `<prefix>_` followed by ten Crockford base32 characters. */
export function isCoherenceId(prefix: CoherenceIdPrefix, value: unknown): value is string {
  return typeof value === 'string' && new RegExp(`^${prefix}_${BODY_PATTERN}$`).test(value);
}

/**
 * Mint an id not already in `taken`. A coherence id has to be the ten-character
 * shape the spec fixes, so whatever the ids package hands back, a candidate that
 * `taken` holds or {@link isCoherenceId} rejects is a throw, never a returned id.
 */
export function mintCoherenceId(
  prefix: CoherenceIdPrefix,
  taken: ReadonlySet<string>,
  randomBytes?: RandomBytes,
): string {
  const candidate = newId(prefix, { taken, ...(randomBytes ? { randomBytes } : {}), maxAttempts: 8 });
  if (!taken.has(candidate) && isCoherenceId(prefix, candidate)) return candidate;
  throw new Error(`could not mint a unique ${prefix}_ id after 8 attempts`);
}
