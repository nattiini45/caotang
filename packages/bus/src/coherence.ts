/**
 * The coherence rules the bus and the store share — [coherence.md §5.2, §5.2.1, §6.3, §7.1](../../../docs/architecture/coherence.md).
 *
 * **Why these live in the bus.** The dependency runs coherence → store → bus, so the
 * bus cannot import the coherence module, and the store cannot either. `coherence.setSceneMeta`
 * and `coherence.setFindingStatus` have to be validated (pure, before any effect, in the bus's
 * `validate`) and applied (synchronously, in the store) by the same rule, so the rule has one
 * home here. `@caotang/coherence` re-exports it, and its tests read the vocabulary back against
 * the model's own lists, so the two copies cannot drift without a test failing.
 *
 * **What is in here, and what is not.** The vocabulary (the timeline modes, the dismissal
 * reason ids, the finding statuses, the note limit), the scene-metadata patch rule, the
 * inverse of a patch for undo, and the finding transition table. Nothing here performs I/O,
 * reads a clock or touches a store: each function is a pure function of its arguments.
 */

/** §5.2.1's `timelineMode` enum. Absent is `linear`, which is stored as absence. */
export const TIMELINE_MODES = [
  'linear',
  'flashback',
  'flash-forward',
  'parallel',
  'frame',
  'dream',
  'mythic',
  'backstory',
  'simultaneous',
  'circular',
  'time-skip',
] as const;

export type TimelineModeName = (typeof TIMELINE_MODES)[number];

/**
 * §6.3's dismissal picker, by id. The labels and tooltips live in the coherence module
 * (`DISMISSAL_REASONS`); the bus needs only the ids to validate a reason.
 */
export const DISMISSAL_REASON_IDS = ['flashback', 'in-world-lie', 'unreliable-narrator', 'intentional', 'false-positive'] as const;

export type DismissalReasonName = (typeof DISMISSAL_REASON_IDS)[number];

/** §3's `FINDING_STATUSES`. */
export const COHERENCE_STATUSES = ['open', 'dismissed', 'fixed'] as const;

export type CoherenceStatusName = (typeof COHERENCE_STATUSES)[number];

/** codex-level note limit (coherence.md §7): counted in code points, the unit `maxLength` counts. */
export const COHERENCE_NOTE_LIMIT = 500;

/** §5.2 plus §5.2.1: one document's declarations. Absent keys are "not declared". */
export interface SceneMetaRecord {
  pov?: string;
  dayOffset?: number;
  durationDays?: number;
  after?: string[];
  expectedPresent?: string[];
  timelineMode?: string;
}

/** §7.1's `patch`. `null` on a scalar clears it; `timelineMode` has no clear form (`linear` is the clear). */
export interface ScenePatch {
  pov?: string | null;
  dayOffset?: number | null;
  durationDays?: number | null;
  after_add?: string[];
  after_remove?: string[];
  expectedPresent_add?: string[];
  expectedPresent_remove?: string[];
  timelineMode?: string;
}

/** The closed set of `patch` keys (§7.1). A key outside it is refused with the list of keys that are valid. */
export const SCENE_PATCH_KEYS = [
  'pov',
  'dayOffset',
  'durationDays',
  'after_add',
  'after_remove',
  'expectedPresent_add',
  'expectedPresent_remove',
  'timelineMode',
] as const;

/** What a patch is checked against: the codex entries by id, and the documents a dependency may name. */
export interface SceneMetaContext {
  readonly entries: readonly { readonly id: string; readonly name: string }[];
  /** Document ids a dependency may name. Omitted means no check is made. */
  readonly documentIds?: ReadonlySet<string>;
}

export type ScenePatchResult =
  | { readonly ok: true; readonly meta: SceneMetaRecord }
  | { readonly ok: false; readonly error: string };

