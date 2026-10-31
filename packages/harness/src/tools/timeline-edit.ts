/**
 * `timeline.edit` — [timeline.md §5.1](../../../../docs/architecture/timeline.md): the agent's proposal of timeline edits, as one `timeline.apply` batch. Built with
 * `primitiveTool`, so its risk (`write-confirm`) and its undo (one compensable group for the whole batch) are the command's, and every call goes through the
 * ordinary gate and the bus's `validate`.
 *
 * **The ops map one-to-one onto `timeline.apply`'s** (`meta`, `move`, `shift`), with the same closed keys; the model never writes an `expect`. Each op's `expect`
 * is read here, at prepare, from the project as the batch's earlier ops leave it, and rides the command to the apply. The bus's `validate` re-reads it at the
 * apply, so a scene that changed between the proposal and the approval refuses the whole batch with a `revision-conflict` and nothing is written.
 *
 * `coherence.setSceneMeta` is not a tool: timing reaches the agent only through here. The `picture-when` op is not offered, because a picture's day pin is the
 * pictures module's to propose.
 */

import {
  DAY_OFFSET_LIMIT,
  STORY_PARTS,
  TIMELINE_LABEL_MAX,
  TIMELINE_MODES,
  TIMELINE_OPS_MAX,
  TIMELINE_SHIFT_NODES_MAX,
  ok,
  projectTimelineBatch,
  projectedSceneMeta,
  shiftFingerprint,
  type CommandError,
  type Result,
  type SceneMetaRecord,
  type TimelineOp,
  type TimelineProjection,
} from '@caotang/bus';
import { effectiveStoryParts } from '@caotang/coherence';
import type { ProjectState } from '@caotang/store';

import { failure } from '../errors.js';
import { CONTAINER, resolveNode, TARGET, type NodeFilter } from '../resolve.js';
import { param } from '../schema.js';
import type { CallParams, PrepareContext } from '../types.js';
import { canonicalJson } from '../util.js';
import { checkParams } from '../validate.js';
import { checkCommand } from './common.js';
import { primitiveTool, type PrimitiveTool } from './primitive.js';
import { coherenceFileOf } from './timeline-model.js';
import { findingsDeltaOf, type DeltaFinding } from './timeline-what-if.js';

type Mapped = Result<Readonly<Record<string, unknown>>, CommandError>;
type Raw = Readonly<Record<string, unknown>>;

/** The most rows and the most findings a card lists; the rest are counted, never dropped silently. */
export const TIMELINE_CARD_ROWS_MAX = 100;
export const TIMELINE_CARD_FINDINGS_MAX = 20;

const CLEARABLE = ['dayOffset', 'durationDays', 'pov', 'storyPart'] as const;

const PATCH_SPEC = param.object(
  'The scene fields to change. Give at least one.',
  {
    dayOffset: param.integer('The scene’s day as a whole number from day 0, negative before it.', { minimum: -DAY_OFFSET_LIMIT, maximum: DAY_OFFSET_LIMIT }),
    durationDays: param.integer('How many days the scene spans, zero or more.', { minimum: 0 }),
    timelineMode: param.choice('How the scene sits in time. "linear" is the ordinary case and clears any other mode.', TIMELINE_MODES),
    pov: param.string('The point-of-view character: a codex entry id or its exact name.', { nonBlank: true }),
    storyPart: param.choice('The part of the story the scene or folder is in. A folder’s part holds for what is inside it, unless a scene names its own.', STORY_PARTS),
    after_add: param.list('Scenes this one must come after: a title or an id each. They are added to the scene’s existing "after" list.', param.string('A scene.', { nonBlank: true }), {
      minItems: 1,
      maxItems: 50,
    }),
    after_remove: param.list('Scenes to take off this scene’s "after" list: a title or an id each.', param.string('A scene.', { nonBlank: true }), {
      minItems: 1,
      maxItems: 50,
    }),
    clear: param.list(
      'Fields to remove from the scene, so it has no value of its own: dayOffset (undated), durationDays, pov, or storyPart (it inherits again).',
      param.choice('A field.', CLEARABLE),
      { minItems: 1, maxItems: CLEARABLE.length, unique: true },
    ),
  },
  [],
);

