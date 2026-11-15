/**
 * `coherence.review` — [coherence.md §5.3 and §7 tool 16](../../../../docs/architecture/coherence.md).
 *
 * Two steps, and the writer's approval sits between them. {@link planReview}
 * is pure: it names the documents, the budgets and the cost, and shows the first
 * prompt. {@link runReview} calls the model, and it refuses to run without an
 * explicit approval and a provider. Nothing in this file touches the manuscript.
 *
 * Partial runs are the spec's rule: a failure in the middle keeps the verdicts
 * already gathered, marks the run `partial`, and does not advance review state,
 * so a retry is a new run and the upsert keeps it idempotent.
 */

import type { RandomBytes } from '@caotang/ids';
import type { ProjectState } from '@caotang/store';

import { CoherenceError, MalformedReplyError, NoProviderError, ReviewNotApprovedError } from '../errors.js';
import { mintCoherenceId } from '../ids.js';
import {
  LLM_CATEGORIES,
  MAX_FINDINGS_CAP,
  MAX_FINDINGS_DEFAULT,
  RUN_HISTORY_LIMIT,
  SCAN_DOC_GUARD,
  type CoherenceFile,
  type CoherenceRun,
  type LlmCategory,
} from '../model.js';
import { entriesOf, resolveScope, snapshotManuscript, type ScannedScene, type ScopeSpec, type SnapshotOptions } from '../scope.js';
import { recurredAfterFixedNote, upsertFindings, type UpsertDraft } from '../upsert.js';

import { assembleFindings } from './assemble.js';
import type { CoherenceModel, ModelReply, ModelUsage } from './port.js';
import { blockFor, pairCount, pairKey, pairSequence, type PairRef } from './pairs.js';
import { pairLabelOf, parseExtraction, parseVerification, type ExtractedSpan, type ParsedVerdict } from './parse.js';
import { PAIRS_PER_CALL, SPANS_PER_DOCUMENT, extractionPrompt, verificationPrompt, type PairBlock } from './prompts.js';

/** §5.3 Stage 1 budgets, in tokens, using the `ceil(chars/4)` estimator (context-assembly §3). */
export const REVIEW_BUDGETS = { focusTokens: 25_000, codexTokens: 2_500, storyTokens: 6_000 } as const;

const CHARS_PER_TOKEN = 4;
const PREVIEW_CHARS = 4000;
/** Worst case for one verification block: a 300-char quote, 200 chars of context each side, and labels, twice, plus the pair id. */
const PAIR_BLOCK_CHARS_AT_MOST = 2 * (300 + 2 * 200 + 80) + 40;

/** The `ceil(chars/4)` estimator the context-assembly spec names (§3). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** One entry of a context layer: a key the plan can name when it is left out, and the text the model reads. */
export interface ContextBlock {
  readonly key: string;
  readonly text: string;
}

export interface ReviewContext {
  /**
   * Codex layer for a document (L2). Blocks arrive in codex.md §6 order (always, type,
   * name). The budget keeps the longest prefix that fits, so the lowest-priority entries
   * are the ones left out. An entry is never cut.
   */
  readonly codex?: (docId: string) => readonly ContextBlock[];
  /**
   * Story-so-far layer for a document (L4). Blocks arrive in manuscript order. The budget
   * keeps the longest run of nearest blocks that fits (context-assembly §2), so the oldest
   * are the ones left out. A block is never cut.
   */
  readonly storySoFar?: (docId: string) => readonly ContextBlock[];
}

export interface ReviewRequest {
  readonly scope: ScopeSpec;
  readonly categories?: readonly LlmCategory[];
  readonly maxFindings?: number;
  /** Documents a read rule keeps from the agent (agent-harness §4): replaces the archived-only exclusion, as `SnapshotOptions.isExcluded`. */
  readonly isExcluded?: SnapshotOptions['isExcluded'];
}

export interface PlannedDocument {
  readonly docId: string;
  readonly title: string;
  readonly estimatedTokens: number;
  /** True when the body was longer than the focus budget and the prompt carries its opening only. */
  readonly truncated: boolean;
  /** Codex entries (L2) left out to fit the budget, by key, in §6 order. The plan card lists them. */
  readonly codexDropped: readonly string[];
  /** Story-so-far blocks (L4) left out to fit the budget, by key, oldest first. */
  readonly storyDropped: readonly string[];
}

