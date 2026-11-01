/**
 * The writing furniture's state for one open project: the saved binder filters and project goals, the filter the binder is
 * showing, the sprint timer, and the draft the filter bar holds (binder-filters §5, goals-progress §4, sprint timer).
 *
 * **Where the saved filters and goals live.** In the manifest, as `filters[]` and `goals[]` (binder-filters §4, goals-progress
 * §3). Every save and delete is a bus command (`binder.saveFilter`, `binder.deleteFilter`, `project.saveGoal`,
 * `project.deleteGoal`), so it is undoable, logged and saved with the project. This store reads the two lists from the
 * manifest through the furniture loaders, so a bad entry is dropped by name and never blocks the rest.
 *
 * **The app database's copy, moved once.** Earlier builds kept both lists in the app database, keyed by project. On open,
 * any stored entry the manifest does not hold yet is saved through its command. Each such save is a bus command, so it is
 * logged and saved with the project, but its undo group is then forgotten (`UndoStore.forget`): an undo cannot take a moved
 * entry out of the binder, because the writer did not make the move and the stored copy is the only other record of it. Once
 * the project has saved those changes, the stored record is marked as moved and keeps its lists. A record whose entries the
 * bus refused, or whose save did not land, is left unmarked, so the next open tries again.
 *
 * The applied filter, the draft, and the sprint are view state: they are kept in memory and start again on a reload, as the
 * spec's view commands do (ui-modules §0.2).
 */

import { t } from '@lingui/core/macro';
import { isolate } from '@caotang/i18n';
import {
  createBinderIndex,
  createSprint,
  danglingVocabulary,
  evaluateFilter,
  goalCharsOf,
  parseProjectGoals,
  parseSavedFilters,
  prepareProjectGoal,
  prepareSavedFilter,
  sprintView,
  transitionSprint,
  vocabularyIds,
  wordsWrittenBetween,
  type BinderIndex,
  type FilterCriteria,
  type FilterResult,
  type GoalProbe,
  type ProjectGoal,
  type SavedFilter,
  type SaveOutcome,
  type SprintEvent,
  type SprintState,
  type SprintView,
  type VocabularyIds,
} from '@caotang/furniture';
import { CROCKFORD_ALPHABET } from '@caotang/ids';
import { getBody, type ProjectState, type SessionRecord } from '@caotang/store';

import { activeAppDb, type AppDb } from './app-db.js';
import type { ProjectSession } from './session.js';

/* lingui-set comment="Interpolated values: error, name, reason, refused" */

/** The app-database key for one project's stored furniture, read only by the one-time move into the manifest. */
export function furnitureKey(projectId: string): string {
  return `furniture:${projectId}`;
}

/** The filter the bar holds while the writer types. Empty fields are absent criteria. */
export interface FilterDraft {
  readonly text: string;
  readonly statusId: string;
  readonly labelId: string;
  /** Tags, comma-separated as typed: the node must carry every one (binder-filters §2). */
  readonly keywordsAll: string;
  /** Tags, comma-separated as typed: the node must carry at least one. */
  readonly keywordsAny: string;
  readonly minWords: string;
  readonly maxWords: string;
  /** binder-filters §2.1: `node.createdAt` within the last N days. */
  readonly createdWithinDays: string;
  /** binder-filters §2.1: `node.updatedAt` within the last N days. */
  readonly modifiedWithinDays: string;
}

export const EMPTY_DRAFT: FilterDraft = {
  text: '',
  statusId: '',
  labelId: '',
  keywordsAll: '',
  keywordsAny: '',
  minWords: '',
  maxWords: '',
  createdWithinDays: '',
  modifiedWithinDays: '',
};

/** The filter the binder shows: its criteria, and the name it was saved under when it came from a saved filter. */
export interface AppliedFilter {
  readonly criteria: FilterCriteria;
  readonly savedId: string | null;
  readonly name: string;
}