export const timelineEditParams = param.object(
  'The timeline edits, applied together or not at all.',
  {
    ops: param.list(
      `The edits, in order, at most ${TIMELINE_OPS_MAX}. Each is read against the project as the edits before it leave it.`,
      param.tagged('One timeline edit.', 'op', {
        meta: param.object(
          'Change the timing declarations of one scene or folder.',
          {
            nodeId: param.string('The scene or folder: the nodeId timeline.read returned, or its exact title.', { nonBlank: true }),
            patch: PATCH_SPEC,
          },
          ['nodeId', 'patch'],
        ),
        move: param.object(
          'Move a scene or folder to a place in the binder. Moving one never moves another.',
          {
            nodeId: param.string('The scene or folder to move: an id, or its exact title.', { nonBlank: true }),
            newParentId: param.string('The folder to move it into, or "manuscript": an id, or its exact title.', { nonBlank: true }),
            index: param.integer('Its position among the new parent’s other children, counted from 0 without the moved node.', { minimum: 0 }),
          },
          ['nodeId', 'newParentId', 'index'],
        ),
        shift: param.object(
          'Move the days of many dated scenes by the same amount, as one edit. Every scene named needs a day.',
          {
            delta: param.integer('Days to add to each day, negative for earlier. Not zero.', { minimum: -2 * DAY_OFFSET_LIMIT, maximum: 2 * DAY_OFFSET_LIMIT }),
            nodeIds: param.list('The dated scenes to move: an id or an exact title each.', param.string('A scene.', { nonBlank: true }), {
              minItems: 1,
              maxItems: TIMELINE_SHIFT_NODES_MAX,
              unique: true,
            }),
          },
          ['delta', 'nodeIds'],
        ),
      }),
      { minItems: 1, maxItems: TIMELINE_OPS_MAX },
    ),
    label: param.string(`A short name for the batch, shown on the card and in the activity list, at most ${TIMELINE_LABEL_MAX} characters.`, {
      nonBlank: true,
      maxLength: TIMELINE_LABEL_MAX,
    }),
  },
  ['ops'],
);

function refTo(context: PrepareContext, ref: unknown, filter: NodeFilter, noun: string, target: string): Result<string, CommandError> {
  const node = resolveNode(context.state, String(ref), filter, noun, target);
  return node.ok ? ok(node.value.id) : node;
}

/** A codex entry id, or the one entry an exact name stands for. Anything else passes through for the bus to refuse, listing the entries. */
function povOf(state: ProjectState, ref: string): string {
  const entries = state.manifest.codex ?? [];
  if (entries.some((entry) => entry.id === ref)) return ref;
  const named = entries.filter((entry) => entry.name.trim().toLowerCase() === ref.trim().toLowerCase());
  return named.length === 1 && named[0] !== undefined ? named[0].id : ref;
}

function sceneMetaOf(state: ProjectState): Readonly<Record<string, SceneMetaRecord>> {
  return (state.coherence?.sceneMeta ?? {}) as Readonly<Record<string, SceneMetaRecord>>;
}

/** The declaration a scene holds after the ops so far: the batch's own result where it touched the scene, else the project's. */
function recordIn(state: ProjectState, view: TimelineProjection, id: string): SceneMetaRecord | undefined {
  return view.sceneMeta.has(id) ? view.sceneMeta.get(id) : sceneMetaOf(state)[id];
}

