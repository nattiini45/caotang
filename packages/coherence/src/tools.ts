/**
 * The three coherence agent tools — [coherence.md §7](../../../docs/architecture/coherence.md),
 * the registry growing from 14 to 17 when the module lands.
 *
 * Each tool is declared in the shape the harness registry reads
 * (`packages/harness/src/types.ts`: `kind`, `meta`, `params`, and a port name), so
 * registration is a table entry and not a rewrite. Two things are deliberately
 * left to registration: the JSON Schema, which the harness derives from `params`
 * with its own `toJsonSchema`, and the closed set of port names, which lives in
 * the harness and widens when these tools are wired.
 *
 * The handlers return model-facing results. A refusal carries the sentence the
 * model reads next, because a bare error would send it looking for a way round.
 */

import { param, type ObjectSpec } from '@caotang/bus';
import type { RandomBytes } from '@caotang/ids';
import type { ProjectState, TreeNode } from '@caotang/store';

import { groupFindings, type FindingGroup } from './groups.js';
import { runDeterministic } from './run.js';
import { CoherenceError, NoProviderError } from './errors.js';
import { setFindingStatusForAgent } from './lifecycle.js';
import { FINDING_SEVERITIES, LLM_CATEGORIES, DETERMINISTIC_CHECK_IDS, NOTE_LIMIT, RUN_STATUSES, SCAN_DOC_GUARD, type CoherenceFile, type CoherenceRun, type DeterministicCheckId, type LlmCategory } from './model.js';
import type { MentionCacheSource, MentionDetector } from './mentions.js';
import { planReview, runReview, type ReviewContext, type ReviewPlan } from './llm/review.js';
import type { CoherenceModel } from './llm/port.js';
import type { DialogueFacts } from './checks/common.js';
import { resolveScope, snapshotManuscript, type ScopeSpec } from './scope.js';
import { noteLengthProblem } from './text.js';

export const COHERENCE_TOOL_NAMES = ['coherence.scan', 'coherence.review', 'coherence.setFindingStatus'] as const;
export type CoherenceToolName = (typeof COHERENCE_TOOL_NAMES)[number];

export function isCoherenceToolName(value: unknown): value is CoherenceToolName {
  return (COHERENCE_TOOL_NAMES as readonly unknown[]).includes(value);
}

/** The harness's risk column, restricted to what these tools use. */
export type CoherenceToolRisk = 'read' | 'write-auto' | 'write-confirm';

/** Mirrors the harness's `ToolMetadata` fields. `surface` is `extension` because the module is post-v0.1. */
export interface CoherenceToolMeta {
  readonly name: CoherenceToolName;
  readonly risk: CoherenceToolRisk;
  readonly undoable: boolean;
  readonly response_token_cap: number;
  readonly descriptionVersion: number;
  readonly description: string;
  readonly surface: 'extension';
  /** Every module row is deferred: the planner declares it only once `tool.search` or a preload loads it (agent-harness §3). */
  readonly load: 'deferred';
  /** Extra search terms for `tool.search`; never shown to the model. */
  readonly keywords: readonly string[];
}

/**
 * The subset of the harness's `ParamSpec` these tools use. The kinds and their
 * fields match `packages/harness/src/schema.ts`, so the harness can read them as-is.
 */
export type ToolParamSpec =
  | { readonly kind: 'string'; readonly description: string; readonly nonBlank?: boolean; readonly maxLength?: number }
  | { readonly kind: 'integer'; readonly description: string; readonly minimum?: number; readonly maximum?: number }
  | { readonly kind: 'enum'; readonly description: string; readonly values: readonly string[] }
  | {
      readonly kind: 'array';
      readonly description: string;
      readonly items: ToolParamSpec;
      readonly minItems?: number;
      readonly maxItems?: number;
      readonly unique?: boolean;
    }
  | {
      readonly kind: 'object';
      readonly description: string;
      readonly properties: Readonly<Record<string, ToolParamSpec>>;
      readonly required: readonly string[];
    };

