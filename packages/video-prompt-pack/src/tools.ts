/**
 * The two prompt-pack agent tools — [video-prompt-pack.md §6](../../../docs/architecture/video-prompt-pack.md),
 * the registry growing from 14 to 16 when the module lands.
 *
 * Each tool is declared in the shape the harness registry reads (`packages/harness/src/types.ts`: `kind`,
 * `meta`, `params`, and a port name), so registration is a table entry and not a rewrite, as
 * `COHERENCE_TOOL_ENTRIES` is. Two things are left to registration: the JSON Schema, which the harness derives
 * from `params`, and the closed set of port names, which lives in the harness and widens when these are wired.
 *
 * Both tools are model-backed, so each has two halves, and the loop runs them in this order:
 *
 *  - `stagePromptDraft` / `stagePromptVariant` call the injected model. They are asynchronous and write nothing.
 *    The loop keeps their output as the call's staged proposal.
 *  - `commitPromptDraftTool` / `pickVariantTool` are synchronous and apply a staged proposal. The port for
 *    `prompt.draft` is `commitPromptDraftTool(context.proposal)`, and the port for `prompt.variant` is
 *    `pickVariantTool`, run only after the writer has picked a value on the card.
 *
 * The handlers return model-facing results. A refusal carries the sentence the model reads next, because a bare
 * error sends it looking for a way round.
 */

import { PromptPackError } from './errors.js';
import { commitPromptDraft, DRAFT_SHOT_LIMIT, requireTemplate, stagePromptDraft, type PromptDraftProposal, type PromptDraftWrite } from './draft.js';
import type { PromptModel } from './port.js';
import type { StoryboardSnapshot } from './model.js';
import { templateById, VIDEO_TEMPLATE_IDS } from './templates/index.js';
import { stagePromptVariant, variantPickProposal, VARIATIONS, type VariantProposal, type VariantRequest } from './variant.js';

export const PROMPT_PACK_TOOL_NAMES = ['prompt.draft', 'prompt.variant'] as const;
export type PromptPackToolName = (typeof PROMPT_PACK_TOOL_NAMES)[number];

export function isPromptPackToolName(value: unknown): value is PromptPackToolName {
  return (PROMPT_PACK_TOOL_NAMES as readonly unknown[]).includes(value);
}

/** The harness's risk column, restricted to what these tools use. */
export type PromptPackToolRisk = 'read' | 'write-confirm';

