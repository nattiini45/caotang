/**
 * `codex.read` as a pure function — [agent-harness.md](../../../docs/architecture/agent-harness.md)
 * row 12 and [codex.md §7](../../../docs/architecture/codex.md).
 *
 * The harness wraps this. Parameter validation and the tool envelope are its job. What
 * is decided here is what the model reads back, and the rules are:
 *
 * - Search covers name, aliases and description, case-insensitively. Keywords are the
 *   human-only lane (codex.md §2) and are never searched or returned.
 * - Results list a preview: the text around the first description hit, or the first
 *   200 characters when there is no hit. An id fetch returns the full description when
 *   the result fits the cap, and a marked prefix when it does not.
 * - An entry's saved references and relations come back with their ids (`ref_`, `rel_`),
 *   because those ids are what `codex.write` takes to update or remove one. Automatic
 *   context carries neither; only this explicit read does.
 * - Empty is a result, not an error. The note tells the model to create the entry.
 * - The serialised result is capped at 8k estimated tokens. A list drops whole entries
 *   from the end. An id fetch cuts its description to the longest prefix that fits.
 *   Either way the result says so, and an id fetch's note states the full length.
 */

import type { CodexEntry, CodexIncludePolicy } from '@caotang/store';
import { compareCodex } from './order.js';
import { canonical, caseFold, tokensForChars } from './text.js';

export const CODEX_READ_DEFAULT_LIMIT = 25;
export const CODEX_READ_MAX_LIMIT = 100;
/** agent-harness.md row 12: "Cap 8k tokens", on the context-assembly §3 estimate. */
export const CODEX_READ_TOKEN_CAP = 8000;
/** codex.md §7: "query-hit ±80 chars context". */
export const CODEX_READ_WINDOW = 80;
/** codex.md §7: "else first 200 chars". */
export const CODEX_READ_PREVIEW = 200;

const EMPTY_NOTE = 'no entries match; use codex.write to create';
const CAP_NOTE = 'result capped at 8k tokens; narrow the query or fetch one entry by id';
/** Reserved for the envelope and the note, so the running estimate never undershoots. */
const ENVELOPE_RESERVE_CHARS = 512;
/**
 * The same cap in characters. `tokensForChars(n)` is within the token cap exactly when
 * `n` is at most this, so a serialised result is checked against one number.
 */
const SERIALISED_CHAR_CAP = CODEX_READ_TOKEN_CAP * 4;

export interface CodexReadQuery {
  /** Case-insensitive substring over name, aliases and description. Blank means no query. */
  readonly query?: string;
  /** A codex type, or 'all' (the default). An unknown type matches entries carrying it. */
  readonly type?: string;
  /** A policy, or 'all' (the default). */
  readonly includePolicy?: CodexIncludePolicy | 'all';
  /** Exact fetch: returns the full description. `query` and `limit` do not apply. */
  readonly id?: string;
  /** Default 25. Values are clamped to 1–100. */
  readonly limit?: number;
}

export interface CodexReadSource {
  readonly entries: readonly CodexEntry[];
  /**
   * Cached mention counts by entry id, when the caller has them (see
   * `MentionIndex.cachedTotals`). When supplied, every item carries a `mentions` count,
   * and 0 means the entry is not in the cached documents.
   */
  readonly mentions?: ReadonlyMap<string, number>;
  /**
   * The entry's stored references and relations, read by the caller, when it has the
   * readers for them (the bus validates and reads those records, and this package is
   * below it). When supplied, each item carries the ids `codex.write` takes.
   */
  readonly links?: ReadonlyMap<string, CodexEntryLinks>;
}

/** One stored reference, as `codex.read` reports it: the id `codex.write` takes, and its title. */
export interface CodexReadReference {
  readonly id: string;
  readonly title: string;
}

/** One stored relation, as `codex.read` reports it: its id, where it points, and the target's name. */
export interface CodexReadRelation {
  readonly id: string;
  readonly targetId: string;
  /** The target entry's name, or its id when that entry is gone. */
  readonly target: string;
  readonly label?: string;
}

export interface CodexEntryLinks {
  readonly references?: readonly CodexReadReference[];
  readonly relations?: readonly CodexReadRelation[];
}

export type CodexMatchField = 'name' | 'alias' | 'description';

export interface CodexReadItem {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly type: string;
  readonly includePolicy: CodexIncludePolicy;
  readonly origin: CodexEntry['origin'];
  /**
   * The full description for an id fetch that fits the cap, a prefix of it when it does
   * not, and otherwise a preview (see `excerpt`).
   */
  readonly description: string;
  /** True when `description` is a window, a preview or a prefix, and not the whole text. */
  readonly excerpt: boolean;
  readonly attachments: readonly string[];
  /** The entry's visual reference asset ids (video-prompt-pack.md §3). Present only when the entry has some. */
  readonly visualRefs?: readonly string[];
  /** Present only when the source supplied mention counts. */
  readonly mentions?: number;
  /** The entry's saved references, each with the `ref_` id `codex.write` takes. Present only when it has some. */
  readonly references?: readonly CodexReadReference[];
  /** The links this entry states, each with the `rel_` id `codex.write` takes. Present only when it has some. */
  readonly relations?: readonly CodexReadRelation[];
  /** Present only with a query: which fields matched. */
  readonly matchedOn?: readonly CodexMatchField[];
}

