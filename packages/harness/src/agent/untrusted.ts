/**
 * What the model reads of text from outside the project — [extensibility.md §4 rule 4](../../../../docs/architecture/extensibility.md), issue #54.
 *
 * An external call's result and a loaded external tool's description reach the model inside a spotlight envelope with the turn's id, on both
 * wires (`context/untrusted.ts` has the envelope, the hidden-character reveal and the scan). Only the model-facing copy is changed: the
 * result in the activity log and on the card is the server's text as it came, and the 8,000-token cap was applied to that text before this
 * module saw it.
 *
 * A turn that took such text in is *tainted* (agent-harness §4): the loop asks the writer before a write the turn would otherwise have run
 * by itself, and every card of the turn says what the turn read.
 */

import { nonceFor, scanForInjection, spotlight, UNTRUSTED_OPEN, type InjectionHit } from '@caotang/context';
import type { TaintRef } from '@caotang/mcp-client';

import { isRecord } from '../util.js';

export {
  STATIC_NONCE,
  UNTRUSTED_CLOSE,
  UNTRUSTED_OPEN,
  UNTRUSTED_RULE,
  defuseMarkers,
  neutralise,
  nonceFor,
  revealInvisible,
  scanForInjection,
  sourceLabel,
  spotlight,
  type InjectionHit,
  type UntrustedSource,
} from '@caotang/context';

/** The nonce of a turn's envelopes: the same turn id gives the same id, so an eval run is repeatable and a resumed turn keeps its own. */
export const turnNonce = (turnId: string): string => nonceFor(turnId);

/** What an external call's result looks like to the harness (`runtime.callExternal`). */
interface ExternalBody {
  readonly untrusted: true;
  readonly source: { readonly serverName: string; readonly toolName: string };
  readonly isError: boolean;
  readonly content: unknown;
}

function isExternalBody(body: unknown): body is ExternalBody {
  if (!isRecord(body) || body['untrusted'] !== true) return false;
  const source = body['source'];
  return isRecord(source) && typeof source['serverName'] === 'string' && typeof source['toolName'] === 'string';
}

/** The external matches of a `tool.search` result: the tools whose descriptions the model is about to read. */
function externalMatches(body: unknown): readonly Record<string, unknown>[] {
  if (!isRecord(body) || !Array.isArray(body['matches'])) return [];
  return body['matches'].filter((match): match is Record<string, unknown> => isRecord(match) && match['source'] === 'external' && typeof match['serverName'] === 'string' && typeof match['toolName'] === 'string');
}

/** Which server and tool a tool name belongs to, when it is a loaded external tool; undefined for a native one. */
export type OutsideOf = (tool: string) => { readonly serverName: string; readonly toolName: string } | undefined;

/**
 * Whether a model-facing message carries a connected server's text in an envelope (a result, an error or a description). The rule paragraph
 * of system prompt v2 and a project file's envelope name the markers too, but only a server's source label starts with `mcp`.
 */
export const readsOutsideText = (content: string): boolean => content.includes(`${UNTRUSTED_OPEN} source="mcp`);

/** How a source reads on a card and in a banner: `Notion › search`. */
export const sourceName = (serverName: string, toolName: string): string => `${serverName} › ${toolName}`;

/**
 * What a read result takes into the turn from outside, as the names a banner shows: an external call's own result, and the external
 * tools a search surfaced (their descriptions are outside text as well). Nothing for a native result.
 */
export function outsideSources(body: unknown): readonly TaintRef[] {
  if (isExternalBody(body)) return [{ serverName: body.source.serverName, label: sourceName(body.source.serverName, body.source.toolName) }];
  return externalMatches(body).map((match) => ({ serverName: match['serverName'] as string, label: sourceName(match['serverName'] as string, match['toolName'] as string) }));
}

