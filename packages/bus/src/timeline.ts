/**
 * The timeline batch ([timeline.md §4.3](docs/architecture/timeline.md)): the op shapes `timeline.apply` takes, their shape check, and the pure
 * projection that validates a whole batch.
 *
 * **One projection serves validate, preview, the what-if run and the store's apply.** `projectTimelineBatch` applies the ops in order to a
 * private copy of the tree (parents, every sibling's `order`) and of the scene declarations, so op N is validated against what ops 1 to N−1 left.
 * It never mutates its input and never reads a clock, so the descriptor's `validate`, the tray and the apply all read the same answer, and the
 * store installs that answer only after every op has passed.
 *
 * **The sibling-order algorithm is here and the store's `siblingOrderAt` delegates to it.** The harness's `projectedSnapshot` changes a parent without
 * establishing a sibling order and carries no scene declarations, and a second copy of the gap-encoding would drift. A move's index, its clamping, the
 * exclusion of the moving node and the renormalisation of a crowded sibling set are `siblingOrderInTree`, once.
 */

import { isFixedRootId, type ValidationSnapshot } from './command.js';
import {
  DAY_OFFSET_LIMIT,
  applySceneMetaPatch,
  isDayOffset,
  isEmptySceneMeta,
  type DeclaredStoryPart,
  type SceneMetaContext,
  type SceneMetaRecord,
  type ScenePatch,
  type TimelineModeName,
} from './coherence.js';
import { HINT_READ_TREE, isRecord, requireNonBlankString, showValue } from './params.js';
import { err, ok, type CommandError, type Result } from './result.js';

/* ------------------------------------------------------------------ *
 * Sibling order — the canonical gap-encoding (project-format §2)
 * ------------------------------------------------------------------ */

/** project-format §2: renormalize a sibling set only when one of its orders exceeds this. */
export const RENORMALIZE_THRESHOLD = 1_000_000;

/** What the sibling-order algorithm reads and writes of a node. The store's `TreeNode` and the projection's copy both satisfy it. */
export interface OrderedTreeNode {
  readonly id: string;
  parentId: string | null;
  order: number;
}

/** Compacts a sibling set to 10, 20, 30 … in its current order. Ties keep their order in `tree`, which is what the sort's stability gives. */
export function renormalizeTreeSiblings(tree: readonly OrderedTreeNode[], parentId: string | null): void {
  const siblings = tree.filter((node) => node.parentId === parentId).sort((a, b) => a.order - b.order);
  siblings.forEach((node, position) => {
    node.order = (position + 1) * 10;
  });
}

/**
 * The `order` that puts a node at `index` among `parentId`'s children, with all three clauses of project-format §2: an empty set is 10, the end is
 * `max + 10` (renormalizing first when a sibling has passed {@link RENORMALIZE_THRESHOLD}), and between two nodes is the midpoint of the gap,
 * renormalizing the set first when the gap holds no integer. `movingId` is left out of the set it is moving into.
 *
 * A renormalisation **rewrites the orders of `tree`'s nodes in place**, the moving node's included when it is already a child of `parentId`, and the
 * caller sets the moving node's order from the return value afterwards. The projection and the store's apply therefore leave the same orders.
 */
export function siblingOrderInTree(tree: readonly OrderedTreeNode[], parentId: string, index: number, movingId?: string): number {
  const ordered = (): OrderedTreeNode[] =>
    tree.filter((node) => node.parentId === parentId && node.id !== movingId).sort((a, b) => a.order - b.order);

  let siblings = ordered();
  if (siblings.length === 0) return 10;

  if (index >= siblings.length) {
    const last = siblings[siblings.length - 1]!;
    if (last.order < RENORMALIZE_THRESHOLD) return last.order + 10;
    renormalizeTreeSiblings(tree, parentId);
    siblings = ordered();
    return siblings[siblings.length - 1]!.order + 10;
  }

  const gap = (list: OrderedTreeNode[]): { low: number; high: number } => ({
    low: index === 0 ? 0 : list[index - 1]!.order,
    high: list[index]!.order,
  });

  const first = gap(siblings);
  if (first.high - first.low >= 2) return first.low + Math.floor((first.high - first.low) / 2);
  renormalizeTreeSiblings(tree, parentId);
  siblings = ordered();
  const compacted = gap(siblings);
  return compacted.low + Math.floor((compacted.high - compacted.low) / 2);
}

/* ------------------------------------------------------------------ *
 * The op shapes
 * ------------------------------------------------------------------ */

/** The most ops one `timeline.apply` takes. */
export const TIMELINE_OPS_MAX = 200;

/** The most scenes one `shift` op moves. A series is one op, so this is a bound on the op's size and not on the batch. */
export const TIMELINE_SHIFT_NODES_MAX = 5000;

/** The `patch` keys of a `meta` op: the scene fields a timeline gesture changes, a closed subset of the scene patch. */
export const TIMELINE_META_PATCH_KEYS = ['dayOffset', 'durationDays', 'timelineMode', 'pov', 'storyPart', 'after_add', 'after_remove'] as const;

/** The `expect` keys of a `meta` op. `after` is the whole before-array and guards both `after_add` and `after_remove`. */
export const TIMELINE_META_EXPECT_KEYS = ['dayOffset', 'durationDays', 'timelineMode', 'pov', 'storyPart', 'after'] as const;

