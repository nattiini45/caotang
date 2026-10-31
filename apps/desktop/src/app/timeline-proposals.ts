/**
 * The proposal model of the timeline ([timeline.md §4.1 to §4.5](docs/architecture/timeline.md)): what a gesture, an Agenda cell or a
 * finding's quick action adds to the tray, how rows coalesce against the original base, and how the selected rows become the ops of
 * one `timeline.apply`.
 *
 * Pure functions over `ProjectState`, no React: the few refusal words a row can carry are messages (`t`), every other word is
 * supplied by the caller. Nothing here writes to
 * the project. A row keeps the value it read (`base`) and the value it asks for (`to`); the ops are built from the rows only when
 * the writer applies, and then **from the selected rows alone, in tray order, each validated against the rows before it that were
 * selected too** (a row validated only in the context of an unchecked predecessor is never applied).
 */

import { t } from '@lingui/core/macro';

import {
  DAY_OFFSET_LIMIT,
  TIMELINE_OPS_MAX,
  TIMELINE_SHIFT_NODES_MAX,
  isDayOffset,
  projectTimelineBatch,
  shiftFingerprint,
  type DeclaredStoryPart,
  type SceneMetaRecord,
  type TimelineMetaExpect,
  type TimelineMetaPatch,
  type TimelineOp,
  type TimelineProjection,
} from '@caotang/bus';
import type { ProjectState, TreeNode } from '@caotang/store';

/* ------------------------------------------------------------------ *
 * Rows
 * ------------------------------------------------------------------ */

/** Where a row came from. A suggestion is derived (timeline.md §4.5) and starts unchecked. */
export type RowOrigin = 'gesture' | 'agenda' | 'menu' | 'finding' | 'suggestion';

/** A scalar the row changes: the value it read, and the value it asks for. `null` is absent (or, for `to`, a clear). */
export interface Change<T> {
  readonly base: T | null;
  readonly to: T | null;
}

/** The `after` list of a scene as the row changes it: the whole list it read, and what it adds and removes. */
export interface AfterChange {
  readonly base: readonly string[] | null;
  readonly add: readonly string[];
  readonly remove: readonly string[];
}

export interface MetaRow {
  readonly kind: 'meta';
  readonly id: string;
  readonly nodeId: string;
  readonly origin: RowOrigin;
  readonly day?: Change<number>;
  readonly duration?: Change<number>;
  /** `base` and `to` are always modes; `linear` stands for no declaration. */
  readonly mode?: Change<string>;
  readonly pov?: Change<string>;
  readonly part?: Change<DeclaredStoryPart>;
  readonly after?: AfterChange;
  /** A suggestion: the scenes whose move it follows from. */
  readonly because?: readonly string[];
}

/** A scene's place among its parent's children: its parent and the sibling before it (`null` is first). */
export interface Place {
  readonly parentId: string;
  readonly predecessorId: string | null;
}

/** Where a move puts a scene: under `parentId`, right after `anchorId` (`null` is first). Resolved against the rows before it when applied. */
export interface MoveTarget {
  readonly parentId: string;
  readonly anchorId: string | null;
}

export interface MoveRow {
  readonly kind: 'move';
  readonly id: string;
  readonly nodeId: string;
  readonly origin: RowOrigin;
  readonly base: Place;
  readonly to: MoveTarget;
}

export interface ShiftRow {
  readonly kind: 'shift';
  readonly id: string;
  readonly origin: RowOrigin;
  readonly delta: number;
  readonly nodeIds: readonly string[];
  /** The days the set had when the shift was proposed. The fingerprint of these is the shift's `expect`. */
  readonly baseDays: Readonly<Record<string, number>>;
}

/** A picture's day pin: a day, a label, both, or none (`null`). The shape `picture-when` carries (timeline.md §9.1). */
export type PinWhen = { readonly dayOffset?: number; readonly label?: string } | null;

/**
 * A picture's day pin moved. It names the placement (`linkId`), not a scene, so it never touches a day on a scene; `base` is the pin
 * the row read and `to` the pin it asks for, and `base` is the apply's `expect.when`.
 */
export interface PinRow {
  readonly kind: 'pin';
  readonly id: string;
  readonly origin: RowOrigin;
  readonly linkId: string;
  readonly assetId: string;
  readonly base: PinWhen;
  readonly to: PinWhen;
}

export type Row = MetaRow | MoveRow | ShiftRow | PinRow;

export interface ProposalSet {
  readonly rows: readonly Row[];
  readonly nextId: number;
}

export const EMPTY_PROPOSALS: ProposalSet = { rows: [], nextId: 1 };

/** The most rows the tray holds: one row is at least one op, and a batch takes {@link TIMELINE_OPS_MAX}. */
export const ROWS_MAX = TIMELINE_OPS_MAX;

