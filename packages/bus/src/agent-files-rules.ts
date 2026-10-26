/**
 * The rules of the agent's files that both the bus and the store state — [command-bus.md §9](../../../docs/architecture/command-bus.md),
 * [project-format.md §1](../../../docs/architecture/project-format.md). The bus owns them because a `validate` has to refuse a bad
 * slug or an over-long note before any effect, and the store (which depends on the bus) imports them for its file codec.
 */

export const MEMORY_TYPES = ['style', 'preference', 'process', 'reference'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** A topic's body, in characters (`memory.write`). */
export const MEMORY_BODY_MAX_CHARS = 4_000;
export const MEMORY_TITLE_MAX_CHARS = 120;
export const MEMORY_SLUG_MAX_CHARS = 64;
/** How many topic files a project holds. Past it `memory.write` is refused and the writer forgets one. */
export const MEMORY_MAX_FILES = 200;
/** `CAOTANG.md`, in characters. The layer sends far less (its token cap); this bounds what a project keeps. */
export const INSTRUCTIONS_MAX_CHARS = 50_000;

/** A slug: lowercase letters and digits in hyphen-separated runs. Scanned, not matched by a backtracking pattern. */
export function isMemorySlug(value: string): boolean {
  if (value.length === 0 || value.length > MEMORY_SLUG_MAX_CHARS) return false;
  for (const part of value.split('-')) {
    if (part.length === 0) return false;
    for (let i = 0; i < part.length; i += 1) {
      const code = part.charCodeAt(i);
      const digit = code >= 48 && code <= 57;
      const lower = code >= 97 && code <= 122;
      if (!digit && !lower) return false;
    }
  }
  return true;
}

/** A slug derived from a title: lowercase, anything else a hyphen, runs collapsed. Empty when the title has no letter or digit. */
export function slugOf(title: string): string {
  let out = '';
  let pending = false;
  for (let i = 0; i < title.length && out.length < MEMORY_SLUG_MAX_CHARS; i += 1) {
    const char = title.charAt(i).toLowerCase();
    const code = char.charCodeAt(0);
    if ((code >= 48 && code <= 57) || (code >= 97 && code <= 122)) {
      if (pending && out !== '') out += '-';
      out += char;
      pending = false;
    } else {
      pending = true;
    }
  }
  return out;
}

/**
 * A short, deterministic fingerprint of a text (cyrb53, 14 hex characters). It is a change check and not a security digest: a caller that
 * read a file names the fingerprint it read as `expectedDigest`, and a write is refused when the text is no longer that one. Synchronous,
 * because a `validate` is.
 */
export function textDigest(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h2 >>> 0).toString(16).padStart(8, '0')}${((h1 >>> 0) & 0x1fffff).toString(16).padStart(6, '0')}`;
}