export interface CodexReadResult {
  readonly entries: readonly CodexReadItem[];
  /** Matches before `limit` and the token cap are applied. */
  readonly total: number;
  readonly truncated: boolean;
  /** Model-facing guidance, present when the result is empty or was cut short. */
  readonly note?: string;
}

interface Hit {
  readonly entry: CodexEntry;
  /** Undefined when there is no query, so every hit matches for the same reason. */
  readonly matchedOn: readonly CodexMatchField[] | undefined;
}

export function codexRead(request: CodexReadQuery, source: CodexReadSource): CodexReadResult {
  const admit = admitFor(request);

  if (request.id !== undefined) return fetchById(request.id, admit, source);

  const needle = queryNeedle(request.query);
  const hits: Hit[] = [];
  for (const entry of source.entries) {
    if (!admit(entry)) continue;
    if (needle === undefined) {
      hits.push({ entry, matchedOn: undefined });
      continue;
    }
    const matchedOn = matchFields(entry, needle);
    if (matchedOn.length > 0) hits.push({ entry, matchedOn });
  }

  // With a query, a name or alias hit outranks a description-only hit. Within a tier,
  // codex order, so the same query always lists the same entries in the same order.
  hits.sort((a, b) => tierOf(a) - tierOf(b) || compareCodex(a.entry, b.entry));

  if (hits.length === 0) return { entries: [], total: 0, truncated: false, note: EMPTY_NOTE };
  return page(hits, clampLimit(request.limit), needle, source);
}

function admitFor(request: CodexReadQuery): (entry: CodexEntry) => boolean {
  const type = request.type === undefined || request.type === 'all' ? undefined : request.type;
  const policy =
    request.includePolicy === undefined || request.includePolicy === 'all' ? undefined : request.includePolicy;
  return (entry) =>
    (type === undefined || entry.type === type) && (policy === undefined || entry.includePolicy === policy);
}

/** The query as matching sees it: canonical and case-folded. Blank means no query. */
function queryNeedle(query: string | undefined): string | undefined {
  if (query === undefined) return undefined;
  const needle = fold(query.trim());
  return needle === '' ? undefined : needle;
}

function fold(text: string): string {
  return caseFold(canonical(text));
}

function matchFields(entry: CodexEntry, needle: string): CodexMatchField[] {
  const fields: CodexMatchField[] = [];
  if (fold(entry.name).includes(needle)) fields.push('name');
  if (aliasesOf(entry).some((alias) => fold(alias).includes(needle))) fields.push('alias');
  if (fold(descriptionOf(entry)).includes(needle)) fields.push('description');
  return fields;
}

// validate.ts checks these fields only when they are present, so an entry loaded without
// them reaches the engine with them absent. A read shows each absent field as empty.
function aliasesOf(entry: CodexEntry): readonly string[] {
  return entry.aliases ?? [];
}

function attachmentsOf(entry: CodexEntry): readonly string[] {
  return entry.attachments ?? [];
}

function descriptionOf(entry: CodexEntry): string {
  return entry.description ?? '';
}

function tierOf(hit: Hit): number {
  if (hit.matchedOn === undefined) return 0;
  return hit.matchedOn.some((field) => field !== 'description') ? 0 : 1;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit)) return CODEX_READ_DEFAULT_LIMIT;
  return Math.min(CODEX_READ_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

function fetchById(id: string, admit: (entry: CodexEntry) => boolean, source: CodexReadSource): CodexReadResult {
  const entry = source.entries.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    return {
      entries: [],
      total: 0,
      truncated: false,
      note: `no codex entry with id "${id}"; use codex.read with a query to find it`,
    };
  }
  if (!admit(entry)) {
    return {
      entries: [],
      total: 0,
      truncated: false,
      note: `codex entry "${id}" does not match the type or includePolicy filter`,
    };
  }
  return fetchedResult(entry, source);
}

/**
 * The id fetch. The full description is returned when the whole result fits the cap.
 * Otherwise it is cut to the longest prefix that does, marked `excerpt`, and the note
 * gives the full length. When the entry overflows without its description (an
 * over-long alias, say), no entry is returned, and the note says why.
 *
 * Escaping only lengthens the serialised form, so a description longer than the cap in
 * characters can never fit whole, and the search starts from that bound. Fitting is
 * monotone in the cut, so a binary search finds the longest prefix that fits.
 */
function fetchedResult(entry: CodexEntry, source: CodexReadSource): CodexReadResult {
  const full = descriptionOf(entry);
  const whole: CodexReadResult = {
    entries: [itemOf(entry, { text: full, excerpt: false }, undefined, source)],
    total: 1,
    truncated: false,
  };
  if (full.length <= SERIALISED_CHAR_CAP && fitsCap(whole)) return whole;

  if (!fitsCap(excerptOf(entry, '', full, source))) {
    return {
      entries: [],
      total: 1,
      truncated: true,
      note: `codex entry "${entry.id}" is over the 8k-token result cap without its description; its name or aliases are too long to return`,
    };
  }

  // Invariant: `low` fits (zero does, by the check above), and `high` bounds the answer.
  let low = 0;
  let high = Math.min(full.length, SERIALISED_CHAR_CAP);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fitsCap(excerptOf(entry, cutAt(full, mid), full, source))) low = mid;
    else high = mid - 1;
  }
  return excerptOf(entry, cutAt(full, low), full, source);
}