/** The `expect` entry for each field a patch changes, read from what the scene holds now. `null` is "not set", as the bus reads it. */
function metaExpect(record: SceneMetaRecord | undefined, patch: Raw): Record<string, unknown> {
  const expect: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) {
    if (key === 'dayOffset') expect['dayOffset'] = record?.dayOffset ?? null;
    else if (key === 'durationDays') expect['durationDays'] = record?.durationDays ?? null;
    else if (key === 'timelineMode') expect['timelineMode'] = record?.timelineMode === undefined || record.timelineMode === 'linear' ? null : record.timelineMode;
    else if (key === 'pov') expect['pov'] = record?.pov ?? null;
    else if (key === 'storyPart') expect['storyPart'] = record?.storyPart ?? null;
    else expect['after'] = record?.after === undefined ? null : [...record.after];
  }
  return expect;
}

function idsOf(context: PrepareContext, refs: unknown, target: string): Result<string[], CommandError> {
  const ids: string[] = [];
  for (const ref of Array.isArray(refs) ? refs : []) {
    const id = refTo(context, ref, TARGET, 'scene or folder', target);
    if (!id.ok) return id;
    ids.push(id.value);
  }
  return ok(ids);
}

function metaOp(entry: Raw, index: number, context: PrepareContext, view: TimelineProjection): Result<TimelineOp, CommandError> {
  const id = refTo(context, entry['nodeId'], TARGET, 'scene or folder', `ops[${index}].nodeId`);
  if (!id.ok) return id;
  const given = (entry['patch'] ?? {}) as Raw;
  const patch: Record<string, unknown> = {};
  for (const key of ['dayOffset', 'durationDays', 'timelineMode', 'storyPart'] as const) if (given[key] !== undefined) patch[key] = given[key];
  if (typeof given['pov'] === 'string') patch['pov'] = povOf(context.state, given['pov']);
  for (const key of ['after_add', 'after_remove'] as const) {
    if (given[key] === undefined) continue;
    const ids = idsOf(context, given[key], `ops[${index}].patch.${key}`);
    if (!ids.ok) return ids;
    patch[key] = ids.value;
  }
  for (const field of (given['clear'] ?? []) as readonly string[]) {
    if (patch[field] !== undefined) {
      return {
        ok: false,
        error: {
          code: 'invalid-params',
          message: `ops[${index}].patch gives ${field} a value and also clears it`,
          correctiveHint: `use ${field}, or list it in clear, not both`,
          target: `ops[${index}].patch.clear`,
        },
      };
    }
    patch[field] = null;
  }
  return ok({ op: 'meta', nodeId: id.value, patch, expect: metaExpect(recordIn(context.state, view, id.value), patch) } as TimelineOp);
}

function moveOp(entry: Raw, index: number, context: PrepareContext, view: TimelineProjection): Result<TimelineOp, CommandError> {
  const id = refTo(context, entry['nodeId'], TARGET, 'scene or folder', `ops[${index}].nodeId`);
  if (!id.ok) return id;
  const parent = refTo(context, entry['newParentId'], CONTAINER, 'folder or the manuscript', `ops[${index}].newParentId`);
  if (!parent.ok) return parent;
  const node = view.tree.find((candidate) => candidate.id === id.value);
  const siblings = view.tree.filter((candidate) => candidate.parentId === (node?.parentId ?? null)).sort((a, b) => a.order - b.order);
  return ok({
    op: 'move',
    nodeId: id.value,
    newParentId: parent.value,
    index: entry['index'] as number,
    // A parent of 'root' is the bus's own refusal to give: only a fixed root has none, and a fixed root is refused as a move target either way.
    expect: { parentId: node?.parentId ?? 'root', index: siblings.findIndex((candidate) => candidate.id === id.value) },
  });
}