/** Above this many scenes a multi-select nudge is one shift (timeline.md §4.2). */
export const SHIFT_ABOVE = 20;

export const META_FIELDS = ['day', 'duration', 'mode', 'pov', 'part', 'after'] as const;
export type MetaField = (typeof META_FIELDS)[number];

/* ------------------------------------------------------------------ *
 * Reading the project
 * ------------------------------------------------------------------ */

/** What a scene declares, in the shape the rows use. `mode` is `linear` when absent, like the bus's own reading. */
export interface Declared {
  readonly day: number | null;
  readonly duration: number | null;
  readonly mode: string;
  readonly pov: string | null;
  readonly part: DeclaredStoryPart | null;
  readonly after: readonly string[] | null;
}

type MetaMap = Readonly<Record<string, SceneMetaRecord | undefined>>;

export function declaredFrom(record: SceneMetaRecord | undefined): Declared {
  return {
    day: record?.dayOffset ?? null,
    duration: record?.durationDays ?? null,
    mode: record?.timelineMode ?? 'linear',
    pov: record?.pov ?? null,
    part: record?.storyPart ?? null,
    after: record?.after === undefined ? null : [...record.after],
  };
}

const metaOf = (state: ProjectState): MetaMap => (state.coherence?.sceneMeta ?? {}) as MetaMap;

export function declaredOf(state: ProjectState, nodeId: string): Declared {
  return declaredFrom(metaOf(state)[nodeId]);
}

function sameList(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((value, at) => value === b[at]);
}

/** The children of a parent in binder order. Ties keep the tree's own order. */
export function childrenIn(tree: readonly Pick<TreeNode, 'id' | 'parentId' | 'order'>[], parentId: string | null): string[] {
  return tree
    .filter((node) => node.parentId === parentId)
    .sort((a, b) => a.order - b.order)
    .map((node) => node.id);
}

export function placeOf(tree: readonly Pick<TreeNode, 'id' | 'parentId' | 'order'>[], nodeId: string): Place | undefined {
  const node = tree.find((candidate) => candidate.id === nodeId);
  if (node === undefined || node.parentId === null) return undefined;
  const siblings = childrenIn(tree, node.parentId);
  const at = siblings.indexOf(nodeId);
  return { parentId: node.parentId, predecessorId: at > 0 ? (siblings[at - 1] as string) : null };
}

/** The tree as the binder would show it with `target` applied: `planKeyboardMove` and `planDrop` read this, so a second nudge starts where the first left off. */
export function treeWithMoves(state: ProjectState, rows: readonly Row[]): TreeNode[] {
  const tree = state.manifest.tree.map((node) => ({ ...node }));
  for (const row of rows) {
    if (row.kind !== 'move') continue;
    const node = tree.find((candidate) => candidate.id === row.nodeId);
    if (node === undefined) continue;
    const siblings = tree.filter((candidate) => candidate.parentId === row.to.parentId && candidate.id !== node.id).sort((a, b) => a.order - b.order);
    const at = row.to.anchorId === null ? 0 : siblings.findIndex((candidate) => candidate.id === row.to.anchorId) + 1;
    siblings.splice(at, 0, node);
    node.parentId = row.to.parentId;
    siblings.forEach((candidate, position) => {
      candidate.order = (position + 1) * 10;
    });
  }
  return tree;
}

/* ------------------------------------------------------------------ *
 * Adding to the set: coalescing against the original base
 * ------------------------------------------------------------------ */

export interface MetaIntent {
  readonly day?: number | null;
  readonly duration?: number | null;
  readonly mode?: string;
  readonly pov?: string | null;
  readonly part?: DeclaredStoryPart | null;
  readonly afterAdd?: readonly string[];
  readonly afterRemove?: readonly string[];
}

function scalar<T>(existing: Change<T> | undefined, base: T | null, to: T | null): Change<T> | undefined {
  const origin = existing === undefined ? base : existing.base;
  return origin === to ? undefined : { base: origin, to };
}

function listAfter(change: AfterChange | undefined, current: readonly string[] | null): readonly string[] {
  const base = change === undefined ? (current ?? []) : (change.base ?? []);
  const result = base.filter((id) => !(change?.remove ?? []).includes(id));
  for (const id of change?.add ?? []) if (!result.includes(id)) result.push(id);
  return result;
}

function afterChange(existing: AfterChange | undefined, current: readonly string[] | null, intent: MetaIntent): AfterChange | undefined {
  if (intent.afterAdd === undefined && intent.afterRemove === undefined) return existing;
  const base = existing === undefined ? current : existing.base;
  const target = [...listAfter(existing, current)];
  for (const id of intent.afterRemove ?? []) {
    const at = target.indexOf(id);
    if (at !== -1) target.splice(at, 1);
  }
  for (const id of intent.afterAdd ?? []) if (!target.includes(id)) target.push(id);
  const was = base ?? [];
  const add = target.filter((id) => !was.includes(id));
  const remove = was.filter((id) => !target.includes(id));
  return add.length === 0 && remove.length === 0 ? undefined : { base, add, remove };
}

