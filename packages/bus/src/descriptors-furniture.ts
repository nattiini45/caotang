/**
 * The writing-furniture commands: saved binder filters and project goals
 * ([binder-filters.md §5](docs/architecture/binder-filters.md), [goals-progress.md §4](docs/architecture/goals-progress.md)).
 *
 * Four names, one descriptor each: `binder.saveFilter`, `binder.deleteFilter`, `project.saveGoal` and
 * `project.deleteGoal`. Their applies are the store's (`packages/store/src/commands-furniture.ts`), because the
 * two lists they write are the manifest's `filters[]` and `goals[]`. Both spec tables mark them write-auto with
 * an exact inverse, and neither is an agent tool.
 *
 * The bus cannot import `@caotang/furniture` (that package imports the store, which imports the bus), so the
 * checks it can make without the store live here: the id shapes, the field types, the vocabulary a criterion
 * names, the node a goal attaches to, and the per-value limits. The furniture package's `prepareSavedFilter`
 * and `prepareProjectGoal` carry the same rules and clamp an over-long name first, so a draft the writer can
 * make is never refused here. The two checks that need the whole list (the count, and whether an id exists)
 * are the store's, and it refuses them before it writes anything.
 */

import { ok, type CommandError, type Result } from './result.js';
import type { CommandDescriptor, ValidationNode, ValidationSnapshot } from './command.js';
import {
  findNode,
  invalid,
  invalidError,
  isRecord,
  limitExceededError,
  requireDeclaredParams,
} from './params.js';

/** The two roots a saved filter may be scoped to (binder-filters §2). */
export type FurnitureRoot = 'manuscript' | 'research';

/** A saved filter as the bus takes it (binder-filters §2): the id is optional, and the store mints one when it is absent. */
export interface SavedFilterParams {
  readonly id?: string;
  readonly name: string;
  readonly root?: FurnitureRoot;
  readonly criteria: Readonly<Record<string, unknown>>;
}

/** `binder.saveFilter` (binder-filters §5): create when the id is new, update by id when it exists. */
export type BinderSaveFilterParams = { readonly filter: SavedFilterParams };

/** `binder.deleteFilter` (binder-filters §5): removes a saved query, metadata and not content. */
export type BinderDeleteFilterParams = { readonly filterId: string };

/** The comparators of goals-progress §2.2, which the bus names here so the goal shape reads from one place. */
export type GoalComparatorParam = 'at-least' | 'at-most' | 'about';

/** What a goal measures (goals-progress §2.2, §9.2): words, or characters counted as non-whitespace code points. */
export type GoalMetricParam = 'words' | 'chars';

/** The kinds a goal takes (goals-progress §9.3): a project goal, or a weekly or monthly session window attached to the manuscript. */
export type GoalKindParam = 'project' | 'weekly' | 'monthly';

/** A weekly goal's reset weekday (0 to 6) or a monthly goal's reset day (1 to 28, or `last`), goals-progress §9.3. */
export type GoalResetDayParam = number | 'last';

/**
 * A project goal as the bus takes it (goals-progress §2.2). The store mints an id when none is given. `metric` and `kind` are
 * optional and default to words and project. The validator returns `metric` only for characters and `kind` only for a session kind,
 * so a goal of the default kind and metric has the same shape it always had.
 */
export interface ProjectGoalParams {
  readonly id?: string;
  readonly nodeId: string;
  readonly metric?: GoalMetricParam;
  readonly kind?: GoalKindParam;
  /**
   * goals-progress §9.3: the day a weekly goal's week starts on (0 Sunday to 6 Saturday), or the day a monthly goal's month starts on
   * (1 to 28, or `last` for each month's last day). Absent means the default: the locale's first weekday, or the 1st.
   */
  readonly resetDay?: GoalResetDayParam;
  readonly comparator: GoalComparatorParam;
  readonly target: number;
  /** A calendar date, `YYYY-MM-DD`. Absent means open-ended. */
  readonly deadline?: string;
  readonly archived?: boolean;
}

/** `project.saveGoal` (goals-progress §4): create when the id is new, update by id when it exists. */
export type ProjectSaveGoalParams = { readonly goal: ProjectGoalParams };