/** What the furniture components read. A new object on every change, so React sees each change. */
export interface FurnitureSnapshot {
  /** False until the one-time move from the app database has been attempted. */
  readonly ready: boolean;
  readonly filters: readonly SavedFilter[];
  readonly goals: readonly ProjectGoal[];
  /**
   * Every session line in this browser, which the weekly and monthly goals count their windows over (goals-progress §9.3). The binder
   * footer loads them and keeps them here, so the footer and the inspector read the same figures. Empty until the first load.
   */
  readonly sessions: readonly SessionRecord[];
  /** What the load dropped or could not read, one line each. */
  readonly notices: readonly string[];
  /** A save the store refused or could not make, in words. Cleared by the next successful change. */
  readonly failure: string | null;
  readonly draft: FilterDraft;
  readonly applied: AppliedFilter | null;
  readonly sprint: SprintState;
}

/** The app database's record for a project's furniture, in the shape the move reads. */
interface StoredFurniture {
  readonly filters?: readonly unknown[];
  readonly goals?: readonly unknown[];
  /** Set once every stored entry is in the manifest and the project has saved it. The lists stay in the record, so nothing is lost. */
  readonly moved?: boolean;
}

/** An id in the furniture families: a prefix, an underscore, and ten Crockford characters (binder-filters §2, goals-progress §2.2). */
export function furnitureId(prefix: 'q' | 'g', randomBytes: (n: number) => Uint8Array = defaultRandomBytes): string {
  let body = '';
  for (const byte of randomBytes(10)) body += CROCKFORD_ALPHABET[byte & 31] ?? '0';
  return `${prefix}_${body}`;
}

function defaultRandomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** The tags a comma-separated field names: trimmed, non-empty, de-duplicated without case, at most 32 (binder-filters §2). */
export function tagsOf(field: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of field.split(',')) {
    const tag = raw.trim();
    if (tag === '' || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    tags.push(tag);
  }
  return tags.slice(0, 32);
}

/** The fields of a draft as criteria: each present field is a criterion, each empty one is absent (binder-filters §2). */
export function criteriaOf(draft: FilterDraft): FilterCriteria {
  const criteria: FilterCriteria = {};
  const text = draft.text.trim();
  if (text !== '') criteria.text = text;
  if (draft.statusId !== '') criteria.statusId = draft.statusId;
  if (draft.labelId !== '') criteria.labelId = draft.labelId;
  const all = tagsOf(draft.keywordsAll);
  if (all.length > 0) criteria.keywordsAll = all;
  const any = tagsOf(draft.keywordsAny);
  if (any.length > 0) criteria.keywordsAny = any;
  const min = wholeOf(draft.minWords, 0);
  const max = wholeOf(draft.maxWords, 0);
  if (min !== undefined) criteria.minWords = min;
  if (max !== undefined) criteria.maxWords = max;
  const created = wholeOf(draft.createdWithinDays, 1);
  if (created !== undefined) criteria.createdWithinDays = created;
  const modified = wholeOf(draft.modifiedWithinDays, 1);
  if (modified !== undefined) criteria.modifiedWithinDays = modified;
  return criteria;
}

/** A draft as the bar shows it, from criteria a saved filter holds. */
export function draftOf(criteria: FilterCriteria): FilterDraft {
  return {
    text: criteria.text ?? '',
    statusId: criteria.statusId ?? '',
    labelId: criteria.labelId ?? '',
    keywordsAll: (criteria.keywordsAll ?? []).join(', '),
    keywordsAny: (criteria.keywordsAny ?? []).join(', '),
    minWords: criteria.minWords === undefined ? '' : String(criteria.minWords),
    maxWords: criteria.maxWords === undefined ? '' : String(criteria.maxWords),
    createdWithinDays: criteria.createdWithinDays === undefined ? '' : String(criteria.createdWithinDays),
    modifiedWithinDays: criteria.modifiedWithinDays === undefined ? '' : String(criteria.modifiedWithinDays),
  };
}

/**
 * The words a saved filter's vocabulary criteria read as when the project no longer holds the term: "Unknown status" and "Unknown
 * label" (binder-filters §2). Empty when every term the filter names still exists.
 */