/** The id fetch's result when only the first `text.length` characters of `full` are shown. */
function excerptOf(entry: CodexEntry, text: string, full: string, source: CodexReadSource): CodexReadResult {
  return {
    entries: [itemOf(entry, { text, excerpt: true }, undefined, source)],
    total: 1,
    truncated: false,
    note: `description is ${full.length} characters; the first ${text.length} are shown, and the rest is over the 8k-token result cap`,
  };
}

/** The first `end` code units of `text`, moved back one unit when the cut would split a surrogate pair. */
function cutAt(text: string, end: number): string {
  const at = end < text.length && isLowSurrogate(text.charCodeAt(end)) ? end - 1 : end;
  return text.slice(0, at);
}

/** True when the serialised result is within the token cap, on the estimate the budget uses. */
function fitsCap(result: CodexReadResult): boolean {
  return tokensForChars(JSON.stringify(result).length) <= CODEX_READ_TOKEN_CAP;
}

/**
 * Apply the limit, then the token cap, to the ordered hits. The cap is applied
 * greedily from the front, so an overflow drops the trailing entries and the order
 * of what remains is unchanged.
 */
function page(hits: readonly Hit[], limit: number, needle: string | undefined, source: CodexReadSource): CodexReadResult {
  const items: CodexReadItem[] = [];
  let chars = ENVELOPE_RESERVE_CHARS;
  let capped = false;
  for (const hit of hits.slice(0, limit)) {
    const item = toItem(hit, needle, source);
    // The trailing comma of the array is counted with the item.
    const size = JSON.stringify(item).length + 1;
    if (tokensForChars(chars + size) > CODEX_READ_TOKEN_CAP) {
      capped = true;
      break;
    }
    chars += size;
    items.push(item);
  }

  const total = hits.length;
  const truncated = items.length < total;
  let note: string | undefined;
  if (capped) note = CAP_NOTE;
  else if (truncated) note = `showing ${items.length} of ${total}; raise limit (max ${CODEX_READ_MAX_LIMIT}) or narrow the query`;
  return note === undefined ? { entries: items, total, truncated } : { entries: items, total, truncated, note };
}

function toItem(hit: Hit, needle: string | undefined, source: CodexReadSource): CodexReadItem {
  return itemOf(hit.entry, previewOf(descriptionOf(hit.entry), needle), hit.matchedOn, source);
}

/** The model-facing item. `text` is the description as shown: a preview, a whole text or a prefix. */
function itemOf(
  entry: CodexEntry,
  text: { readonly text: string; readonly excerpt: boolean },
  matchedOn: readonly CodexMatchField[] | undefined,
  source: CodexReadSource,
): CodexReadItem {
  return {
    id: entry.id,
    name: entry.name,
    aliases: [...aliasesOf(entry)],
    type: entry.type,
    includePolicy: entry.includePolicy,
    origin: entry.origin,
    description: text.text,
    excerpt: text.excerpt,
    attachments: [...attachmentsOf(entry)],
    ...(entry.visualRefs === undefined || entry.visualRefs.length === 0 ? {} : { visualRefs: [...entry.visualRefs] }),
    ...(source.mentions === undefined ? {} : { mentions: source.mentions.get(entry.id) ?? 0 }),
    ...(source.links?.get(entry.id) ?? {}),
    ...(matchedOn === undefined ? {} : { matchedOn }),
  };
}

/**
 * The text shown for a description. When the needle occurs, that is a window of
 * CODEX_READ_WINDOW characters either side of the first occurrence. When it does not,
 * it is the first CODEX_READ_PREVIEW characters. The text is canonical (NFC); the
 * window is cut on the folded text, which has the same length, so the indices agree.
 */
function previewOf(description: string, needle: string | undefined): { text: string; excerpt: boolean } {
  const text = canonical(description);
  const at = needle === undefined ? -1 : caseFold(text).indexOf(needle);

  let from = 0;
  let to = Math.min(text.length, CODEX_READ_PREVIEW);
  if (needle !== undefined && at !== -1) {
    from = Math.max(0, at - CODEX_READ_WINDOW);
    to = Math.min(text.length, at + needle.length + CODEX_READ_WINDOW);
  }

  // Never cut a surrogate pair: widen the window by the one code unit that would split it.
  if (from > 0 && isLowSurrogate(text.charCodeAt(from))) from -= 1;
  if (to < text.length && isLowSurrogate(text.charCodeAt(to))) to += 1;

  const body = text.slice(from, to);
  const excerpt = from > 0 || to < text.length;
  return {
    text: `${from > 0 ? '…' : ''}${body}${to < text.length ? '…' : ''}`,
    excerpt,
  };
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
