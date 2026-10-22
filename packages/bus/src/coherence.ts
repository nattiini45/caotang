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

/** §5.5: a handle, at most this many code points. The handle names the thread in a finding and a dismissal. */
export const THREAD_ID_LIMIT = 80;

/** §5.5: the writer's one line about what the payoff is for, at most this many code points. */
export const THREAD_NOTE_LIMIT = 200;

/**
 * §5.5: a thread declared on its setup scene. `id` is the writer's handle (free text), `payoff` the document that pays it
 * off, and `note` what that payoff is for. Only `id` and `payoff` are read by a check.
 */
export interface SceneThread {
  id: string;
  payoff: string;
  note?: string;
}

/** §4.4: a character (a codex entry id) and a knowledge fact (a `k_` id). The unit `learns` and `knows` are lists of. */
export interface KnowledgeLinkRecord {
  entryId: string;
  factId: string;
}

/** §5.2 plus §5.2.1, §5.5 and §4.4: one document's declarations. Absent keys are "not declared". */
export interface SceneMetaRecord {
  pov?: string;
  dayOffset?: number;
  durationDays?: number;
  after?: string[];
  expectedPresent?: string[];
  timelineMode?: string;
  /** Kept sorted by handle, so an add and the undo of a remove leave the list as it was. */
  threads?: SceneThread[];
  /** §4.4: characters who learn a fact in this scene. Kept in the order they were declared. */
  learns?: KnowledgeLinkRecord[];
  /** §4.4: characters who act on a fact in this scene. */
  knows?: KnowledgeLinkRecord[];
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
  /** §5.5: threads to declare. A handle already declared is refused unless `threads_remove` takes it in the same patch. */
  threads_add?: SceneThread[];
  /** §5.5: handles to remove, matched without regard to case. Applied before `threads_add`, so the two together edit a thread. */
  threads_remove?: string[];
  /** §4.4: characters who learn a fact here. A character and a fact that the codex and the knowledge list hold; a pair already declared is left as it is. */
  learns_add?: KnowledgeLinkRecord[];
  /** §4.4: pairs to remove. A pair that is not declared is ignored. Applied before `learns_add`. */
  learns_remove?: KnowledgeLinkRecord[];
  /** §4.4: characters who act on a fact here. */
  knows_add?: KnowledgeLinkRecord[];
  knows_remove?: KnowledgeLinkRecord[];
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
  'threads_add',
  'threads_remove',
  'learns_add',
  'learns_remove',
  'knows_add',
  'knows_remove',
] as const;

/** What a patch is checked against: the codex entries by id, and the documents a dependency may name. */
export interface SceneMetaContext {
  /** The codex entries. `type` is read for `learns` and `knows`, which take a character (§4.4). */
  readonly entries: readonly { readonly id: string; readonly name: string; readonly type?: string }[];
  /** The knowledge facts a `learns` or `knows` may name (§4.4). Omitted means there is none. */
  readonly facts?: readonly { readonly id: string; readonly text: string }[];
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

  if (patch.threads_add !== undefined || patch.threads_remove !== undefined) {
    const threads = applyThreads(docId, next.threads ?? [], patch, context);
    if (!threads.ok) return threads;
    if (threads.threads.length > 0) next.threads = threads.threads;
    else delete next.threads;
  }

  for (const field of ['learns', 'knows'] as const) {
    if (patch[`${field}_add`] === undefined && patch[`${field}_remove`] === undefined) continue;
    const links = applyKnowledgeLinks(field, next[field] ?? [], patch, context);
    if (!links.ok) return links;
    if (links.links.length > 0) next[field] = links.links;
    else delete next[field];
  }

  return { ok: true, meta: next };
}

function linkKey(link: KnowledgeLinkRecord): string {
  return JSON.stringify([link.entryId, link.factId]);
}

function listCharacters(entries: SceneMetaContext['entries']): string {
  const characters = entries.filter((entry) => entry.type === 'character');
  if (characters.length === 0) return 'the codex has no character; create the entry first';
  return `valid characters are ${characters.map((e) => `${e.name} (${e.id})`).join(', ')}`;
}

function listFacts(facts: NonNullable<SceneMetaContext['facts']>): string {
  if (facts.length === 0) return 'there is no knowledge fact; add one first';
  return `valid facts are ${facts.map((f) => `"${f.text}" (${f.id})`).join(', ')}`;
}

/**
 * §4.4: removes the named pairs, then adds the new ones, keeping the order declared. A pair names a character of the codex and a
 * fact of the knowledge list, and every refusal names the field and lists what would have been valid.
 */