/** `project.deleteGoal` (goals-progress §4): removes a goal, metadata and not content. */
export type ProjectDeleteGoalParams = { readonly goalId: string };

/* ------------------------------------------------------------------ *
 * The limits and the shapes they check. Each is quoted from the spec
 * that states it, as descriptors.ts does for its own.
 * ------------------------------------------------------------------ */

/** binder-filters §2: `name` ≤ 60 characters. */
export const FILTER_NAME_MAX = 60;
/** binder-filters §2: `text` ≤ 200 characters. */
const TEXT_MAX = 200;
/** binder-filters §2 and project-format §2: each criteria array ≤ 32 entries, a tag ≤ 64 characters. */
const CRITERIA_ARRAY_MAX = 32;
const TAG_MAX = 64;
/** binder-filters §2: ≤ 50 saved filters per project (the store checks the count). */
export const SAVED_FILTERS_MAX = 50;
/** goals-progress §2.2: ≤ 20 goals per project (the store checks the count). */
export const GOALS_MAX = 20;

/**
 * The criteria keys this build knows (binder-filters §2, §2.1). A key outside the list is refused here, and the store's loader
 * (validate.ts) reads this same list to drop an unknown key from a saved filter on load — one record of the list, so the
 * command boundary and the load cannot drift apart.
 */
export const CRITERIA_KEYS: readonly string[] = [
  'text',
  'textIn',
  'statusId',
  'labelId',
  'keywordsAll',
  'keywordsAny',
  'minWords',
  'maxWords',
  'createdWithinDays',
  'modifiedWithinDays',
];

const SEARCH_SURFACES: readonly string[] = ['title', 'synopsis', 'body'];
const GOAL_COMPARATORS: readonly string[] = ['at-least', 'at-most', 'about'];
const GOAL_METRICS: readonly string[] = ['words', 'chars'];
const GOAL_KINDS: readonly string[] = ['project', 'weekly', 'monthly'];
const FILTER_KEYS: readonly string[] = ['id', 'name', 'root', 'criteria'];
const GOAL_KEYS: readonly string[] = ['id', 'nodeId', 'metric', 'kind', 'resetDay', 'comparator', 'target', 'deadline', 'archived'];
/** goals-progress §9.3: every month has a 28th, so a monthly goal resets on a day up to it, or on the month's last day. */
const MONTHLY_RESET_MAX = 28;

/** Crockford base32, as the id generators draw it (`@caotang/ids`). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const FILTER_ID = new RegExp(`^q_[${CROCKFORD}]{10}$`);
const GOAL_ID = new RegExp(`^g_[${CROCKFORD}]{10}$`);
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar day, not just a shape: `2026-02-30` is refused. */
function isRealDay(value: string): boolean {
  const match = DAY.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const at = new Date(Date.UTC(year, month - 1, day));
  return at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day;
}

function codePoints(text: string): number {
  return [...text].length;
}

/**
 * Whether a saved filter's name is one the bus accepts: at most
 * `FILTER_NAME_MAX` characters, counted in code points.
 *
 * The count is in code points and not in `.length` (UTF-16 units), so a name
 * of 31 emoji is 31 characters and not 62 — the writer may give a name that
 * long, and the store's loader, which drops a filter whose name the bus would
 * refuse, reads this same rule (`packages/store/src/validate.ts`). One record
 * of it, so the two halves cannot drift apart: `.length` here would refuse a
 * name of 31 emoji that the bus accepts.
 */
export function filterNameFits(name: string): boolean {
  return codePoints(name.trim()) <= FILTER_NAME_MAX;
}

/* ------------------------------------------------------------------ *
 * Saved filters
 * ------------------------------------------------------------------ */