export interface ReviewPlan {
  readonly scopeDocIds: readonly string[];
  readonly documents: readonly PlannedDocument[];
  readonly categories: readonly LlmCategory[];
  readonly maxFindings: number;
  readonly estimate: {
    readonly extractCalls: number;
    readonly extractTokens: number;
    /**
     * An upper bound, not a count: pairs are formed only after extraction, and at
     * most {@link SPANS_PER_DOCUMENT} spans per document can exist.
     */
    readonly verifyCallsAtMost: number;
    readonly verifyTokensAtMost: number;
    readonly totalTokensAtMost: number;
  };
  /** Over the guard: the plan card requires explicit approval for a scope this size (§6.2). */
  readonly overGuard: boolean;
  /** The first extraction prompt, shown so the writer sees what the model will read. */
  readonly promptPreview: string;
}

/** The plan as an approval persists and a run executes it: everything but the first prompt, which only the ephemeral preview shows. */
export type ReviewExecutionPlan = Omit<ReviewPlan, 'promptPreview'>;

export function reviewExecutionPlanOf(plan: ReviewPlan): ReviewExecutionPlan {
  const { promptPreview: _promptPreview, ...execution } = plan;
  return execution;
}

function validateCategories(categories: readonly LlmCategory[] | undefined): readonly LlmCategory[] {
  if (categories === undefined) return LLM_CATEGORIES;
  if (categories.length === 0) throw new CoherenceError('categories-empty', 'select at least one category to review');
  for (const category of categories) {
    if (!(LLM_CATEGORIES as readonly string[]).includes(category)) {
      throw new CoherenceError('category-unknown', `"${category}" is not a category; valid categories are ${LLM_CATEGORIES.join(', ')}`);
    }
  }
  return LLM_CATEGORIES.filter((category) => categories.includes(category));
}

function validateMaxFindings(value: number | undefined): number {
  if (value === undefined) return MAX_FINDINGS_DEFAULT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_FINDINGS_CAP) {
    throw new CoherenceError('max-findings-invalid', `maxFindings must be a whole number from 1 to ${MAX_FINDINGS_CAP}; got ${String(value)}`);
  }
  return value;
}

function focusBody(body: string): { text: string; truncated: boolean } {
  const limit = REVIEW_BUDGETS.focusTokens * CHARS_PER_TOKEN;
  return body.length > limit ? { text: body.slice(0, limit), truncated: true } : { text: body, truncated: false };
}

const BLOCK_SEPARATOR = '\n\n';

/** What a context layer kept, as the text shown to the model, and the keys it left out. */
export interface FittedLayer {
  readonly text: string;
  readonly dropped: readonly string[];
}

/**
 * Whole blocks only (codex.md §6, context-assembly §2): a block is kept or left out, and
 * never cut. `keep: 'head'` keeps the longest prefix that fits, for a layer whose order is
 * priority order. `keep: 'tail'` keeps the longest suffix, for a layer whose order is
 * manuscript order and whose nearest blocks matter most. Kept blocks are shown in their
 * given order. The budget is in tokens by the `ceil(chars/4)` estimator, so it is a
 * character limit of four times the tokens.
 */
export function fitBlocks(blocks: readonly ContextBlock[], tokens: number, keep: 'head' | 'tail'): FittedLayer {
  const limit = tokens * CHARS_PER_TOKEN;
  const order = blocks.map((_, index) => index);
  if (keep === 'tail') order.reverse();
  const chosen = new Set<number>();
  let used = 0;
  for (const index of order) {
    const block = blocks[index];
    if (block === undefined) continue;
    const cost = block.text.length + (chosen.size > 0 ? BLOCK_SEPARATOR.length : 0);
    if (used + cost > limit) break;
    used += cost;
    chosen.add(index);
  }
  return {
    text: blocks
      .filter((_, index) => chosen.has(index))
      .map((block) => block.text)
      .join(BLOCK_SEPARATOR),
    dropped: blocks.filter((_, index) => !chosen.has(index)).map((block) => block.key),
  };
}