function applyKnowledgeLinks(
  field: 'learns' | 'knows',
  current: readonly KnowledgeLinkRecord[],
  patch: ScenePatch,
  context: SceneMetaContext,
): { readonly ok: true; readonly links: KnowledgeLinkRecord[] } | { readonly ok: false; readonly error: string } {
  const readPair = (raw: unknown, where: string): KnowledgeLinkRecord | string => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return `${where} must be an object with an entryId and a factId`;
    const { entryId, factId } = raw as Partial<Record<keyof KnowledgeLinkRecord, unknown>>;
    if (typeof entryId !== 'string' || entryId.trim() === '') return `${where}.entryId must be the id of a character in the codex`;
    if (typeof factId !== 'string' || factId.trim() === '') return `${where}.factId must be the id of a knowledge fact`;
    return { entryId, factId };
  };
  const removing = new Set<string>();
  const removed = patch[`${field}_remove`];
  if (removed !== undefined && !Array.isArray(removed)) return { ok: false, error: `${field}_remove must be a list of pairs` };
  for (const [index, raw] of (removed ?? []).entries()) {
    const pair = readPair(raw, `${field}_remove[${index}]`);
    if (typeof pair === 'string') return { ok: false, error: pair };
    removing.add(linkKey(pair));
  }
  const kept = new Map<string, KnowledgeLinkRecord>();
  for (const link of current) if (!removing.has(linkKey(link))) kept.set(linkKey(link), link);

  const added = patch[`${field}_add`];
  if (added !== undefined && !Array.isArray(added)) return { ok: false, error: `${field}_add must be a list of pairs` };
  for (const [index, raw] of (added ?? []).entries()) {
    const where = `${field}_add[${index}]`;
    const pair = readPair(raw, where);
    if (typeof pair === 'string') return { ok: false, error: pair };
    const entry = context.entries.find((candidate) => candidate.id === pair.entryId);
    if (entry === undefined) {
      return { ok: false, error: `${where}.entryId "${pair.entryId}" is not a codex entry; ${listCharacters(context.entries)}` };
    }
    if (entry.type !== 'character') {
      return { ok: false, error: `${where}.entryId names ${entry.name}, which is not a character; ${listCharacters(context.entries)}` };
    }
    const facts = context.facts ?? [];
    if (!facts.some((fact) => fact.id === pair.factId)) {
      return { ok: false, error: `${where}.factId "${pair.factId}" is not a knowledge fact; ${listFacts(facts)}` };
    }
    if (!kept.has(linkKey(pair))) kept.set(linkKey(pair), pair);
  }
  return { ok: true, links: [...kept.values()] };
}

/** The key two handles are compared by: trimmed, and without regard to case, as the finding's fact group lowercases it. */
function threadKey(id: string): string {
  return id.trim().toLowerCase();
}

function codePoints(text: string): number {
  return [...text].length;
}

/**
 * §5.5: removes the named handles, then adds the new threads, and returns the list sorted by handle. Every refusal names the
 * field, so an agent or a form can say which entry was wrong.
 */
function applyThreads(
  docId: string,
  current: readonly SceneThread[],
  patch: ScenePatch,
  context: SceneMetaContext,
): { readonly ok: true; readonly threads: SceneThread[] } | { readonly ok: false; readonly error: string } {
  const removing = new Set<string>();
  for (const [index, id] of (patch.threads_remove ?? []).entries()) {
    if (typeof id !== 'string') return { ok: false, error: `threads_remove[${index}] must be a handle, got ${String(id)}` };
    removing.add(threadKey(id));
  }
  const kept = new Map<string, SceneThread>();
  for (const thread of current) if (!removing.has(threadKey(thread.id))) kept.set(threadKey(thread.id), thread);

  for (const [index, raw] of (patch.threads_add ?? []).entries()) {
    const field = `threads_add[${index}]`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, error: `${field} must be an object with an id and a payoff` };
    }
    const { id, payoff, note } = raw as Partial<Record<keyof SceneThread, unknown>>;
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: `${field}.id must be a handle that is not blank` };
    }
    const handle = id.trim();
    if (codePoints(handle) > THREAD_ID_LIMIT) {
      return { ok: false, error: `${field}.id is ${codePoints(handle)} characters; the limit is ${THREAD_ID_LIMIT}` };
    }
    if (typeof payoff !== 'string' || payoff.trim() === '') {
      return { ok: false, error: `${field}.payoff must be the id of the document that pays the thread off` };
    }
    if (payoff === docId) return { ok: false, error: `${field}.payoff cannot be the scene that sets the thread up` };
    if (context.documentIds !== undefined && !context.documentIds.has(payoff)) {
      return { ok: false, error: `${field}.payoff names "${payoff}", which is not a document in this project` };
    }
    if (note !== undefined && typeof note !== 'string') return { ok: false, error: `${field}.note must be text` };
    const line = note === undefined ? '' : note.trim();
    if (codePoints(line) > THREAD_NOTE_LIMIT) {
      return { ok: false, error: `${field}.note is ${codePoints(line)} characters; the limit is ${THREAD_NOTE_LIMIT}` };
    }
    if (kept.has(threadKey(handle))) {
      return { ok: false, error: `${field}.id "${handle}" is already a thread on this scene; remove it first to change it` };
    }
    kept.set(threadKey(handle), line === '' ? { id: handle, payoff } : { id: handle, payoff, note: line });
  }
  const threads = [...kept.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, thread]) => thread);
  return { ok: true, threads };
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
  if (forward.threads_add !== undefined || forward.threads_remove !== undefined) {
    const was = new Map((prior.threads ?? []).map((thread) => [threadKey(thread.id), thread] as const));
    const now = new Map((after.threads ?? []).map((thread) => [threadKey(thread.id), thread] as const));
    const same = (a: SceneThread | undefined, b: SceneThread | undefined): boolean =>
      a !== undefined && b !== undefined && a.id === b.id && a.payoff === b.payoff && a.note === b.note;
    // A thread the patch edited is in both lists: it is removed as it is now, and added as it was.
    inverse.threads_add = [...was].filter(([key, thread]) => !same(thread, now.get(key))).map(([, thread]) => thread);
    inverse.threads_remove = [...now].filter(([key, thread]) => !same(thread, was.get(key))).map(([, thread]) => thread.id);
  }
  for (const field of ['learns', 'knows'] as const) {
    if (forward[`${field}_add`] === undefined && forward[`${field}_remove`] === undefined) continue;
    const was = new Map((prior[field] ?? []).map((link) => [linkKey(link), link] as const));
    const now = new Map((after[field] ?? []).map((link) => [linkKey(link), link] as const));
    inverse[`${field}_add`] = [...was].filter(([key]) => !now.has(key)).map(([, link]) => link);
    inverse[`${field}_remove`] = [...now].filter(([key]) => !was.has(key)).map(([, link]) => link);
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