const hasFields = (row: MetaRow): boolean =>
  row.day !== undefined || row.duration !== undefined || row.mode !== undefined || row.pov !== undefined || row.part !== undefined || row.after !== undefined;

function replaceRow(set: ProposalSet, id: string, next: Row | undefined): ProposalSet {
  const rows = next === undefined ? set.rows.filter((row) => row.id !== id) : set.rows.map((row) => (row.id === id ? next : row));
  return { ...set, rows };
}

/**
 * Adds a scene's change to the set. A second change to the same scene joins its row, the **base kept and the latest target winning**,
 * and a field that returns to its base value drops out, and a row left with no field drops out with it (timeline.md §4.2).
 */
export function proposeMeta(set: ProposalSet, state: ProjectState, nodeId: string, intent: MetaIntent, origin: RowOrigin = 'gesture'): ProposalSet {
  const existing = set.rows.find((row): row is MetaRow => row.kind === 'meta' && row.nodeId === nodeId);
  if (existing === undefined && set.rows.filter((row) => row.origin !== 'suggestion').length >= ROWS_MAX) return set;
  const current = declaredOf(state, nodeId);
  const next: { -readonly [K in keyof MetaRow]: MetaRow[K] } = {
    kind: 'meta',
    id: existing?.id ?? `row-${set.nextId}`,
    nodeId,
    // A suggestion the writer edits is theirs from then on.
    origin: existing === undefined || existing.origin === 'suggestion' ? origin : existing.origin,
  };
  if (existing?.because !== undefined && origin === 'suggestion') next.because = existing.because;
  const day = intent.day !== undefined ? scalar(existing?.day, current.day, intent.day) : existing?.day;
  const duration = intent.duration !== undefined ? scalar(existing?.duration, current.duration, intent.duration) : existing?.duration;
  const mode = intent.mode !== undefined ? scalar<string>(existing?.mode, current.mode, intent.mode) : existing?.mode;
  const pov = intent.pov !== undefined ? scalar(existing?.pov, current.pov, intent.pov) : existing?.pov;
  const part = intent.part !== undefined ? scalar(existing?.part, current.part, intent.part) : existing?.part;
  if (day !== undefined) next.day = day;
  if (duration !== undefined) next.duration = duration;
  if (mode !== undefined) next.mode = mode;
  if (pov !== undefined) next.pov = pov;
  if (part !== undefined) next.part = part;
  const after = afterChange(existing?.after, current.after, intent);
  if (after !== undefined) next.after = after;
  if (!hasFields(next)) return existing === undefined ? set : replaceRow(set, existing.id, undefined);
  if (existing === undefined) return { rows: [...set.rows, next], nextId: set.nextId + 1 };
  return replaceRow(set, existing.id, next);
}

/** Puts a scene somewhere else in the binder. The base is where the scene is in the project now, kept across later moves of the same scene. */
export function proposeMove(set: ProposalSet, state: ProjectState, nodeId: string, to: MoveTarget, origin: RowOrigin = 'gesture'): ProposalSet {
  if (to.anchorId === nodeId) return set;
  const existing = set.rows.find((row): row is MoveRow => row.kind === 'move' && row.nodeId === nodeId);
  if (existing === undefined && set.rows.filter((row) => row.origin !== 'suggestion').length >= ROWS_MAX) return set;
  const base = existing?.base ?? placeOf(state.manifest.tree, nodeId);
  if (base === undefined) return set;
  if (to.parentId === base.parentId && to.anchorId === base.predecessorId) return existing === undefined ? set : replaceRow(set, existing.id, undefined);
  const row: MoveRow = { kind: 'move', id: existing?.id ?? `row-${set.nextId}`, nodeId, origin: existing?.origin ?? origin, base, to };
  return existing === undefined ? { rows: [...set.rows, row], nextId: set.nextId + 1 } : replaceRow(set, existing.id, row);
}

const setKey = (ids: readonly string[]): string => [...ids].sort().join('\u0000');

/** The dated scenes among `nodeIds`, and how many were left out for having no day. */
export function datedAmong(state: ProjectState, nodeIds: readonly string[]): { dated: string[]; undated: number } {
  const meta = metaOf(state);
  const dated = nodeIds.filter((id) => meta[id]?.dayOffset !== undefined);
  return { dated, undated: nodeIds.length - dated.length };
}