export function unknownTermsOf(criteria: FilterCriteria, vocabulary: VocabularyIds): string[] {
  const dangling = danglingVocabulary(criteria, vocabulary);
  const words: string[] = [];
  if (criteria.statusId !== undefined && dangling.includes(criteria.statusId)) words.push(t`Unknown status`);
  if (criteria.labelId !== undefined && dangling.includes(criteria.labelId)) words.push(t`Unknown label`);
  return words;
}

/** A whole number at or above `min` as typed, or `undefined` when the field is empty or not such a number. */
function wholeOf(value: string, min: number): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= min ? parsed : undefined;
}

/** Whether a draft names any criterion at all. An empty draft is the reset state, which matches everything. */
export function isEmptyDraft(draft: FilterDraft): boolean {
  return Object.keys(criteriaOf(draft)).length === 0;
}

/**
 * The input a goal save takes from the footer or the inspector: the fields the writer set, before the furniture rules check them.
 * `metric` is `words` (the default) or `chars`; `kind` is `project` (the default), `weekly` or `monthly` (goals-progress §9.2, §9.3).
 */
export interface GoalInput {
  readonly id?: string;
  readonly nodeId: string;
  readonly metric?: string;
  readonly kind?: string | null;
  /** A weekly goal's reset weekday (0 to 6) or a monthly goal's reset day (1 to 28, or `last`); null for the default (§9.3). */
  readonly resetDay?: number | string | null;
  readonly comparator: string;
  readonly target: number;
  readonly deadline?: string | null;
  readonly archived?: boolean | null;
}

export class FurnitureStore {
  private readonly session: ProjectSession;
  private readonly db: AppDb | null;
  private readonly listeners = new Set<() => void>();
  private current: FurnitureSnapshot;
  /** The last derived lists, as text: a session change that leaves them as they were does not re-render the furniture. */
  private derivedKey = '';
  private loading: Promise<void> = Promise.resolve();