/**
 * A result as the model reads it. A native result is the JSON it always was. An external call's is a JSON line that says where it came
 * from, then its content blocks in an envelope. A search keeps its JSON, with each external match's excerpt in an envelope of its own.
 * `named` puts the tool's name in the line (the JSON wire); the native wire answers a call by its id and leaves it out. A failed call of a
 * loaded external tool (`outside`) is outside text too: the server's own words sit in its error, so the error goes in an envelope.
 */
export function modelResult(result: { readonly tool: string; readonly ok: boolean; readonly body: unknown }, nonce: string, named = true, outside?: OutsideOf): string {
  const head = named ? { tool: result.tool } : {};
  if (!result.ok) {
    const from = outside?.(result.tool);
    if (from === undefined) return JSON.stringify({ ...head, ok: false, error: result.body });
    const text = typeof result.body === 'string' ? result.body : (JSON.stringify(result.body) ?? '');
    return `${JSON.stringify({ ...head, ok: false, error: 'in the untrusted block below' })}\n${spotlight(text, { kind: 'mcp-result', ...from }, nonce)}`;
  }
  if (isExternalBody(result.body)) {
    const { content, ...rest } = result.body;
    const line = JSON.stringify({ ...head, ok: true, data: { ...rest, content: 'in the untrusted block below' } });
    const text = JSON.stringify(content);
    return `${line}\n${spotlight(text, { kind: 'mcp-result', serverName: result.body.source.serverName, toolName: result.body.source.toolName }, nonce)}`;
  }
  if (externalMatches(result.body).length > 0) {
    const body = result.body as { readonly matches: readonly unknown[] };
    const matches = body.matches.map((match) =>
      isRecord(match) && externalMatches({ matches: [match] }).length === 1 && typeof match['excerpt'] === 'string'
        ? { ...match, excerpt: spotlight(match['excerpt'], { kind: 'mcp-description', serverName: match['serverName'] as string, toolName: match['toolName'] as string }, nonce) }
        : match,
    );
    return JSON.stringify({ ...head, ok: true, data: { ...body, matches } });
  }
  return JSON.stringify({ ...head, ok: true, data: result.body });
}

/* ------------------------------------------------------------------ *
 * The scan at import
 * ------------------------------------------------------------------ */

/** A hit, and which field of what was imported held it. */
export interface ImportHit extends InjectionHit {
  readonly where: string;
}

/** How many hits an import lists. The count it found is said as well. */
export const IMPORT_HITS_MAX = 10;

/** What the scan found in the text a tool is about to import, field by field. Nothing is changed or refused: the text is stored as given. */
export function scanImport(parts: readonly { readonly where: string; readonly text: string }[]): { readonly total: number; readonly hits: readonly ImportHit[] } {
  const all = parts.flatMap((part) => scanForInjection(part.text).map((hit): ImportHit => ({ ...hit, where: part.where })));
  return { total: all.length, hits: all.slice(0, IMPORT_HITS_MAX) };
}

const KIND_WORDS: Readonly<Record<InjectionHit['kind'], string>> = {
  invisible: 'hidden characters',
  'role-marker': 'a chat role marker',
  'override-phrase': 'a phrase that tells an AI to drop its instructions',
  'foreign-link': 'a link to an outside address',
};

/**
 * The sentence an import's notice adds when the scan found something, and nothing when it found nothing. It says what the text was imported
 * as: exactly as given, so the writer reads it before an agent does.
 */
export function importScanSentence(name: string, found: { readonly total: number; readonly hits: readonly InjectionHit[] }): string | undefined {
  const [first] = found.hits;
  if (first === undefined) return undefined;
  const kinds = [...new Set(found.hits.map((hit) => KIND_WORDS[hit.kind]))].join(', ');
  const count = found.total === 1 ? '1 passage that looks' : `${found.total} passages that look`;
  return `${name}: ${count} like instructions to an AI (${kinds}), for example “${first.excerpt}”. The text was imported exactly as it is; read it before you ask the agent to work from it.`;
}