/**
 * Shifts a set of dated scenes by `delta` days as one row. A repeat on the same set adds to its delta and a delta that comes back
 * to zero drops the row; the set is never cascaded into (timeline.md §4.5).
 */
export function proposeShift(set: ProposalSet, state: ProjectState, delta: number, nodeIds: readonly string[], origin: RowOrigin = 'menu'): ProposalSet {
  if (!Number.isInteger(delta) || delta === 0) return set;
  const { dated } = datedAmong(state, nodeIds);
  if (dated.length === 0 || dated.length > TIMELINE_SHIFT_NODES_MAX) return set;
  const key = setKey(dated);
  const existing = set.rows.find((row): row is ShiftRow => row.kind === 'shift' && setKey(row.nodeIds) === key);
  const total = (existing?.delta ?? 0) + delta;
  if (existing !== undefined && total === 0) return replaceRow(set, existing.id, undefined);
  if (existing === undefined && set.rows.filter((row) => row.origin !== 'suggestion').length >= ROWS_MAX) return set;
  const meta = metaOf(state);
  const baseDays: Record<string, number> = existing?.baseDays === undefined ? {} : { ...existing.baseDays };
  if (existing === undefined) for (const id of dated) baseDays[id] = meta[id]?.dayOffset as number;
  const row: ShiftRow = { kind: 'shift', id: existing?.id ?? `row-${set.nextId}`, origin: existing?.origin ?? origin, delta: total, nodeIds: dated, baseDays };
  return existing === undefined ? { rows: [...set.rows, row], nextId: set.nextId + 1 } : replaceRow(set, existing.id, row);
}

/** A pin as the row keeps it: no empty object, and no key holding `undefined`, so two pins compare by their fields. */
export function normalPin(when: { readonly dayOffset?: number | undefined; readonly label?: string | undefined } | null | undefined): PinWhen {
  if (when === null || when === undefined) return null;
  const pin: { dayOffset?: number; label?: string } = {};
  if (when.dayOffset !== undefined) pin.dayOffset = when.dayOffset;
  if (when.label !== undefined) pin.label = when.label;
  return pin.dayOffset === undefined && pin.label === undefined ? null : pin;
}

export function samePin(a: PinWhen, b: PinWhen): boolean {
  if (a === null || b === null) return a === b;
  return a.dayOffset === b.dayOffset && a.label === b.label;
}

/** The placement as the project holds it, or `undefined` when it is gone. */
const linkOf = (state: ProjectState, linkId: string) => (state.manifest.assetLinks ?? []).find((candidate) => candidate.id === linkId);

/** The pin a placement holds now, in the row's shape; `undefined` when the placement is not in the project. */
export function pinNow(state: ProjectState, linkId: string): PinWhen | undefined {
  const link = linkOf(state, linkId);
  return link === undefined ? undefined : normalPin(link.when);
}

/**
 * Moves a picture's pin as one row. A second move of the same placement joins its row, **the base kept and the latest target winning**,
 * and a pin that comes back to what the project holds drops the row (timeline.md §4.2 applies to pins as it does to scenes). A
 * placement the project does not hold adds nothing.
 */
export function proposePin(set: ProposalSet, state: ProjectState, linkId: string, to: PinWhen, origin: RowOrigin = 'gesture'): ProposalSet {
  const link = linkOf(state, linkId);
  if (link === undefined) return set;
  const existing = set.rows.find((row): row is PinRow => row.kind === 'pin' && row.linkId === linkId);
  if (existing === undefined && set.rows.filter((row) => row.origin !== 'suggestion').length >= ROWS_MAX) return set;
  const base = existing?.base ?? normalPin(link.when);
  const target = normalPin(to);
  if (samePin(base, target)) return existing === undefined ? set : replaceRow(set, existing.id, undefined);
  const row: PinRow = { kind: 'pin', id: existing?.id ?? `row-${set.nextId}`, origin: existing?.origin ?? origin, linkId, assetId: link.assetId, base, to: target };
  return existing === undefined ? { rows: [...set.rows, row], nextId: set.nextId + 1 } : replaceRow(set, existing.id, row);
}

/** `pin` with its day changed to `day`; the label it had stays. */
export function pinWithDay(pin: PinWhen, day: number): PinWhen {
  return pin?.label === undefined ? { dayOffset: day } : { dayOffset: day, label: pin.label };
}

export function removeRow(set: ProposalSet, id: string): ProposalSet {
  return replaceRow(set, id, undefined);
}

/** The shift row's delta edited in the tray. Zero removes it. */
export function setShiftDelta(set: ProposalSet, id: string, delta: number): ProposalSet {
  const row = set.rows.find((candidate): candidate is ShiftRow => candidate.kind === 'shift' && candidate.id === id);
  if (row === undefined) return set;
  return !Number.isInteger(delta) || delta === 0 ? replaceRow(set, id, undefined) : replaceRow(set, id, { ...row, delta });
}