function shiftOp(entry: Raw, index: number, context: PrepareContext, view: TimelineProjection): Result<TimelineOp, CommandError> {
  const ids = idsOf(context, entry['nodeIds'], `ops[${index}].nodeIds`);
  if (!ids.ok) return ids;
  // A scene with no day is not shifted: the bus refuses it by name before it reads the fingerprint, so the placeholder day here is never compared.
  const pairs = ids.value.map((nodeId) => ({ nodeId, dayOffset: recordIn(context.state, view, nodeId)?.dayOffset ?? 0 }));
  return ok({ op: 'shift', delta: entry['delta'] as number, nodeIds: ids.value, expect: { fingerprint: shiftFingerprint(pairs) } });
}

/** The model's ops as `timeline.apply`'s, each with the `expect` the project holds as the ops before it leave it. */
function opsOf(raw: readonly Raw[], context: PrepareContext): Result<TimelineOp[], CommandError> {
  const built: TimelineOp[] = [];
  let view = projectTimelineBatch(context.state, []);
  if (!view.ok) return view;
  for (const [index, entry] of raw.entries()) {
    const made = entry['op'] === 'meta' ? metaOp(entry, index, context, view.value) : entry['op'] === 'move' ? moveOp(entry, index, context, view.value) : shiftOp(entry, index, context, view.value);
    if (!made.ok) return made;
    built.push(made.value);
    view = projectTimelineBatch(context.state, built);
    if (!view.ok) return view;
  }
  return ok(built);
}

/**
 * What the loop stages for a `timeline.edit` step before its card is shown: the ops as `timeline.apply` takes them, each with the `expect` the
 * project held at that moment. `key` binds it to the model's params, so an edited card is staged again and never approved on old values.
 */
export interface TimelineProposal {
  readonly kind: 'timeline.edit';
  readonly key: string;
  readonly ops: readonly TimelineOp[];
}

/** The model's params as one string: what a staged proposal answers for. */
function keyOf(params: CallParams): string {
  return canonicalJson({ ops: params['ops'] ?? [], label: params['label'] ?? null });
}

export function asTimelineProposal(value: unknown): TimelineProposal | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as { readonly kind?: unknown; readonly key?: unknown; readonly ops?: unknown };
  if (candidate.kind !== 'timeline.edit' || typeof candidate.key !== 'string' || !Array.isArray(candidate.ops)) return undefined;
  return value as TimelineProposal;
}

function toCommand(params: CallParams, context: PrepareContext): Mapped {
  const label = typeof params['label'] === 'string' ? { label: params['label'] } : {};
  if (context.proposal !== undefined) {
    // The values the card was shown against ride to the approval. They are not read again, so a scene that changed since is the bus's
    // `revision-conflict`, and the batch is refused whole.
    const staged = asTimelineProposal(context.proposal);
    if (staged === undefined) {
      return failure({ code: 'invalid-params', message: 'the staged timeline edit is not one this tool made', correctiveHint: 'propose the timeline edit again' });
    }
    if (staged.key !== keyOf(params)) {
      return failure({
        code: 'invalid-params',
        message: 'the staged timeline edit is for different parameters than this step has, so it was not applied',
        correctiveHint: 'propose the timeline edit again so the values it checks are read for the edited step',
        target: 'ops',
      });
    }
    return ok({ ops: staged.ops, ...label });
  }
  const ops = opsOf((params['ops'] ?? []) as readonly Raw[], context);
  if (!ops.ok) return ops;
  return ok({ ops: ops.value, ...label });
}

/**
 * The batch as it stands now, staged for a card: its ops with their `expect` values, checked by the bus's own `validate` as a call is, so a
 * batch that is refused now is refused before its card. Pure, and no model is asked.
 */
export function stageTimelineEdit(params: CallParams, context: PrepareContext): Result<TimelineProposal, CommandError> {
  const checked = checkParams('timeline.edit', timelineEditParams, params);
  if (!checked.ok) return checked as Result<TimelineProposal, CommandError>;
  const own: PrepareContext = { ...context };
  delete (own as { proposal?: unknown }).proposal;
  const mapped = toCommand(checked.value, own);
  if (!mapped.ok) return mapped as Result<TimelineProposal, CommandError>;
  const valid = checkCommand(own, 'timeline.apply', mapped.value);
  if (!valid.ok) return failure(valid.error) as Result<TimelineProposal, CommandError>;
  return ok({ kind: 'timeline.edit', key: keyOf(checked.value), ops: mapped.value['ops'] as readonly TimelineOp[] });
}

