/**
 * Ids for the coherence module — the same Crockford base32 family as node and
 * codex ids ([project-format.md](../../../docs/architecture/project-format.md)),
 * with four prefixes of its own: `f_` finding, `r_` run, `w_` world rule, `k_` knowledge fact (coherence.md §3, §4.1, §4.3, §4.4).
 *
 * `@caotang/ids` owns the prefix union, and this module mints through it with its own
 * prefix (the union carries these four, rather than
 * borrowing `c` and swapping the prefix afterwards). The body is ten Crockford
 * characters from the family's randomness, and the spec's uniqueness rule still
 * applies: a minted id is never one `taken` already holds.
 */

import { ID_BODY_PATTERN, newId, type RandomBytes } from '@caotang/ids';

export type CoherenceIdPrefix = 'f' | 'r' | 'w' | 'k';

/**
 * True when `value` is `<prefix>_` followed by `ID_LENGTH` Crockford base32 characters.
 *
 * **Built from `@caotang/ids`' own constants**, so the check and the mint
 * cannot drift apart: if the alphabet or the length ever changes there, this
 * changes with it, and `mintCoherenceId` keeps returning ids `isCoherenceId`
 * accepts. A second copy of the alphabet here would be a second thing to get
 * wrong — and the failure would surface at the codec load, not at the mint.
 *
 * **The pattern is built from an escaped alphabet**, because it goes into a
 * character class. `@caotang/ids` escapes it there and this module takes the
 * escaped fragment rather than building a class of its own: an unescaped `]`
 * would build a *valid* regex with the wrong language, and `isCoherenceId`
 * would then accept ids the mint never produces — a silent mis-validation,
 * not the load failure the paragraph above promises. An unescaped `-` fails
 * differently again: between descending code points it throws `Range out of
 * order in character class` at construction, and between ascending ones it
 * widens the class. Escaping removes both cases.
 */
export function isCoherenceId(prefix: CoherenceIdPrefix, value: unknown): value is string {
  return typeof value === 'string' && new RegExp(`^${prefix}_${ID_BODY_PATTERN}$`).test(value);
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