export type TimelineMetaPatch = {
  dayOffset?: number | null;
  durationDays?: number | null;
  timelineMode?: TimelineModeName;
  pov?: string | null;
  storyPart?: DeclaredStoryPart | null;
  after_add?: string[];
  after_remove?: string[];
};

/** The values the plan read. `null` means the field was absent; an `expect` entry the patch needs but does not carry is refused, not read as "no opinion". */
export type TimelineMetaExpect = {
  dayOffset?: number | null;
  durationDays?: number | null;
  timelineMode?: TimelineModeName | null;
  pov?: string | null;
  storyPart?: DeclaredStoryPart | null;
  after?: string[] | null;
};

/** A picture's day pin (timeline.md §9.1). */
export type TimelinePictureWhen = { dayOffset?: number; label?: string } | null;

export type TimelineOp =
  | { op: 'meta'; nodeId: string; patch: TimelineMetaPatch; expect: TimelineMetaExpect }
  | { op: 'move'; nodeId: string; newParentId: string; index: number; expect: { parentId: string; index: number } }
  | { op: 'shift'; delta: number; nodeIds: string[]; expect: { fingerprint: string } }
  | { op: 'picture-when'; linkId: string; when: TimelinePictureWhen; expect: { when: TimelinePictureWhen } };

export type TimelineApplyParams = { ops: TimelineOp[]; label?: string };

/** The longest `label` a batch carries, in characters. */
export const TIMELINE_LABEL_MAX = 200;

const OP_NAMES = ['meta', 'move', 'shift', 'picture-when'] as const;
const PATCH_FIELD_OF_EXPECT: Readonly<Record<(typeof TIMELINE_META_PATCH_KEYS)[number], (typeof TIMELINE_META_EXPECT_KEYS)[number]>> = {
  dayOffset: 'dayOffset',
  durationDays: 'durationDays',
  timelineMode: 'timelineMode',
  pov: 'pov',
  storyPart: 'storyPart',
  after_add: 'after',
  after_remove: 'after',
};

/**
 * What a `shift` op's `expect.fingerprint` is made of: the scenes' `(nodeId, dayOffset)` pairs in canonical order (by node id, code unit
 * order), hashed to a short string. The tray computes it at proposal time with this same function, so the check cannot disagree with it. A hash and
 * not the list, so a 5,000-scene shift carries a few bytes and not its own before-image.
 */
export function shiftFingerprint(pairs: readonly { readonly nodeId: string; readonly dayOffset: number }[]): string {
  const sorted = [...pairs].sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
  // cyrb53: two 32-bit lanes folded to 53 bits. Not a security hash; a stale check needs only to change when a pair does.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  const feed = (text: string): void => {
    for (let at = 0; at < text.length; at += 1) {
      const code = text.charCodeAt(at);
      h1 = Math.imul(h1 ^ code, 2654435761);
      h2 = Math.imul(h2 ^ code, 1597334677);
    }
  };
  for (const pair of sorted) {
    feed(pair.nodeId);
    feed(`\u0000${pair.dayOffset}\n`);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const folded = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return `tl1-${sorted.length}-${folded.toString(16)}`;
}

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

function opError(code: CommandError['code'], index: number, message: string, correctiveHint?: string, field?: string, details?: Record<string, unknown>): Result<never, CommandError> {
  return err({
    code,
    message: `ops[${index}]: ${message}`,
    target: field === undefined ? `ops[${index}]` : `ops[${index}].${field}`,
    ...(correctiveHint === undefined ? {} : { correctiveHint }),
    details: { opIndex: index, ...(details ?? {}) },
  });
}

const badOp = (index: number, message: string, hint?: string, field?: string): Result<never, CommandError> =>
  opError('invalid-params', index, message, hint, field);

/* ------------------------------------------------------------------ *
 * The shape check
 * ------------------------------------------------------------------ */

function closedKeys(record: Record<string, unknown>, allowed: readonly string[], index: number, where: string): Result<true, CommandError> {
  const extra = Object.keys(record).filter((key) => !allowed.includes(key));
  if (extra.length === 0) return ok(true);
  return badOp(index, `${where} takes no ${extra.map((key) => `"${key}"`).join(', ')}`, `${where} accepts only: ${allowed.join(', ')}`, where === 'the op' ? extra[0] : `${where}.${extra[0]}`);
}

function textField(record: Record<string, unknown>, key: string, index: number, maxChars = 64): Result<string, CommandError> {
  const value = requireNonBlankString(record, key, { maxChars });
  if (value.ok) return value;
  return badOp(index, value.error.message.replace(/^params\./u, ''), value.error.correctiveHint, key);
}

function wholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function idList(value: unknown, index: number, field: string): Result<string[], CommandError> {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || id.trim() === '')) {
    return badOp(index, `${field} must be a list of ids, each a non-blank string, got ${showValue(value)}`, undefined, field);
  }
  return ok([...(value as string[])]);
}

