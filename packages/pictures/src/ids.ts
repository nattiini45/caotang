/**
 * Asset ids — storyboard.md §2.2's `a_XXXXXXXXXX.<ext>` filenames.
 *
 * The same Crockford base32 family as node and codex ids (project-format.md), with the
 * `a_` prefix. `@caotang/ids` fixes its prefix union at `p | n | c | cmd`, so this module
 * borrows the family's generator and swaps the prefix, the way `packages/coherence/src/ids.ts`
 * does for `f_`, `r_` and `w_`. The body is ten characters from the same randomness, and the
 * uniqueness rule still applies: a minted id is checked against every id already in use.
 */

import { newId, type RandomBytes } from '@caotang/ids';

/** `a_` followed by ten Crockford base32 characters (no I, L, O or U). */
export const ASSET_ID_PATTERN = /^a_[0-9A-HJKMNP-TV-Z]{10}$/;

export function isAssetId(value: unknown): value is string {
  return typeof value === 'string' && ASSET_ID_PATTERN.test(value);
}

/**
 * Mints an asset id not already in `taken`. Eight attempts is far beyond what a project's
 * images need, and exhausting them means the randomness source is broken, so it throws
 * rather than hand back a duplicate.
 */
export function mintAssetId(taken: ReadonlySet<string>, randomBytes?: RandomBytes): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const body = newId('c', randomBytes ? { randomBytes } : {}).slice(2);
    const candidate = `a_${body}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error('could not mint a unique a_ id after 8 attempts');
}
