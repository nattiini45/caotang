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
import { recurredAfterFixedNote, upsertFindings } from '../upsert.js';

import { assembleFindings } from './assemble.js';
import type { CoherenceModel, ModelReply, ModelUsage } from './port.js';
import { batchPairs, blockFor, candidatePairs, pairCount, type PairRef } from './pairs.js';
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

/**
 * Runs an approved plan. Stage 1 extracts per document; Stage 2 verifies the
 * candidate pairs in batches; Stage 4 assembles and upserts. A provider error
 * stops the run at that point and keeps what was already gathered.
 */
export async function runReview(state: ProjectState, file: CoherenceFile, plan: ReviewPlan, options: ReviewRunOptions): Promise<ReviewRunResult> {
  if (options.approved !== true) throw new ReviewNotApprovedError();
  const model = options.model;
  if (model === undefined) throw new NoProviderError();

  const snapshot = snapshotManuscript(state, file, {
    includeDocIds: new Set(plan.scopeDocIds),
    ...(options.isExcluded === undefined ? {} : { isExcluded: options.isExcluded }),
  });
  const byId = new Map(snapshot.scanned.map((scene) => [scene.docId, scene] as const));
  const scenes: ScannedScene[] = [];
  const notes: string[] = [];
  for (const docId of plan.scopeDocIds) {
    const scene = byId.get(docId);
    if (scene === undefined) {
      const planned = plan.documents.find((doc) => doc.docId === docId);
      notes.push(`${planned === undefined ? 'a scene' : `"${planned.title}"`} is no longer readable and was skipped`);
    }
    else scenes.push(scene);
  }

  let status: 'complete' | 'partial' = 'complete';
  let promptTokens = 0;
  let completionTokens = 0;
  const addUsage = (usage: ModelUsage | undefined): void => {
    promptTokens += usage?.promptTokens ?? 0;
    completionTokens += usage?.completionTokens ?? 0;
  };
  const context = options.context ?? {};

  // Stage 1: one call per document, in binder order.
  const bodies = new Map<string, string>();
  const spans: ExtractedSpan[] = [];
  const evaluated: string[] = [];
  for (const scene of scenes) {
    if (options.signal?.aborted === true) {
      status = 'partial';
      notes.push('extraction stopped: the run was cancelled');
      break;
    }
    const prompt = promptFor(scene, plan.categories, context);
    bodies.set(scene.docId, prompt.body);
    let reply: ModelReply;
    try {
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
    } catch (error) {
      if (!(error instanceof MalformedReplyError)) throw error;
      status = 'partial';
      notes.push(`extraction for "${scene.title}" was unusable: ${error.message}`);
    }
  }

  // Stage 2: pairwise verification, in batches of at most ten pairs.
  const pairs = candidatePairs(spans, plan.categories);
  const pairById = new Map<string, PairRef>(pairs.map((pair) => [pair.pairId, pair] as const));
  const usageByPair = new Map<string, ModelUsage | undefined>();
  const verdicts: ParsedVerdict[] = [];
  for (const batch of batchPairs(pairs)) {
    if (options.signal?.aborted === true) {
      status = 'partial';
      notes.push('verification stopped: the run was cancelled');
      break;
    }
    const blocks = batch
      .map((pair) => blockFor(pair, bodies))
      .filter((block): block is PairBlock => block !== undefined);
    if (blocks.length === 0) continue;
    const prompt = verificationPrompt(blocks);
    let reply: ModelReply;
    try {
      reply = await model.complete({
        system: prompt.system,
        user: prompt.user,
        jsonSchemaHint: prompt.jsonSchemaHint,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
    } catch (error) {
      status = 'partial';
      notes.push(`verification stopped at ${pairLabelOf(batch[0])}: ${reasonOf(error)}`);
      break;
    }
    addUsage(reply.usage);
    try {
      const parsed = parseVerification(reply.content, {
        bodies,
        pairs: new Map(batch.map((pair) => [pair.pairId, pair] as const)),
      });
      verdicts.push(...parsed.verdicts);
      notes.push(...parsed.notes);
      for (const verdict of parsed.verdicts) usageByPair.set(verdict.pairId, reply.usage);
    } catch (error) {
      if (!(error instanceof MalformedReplyError)) throw error;
      status = 'partial';
      notes.push(`a verification batch was unusable: ${error.message}`);
    }
  }

  // Stage 4: deterministic assembly, then the shared upsert. An llm run never clears findings.
  const docOrder = new Map(snapshot.scanned.map((scene) => [scene.docId, scene.binderIndex] as const));
  const assembled = assembleFindings(verdicts, {
    pairs: pairById,
    entries: entriesOf(state),
    model: model.model,
    docOrder,
    maxFindings: plan.maxFindings,
    usageByPair,
  });
  notes.push(...assembled.notes);

  // The copy is taken from the file as it stands now, after the awaits above: a scan or a fix made while the model worked is in it.
  const next = structuredClone(options.currentFile?.() ?? file);
  const runId = mintCoherenceId('r', new Set(next.runs.map((run) => run.id)), options.randomBytes);
  const at = options.now.toISOString();
  const report = upsertFindings(next, assembled.drafts, {
    runId,
    now: at,
    randomBytes: options.randomBytes,
  });
  if (report.redetectedFixed.length > 0) notes.push(recurredAfterFixedNote(next, report.redetectedFixed));
  if (report.redetectedDismissed > 0) notes.push(`${report.redetectedDismissed} previously dismissed finding(s) still present`);

  const run: CoherenceRun = {
    id: runId,
    at,
    kind: 'llm',
    checkIds: plan.categories.map((category) => `llm:${category}`),
    scope: { docIds: [...evaluated].sort() },
    findingsUpserted: report.upserted,
    tokens: { promptTokens, completionTokens },
    model: model.model,
    status,
    notes,
  };
  next.runs.push(run);
  if (next.runs.length > RUN_HISTORY_LIMIT) next.runs.splice(0, next.runs.length - RUN_HISTORY_LIMIT);

  // Review state advances only for a complete run. A partial run leaves every document due again.
  if (status === 'complete') {
    for (const scene of scenes) next.reviewState[scene.docId] = { lastReviewedRevision: scene.revision, lastReviewedAt: at };
  }
  return { file: next, run, status, notes };
}
