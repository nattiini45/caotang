/**
 * An approved timeline batch written to the folder — [timeline.md §9.2](../../../docs/architecture/timeline.md), T12.
 *
 * A `timeline.apply` batch touches **two files**: `caotang.json` (a move changes a node's parent and order) and `coherence.json`
 * (a scene's day, duration, mode, point of view or story part is a declaration). The folder session writes them one after the
 * other, so a batch is never one atomic write, and a bare "ok" from the bus would promise more than the disk can. The save
 * therefore answers with a **typed outcome** — `persisted`, `conflict`, `partial` or `refused` — and a `persisted` one carries a
 * **read-back** of every scene and moved node the batch changed, read from the files on disk. This module is the pure half of that:
 * the shapes the answer is built from, and the two rules that make a two-writer folder safe —
 *
 * - **the per-scene rule.** `coherence.json` is derived state the desktop app writes too, and it sits outside the folder-drift
 *   check, so the server never writes its copy blind. It re-reads the file, keeps everything the app changed that this batch did
 *   not touch (other scenes' declarations, findings and dismissals, world rules, review state), and writes its own declarations
 *   over the scenes it did touch. Two writers on one field is where a merge would have to guess, and the guess would be the app's
 *   work lost, so that is a **conflict**: nothing is written, and the scene and field are named with the value on disk.
 * - **the read-back rule.** A file that was written is read again and compared with what the batch meant. `persist()` answering
 *   without throwing is not evidence that the folder holds the change — another program may have rewritten the file, or a save may
 *   have stopped at the second file — so `persisted` is only ever said about values read back from disk.
 *
 * Neither rule closes the window between the check and the write: the folder port has no compare-and-swap, and the digest check
 * before a write is a second read (timeline.md §9.2, "what is not closed"). It is narrowed and, when it is crossed, reported as
 * `partial` rather than claimed as a success.
 */

import type { CommandError } from '@caotang/bus';
import type { CoherenceFile, SceneMeta } from '@caotang/coherence';
import { effectiveStoryParts } from '@caotang/coherence';
import type { Manifest, TreeNode } from '@caotang/store';

/** The two project files a timeline batch can change, as its answer names them. */
export type TimelineFile = 'caotang.json' | 'coherence.json';

/** The scene fields a batch can declare, and the read-back reports. `after` is here because an ordering op changes it. */
export const SCENE_FIELDS = ['dayOffset', 'durationDays', 'timelineMode', 'pov', 'storyPart', 'after'] as const;

export type SceneField = (typeof SCENE_FIELDS)[number];

/** A field's name in the words a refusal uses, as the harness's own card names it. */
export const FIELD_WORDS: Readonly<Record<SceneField, string>> = {
  dayOffset: 'day',
  durationDays: 'duration',
  timelineMode: 'mode',
  pov: 'point of view',
  storyPart: 'story part',
  after: '“after” list',
};

/** One scene's declaration as the folder holds it after the write: what the caller is told the batch made true. */
export interface SceneReadback {
  readonly nodeId: string;
  readonly title: string;
  /** `null` is "the scene has no day of its own" (undated), never day zero. */
  readonly dayOffset: number | null;
  readonly durationDays: number | null;
  readonly timelineMode: string;
  /** The codex entry id, or `null` when the scene declares no point of view. */
  readonly pov: string | null;
  /** The **effective** part (coherence.md §5.2.2): the nearest declaration above the scene, then the main story. */
  readonly storyPart: string;
}

/** One moved node as the folder holds it: its parent and its position among that parent's children. */
export interface MoveReadback {
  readonly nodeId: string;
  readonly title: string;
  readonly parentId: string;
  readonly parentTitle: string;
  readonly index: number;
}

export interface TimelineReadback {
  readonly scenes: readonly SceneReadback[];
  readonly moved: readonly MoveReadback[];
}

/** One scene field the app changed while the batch was being confirmed, in the words a refusal uses. */
export interface SceneClash {
  readonly nodeId: string;
  readonly title: string;
  readonly field: SceneField;
  /** The value this host held when it proposed the change, in words. */
  readonly expected: string;
  /** The value the folder holds now, in words. */
  readonly current: string;
}

/** Why a batch wrote nothing: the refusal to hand back, and the scenes and fields behind it. */
export interface TimelineConflict {
  readonly error: CommandError;
  readonly scenes: readonly SceneClash[];
}

/**
 * What a host supplies to a batch save: the call that installs it in the session's copy, and whether the harness refused it.
 * `apply` is synchronous on purpose — the save reads what the batch changed by comparing its own copies either side of the call,
 * so nothing may await between them.
 */
export interface TimelineApplied<T> {
  readonly installed: boolean;
  readonly outcome: T;
}