/** The row's own title is the scene's; rows that name more than one scene have none. */
export function rowNodeIds(row: Row): readonly string[] {
  if (row.kind === 'pin') return [];
  return row.kind === 'shift' ? row.nodeIds : [row.nodeId];
}

/* ------------------------------------------------------------------ *
 * Stale rows
 * ------------------------------------------------------------------ */

/**
 * The fields of a row whose base no longer matches the project: an Inspector edit, an agent turn, an undo or a binder move made after
 * the row was proposed. A row with any is stale and is not applied until it is re-based or removed (timeline.md §4.4).
 */
export function staleFields(state: ProjectState, row: Row): MetaField[] | 'gone' | 'place' | 'days' | 'pin' | readonly [] {
  const present = (id: string): boolean => state.manifest.tree.some((node) => node.id === id);
  if (row.kind === 'pin') {
    const now = pinNow(state, row.linkId);
    if (now === undefined) return 'gone';
    return samePin(now, row.base) ? [] : 'pin';
  }
  if (row.kind === 'shift') {
    const meta = metaOf(state);
    if (row.nodeIds.some((id) => !present(id) || meta[id]?.dayOffset === undefined)) return 'days';
    const now = shiftFingerprint(row.nodeIds.map((nodeId) => ({ nodeId, dayOffset: meta[nodeId]?.dayOffset as number })));
    const then = shiftFingerprint(row.nodeIds.map((nodeId) => ({ nodeId, dayOffset: row.baseDays[nodeId] as number })));
    return now === then ? [] : 'days';
  }
  if (!present(row.nodeId)) return 'gone';
  if (row.kind === 'move') {
    const place = placeOf(state.manifest.tree, row.nodeId);
    return place !== undefined && place.parentId === row.base.parentId && place.predecessorId === row.base.predecessorId ? [] : 'place';
  }
  const current = declaredOf(state, row.nodeId);
  const stale: MetaField[] = [];
  if (row.day !== undefined && row.day.base !== current.day) stale.push('day');
  if (row.duration !== undefined && row.duration.base !== current.duration) stale.push('duration');
  if (row.mode !== undefined && row.mode.base !== current.mode) stale.push('mode');
  if (row.pov !== undefined && row.pov.base !== current.pov) stale.push('pov');
  if (row.part !== undefined && row.part.base !== current.part) stale.push('part');
  if (row.after !== undefined && !sameList(row.after.base, current.after)) stale.push('after');
  return stale;
}

export function isStale(state: ProjectState, row: Row): boolean {
  const stale = staleFields(state, row);
  return typeof stale === 'string' || stale.length > 0;
}

/**
 * The row read again from the project: every base becomes what the project holds now, the target is kept, and a field whose target
 * is now what the project holds drops out. A row left empty is removed. The project is read, never written.
 */
export function rebaseRow(set: ProposalSet, state: ProjectState, id: string): ProposalSet {
  const row = set.rows.find((candidate) => candidate.id === id);
  if (row === undefined) return set;
  if (row.kind === 'pin') {
    const now = pinNow(state, row.linkId);
    if (now === undefined || samePin(row.to, now)) return replaceRow(set, id, undefined);
    return replaceRow(set, id, { ...row, base: now });
  }
  if (row.kind === 'move') {
    const place = placeOf(state.manifest.tree, row.nodeId);
    if (place === undefined) return replaceRow(set, id, undefined);
    if (row.to.parentId === place.parentId && row.to.anchorId === place.predecessorId) return replaceRow(set, id, undefined);
    return replaceRow(set, id, { ...row, base: place });
  }
  if (row.kind === 'shift') {
    const { dated } = datedAmong(state, row.nodeIds);
    if (dated.length === 0) return replaceRow(set, id, undefined);
    const meta = metaOf(state);
    const baseDays: Record<string, number> = {};
    for (const nodeId of dated) baseDays[nodeId] = meta[nodeId]?.dayOffset as number;
    return replaceRow(set, id, { ...row, nodeIds: dated, baseDays });
  }
  if (!state.manifest.tree.some((node) => node.id === row.nodeId)) return replaceRow(set, id, undefined);
  const current = declaredOf(state, row.nodeId);
  const next: { -readonly [K in keyof MetaRow]: MetaRow[K] } = { kind: 'meta', id: row.id, nodeId: row.nodeId, origin: row.origin };
  const rebase = <T>(change: Change<T> | undefined, now: T | null): Change<T> | undefined => (change === undefined || change.to === now ? undefined : { base: now, to: change.to });
  const day = rebase(row.day, current.day);
  const duration = rebase(row.duration, current.duration);
  const mode = rebase(row.mode, current.mode);
  const pov = rebase(row.pov, current.pov);
  const part = rebase(row.part, current.part);
  if (day !== undefined) next.day = day;
  if (duration !== undefined) next.duration = duration;
  if (mode !== undefined) next.mode = mode;
  if (pov !== undefined) next.pov = pov;
  if (part !== undefined) next.part = part;
  if (row.after !== undefined) {
    const target = listAfter(row.after, null);
    const was = current.after ?? [];
    const add = target.filter((entry) => !was.includes(entry));
    const remove = was.filter((entry) => !target.includes(entry) && (row.after as AfterChange).remove.includes(entry));
    if (add.length > 0 || remove.length > 0) next.after = { base: current.after, add, remove };
  }
  if (!hasFields(next)) return replaceRow(set, id, undefined);
  return replaceRow(set, id, next);
}

