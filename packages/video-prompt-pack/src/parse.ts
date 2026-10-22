/**
 * Reads model replies back in. A reply that is not the JSON the stage asks for is refused with
 * `MalformedReplyError`, and nothing is guessed from it. A fenced block is unwrapped, since providers
 * often wrap one. Anything else that is not a JSON object is malformed.
 */

import { MalformedReplyError } from './errors.js';

type Obj = Record<string, unknown>;

const FENCE = '```';

/**
 * The body of a reply wrapped in a code fence, trimmed, or null when it is not wrapped in one. The fence opens
 * with three backticks and an optional `json` tag, and closes with three backticks at the very end. Scanned
 * by hand, because a pattern with overlapping whitespace quantifiers backtracks quadratically on a long run of blanks.
 */
function unfence(text: string): string | null {
  if (text.length < 2 * FENCE.length || !text.startsWith(FENCE) || !text.endsWith(FENCE)) return null;
  let start = FENCE.length;
  if (text.slice(start, start + 4).toLowerCase() === 'json') start += 4;
  return text.slice(start, text.length - FENCE.length).trim();
}

/** The fields the draft reply may carry. Audio and negatives are read only when the template takes them. */
export const DRAFT_FIELDS = ['camera', 'subject', 'action', 'context', 'style', 'dialogue', 'sfx', 'ambient', 'music', 'negativePrompt'] as const;
export type DraftField = (typeof DRAFT_FIELDS)[number];

function isRecord(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses a reply to a JSON object, or refuses it as malformed. */
export function parseJsonReply(content: string, stage: string): Obj {
  let text = content.trim();
  const fenced = unfence(text);
  if (fenced !== null) text = fenced;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new MalformedReplyError(stage, 'the reply is not JSON');
  }
  if (!isRecord(value)) throw new MalformedReplyError(stage, 'the top level is not an object');
  return value;
}

export interface DraftReply {
  /** The text fields, trimmed. A null or absent field is left out. */
  readonly fields: Partial<Record<DraftField, string>>;
  /** Keys the reply carried that the draft does not use. Kept so the preview can say what was ignored. */
  readonly ignored: readonly string[];
}

/** Reads a `prompt.draft` reply. A field that is not text is malformed, because the draft cannot use it. */
export function parseDraftReply(content: string): DraftReply {
  const value = parseJsonReply(content, 'prompt.draft');
  const fields: Partial<Record<DraftField, string>> = {};
  const ignored: string[] = [];
  for (const [key, raw] of Object.entries(value)) {
    if (!(DRAFT_FIELDS as readonly string[]).includes(key)) {
      ignored.push(key);
      continue;
    }
    if (raw === null || raw === undefined) continue;
    if (typeof raw !== 'string') throw new MalformedReplyError('prompt.draft', `"${key}" is not text`);
    fields[key as DraftField] = raw.trim();
  }
  return { fields, ignored };
}

/** Reads a `prompt.variant` reply: exactly three alternatives, each non-empty text. */
export function parseVariantReply(content: string): string[] {
  const value = parseJsonReply(content, 'prompt.variant');
  const alternatives = value.alternatives;
  if (!Array.isArray(alternatives)) throw new MalformedReplyError('prompt.variant', 'the reply has no "alternatives" list');
  const texts: string[] = [];
  for (const item of alternatives) {
    if (typeof item !== 'string') throw new MalformedReplyError('prompt.variant', 'an alternative is not text');
    if (item.trim() !== '') texts.push(item.trim());
  }
  if (texts.length < 3) throw new MalformedReplyError('prompt.variant', `${texts.length} usable alternative(s); three are needed`);
  return texts.slice(0, 3);
}
