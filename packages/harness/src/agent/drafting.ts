/**
 * The model-backed generation for `scene.draft`, `synopsis.fill` and `continuity.scan`.
 *
 * These tools call the model, and the harness's dispatch is synchronous, so the generation happens
 * here, in the async loop, **before** a step is previewed or applied. Its output is a *proposal*:
 * plain data that the card shows, that the user can retry or discard, and that a port applies once
 * the step is approved (`ports.ts`). Nothing in this file writes to the project.
 *
 * The prompt of each call is assembled by `@caotang/context` (context.ts), and this file sends the messages
 * it is given. What this file owns is each call's role text (its system message), and how the reply is read.
 *
 * Each call is one completion through the gateway, tagged with the turn, so its usage lands in the
 * per-turn ledger (provider-gateway §6). Deltas are passed on as they arrive, which is how the
 * ghost-preview region streams (agent-harness §8).
 *
 * Every stream ends with a finish reason (provider-gateway §3), and this file reads it:
 *  - `length`: the provider stopped at its output limit, so the text is cut short. The proposal says
 *    so, and the card blocks approval until the draft is retried or the cut text is accepted.
 *  - `error`: the stream ended on a failure with part of an answer. That is not a whole answer, so
 *    nothing is staged from it and the turn stops (`GenerationStopped`).
 */

import type { ChatChunk, ChatMessage, ChatRequest, ProviderGateway, ReasoningBlock, ThinkingLevel, ToolCall, ToolDef } from '@caotang/gateway';
import { countBody } from '@caotang/store';

import { err, ok, type Result } from '@caotang/bus';
import type { PromptPreview } from '@caotang/context';

import { param, type ObjectSpec } from '../schema.js';
import { checkParams } from '../validate.js';
import { DRAFT_SYSTEM_PREFIX } from './protocol.js';
import { estimateTokens } from '../tokens.js';
import { isRecord } from '../util.js';

/** What one generation call needs from the session: the gateway, the turn it belongs to, and where deltas go. */
export interface ModelCall {
  /** Only `complete` is used here, so the session can count the requests a turn makes. */
  readonly gateway: Pick<ProviderGateway, 'complete'>;
  readonly turnId: string;
  readonly profileId?: string;
  readonly model?: string;
  /**
   * The tools the request declares for native tool calling. Set only on planner calls for a model
   * `modelCaps` reports as tool-capable; drafting calls leave it unset, and their replies never
   * carry `toolCalls`.
   */
  readonly tools?: readonly ToolDef[];
  /** The session's effort level, when it pins one — passed to the request as `thinking`. */
  readonly thinking?: ThinkingLevel;
  readonly onDelta?: (text: string) => void;
  /**
   * The call's reasoning deltas as they stream (provider-gateway §3). The panel folds them into its "Thinking" block;
   * the reply's terminal `reasoning` blocks are replay data for the next request and do not come through here.
   */
  readonly onReasoning?: (text: string) => void;
}

/**
 * A generation the provider ended on its error finish. Its text is part of an answer and not a whole
 * one, so nothing is staged from it: the turn stops, and the message says how far the answer got.
 */
export class GenerationStopped extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GenerationStopped';
  }
}

/**
 * A completion's text, and whether the provider stopped it at its output limit. A native-mode reply
 * also carries the calls it asked for and the reasoning blocks that preceded them, exactly as the
 * provider sent them — the loop replays both verbatim on the next request.
 */
export interface Completion {
  readonly text: string;
  readonly cut: boolean;
  readonly toolCalls?: readonly ToolCall[];
  readonly reasoning?: readonly ReasoningBlock[];
}