/**
 * The answer of one approved timeline batch. `persisted` alone is success; `partial` is a save that stopped somewhere in the
 * middle and is never reported as success; `conflict` and `refused` wrote nothing.
 */
export type TimelineWriteResult<T> =
  | {
      readonly status: 'persisted';
      readonly outcome: T;
      readonly readback: TimelineReadback;
      /** The files the batch changed, read back above: `coherence.json` alone for declarations, both for a move. */
      readonly files: readonly TimelineFile[];
    }
  | { readonly status: 'conflict'; readonly conflict: TimelineConflict }
  | {
      readonly status: 'partial';
      readonly outcome: T;
      readonly written: readonly TimelineFile[];
      readonly unwritten: readonly TimelineFile[];
      /** What the folder holds now, so the caller can say which fields are durable and which are not. */
      readonly readback: TimelineReadback;
      /** What to do about it, in words: re-read the project, then propose again what is not on disk. */
      readonly recovery: string;
    }
  | {
      readonly status: 'refused';
      /** The harness's own refusal, which wrote nothing: an invalid op, an unknown node, a stale expectation. */
      readonly outcome: T;
    };

/** A tree node's place, as the before-image of a move: the parent it sat under and its order among the siblings. */
export interface TreePlace {
  readonly parentId: string | null;
  readonly order: number;
}

/**
 * A declaration's value for one field, as the compare reads it: an absent field and a clear are the same thing, `linear` is no
 * mode at all, and an empty `after` list is no list. The bus reads `expect` the same way (`parseMetaExpect`, timeline.ts), so a
 * comparison here cannot disagree with the one the apply makes.
 */
export function fieldValue(record: SceneMeta | undefined, field: SceneField): string | number | string[] | null {
  if (record === undefined) return null;
  switch (field) {
    case 'dayOffset':
      return record.dayOffset ?? null;
    case 'durationDays':
      return record.durationDays ?? null;
    case 'timelineMode':
      return record.timelineMode === undefined || record.timelineMode === 'linear' ? null : record.timelineMode;
    case 'pov':
      return record.pov ?? null;
    case 'storyPart':
      return record.storyPart ?? null;
    case 'after':
      return record.after === undefined || record.after.length === 0 ? null : [...record.after];
  }
}

/** Whether two declarations are the same record, by every field a batch could write. */
function sameRecord(left: SceneMeta | undefined, right: SceneMeta | undefined): boolean {
  return SCENE_FIELDS.every((field) => JSON.stringify(fieldValue(left, field)) === JSON.stringify(fieldValue(right, field)));
}

/** The scenes whose declaration differs between two copies of the project, in id order: the batch touched these. */
export function declarationChanges(
  before: Readonly<Record<string, SceneMeta>>,
  after: Readonly<Record<string, SceneMeta>>,
): string[] {
  const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...ids].filter((id) => !sameRecord(before[id], after[id])).sort();
}

/** The scenes whose parent or position differs between two copies of the tree, in tree order: the batch moved these. */
export function movedSince(before: ReadonlyMap<string, TreePlace>, tree: readonly TreeNode[]): string[] {
  return tree.filter((node) => {
    const place = before.get(node.id);
    return place !== undefined && (place.parentId !== node.parentId || place.order !== node.order);
  }).map((node) => node.id);
}

/** Every node's place, for the before-image of a batch's moves. */
export function placesOf(tree: readonly TreeNode[]): Map<string, TreePlace> {
  return new Map(tree.map((node) => [node.id, { parentId: node.parentId, order: node.order }]));
}

/** How a value reads in words, for a conflict: days, durations, modes and parts as a writer says them. */
function wordsOf(
  field: SceneField,
  value: string | number | string[] | null,
  titles: ReadonlyMap<string, string>,
  entryNames: ReadonlyMap<string, string>,
): string {
  if (value === null) {
    switch (field) {
      case 'dayOffset':
        return 'no day';
      case 'durationDays':
        return 'no duration of its own';
      case 'timelineMode':
        return 'linear';
      case 'pov':
        return 'no point of view';
      case 'storyPart':
        return 'inherited';
      case 'after':
        return 'no “after” list';
    }
  }
  switch (field) {
    case 'dayOffset':
      return `day ${String(value)}`;
    case 'durationDays':
      return `${String(value)} ${value === 1 ? 'day' : 'days'}`;
    case 'timelineMode':
    case 'storyPart':
      return String(value);
    case 'pov':
      return entryNames.get(String(value)) ?? String(value);
    case 'after':
      return (value as string[]).map((id) => `‘${titles.get(id) ?? id}’`).join(', ');
  }
}

/**
 * The scenes and fields where the folder disagrees with what this host proposed, for the scenes a batch changes.
 *
 * Only the fields the batch changes are compared: the app is free to have set a scene's point of view while the batch sets its day,
 * and that is a merge, not a clash. A clash is the one case a merge could not settle — two values for one field — so it is the one
 * case that refuses, before any file is written.
 */
