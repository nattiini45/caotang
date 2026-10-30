/**
 * The approval card's data — [extensibility.md §4 rule 5](../../../docs/architecture/extensibility.md),
 * the approval-card content contract for external calls.
 *
 * The card is data, not markup, so the rule that matters can be tested: the description is the
 * server's text in full, the arguments are the whole JSON with nothing elided, the server's name
 * and trust state and risk badge are always present, and a call that is not `read-auto` says it
 * still needs a confirmation. Cursor's dialog hid the tool input, and that gap is what this file
 * exists to close (E4).
 *
 * Two things the card also says (issue #54): that the call follows text the turn read from outside, and that its arguments quote the
 * project. Both are information, never a block: a call the writer meant still runs, after one more click when it quotes the project.
 */

import type { ExternalToolDescriptor } from './client.js';
import type { PinState } from './pins.js';
import type { EffectiveRisk } from './risk.js';

/** Project text that an external call's arguments repeat: a run of words in a row that is also in a document or a codex entry. */
export interface QuoteFinding {
  /** The document or codex entry. */
  readonly nodeId: string;
  readonly title: string;
  /** The length of the longest run in common. */
  readonly words: number;
  /** Where in the arguments it sits, e.g. `args.body`. */
  readonly argPath: string;
  /** The step's number on a plan card, from 1, when the card holds several. */
  readonly step?: number;
}

/** Instruction-shaped content found in a call's arguments or description (the context scan, `scanForInjection`). */
export interface CardHit {
  readonly kind: 'invisible' | 'role-marker' | 'override-phrase' | 'foreign-link';
  readonly excerpt: string;
}

/** Outside text a turn took in before this call: the server it came from, and how a card names it (`Notion › search`). */
export interface TaintRef {
  readonly serverName: string;
  readonly label: string;
}

/** What the loop knows about a call besides its descriptor. */
export interface ApprovalContext {
  readonly followsUntrusted?: readonly TaintRef[];
  readonly quotes?: readonly QuoteFinding[];
  readonly hits?: readonly CardHit[];
}

/** The card's words about the turn and the call, or nothing when there is nothing to say. */
export interface ApprovalCaution {
  /** The labels of the outside text the turn read before this card. */
  readonly followsUntrusted: readonly string[];
  readonly quotes: readonly QuoteFinding[];
  readonly hits: readonly CardHit[];
  /** The sentence the card leads with when the call would send project text to a server after reading another server's content. */
  readonly lead?: string;
  /** Approve needs a second click: the call's arguments quote the project. */
  readonly requiresSecondClick: boolean;
}

export interface ApprovalCard extends Partial<Pick<ApprovalCaution, 'followsUntrusted' | 'quotes' | 'hits' | 'lead'>> {
  readonly serverName: string;
  readonly serverKey: string;
  readonly trustState: 'trusted for reads' | 'not trusted for reads';
  readonly badge: 'read' | 'write';
  readonly risk: EffectiveRisk;
  readonly requiresConfirm: boolean;
  readonly qualifiedName: string;
  readonly toolName: string;
  readonly pinState: PinState;
  /** The server's own description, in full. Never truncated, and never summarised by Caotang. */
  readonly description: string;
  /** Every argument the model sent, pretty-printed. Never truncated. */
  readonly argumentsJson: string;
  /** Said on every card: the text came from an external server and was shown as received. */
  readonly notice: string;
  /** Approve needs a second click. False when the call quotes no project text. */
  readonly requiresSecondClick: boolean;
}

export const APPROVAL_NOTICE = 'This text comes from an external server and is shown exactly as the server sent it.';

/** The titles of the findings, once each, as a sentence's list: “Chapter 3”, or “Chapter 3” and 2 more. */
function titlesOf(quotes: readonly QuoteFinding[]): string {
  const titles = [...new Set(quotes.map((quote) => quote.title))];
  const [first] = titles;
  return titles.length === 1 ? `“${first}”` : `“${first}” and ${titles.length - 1} more`;
}

/**
 * What a card says besides the call: the sources the turn read, the project text the arguments quote, and the scan's hits. The lead sentence
 * is for the cross-server shape: text of the project would go to `target` after the turn read content from another server.
 */
export function cautionOf(target: string, context: ApprovalContext): ApprovalCaution | undefined {
  const sources = context.followsUntrusted ?? [];
  const quotes = context.quotes ?? [];
  const hits = context.hits ?? [];
  if (sources.length === 0 && quotes.length === 0 && hits.length === 0) return undefined;
  const others = sources.filter((source) => source.serverName !== target);
  const lead =
    quotes.length > 0 && others.length > 0
      ? `This call would send text from ${titlesOf(quotes)} to “${target}” after reading content from ${[...new Set(others.map((source) => `“${source.serverName}”`))].join(', ')}.`
      : undefined;
  return {
    followsUntrusted: [...new Set(sources.map((source) => source.label))],
    quotes,
    hits,
    ...(lead === undefined ? {} : { lead }),
    requiresSecondClick: quotes.length > 0,
  };
}

/** The card for one call: the tool's descriptor from the client, the arguments the model sent, and the server's trust grant. */
export function approvalCardFor(tool: ExternalToolDescriptor, args: Record<string, unknown>, trustReads: boolean, context: ApprovalContext = {}): ApprovalCard {
  const caution = cautionOf(tool.serverName, context);
  return {
    serverName: tool.serverName,
    serverKey: tool.serverKey,
    trustState: trustReads ? 'trusted for reads' : 'not trusted for reads',
    badge: tool.effectiveRisk === 'read-auto' ? 'read' : 'write',
    risk: tool.effectiveRisk,
    requiresConfirm: tool.effectiveRisk !== 'read-auto',
    qualifiedName: tool.qualifiedName,
    toolName: tool.toolName,
    pinState: tool.pinState,
    description: tool.description,
    argumentsJson: JSON.stringify(args, null, 2),
    notice: APPROVAL_NOTICE,
    ...(caution === undefined ? {} : { followsUntrusted: caution.followsUntrusted, quotes: caution.quotes, hits: caution.hits, ...(caution.lead === undefined ? {} : { lead: caution.lead }) }),
    requiresSecondClick: caution?.requiresSecondClick ?? false,
  };
}