export type ToolParamsObject = Extract<ToolParamSpec, { kind: 'object' }>;

export interface CoherenceToolEntry {
  readonly kind: 'port';
  readonly meta: CoherenceToolMeta;
  readonly params: ToolParamsObject;
  readonly port: CoherenceToolName;
  /** What `data` holds on success: the answer of the engine's tool, as the harness hands it on (agent-harness §3). */
  readonly result: ObjectSpec;
  /** False while the spec still lets an unlisted key through. */
  readonly resultClosed: boolean;
  /** A cross-field rule the closed-set shape cannot express. Returns a model-facing error, or nothing. */
  readonly refine?: (params: Readonly<Record<string, unknown>>) => string | undefined;
}

const GROUPS_RESULT = param.list(
  'The findings, grouped by check and fact group, the most severe first.',
  param.object(
    'One group.',
    {
      checkId: param.string('The check that found them.'),
      factGroup: param.string('The fact the findings share.'),
      type: param.string('The finding type.'),
      severity: param.choice('The most severe finding in the group.', FINDING_SEVERITIES),
      count: param.integer('How many findings the group holds.'),
      findingIds: param.list('Their ids.', param.string('A finding id.')),
      docIds: param.list('The documents they touch.', param.string('A document id.')),
    },
    ['checkId', 'factGroup', 'type', 'severity', 'count', 'findingIds', 'docIds'],
  ),
);

/** `coherence.scan`'s answer (`ScanData`), less the groups the response cap left out. */
export const COHERENCE_SCAN_RESULT = param.object(
  'The run, and its findings by group.',
  {
    runId: param.string('The run that was recorded.'),
    status: param.choice('Whether every check finished.', RUN_STATUSES),
    findingsUpserted: param.integer('How many findings the run recorded or refreshed.'),
    documents: param.integer('How many documents the scope held once archived and withheld ones were left out.'),
    groups: GROUPS_RESULT,
    notes: param.list('What the run says aloud.', param.string('One note.')),
  },
  ['runId', 'status', 'findingsUpserted', 'documents', 'groups', 'notes'],
);

/** `coherence.review`'s answer (`ReviewRunData`), less the groups the response cap left out. */
export const COHERENCE_REVIEW_RESULT = param.object(
  'The run, and its findings by group.',
  {
    runId: param.string('The run that was recorded.'),
    status: param.choice('Whether the review finished.', ['complete', 'partial']),
    findingsUpserted: param.integer('How many findings the run recorded or refreshed.'),
    groups: GROUPS_RESULT,
    notes: param.list('What the run says aloud.', param.string('One note.')),
  },
  ['runId', 'status', 'findingsUpserted', 'groups', 'notes'],
);

/** `coherence.setFindingStatus`'s answer (`SetStatusData`). */
export const COHERENCE_SET_STATUS_RESULT = param.object(
  'The finding, and whether it was already fixed.',
  {
    findingId: param.string('The finding.'),
    status: param.choice('Always fixed: the only status an agent sets.', ['fixed']),
    alreadyFixed: param.boolean('True when the finding was fixed before this call.'),
  },
  ['findingId', 'status', 'alreadyFixed'],
);

const SCOPE_PARAM: ToolParamSpec = {
  kind: 'object',
  description:
    'Which documents to read. "doc" reads one document (docIds holds exactly its id); "changed" reads documents edited since their last review; "full" reads the manuscript.',
  properties: {
    mode: { kind: 'enum', description: 'The run scope.', values: ['doc', 'changed', 'full'] },
    docIds: {
      kind: 'array',
      description: 'For mode "doc" only: the one document id to read.',
      items: { kind: 'string', description: 'A document id.', nonBlank: true },
      maxItems: 1,
      unique: true,
    },
  },
  required: ['mode'],
};

/**
 * Cross-field rule for a scope. An absent scope is not checked here: the harness
 * decides whether it is required, which `coherence.review` does and `coherence.scan` does not.
 */