function parsePatch(raw: unknown, index: number): Result<TimelineMetaPatch, CommandError> {
  if (!isRecord(raw)) return badOp(index, `patch must be an object of scene fields, got ${showValue(raw)}`, 'pass patch as an object with the fields to change', 'patch');
  const closed = closedKeys(raw, TIMELINE_META_PATCH_KEYS, index, 'patch');
  if (!closed.ok) return closed;
  const patch: TimelineMetaPatch = {};
  for (const key of ['dayOffset', 'durationDays'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (value !== null && typeof value !== 'number') return badOp(index, `patch.${key} must be a number, or null to clear it, got ${showValue(value)}`, undefined, `patch.${key}`);
    patch[key] = value;
  }
  for (const key of ['pov', 'storyPart'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (value !== null && typeof value !== 'string') return badOp(index, `patch.${key} must be a string, or null to clear it, got ${showValue(value)}`, undefined, `patch.${key}`);
    (patch as Record<string, unknown>)[key] = value;
  }
  if (raw['timelineMode'] !== undefined) {
    if (typeof raw['timelineMode'] !== 'string') return badOp(index, `patch.timelineMode must be a timeline mode, got ${showValue(raw['timelineMode'])}`, undefined, 'patch.timelineMode');
    patch.timelineMode = raw['timelineMode'] as TimelineModeName;
  }
  for (const key of ['after_add', 'after_remove'] as const) {
    if (raw[key] === undefined) continue;
    const list = idList(raw[key], index, `patch.${key}`);
    if (!list.ok) return list;
    patch[key] = list.value;
  }
  if (Object.keys(patch).length === 0) return badOp(index, 'patch names no field to change', `a meta op patches at least one of ${TIMELINE_META_PATCH_KEYS.join(', ')}`, 'patch');
  return ok(patch);
}

function parseMetaExpect(raw: unknown, patch: TimelineMetaPatch, index: number): Result<TimelineMetaExpect, CommandError> {
  if (!isRecord(raw)) return badOp(index, `expect must be an object of the values the plan read, got ${showValue(raw)}`, 'pass expect with every field the patch changes', 'expect');
  const closed = closedKeys(raw, TIMELINE_META_EXPECT_KEYS, index, 'expect');
  if (!closed.ok) return closed;
  const expect: TimelineMetaExpect = {};
  for (const key of ['dayOffset', 'durationDays'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (value !== null && typeof value !== 'number') return badOp(index, `expect.${key} must be the number the plan read, or null when it was not set, got ${showValue(value)}`, undefined, `expect.${key}`);
    expect[key] = value;
  }
  for (const key of ['pov', 'storyPart', 'timelineMode'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (value !== null && typeof value !== 'string') return badOp(index, `expect.${key} must be the value the plan read, or null when it was not set, got ${showValue(value)}`, undefined, `expect.${key}`);
    (expect as Record<string, unknown>)[key] = value;
  }
  if (raw['after'] !== undefined) {
    if (raw['after'] !== null) {
      const list = idList(raw['after'], index, 'expect.after');
      if (!list.ok) return list;
      expect.after = list.value;
    } else expect.after = null;
  }
  for (const key of Object.keys(patch) as (keyof TimelineMetaPatch)[]) {
    const needed = PATCH_FIELD_OF_EXPECT[key];
    if (expect[needed] === undefined) {
      return badOp(
        index,
        `expect.${needed} is missing, and the patch changes ${key}`,
        needed === 'after'
          ? 'carry the complete array the scene had before (null when it had none), so a stale list cannot be approved'
          : `carry the value the plan read for ${needed} (null when it was not set), so a stale row cannot be approved`,
        `expect.${needed}`,
      );
    }
  }
  return ok(expect);
}

function parseWhen(raw: unknown, index: number, field: string): Result<TimelinePictureWhen, CommandError> {
  if (raw === null) return ok(null);
  if (!isRecord(raw)) return badOp(index, `${field} must be {dayOffset?, label?} or null, got ${showValue(raw)}`, undefined, field);
  const closed = closedKeys(raw, ['dayOffset', 'label'], index, field);
  if (!closed.ok) return closed;
  const when: { dayOffset?: number; label?: string } = {};
  if (raw['dayOffset'] !== undefined) {
    if (!isDayOffset(raw['dayOffset'])) return badOp(index, `${field}.dayOffset must be a whole number of days between −${DAY_OFFSET_LIMIT.toLocaleString('en-US')} and ${DAY_OFFSET_LIMIT.toLocaleString('en-US')}`, undefined, `${field}.dayOffset`);
    when.dayOffset = raw['dayOffset'];
  }
  if (raw['label'] !== undefined) {
    if (typeof raw['label'] !== 'string' || [...raw['label']].length > 200) return badOp(index, `${field}.label must be text of at most 200 characters`, undefined, `${field}.label`);
    when.label = raw['label'];
  }
  return ok(when);
}

function parseOp(entry: unknown, index: number): Result<TimelineOp, CommandError> {
  if (!isRecord(entry)) return badOp(index, `an op must be an object, got ${showValue(entry)}`, `each op is one of ${OP_NAMES.join(', ')}`);
  const name = entry['op'];
  if (typeof name !== 'string' || !(OP_NAMES as readonly string[]).includes(name)) {
    return badOp(index, `op must be one of ${OP_NAMES.join(', ')}, got ${showValue(name)}`, undefined, 'op');
  }
  if (name === 'meta') {
    const closed = closedKeys(entry, ['op', 'nodeId', 'patch', 'expect'], index, 'the op');
    if (!closed.ok) return closed;
    const nodeId = textField(entry, 'nodeId', index);
    if (!nodeId.ok) return nodeId;
    const patch = parsePatch(entry['patch'], index);
    if (!patch.ok) return patch;
    const expect = parseMetaExpect(entry['expect'], patch.value, index);
    if (!expect.ok) return expect;
    return ok({ op: 'meta', nodeId: nodeId.value, patch: patch.value, expect: expect.value });
  }
  if (name === 'move') {
    const closed = closedKeys(entry, ['op', 'nodeId', 'newParentId', 'index', 'expect'], index, 'the op');
    if (!closed.ok) return closed;
    const nodeId = textField(entry, 'nodeId', index);
    if (!nodeId.ok) return nodeId;
    const newParentId = textField(entry, 'newParentId', index);
    if (!newParentId.ok) return newParentId;
    const at = entry['index'];
    if (!wholeNumber(at) || at < 0) return badOp(index, `index must be a whole number, zero or more, got ${showValue(at)}`, 'index counts the new parent’s children without the moved node', 'index');
    const expect = entry['expect'];
    if (!isRecord(expect)) return badOp(index, `expect must be {parentId, index}, got ${showValue(expect)}`, 'carry where the node was when the move was proposed', 'expect');
    const expectClosed = closedKeys(expect, ['parentId', 'index'], index, 'expect');
    if (!expectClosed.ok) return expectClosed;
    const parentId = textField(expect, 'parentId', index);
    if (!parentId.ok) return parentId;
    if (!wholeNumber(expect['index']) || expect['index'] < 0) return badOp(index, `expect.index must be a whole number, zero or more, got ${showValue(expect['index'])}`, undefined, 'expect.index');
    return ok({ op: 'move', nodeId: nodeId.value, newParentId: newParentId.value, index: at, expect: { parentId: parentId.value, index: expect['index'] } });
  }
  if (name === 'shift') {
    const closed = closedKeys(entry, ['op', 'delta', 'nodeIds', 'expect'], index, 'the op');
    if (!closed.ok) return closed;
    const delta = entry['delta'];
    if (!wholeNumber(delta) || delta === 0) return badOp(index, `delta must be a whole number of days other than zero, got ${showValue(delta)}`, 'a shift of zero days changes nothing', 'delta');
    if (Math.abs(delta) > 2 * DAY_OFFSET_LIMIT) return badOp(index, `delta ${delta} is further than any day offset can move`, undefined, 'delta');
    const raw = entry['nodeIds'];
    if (Array.isArray(raw) && raw.length > TIMELINE_SHIFT_NODES_MAX) {
      return opError('limit-exceeded', index, `nodeIds has ${raw.length} entries, limit ${TIMELINE_SHIFT_NODES_MAX}`, `shift at most ${TIMELINE_SHIFT_NODES_MAX} scenes in one op`, 'nodeIds');
    }
    const nodeIds = idList(raw, index, 'nodeIds');
    if (!nodeIds.ok) return nodeIds;
    if (nodeIds.value.length === 0) return badOp(index, 'nodeIds names no scene to shift', 'name the dated scenes the shift moves', 'nodeIds');
    if (new Set(nodeIds.value).size !== nodeIds.value.length) return badOp(index, 'nodeIds names a scene more than once', 'give each scene once', 'nodeIds');
    const expect = entry['expect'];
    if (!isRecord(expect)) return badOp(index, `expect must be {fingerprint}, got ${showValue(expect)}`, 'carry the fingerprint of the scenes’ days, from shiftFingerprint', 'expect');
    const expectClosed = closedKeys(expect, ['fingerprint'], index, 'expect');
    if (!expectClosed.ok) return expectClosed;
    const fingerprint = textField(expect, 'fingerprint', index);
    if (!fingerprint.ok) return fingerprint;
    return ok({ op: 'shift', delta, nodeIds: nodeIds.value, expect: { fingerprint: fingerprint.value } });
  }
  const closed = closedKeys(entry, ['op', 'linkId', 'when', 'expect'], index, 'the op');
  if (!closed.ok) return closed;
  const linkId = textField(entry, 'linkId', index);
  if (!linkId.ok) return linkId;
  const when = parseWhen(entry['when'], index, 'when');
  if (!when.ok) return when;
  const expect = entry['expect'];
  if (!isRecord(expect)) return badOp(index, `expect must be {when}, got ${showValue(expect)}`, undefined, 'expect');
  const expectClosed = closedKeys(expect, ['when'], index, 'expect');
  if (!expectClosed.ok) return expectClosed;
  if (!('when' in expect)) return badOp(index, 'expect.when is missing', 'carry the pin the plan read, or null when the link had none', 'expect.when');
  const expectedWhen = parseWhen(expect['when'], index, 'expect.when');
  if (!expectedWhen.ok) return expectedWhen;
  return ok({ op: 'picture-when', linkId: linkId.value, when: when.value, expect: { when: expectedWhen.value } });
}

/** The ops of a batch, shape-checked: closed keys, 1 to {@link TIMELINE_OPS_MAX} ops, every `expect` entry a patch needs. State is not read. */
export function parseTimelineOps(raw: unknown): Result<TimelineOp[], CommandError> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return err({
      code: 'invalid-params',
      message: `params.ops must be a non-empty array of timeline ops, got ${showValue(raw)}`,
      correctiveHint: 'pass one op for each change the batch makes',
      target: 'ops',
    });
  }
  if (raw.length > TIMELINE_OPS_MAX) {
    return err({
      code: 'limit-exceeded',
      message: `params.ops has ${raw.length} entries, limit ${TIMELINE_OPS_MAX}`,
      correctiveHint: `send at most ${TIMELINE_OPS_MAX} ops; a shift moves any number of scenes as one op`,
      target: 'ops',
    });
  }
  const ops: TimelineOp[] = [];
  for (const [index, entry] of raw.entries()) {
    const parsed = parseOp(entry, index);
    if (!parsed.ok) return parsed;
    ops.push(parsed.value);
  }
  return ok(ops);
}

/* ------------------------------------------------------------------ *
 * The projection
 * ------------------------------------------------------------------ */

/** A node's place in the tree, as a move changes it. */
export interface TimelineNodePlace {
  readonly parentId: string | null;
  readonly order: number;
}

/** What the batch counts: one per field a meta op changes, one per move, one per shift. `shiftedScenes` is the scenes the shifts moved, counted per shift. */
export interface TimelineBatchCounts {
  readonly total: number;
  readonly days: number;
  readonly durations: number;
  readonly modes: number;
  readonly povs: number;
  readonly parts: number;
  readonly orderings: number;
  readonly moves: number;
  readonly shifts: number;
  readonly shiftedScenes: number;
  /** The `picture-when` ops that moved a picture's day pin (§9.1). */
  readonly pins: number;
}

export interface TimelineProjection {
  /** Every tree node after the batch, in the tree's own array order, with the parent and order the moves left. */
  readonly tree: readonly (OrderedTreeNode & { readonly type: string; readonly title: string })[];
  /** The scene declarations of every node a meta or shift op touched, as the batch leaves them. `undefined` is "no declarations". */
  readonly sceneMeta: ReadonlyMap<string, SceneMetaRecord | undefined>;
  /** The touched declarations whose result differs from what they were, each with its before-image. The records are the snapshot's own and are never mutated. */
  readonly metaChanges: readonly { readonly nodeId: string; readonly before: SceneMetaRecord | undefined; readonly after: SceneMetaRecord | undefined }[];
  /** Every node whose parent or order differs after the batch: the moved nodes and the siblings a renormalisation rewrote. */
  readonly nodeChanges: readonly { readonly nodeId: string; readonly before: TimelineNodePlace; readonly after: TimelineNodePlace }[];
  /**
   * The picture placements whose day pin the batch moves (timeline.md §9.1), each with the pin it held. `undefined` is "no pin", so an
   * `after` of `undefined` is a cleared pin. A `picture-when` op whose value the link already holds is accepted and appears here not at all.
   */
  readonly linkChanges: readonly { readonly linkId: string; readonly before: TimelinePictureWhen; readonly after: TimelinePictureWhen }[];
  readonly counts: TimelineBatchCounts;
  /** The ops' scene or node ids, in first-touch order, for the activity row. */
  readonly touchedIds: readonly string[];
  /** The shift ops, each with the scene it moved first and its size, for a one-op summary. */
  readonly shifts: readonly { readonly delta: number; readonly count: number }[];
  /** The `storyPart` meta ops, in order, for a one-op summary ("‘Coda’ is now the epilogue"). */
  readonly partChanges: readonly { readonly nodeId: string; readonly part: DeclaredStoryPart | null }[];
}

const FIELD_WORDS = {
  dayOffset: 'day',
  durationDays: 'duration',
  timelineMode: 'mode',
  pov: 'POV',
  storyPart: 'story part',
  after: 'order links',
} as const;

function metaOfRecord(map: Readonly<Record<string, SceneMetaRecord>> | undefined, id: string): SceneMetaRecord | undefined {
  return map !== undefined && Object.prototype.hasOwnProperty.call(map, id) ? map[id] : undefined;
}

function sameList(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((value, at) => value === b[at]);
}

function describeValue(value: unknown, titleOf: (id: string) => string): string {
  if (value === null || value === undefined) return 'not set';
  if (Array.isArray(value)) return value.length === 0 ? 'empty' : value.map((id) => `‘${titleOf(String(id))}’`).join(', ');
  return String(value);
}

/**
 * Validates a whole batch against the snapshot and returns what it leaves. The first op that fails ends the projection, because every later op
 * is read against the ones before it: the error names the op (`ops[i]`, `details.opIndex`). A stale `expect` is a `revision-conflict` naming the scene
 * and the field; every other refusal is `invalid-params` or `not-found`. The snapshot is read, never written.
 */
export function projectTimelineBatch(snapshot: ValidationSnapshot, ops: readonly TimelineOp[]): Result<TimelineProjection, CommandError> {
  const rank = new Map<string | null, number>();
  const tree = snapshot.manifest.tree.map((node) => {
    const position = (rank.get(node.parentId) ?? 0) + 1;
    rank.set(node.parentId, position);
    // A snapshot that carries no orders (a test fixture) reads each sibling set in tree order.
    return { id: node.id, parentId: node.parentId, type: node.type, kind: node.kind, title: node.title, order: node.order ?? position * 10 };
  });
  const byId = new Map(tree.map((node) => [node.id, node]));
  const original = new Map(tree.map((node) => [node.id, { parentId: node.parentId, order: node.order }]));
  const titleOf = (id: string): string => byId.get(id)?.title ?? id;

  const baseMeta = snapshot.coherence?.sceneMeta;
  const first = new Map<string, SceneMetaRecord | undefined>();
  const current = new Map<string, SceneMetaRecord | undefined>();
  const metaOf = (id: string): SceneMetaRecord | undefined => (current.has(id) ? current.get(id) : metaOfRecord(baseMeta, id));
  const putMeta = (id: string, record: SceneMetaRecord | undefined): void => {
    if (!first.has(id)) first.set(id, metaOfRecord(baseMeta, id));
    current.set(id, record !== undefined && isEmptySceneMeta(record) ? undefined : record);
  };

  const documentIds = new Set(tree.filter((node) => node.type === 'document').map((node) => node.id));
  const context: SceneMetaContext = {
    entries: snapshot.manifest.codex ?? [],
    facts: snapshot.coherence?.knowledge ?? [],
    documentIds,
  };

  // The picture pins the batch moves (timeline.md §9.1): the link's `when` as the snapshot holds it, and as the batch leaves it. The
  // links are read here and never written — the apply owns the manifest, as it does for every other op.
  const pinsBefore = new Map<string, TimelinePictureWhen>();
  const pinsAfter = new Map<string, TimelinePictureWhen>();
  for (const link of snapshot.manifest.assetLinks ?? []) pinsBefore.set(link.id, link.when ?? null);
  const pinOf = (linkId: string): TimelinePictureWhen => (pinsAfter.has(linkId) ? pinsAfter.get(linkId)! : (pinsBefore.get(linkId) ?? null));

  const touched: string[] = [];
  const seen = new Set<string>();
  const touch = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      touched.push(id);
    }
  };
  const counts = { days: 0, durations: 0, modes: 0, povs: 0, parts: 0, orderings: 0, moves: 0, shifts: 0, shiftedScenes: 0, pins: 0 };
  const shifts: { delta: number; count: number }[] = [];
  const partChanges: { nodeId: string; part: DeclaredStoryPart | null }[] = [];

  const noCoherence = (index: number): Result<never, CommandError> =>
    opError('not-found', index, 'no coherence file is open for this project, so there are no scene declarations to change', 'open the project with its coherence file loaded');

  for (const [index, op] of ops.entries()) {
    if (op.op === 'picture-when') {
      // A day pin belongs to the placement, not the scene (pictures.md §2.1, timeline.md §9.1), so moving one never touches a day.
      const link = (snapshot.manifest.assetLinks ?? []).find((candidate) => candidate.id === op.linkId);
      if (link === undefined) {
        return opError('not-found', index, `no picture placement with id "${op.linkId}"`, 'read the timeline again and propose the pin from what it shows', 'linkId');
      }
      const held = pinOf(op.linkId);
      if (!sameWhen(op.expect.when, held)) {
        return opError(
          'revision-conflict',
          index,
          `the day pin of this placement changed since this was proposed: it was ${describeWhen(op.expect.when)} and is now ${describeWhen(held)}`,
          'read the picture again and propose the pin from its current value',
          'expect.when',
        );
      }
      if (!sameWhen(op.when, held)) {
        pinsAfter.set(op.linkId, op.when === null ? null : { ...op.when });
        counts.pins += 1;
      }
      continue;
    }

    if (op.op === 'meta') {
      const node = byId.get(op.nodeId);
      if (node === undefined || (node.type !== 'document' && node.type !== 'folder')) {
        return opError('not-found', index, `no document or folder with id "${op.nodeId}"`, HINT_READ_TREE, 'nodeId');
      }
      if (snapshot.coherence === undefined) return noCoherence(index);
      const record = metaOf(op.nodeId);
      const read: Record<(typeof TIMELINE_META_EXPECT_KEYS)[number], string | number | string[] | null> = {
        dayOffset: record?.dayOffset ?? null,
        durationDays: record?.durationDays ?? null,
        timelineMode: record?.timelineMode === undefined || record.timelineMode === 'linear' ? null : record.timelineMode,
        pov: record?.pov ?? null,
        storyPart: record?.storyPart ?? null,
        after: record?.after === undefined ? null : [...record.after],
      };
      for (const key of TIMELINE_META_EXPECT_KEYS) {
        const wanted = op.expect[key];
        if (wanted === undefined) continue;
        const expected = key === 'timelineMode' && wanted === 'linear' ? null : wanted;
        const actual = read[key];
        const agrees = key === 'after' ? sameList(expected as string[] | null, actual as string[] | null) : expected === actual;
        if (!agrees) {
          return opError(
            'revision-conflict',
            index,
            `‘${node.title}’ changed since this was proposed: its ${FIELD_WORDS[key]} was ${describeValue(expected, titleOf)} and is now ${describeValue(actual, titleOf)}`,
            'read the scene again and propose the change from its current values',
            `expect.${key}`,
            { nodeId: op.nodeId, field: key, expected, actual },
          );
        }
      }
      const result = applySceneMetaPatch(op.nodeId, record, op.patch as ScenePatch, context);
      if (!result.ok) return badOp(index, `${result.error} (‘${node.title}’)`, undefined, 'patch');
      putMeta(op.nodeId, result.meta);
      touch(op.nodeId);
      if (op.patch.dayOffset !== undefined) counts.days += 1;
      if (op.patch.durationDays !== undefined) counts.durations += 1;
      if (op.patch.timelineMode !== undefined) counts.modes += 1;
      if (op.patch.pov !== undefined) counts.povs += 1;
      if (op.patch.storyPart !== undefined) {
        counts.parts += 1;
        partChanges.push({ nodeId: op.nodeId, part: op.patch.storyPart });
      }
      if (op.patch.after_add !== undefined || op.patch.after_remove !== undefined) counts.orderings += 1;
      continue;
    }

    if (op.op === 'shift') {
      if (snapshot.coherence === undefined) return noCoherence(index);
      const pairs: { nodeId: string; dayOffset: number }[] = [];
      for (const id of op.nodeIds) {
        const node = byId.get(id);
        if (node === undefined || (node.type !== 'document' && node.type !== 'folder')) {
          return opError('not-found', index, `no document or folder with id "${id}"`, HINT_READ_TREE, 'nodeIds');
        }
        const day = metaOf(id)?.dayOffset;
        if (day === undefined) {
          return badOp(index, `‘${node.title}’ has no day, so a shift cannot move it`, 'a shift moves dated scenes only; leave undated scenes out of the set', 'nodeIds');
        }
        pairs.push({ nodeId: id, dayOffset: day });
      }
      if (shiftFingerprint(pairs) !== op.expect.fingerprint) {
        return opError(
          'revision-conflict',
          index,
          `the days of the ${pairs.length} ${pairs.length === 1 ? 'scene' : 'scenes'} in this shift changed since it was proposed`,
          'read the scenes again and propose the shift from their current days',
          'expect.fingerprint',
          { scenes: pairs.length },
        );
      }
      for (const pair of pairs) {
        const moved = pair.dayOffset + op.delta;
        if (!isDayOffset(moved)) {
          return badOp(
            index,
            `shifting ‘${titleOf(pair.nodeId)}’ from day ${pair.dayOffset} by ${op.delta} would land on day ${moved}, outside −${DAY_OFFSET_LIMIT.toLocaleString('en-US')} to ${DAY_OFFSET_LIMIT.toLocaleString('en-US')}`,
            'shift by fewer days, or leave that scene out of the set',
            'delta',
          );
        }
      }
      for (const pair of pairs) {
        const record = metaOf(pair.nodeId)!;
        putMeta(pair.nodeId, { ...record, dayOffset: pair.dayOffset + op.delta });
        touch(pair.nodeId);
      }
      counts.shifts += 1;
      counts.shiftedScenes += pairs.length;
      shifts.push({ delta: op.delta, count: pairs.length });
      continue;
    }

    const node = byId.get(op.nodeId);
    if (node === undefined) return opError('not-found', index, `no node with id "${op.nodeId}"`, HINT_READ_TREE, 'nodeId');
    if (isFixedRootId(node.id)) {
      return badOp(index, `"${node.id}" is a fixed root and cannot be moved`, 'move the nodes inside the fixed roots instead', 'nodeId');
    }
    const parent = byId.get(op.newParentId);
    if (parent === undefined) return opError('not-found', index, `no node with id "${op.newParentId}"`, HINT_READ_TREE, 'newParentId');
    if (parent.id === 'root') {
      return badOp(index, 'the project root is not a place for a node: the binder shows only the manuscript and research', 'move the node under "manuscript" or "research", or under a folder inside one of them', 'newParentId');
    }
    if (parent.type !== 'root' && parent.type !== 'folder') {
      return badOp(index, `new parent "${parent.id}" is a ${parent.type} and cannot hold children`, 'move into a folder or the manuscript, not into a document', 'newParentId');
    }
    const isBoard = parent.type === 'folder' && parent.kind === 'storyboard';
    if (node.type === 'shot' && !isBoard) {
      return badOp(index, `a shot must sit in a storyboard folder, and "${parent.id}" is not one`, 'move the shot into a storyboard folder, or leave it where it is', 'newParentId');
    }
    if (node.type !== 'shot' && isBoard) {
      return badOp(index, `"${parent.id}" is a storyboard, and a storyboard holds only shots, so "${node.id}" (a ${node.type}) cannot move into it`, 'move it beside the storyboard instead', 'newParentId');
    }
    for (let cursor: typeof node | undefined = parent, hops = 0; cursor !== undefined && hops <= tree.length; hops += 1) {
      if (cursor.id === node.id) {
        return opError('cycle', index, `cannot move ‘${node.title}’ into "${parent.id}", which is itself or a descendant of it`, 'move the node to a sibling branch', 'newParentId');
      }
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
    }

    const siblingIds = tree.filter((sibling) => sibling.parentId === node.parentId).sort((a, b) => a.order - b.order).map((sibling) => sibling.id);
    const at = siblingIds.indexOf(node.id);
    if (node.parentId !== op.expect.parentId || at !== op.expect.index) {
      const was = op.expect.parentId === null ? 'the top' : `‘${titleOf(op.expect.parentId)}’`;
      const now = node.parentId === null ? 'the top' : `‘${titleOf(node.parentId)}’`;
      return opError(
        'revision-conflict',
        index,
        `‘${node.title}’ moved since this was proposed: it was at position ${op.expect.index} under ${was} and is now at position ${at} under ${now}`,
        'read the binder again and propose the move from the current order',
        'expect',
        { nodeId: op.nodeId, expected: op.expect, actual: { parentId: node.parentId, index: at } },
      );
    }

    const position = Math.min(op.index, tree.filter((sibling) => sibling.parentId === parent.id && sibling.id !== node.id).length);
    const order = siblingOrderInTree(tree, parent.id, position, node.id);
    node.parentId = parent.id;
    node.order = order;
    touch(node.id);
    counts.moves += 1;
  }

  const nodeChanges: { nodeId: string; before: TimelineNodePlace; after: TimelineNodePlace }[] = [];
  for (const node of tree) {
    const was = original.get(node.id)!;
    if (was.parentId !== node.parentId || was.order !== node.order) {
      nodeChanges.push({ nodeId: node.id, before: was, after: { parentId: node.parentId, order: node.order } });
    }
  }
  const metaChanges: { nodeId: string; before: SceneMetaRecord | undefined; after: SceneMetaRecord | undefined }[] = [];
  for (const [nodeId, before] of first) {
    const after = current.get(nodeId);
    if (JSON.stringify(before ?? null) !== JSON.stringify(after ?? null)) metaChanges.push({ nodeId, before, after });
  }
  const linkChanges: { linkId: string; before: TimelinePictureWhen; after: TimelinePictureWhen }[] = [];
  for (const [linkId, after] of pinsAfter) {
    const before = pinsBefore.get(linkId) ?? null;
    if (!sameWhen(before, after)) linkChanges.push({ linkId, before, after });
  }

  return ok({
    tree,
    sceneMeta: current,
    metaChanges,
    nodeChanges,
    linkChanges,
    counts: {
      ...counts,
      total: counts.days + counts.durations + counts.modes + counts.povs + counts.parts + counts.orderings + counts.moves + counts.shifts + counts.pins,
    },
    touchedIds: touched,
    shifts,
    partChanges,
  });
}