export function declarationClashes(
  held: Readonly<Record<string, SceneMeta>>,
  next: Readonly<Record<string, SceneMeta>>,
  disk: Readonly<Record<string, SceneMeta>>,
  titles: ReadonlyMap<string, string>,
  entryNames: ReadonlyMap<string, string>,
): SceneClash[] {
  const clashes: SceneClash[] = [];
  for (const nodeId of declarationChanges(held, next)) {
    for (const field of SCENE_FIELDS) {
      const was = fieldValue(held[nodeId], field);
      if (JSON.stringify(was) !== JSON.stringify(fieldValue(next[nodeId], field))) {
        const onDisk = fieldValue(disk[nodeId], field);
        if (JSON.stringify(onDisk) !== JSON.stringify(was)) {
          clashes.push({
            nodeId,
            title: titles.get(nodeId) ?? nodeId,
            field,
            expected: wordsOf(field, was, titles, entryNames),
            current: wordsOf(field, onDisk, titles, entryNames),
          });
        }
      }
    }
  }
  return clashes;
}

/** The codex entry names of a manifest, by id, for the words a point of view is quoted by. */
export function entryNamesOf(manifest: Manifest): Map<string, string> {
  return new Map((manifest.codex ?? []).map((entry) => [entry.id, entry.name]));
}

/** The titles of a manifest's nodes, by id. */
export function titlesOf(manifest: Manifest): Map<string, string> {
  return new Map(manifest.tree.map((node) => [node.id, node.title]));
}

/**
 * The `coherence.json` a batch writes: `disk` (the file the folder holds now, with this host's own unsaved findings delta already
 * merged onto it) with the declarations of exactly the scenes the batch changed taken from `mine`.
 *
 * Every other part of `disk` is kept as it is — the other scenes' declarations, the findings the app added, dismissed or fixed, the
 * runs, the world rules and the review state — because a timeline batch changes none of them, and a write that replaced them would
 * be this host overwriting work it never read. A scene the batch cleared loses its record entirely, as the store's apply does.
 */
export function declarationsWritten(
  disk: CoherenceFile,
  mine: CoherenceFile,
  changed: readonly string[],
): CoherenceFile {
  const written: CoherenceFile = structuredClone(disk);
  for (const nodeId of changed) {
    const record = mine.sceneMeta[nodeId];
    if (record === undefined) delete written.sceneMeta[nodeId];
    else written.sceneMeta[nodeId] = structuredClone(record);
  }
  return written;
}

/**
 * What the folder holds for the scenes and nodes a batch changed, read from the files as they are now.
 *
 * A scene the batch cleared has no declaration and reads as undated, `linear`, with no point of view; its effective part is the
 * nearest declaration above it or the main story, as the app and the checks compute it. A node that is no longer in the tree is
 * left out of `moved` rather than reported at a place it does not hold: the read-back says what is there, not what was meant.
 */
export function readbackOf(
  manifest: Manifest,
  file: CoherenceFile,
  scenes: readonly string[],
  moved: readonly string[],
): TimelineReadback {
  const titles = titlesOf(manifest);
  const parts = effectiveStoryParts(manifest.tree, file.sceneMeta);
  const siblings = new Map<string, TreeNode[]>();
  for (const node of manifest.tree) {
    const key = node.parentId ?? '';
    const list = siblings.get(key) ?? [];
    list.push(node);
    siblings.set(key, list);
  }
  const readScenes: SceneReadback[] = [];
  for (const nodeId of scenes) {
    const title = titles.get(nodeId);
    if (title === undefined) continue;
    const record = file.sceneMeta[nodeId];
    readScenes.push({
      nodeId,
      title,
      dayOffset: (fieldValue(record, 'dayOffset') as number | null) ?? null,
      durationDays: (fieldValue(record, 'durationDays') as number | null) ?? null,
      timelineMode: String(fieldValue(record, 'timelineMode') ?? 'linear'),
      pov: (fieldValue(record, 'pov') as string | null) ?? null,
      storyPart: parts.get(nodeId) ?? 'main',
    });
  }
  const readMoved: MoveReadback[] = [];
  for (const nodeId of moved) {
    const node = manifest.tree.find((candidate) => candidate.id === nodeId);
    if (node === undefined || node.parentId === null) continue;
    const list = (siblings.get(node.parentId) ?? []).slice().sort((a, b) => a.order - b.order);
    readMoved.push({
      nodeId,
      title: node.title,
      parentId: node.parentId,
      parentTitle: titles.get(node.parentId) ?? node.parentId,
      index: list.findIndex((sibling) => sibling.id === nodeId),
    });
  }
  return { scenes: readScenes, moved: readMoved };
}