/** Reads a filter draft the way the bus takes one: its shape, its id, its name, its root and its criteria. */
function readFilter(raw: unknown, snapshot: ValidationSnapshot): Result<SavedFilterParams, CommandError> {
  if (!isRecord(raw)) {
    return invalid(
      'params.filter must be an object with a name and criteria',
      'pass { filter: { name, criteria } }, with criteria {} for a filter that matches everything',
      'filter',
    );
  }
  for (const key of Object.keys(raw)) {
    if (!FILTER_KEYS.includes(key)) {
      return invalid(`params.filter.${key} is not a saved-filter field`, `a saved filter carries only: ${FILTER_KEYS.join(', ')}`, `filter.${key}`);
    }
  }

  let id: string | undefined;
  if (raw['id'] !== undefined) {
    if (typeof raw['id'] !== 'string' || !FILTER_ID.test(raw['id'])) {
      return invalid(
        `"${String(raw['id'])}" is not a saved-filter id`,
        'a saved-filter id is q_ followed by 10 base32 characters, or leave the id out and one is made',
        'filter.id',
      );
    }
    id = raw['id'];
  }

  const name = raw['name'];
  if (typeof name !== 'string' || name.trim() === '') {
    return invalid('a saved filter needs a name', `give the filter a name of up to ${FILTER_NAME_MAX} characters`, 'filter.name');
  }
  const trimmed = name.trim();
  if (!filterNameFits(trimmed)) {
    return invalid(`the filter name is ${codePoints(trimmed)} characters`, `a name is at most ${FILTER_NAME_MAX} characters`, 'filter.name');
  }

  let root: FurnitureRoot | undefined;
  if (raw['root'] !== undefined) {
    if (raw['root'] !== 'manuscript' && raw['root'] !== 'research') {
      return invalid('root must be "manuscript" or "research"', 'leave root out to search both roots', 'filter.root');
    }
    root = raw['root'];
  }

  const criteria = readCriteria(raw['criteria'], snapshot);
  if (!criteria.ok) return criteria;

  return ok({
    ...(id !== undefined ? { id } : {}),
    name: trimmed,
    ...(root !== undefined ? { root } : {}),
    criteria: criteria.value,
  });
}

/** Checks each criterion against its own rule, and copies the criteria so the caller's object is never kept. */
function readCriteria(raw: unknown, snapshot: ValidationSnapshot): Result<Readonly<Record<string, unknown>>, CommandError> {
  if (!isRecord(raw)) {
    return invalid('filter.criteria must be an object', 'pass {} for a filter that matches everything', 'filter.criteria');
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (!CRITERIA_KEYS.includes(key)) {
      return invalid(`criterion "${key}" is not one this build knows`, `a criterion is one of: ${CRITERIA_KEYS.join(', ')}`, `filter.criteria.${key}`);
    }
    const checked = checkCriterion(key, value, snapshot);
    if (!checked.ok) return checked;
    out[key] = checked.value;
  }
  return ok(out);
}

function checkCriterion(key: string, value: unknown, snapshot: ValidationSnapshot): Result<unknown, CommandError> {
  const target = `filter.criteria.${key}`;
  switch (key) {
    case 'text':
      if (typeof value !== 'string') return invalid('text must be a string', 'pass the words to search for', target);
      if (codePoints(value) > TEXT_MAX) {
        return invalid(`text is ${codePoints(value)} characters`, `text is at most ${TEXT_MAX} characters`, target);
      }
      return ok(value);
    case 'textIn': {
      if (!Array.isArray(value) || value.length > SEARCH_SURFACES.length) {
        return invalid('textIn must be a list of title, synopsis and body', 'name the surfaces text searches, or leave textIn out for all three', target);
      }
      for (const surface of value) {
        if (typeof surface !== 'string' || !SEARCH_SURFACES.includes(surface)) {
          return invalid(`"${String(surface)}" is not a search surface`, `a surface is one of: ${SEARCH_SURFACES.join(', ')}`, target);
        }
      }
      return ok([...value]);
    }
    case 'statusId':
      return vocabularyId(value, 'status', snapshot.manifest.vocabulary.statuses, target);
    case 'labelId':
      return vocabularyId(value, 'label', snapshot.manifest.vocabulary.labels, target);
    case 'keywordsAll':
    case 'keywordsAny':
      return tagList(value, target);
    case 'minWords':
    case 'maxWords':
      if (!Number.isSafeInteger(value) || (value as number) < 0) {
        return invalid(`${key} must be a whole number of words, zero or more`, 'pass a whole number', target);
      }
      return ok(value);
    case 'createdWithinDays':
    case 'modifiedWithinDays':
      if (!Number.isSafeInteger(value) || (value as number) < 1) {
        return invalid(`${key} must be a whole number of days, one or more`, 'pass a whole number of days', target);
      }
      return ok(value);
    default:
      return invalid(`criterion "${key}" is not one this build knows`, `a criterion is one of: ${CRITERIA_KEYS.join(', ')}`, target);
  }
}