function scopeRefine(scope: unknown): string | undefined {
  if (scope === undefined) return undefined;
  if (typeof scope !== 'object' || scope === null) return 'scope must be an object with a mode';
  const record = scope as Record<string, unknown>;
  const docIds = record.docIds;
  if (record.mode === 'doc') {
    if (!Array.isArray(docIds) || docIds.length !== 1) return 'scope mode "doc" names exactly one document in docIds';
    return undefined;
  }
  if (docIds !== undefined) return `scope mode "${String(record.mode)}" takes no docIds; use mode "doc" for one document`;
  return undefined;
}

function toScope(scope: unknown): ScopeSpec {
  const record = (scope ?? { mode: 'full' }) as { mode: 'doc' | 'changed' | 'full'; docIds?: string[] };
  if (record.mode === 'doc') return { mode: 'doc', docIds: record.docIds ?? [] };
  return { mode: record.mode };
}

const SCAN_DESCRIPTION =
  'Run the deterministic coherence checks over a scope: timeline order, relations, windows and overlaps; codex alias collisions and unmentioned entries; POV coverage and expected presence. No model call. Findings go to the inbox and a run is recorded. The manuscript is never changed. A scope over 20 documents asks for confirmation first.';

const REVIEW_DESCRIPTION =
  'Run the model-judged continuity review over a scope: extract checkable statements, verify candidate pairs, assemble findings. Write-confirm: a plan card shows the documents, a cost bound and a prompt preview, and nothing runs until the writer approves. Findings go to the inbox. The manuscript is never changed.';

const SET_STATUS_DESCRIPTION =
  'Mark a finding fixed once the text that produced it has changed. Applies automatically within an approved turn. Only status "fixed" is settable here. A finding that the check or the quoted text still shows is refused with the reason. Dismissal is a writer judgment, so a "dismissed" request is refused and belongs in your report.';

/** The three entries, in the harness's entry shape. Registration maps each `port` to its handler below. */
export const COHERENCE_TOOL_ENTRIES: readonly CoherenceToolEntry[] = [
  {
    kind: 'port',
    meta: {
      name: 'coherence.scan',
      risk: 'read',
      undoable: true,
      response_token_cap: 4000,
      descriptionVersion: 1,
      description: SCAN_DESCRIPTION,
      surface: 'extension',
      load: 'deferred',
      keywords: ['coherence', 'continuity', 'consistency', 'check', 'findings'],
    },
    params: {
      kind: 'object',
      description: 'Scope and checks for a deterministic coherence scan.',
      properties: {
        scope: SCOPE_PARAM,
        checks: {
          kind: 'array',
          description: 'The deterministic checks to run. Omit for all eight.',
          items: { kind: 'enum', description: 'A deterministic check id.', values: DETERMINISTIC_CHECK_IDS },
          unique: true,
        },
      },
      required: [],
    },
    port: 'coherence.scan',
    result: COHERENCE_SCAN_RESULT,
    resultClosed: false,
    refine: (params) => scopeRefine(params.scope),
  },
  {
    kind: 'port',
    meta: {
      name: 'coherence.review',
      risk: 'write-confirm',
      undoable: true,
      response_token_cap: 2000,
      descriptionVersion: 1,
      description: REVIEW_DESCRIPTION,
      surface: 'extension',
      load: 'deferred',
      keywords: ['coherence', 'continuity', 'consistency', 'review', 'findings', 'contradiction'],
    },
    params: {
      kind: 'object',
      description: 'Scope, categories and cap for a model-judged review.',
      properties: {
        scope: SCOPE_PARAM,
        categories: {
          kind: 'array',
          description: 'The categories to review. Omit for all five.',
          items: { kind: 'enum', description: 'A review category.', values: LLM_CATEGORIES },
          unique: true,
        },
        maxFindings: {
          kind: 'integer',
          description: 'The most findings to record. Defaults to 50; capped at 200.',
          minimum: 1,
          maximum: 200,
        },
      },
      required: ['scope'],
    },
    port: 'coherence.review',
    result: COHERENCE_REVIEW_RESULT,
    resultClosed: false,
    refine: (params) => scopeRefine(params.scope),
  },
  {
    kind: 'port',
    meta: {
      name: 'coherence.setFindingStatus',
      risk: 'write-auto',
      undoable: true,
      response_token_cap: 300,
      descriptionVersion: 1,
      description: SET_STATUS_DESCRIPTION,
      surface: 'extension',
      load: 'deferred',
      keywords: ['coherence', 'finding', 'fixed', 'inbox'],
    },
    params: {
      kind: 'object',
      description: 'The finding and the status to set.',
      properties: {
        findingId: { kind: 'string', description: 'The finding id, from a run report or the inbox.', nonBlank: true },
        status: { kind: 'enum', description: 'Only "fixed" is settable by the agent.', values: ['fixed', 'dismissed'] },
        note: { kind: 'string', description: 'What changed, in a sentence.', maxLength: NOTE_LIMIT },
      },
      required: ['findingId', 'status'],
    },
    port: 'coherence.setFindingStatus',
    result: COHERENCE_SET_STATUS_RESULT,
    resultClosed: false,
  },
];

