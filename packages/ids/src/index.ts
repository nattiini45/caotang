/**
 * Crockford base32 ids — [project-format.md §2](docs/architecture/project-format.md).
 *
 * One generator family for every id in the system:
 *   `p_` project · `n_` tree node · `c_` codex entry · `cmd_` command
 *   · `f_` coherence finding · `r_` coherence run · `w_` world rule (coherence.md §3, §4.1, §4.3)
 *   · `prv_` provider profile (provider-gateway.md — the gateway mints its own today)
 *
 * 10 chars of Crockford base32 = 32^10 ≈ 10^15. The alphabet omits I, L, O and U
 * so an id can be read aloud or copied without ambiguity.
 *
 * Renames and reorganisations never touch disk because ids are opaque and never
 * derived from the title — that is the point of the whole scheme.
 */

/** Crockford base32: no I, L, O, or U. */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Every prefix the family uses. `f`, `r` and `w` are the coherence module's
 * (coherence.md §3, §4.1, §4.3): a finding, a run and a world rule are minted by
 * this generator, not by a caller that borrows another family's prefix and swaps it.
 * `prv` is the provider profile's (the gateway's `prv_` ids, PROFILE_ID_PATTERN).
 */
export type IdPrefix = 'p' | 'n' | 'c' | 'cmd' | 'f' | 'r' | 'w' | 'prv';

/**
 * The number of characters an id's body carries, after its prefix.
 *
 * **Exported so that nothing else has to restate it.** A second copy of "ten"
 * is a second thing to get wrong: an id minted with one length and checked
 * against another fails at the check, not at the mint.
 */
export const ID_LENGTH = 10;

const FIXED_ROOTS = new Set(['root', 'manuscript', 'research']);

/** True for the three fixed root ids, which are reserved and not deletable. */
export function isFixedRoot(id: string): boolean {
  return FIXED_ROOTS.has(id);
}

export function isGeneratedId(id: string): boolean {
  const [prefix, body] = splitId(id);
  if (prefix === undefined || body.length !== ID_LENGTH) return false;
  return [...body].every((c) => CROCKFORD_ALPHABET.includes(c));
}

function splitId(id: string): [string | undefined, string] {
  const idx = id.indexOf('_');
  if (idx <= 0 || idx === id.length - 1) return [undefined, id];
  return [id.slice(0, idx), id.slice(idx + 1)];
}

/**
 * True when `id` is a well-formed id *of that family* — the shape check plus the
 * prefix. `isGeneratedId` alone answers "is this 10 Crockford chars after an
 * underscore", which is deliberately family-agnostic because one generator makes
 * them all; the format spec, however, fixes the prefix per field ("tree[].id" is
 * `n_` + 10, a codex entry is `c_` + 10), and a `p_` id is not a node.
 */
export function isIdWithPrefix(prefix: IdPrefix, id: string): boolean {
  const [found, body] = splitId(id);
  return found === prefix && body.length === ID_LENGTH && isGeneratedId(id);
}

/**
 * Randomness source, injectable so tests can be deterministic.
 * `crypto.getRandomValues` when available, else a seeded fallback.
 */
export type RandomBytes = (n: number) => Uint8Array;

function defaultRandomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(out);
    return out;
  }
  for (let i = 0; i < n; i += 1) out[i] = Math.floor(Math.random() * 256);
  return out;
}

function encode(bytes: Uint8Array, length: number): string {
  let out = '';
  // Rejection-free mapping: each byte yields 5 base32 chars would waste entropy,
  // so take a 64-bit BigInt path for exact, unbiased coverage of 32^10.
  let acc = 0n;
  let bits = 0n;
  for (const b of bytes) {
    acc = (acc << 8n) | BigInt(b);
    bits += 8n;
    while (bits >= 5n) {
      bits -= 5n;
      const digit = Number((acc >> bits) & 31n);
      out += CROCKFORD_ALPHABET[digit] ?? '0';
      if (out.length === length) return out;
    }
  }
  while (out.length < length) out += '0';
  return out.slice(0, length);
}

/**
 * Generate an id, e.g. `newId('n')` → `n_7K2QX9M4A1`.
 *
 * Callers that need a hard uniqueness guarantee pass `taken`; the generator then
 * re-rolls on collision (project-format.md §2: collision-checked at generation).
 *
 * `maxAttempts` bounds **one round of draws, and there are two rounds**: when
 * every candidate of the first round was taken, the generator draws up to
 * `maxAttempts` more times against the same `taken` set before giving up, so
 * the total is `maxAttempts * 2` draws — the number the throw reports. The
 * second round is more of the same, not a different strategy: there is no
 * fallback shape to fall back to (see the loop's own comment).
 *
 * @throws {Error} when every candidate of both rounds was taken — a randomness
 * source that keeps drawing taken bytes, or a `taken` set covering (nearly) the
 * whole space. Failing loudly is the guarantee: the alternatives are a
 * duplicate id or a shape no consumer accepts. Callers outside a command apply
 * (the store's `read.ts` recovery paths) surface the throw as a failure of the
 * operation they are in; nothing here downgrades it to a returned id.
 */
export function newId(
  prefix: IdPrefix,
  opts: { randomBytes?: RandomBytes; taken?: ReadonlySet<string>; maxAttempts?: number } = {},
): string {
  const randomBytes = opts.randomBytes ?? defaultRandomBytes;
  const maxAttempts = opts.maxAttempts ?? 8;
  const taken = opts.taken;
  // 8 bytes -> 12.8 base32 chars; 10 are needed. 7 bytes would truncate entropy
  // below 32^10, so request 8 and let `encode` slice.
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = `${prefix}_${encode(randomBytes(8), ID_LENGTH)}`;
    if (!taken || !taken.has(candidate)) return candidate;
  }
  // Every candidate so far was taken. Draw again — up to `maxAttempts` more
  // times, at the same length and against the same `taken` set, because there
  // is no second strategy: an id of another length is not an id of this family,
  // so every consumer's shape check would refuse it, and an id that is not
  // checked against `taken` is not unique. This loop is therefore deliberately
  // identical to the one above; the two together are `maxAttempts * 2` draws. A
  // source that keeps drawing the same bytes never gets past them, so the mint
  // fails loudly rather than handing back a duplicate or a shape no consumer
  // accepts.
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = `${prefix}_${encode(randomBytes(8), ID_LENGTH)}`;
    if (!taken || !taken.has(candidate)) return candidate;
  }
  throw new Error(`could not mint a unique ${prefix}_ id after ${maxAttempts * 2} attempts`);
}

/** Deterministic id for fixtures and tests — same seed, same id, every run. */
export function seededId(prefix: IdPrefix, seed: number): string {
  const bytes = new Uint8Array(8);
  let x = seed >>> 0;
  for (let i = 0; i < 8; i += 1) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    bytes[i] = (x >>> 24) & 0xff;
  }
  return `${prefix}_${encode(bytes, ID_LENGTH)}`;
}