  constructor(session: ProjectSession, db: AppDb | null) {
    this.session = session;
    this.db = db;
    this.current = {
      ready: false,
      filters: [],
      goals: [],
      sessions: [],
      notices: [],
      failure: null,
      draft: EMPTY_DRAFT,
      applied: null,
      sprint: createSprint(),
    };
    this.session.subscribe(() => this.refresh());
    this.refresh();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  snapshot = (): FurnitureSnapshot => this.current;

  private set(patch: Partial<FurnitureSnapshot>): void {
    this.current = { ...this.current, ...patch };
    for (const listener of this.listeners) listener();
  }

  /**
   * Re-reads the two lists from the manifest through the furniture loaders. Called on every session change, so it stays
   * cheap: the lists are small, and the snapshot changes only when what the furniture shows does.
   */
  private refresh(): void {
    const manifest = this.session.state.manifest;
    const filters = parseSavedFilters(manifest.filters ?? []);
    const goals = parseProjectGoals(manifest.goals ?? [], manifest.tree);
    const notices = [...filters.notices.map((notice) => notice.message), ...goals.notices.map((notice) => notice.message)];
    const key = JSON.stringify([filters.filters, goals.goals, notices]);
    if (key === this.derivedKey) return;
    this.derivedKey = key;
    this.set({ filters: filters.filters, goals: goals.goals, notices });
  }

  /** Keeps the session lines the weekly and monthly goals count over (goals-progress §9.3). The footer calls it after each read. */
  setSessions(records: readonly SessionRecord[]): void {
    this.set({ sessions: records });
  }

  /**
   * The one-time move from the app database (see the file's header). Never throws. The move runs once per project open,
   * and a record it has moved is marked, so the next open skips it.
   */
  load(): Promise<void> {
    this.loading = this.move();
    return this.loading;
  }

  /** Whether the project's pending changes have reached the store: settles its saves, then reads the save state. */
  private async saved(): Promise<boolean> {
    try {
      await this.session.settle();
    } catch {
      return false;
    }
    return this.session.saveState() === 'saved';
  }

  /**
   * Takes a moved entry's undo group off the stack, so no undo can take the entry out (see the file's header). A dispatch that
   * registered no group has nothing to forget.
   */
  private keepMoved(groupId: string | undefined): void {
    if (groupId !== undefined) this.session.undo.forget(groupId);
  }

  private async move(): Promise<void> {
    if (this.db === null) {
      this.set({ ready: true });
      return;
    }
    let stored: StoredFurniture | undefined;
    try {
      stored = await this.db.get<StoredFurniture>(furnitureKey(this.session.projectId));
    } catch (error) {
      const reason = messageOf(error);
      this.set({
        ready: true,
        failure: t`The saved filters and goals could not be read from this browser, so none were moved into the project: ${{ error: reason }}`,
      });
      return;
    }
    const hasStored = (stored?.filters?.length ?? 0) + (stored?.goals?.length ?? 0) > 0;
    if (stored === undefined || stored.moved === true || !hasStored) {
      this.set({ ready: true });
      return;
    }

    const manifest = this.session.state.manifest;
    const held = new Set(manifest.filters?.map((filter) => filter.id) ?? []);
    const heldGoals = new Set(manifest.goals?.map((goal) => goal.id) ?? []);
    const filters = parseSavedFilters(stored.filters ?? []).filters;
    const goals = parseProjectGoals(stored.goals ?? [], manifest.tree).goals;
    const refused: string[] = [];
    for (const filter of filters) {
      if (held.has(filter.id)) continue;
      const result = this.session.dispatch('binder.saveFilter', {
        filter: {
          id: filter.id,
          name: filter.name,
          ...(filter.root !== undefined ? { root: filter.root } : {}),
          criteria: { ...filter.criteria },
        },
      });
      if (!result.ok) refused.push(t`“${{ name: isolate(filter.name) }}”: ${{ reason: result.error.message }}`);
      else this.keepMoved(result.value.undoGroupId);
    }
    for (const goal of goals) {
      if (heldGoals.has(goal.id)) continue;
      const result = this.session.dispatch('project.saveGoal', { goal: goalParamsOf(goal) });
      if (!result.ok) refused.push(t`a goal: ${{ reason: result.error.message }}`);
      else this.keepMoved(result.value.undoGroupId);
    }

    if (refused.length === 0) {
      // The moved entries must be saved in the project before the copy is marked. A save that did not land leaves the copy
      // unmarked, so the next open tries again; the entries already in the manifest are skipped then.
      if (!(await this.saved())) {
        this.set({
          ready: true,
          failure: t`The saved filters and goals were added to the project, but the project has not saved them yet. They are kept in this browser and will be tried again on the next open.`,
        });
        this.refresh();
        return;
      }
      try {
        await this.db.put(furnitureKey(this.session.projectId), { ...stored, moved: true });
      } catch (error) {
        const reason = messageOf(error);
        this.set({ ready: true, failure: t`The saved filters and goals moved into the project, but the stored copy could not be marked: ${{ error: reason }}` });
        this.refresh();
        return;
      }
      this.set({ ready: true, failure: null });
    } else {
      this.set({
        ready: true,
        failure: t`Some saved filters or goals could not be moved into the project, so they are kept in this browser and will be tried again on the next open. ${{ refused: refused.join(' ') }}`,
      });
    }
    this.refresh();
  }

  /* ---------------------------------------------------------------- *
   * The filter bar and the applied filter (view state)
   * ---------------------------------------------------------------- */

  /**
   * A change to the bar, as typed or chosen. The binder shows what the draft matches at once (the text is debounced by the
   * bar itself, binder-filters §5); an empty draft is the reset state and shows the whole binder.
   */
  setDraft(patch: Partial<FilterDraft>): void {
    const draft = { ...this.current.draft, ...patch };
    // A saved filter being edited stays the one being edited: its criteria change in the bar, and saving the bar updates it.
    const editing = this.current.applied;
    this.set({
      draft,
      applied: isEmptyDraft(draft) ? null : { criteria: criteriaOf(draft), savedId: editing?.savedId ?? null, name: editing?.name ?? '' },
    });
  }

  /** Applies a saved filter: the bar is filled with its criteria, and the binder shows its matches. */
  applySaved(filter: SavedFilter): void {
    this.set({ draft: draftOf(filter.criteria), applied: { criteria: filter.criteria, savedId: filter.id, name: filter.name } });
  }

  /** Clears the bar and shows the whole binder again. */
  clearFilter(): void {
    this.set({ draft: EMPTY_DRAFT, applied: null });
  }

  /* ---------------------------------------------------------------- *
   * Saved filters (binder.saveFilter, binder.deleteFilter)
   * ---------------------------------------------------------------- */

  /** Saves the current draft under a name, or updates the filter `id` with it. The furniture rules check it first; the bus checks it again. */
  saveFilter(name: string, id?: string): SaveOutcome<SavedFilter> {
    const manifest = this.session.state.manifest;
    const existing = id === undefined ? undefined : this.current.filters.find((filter) => filter.id === id);
    const outcome = prepareSavedFilter(
      {
        ...(id === undefined ? {} : { id }),
        name,
        ...(existing?.root !== undefined ? { root: existing.root } : {}),
        criteria: criteriaOf(this.current.draft),
      },
      {
        vocabulary: manifest.vocabulary,
        existing: this.current.filters,
        now: new Date(),
        newId: () => furnitureId('q'),
      },
    );
    if (!outcome.ok) {
      this.set({ failure: outcome.errors.join(' ') });
      return outcome;
    }
    const saved = outcome.value;
    const result = this.session.dispatch('binder.saveFilter', {
      filter: {
        id: saved.id,
        name: saved.name,
        ...(saved.root !== undefined ? { root: saved.root } : {}),
        criteria: { ...saved.criteria },
      },
    });
    if (!result.ok) {
      this.set({ failure: result.error.message });
      return { ok: false, errors: [result.error.message] };
    }
    this.set({ failure: null, applied: { criteria: saved.criteria, savedId: saved.id, name: saved.name } });
    this.refresh();
    return outcome;
  }

  /**
   * Deletes a saved filter. When it is the one the binder shows, the bar is cleared with it: the bar and the tree must agree
   * (binder-filters §5), so a deleted filter never leaves its criteria in the bar over a binder showing everything.
   */
  deleteFilter(id: string): void {
    const result = this.session.dispatch('binder.deleteFilter', { filterId: id });
    if (!result.ok) {
      this.set({ failure: result.error.message });
      return;
    }
    const applied = this.current.applied;
    this.set({
      failure: null,
      ...(applied?.savedId === id ? { applied: null, draft: EMPTY_DRAFT } : {}),
    });
    this.refresh();
  }

  /* ---------------------------------------------------------------- *
   * Project goals (project.saveGoal, project.deleteGoal)
   * ---------------------------------------------------------------- */

  saveGoal(draft: GoalInput): SaveOutcome<ProjectGoal> {
    const outcome = prepareProjectGoal(draft, {
      tree: this.session.state.manifest.tree,
      existing: this.current.goals,
      now: new Date(),
      newId: () => furnitureId('g'),
    });
    if (!outcome.ok) {
      this.set({ failure: outcome.errors.join(' ') });
      return outcome;
    }
    const result = this.session.dispatch('project.saveGoal', { goal: goalParamsOf(outcome.value) });
    if (!result.ok) {
      this.set({ failure: result.error.message });
      return { ok: false, errors: [result.error.message] };
    }
    this.set({ failure: null });
    this.refresh();
    return outcome;
  }

  deleteGoal(id: string): void {
    const result = this.session.dispatch('project.deleteGoal', { goalId: id });
    if (!result.ok) {
      this.set({ failure: result.error.message });
      return;
    }
    this.set({ failure: null });
    this.refresh();
  }

  /* ---------------------------------------------------------------- *
   * The sprint timer (view state)
   * ---------------------------------------------------------------- */

  sprintEvent(event: SprintEvent): void {
    this.set({ sprint: transitionSprint(this.current.sprint, event) });
  }

  /** The timer's reading, at `now`: the time left, the words gained, and the pace. */
  sprintReading(now: number): SprintView {
    return sprintView(this.current.sprint, now);
  }

  /** Words typed in the open sitting, the sprint's word sample. */
  sittingWords(): number {
    return this.session.sittingWords();
  }

  /** Resolves when the one-time move has settled. A test reads the store after this. */
  settled(): Promise<void> {
    return this.loading;
  }
}

/**
 * A goal as the bus takes one (`project.saveGoal`): the id the furniture rules gave it, and the fields the goal carries. The metric and
 * the kind are sent only when they are not the defaults, which is the shape the bus returns too.
 */
function goalParamsOf(goal: ProjectGoal): {
  id: string;
  nodeId: string;
  metric?: 'chars';
  kind?: 'weekly' | 'monthly';
  resetDay?: number | 'last';
  comparator: 'at-least' | 'at-most' | 'about';
  target: number;
  deadline?: string;
  archived?: boolean;
} {
  return {
    id: goal.id,
    nodeId: goal.nodeId,
    ...(goal.metric === 'chars' ? { metric: 'chars' as const } : {}),
    ...(goal.kind === 'weekly' || goal.kind === 'monthly' ? { kind: goal.kind } : {}),
    ...(goal.resetDay !== undefined ? { resetDay: goal.resetDay } : {}),
    comparator: goal.comparator,
    target: goal.target,
    ...(goal.deadline !== undefined ? { deadline: goal.deadline } : {}),
    ...(goal.archived === true ? { archived: true } : {}),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The binder's result set for a criteria set (binder-filters §3): the nodes that match, their ancestors, and the two roots.
 * Pure over the project, so the tree the binder shows and the count its bar shows are the same answer.
 */
export function filterResultFor(state: ProjectState, criteria: FilterCriteria, now: Date): FilterResult {
  const index = createBinderIndex(state.manifest.tree, state.manifest.derived.wordCounts);
  return evaluateFilter(
    { criteria },
    index,
    { bodyOf: (id) => getBody(state, id), now, vocabulary: vocabularyIds(state.manifest.vocabulary) },
  );
}

/**
 * The probe a goal's progress reads for one open project (goals-progress §2.2, §9.2, §9.3): the word and character sums of the binder,
 * whether a node is a goal's target, and the words written in a window of sessions. `sessions` is the log the footer loaded, and the
 * open sitting's words are added, because the log holds a sitting only once it ends. Characters are measured from the bodies when a
 * probe first asks for them, so a project with no `chars` goal is never read for them.
 */
export function goalProbeOf(session: ProjectSession, sessions: readonly SessionRecord[]): GoalProbe {
  const { state } = session;
  const wordCounts = state.manifest.derived.wordCounts;
  const index = createBinderIndex(state.manifest.tree, wordCounts);
  let measured: BinderIndex | undefined;
  return {
    wordsOf: (id) => index.wordsOf(id),
    isGoalTarget: (id) => index.isGoalTarget(id),
    charsOf: (id) => {
      measured ??= createBinderIndex(state.manifest.tree, wordCounts, charCountsOf(state));
      return measured.charsOf(id);
    },
    wordsWrittenIn: (span) => wordsWrittenBetween(sessions, span.from, span.to) + session.sittingWords(),
  };
}

/** The characters of each document's body, by id (goals-progress §9.2). A folder or the root carries none of its own. */
function charCountsOf(state: ProjectState): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const node of state.manifest.tree) {
    if (node.type === 'document') counts[node.id] = goalCharsOf(getBody(state, node.id));
  }
  return counts;
}

const stores = new WeakMap<ProjectSession, FurnitureStore>();

/** The furniture store of a session, made and moved the first time it is asked for. */
export function furnitureFor(session: ProjectSession): FurnitureStore {
  let store = stores.get(session);
  if (store === undefined) {
    store = new FurnitureStore(session, activeAppDb());
    stores.set(session, store);
    void store.load();
  }
  return store;
}
