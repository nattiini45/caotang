/**
 * Ids for the coherence module — the same Crockford base32 family as node and
 * codex ids ([project-format.md](../../../docs/architecture/project-format.md)),
 * with three prefixes of its own: `f_` finding, `r_` run, `w_` world rule (coherence.md §3, §4.1, §4.3).
 *
 * `@caotang/ids` owns the prefix union, and this module mints through it with its own
 * prefix (the union carries these three, rather than
 * borrowing `c` and swapping the prefix afterwards). The body is ten Crockford
 * characters from the family's randomness, and the spec's uniqueness rule still
 * applies: `taken` re-rolls on collision, and an exhausted re-roll is a throw.
 */

import { CROCKFORD_ALPHABET, ID_LENGTH, newId, type RandomBytes } from '@caotang/ids';

export type CoherenceIdPrefix = 'f' | 'r' | 'w';

/**
 * The body of a coherence id, as a pattern: `ID_LENGTH` Crockford base32
 * characters.
 *
 * **Built from `@caotang/ids`' own constants**, so the check and the mint
 * cannot drift apart: if the alphabet or the length ever changes there, this
 * changes with it, and `mintCoherenceId` keeps returning ids `isCoherenceId`
 * accepts. A second copy of the alphabet here would be a second thing to get
 * wrong — and the failure would surface at the codec load, not at the mint.
 *
 * **The alphabet is escaped, because it goes into a character class.** The
 * alphabet as it stands holds no metacharacter, so the pattern is the same
 * either way — but an unescaped `-` or `]` would build a *valid* regex with
 * the wrong language, and `isCoherenceId` would then accept ids the mint never
 * produces. That is a silent mis-validation, not the load failure the
 * paragraph above promises, so the class is built from an escaped copy.
 */
const ESCAPED_ALPHABET = CROCKFORD_ALPHABET.replace(/[\\^\]-]/g, '\\$&');
const BODY_PATTERN = `[${ESCAPED_ALPHABET}]{${ID_LENGTH}}`;

/** True when `value` is `<prefix>_` followed by `ID_LENGTH` Crockford base32 characters. */
export function isCoherenceId(prefix: CoherenceIdPrefix, value: unknown): value is string {
  return typeof value === 'string' && new RegExp(`^${prefix}_${BODY_PATTERN}$`).test(value);
}

/**
 * Mint an id not already in `taken`. `newId` re-rolls on collision itself — up
 * to twice `maxAttempts` draws — and **throws** once the draws are exhausted:
 * an exhausted mint is a bug in the randomness source, and it surfaces as that
 * throw rather than as a duplicate or a fallback of another shape. The id that
 * comes back is therefore always taken-free and always the ten-character shape
 * the spec fixes, so there is nothing left to re-check here.
 *
 * @throws {Error} when `newId`'s draws are exhausted (its message, naming the
 * prefix and the attempt count).
 */
export function mintCoherenceId(
  prefix: CoherenceIdPrefix,
  taken: ReadonlySet<string>,
  randomBytes?: RandomBytes,
): string {
  return newId(prefix, { taken, ...(randomBytes ? { randomBytes } : {}), maxAttempts: 8 });
}