/* ------------------------------------------------------------------ *
 * Handlers. Each takes validated params and a context, and returns a
 * result. The caller persists `file` when it is present.
 * ------------------------------------------------------------------ */

export interface CoherenceToolContext {
  readonly state: ProjectState;
  readonly file: CoherenceFile;
  readonly now: Date;
  readonly mentions?: MentionCacheSource;
  readonly detector?: MentionDetector;
  readonly model?: CoherenceModel;
  readonly review?: ReviewContext;
  readonly randomBytes?: RandomBytes;
  /** The writer approved a scope over the guard in the one-step card. */
  readonly approvedLargeScope?: boolean;
  /** The dialogue module's validation for the containers in the project, when the app has read them (dialogue-narrative.md §5). */
  readonly dialogue?: DialogueFacts;
  /** The held findings file as it stands now, read again when a review's model calls have settled (see `ReviewRunOptions.currentFile`). */
  readonly currentFile?: () => CoherenceFile;
  /** The writer's stop: a review that sees it fired ends its run as partial, with the findings it has (`ReviewRunOptions.signal`). */
  readonly signal?: AbortSignal;
  /** Documents a read rule keeps from the agent (agent-harness §4): they are not scanned or reviewed. Absent, only archived documents are left out. */
  readonly isExcluded?: (node: TreeNode) => boolean;
}

export interface ToolSuccess<T> {
  readonly ok: true;
  readonly data: T;
  readonly summary: string;
  /** The coherence file after the call, when the call changed it. */
  readonly file?: CoherenceFile;
}

export interface ToolFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

export type ToolResult<T> = ToolSuccess<T> | ToolFailure;

function failureOf(error: unknown): ToolFailure {
  if (error instanceof CoherenceError) return { ok: false, code: error.code, message: error.message };
  if (error instanceof Error) return { ok: false, code: 'failed', message: error.message };
  return { ok: false, code: 'failed', message: String(error) };
}

export interface ScanData {
  readonly runId: string;
  readonly status: CoherenceRun['status'];
  readonly findingsUpserted: number;
  /** How many documents the scope held once archived and withheld ones were left out. */
  readonly documents: number;
  readonly groups: readonly FindingGroup[];
  readonly notes: readonly string[];
}

/**
 * The checks a scan names. Absent means all eight. Anything else must name real checks:
 * an unknown id is refused with the list of valid ones (§7 tool 15), and an empty list
 * is refused, because it would run nothing and still report a complete run.
 */