/** A status or label criterion names a vocabulary id that must exist at save time (binder-filters §2). */
function vocabularyId(
  value: unknown,
  kind: 'status' | 'label',
  terms: readonly { readonly id: string }[],
  target: string,
): Result<unknown, CommandError> {
  if (typeof value !== 'string' || value === '') {
    return invalid(`${kind} must be a vocabulary id`, `pick a ${kind} from this project's vocabulary`, target);
  }
  if (!terms.some((term) => term.id === value)) {
    return invalid(`"${value}" is not a ${kind} in this project`, `pick a ${kind} from this project's vocabulary`, target);
  }
  return ok(value);
}

/** A tag list: at most 32 entries, each a non-blank tag of at most 64 characters (project-format §2). */
function tagList(value: unknown, target: string): Result<unknown, CommandError> {
  if (!Array.isArray(value) || value.length > CRITERIA_ARRAY_MAX) {
    return invalid(`${target.split('.').pop()} must be a list of at most ${CRITERIA_ARRAY_MAX} tags`, 'keep the tag list short', target);
  }
  for (const tag of value) {
    if (typeof tag !== 'string' || tag.trim() === '' || codePoints(tag) > TAG_MAX) {
      return invalid(`"${String(tag)}" is not a tag`, `a tag is a non-blank string of at most ${TAG_MAX} characters`, target);
    }
  }
  return ok([...value]);
}

/* ------------------------------------------------------------------ *
 * Project goals
 * ------------------------------------------------------------------ */