/* ------------------------------------------------------------------ *
 * From rows to one batch
 * ------------------------------------------------------------------ */

export type RowState = 'ok' | 'skipped' | 'stale' | 'invalid';

export interface RowStatus {
  readonly state: RowState;
  /** The bus's own refusal text, for an invalid row. */
  readonly message?: string;
  readonly stale?: ReturnType<typeof staleFields>;
}

export interface Built {
  readonly ops: readonly TimelineOp[];
  readonly status: ReadonlyMap<string, RowStatus>;
  /** The projection of exactly these ops; `undefined` when no row was accepted. */
  readonly projection: TimelineProjection | undefined;
  /** The ids of the rows the ops came from, in order. */
  readonly accepted: readonly string[];
}

function projectedDeclared(state: ProjectState, projection: TimelineProjection | undefined, nodeId: string): Declared {
  if (projection !== undefined && projection.sceneMeta.has(nodeId)) return declaredFrom(projection.sceneMeta.get(nodeId));
  return declaredOf(state, nodeId);
}

function opsOf(state: ProjectState, projection: TimelineProjection | undefined, row: Row): { ops: TimelineOp[] } | { error: string } {
  if (row.kind === 'pin') {
    // The expectation is the pin the project holds now, which is the row's base unless the row is stale, and a stale row is never built.
    const held = pinNow(state, row.linkId);
    if (held === undefined) return { error: t`the picture is no longer placed there` };
    return { ops: [{ op: 'picture-when', linkId: row.linkId, when: row.to === null ? null : { ...row.to }, expect: { when: held === null ? null : { ...held } } }] };
  }
  if (row.kind === 'shift') {
    const days = row.nodeIds.map((nodeId) => ({ nodeId, dayOffset: projectedDeclared(state, projection, nodeId).day }));
    if (days.some((entry) => entry.dayOffset === null)) return { error: t`one of its scenes has no day now` };
    return {
      ops: [{ op: 'shift', delta: row.delta, nodeIds: [...row.nodeIds], expect: { fingerprint: shiftFingerprint(days as { nodeId: string; dayOffset: number }[]) } }],
    };
  }
  if (row.kind === 'move') {
    const tree = projection === undefined ? state.manifest.tree : projection.tree;
    const node = tree.find((candidate) => candidate.id === row.nodeId);
    if (node === undefined || node.parentId === null) return { error: t`the scene is no longer in the binder` };
    const at = childrenIn(tree, node.parentId).indexOf(node.id);
    const siblings = childrenIn(tree, row.to.parentId).filter((id) => id !== node.id);
    let index = 0;
    if (row.to.anchorId !== null) {
      const anchor = siblings.indexOf(row.to.anchorId);
      if (anchor === -1) return { error: t`the scene it was placed after is not there any more` };
      index = anchor + 1;
    }
    return { ops: [{ op: 'move', nodeId: row.nodeId, newParentId: row.to.parentId, index, expect: { parentId: node.parentId, index: at } }] };
  }
  const read = projectedDeclared(state, projection, row.nodeId);
  const patch: TimelineMetaPatch = {};
  const expect: TimelineMetaExpect = {};
  if (row.day !== undefined) {
    patch.dayOffset = row.day.to;
    expect.dayOffset = read.day;
  }
  if (row.duration !== undefined) {
    patch.durationDays = row.duration.to;
    expect.durationDays = read.duration;
  }
  if (row.mode !== undefined && row.mode.to !== null) {
    patch.timelineMode = row.mode.to as NonNullable<TimelineMetaPatch['timelineMode']>;
    expect.timelineMode = read.mode === 'linear' ? null : (read.mode as TimelineMetaExpect['timelineMode']);
  }
  if (row.pov !== undefined) {
    patch.pov = row.pov.to;
    expect.pov = read.pov;
  }
  if (row.part !== undefined) {
    patch.storyPart = row.part.to;
    expect.storyPart = read.part;
  }
  if (row.after !== undefined) {
    if (row.after.add.length > 0) patch.after_add = [...row.after.add];
    if (row.after.remove.length > 0) patch.after_remove = [...row.after.remove];
    expect.after = read.after === null ? null : [...read.after];
  }
  return { ops: [{ op: 'meta', nodeId: row.nodeId, patch, expect }] };
}

