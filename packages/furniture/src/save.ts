/**
 * Save-time validation and clamps for saved filters and project goals — the rules the
 * `binder.saveFilter` and `project.saveGoal` commands apply before they write
 * ([binder-filters.md §2, §5](docs/architecture/binder-filters.md), [goals-progress.md §2.2, §4](docs/architecture/goals-progress.md)).
 *
 * Both functions are pure. They take the draft, the current state and an injected
 * clock, and return either the value to store or the reasons to refuse. The command
 * owns the write; this module owns what a legal write is.
 *
 * A filter's over-long values are clamped and the clamp is reported. A goal over its
 * count is refused, because a goal cannot be truncated.
 */
import { CROCKFORD_ALPHABET, ID_LENGTH } from '@caotang/ids';
import type { TreeNode } from '@caotang/store';

import { createBinderIndex } from './binder-index.js';
import { FILTER_ROOTS, vocabularyIds, type FilterRoot } from './criteria.js';
import { readCriteria } from './criteria-read.js';
import { isLocalDay, type LocalDay } from './day.js';
import { clampCodePoints, isWholeNumber } from './guards.js';
import {
  GOAL_COMPARATORS,
  GOAL_KINDS,
  isResetDayOf,
  sessionGoalProblems,
  type GoalComparator,
  type GoalKind,
  type GoalMetric,
  type ProjectGoal,
} from './goal.js';
import type { SavedFilter } from './filter-load.js';
import { MAX_FILTER_NAME_CHARS, MAX_GOALS, MAX_SAVED_FILTERS } from './limits.js';

/** The result of a save check: the value to write, or every reason it may not be written. */
export type SaveOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly clamped: readonly string[] }
  | { readonly ok: false; readonly errors: readonly string[] };

/** The manifest's vocabulary, as the save checks need it. */
export interface VocabularyShape {
  readonly statuses: readonly { readonly id: string }[];
  readonly labels: readonly { readonly id: string }[];
}

const FILTER_ID = new RegExp(`^q_[${CROCKFORD_ALPHABET}]{${ID_LENGTH}}$`);
const GOAL_ID = new RegExp(`^g_[${CROCKFORD_ALPHABET}]{${ID_LENGTH}}$`);

export interface SavedFilterDraft {
  /** Absent for a new filter; present for an update by id, or a new filter with a chosen id. */
  readonly id?: string;
  readonly name: string;
  /** Untrusted text from the caller, so it is typed as text and checked here. */
  readonly root?: string | null;
  /** The raw criteria as the caller holds them. Checked here, not trusted. */
  readonly criteria: unknown;
}

export interface SavedFilterSaveContext {
  readonly vocabulary: VocabularyShape;
  readonly existing: readonly SavedFilter[];
  readonly now: Date;
  /** Mints an id for a new filter. Required when the draft carries none. */
  readonly newId?: () => string;
}

/**
 * Create or update a saved filter. Refused for: a malformed id, a missing name, an
 * unknown root, a criterion the build does not know, a malformed criterion value, a
 * vocabulary id the project does not have, or a 51st filter. Over-long text, names and
 * arrays are clamped and each clamp is reported.
 */
export function prepareSavedFilter(draft: SavedFilterDraft, context: SavedFilterSaveContext): SaveOutcome<SavedFilter> {
  const errors: string[] = [];
  const clamped: string[] = [];

  const existing = draft.id === undefined ? undefined : context.existing.find((filter) => filter.id === draft.id);
  const id = draft.id ?? context.newId?.();
  if (id === undefined) {
    errors.push('a new saved filter needs an id, and no id generator was given');
  } else if (existing === undefined && !FILTER_ID.test(id)) {
    errors.push(`"${id}" is not a saved-filter id (q_ followed by 10 base32 characters)`);
  }
  if (existing === undefined && context.existing.length >= MAX_SAVED_FILTERS) {
    errors.push(`a project holds at most ${MAX_SAVED_FILTERS} saved filters`);
  }

  const name = readName(draft.name, errors, clamped);

  let root: FilterRoot | undefined;
  if (draft.root !== undefined && draft.root !== null) {
    if ((FILTER_ROOTS as readonly string[]).includes(draft.root)) root = draft.root as FilterRoot;
    else errors.push('root must be "manuscript" or "research", or absent for both');
  }

  const reading = readCriteria(draft.criteria);
  for (const key of reading.unknown) errors.push(`unknown criterion "${key}"`);
  errors.push(...reading.malformed);
  clamped.push(...reading.clamped);

  const vocabulary = vocabularyIds(context.vocabulary);
  if (reading.criteria.statusId !== undefined && !vocabulary.statusIds.has(reading.criteria.statusId)) {
    errors.push(`statusId "${reading.criteria.statusId}" is not a status in this project`);
  }
  if (reading.criteria.labelId !== undefined && !vocabulary.labelIds.has(reading.criteria.labelId)) {
    errors.push(`labelId "${reading.criteria.labelId}" is not a label in this project`);
  }

  if (errors.length > 0 || id === undefined || name === undefined) return { ok: false, errors };

  const now = context.now.toISOString();
  const value: SavedFilter = {
    id,
    name,
    ...(root !== undefined ? { root } : {}),
    criteria: reading.criteria,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  return { ok: true, value, clamped };
}

function readName(raw: unknown, errors: string[], clamped: string[]): string | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') {
    errors.push('a saved filter needs a name');
    return undefined;
  }
  const fitted = clampCodePoints(raw.trim(), MAX_FILTER_NAME_CHARS);
  if (fitted.clamped) clamped.push(`name clamped to ${MAX_FILTER_NAME_CHARS} characters`);
  return fitted.text;
}