function checksOf(raw: unknown): ToolFailure | { readonly ok: true; readonly checks: readonly DeterministicCheckId[] | undefined } {
  if (raw === undefined) return { ok: true, checks: undefined };
  const valid = DETERMINISTIC_CHECK_IDS.join(', ');
  if (!Array.isArray(raw)) {
    return { ok: false, code: 'checks-invalid', message: `checks must be a list of check ids; valid ids are ${valid}` };
  }
  if (raw.length === 0) {
    return {
      ok: false,
      code: 'checks-empty',
      message: `checks names no check, so nothing would run. Omit checks to run all ${DETERMINISTIC_CHECK_IDS.length}, or name at least one of: ${valid}`,
    };
  }
  const unknown = raw.filter((id) => typeof id !== 'string' || !(DETERMINISTIC_CHECK_IDS as readonly string[]).includes(id));
  if (unknown.length > 0) {
    return {
      ok: false,
      code: 'unknown-check',
      message: `unknown check ${unknown.map((id) => `"${String(id)}"`).join(', ')}; valid check ids are ${valid}`,
    };
  }
  return { ok: true, checks: raw as DeterministicCheckId[] };
}

/** §7 tool 15. A scope over the guard needs approval, and the refusal says how to proceed. */
export function scanTool(params: Readonly<Record<string, unknown>>, context: CoherenceToolContext): ToolResult<ScanData> {
  const refusal = scopeRefine(params.scope);
  if (refusal !== undefined) return { ok: false, code: 'scope-invalid', message: refusal };
  const picked = checksOf(params.checks);
  if (!picked.ok) return picked;
  try {
    const scope = toScope(params.scope);
    const includeDocIds = scope.mode === 'doc' ? new Set(scope.docIds) : undefined;
    const snapshot = snapshotManuscript(context.state, context.file, {
      ...(includeDocIds === undefined ? {} : { includeDocIds }),
      ...(context.isExcluded === undefined ? {} : { isExcluded: context.isExcluded }),
    });
    const count = resolveScope(snapshot, context.file, scope).length;
    if (count > SCAN_DOC_GUARD && context.approvedLargeScope !== true) {
      return {
        ok: false,
        code: 'confirmation-required',
        message: `This scope has ${count} documents, over the ${SCAN_DOC_GUARD}-document guard. Split the scope, or confirm it in the card.`,
      };
    }
    const result = runDeterministic(context.state, context.file, {
      scope,
      ...(context.isExcluded !== undefined ? { isExcluded: context.isExcluded } : {}),
      ...(picked.checks !== undefined ? { checks: picked.checks } : {}),
      now: context.now,
      ...(context.mentions !== undefined ? { mentions: context.mentions } : {}),
      ...(context.detector !== undefined ? { detector: context.detector } : {}),
      ...(context.dialogue !== undefined ? { dialogue: context.dialogue } : {}),
      randomBytes: context.randomBytes,
    });
    const upserted = new Set(result.run.findingsUpserted);
    const groups = groupFindings(result.file.findings.filter((finding) => upserted.has(finding.id)));
    return {
      ok: true,
      file: result.file,
      data: {
        runId: result.run.id,
        status: result.run.status,
        findingsUpserted: result.run.findingsUpserted.length,
        documents: count,
        groups,
        notes: result.run.notes ?? [],
      },
      summary: `Scan ${result.run.status}: ${result.run.findingsUpserted.length} finding(s) in ${groups.length} group(s) across ${count} document(s).`,
    };
  } catch (error) {
    return failureOf(error);
  }
}

export interface ReviewPreviewData {
  readonly plan: ReviewPlan;
}