/**
 * The batch for the selected rows. Rows are read **from the original base, in tray order**: each selected row's ops are built against
 * the projection of the selected rows before it, so an unselected predecessor is never part of what a later row was validated
 * against. A stale row is not built; a row the bus refuses (a move whose anchor is gone, a day out of range) is marked with the bus's
 * reason and left out, and the rows around it stay applicable.
 */
export function buildBatch(state: ProjectState, rows: readonly Row[], selected: ReadonlySet<string>): Built {
  const status = new Map<string, RowStatus>();
  const ops: TimelineOp[] = [];
  const accepted: string[] = [];
  let projection: TimelineProjection | undefined;
  for (const row of rows) {
    const stale = staleFields(state, row);
    if (typeof stale === 'string' || stale.length > 0) {
      status.set(row.id, { state: 'stale', stale });
      continue;
    }
    if (!selected.has(row.id)) {
      status.set(row.id, { state: 'skipped' });
      continue;
    }
    if (ops.length >= TIMELINE_OPS_MAX) {
      status.set(row.id, { state: 'invalid', message: t({ message: `a batch takes at most ${TIMELINE_OPS_MAX} changes`, comment: 'The value is the maximum number of proposed timeline changes in one batch.' }) });
      continue;
    }
    const built = opsOf(state, projection, row);
    if ('error' in built) {
      status.set(row.id, { state: 'invalid', message: built.error });
      continue;
    }
    const next = projectTimelineBatch(state, [...ops, ...built.ops]);
    if (!next.ok) {
      status.set(row.id, { state: 'invalid', message: next.error.message.replace(/^ops\[\d+\]: /u, '') });
      continue;
    }
    ops.push(...built.ops);
    accepted.push(row.id);
    projection = next.value;
    status.set(row.id, { state: 'ok' });
  }
  return { ops, status, projection, accepted };
}

/* ------------------------------------------------------------------ *
 * Dependant suggestions (timeline.md §4.5): one hop, never a cascade
 * ------------------------------------------------------------------ */

export interface Suggestion {
  readonly nodeId: string;
  /** The scenes whose move makes this one violate its `after` link. */
  readonly because: readonly string[];
  readonly day: number;
  readonly base: number;
}

/** The most suggestion rows kept. The tray shows ten of them and the count of the rest. */
export const SUGGESTIONS_KEPT = 100;

/** The suggested rows the tray shows before "Show N more". */
export const SUGGESTIONS_VISIBLE = 10;

/**
 * The scenes that would newly break "A follows B" because a row moved B: each is proposed to go to the day B now ends, one hop from the
 * rows the writer made. A shift's own set is never suggested to (the set moves together), and rows that are themselves suggestions
 * start no further hop.
 */
export function deriveSuggestions(state: ProjectState, rows: readonly Row[]): Suggestion[] {
  const sources = rows.filter((row) => row.origin !== 'suggestion');
  if (sources.length === 0) return [];
  const meta = metaOf(state);
  const moved = new Map<string, { oldEnd: number; newEnd: number }>();
  const inShift = new Set<string>();
  for (const row of sources) {
    if (row.kind === 'shift') {
      for (const id of row.nodeIds) {
        inShift.add(id);
        const day = meta[id]?.dayOffset;
        if (day === undefined) continue;
        const dur = meta[id]?.durationDays ?? 0;
        moved.set(id, { oldEnd: day + dur, newEnd: day + row.delta + dur });
      }
    } else if (row.kind === 'meta' && (row.day !== undefined || row.duration !== undefined)) {
      const current = declaredOf(state, row.nodeId);
      const start = row.day === undefined ? current.day : row.day.to;
      if (start === null) continue;
      const dur = (row.duration === undefined ? current.duration : row.duration.to) ?? 0;
      // A scene that had no day was not compared, so nothing it breaks is a break it already had.
      const oldEnd = current.day === null ? Number.NEGATIVE_INFINITY : current.day + (current.duration ?? 0);
      moved.set(row.nodeId, { oldEnd, newEnd: start + dur });
    }
  }
  if (moved.size === 0) return [];
  const pendingDay = new Map<string, number | null>();
  for (const row of rows) if (row.kind === 'meta' && row.day !== undefined && row.origin !== 'suggestion') pendingDay.set(row.nodeId, row.day.to);
  const found = new Map<string, { because: string[]; day: number }>();
  for (const [aId, record] of Object.entries(meta)) {
    if (record === undefined || record.after === undefined || record.dayOffset === undefined) continue;
    if (inShift.has(aId)) continue;
    const aDay = pendingDay.has(aId) ? pendingDay.get(aId) : record.dayOffset;
    if (aDay === null || aDay === undefined) continue;
    for (const bId of record.after) {
      const change = moved.get(bId);
      if (change === undefined || bId === aId) continue;
      const wasBroken = aDay < change.oldEnd;
      if (wasBroken || aDay >= change.newEnd) continue;
      const entry = found.get(aId);
      if (entry === undefined) found.set(aId, { because: [bId], day: change.newEnd });
      else {
        entry.because.push(bId);
        entry.day = Math.max(entry.day, change.newEnd);
      }
    }
  }
  const out: Suggestion[] = [];
  for (const [nodeId, entry] of found) {
    if (!isDayOffset(entry.day)) continue;
    out.push({ nodeId, because: entry.because, day: entry.day, base: meta[nodeId]?.dayOffset as number });
    if (out.length >= SUGGESTIONS_KEPT) break;
  }
  return out;
}