export interface ProjectGoalDraft {
  /** Absent for a new goal; present for an update by id, or a new goal with a chosen id. */
  readonly id?: string;
  readonly nodeId: string;
  /** `words` (the default) or `chars` (goals-progress §9.2). */
  readonly metric?: string;
  /** `project` (the default), `weekly` or `monthly` (goals-progress §9.3). */
  readonly kind?: string | null;
  /** A weekly goal's reset weekday (0 Sunday to 6 Saturday) or a monthly goal's reset day (1 to 28, or `last`); goals-progress §9.3. */
  readonly resetDay?: number | string | null;
  readonly comparator: string;
  readonly target: number;
  readonly deadline?: string | null;
  readonly archived?: boolean | null;
}

export interface ProjectGoalSaveContext {
  readonly tree: readonly TreeNode[];
  readonly existing: readonly ProjectGoal[];
  readonly now: Date;
  /** Mints an id for a new goal. Required when the draft carries none. */
  readonly newId?: () => string;
}

/**
 * Create or update a project goal. Refused for: a malformed id; a node that is not the
 * manuscript root or a folder (a missing node counts); an unknown metric, kind or comparator;
 * a target that is not a positive whole number of words; a deadline that is not a real
 * date; a weekly or monthly goal (goals-progress §9.3) that is not on the manuscript root, is
 * not in words, is not `at-least`, or has a deadline; and a 21st goal. Nothing is clamped: a
 * goal's values are either right or refused.
 */
export function prepareProjectGoal(draft: ProjectGoalDraft, context: ProjectGoalSaveContext): SaveOutcome<ProjectGoal> {
  const errors: string[] = [];
  const index = createBinderIndex(context.tree);

  const existing = draft.id === undefined ? undefined : context.existing.find((goal) => goal.id === draft.id);
  const id = draft.id ?? context.newId?.();
  if (id === undefined) {
    errors.push('a new goal needs an id, and no id generator was given');
  } else if (existing === undefined && !GOAL_ID.test(id)) {
    errors.push(`"${id}" is not a goal id (g_ followed by 10 base32 characters)`);
  }
  if (existing === undefined && context.existing.length >= MAX_GOALS) {
    errors.push(`a project holds at most ${MAX_GOALS} goals`);
  }

  if (!index.isGoalTarget(draft.nodeId)) {
    errors.push(`goal target "${draft.nodeId}" must be the manuscript root or a folder`);
  }
  const metric: GoalMetric | undefined =
    draft.metric === undefined || draft.metric === 'words' ? 'words' : draft.metric === 'chars' ? 'chars' : undefined;
  if (metric === undefined) errors.push(`unknown metric "${draft.metric}"; goals measure words or characters`);
  let kind: GoalKind = 'project';
  if (draft.kind !== undefined && draft.kind !== null) {
    if ((GOAL_KINDS as readonly string[]).includes(draft.kind)) kind = draft.kind as GoalKind;
    else errors.push(`unknown kind "${draft.kind}"; a goal is project, weekly or monthly`);
  }
  const comparator = (GOAL_COMPARATORS as readonly string[]).includes(draft.comparator)
    ? (draft.comparator as GoalComparator)
    : undefined;
  if (comparator === undefined) errors.push(`unknown comparator "${draft.comparator}"`);
  if (!isWholeNumber(draft.target) || draft.target <= 0) {
    errors.push('target must be a positive whole number of words');
  }
  let deadline: LocalDay | undefined;
  if (draft.deadline !== undefined && draft.deadline !== null) {
    if (isLocalDay(draft.deadline)) deadline = draft.deadline;
    else errors.push('deadline must be a real date in YYYY-MM-DD form');
  }
  if (draft.archived !== undefined && draft.archived !== null && typeof draft.archived !== 'boolean') {
    errors.push('archived must be true or false');
  }
  errors.push(
    ...sessionGoalProblems({
      kind,
      nodeId: draft.nodeId,
      metric: draft.metric ?? 'words',
      comparator: draft.comparator,
      hasDeadline: draft.deadline !== undefined && draft.deadline !== null,
      resetDay: draft.resetDay,
    }),
  );
  const resetDay =
    (kind === 'weekly' || kind === 'monthly') && draft.resetDay !== undefined && draft.resetDay !== null && isResetDayOf(kind, draft.resetDay)
      ? draft.resetDay
      : undefined;

  if (errors.length > 0 || id === undefined || comparator === undefined || metric === undefined) return { ok: false, errors };

  const now = context.now.toISOString();
  const value: ProjectGoal = {
    id,
    nodeId: draft.nodeId,
    metric,
    ...(kind !== 'project' ? { kind } : {}),
    ...(resetDay !== undefined ? { resetDay } : {}),
    comparator,
    target: draft.target,
    ...(deadline !== undefined ? { deadline } : {}),
    ...(draft.archived === true ? { archived: true } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  return { ok: true, value, clamped: [] };
}