/* ------------------------------------------------------------------ *
 * The card
 * ------------------------------------------------------------------ */

export interface TimelineCardRow {
  readonly node: string;
  readonly part: string;
  readonly field: string;
  readonly before: string;
  readonly after: string;
}

/** The card of a 	imeline.edit step as its preview carries it: every changed field, and the findings the batch would resolve and raise. */
export interface TimelineCard {
  readonly kind: 'timeline-edit';
  readonly rows: readonly TimelineCardRow[];
  /** Rows past TIMELINE_CARD_ROWS_MAX, counted and not listed. */
  readonly omittedRows?: number;
  readonly findingsDelta: {
    readonly resolved: readonly DeltaFinding[];
    readonly added: readonly DeltaFinding[];
    /** The whole counts, which exceed the lists when they were cut at TIMELINE_CARD_FINDINGS_MAX. */
    readonly resolvedCount: number;
    readonly addedCount: number;
  };
}

const noun = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

function declaredFields(state: ProjectState) {
  const entryName = (id: string): string => state.manifest.codex?.find((entry) => entry.id === id)?.name ?? id;
  const titleOf = (id: string): string => state.manifest.tree.find((node) => node.id === id)?.title ?? id;
  return {
    day: (record: SceneMetaRecord | undefined): string => (record?.dayOffset === undefined ? 'not set' : `day ${record.dayOffset}`),
    duration: (record: SceneMetaRecord | undefined): string => (record?.durationDays === undefined ? 'not set' : noun(record.durationDays, 'day', 'days')),
    mode: (record: SceneMetaRecord | undefined): string => record?.timelineMode ?? 'linear',
    pov: (record: SceneMetaRecord | undefined): string => (record?.pov === undefined ? 'not set' : entryName(record.pov)),
    part: (record: SceneMetaRecord | undefined): string => record?.storyPart ?? 'inherited',
    after: (record: SceneMetaRecord | undefined): string => (record?.after === undefined || record.after.length === 0 ? 'none' : record.after.map((id) => `‘${titleOf(id)}’`).join(', ')),
  };
}

/** The rows a card shows for a batch: one per field a scene's declaration changes and one per move, in the order the ops first touched each node. */
function rowsOf(state: ProjectState, ops: readonly TimelineOp[], projection: TimelineProjection): TimelineCardRow[] {
  const parts = effectiveStoryParts(projection.tree, projectedSceneMeta(sceneMetaOf(state), projection));
  const titleOf = (id: string): string => state.manifest.tree.find((node) => node.id === id)?.title ?? id;
  const show = declaredFields(state);
  const byNode = new Map<string, TimelineCardRow[]>();
  const put = (nodeId: string, field: string, before: string, after: string): void => {
    const rows = byNode.get(nodeId) ?? [];
    rows.push({ node: titleOf(nodeId), part: parts.get(nodeId) ?? 'main', field, before, after });
    byNode.set(nodeId, rows);
  };

  for (const change of projection.metaChanges) {
    const fields = [
      ['day', show.day],
      ['duration', show.duration],
      ['mode', show.mode],
      ['POV', show.pov],
      ['story part', show.part],
      ['after', show.after],
    ] as const;
    for (const [field, text] of fields) {
      const before = text(change.before);
      const after = text(change.after);
      if (before !== after) put(change.nodeId, field, before, after);
    }
  }

  const placeOf = (parentId: string, at: number): string => `position ${at} under ‘${titleOf(parentId)}’`;
  for (const op of ops) {
    if (op.op !== 'move') continue;
    const into = projection.tree.filter((node) => node.parentId === op.newParentId && node.id !== op.nodeId).length;
    put(op.nodeId, 'position', placeOf(op.expect.parentId, op.expect.index), placeOf(op.newParentId, Math.min(op.index, into)));
  }

  return projection.touchedIds.flatMap((id) => byNode.get(id) ?? []);
}

