/**
 * Line and cue ids — [av-script.md §2 and §3](../../../docs/architecture/av-script.md), on the dialogue package's pattern
 * (`packages/dialogue/src/line-ids.ts`).
 *
 * A speech line, a narration line and a cue carry a trailing `<!-- lineId: sl_… -->` (a cue `sc_…`) tag: the prefix
 * plus 10 Crockford base32 characters, minted by Caotang on save and never typed by hand. The id lives in the body, so it
 * survives every edit of the line's words and dies with the line. A malformed tag is left alone and reported, never
 * overwritten; a duplicated id is reported, and the second line carrying it reads with a session-local id. A save never
 * rewrites either. A text line is not spoken and takes no tag.
 */

import { CROCKFORD_ALPHABET, CROCKFORD_ALPHABET_ESCAPED, ID_LENGTH, type RandomBytes } from '@caotang/ids';

import { classifyBodyLines } from './parse.js';

/** A minted line id: `sl_` plus ten Crockford characters. */
export const SCRIPT_LINE_ID = new RegExp(`^sl_[${CROCKFORD_ALPHABET_ESCAPED}]{${ID_LENGTH}}$`);

/** A minted cue id: `sc_` plus ten Crockford characters. */
export const SCRIPT_CUE_ID = new RegExp(`^sc_[${CROCKFORD_ALPHABET_ESCAPED}]{${ID_LENGTH}}$`);

export interface ScriptMintOptions {
  /** Randomness, injectable so a fixture mints the same ids every run. */
  readonly randomBytes?: RandomBytes;
  /** Ids already in use. A candidate is re-rolled on a hit. */
  readonly taken?: ReadonlySet<string>;
  /** Ids of deleted lines. Never reused. */
  readonly retired?: ReadonlySet<string>;
  /** The show's cue vocabulary, so the mint knows which lines are cues. Absent = the default six. */
  readonly vocabulary?: readonly string[];
}

export interface ScriptMintedId {
  /** The 1-based body line the tag was written on. */
  readonly line: number;
  readonly id: string;
}

export interface ScriptEnsureResult {
  /** The body with the minted tags written in. The same string when nothing was minted. */
  readonly body: string;
  readonly minted: readonly ScriptMintedId[];
}

const ATTEMPTS = 16;

function defaultRandomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const source = globalThis.crypto;
  if (source && typeof source.getRandomValues === 'function') {
    source.getRandomValues(out);
    return out;
  }
  for (let i = 0; i < n; i += 1) out[i] = Math.floor(Math.random() * 256);
  return out;
}

/** The text without the spaces and tabs at its end. A loop, not a regular expression, so a long run of tabs costs one pass. */
function trimSpacesEnd(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === ' ' || text[end - 1] === '\t')) end -= 1;
  return text.slice(0, end);
}

/** One id: `sl_` for a line, `sc_` for a cue. `byte & 31` is an unbiased draw from the 32-symbol alphabet. */
export function mintScriptId(kind: 'line' | 'cue', options: ScriptMintOptions = {}): string {
  const randomBytes = options.randomBytes ?? defaultRandomBytes;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    let candidate = kind === 'cue' ? 'sc_' : 'sl_';
    for (const byte of randomBytes(ID_LENGTH)) candidate += CROCKFORD_ALPHABET.charAt(byte & 31);
    if (!options.taken?.has(candidate) && !options.retired?.has(candidate)) return candidate;
  }
  throw new Error('could not mint a free script line id: the random source repeats');
}

/** True when `id` is a minted id of the kind a line or a cue carries. */
export function isMintedScriptId(id: string, kind: 'line' | 'cue'): boolean {
  return (kind === 'cue' ? SCRIPT_CUE_ID : SCRIPT_LINE_ID).test(id);
}

/**
 * Writes a fresh tag at the end of every speech line, narration line and cue that has none — the save step (§3). A line
 * with a tag, valid, malformed or duplicated, is left as it is. Line endings (`\n` or `\r\n`) are kept.
 */
export function ensureScriptLineIds(body: string, options: ScriptMintOptions = {}): ScriptEnsureResult {
  const lines = body.split('\n');
  const classified = classifyBodyLines(body, options.vocabulary);
  const taken = new Set<string>(options.taken ?? []);
  for (const entry of classified) if (entry.tag !== undefined) taken.add(entry.tag);
  const minted: ScriptMintedId[] = [];
  for (const entry of classified) {
    if (entry.role === 'text' || entry.tag !== undefined) continue;
    const id = mintScriptId(entry.role === 'cue' ? 'cue' : 'line', { ...options, taken });
    taken.add(id);
    const index = entry.line - 1;
    const raw = lines[index] ?? '';
    const cr = raw.endsWith('\r') ? '\r' : '';
    const content = trimSpacesEnd(cr === '' ? raw : raw.slice(0, -1));
    lines[index] = `${content} <!-- lineId: ${id} -->${cr}`;
    minted.push({ line: entry.line, id });
  }
  return minted.length === 0 ? { body, minted } : { body: lines.join('\n'), minted };
}