function readGoal(raw: unknown, snapshot: ValidationSnapshot): Result<ProjectGoalParams, CommandError> {
  if (!isRecord(raw)) {
    return invalid(
      'params.goal must be an object with a node, a comparator and a target',
      'pass { goal: { nodeId, comparator, target } }',
      'goal',
    );
  }
  for (const key of Object.keys(raw)) {
    if (!GOAL_KEYS.includes(key)) {
      return invalid(`params.goal.${key} is not a goal field`, `a goal carries only: ${GOAL_KEYS.join(', ')}`, `goal.${key}`);
    }
  }

  let id: string | undefined;
  if (raw['id'] !== undefined) {
    if (typeof raw['id'] !== 'string' || !GOAL_ID.test(raw['id'])) {
      return invalid(
        `"${String(raw['id'])}" is not a goal id`,
        'a goal id is g_ followed by 10 base32 characters, or leave the id out and one is made',
        'goal.id',
      );
    }
    id = raw['id'];
  }

  const nodeId = raw['nodeId'];
  if (typeof nodeId !== 'string' || nodeId === '') {
    return invalid('a goal needs the node it attaches to', 'pass the manuscript root or a folder id', 'goal.nodeId');
  }
  const node: ValidationNode | undefined = findNode(snapshot, nodeId);
  if (node === undefined || !isGoalTarget(node)) {
    return invalid(
      `goal target "${nodeId}" must be the manuscript root or a folder`,
      'a goal attaches to the manuscript root or a folder, not to a scene; use binder.read_tree to list valid ids',
      'goal.nodeId',
    );
  }

  if (raw['metric'] !== undefined && (typeof raw['metric'] !== 'string' || !GOAL_METRICS.includes(raw['metric']))) {
    return invalid(`unknown metric "${String(raw['metric'])}"`, `a goal measures one of: ${GOAL_METRICS.join(', ')}`, 'goal.metric');
  }
  const metric: GoalMetricParam = raw['metric'] === 'chars' ? 'chars' : 'words';

  let kind: GoalKindParam = 'project';
  if (raw['kind'] !== undefined) {
    if (typeof raw['kind'] !== 'string' || !GOAL_KINDS.includes(raw['kind'])) {
      return invalid(`unknown kind "${String(raw['kind'])}"`, `a goal is one of: ${GOAL_KINDS.join(', ')}`, 'goal.kind');
    }
    kind = raw['kind'] as GoalKindParam;
  }

  const comparator = raw['comparator'];
  if (typeof comparator !== 'string' || !GOAL_COMPARATORS.includes(comparator)) {
    return invalid(
      `unknown comparator "${String(comparator)}"`,
      `a comparator is one of: ${GOAL_COMPARATORS.join(', ')}`,
      'goal.comparator',
    );
  }

  const target = raw['target'];
  if (!Number.isSafeInteger(target) || (target as number) <= 0) {
    return invalid('target must be a positive whole number of words', 'pass a target above zero', 'goal.target');
  }

  let deadline: string | undefined;
  if (raw['deadline'] !== undefined && raw['deadline'] !== null) {
    if (typeof raw['deadline'] !== 'string' || !isRealDay(raw['deadline'])) {
      return invalid('deadline must be a real date in YYYY-MM-DD form', 'pass a date such as 2026-10-31, or leave it out', 'goal.deadline');
    }
    deadline = raw['deadline'];
  }

  if (raw['archived'] !== undefined && raw['archived'] !== null && typeof raw['archived'] !== 'boolean') {
    return invalid('archived must be true or false', 'pass true or false', 'goal.archived');
  }

  // goals-progress §9.3: a weekly or monthly goal keeps four rules, and the first one it breaks is the refusal.
  const broken = sessionGoalProblem(kind, { nodeId: node.id, metric, comparator, hasDeadline: deadline !== undefined });
  if (broken !== undefined) return invalid(broken.message, broken.hint, 'goal');

  const resetDay = raw['resetDay'] === null ? undefined : raw['resetDay'];
  if (resetDay !== undefined) {
    const refused = resetDayProblem(kind, resetDay);
    if (refused !== undefined) return invalid(refused.message, refused.hint, 'goal.resetDay');
  }

  return ok({
    ...(id !== undefined ? { id } : {}),
    nodeId: node.id,
    ...(metric === 'chars' ? { metric } : {}),
    ...(kind !== 'project' ? { kind } : {}),
    ...(resetDay !== undefined ? { resetDay: resetDay as GoalResetDayParam } : {}),
    comparator: comparator as GoalComparatorParam,
    target: target as number,
    ...(deadline !== undefined ? { deadline } : {}),
    ...(raw['archived'] === true ? { archived: true } : {}),
  });
}

/**
 * The first rule a weekly or monthly goal breaks (goals-progress §9.3), or `undefined` for a project goal and for a session goal that
 * keeps every rule. The furniture package's `sessionGoalProblems` states the same rules in the same order. The bus cannot import
 * it, because the furniture package imports the store, which imports the bus, so the rules are written out here as well.
 */
function sessionGoalProblem(
  kind: GoalKindParam,
  goal: { readonly nodeId: string; readonly metric: GoalMetricParam; readonly comparator: string; readonly hasDeadline: boolean },
): { readonly message: string; readonly hint: string } | undefined {
  if (kind === 'project') return undefined;
  if (goal.nodeId !== 'manuscript') {
    return {
      message: `a ${kind} goal counts the whole project, so it attaches to the manuscript root`,
      hint: 'set the goal on the manuscript, or make it a project goal',
    };
  }
  if (goal.metric !== 'words') {
    return { message: `a ${kind} goal counts words, because a session records words`, hint: 'count words, or make it a project goal' };
  }
  if (goal.comparator !== 'at-least') {
    return {
      message: `a ${kind} goal is a minimum, so its comparator is at-least`,
      hint: 'compare with at-least, or make it a project goal',
    };
  }
  if (goal.hasDeadline) {
    return {
      message: `a ${kind} goal recurs, so it takes no deadline`,
      hint: 'leave the deadline out, or make it a project goal',
    };
  }
  return undefined;
}

/**
 * Why a reset day does not fit its goal (goals-progress §9.3), or `undefined` when it does: a weekly goal takes a weekday 0 to 6, a
 * monthly goal a day 1 to 28 or `last`, and a project goal none. The furniture package's `sessionGoalProblems` words the same rules.
 */
