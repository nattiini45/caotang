/**
 * Line ids — [dialogue-narrative.md §2.2 and §6](../../../docs/architecture/dialogue-narrative.md).
 *
 * A spoken line carries `# lineId: l_` + 10 Crockford base32 characters, minted by Caotang and
 * never typed by hand. A choice label takes the same shape with `_c`. The id lives in the Ink
 * text, so it survives every edit of the line's words and dies with the line; nothing else
 * stores it. Minting is opt-in per container (A3) and writes only where the parse says the
 * tag keeps the runtime output (`MintMode` in ink-parse.ts).
 */

import { CROCKFORD_ALPHABET, ID_LENGTH, type RandomBytes } from '@caotang/ids';

import { parseInk, type DialogueLine } from './ink-parse.js';

export interface MintOptions {
  /** Randomness, injectable so a fixture mints the same ids every run. */
  readonly randomBytes?: RandomBytes;
  /** Ids already in use in this body or elsewhere in the project. A candidate is re-rolled on a hit. */
  readonly taken?: ReadonlySet<string>;
  /** Ids of deleted lines. Never reused (§6: deleting a line retires its id). */
  readonly retired?: ReadonlySet<string>;
}

export interface MintedId {
  readonly line: number;
  readonly lineId: string;
}

export interface UnplaceableLine {
  readonly line: number;
  readonly text: string;
  readonly reason: string;
}

export interface EnsureResult {
  /** The body with the minted tags written in. Unchanged when nothing was minted. */
  readonly body: string;
  readonly minted: readonly MintedId[];
  /** Lines that need an id and cannot take one without changing their output. The author moves the divert. */
  readonly unplaceable: readonly UnplaceableLine[];
}

const ATTEMPTS = 16;
/**
 * The body of a line id: one Crockford character per random byte, and the same
 * length every other id body in the system carries (`@caotang/ids`'s
 * `ID_LENGTH`) — so a line id is the same shape as the id beside it.
 */
const ID_CHARS = ID_LENGTH;

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

/**
 * One line id. The alphabet has 32 symbols and a byte has 256 values, so `byte & 31` is an
 * unbiased draw from it. A choice label's id is the same base with the `_c` suffix.
 */
export function mintLineId(kind: 'line' | 'choice', options: MintOptions = {}): string {
  const randomBytes = options.randomBytes ?? defaultRandomBytes;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    let base = 'l_';
    for (const byte of randomBytes(ID_CHARS)) base += CROCKFORD_ALPHABET.charAt(byte & 31);
    const candidate = kind === 'choice' ? `${base}_c` : base;
    if (!options.taken?.has(candidate) && !options.retired?.has(candidate)) return candidate;
  }
  throw new Error('could not mint a free line id: the random source repeats');
}

/** The valid ids a body already carries, by line. Malformed tags are not ids and are not listed. */
export function lineIdsOf(body: string): MintedId[] {
  return parseInk(body)
    .lines.filter((line): line is DialogueLine & { lineId: string } => line.lineId !== null)
    .map((line) => ({ line: line.line, lineId: line.lineId }));
}

interface Edit {
  readonly at: number;
  readonly insert: string;
}

/** The edit that writes one line's tag, or the reason no edit can. */
function editFor(line: DialogueLine, id: string): Edit | UnplaceableLine {
  const tag = `# lineId: ${id}`;
  switch (line.mint) {
    case 'inline':
      return { at: line.to, insert: ` ${tag}` };
    case 'above':
      return { at: line.lineStart, insert: `${line.indent}${tag}\n` };
    case 'bracket':
      return { at: line.bracketClose, insert: ` ${tag}` };
    case 'none':
      return {
        line: line.line,
        text: line.text,
        reason: 'a divert on this line leaves no place for the tag without changing what the reader sees',
      };
  }
}

function isEdit(value: Edit | UnplaceableLine): value is Edit {
  return 'at' in value;
}

/**
 * Writes a fresh id into every speakable line that has none. Lines with an id, valid or
 * malformed, are left alone: a malformed tag is the author's to fix, not a thing to overwrite.
 * Edits apply from the end of the body backwards, so every offset stays valid.
 */
export function ensureLineIds(body: string, options: MintOptions = {}): EnsureResult {
  const parsed = parseInk(body);
  const taken = new Set<string>(options.taken ?? []);
  for (const line of parsed.lines) if (line.lineId !== null) taken.add(line.lineId);
  const minted: MintedId[] = [];
  const unplaceable: UnplaceableLine[] = [];
  const edits: Edit[] = [];

  for (const line of parsed.lines) {
    if (line.lineId !== null || line.malformedId !== null) continue;
    const kind = line.kind === 'choice' ? 'choice' : 'line';
    const id = mintLineId(kind, { ...options, taken });
    taken.add(id);
    const result = editFor(line, id);
    if (isEdit(result)) {
      edits.push(result);
      minted.push({ line: line.line, lineId: id });
    } else {
      unplaceable.push(result);
    }
  }

  let next = body;
  for (const edit of [...edits].sort((a, b) => b.at - a.at)) {
    next = next.slice(0, edit.at) + edit.insert + next.slice(edit.at);
  }
  return { body: next, minted, unplaceable };
}

/** The speakable lines that have no valid id, for the export gate and the table's count. */
export function missingLineIds(body: string): DialogueLine[] {
  return parseInk(body).lines.filter((line) => line.lineId === null);
}

/**
 * Removes every `lineId` tag from a drafted block, valid or not, so an id the model typed never
 * reaches the body (§2.2: ids are minted by Caotang). A `#` left with nothing after it goes with the
 * id, so a tag-only line is left blank and a bracketed choice keeps its brackets. Other tags stay.
 */
export function stripLineIdTags(ink: string): { readonly ink: string; readonly removed: number } {
  let removed = 0;
  const lines = ink.split('\n').map((line) => {
    if (!line.includes('lineId:')) return line;
    const withoutIds = line.replace(/lineId:[ \t]*[^\s#\]]*/g, () => {
      removed += 1;
      return '';
    });
    return withoutIds.replace(/[ \t]*#[ \t]*(?=\]|\r?$)/, '');
  });
  return { ink: lines.join('\n'), removed };
}
