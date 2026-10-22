/**
 * The two storyboard agent tools — [storyboard.md](../../../docs/architecture/storyboard.md) §4, tools 18 and 19.
 *
 * Each entry is declared in the shape the harness registry reads (`packages/harness/src/types.ts`: `meta`,
 * `params`, `refine` and a port name). `test/harness-contract.test.ts` checks that shape against the
 * harness's own types at compile time, so a drift in either package fails the typecheck. Two things are
 * left to registration, as coherence leaves them: the JSON Schema, which the harness derives from `params`
 * with its own `toJsonSchema` (its types say so: "never written by hand"), and the closed set of port names,
 * which lives in the harness and widens when these tools are wired. This package does not import the
 * harness at runtime. The harness is the package that registers these entries, so the dependency runs one
 * way, from harness to here.
 *
 * Both handlers plan. Neither applies, and neither returns an inverse. Each returns the bus's
 * `Result<…, CommandError>` (command-bus §7), with the plan to show and the commands the bus will apply as
 * one undo group (agent-harness §5). The entries are declared, not registered: a port dispatches through
 * `PortContext.dispatch`, whose command names are the bus's closed registry, and the bus has no shot
 * commands yet (see `commands.ts`). So `shots.*` stays out of the harness until it does.
 */

import type { RandomBytes } from '@caotang/ids';
import type { ProjectState } from '@caotang/store';
import type { CommandError, CommandErrorCode, Result } from '@caotang/bus';

import type { ShotCommand } from './commands.js';
import { planAnnotate, type AnnotatePlan, type AnnotateRequest, type SpecPatch } from './annotate.js';
import { planDerive, type DerivePlan } from './derive.js';
import {
  ACTION_MAX_CHARS,
  ANNOTATE_MAX_SHOTS,
  CAMERA_ANGLES,
  CAMERA_MOVEMENTS,
  DERIVE_GRANULARITIES,
  SHOT_SIZES,
  TRANSITIONS,
} from './model.js';
import { isPlainObject } from './shot-meta.js';
import { ok, refuse, type StoryboardRefusal, type StoryboardResult } from './result.js';

export const STORYBOARD_TOOL_NAMES = ['shots.derive', 'shots.annotate'] as const;
export type StoryboardToolName = (typeof STORYBOARD_TOOL_NAMES)[number];

export function isStoryboardToolName(value: unknown): value is StoryboardToolName {
  return (STORYBOARD_TOOL_NAMES as readonly unknown[]).includes(value);
}

/** The harness's risk column, restricted to what these two tools use. */
export type StoryboardToolRisk = 'write-auto' | 'write-confirm';