function cardOf(command: CallParams, context: PrepareContext): TimelineCard | undefined {
  const ops = command['ops'] as readonly TimelineOp[];
  const projection = projectTimelineBatch(context.state, ops);
  if (!projection.ok) return undefined;
  const rows = rowsOf(context.state, ops, projection.value);
  const delta = findingsDeltaOf(context.state, coherenceFileOf(context.state), projection.value);
  return {
    kind: 'timeline-edit',
    rows: rows.slice(0, TIMELINE_CARD_ROWS_MAX),
    ...(rows.length > TIMELINE_CARD_ROWS_MAX ? { omittedRows: rows.length - TIMELINE_CARD_ROWS_MAX } : {}),
    findingsDelta: {
      resolved: delta.resolved.slice(0, TIMELINE_CARD_FINDINGS_MAX),
      added: delta.added.slice(0, TIMELINE_CARD_FINDINGS_MAX),
      resolvedCount: delta.resolved.length,
      addedCount: delta.added.length,
    },
  };
}

function summaryOf(counts: Readonly<Record<string, number>>, label: unknown): string {
  const words: [string, string, string][] = [
    ['days', 'day', 'days'],
    ['durations', 'duration', 'durations'],
    ['modes', 'mode', 'modes'],
    ['povs', 'POV', 'POVs'],
    ['parts', 'part', 'parts'],
    ['orderings', 'ordering', 'orderings'],
    ['moves', 'move', 'moves'],
    ['shifts', 'shift', 'shifts'],
  ];
  const parts = words.filter(([key]) => (counts[key] ?? 0) > 0).map(([key, one, many]) => noun(counts[key] ?? 0, one, many));
  const total = counts['total'] ?? 0;
  const named = typeof label === 'string' && label.trim() !== '' ? ` “${label.trim()}”` : '';
  return `applied${named} ${noun(total, 'timeline change', 'timeline changes')}${parts.length === 0 ? '' : ` (${parts.join(', ')})`}`;
}

export const timelineEdit: PrimitiveTool = primitiveTool({
  tool: 'timeline.edit',
  command: 'timeline.apply',
  description: `Propose edits to the story timeline as one batch of at most ${TIMELINE_OPS_MAX} ops, applied together or not at all: change a scene's or folder's day, duration, mode, point of view or story part (prologue, main or epilogue), add or remove an "after" link, move a scene to another place in the binder, or shift many dated scenes by the same days. Read the current values with timeline.read first and name scenes by the nodeId it returns; you never send the old values, they are read for you and checked again when the writer approves, so a scene that changed in between refuses the whole batch and nothing is written. Moving or dating one scene never moves another: propose each change. The card lists every row as before and after, with the part, and the findings the batch would resolve and raise. Undo restores the whole batch in one step.`,
  descriptionVersion: 1,
  keywords: ['timeline', 'day', 'chronology', 'schedule', 'prologue', 'epilogue', 'flashback', 'shift', 'story part', 'date'],
  response_token_cap: 1000,
  params: timelineEditParams,
  toCommand,
  preview: cardOf,
  report: (command, outcome) => {
    const result = (outcome.result ?? {}) as { readonly changes?: number; readonly counts?: Readonly<Record<string, number>>; readonly moved?: readonly string[]; readonly declarations?: readonly string[] };
    const counts = result.counts ?? {};
    return {
      data: { changes: result.changes ?? 0, counts, moved: result.moved ?? [], declared: result.declarations ?? [] },
      summary: summaryOf(counts, command['label']),
    };
  },
});