function promptFor(
  scene: ScannedScene,
  categories: readonly LlmCategory[],
  context: ReviewContext,
): { system: string; user: string; schema: Readonly<Record<string, unknown>>; body: string; truncated: boolean; codexDropped: readonly string[]; storyDropped: readonly string[] } {
  const focus = focusBody(scene.body);
  const codex = fitBlocks(context.codex?.(scene.docId) ?? [], REVIEW_BUDGETS.codexTokens, 'head');
  const story = fitBlocks(context.storySoFar?.(scene.docId) ?? [], REVIEW_BUDGETS.storyTokens, 'tail');
  const prompt = extractionPrompt({
    docId: scene.docId,
    title: scene.title,
    body: focus.text,
    categories,
    codex: codex.text,
    storySoFar: story.text,
  });
  return {
    system: prompt.system,
    user: prompt.user,
    schema: prompt.jsonSchemaHint,
    body: focus.text,
    truncated: focus.truncated,
    codexDropped: codex.dropped,
    storyDropped: story.dropped,
  };
}

/**
 * The plan card's content. Pure: it reads the project and writes nothing, and
 * the same inputs always give the same plan.
 */
export function planReview(state: ProjectState, file: CoherenceFile, request: ReviewRequest, context: ReviewContext = {}): ReviewPlan {
  const categories = validateCategories(request.categories);
  const maxFindings = validateMaxFindings(request.maxFindings);
  const includeDocIds = request.scope.mode === 'doc' ? new Set(request.scope.docIds) : undefined;
  const snapshot = snapshotManuscript(state, file, {
    ...(includeDocIds === undefined ? {} : { includeDocIds }),
    ...(request.isExcluded === undefined ? {} : { isExcluded: request.isExcluded }),
  });
  const scenes = resolveScope(snapshot, file, request.scope);

  const documents: PlannedDocument[] = [];
  let preview = '';
  for (const scene of scenes) {
    const prompt = promptFor(scene, categories, context);
    documents.push({
      docId: scene.docId,
      title: scene.title,
      estimatedTokens: estimateTokens(prompt.system + prompt.user),
      truncated: prompt.truncated,
      codexDropped: prompt.codexDropped,
      storyDropped: prompt.storyDropped,
    });
    if (preview === '') preview = `${prompt.system}\n\n${prompt.user}`;
  }

  const extractTokens = documents.reduce((sum, doc) => sum + doc.estimatedTokens, 0);
  const maxSpans = SPANS_PER_DOCUMENT * scenes.length;
  const verifyCallsAtMost = Math.ceil(pairCount(maxSpans) / PAIRS_PER_CALL);
  const verifySystem = estimateTokens(verificationPrompt([]).system);
  const verifyTokensAtMost = verifyCallsAtMost * (verifySystem + PAIRS_PER_CALL * estimateTokens('x'.repeat(PAIR_BLOCK_CHARS_AT_MOST)));

  return {
    scopeDocIds: scenes.map((scene) => scene.docId),
    documents,
    categories,
    maxFindings,
    estimate: {
      extractCalls: scenes.length,
      extractTokens,
      verifyCallsAtMost,
      verifyTokensAtMost,
      totalTokensAtMost: extractTokens + verifyTokensAtMost,
    },
    overGuard: scenes.length > SCAN_DOC_GUARD,
    promptPreview: preview.length > PREVIEW_CHARS ? `${preview.slice(0, PREVIEW_CHARS)}\n… (preview truncated)` : preview,
  };
}

export interface ReviewRunOptions {
  readonly model: CoherenceModel | undefined;
  /** Must be `true`. The plan card's approval is the only thing that starts a run (§7 tool 16). */
  readonly approved: boolean;
  readonly now: Date;
  readonly context?: ReviewContext;
  readonly randomBytes?: RandomBytes;
  readonly signal?: AbortSignal;
  /**
   * The findings file as it stands when the model calls have settled. A review waits on the model, and a scan or a fix made in
   * the meantime replaces the held file; the run is written into this copy, so what changed while the review waited is kept.
   * Absent, the run is written into the file the review was given.
   */
  readonly currentFile?: () => CoherenceFile;
  /** As `ReviewRequest.isExcluded`: a document that became withheld since the plan was made is not read. */
  readonly isExcluded?: SnapshotOptions['isExcluded'];
}