/** Whether two day pins say the same thing: both empty, or the same day and the same label. */
function sameWhen(left: TimelinePictureWhen, right: TimelinePictureWhen): boolean {
  if (left === null || right === null) return left === right;
  return left.dayOffset === right.dayOffset && left.label === right.label;
}

/** A pin in the words a refusal quotes: its day and label, or "no pin". */
function describeWhen(when: TimelinePictureWhen): string {
  if (when === null) return 'no pin';
  const parts: string[] = [];
  if (when.dayOffset !== undefined) parts.push(`day ${when.dayOffset}`);
  if (when.label !== undefined) parts.push(`“${when.label}”`);
  return parts.length === 0 ? 'a pin with no day' : parts.join(', ');
}

/** The scene declarations after a batch: `base` with every touched node's result written over it. A copy; `base` is not changed. */
export function projectedSceneMeta(base: Readonly<Record<string, SceneMetaRecord>>, projection: TimelineProjection): Record<string, SceneMetaRecord> {
  const next: Record<string, SceneMetaRecord> = { ...base };
  for (const [id, record] of projection.sceneMeta) {
    if (record === undefined) delete next[id];
    else next[id] = record;
  }
  return next;
}

/* ------------------------------------------------------------------ *
 * The activity row
 * ------------------------------------------------------------------ */

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The words for a batch's activity row and its Undo button (timeline.md §4.3): `Timeline: shifted 412 scenes by +14 days`, `Timeline: ‘Coda’ is now the
 * epilogue`, or `Timeline: 5 changes (3 days, 1 duration, 1 move)`. A label the caller gave wins over the counts.
 */
export function timelineBatchSummary(projection: TimelineProjection, titleOf: (nodeId: string) => string, label?: string): string {
  const { counts } = projection;
  if (label !== undefined && label.trim() !== '') return `Timeline: ${label.trim()}`;
  const only = projection.partChanges[0];
  if (counts.total === 1 && only !== undefined) {
    const title = `‘${titleOf(only.nodeId)}’`;
    if (only.part === null) return `Timeline: ${title} inherits its story part again`;
    return only.part === 'main' ? `Timeline: ${title} is now the main story` : `Timeline: ${title} is now the ${only.part}`;
  }
  const shift = projection.shifts[0];
  if (counts.total === 1 && shift !== undefined) {
    const signed = shift.delta > 0 ? `+${shift.delta}` : `${shift.delta}`;
    return `Timeline: shifted ${plural(shift.count, 'scene', 'scenes')} by ${signed} ${Math.abs(shift.delta) === 1 ? 'day' : 'days'}`;
  }
  if (counts.total === 1 && counts.pins === 1) {
    const pin = projection.linkChanges[0];
    if (pin !== undefined) {
      if (pin.after === null) return 'Timeline: the picture is no longer pinned to a day';
      if (pin.after.dayOffset !== undefined) return `Timeline: the picture is pinned to day ${pin.after.dayOffset}`;
      return 'Timeline: the picture’s day pin is cleared';
    }
  }
  const parts = [
    counts.days > 0 ? plural(counts.days, 'day', 'days') : '',
    counts.durations > 0 ? plural(counts.durations, 'duration', 'durations') : '',
    counts.modes > 0 ? plural(counts.modes, 'mode', 'modes') : '',
    counts.povs > 0 ? plural(counts.povs, 'POV', 'POVs') : '',
    counts.parts > 0 ? plural(counts.parts, 'part', 'parts') : '',
    counts.orderings > 0 ? plural(counts.orderings, 'ordering', 'orderings') : '',
    counts.moves > 0 ? plural(counts.moves, 'move', 'moves') : '',
    counts.shifts > 0 ? plural(counts.shifts, 'shift', 'shifts') : '',
    counts.pins > 0 ? plural(counts.pins, 'picture pin', 'picture pins') : '',
  ].filter((part) => part !== '');
  return `Timeline: ${plural(counts.total, 'change', 'changes')} (${parts.join(', ')})`;
}