/** Mirrors the harness's `ToolMetadata`. `surface` is `extension`: the track lands after v0.1 (media-track §2). */
export interface StoryboardToolMeta {
  readonly name: StoryboardToolName;
  readonly risk: StoryboardToolRisk;
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
 * The subset of the harness's `ParamSpec` these tools use. The kinds and their fields match
 * `packages/harness/src/schema.ts`, so the harness reads them as they are.
 */
export type StoryboardParamSpec =
  | { readonly kind: 'string'; readonly description: string; readonly nonBlank?: boolean; readonly maxLength?: number }
  | { readonly kind: 'enum'; readonly description: string; readonly values: readonly string[]; readonly default?: string }
  | {
      readonly kind: 'array';
      readonly description: string;
      readonly items: StoryboardParamSpec;
      readonly minItems?: number;
      readonly maxItems?: number;
      readonly unique?: boolean;
    }
  | {
      readonly kind: 'object';
      readonly description: string;
      readonly properties: Readonly<Record<string, StoryboardParamSpec>>;
      readonly required: readonly string[];
    };

export type StoryboardParamsObject = Extract<StoryboardParamSpec, { kind: 'object' }>;

export interface StoryboardToolEntry {
  readonly kind: 'port';
  readonly meta: StoryboardToolMeta;
  readonly params: StoryboardParamsObject;
  readonly port: StoryboardToolName;
  /**
   * A cross-field rule the closed-set shape cannot express. Returns the refusal the harness reports, or
   * nothing. The type is the harness's own (`refine` in `types.ts`), so a bare string does not compile.
   */
  readonly refine?: (params: Readonly<Record<string, unknown>>) => CommandError | undefined;
}

const DERIVE_DESCRIPTION =
  'Propose the shots for one screenplay scene: size, angle, movement, action, duration and the dialogue each shot covers. Dialogue is covered by quoting the scene verbatim. The plan card shows the new storyboard folder and its shots, and nothing is created until the writer approves. Images are not generated. More than 60 shots is refused: split the scene. Requires user confirmation.';

const ANNOTATE_DESCRIPTION =
  'Set the image, the camera spec or the action on up to 50 existing shots in one batch, validated before anything changes. The vocabulary is closed: a value outside the list is refused with the valid ones. Applies automatically within an approved turn, and naming a shot again with the values it already has changes nothing. Undo restores each shot\'s prior metadata.';

const SPEC_PARAMS: StoryboardParamsObject = {
  kind: 'object',
  description: 'The camera fields to set. Any subset.',
  properties: {
    shotSize: { kind: 'enum', description: 'The shot size.', values: SHOT_SIZES },
    cameraAngle: { kind: 'enum', description: 'The camera angle.', values: CAMERA_ANGLES },
    cameraMovement: { kind: 'enum', description: 'The camera movement.', values: CAMERA_MOVEMENTS },
    lens: { kind: 'string', description: 'The lens, as free text, e.g. 35mm anamorphic.', maxLength: 200 },
    transition: { kind: 'enum', description: 'The outgoing transition.', values: TRANSITIONS },
  },
  required: [],
};

/** The two entries, in the harness's entry shape. Registration maps each `port` to its handler below. */
export const STORYBOARD_TOOL_ENTRIES: readonly StoryboardToolEntry[] = [
  {
    kind: 'port',
    meta: {
      name: 'shots.derive',
      risk: 'write-confirm',
      undoable: true,
      response_token_cap: 2000,
      descriptionVersion: 1,
      description: DERIVE_DESCRIPTION,
      surface: 'extension',
      load: 'deferred',
      keywords: ['storyboard', 'shots', 'screenplay', 'scene', 'camera'],
    },
    params: {
      kind: 'object',
      description: 'The scene to derive shots from, and how.',
      properties: {
        doc: {
          kind: 'string',
          description: 'The screenplay scene: a document id, resolved from its title first.',
          nonBlank: true,
        },
        granularity: {
          kind: 'enum',
          description: 'key-shots covers the scene with the shots that carry it; full-coverage covers every line of dialogue and action.',
          values: DERIVE_GRANULARITIES,
          default: 'key-shots',
        },
        styleNote: {
          kind: 'string',
          description: 'A shot style to follow, e.g. handheld and tight, passed to the model with the scene.',
          maxLength: 500,
        },
      },
      required: ['doc'],
    },
    port: 'shots.derive',
  },
  {
    kind: 'port',
    meta: {
      name: 'shots.annotate',
      risk: 'write-auto',
      undoable: true,
      response_token_cap: 500,
      descriptionVersion: 1,
      description: ANNOTATE_DESCRIPTION,
      surface: 'extension',
      load: 'deferred',
      keywords: ['storyboard', 'shots', 'camera', 'framing', 'image'],
    },
    params: {
      kind: 'object',
      description: 'The shots to change and what to set on them.',
      properties: {
        shots: {
          kind: 'array',
          description: 'The shot ids to change, each named once.',
          items: { kind: 'string', description: 'A shot id, read from binder.read_tree.', nonBlank: true },
          minItems: 1,
          maxItems: ANNOTATE_MAX_SHOTS,
          unique: true,
        },
        image: {
          kind: 'object',
          description: 'An image already in assets/, by its id.',
          properties: { assetId: { kind: 'string', description: 'The asset id the import returned.', nonBlank: true } },
          required: ['assetId'],
        },
        spec: SPEC_PARAMS,
        action: {
          kind: 'string',
          description: 'What happens in frame.',
          maxLength: ACTION_MAX_CHARS,
        },
      },
      required: ['shots'],
    },
    port: 'shots.annotate',
    refine: (params) =>
      params.image === undefined && params.spec === undefined && params.action === undefined
        ? {
            code: 'invalid-params',
            message: 'nothing to set: pass an image, a spec or an action',
            correctiveHint: 'add an image, a spec or an action',
          }
        : undefined,
  },
];

/** The bus codes a storyboard refusal maps to. A refusal not named here is a bad parameter, which is what most of them are. */
const CODE_MAP: Readonly<Record<string, CommandErrorCode>> = {
  'doc-missing': 'not-found',
  'shot-unknown': 'not-found',
  'not-found': 'not-found',
  'too-many-shots': 'limit-exceeded',
  'batch-too-large': 'limit-exceeded',
};

/**
 * A storyboard refusal as the bus's `CommandError` (command-bus §7). The message is the refusal's own text,
 * which already names the corrective step. `askBack` rides in `details` (the bus's details are open), so the
 * harness can tell a question for the writer from a retry, as agent-harness §2 asks.
 */
export function commandErrorOf(refusal: StoryboardRefusal): CommandError {
  const code: CommandErrorCode = refusal.askBack === 'conflict' ? 'revision-conflict' : (CODE_MAP[refusal.code] ?? 'invalid-params');
  return {
    code,
    message: refusal.message,
    details: { storyboardCode: refusal.code, ...(refusal.askBack !== undefined ? { askBack: refusal.askBack } : {}) },
  };
}

/** A storyboard result as the bus's `Result`, so a handler's refusal has the shape the harness reads. */
export function toBusResult<T>(result: StoryboardResult<T>): Result<T, CommandError> {
  return result.ok ? { ok: true, value: result.value } : { ok: false, error: commandErrorOf(result.refusal) };
}

/** What the harness is handed back from the derive handler: the plan to show, the commands to apply, and a line to report. */
export interface DeriveToolData {
  readonly plan: DerivePlan;
  readonly commands: readonly ShotCommand[];
  readonly summary: string;
}

export interface AnnotateToolData {
  readonly plan: AnnotatePlan;
  readonly commands: readonly ShotCommand[];
  readonly summary: string;
}

export interface StoryboardToolContext {
  readonly state: ProjectState;
  /** The asset ids present under `assets/`, from `presentAssetIds`. */
  readonly presentAssets: ReadonlySet<string>;
  /** What the agent loop staged for this call: the model's shot proposal, for `shots.derive`. */
  readonly proposal?: unknown;
  readonly now?: Date;
  readonly randomBytes?: RandomBytes;
}

function deriveShots(params: Readonly<Record<string, unknown>>, context: StoryboardToolContext): StoryboardResult<DeriveToolData> {
  const doc = params.doc;
  if (typeof doc !== 'string' || doc.trim() === '') return refuse('doc-missing', 'doc must be the id of a screenplay scene');
  const granularity = params.granularity ?? DERIVE_GRANULARITIES[0];
  if (!(DERIVE_GRANULARITIES as readonly unknown[]).includes(granularity)) {
    return refuse('granularity-invalid', `granularity must be one of ${DERIVE_GRANULARITIES.join(', ')}`);
  }
  const styleNote = typeof params.styleNote === 'string' ? params.styleNote : undefined;
  const planned = planDerive(
    context.state,
    {
      docId: doc,
      granularity: granularity as (typeof DERIVE_GRANULARITIES)[number],
      ...(styleNote !== undefined ? { styleNote } : {}),
    },
    context.proposal,
    context.randomBytes !== undefined ? { randomBytes: context.randomBytes } : {},
  );
  if (!planned.ok) return planned;
  const count = planned.value.shots.length;
  return ok({
    plan: planned.value,
    commands: planned.value.commands,
    summary: `Plan: a storyboard "${planned.value.folderTitle}" with ${count} shot${count === 1 ? '' : 's'}, awaiting approval.`,
  });
}

/**
 * `shots.derive`'s handler. It plans and does not apply: the commands in the result are what the bus runs
 * once the writer approves the card. `params.doc` is a resolved id, as the harness passes it after
 * resolving a title.
 */
export function deriveShotsTool(params: Readonly<Record<string, unknown>>, context: StoryboardToolContext): Result<DeriveToolData, CommandError> {
  return toBusResult(deriveShots(params, context));
}

/** Reads `shots.annotate`'s params into a request. The closed-set check already ran; this only narrows the types. */
function annotateRequestOf(params: Readonly<Record<string, unknown>>): StoryboardResult<AnnotateRequest> {
  const shots = params.shots;
  if (!Array.isArray(shots) || !shots.every((id) => typeof id === 'string')) {
    return refuse('shots-invalid', 'shots must be a list of shot ids');
  }
  const request: { shots: string[]; image?: { assetId: string }; spec?: SpecPatch; action?: string } = { shots: shots as string[] };
  if (params.image !== undefined) {
    if (!isPlainObject(params.image) || typeof params.image.assetId !== 'string') {
      return refuse('image-invalid', 'image must be an object with the assetId the import returned');
    }
    request.image = { assetId: params.image.assetId };
  }
  if (params.spec !== undefined) {
    if (!isPlainObject(params.spec)) return refuse('spec-invalid', 'spec must be an object with the camera fields to set');
    request.spec = params.spec as SpecPatch;
  }
  if (params.action !== undefined) {
    if (typeof params.action !== 'string') return refuse('action-invalid', 'action must be text');
    request.action = params.action;
  }
  return ok(request);
}

function annotateShots(params: Readonly<Record<string, unknown>>, context: StoryboardToolContext): StoryboardResult<AnnotateToolData> {
  const request = annotateRequestOf(params);
  if (!request.ok) return request;
  const planned = planAnnotate(context.state, request.value, context.presentAssets);
  if (!planned.ok) return planned;
  const changed = planned.value.changes.length;
  const same = planned.value.unchanged.length;
  return ok({
    plan: planned.value,
    commands: planned.value.commands,
    summary: `${changed} shot${changed === 1 ? '' : 's'} changed${same > 0 ? `, ${same} already had these values` : ''}.`,
  });
}

/**
 * `shots.annotate`'s handler. It plans and does not apply. A refused plan has no commands, so a batch with
 * one bad shot changes nothing; a passing plan's commands are what the bus applies, in one undo group.
 */
export function annotateShotsTool(params: Readonly<Record<string, unknown>>, context: StoryboardToolContext): Result<AnnotateToolData, CommandError> {
  return toBusResult(annotateShots(params, context));
}