/** The estimated prompt and completion tokens of one generation, on the budgets' own estimate (context-assembly §3). */
export interface Spend {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

/**
 * The text of one completion, streamed through the gateway, with its finish reason. A gateway failure
 * propagates as the gateway threw it. A stream that finished on `error` throws `GenerationStopped`.
 */
export async function complete(call: ModelCall, messages: readonly ChatMessage[], responseFormat?: ChatRequest['responseFormat']): Promise<Completion> {
  let text = '';
  let finish: ChatChunk['finishReason'];
  let toolCalls: readonly ToolCall[] | undefined;
  let reasoning: readonly ReasoningBlock[] | undefined;
  const request: ChatRequest = {
    messages: [...messages],
    turnId: call.turnId,
    ...(call.profileId === undefined ? {} : { profileId: call.profileId }),
    ...(call.model === undefined ? {} : { model: call.model }),
    ...(responseFormat === undefined ? {} : { responseFormat }),
    ...(call.tools === undefined || call.tools.length === 0 ? {} : { tools: call.tools, toolChoice: 'auto' as const }),
    ...(call.thinking === undefined ? {} : { thinking: call.thinking }),
  };
  for await (const chunk of call.gateway.complete(request)) {
    if (chunk.delta !== undefined && chunk.delta.length > 0) {
      text += chunk.delta;
      call.onDelta?.(chunk.delta);
    }
    // Streamed reasoning is panel text (the collapsed "Thinking" block); a terminal `reasoning` block
    // is replay data for the next request and stays off this channel.
    if (chunk.reasoningDelta !== undefined && chunk.reasoningDelta.length > 0) call.onReasoning?.(chunk.reasoningDelta);
    // Calls and reasoning arrive on the terminal chunk; take the last value either way, so a
    // provider that announces them piecemeal still lands its final form.
    if (chunk.toolCalls !== undefined) toolCalls = chunk.toolCalls;
    if (chunk.reasoning !== undefined) reasoning = chunk.reasoning;
    if (chunk.finishReason !== undefined) finish = chunk.finishReason;
  }
  if (finish === 'error') throw new GenerationStopped(`the provider ended the answer on an error after ${text.length} characters`);
  return {
    text,
    cut: finish === 'length',
    ...(toolCalls === undefined ? {} : { toolCalls }),
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

/** The estimated spend of one generation: its messages, and the text it produced. */
export function spendOf(messages: readonly ChatMessage[], completion: string): Spend {
  return {
    promptTokens: messages.reduce((total, message) => total + estimateTokens(message.content), 0),
    completionTokens: estimateTokens(completion),
  };
}

/** The spend of two generations together. */
export function addSpend(a: Spend, b: Spend): Spend {
  return { promptTokens: a.promptTokens + b.promptTokens, completionTokens: a.completionTokens + b.completionTokens };
}

/** The words of a piece of text, counted the way the store counts a body, so every number in the app agrees. */
export function wordsOf(text: string): number {
  return countBody(text).words;
}

/** The first `max` words of `text`. Used to hold a synopsis to its limit, which the model is asked to keep but may not. */
export function truncateWords(text: string, max: number): string {
  const words = text.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length <= max) return text.trim();
  return words.slice(0, max).join(' ');
}

/* ------------------------------------------------------------------ *
 * Proposals — the data a port applies, and the card shows.
 * ------------------------------------------------------------------ */

export interface SceneProposal {
  readonly text: string;
  readonly words: number;
  /**
   * The document's revision when the draft was staged, before the model was asked (agent-harness §8).
   * Apply carries it as `expectedRevision`, so a document the user changed while the card was open
   * refuses the draft instead of being written over.
   */
  readonly revision: number;
  /** The provider stopped the draft at its output limit. The card blocks approval until it is accepted or drafted again. */
  readonly cut?: boolean;
  /** The prompt that produced this draft, as the card shows it (context-assembly §5). */
  readonly context?: PromptPreview;
}

export interface SynopsisProposal {
  readonly items: readonly { readonly docId: string; readonly synopsis: string }[];
  /** A synopsis the provider cut at its output limit. The card blocks approval until it is accepted or drafted again. */
  readonly cut?: boolean;
  /** The prompts behind the batch, merged into one view: one call per document (context.ts `mergePreviews`). */
  readonly context?: PromptPreview;
}

export const FINDING_ASPECTS = ['timeline', 'characters', 'props', 'custom'] as const;
export const FINDING_SEVERITIES = ['info', 'minor', 'major'] as const;

/** One continuity finding: the aspect, the documents it spans, the quoted span, and what conflicts. */
export interface Finding {
  readonly aspect: (typeof FINDING_ASPECTS)[number];
  readonly severity: (typeof FINDING_SEVERITIES)[number];
  readonly docs: readonly string[];
  readonly quote: string;
  readonly note: string;
}

export interface FindingsProposal {
  readonly findings: readonly Finding[];
  /** The prompt that produced the findings, as the card shows it (context-assembly §5). */
  readonly context?: PromptPreview;
}

/** The findings reply, as the model must send it. Checked with the same closed-set validator as tool params. */
export const findingsParams: ObjectSpec = param.object(
  'The continuity findings for the documents checked.',
  {
    findings: param.list(
      'One entry per problem found. An empty list means none were found.',
      param.object(
        'One finding.',
        {
          aspect: param.choice('What the problem concerns.', [...FINDING_ASPECTS]),
          severity: param.choice('How much it matters.', [...FINDING_SEVERITIES]),
          docs: param.list('The documents the problem spans, by title.', param.string('One title.', { nonBlank: true })),
          quote: param.string('The quoted span, verbatim.', { maxLength: 300 }),
          note: param.string('What conflicts, in one or two sentences.', { nonBlank: true, maxLength: 600 }),
        },
        ['aspect', 'severity', 'docs', 'quote', 'note'],
      ),
    ),
  },
  ['findings'],
);

/** The schema hint sent with the findings call. Derived from the spec above, so the two cannot drift. */
const FINDINGS_HINT = { title: 'Continuity findings', description: 'Exactly one JSON object with a "findings" list.' } as const;

/** The parse of a findings reply: JSON, then the closed-set check. A failure names what to fix. */
export function parseFindingsReply(content: string): Result<FindingsProposal, string> {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  let value: unknown;
  try {
    value = JSON.parse(fenced?.[1] ?? trimmed);
  } catch {
    return err('the continuity reply was not valid JSON, so no findings were recorded');
  }
  const checked = checkParams('continuity.scan', findingsParams, value);
  if (!checked.ok) return err(`the continuity reply was refused: ${checked.error.message}`);
  return ok({ findings: (checked.value['findings'] as Finding[]) ?? [] });
}

/* ------------------------------------------------------------------ *
 * The three generators. Each sends the messages its call was assembled into (context.ts). The role
 * text, the system message, is the one piece of prompt this file writes.
 * ------------------------------------------------------------------ */

/**
 * The role text of a scene draft. The assembly's L7 says what to write; this says how to answer. A screenplay scene's text is
 * Fountain, not prose, so its role names the form the text must keep (screenplay.md §3 and §6: the model is told the doc kind).
 * This role is the L0 system message of the call (context.ts), so the note is part of L0 for a screenplay scene.
 *
 * A `draft` writes the whole scene, heading included. `continue` and `rewrite_selection` write one passage of a scene that already
 * has its heading, so their role asks for that passage's Fountain only: a second heading in the middle of a scene is a defect.
 */
export function sceneRole(targetWords?: number, kind?: string, mode: 'draft' | 'continue' | 'rewrite_selection' = 'draft'): string {
  const aim = targetWords === undefined ? '' : ` Aim for about ${targetWords} words.`;
  if (kind === 'screenplay' && mode !== 'draft') {
    const passage = mode === 'continue' ? 'the text that carries on from the end of the scene' : 'the replacement for the selected text';
    return `${DRAFT_SYSTEM_PREFIX} Write only the Fountain for ${passage} that the request below names. Do not write a scene heading (INT. or EXT.), a title, a note or a preamble: the scene already has its heading. Write action as plain paragraphs, put each character cue in UPPERCASE on its own line with its dialogue beneath, and keep parentheticals in parentheses. Output the Fountain only.${aim}`;
  }
  if (kind === 'screenplay') {
    return `${DRAFT_SYSTEM_PREFIX} Write the screenplay scene described below in Fountain. Keep its scene heading (INT. or EXT.), write action as plain paragraphs, put each character cue in UPPERCASE on its own line with its dialogue beneath, and keep parentheticals in parentheses. Output the Fountain only: no title, no notes, no preamble.${aim}`;
  }
  return `${DRAFT_SYSTEM_PREFIX} Write the prose for the scene described below. Output the prose only: no title, no notes, no preamble.${aim}`;
}

export interface DraftedScene {
  readonly text: string;
  readonly words: number;
  readonly cut: boolean;
  readonly spend: Spend;
}

/** scene.draft's text: the prose for one scene, streamed. Empty output is returned as it is, and the port refuses it. */
export async function draftScene(call: ModelCall, messages: readonly ChatMessage[]): Promise<DraftedScene> {
  const reply = await complete(call, messages, 'text');
  const text = reply.text.trim();
  return { text, words: wordsOf(text), cut: reply.cut, spend: spendOf(messages, text) };
}

/**
 * The role text of a dialogue draft: Ink, the one block the container takes (dialogue-narrative.md §7). The module compile-checks what
 * comes back, so this says the syntax and the one thing a writer's container must not get: a fence or a commentary around the Ink.
 */
export function dialogueRole(targetLines?: number): string {
  const aim = targetLines === undefined ? '' : ` Aim for about ${targetLines} spoken lines.`;
  return `${DRAFT_SYSTEM_PREFIX} Write the dialogue for the beats described below as Ink: knots (=== name ===), choices (* [text]) and diverts (-> name). Output the Ink only: no commentary and no code fence.${aim}`;
}

/** dialogue.draft's text: the Ink for one container's beats, streamed. Empty output is returned as it is, and the port refuses it. */
export async function draftDialogue(call: ModelCall, messages: readonly ChatMessage[]): Promise<DraftedScene> {
  const reply = await complete(call, messages, 'text');
  const text = reply.text.trim();
  return { text, words: wordsOf(text), cut: reply.cut, spend: spendOf(messages, text) };
}

/** The role text of one synopsis: at most `maxWords` words, as one plain paragraph. */
export function synopsisRole(maxWords: number): string {
  return `${DRAFT_SYSTEM_PREFIX} Write a synopsis of the document below in at most ${maxWords} words, as one plain paragraph. Output the synopsis only.`;
}

/** One document's synopsis call: the document it is for, and the messages assembled for it. */
export interface SynopsisDoc {
  readonly id: string;
  readonly messages: readonly ChatMessage[];
}

export interface SynopsisInput {
  readonly docs: readonly SynopsisDoc[];
  readonly maxWords: number;
}

export interface DraftedSynopses {
  readonly items: readonly { readonly docId: string; readonly synopsis: string }[];
  /** True when any one of the synopses was cut at the provider's output limit. */
  readonly cut: boolean;
  readonly spend: Spend;
}

/** synopsis.fill's proposals: one completion per document, each held to the word limit. */
export async function fillSynopses(call: ModelCall, input: SynopsisInput): Promise<DraftedSynopses> {
  const items: { docId: string; synopsis: string }[] = [];
  let cut = false;
  let spend: Spend = { promptTokens: 0, completionTokens: 0 };
  for (const doc of input.docs) {
    const reply = await complete(call, doc.messages, 'text');
    items.push({ docId: doc.id, synopsis: truncateWords(reply.text, input.maxWords) });
    cut = cut || reply.cut;
    spend = addSpend(spend, spendOf(doc.messages, reply.text));
  }
  return { items, cut, spend };
}

/** The role text of a continuity check: the aspects, and the one JSON object the reply must be. */
export function continuityRole(aspects: readonly string[]): string {
  const list = aspects.length === 0 ? FINDING_ASPECTS.join(', ') : aspects.join(', ');
  return `${DRAFT_SYSTEM_PREFIX} Check the documents below for continuity problems in these aspects: ${list}. Reply with exactly one JSON object: {"findings": [{"aspect": "...", "severity": "info" | "minor" | "major", "docs": ["<title>"], "quote": "<verbatim span>", "note": "<what conflicts>"}]}. Reply {"findings": []} when there are none. ${FINDINGS_HINT.description}`;
}

/**
 * continuity.scan's proposal: findings across the scope, parsed and checked before the port sees them.
 * A reply the provider cut at its output limit is not parsed as findings, because a cut list is not a
 * complete one, and the caller refuses it so the model can ask for less.
 */
export async function scanContinuity(call: ModelCall, messages: readonly ChatMessage[]): Promise<Result<FindingsProposal, string>> {
  const reply = await complete(call, messages, { jsonSchemaHint: FINDINGS_HINT });
  if (reply.cut) {
    return err('the continuity reply was cut off at the provider’s output limit, so no findings were recorded: check fewer documents in one call');
  }
  return parseFindingsReply(reply.text);
}

/* ------------------------------------------------------------------ *
 * Checks on a proposal the loop did not build itself (the port's own guard).
 * ------------------------------------------------------------------ */

/** A scene proposal as a port reads it. A proposal with no revision was not staged against a document, so it is not applied. */
export function asSceneProposal(value: unknown): SceneProposal | undefined {
  if (!isRecord(value) || typeof value['text'] !== 'string' || typeof value['revision'] !== 'number') return undefined;
  return {
    text: value['text'],
    words: typeof value['words'] === 'number' ? value['words'] : wordsOf(value['text']),
    revision: value['revision'],
    cut: value['cut'] === true,
  };
}

export function asSynopsisProposal(value: unknown): SynopsisProposal | undefined {
  if (!isRecord(value) || !Array.isArray(value['items'])) return undefined;
  const items: { docId: string; synopsis: string }[] = [];
  for (const item of value['items']) {
    if (!isRecord(item) || typeof item['docId'] !== 'string' || typeof item['synopsis'] !== 'string') return undefined;
    items.push({ docId: item['docId'], synopsis: item['synopsis'] });
  }
  // The cut flag travels with the batch, as it does with a scene proposal: the port reads it to refuse
  // a batch the writer has not accepted as truncated.
  return value['cut'] === true ? { items, cut: true } : { items };
}

export function asFindingsProposal(value: unknown): FindingsProposal | undefined {
  if (!isRecord(value) || !Array.isArray(value['findings'])) return undefined;
  const checked = checkParams('continuity.scan', findingsParams, { findings: value['findings'] });
  if (!checked.ok) return undefined;
  return { findings: (checked.value['findings'] as Finding[]) ?? [] };
}