function resetDayProblem(kind: GoalKindParam, value: unknown): { readonly message: string; readonly hint: string } | undefined {
  if (kind === 'project') {
    return { message: 'a project goal does not reset, so it takes no reset day', hint: 'leave resetDay out, or make it a weekly or monthly goal' };
  }
  if (kind === 'weekly') {
    if (Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 6) return undefined;
    return {
      message: 'a weekly goal resets on a weekday, 0 (Sunday) to 6 (Saturday)',
      hint: 'pass a weekday from 0 to 6, or leave resetDay out for the first day of the week in the writer\'s locale',
    };
  }
  if (value === 'last' || (Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MONTHLY_RESET_MAX)) return undefined;
  return {
    message: 'a monthly goal resets on a day from 1 to 28, or on "last" for the last day of the month',
    hint: 'pass a day from 1 to 28 or "last", or leave resetDay out for the 1st',
  };
}

/** goals-progress §2.2: the manuscript root or a folder. A scene is not a goal target. */
function isGoalTarget(node: ValidationNode): boolean {
  return node.type === 'folder' || node.id === 'manuscript';
}

/* ------------------------------------------------------------------ *
 * The four descriptors
 * ------------------------------------------------------------------ */

export const binderSaveFilter: CommandDescriptor<BinderSaveFilterParams> = {
  mutates: 'project',
  agentRisk: 'write-auto',
  undo: 'inverse',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('binder.saveFilter', params);
    if (!p.ok) return p;
    const filter = readFilter(p.value['filter'], snapshot);
    if (!filter.ok) return filter;
    return ok({ filter: filter.value });
  },
};

export const binderDeleteFilter: CommandDescriptor<BinderDeleteFilterParams> = {
  mutates: 'project',
  agentRisk: 'write-auto',
  undo: 'inverse',
  validate: (params) => {
    const p = requireDeclaredParams('binder.deleteFilter', params);
    if (!p.ok) return p;
    const filterId = p.value['filterId'];
    if (typeof filterId !== 'string' || filterId === '') {
      return invalid('params.filterId must name a saved filter', 'pass the id of a saved filter', 'filterId');
    }
    return ok({ filterId });
  },
};

export const projectSaveGoal: CommandDescriptor<ProjectSaveGoalParams> = {
  mutates: 'project',
  agentRisk: 'write-auto',
  undo: 'inverse',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('project.saveGoal', params);
    if (!p.ok) return p;
    const goal = readGoal(p.value['goal'], snapshot);
    if (!goal.ok) return goal;
    return ok({ goal: goal.value });
  },
};

export const projectDeleteGoal: CommandDescriptor<ProjectDeleteGoalParams> = {
  mutates: 'project',
  agentRisk: 'write-auto',
  undo: 'inverse',
  validate: (params) => {
    const p = requireDeclaredParams('project.deleteGoal', params);
    if (!p.ok) return p;
    const goalId = p.value['goalId'];
    if (typeof goalId !== 'string' || goalId === '') {
      return invalid('params.goalId must name a goal', 'pass the id of a project goal', 'goalId');
    }
    return ok({ goalId });
  },
};

/** The errors the store's applies raise for what only the whole list can show, in the bus's own shapes. */
export const furnitureErrors = {
  filterCount: (): CommandError =>
    limitExceededError(
      `a project holds at most ${SAVED_FILTERS_MAX} saved filters`,
      'delete a saved filter before saving another',
      'binder.saveFilter',
    ),
  goalCount: (): CommandError =>
    limitExceededError(
      `a project holds at most ${GOALS_MAX} goals`,
      'delete a goal before adding another',
      'project.saveGoal',
    ),
  filterMissing: (id: string): CommandError =>
    invalidError(`no saved filter with id "${id}"`, 'the filter may already be deleted; read the saved filters in the binder rail', id),
  goalMissing: (id: string): CommandError =>
    invalidError(`no goal with id "${id}"`, 'the goal may already be deleted; read the goals in the inspector', id),
  goalTargetMissing: (nodeId: string): CommandError =>
    invalidError(
      `goal target "${nodeId}" is not the manuscript root or a folder any more`,
      'attach the goal to the manuscript root or a folder that still exists',
      nodeId,
    ),
};