function listEntries(entries: SceneMetaContext['entries']): string {
  if (entries.length === 0) return 'the codex is empty; create the entry first';
  return `valid codex entries are ${entries.map((e) => `${e.name} (${e.id})`).join(', ')}`;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Applies a patch to one node's declarations, purely. `docId` is the node being edited:
 * a scene may not follow itself, which would be a relation no order can satisfy. The
 * caller passes `current` as the record it holds (or `undefined`), and gets the record the
 * patch makes. The store's apply calls this with the same arguments `validate` did, so a
 * patch that validated cannot fail here.
 */
export function applySceneMetaPatch(
  docId: string,
  current: SceneMetaRecord | undefined,
  patch: ScenePatch,
  context: SceneMetaContext,
): ScenePatchResult {
  for (const key of Object.keys(patch)) {
    if (!(SCENE_PATCH_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `unknown patch field "${key}"; valid fields are ${SCENE_PATCH_KEYS.join(', ')}` };
    }
  }
  const next: SceneMetaRecord = { ...(current ?? {}) };
  const entryIds = new Set(context.entries.map((e) => e.id));

  if (patch.pov !== undefined) {
    if (patch.pov === null) delete next.pov;
    else if (!entryIds.has(patch.pov)) {
      return { ok: false, error: `pov "${patch.pov}" is not a codex entry; ${listEntries(context.entries)}` };
    } else next.pov = patch.pov;
  }

  for (const field of ['dayOffset', 'durationDays'] as const) {
    const value = patch[field];
    if (value === undefined) continue;
    if (value === null) delete next[field];
    else if (isNonNegativeInteger(value)) next[field] = value;
    else return { ok: false, error: `${field} must be a whole number of days, zero or more; got ${String(value)}` };
  }

  if (patch.after_add !== undefined || patch.after_remove !== undefined) {
    const after = new Set(next.after ?? []);
    for (const id of patch.after_add ?? []) {
      if (id === docId) return { ok: false, error: 'a scene cannot be declared to follow itself' };
      if (context.documentIds !== undefined && !context.documentIds.has(id)) {
        return { ok: false, error: `after names "${id}", which is not a document in this project` };
      }
      after.add(id);
    }
    for (const id of patch.after_remove ?? []) after.delete(id);
    if (after.size > 0) next.after = [...after];
    else delete next.after;
  }

  if (patch.expectedPresent_add !== undefined || patch.expectedPresent_remove !== undefined) {
    const expected = new Set(next.expectedPresent ?? []);
    for (const id of patch.expectedPresent_add ?? []) {
      if (!entryIds.has(id)) {
        return { ok: false, error: `expectedPresent names "${id}", which is not a codex entry; ${listEntries(context.entries)}` };
      }
      expected.add(id);
    }
    for (const id of patch.expectedPresent_remove ?? []) expected.delete(id);
    if (expected.size > 0) next.expectedPresent = [...expected];
    else delete next.expectedPresent;
  }

  if (patch.timelineMode !== undefined) {
    const mode = patch.timelineMode;
    if (!(TIMELINE_MODES as readonly string[]).includes(mode)) {
      return { ok: false, error: `timelineMode "${mode}" is not a mode; valid modes are ${TIMELINE_MODES.join(', ')}` };
    }
    // `linear` is the default and is stored as absence, so an unset mode and a linear one are one state.
    if (mode === 'linear') delete next.timelineMode;
    else next.timelineMode = mode;
  }

  return { ok: true, meta: next };
}

/** A record with no declarations is absent, not an empty object: the store drops it. */
export function isEmptySceneMeta(meta: SceneMetaRecord): boolean {
  return Object.keys(meta).length === 0;
}

/**
 * The patch that restores `before` from `after`, for undo (command-bus §5, `inverse`).
 *
 * Only the keys the forward patch named are restored, so an undo touches what the
 * command touched and nothing else. A scalar goes back to its prior value, or to `null`
 * (clear) when there was none. A list goes back by membership: what the forward patch
 * added is removed, and what it removed is added back. Membership is exact; the position
 * a removed id had in the list is not, because the list is kept in insertion order.
 */
export function inverseScenePatch(before: SceneMetaRecord | undefined, forward: ScenePatch, after: SceneMetaRecord): ScenePatch {
  const prior: SceneMetaRecord = before ?? {};
  const inverse: ScenePatch = {};
  if (forward.pov !== undefined) inverse.pov = prior.pov ?? null;
  if (forward.dayOffset !== undefined) inverse.dayOffset = prior.dayOffset ?? null;
  if (forward.durationDays !== undefined) inverse.durationDays = prior.durationDays ?? null;
  if (forward.timelineMode !== undefined) inverse.timelineMode = prior.timelineMode ?? 'linear';
  if (forward.after_add !== undefined || forward.after_remove !== undefined) {
    const { added, removed } = membershipChange(prior.after ?? [], after.after ?? []);
    inverse.after_add = removed;
    inverse.after_remove = added;
  }
  if (forward.expectedPresent_add !== undefined || forward.expectedPresent_remove !== undefined) {
    const { added, removed } = membershipChange(prior.expectedPresent ?? [], after.expectedPresent ?? []);
    inverse.expectedPresent_add = removed;
    inverse.expectedPresent_remove = added;
  }
  return inverse;
}

function membershipChange(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
  const was = new Set(before);
  const now = new Set(after);
  return {
    added: after.filter((id) => !was.has(id)),
    removed: before.filter((id) => !now.has(id)),
  };
}

/* ------------------------------------------------------------------ *
 * Finding status transitions (§6.3, and the engine's lifecycle).
 * ------------------------------------------------------------------ */

/** A stored note: trimmed, and absent when nothing is left (the engine's `trimNote`). */
export function trimCoherenceNote(note: string | undefined): string | undefined {
  if (note === undefined) return undefined;
  const trimmed = note.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** The count and the limit, when a note is over it (the engine's `noteLengthProblem`). */
export function coherenceNoteProblem(note: string | undefined): string | undefined {
  const kept = trimCoherenceNote(note);
  if (kept === undefined) return undefined;
  const length = [...kept].length;
  return length > COHERENCE_NOTE_LIMIT ? `${length} characters; the limit is ${COHERENCE_NOTE_LIMIT}` : undefined;
}

/**
 * Whether a finding in `from` may move to `to`. The engine's rules, as a table:
 * dismiss and mark fixed need an open finding; re-open needs a dismissed or fixed one.
 * A finding already in the target status is not a transition, and says so.
 */
export function findingTransition(from: string, to: CoherenceStatusName): { readonly ok: true } | { readonly ok: false; readonly message: string } {
  if (from === to) {
    return { ok: false, message: `the finding is already ${to}; there is nothing to change` };
  }
  if (to === 'dismissed' || to === 'fixed') {
    if (from !== 'open') {
      return { ok: false, message: `the finding is ${from}; re-open it before it can be marked ${to}` };
    }
    return { ok: true };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * The run discard (§7.1). The rule is the lifecycle's, and the store applies it with the same function, so the two cannot
 * disagree about which findings a discard takes.
 * ------------------------------------------------------------------ */

/**
 * The findings a discard of `runId` takes, and the ones it keeps. A finding goes when the run created it and nobody
 * touched it, whatever its status is now. A touched finding stays with its history, and so does one the run only updated,
 * because "created" is recorded when the finding is made and "touched" when the writer or the agent acts on it.
 */
export function findingsDiscardedWith<F extends { readonly createdByRunId?: string; readonly touchedAt?: string }>(
  findings: readonly F[],
  runId: string,
): { readonly kept: F[]; readonly removed: F[] } {
  const kept: F[] = [];
  const removed: F[] = [];
  for (const finding of findings) {
    if (finding.createdByRunId === runId && finding.touchedAt === undefined) removed.push(finding);
    else kept.push(finding);
  }
  return { kept, removed };
}