/**
 * The set with its suggestion rows brought in line with what the other rows imply: a derived suggestion that has no row gets one, one
 * that still follows has its target updated, and one that no longer follows is dropped. A suggestion the writer has edited is
 * a row of its own origin by then and is left alone. Turned off, every suggestion row is removed.
 */
export function syncSuggestions(set: ProposalSet, state: ProjectState, enabled: boolean): ProposalSet {
  const derived = enabled ? deriveSuggestions(state, set.rows) : [];
  const wanted = new Map(derived.map((entry) => [entry.nodeId, entry]));
  let nextId = set.nextId;
  let changed = false;
  const kept: Row[] = [];
  for (const row of set.rows) {
    if (row.origin !== 'suggestion' || row.kind !== 'meta') {
      kept.push(row);
      continue;
    }
    const entry = wanted.get(row.nodeId);
    if (entry === undefined) {
      changed = true;
      continue;
    }
    wanted.delete(row.nodeId);
    if (row.day?.to === entry.day && row.day.base === entry.base) {
      kept.push(row);
      continue;
    }
    changed = true;
    kept.push({ ...row, day: { base: entry.base, to: entry.day }, because: entry.because });
  }
  for (const entry of wanted.values()) {
    if (kept.some((row) => row.kind === 'meta' && row.nodeId === entry.nodeId)) continue;
    changed = true;
    kept.push({ kind: 'meta', id: `row-${nextId}`, nodeId: entry.nodeId, origin: 'suggestion', day: { base: entry.base, to: entry.day }, because: entry.because });
    nextId += 1;
  }
  return changed ? { rows: kept, nextId } : set;
}

/* ------------------------------------------------------------------ *
 * What a row says: the facts a tray row names, without the words
 * ------------------------------------------------------------------ */

/** The part a row leaves a scene in, and the part it was in. A row that does not change the part leaves it where it was. */
export interface PartFacts {
  readonly before: DeclaredStoryPart;
  readonly after: DeclaredStoryPart;
}

/** Whether a scene's day sits on the wrong side of the main story for its part (timeline.md §3.4). */
export function datedInsideMain(part: DeclaredStoryPart, day: number | null, main: { readonly start?: number; readonly end?: number } | undefined): boolean {
  if (day === null || main === undefined) return false;
  if (part === 'prologue') return main.start !== undefined && day >= main.start;
  if (part === 'epilogue') return main.end !== undefined && day < main.end;
  return false;
}

/** The counts the batch's Apply says: "3 days, 1 duration, 1 move". */
export interface BatchWords {
  readonly total: number;
  readonly parts: readonly { readonly kind: 'days' | 'durations' | 'modes' | 'povs' | 'parts' | 'orderings' | 'moves' | 'shifts' | 'pins'; readonly count: number }[];
}

export function batchWords(projection: TimelineProjection | undefined): BatchWords {
  if (projection === undefined) return { total: 0, parts: [] };
  const { counts } = projection;
  const all = [
    { kind: 'days', count: counts.days },
    { kind: 'durations', count: counts.durations },
    { kind: 'modes', count: counts.modes },
    { kind: 'povs', count: counts.povs },
    { kind: 'parts', count: counts.parts },
    { kind: 'orderings', count: counts.orderings },
    { kind: 'moves', count: counts.moves },
    { kind: 'shifts', count: counts.shifts },
    { kind: 'pins', count: counts.pins },
  ] as const;
  return { total: counts.total, parts: all.filter((entry) => entry.count > 0) };
}

/** Whether a number is a day the patch accepts, for a cell or a field to check before it proposes. */
export function isProposableDay(value: number): boolean {
  return isDayOffset(value);
}

export { DAY_OFFSET_LIMIT };