export interface ReviewRunResult {
  readonly file: CoherenceFile;
  readonly run: CoherenceRun;
  readonly status: 'complete' | 'partial';
  readonly notes: string[];
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ReviewCheckpoint {
  readonly extractedDocIds: readonly string[];
  readonly spans: readonly ExtractedSpan[];
  readonly verifiedBatches: number;
  readonly verdicts: readonly ParsedVerdict[];
  readonly usageByPair: Readonly<Record<string, ModelUsage>>;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly notes: readonly string[];
  readonly status: 'complete' | 'partial';
  readonly evaluated: readonly string[];
  readonly modelCalls?: number;
  readonly usageSource?: 'reported' | 'estimated' | 'unknown';
}

export interface ReviewComputed {
  readonly drafts: readonly UpsertDraft[];
  readonly evaluated: readonly string[];
  readonly scenes: readonly { readonly docId: string; readonly revision: number }[];
  readonly status: 'complete' | 'partial';
  readonly notes: readonly string[];
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly model: string;
  readonly categories: readonly LlmCategory[];
}

export interface ReviewComputeOptions {
  readonly model: CoherenceModel | undefined;
  readonly approved: boolean;
  readonly context?: ReviewContext;
  readonly signal?: AbortSignal;
  readonly isExcluded?: SnapshotOptions['isExcluded'];
  readonly resumeFrom?: ReviewCheckpoint;
  readonly onCheckpoint?: (checkpoint: ReviewCheckpoint) => void | Promise<void>;
  readonly beforeCall?: () => void | Promise<void>;
  readonly yieldToHost?: () => Promise<void>;
}

export const REVIEW_YIELD_EVERY = 2000;

export function emptyReviewCheckpoint(): ReviewCheckpoint {
  return { extractedDocIds: [], spans: [], verifiedBatches: 0, verdicts: [], usageByPair: {}, promptTokens: 0, completionTokens: 0, notes: [], status: 'complete', evaluated: [] };
}

/**
 * A resumed checkpoint's evidence, checked again against the approved plan and the bodies as they stand: every span and verdict
 * passage is a verbatim slice of a scope document at its own offsets, every span's category is approved, every verdict names a pair
 * the spans still form, and its passages overlap that pair's own spans as at parse time. The store's shape check says a record is
 * shaped like a checkpoint; this says its evidence is still the approved work. A checkpoint that fails is not resumed: its progress
 * is dropped and the review starts again within the remaining call bound, keeping the checkpoint's token totals and notes.
 *
 * The pair walk streams with the host's yield hook, as the verification preparation does, so a large resumed review stays
 * cancellable while its evidence is checked; only the pairs a verdict names are kept.
 */
export async function reviewCheckpointEvidenceOk(plan: ReviewExecutionPlan, bodies: ReadonlyMap<string, string>, checkpoint: ReviewCheckpoint, yieldToHost?: () => Promise<void>): Promise<boolean> {
  const scope = new Set(plan.scopeDocIds);
  const categories = new Set<string>(plan.categories);
  if (!checkpoint.extractedDocIds.every((id) => scope.has(id)) || !checkpoint.evaluated.every((id) => scope.has(id))) return false;
  const verbatim = (docId: string, quote: string, from: number, to: number): boolean => {
    const body = bodies.get(docId);
    return body !== undefined && quote !== '' && body.slice(from, to) === quote;
  };
  const spanCount = new Map<string, number>();
  for (const span of checkpoint.spans) {
    if (!scope.has(span.docId) || !categories.has(span.category) || !verbatim(span.docId, span.quote, span.from, span.to)) return false;
    const count = (spanCount.get(span.docId) ?? 0) + 1;
    if (count > SPANS_PER_DOCUMENT) return false;
    spanCount.set(span.docId, count);
  }
  const named = new Set(checkpoint.verdicts.map((verdict) => verdict.pairId));
  const captured = new Map<string, PairRef>();
  let pairs = 0;
  let sinceYield = 0;
  for (const pair of pairSequence(checkpoint.spans, plan.categories)) {
    pairs += 1;
    if (named.has(pair.pairId)) captured.set(pair.pairId, pair);
    sinceYield += 1;
    if (yieldToHost !== undefined && sinceYield >= REVIEW_YIELD_EVERY) {
      sinceYield = 0;
      await yieldToHost();
    }
  }
  if (checkpoint.verifiedBatches > Math.ceil(pairs / PAIRS_PER_CALL)) return false;
  const overlaps = (passage: { docId: string; from: number; to: number }, span: ExtractedSpan): boolean =>
    passage.docId === span.docId && passage.from < span.to && span.from < passage.to;
  for (const verdict of checkpoint.verdicts) {
    const pair = captured.get(verdict.pairId);
    if (pair === undefined) return false;
    if (verdict.evidence === undefined) continue;
    if (verdict.evidence.length !== 2) return false;
    const [first, second] = verdict.evidence;
    if (first === undefined || second === undefined) return false;
    if (!verbatim(first.docId, first.quote, first.from, first.to) || !verbatim(second.docId, second.quote, second.from, second.to)) return false;
    if (!((overlaps(first, pair.a) && overlaps(second, pair.b)) || (overlaps(second, pair.a) && overlaps(first, pair.b)))) return false;
  }
  return true;
}

export async function computeReview(state: ProjectState, file: CoherenceFile, plan: ReviewExecutionPlan, options: ReviewComputeOptions): Promise<ReviewComputed> {
  if (options.approved !== true) throw new ReviewNotApprovedError();
  const model = options.model;
  if (model === undefined) throw new NoProviderError();

  const snapshot = snapshotManuscript(state, file, {
    includeDocIds: new Set(plan.scopeDocIds),
    ...(options.isExcluded === undefined ? {} : { isExcluded: options.isExcluded }),
  });
  const byId = new Map(snapshot.scanned.map((scene) => [scene.docId, scene] as const));
  const scenes: ScannedScene[] = [];
  const resume = options.resumeFrom;
  const notes: string[] = resume === undefined ? [] : [...resume.notes];
  for (const docId of plan.scopeDocIds) {
    const scene = byId.get(docId);
    if (scene === undefined) {
      const planned = plan.documents.find((doc) => doc.docId === docId);
      const note = `${planned === undefined ? 'a scene' : `"${planned.title}"`} is no longer readable and was skipped`;
      if (resume === undefined || !notes.includes(note)) notes.push(note);
    } else scenes.push(scene);
  }
  const bodies = new Map<string, string>(scenes.map((scene) => [scene.docId, focusBody(scene.body).text] as const));
  const usable = resume !== undefined && (await reviewCheckpointEvidenceOk(plan, bodies, resume, options.yieldToHost)) ? resume : undefined;
  if (resume !== undefined && usable === undefined) notes.push('the saved checkpoint did not match the approved documents; the review started again within its remaining limit');

  // A resume finishes the work the checkpoint left missing, so its outcome is this run's: an unusable reply is retried, not carried as a permanent gap.
  let status: 'complete' | 'partial' = 'complete';
  const previousKeys = new Map<string, string>();
  const verifiedKeys = new Set<string>();
  if (usable !== undefined) {
    let ordinal = 0;
    for (const pair of pairSequence(usable.spans, plan.categories)) {
      const key = pairKey(pair);
      previousKeys.set(pair.pairId, key);
      if (Math.floor(ordinal / PAIRS_PER_CALL) < usable.verifiedBatches) verifiedKeys.add(key);
      ordinal += 1;
    }
  }
  let promptTokens = resume?.promptTokens ?? 0;
  let completionTokens = resume?.completionTokens ?? 0;
  const addUsage = (usage: ModelUsage | undefined): void => {
    promptTokens += usage?.promptTokens ?? 0;
    completionTokens += usage?.completionTokens ?? 0;
  };
  const context = options.context ?? {};
  const extractedDocIds = new Set(usable?.extractedDocIds ?? []);
  const spans: ExtractedSpan[] = usable === undefined ? [] : [...usable.spans];
  const evaluated: string[] = usable === undefined ? [] : [...usable.evaluated];
  const usageByPair = new Map<string, ModelUsage | undefined>();
  const verdicts: ParsedVerdict[] = [];
  const verdictKeys: string[] = [];
  if (usable !== undefined) {
    for (const [pairId, usage] of Object.entries(usable.usageByPair)) {
      const key = previousKeys.get(pairId);
      if (key !== undefined) usageByPair.set(key, usage);
    }
    for (const verdict of usable.verdicts) {
      const key = previousKeys.get(verdict.pairId);
      if (key === undefined) continue;
      verdicts.push(verdict);
      verdictKeys.push(key);
    }
  }
  let verifiedBatches = usable?.verifiedBatches ?? 0;
  let idsByKeyCache: { spanCount: number; ids: Map<string, string> } | undefined;
  const idsByKey = (): Map<string, string> => {
    if (idsByKeyCache !== undefined && idsByKeyCache.spanCount === spans.length) return idsByKeyCache.ids;
    const ids = new Map<string, string>();
    for (const pair of pairSequence(spans, plan.categories)) ids.set(pairKey(pair), pair.pairId);
    idsByKeyCache = { spanCount: spans.length, ids };
    return ids;
  };
  const withCurrentIds = (): { verdicts: ParsedVerdict[]; usageByPair: Map<string, ModelUsage | undefined> } => {
    const ids = idsByKey();
    return {
      verdicts: verdicts.map((verdict, index) => ({ ...verdict, pairId: ids.get(verdictKeys[index]!) ?? verdict.pairId })),
      usageByPair: new Map([...usageByPair].flatMap(([key, usage]) => {
        const pairId = ids.get(key);
        return pairId === undefined ? [] : [[pairId, usage] as const];
      })),
    };
  };

  const checkpoint = (): ReviewCheckpoint => {
    const current = withCurrentIds();
    return {
    extractedDocIds: [...extractedDocIds],
    spans: [...spans],
    verifiedBatches,
    verdicts: current.verdicts,
    usageByPair: Object.fromEntries([...current.usageByPair].filter((entry): entry is [string, ModelUsage] => entry[1] !== undefined)),
    promptTokens,
    completionTokens,
    notes: [...notes],
    status,
    evaluated: [...evaluated],
    };
  };

  // Stage 1: one call per document, in binder order.
  for (const scene of scenes) {
    const prompt = promptFor(scene, plan.categories, context);
    if (extractedDocIds.has(scene.docId)) continue;
    if (options.signal?.aborted === true) {
      status = 'partial';
      notes.push('extraction stopped: the run was cancelled');
      break;
    }
    let reply: ModelReply;
    try {
      if (options.beforeCall !== undefined) await options.beforeCall();
      reply = await model.complete({
        system: prompt.system,
        user: prompt.user,
        jsonSchemaHint: prompt.schema,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
    } catch (error) {
      status = 'partial';
      notes.push(`extraction stopped at "${scene.title}": ${reasonOf(error)}`);
      break;
    }
    addUsage(reply.usage);
    try {
      const parsed = parseExtraction(reply.content, { docId: scene.docId, body: prompt.body, title: scene.title });
      spans.push(...parsed.spans);
      notes.push(...parsed.notes);
      evaluated.push(scene.docId);
      extractedDocIds.add(scene.docId);
    } catch (error) {
      if (!(error instanceof MalformedReplyError)) throw error;
      status = 'partial';
      notes.push(`extraction for "${scene.title}" was unusable: ${error.message}`);
    }
    await options.onCheckpoint?.(checkpoint());
  }

  // Stage 2: pairwise verification, in batches of at most ten pairs.
  const pairById = new Map<string, PairRef>();
  const batches: PairRef[][] = [];
  let filling: PairRef[] = [];
  let sinceYield = 0;
  for (const pair of pairSequence(spans, plan.categories)) {
    pairById.set(pair.pairId, pair);
    filling.push(pair);
    if (filling.length === PAIRS_PER_CALL) {
      batches.push(filling);
      filling = [];
    }
    sinceYield += 1;
    if (options.yieldToHost !== undefined && sinceYield >= REVIEW_YIELD_EVERY) {
      sinceYield = 0;
      await options.yieldToHost();
    }
  }
  if (filling.length > 0) batches.push(filling);
  if (options.yieldToHost !== undefined) await options.yieldToHost();
  for (const [index, batch] of batches.entries()) {
    const pending = batch.filter((pair) => !verifiedKeys.has(pairKey(pair)));
    if (pending.length === 0) {
      verifiedBatches = index + 1;
      continue;
    }
    if (options.signal?.aborted === true) {
      status = 'partial';
      notes.push('verification stopped: the run was cancelled');
      break;
    }
    const blocks = pending
      .map((pair) => blockFor(pair, bodies))
      .filter((block): block is PairBlock => block !== undefined);
    if (blocks.length === 0) {
      verifiedBatches = index + 1;
      continue;
    }
    const prompt = verificationPrompt(blocks);
    let reply: ModelReply;
    try {
      if (options.beforeCall !== undefined) await options.beforeCall();
      reply = await model.complete({
        system: prompt.system,
        user: prompt.user,
        jsonSchemaHint: prompt.jsonSchemaHint,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
    } catch (error) {
      status = 'partial';
      notes.push(`verification stopped at ${pairLabelOf(pending[0])}: ${reasonOf(error)}`);
      break;
    }
    addUsage(reply.usage);
    try {
      const parsed = parseVerification(reply.content, {
        bodies,
        pairs: new Map(pending.map((pair) => [pair.pairId, pair] as const)),
      });
      notes.push(...parsed.notes);
      for (const verdict of parsed.verdicts) {
        const pair = pairById.get(verdict.pairId);
        if (pair === undefined) continue;
        verdicts.push(verdict);
        verdictKeys.push(pairKey(pair));
        usageByPair.set(pairKey(pair), reply.usage);
      }
    } catch (error) {
      if (!(error instanceof MalformedReplyError)) throw error;
      status = 'partial';
      notes.push(`a verification batch was unusable: ${error.message}`);
      break;
    }
    verifiedBatches = index + 1;
    await options.onCheckpoint?.(checkpoint());
  }

  // Stage 4: deterministic assembly, then the shared upsert. An llm run never clears findings.
  if (options.yieldToHost !== undefined) await options.yieldToHost();
  const docOrder = new Map(snapshot.scanned.map((scene) => [scene.docId, scene.binderIndex] as const));
  const current = withCurrentIds();
  const assembled = assembleFindings(current.verdicts, {
    pairs: pairById,
    entries: entriesOf(state),
    model: model.model,
    docOrder,
    maxFindings: plan.maxFindings,
    usageByPair: current.usageByPair,
  });
  notes.push(...assembled.notes);

  return {
    drafts: assembled.drafts,
    evaluated,
    scenes: scenes.map((scene) => ({ docId: scene.docId, revision: scene.revision })),
    status,
    notes,
    promptTokens,
    completionTokens,
    model: model.model,
    categories: plan.categories,
  };
}

export interface ReviewPublishOptions {
  readonly now: Date;
  readonly randomBytes?: RandomBytes;
  readonly runId?: string;
}

export function publishReview(currentFile: CoherenceFile, computed: ReviewComputed, options: ReviewPublishOptions): ReviewRunResult {
  const existing = options.runId === undefined ? undefined : currentFile.runs.find((run) => run.id === options.runId);
  if (existing !== undefined) {
    return { file: currentFile, run: existing, status: existing.status === 'partial' ? 'partial' : 'complete', notes: existing.notes ?? [] };
  }
  const next = structuredClone(currentFile);
  const runId = options.runId ?? mintCoherenceId('r', new Set(next.runs.map((run) => run.id)), options.randomBytes);
  const at = options.now.toISOString();
  const notes = [...computed.notes];
  const report = upsertFindings(next, computed.drafts, { runId, now: at, randomBytes: options.randomBytes });
  if (report.redetectedFixed.length > 0) notes.push(recurredAfterFixedNote(next, report.redetectedFixed));
  if (report.redetectedDismissed > 0) notes.push(`${report.redetectedDismissed} previously dismissed finding(s) still present`);

  const run: CoherenceRun = {
    id: runId,
    at,
    kind: 'llm',
    checkIds: computed.categories.map((category) => `llm:${category}`),
    scope: { docIds: [...computed.evaluated].sort() },
    findingsUpserted: report.upserted,
    tokens: { promptTokens: computed.promptTokens, completionTokens: computed.completionTokens },
    model: computed.model,
    status: computed.status,
    notes,
  };
  next.runs.push(run);
  if (next.runs.length > RUN_HISTORY_LIMIT) next.runs.splice(0, next.runs.length - RUN_HISTORY_LIMIT);

  if (computed.status === 'complete') {
    for (const scene of computed.scenes) next.reviewState[scene.docId] = { lastReviewedRevision: scene.revision, lastReviewedAt: at };
  }
  return { file: next, run, status: computed.status, notes };
}

/**
 * Runs an approved plan. Stage 1 extracts per document; Stage 2 verifies the
 * candidate pairs in batches; Stage 4 assembles and upserts. A provider error
 * stops the run at that point and keeps what was already gathered.
 */
export async function runReview(state: ProjectState, file: CoherenceFile, plan: ReviewPlan, options: ReviewRunOptions): Promise<ReviewRunResult> {
  const computed = await computeReview(state, file, plan, {
    model: options.model,
    approved: options.approved,
    ...(options.context === undefined ? {} : { context: options.context }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.isExcluded === undefined ? {} : { isExcluded: options.isExcluded }),
  });
  // The copy is taken from the file as it stands now, after the awaits above: a scan or a fix made while the model worked is in it.
  return publishReview(options.currentFile?.() ?? file, computed, { now: options.now, ...(options.randomBytes === undefined ? {} : { randomBytes: options.randomBytes }) });
}