/** §7 tool 16, the plan half. Refuses before planning when there is no provider to call. */
export function previewReviewTool(params: Readonly<Record<string, unknown>>, context: CoherenceToolContext): ToolResult<ReviewPreviewData> {
  if (context.model === undefined) {
    const missing = new NoProviderError();
    return { ok: false, code: missing.code, message: missing.message };
  }
  if (params.scope === undefined) {
    return { ok: false, code: 'scope-required', message: 'coherence.review needs a scope: name "doc", "changed" or "full"' };
  }
  const refusal = scopeRefine(params.scope);
  if (refusal !== undefined) return { ok: false, code: 'scope-invalid', message: refusal };
  try {
    const plan = planReview(
      context.state,
      context.file,
      {
        scope: toScope(params.scope),
        ...(Array.isArray(params.categories) ? { categories: params.categories as LlmCategory[] } : {}),
        ...(typeof params.maxFindings === 'number' ? { maxFindings: params.maxFindings } : {}),
        ...(context.isExcluded !== undefined ? { isExcluded: context.isExcluded } : {}),
      },
      context.review,
    );
    return {
      ok: true,
      data: { plan },
      summary: `Plan: ${plan.documents.length} document(s), ${plan.estimate.extractCalls} extraction call(s) and at most ${plan.estimate.verifyCallsAtMost} verification call(s), about ${plan.estimate.totalTokensAtMost} tokens at most.`,
    };
  } catch (error) {
    return failureOf(error);
  }
}

export interface ReviewRunData {
  readonly runId: string;
  readonly status: 'complete' | 'partial';
  readonly findingsUpserted: number;
  readonly groups: readonly FindingGroup[];
  readonly notes: readonly string[];
}

/** §7 tool 16, the run half. Called only with the writer's approval of the plan it names. */
export async function executeReviewTool(
  plan: ReviewPlan,
  approved: boolean,
  context: CoherenceToolContext,
): Promise<ToolResult<ReviewRunData>> {
  try {
    const result = await runReview(context.state, context.file, plan, {
      model: context.model,
      approved,
      now: context.now,
      ...(context.review !== undefined ? { context: context.review } : {}),
      ...(context.currentFile !== undefined ? { currentFile: context.currentFile } : {}),
      ...(context.signal !== undefined ? { signal: context.signal } : {}),
      ...(context.isExcluded !== undefined ? { isExcluded: context.isExcluded } : {}),
      randomBytes: context.randomBytes,
    });
    const upserted = new Set(result.run.findingsUpserted);
    const groups = groupFindings(result.file.findings.filter((finding) => upserted.has(finding.id)));
    return {
      ok: true,
      file: result.file,
      data: {
        runId: result.run.id,
        status: result.status,
        findingsUpserted: result.run.findingsUpserted.length,
        groups,
        notes: result.notes,
      },
      summary: `Review ${result.status}: ${result.run.findingsUpserted.length} finding(s) recorded.`,
    };
  } catch (error) {
    return failureOf(error);
  }
}

export interface SetStatusData {
  readonly findingId: string;
  readonly status: 'fixed';
  readonly alreadyFixed: boolean;
}

/** §7 tool 17. Only `fixed` is settable; the refusals are the spec's, worded for the model. */
export function setFindingStatusTool(params: Readonly<Record<string, unknown>>, context: CoherenceToolContext): ToolResult<SetStatusData> {
  const findingId = typeof params.findingId === 'string' ? params.findingId : '';
  const status = typeof params.status === 'string' ? params.status : '';
  const note = typeof params.note === 'string' ? params.note : undefined;
  const problem = noteLengthProblem(note);
  if (problem !== undefined) return { ok: false, code: 'note-too-long', message: `the note is ${problem}. Shorten it and try again.` };
  const outcome = setFindingStatusForAgent(
    context.state,
    context.file,
    { findingId, status, ...(note !== undefined ? { note } : {}) },
    { now: context.now, ...(context.mentions !== undefined ? { mentions: context.mentions } : {}), ...(context.detector !== undefined ? { detector: context.detector } : {}) },
  );
  if (!outcome.ok) return { ok: false, code: outcome.refusal, message: outcome.message };
  const data: SetStatusData = { findingId, status: 'fixed', alreadyFixed: outcome.alreadyFixed };
  return {
    ok: true,
    data,
    summary: outcome.alreadyFixed ? `Finding ${findingId} was already fixed.` : `Finding ${findingId} marked fixed.`,
    file: outcome.alreadyFixed ? undefined : outcome.file,
  };
}