/** Mirrors the harness's `ToolMetadata` fields. `surface` is `extension` because the module is post-v0.1. */
export interface PromptPackToolMeta {
  readonly name: PromptPackToolName;
  readonly risk: PromptPackToolRisk;
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

/** The subset of the harness's `ParamSpec` these tools use. The kinds and their fields match `packages/harness/src/schema.ts`. */
export type PromptPackParamSpec =
  | { readonly kind: 'string'; readonly description: string; readonly nonBlank?: boolean; readonly maxLength?: number }
  | { readonly kind: 'enum'; readonly description: string; readonly values: readonly string[] }
  | {
      readonly kind: 'array';
      readonly description: string;
      readonly items: PromptPackParamSpec;
      readonly minItems?: number;
      readonly maxItems?: number;
      readonly unique?: boolean;
    }
  | {
      readonly kind: 'object';
      readonly description: string;
      readonly properties: Readonly<Record<string, PromptPackParamSpec>>;
      readonly required: readonly string[];
    };

export type PromptPackParamsObject = Extract<PromptPackParamSpec, { kind: 'object' }>;

export interface PromptPackToolEntry {
  readonly kind: 'port';
  readonly meta: PromptPackToolMeta;
  readonly params: PromptPackParamsObject;
  readonly port: PromptPackToolName;
  /** A cross-field rule the closed-set shape cannot express. Returns a model-facing error, or nothing. */
  readonly refine?: (params: Readonly<Record<string, unknown>>) => string | undefined;
}

/** A vendor refusal that names what is installed. Undefined for a vendor that is. */
function vendorProblem(vendor: unknown): string | undefined {
  if (typeof vendor !== 'string') return 'vendor must be the id of an installed template';
  if (templateById(vendor) !== undefined) return undefined;
  return `"${vendor}" is not an installed vendor template. The installed templates are ${VIDEO_TEMPLATE_IDS.join(', ')}.`;
}

const DRAFT_DESCRIPTION =
  "Draft one vendor's video prompt for up to 30 shots: the camera from each shot's parameters, the subject, action, context and style from its script coverage and the codex, and audio and negatives where the vendor takes them. Write-confirm: the plan card shows each shot's proposed prompt, the codex entries behind its references and its validation rows, and nothing is written until the writer approves. Caotang never generates video.";

const VARIANT_DESCRIPTION =
  "Offer three alternative values for one part of a shot's prompt for one vendor: its camera, its lighting, its style or its ambient audio. Read-only: the alternatives come back as a list and nothing is written. The shot needs a prompt for that vendor first; run prompt.draft on it.";

/** The two entries, in the harness's entry shape. Registration maps each `port` to its handler below. */
export const PROMPT_PACK_TOOL_ENTRIES: readonly PromptPackToolEntry[] = [
  {
    kind: 'port',
    meta: {
      name: 'prompt.draft',
      risk: 'write-confirm',
      undoable: true,
      response_token_cap: 4000,
      descriptionVersion: 1,
      description: DRAFT_DESCRIPTION,
      surface: 'extension',
      load: 'deferred',
      keywords: ['prompt pack', 'video', 'prompt', 'shots', 'vendor'],
    },
    params: {
      kind: 'object',
      description: 'The shots to draft, the vendor template and the creative direction.',
      properties: {
        shots: {
          kind: 'array',
          description: 'The storyboard shot ids to draft, in any order. At most 30 per call; split a longer list.',
          items: { kind: 'string', description: 'A shot node id.', nonBlank: true },
          minItems: 1,
          maxItems: DRAFT_SHOT_LIMIT,
          unique: true,
        },
        vendor: { kind: 'string', description: 'The vendor template id, for example runway-gen4.', nonBlank: true },
        instruction: { kind: 'string', description: 'Creative direction applied to every shot in the call.', maxLength: 2000 },
      },
      required: ['shots', 'vendor'],
    },
    port: 'prompt.draft',
    refine: (params) => vendorProblem(params.vendor),
  },
  {
    kind: 'port',
    meta: {
      name: 'prompt.variant',
      risk: 'read',
      undoable: false,
      response_token_cap: 1000,
      descriptionVersion: 1,
      description: VARIANT_DESCRIPTION,
      surface: 'extension',
      load: 'deferred',
      keywords: ['prompt pack', 'video', 'prompt', 'variant', 'vendor'],
    },
    params: {
      kind: 'object',
      description: 'The shot, the vendor template and the part of the prompt to vary.',
      properties: {
        shot: { kind: 'string', description: 'The storyboard shot id.', nonBlank: true },
        vendor: { kind: 'string', description: 'The vendor template id, for example runway-gen4.', nonBlank: true },
        variation: { kind: 'enum', description: 'The part of the prompt to vary: camera, lighting, style or audio.', values: VARIATIONS },
      },
      required: ['shot', 'vendor', 'variation'],
    },
    port: 'prompt.variant',
    refine: (params) => vendorProblem(params.vendor),
  },
];

/* ------------------------------------------------------------------ *
 * Handlers. A success carries `data` and a one-line `summary`. A
 * failure carries a stable `code` and the message the model reads.
 * ------------------------------------------------------------------ */

export interface PromptPackToolContext {
  readonly storyboard: StoryboardSnapshot;
  /** Absent when the app has no provider. The draft tools then refuse, and name the settings step. */
  readonly model?: PromptModel;
  readonly signal?: AbortSignal;
}

export interface ToolSuccess<T> {
  readonly ok: true;
  readonly data: T;
  readonly summary: string;
}

export interface ToolFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

export type ToolResult<T> = ToolSuccess<T> | ToolFailure;

function failureOf(error: unknown): ToolFailure {
  if (error instanceof PromptPackError) return { ok: false, code: error.code, message: error.message };
  if (error instanceof Error && error.name === 'AbortError') return { ok: false, code: 'aborted', message: 'The draft was stopped before it finished. Nothing was written.' };
  if (error instanceof Error) return { ok: false, code: 'failed', message: error.message };
  return { ok: false, code: 'failed', message: String(error) };
}

/** Stages a `prompt.draft` call. The result's `data` is the proposal the plan card shows. */
export async function stagePromptDraftTool(params: Readonly<Record<string, unknown>>, context: PromptPackToolContext): Promise<ToolResult<PromptDraftProposal>> {
  const problem = vendorProblem(params.vendor);
  if (problem !== undefined) return { ok: false, code: 'unknown-vendor', message: problem };
  if (context.model === undefined) {
    return { ok: false, code: 'no-model', message: 'No provider is configured, so prompt.draft cannot run. Name a provider profile in settings, then draft again.' };
  }
  try {
    const shotIds = Array.isArray(params.shots) ? params.shots.filter((id): id is string => typeof id === 'string') : [];
    const proposal = await stagePromptDraft(
      {
        shotIds,
        vendor: String(params.vendor),
        ...(typeof params.instruction === 'string' && params.instruction.trim() !== '' ? { instruction: params.instruction } : {}),
      },
      context.storyboard,
      context.model,
      context.signal,
    );
    const issues = proposal.items.reduce((total, item) => total + item.issues.length, 0);
    return {
      ok: true,
      data: proposal,
      summary: `Drafted ${proposal.items.length} shot(s) for ${proposal.displayName}; ${proposal.refusals.length} refused; ${issues} validation row(s).`,
    };
  } catch (error) {
    return failureOf(error);
  }
}

export interface CommitData {
  readonly writes: readonly PromptDraftWrite[];
}

/**
 * Applies an approved `prompt.draft` proposal. Synchronous, because it is the one step that writes. A conflict
 * refuses the whole proposal, so nothing lands half-applied, and the message says to draft again.
 */
export function commitPromptDraftTool(proposal: PromptDraftProposal, context: PromptPackToolContext): ToolResult<CommitData> {
  if (proposal.items.length === 0) {
    return { ok: false, code: 'nothing-to-apply', message: 'The proposal drafted no shot, so there is nothing to write. Draft the shots again, or drop the ones that were refused.' };
  }
  try {
    requireTemplate(proposal.vendor);
    const outcome = commitPromptDraft(proposal, context.storyboard);
    if (!outcome.ok) {
      return { ok: false, code: 'conflict', message: `Not applied: ${outcome.conflicts.join('; ')}. Nothing was written. Draft those shots again.` };
    }
    return {
      ok: true,
      data: { writes: outcome.writes },
      summary: `Wrote the prompt for ${outcome.writes.length} shot(s) as ${proposal.displayName}.`,
    };
  } catch (error) {
    return failureOf(error);
  }
}

/** Stages a `prompt.variant` call. Read-only: the result lists the alternatives and writes nothing. */
export async function stagePromptVariantTool(params: Readonly<Record<string, unknown>>, context: PromptPackToolContext): Promise<ToolResult<VariantProposal>> {
  const problem = vendorProblem(params.vendor);
  if (problem !== undefined) return { ok: false, code: 'unknown-vendor', message: problem };
  const variation = VARIATIONS.find((candidate) => candidate === params.variation);
  if (variation === undefined) {
    return { ok: false, code: 'unknown-variation', message: `The variation must be one of ${VARIATIONS.join(', ')}.` };
  }
  if (context.model === undefined) {
    return { ok: false, code: 'no-model', message: 'No provider is configured, so prompt.variant cannot run. Name a provider profile in settings, then try again.' };
  }
  try {
    const request: VariantRequest = { shot: String(params.shot), vendor: String(params.vendor), variation };
    const proposal = await stagePromptVariant(request, context.storyboard, context.model, context.signal);
    return {
      ok: true,
      data: proposal,
      summary: `Three ${proposal.variation} alternatives for shot ${proposal.shotNumber}. Nothing is written until one is picked.`,
    };
  } catch (error) {
    return failureOf(error);
  }
}

/**
 * Turns the writer's pick from a `prompt.variant` card into the draft proposal that the commit applies.
 * The value must be one of the alternatives the card offered.
 */
export function pickVariantTool(proposal: VariantProposal, value: string, context: PromptPackToolContext): ToolResult<PromptDraftProposal> {
  try {
    const picked = variantPickProposal(proposal, value, context.storyboard);
    return { ok: true, data: picked, summary: `Picked a ${proposal.variation} alternative for shot ${proposal.shotNumber}; it lands through the draft commit.` };
  } catch (error) {
    return failureOf(error);
  }
}
