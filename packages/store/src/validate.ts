/**
 * Load-time validation — [project-format.md §2 "Validation (load-time, in order)"](docs/architecture/project-format.md).
 *
 * The order is load-bearing and reproduced exactly:
 *   1. parse → hard fail "not a Caotang project" if app !== "caotang"
 *   2. formatVersion > current → refuse (never guess-upgrade); < current → migrate
 *   3. per-field schema validation, first violation reported with node id + field path
 *   4. referential integrity: parents resolve, ids unique, document ids have files
 *
 * Step 2's migration half is §6's registry (`migrations.ts`) and it runs *here*,
 * before step 3, because §2's order says the version gate comes first and step 3
 * can only judge a manifest at the version this build understands. The effective
 * manifest — the input, or its in-memory upgrade — is what steps 3 and 4 see, and
 * it is handed back on the report so the loader builds state from the same object
 * that was validated rather than re-deriving it.
 *
 * Orphan `docs/*.md` files are *imported as "Recovered" documents*, never deleted.
 * Unknown statuses/labels and unknown node types are kept and surfaced, never dropped.
 */

import {
  APP_ID,
  FIXED_ROOT_IDS,
  type Manifest,
  type TreeNode,
} from './manifest.js';
import {
  FIRST_FORMAT_VERSION,
  PRODUCTION_FORMAT,
  runMigrations,
  type AppliedMigration,
  type FormatContext,
} from './migrations.js';
import { CALENDAR_JSON_MAX_CHARS, CHAR_LIMIT_MAX, CRITERIA_KEYS, EPUB_IMAGE_MAX_PX_MAX, EPUB_IMAGE_MAX_PX_MIN, PICTURE_MODES, SCENE_NUMBER_OPTIONS, SCENE_STYLES, filterNameFits } from '@caotang/bus';
// The shapes the bus names for the furniture commands. The *values* the bus
// refuses at the command boundary are restated below, for the load; the types
// are the bus's own, so a value the bus does not know cannot be listed here.
import type {
  FurnitureRoot,
  GoalComparatorParam,
  GoalKindParam,
  GoalMetricParam,
} from '@caotang/bus';
import { isGeneratedId, isIdWithPrefix } from '@caotang/ids';
import { readAssetLinks, readAssetRecords, validateLinkSet } from '@caotang/pictures';
import { bodyNamesOf, isBodyType } from './paths.js';
import { isJsonNumber, jsonValueProblem } from './json-value.js';
import {
  CODEX_INCLUDE_POLICIES,
  CODEX_ORIGINS,
  CODEX_TYPES,
  coerceIncludePolicy,
  citationOffsetProblem,
  coerceOrigin,
  coerceType,
} from './codex-fields.js';
// One home for a limit. The bus owns these because it is the
// package store already depends on (store → bus, never the reverse), and it is
// where codex.md §7's command-boundary refusals quote them from. Two copies of
// a limit is the two-records-of-one-fact species this repo keeps paying for.
//
// The **keyword** limits are deliberately absent from that list: codex.md §2
// says "same limits as node keywords", and the node constants in this file are
// the record the codex row refers *to* — importing the bus's copy would make a
// node limit defined by a codex one.
import {
  CODEX_ALIAS_CHARS_MAX,
  CODEX_ALIASES_MAX,
  CODEX_DESCRIPTION_MAX,
  CODEX_EXCLUDE_CHARS_MAX,
  CODEX_EXCLUDE_MAX,
  CODEX_NAME_MAX,
  CODEX_SOURCES_MAX,
} from '@caotang/bus';

export interface ValidationError {
  /** e.g. `tree[4].order` — node id and field path, per §2.3 */
  path: string;
  message: string;
  /** true when the load cannot proceed at all (vs. a warning) */
  fatal: boolean;
}

export interface ValidationReport {
  ok: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
  /** orphan docs/*.md with no tree entry — imported as "Recovered", never deleted */
  orphans: string[];
  /**
   * §6 steps that ran, in order. Empty unless the manifest arrived at an older
   * `formatVersion` — which cannot happen until format v2 exists.
   */
  migrations: readonly AppliedMigration[];
  /**
   * The manifest steps 3–4 actually judged: the input, or its in-memory upgrade
   * per {@link migrations}. Absent only when step 1 or 2 failed outright. The
   * loader builds its state from this, so the validated object and the loaded
   * object can never be two different manifests.
   */
  manifest?: Manifest;
}

// §2's *node* keyword limits, kept as this file's own constants rather than
// imported from the bus: codex.md §2's `keywords` row says "same limits as node
// keywords", so node keywords are the definition and the bus's copy is the codex
// one. Both are 32 × 64 and `codex-keywords-match-node-limits` in the test file
// holds them together — a *test* rather than a shared constant because the two
// live in different packages and one of them is the older record.
const MAX_KEYWORDS = 32;
const MAX_KEYWORD_CHARS = 64;
const MAX_SYNOPSIS = 2000;
const MAX_NOTES = 50_000;
const ORDER_RENORMALIZE_THRESHOLD = 1_000_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Why a stored calendar cannot be kept, or `undefined` when it can. The store checks what any JSON holds (an object, a version number,
 * plain data, a bounded size) and leaves the calendar's own rules to `@caotang/timeline`, which sits above it.
 */
function calendarProblem(calendar: unknown): string | undefined {
  if (!isRecord(calendar)) return 'expected a calendar object';
  if (typeof calendar['version'] !== 'number' || !Number.isSafeInteger(calendar['version'])) return 'expected a calendar with a whole-number version';
  if (jsonValueProblem(calendar) !== undefined) return 'the calendar holds a value JSON cannot write';
  if (JSON.stringify(calendar).length > CALENDAR_JSON_MAX_CHARS) return `the calendar is longer than ${CALENDAR_JSON_MAX_CHARS.toLocaleString('en-US')} characters`;
  return undefined;
}

function isFixedRootId(id: unknown): boolean {
  return typeof id === 'string' && (FIXED_ROOT_IDS as readonly string[]).includes(id);
}

function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

/**
 * epub-metadata.md: `{ uuid: string, isbn?: string | null }`. The uuid is the identity a book is deduped on, so a block
 * that has one is kept whatever else is wrong with it. Only the uuid's presence decides that, not the ISBN's.
 */
function hasIdentifierUuid(v: unknown): boolean {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const uuid = (v as Record<string, unknown>)['uuid'];
  return typeof uuid === 'string' && uuid.trim() !== '';
}

/** The ISBN of an identifier block, when it has one, is a string or null. */
function hasValidIsbn(v: unknown): boolean {
  const isbn = (v as Record<string, unknown>)['isbn'];
  return isbn === undefined || isbn === null || typeof isbn === 'string';
}

/**
 * A dialogue table's character limit: a whole number from 1 to the bound `recipe.save` checks (dialogue-narrative.md §4). A limit
 * outside it is dropped on load, so a hand-edited manifest cannot keep a value the app would refuse to save.
 */
function isCharLimit(v: unknown): boolean {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= CHAR_LIMIT_MAX;
}

/** exporter.md §2 options: every key optional, and each one the type it names when present. */
function isRecipeOptions(v: unknown): boolean {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    (o['titlePage'] === undefined || typeof o['titlePage'] === 'boolean') &&
    (o['toc'] === undefined || typeof o['toc'] === 'boolean') &&
    (o['author'] === undefined || typeof o['author'] === 'string') &&
    (o['charLimit'] === undefined || isCharLimit(o['charLimit'])) &&
    (o['sceneNumbers'] === undefined || isSceneNumbers(o['sceneNumbers'])) &&
    (o['continued'] === undefined || typeof o['continued'] === 'boolean') &&
    (o['pageSize'] === undefined || o['pageSize'] === 'A4' || o['pageSize'] === 'Letter') &&
    (o['paperFrames'] === undefined || typeof o['paperFrames'] === 'boolean') &&
    (o['bleed'] === undefined || typeof o['bleed'] === 'boolean') &&
    (o['cropMarks'] === undefined || typeof o['cropMarks'] === 'boolean') &&
    (o['contentsLabel'] === undefined || typeof o['contentsLabel'] === 'string') &&
    (o['pictures'] === undefined || (typeof o['pictures'] === 'string' && (PICTURE_MODES as readonly string[]).includes(o['pictures']))) &&
    (o['epubImageMaxPx'] === undefined ||
      (typeof o['epubImageMaxPx'] === 'number' &&
        Number.isSafeInteger(o['epubImageMaxPx']) &&
        o['epubImageMaxPx'] >= EPUB_IMAGE_MAX_PX_MIN &&
        o['epubImageMaxPx'] <= EPUB_IMAGE_MAX_PX_MAX)) &&
    (o['epubKeepWebp'] === undefined || typeof o['epubKeepWebp'] === 'boolean') &&
    (o['keepPictureMetadata'] === undefined || typeof o['keepPictureMetadata'] === 'boolean') &&
    (o['timelinePictures'] === undefined || typeof o['timelinePictures'] === 'boolean')
  );
}

/**
 * The screenplay PDF's scene-number placement (screenplay.md §5.3): one the bus accepts. The set is the bus's own export, so
 * a placement the bus gains is kept here too, and a recipe's options are never dropped for it.
 */
function isSceneNumbers(v: unknown): v is (typeof SCENE_NUMBER_OPTIONS)[number] {
  return typeof v === 'string' && (SCENE_NUMBER_OPTIONS as readonly string[]).includes(v);
}

/** exporter.md §2's recipe shape, the three fields a recipe cannot do without. */
function isExportRecipe(v: unknown): boolean {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['name'] === 'string' &&
    r['name'] !== '' &&
    Array.isArray(r['includeRootIds']) &&
    (r['includeRootIds'] as unknown[]).every((id) => typeof id === 'string') &&
    typeof r['format'] === 'string' &&
    r['format'] !== '' &&
    (r['templateId'] === undefined || typeof r['templateId'] === 'string')
  );
}

// The values binder-filters §2 and goals-progress §2.2/§9.3 name, restated
// here for the load. The bus owns the same lists at the command boundary, where
// a value outside them is *refused*; these are the load's copy, and the load's
// half is the tolerant one — a value the bus would refuse is a value a hand
// edit, a sync conflict or a foreign writer put there, and the answer is to
// drop the entry that carries it, not to refuse the project. `satisfies` ties
// every entry to the bus's own union, so a value the bus does not know cannot
// be listed here.
const FILTER_ROOTS = ['manuscript', 'research'] as const satisfies readonly FurnitureRoot[];
const GOAL_COMPARATORS = ['at-least', 'at-most', 'about'] as const satisfies readonly GoalComparatorParam[];
const GOAL_METRICS = ['words', 'chars'] as const satisfies readonly GoalMetricParam[];
const GOAL_KINDS = ['project', 'weekly', 'monthly'] as const satisfies readonly GoalKindParam[];

/**
 * A criterion value the writer can write back as JSON (binder-filters §2's criteria).
 *
 * The bus's own check is stricter about *which* keys exist and what each one
 * means; this one is about the shape, because a criterion value the writer
 * cannot write is a filter the writer cannot save. A number has to be finite:
 * `JSON.stringify` writes NaN and Infinity as `null`, so keeping one would let
 * the next save silently change the value — and JSON itself parses `1e400` to
 * Infinity, which is how a file can carry one.
 */
function isCriterionValue(v: unknown): boolean {
  if (v === null) return true;
  if (isJsonNumber(v)) return true;
  if (typeof v === 'string' || typeof v === 'boolean') return true;
  if (Array.isArray(v)) return v.every((item) => typeof item === 'string');
  return false;
}

/**
 * A saved-filter or goal id of the shape the bus enforces at every command
 * boundary (`q_`/`g_` + 10 Crockford chars, binder-filters §2, goals-progress
 * §2.2). An id of another shape loads as a record no command can update, and
 * the undo of a delete of it refuses (the inverse replays the draft through the
 * same checks) — so the author could never edit it again, and could not take
 * back the deletion either. The load drops the entry with a warning. A codex id
 * of the wrong shape is refused more loudly — it fails the whole load — because
 * a codex entry has no half-measures: the manifest names it, so the load cannot
 * carry on without it.
 */
function isFurnitureId(prefix: 'q' | 'g', v: unknown): v is string {
  return typeof v === 'string' && v.startsWith(`${prefix}_`) && isGeneratedId(v);
}

/**
 * binder-filters §2's `SavedFilter`: the fields it cannot do without.
 *
 * The root is not among them, and neither are the timestamps' *values* — those
 * are checked here because the writer writes them unconditionally, so a filter
 * without them is a filter the writer cannot write back. The name has to be one
 * the writer could show: the bus refuses a blank one at save, and a name longer
 * than its limit, so neither can arrive from the writer — only from a hand edit
 * or a foreign writer. The length is the bus's own rule (`filterNameFits`), so
 * the load counts a name exactly as the bus counts it.
 */
function isSavedFilter(v: unknown): boolean {
  if (!isRecord(v)) return false;
  if (!isFurnitureId('q', v['id'])) return false;
  if (typeof v['name'] !== 'string' || v['name'].trim() === '') return false;
  if (!filterNameFits(v['name'])) return false;
  if (!isRecord(v['criteria'])) return false;
  if (!Object.values(v['criteria']).every(isCriterionValue)) return false;
  return isIsoDate(v['createdAt']) && isIsoDate(v['updatedAt']);
}

/**
 * A calendar day, `YYYY-MM-DD`, that the calendar agrees with (goals-progress §2.2's `deadline`).
 *
 * The shape alone is not enough: `2026-02-30` is a day-shaped string that names
 * no day, and a goal whose deadline names none is a goal that can never be
 * overdue.
 */
function isCalendarDay(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [year, month, day] = v.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Steps 1–3: parse, version gate, field schema. */
function validateFields(
  input: unknown,
  format: FormatContext,
): {
  manifest?: Manifest;
  errors: ValidationError[];
  migrations: readonly AppliedMigration[];
} {
  const errors: ValidationError[] = [];
  const fatal = (path: string, message: string) => errors.push({ path, message, fatal: true });
  const warn = (path: string, message: string) => errors.push({ path, message, fatal: false });

  if (!isRecord(input)) {
    fatal('$', 'not a Caotang project: manifest is not an object');
    return { errors, migrations: [] };
  }

  // Step 1
  if (input.app !== APP_ID) {
    fatal('app', `not a Caotang project: expected app "${APP_ID}", got ${JSON.stringify(input.app)}`);
    return { errors, migrations: [] };
  }

  // Step 2 — the version gate, in three parts. Only the middle one migrates.
  const version = input.formatVersion;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    fatal('formatVersion', `expected integer ≥ ${FIRST_FORMAT_VERSION}`);
    return { errors, migrations: [] };
  }
  if (version < FIRST_FORMAT_VERSION) {
    // §2's field table bounds `formatVersion` at "integer ≥ 1" and §6's first
    // line is "v1 is the first stable format" — so the space below v1 is not a
    // set of older formats to walk up from, it is input that never named a Caotang
    // format. Refusing it says exactly that, where "no migration from v0" would
    // read as if a v0 had existed and simply been forgotten.
    fatal(
      'formatVersion',
      `formatVersion ${version} is below v${FIRST_FORMAT_VERSION}, the first Caotang format; the version space starts at v${FIRST_FORMAT_VERSION}`,
    );
    return { errors, migrations: [] };
  }
  if (version > format.current) {
    fatal(
      'formatVersion',
      `formatVersion ${version} is newer than this build (${format.current}); refusing to guess-upgrade`,
    );
    return { errors, migrations: [] };
  }

  // Below current → §6's in-memory upgrade. A `MigrationError` thrown from here
  // propagates on purpose: §6 says a migration failure "aborts the open with the
  // project untouched", which is an abort rather than a field complaint.
  let source: Record<string, unknown> = input;
  let migrations: readonly AppliedMigration[] = [];
  if (version < format.current) {
    const result = runMigrations(format.registry, input, format.current);
    source = result.manifest;
    migrations = result.applied;
  }

  // Step 3 — project identity
  if (!isRecord(source.project)) {
    fatal('project', 'expected object');
    return { manifest: source as unknown as Manifest, errors, migrations };
  }
  const p = source.project;
  if (typeof p.id !== 'string' || !isGeneratedId(p.id)) {
    fatal('project.id', 'expected "p_" + 10 Crockford base32 chars');
  }
  if (typeof p.name !== 'string' || p.name.length === 0) {
    fatal('project.name', 'expected non-empty string');
  }
  if (!isIsoDate(p.createdAt)) fatal('project.createdAt', 'expected ISO-8601 date string');
  if (!isIsoDate(p.modifiedAt)) fatal('project.modifiedAt', 'expected ISO-8601 date string');

  // epub-metadata.md's additive slots and exporter.md's recipes. A malformed one is
  // dropped with a warning and never refused: the project still opens, and the export
  // falls back to the value it would derive. Removed from `source` so the next save
  // does not write back what the load rejected.
  const project = p as unknown as Record<string, unknown>;
  if (project['language'] !== undefined && (typeof project['language'] !== 'string' || project['language'] === '')) {
    warn('project.language', 'expected a non-empty BCP-47 tag; dropped, and the export derives one from the app locale');
    delete project['language'];
  }
  // A block with a uuid string keeps that uuid, so a book's identity never changes on a bad ISBN. Only a block with no uuid
  // at all is dropped, and the open then makes one (project-identity.ts), because there is nothing stored to keep.
  const identifier = project['identifier'];
  if (identifier !== undefined && !hasIdentifierUuid(identifier)) {
    warn('project.identifier', 'expected { uuid: "urn:uuid:…" }; dropped, and a new identifier is made for the project on open');
    delete project['identifier'];
  } else if (identifier !== undefined && !hasValidIsbn(identifier)) {
    warn('project.identifier.isbn', 'expected an ISBN string or null; dropped, and the identifier is kept');
    delete (identifier as Record<string, unknown>)['isbn'];
  }
  if (
    project['coverAssetId'] !== undefined &&
    project['coverAssetId'] !== null &&
    typeof project['coverAssetId'] !== 'string'
  ) {
    warn('project.coverAssetId', 'expected an asset id or null; dropped, and the export carries no cover');
    delete project['coverAssetId'];
  }
  if (project['author'] !== undefined && typeof project['author'] !== 'string') {
    warn('project.author', 'expected a string; dropped, and the exports carry no byline');
    delete project['author'];
  }
  // extensibility.md §10: the skills the writer turned off. A malformed list is dropped with a warning, which turns every skill on
  // again, and a skill that is on still waits for the writer's review before the agent is told about it.
  const disabledSkills = (source as unknown as Record<string, unknown>)['disabledSkills'];
  if (disabledSkills !== undefined && !(Array.isArray(disabledSkills) && disabledSkills.every((name) => typeof name === 'string'))) {
    warn('disabledSkills', 'expected a list of skill names; dropped, and every skill is on');
    delete (source as unknown as Record<string, unknown>)['disabledSkills'];
  }
  // timeline.md §3.8: the lens choice and the custom calendar. Anything malformed is dropped with a warning and the day lens is used, so a
  // bad setting never blocks a project from opening. A definition of a later version is kept whole: this build cannot read it, and the
  // timeline falls back to the day lens, but the next save must not delete a calendar a newer build wrote.
  const timeline = (source as unknown as Record<string, unknown>)['timeline'];
  if (timeline !== undefined) {
    if (!isRecord(timeline)) {
      warn('timeline', 'expected an object with a lens and a calendar; dropped, and the timeline uses the day lens');
      delete (source as unknown as Record<string, unknown>)['timeline'];
    } else {
      for (const name of Object.keys(timeline)) {
        if (name !== 'lens' && name !== 'calendar') {
          warn(`timeline.${name}`, 'unknown field; dropped on next save');
          delete timeline[name];
        }
      }
      const lens = timeline['lens'];
      if (lens !== undefined && lens !== 'day' && lens !== 'calendar') {
        warn('timeline.lens', 'expected "day" or "calendar"; dropped, and the timeline uses the calendar when there is one');
        delete timeline['lens'];
      }
      const calendar = timeline['calendar'];
      if (calendar !== undefined) {
        const reason = calendarProblem(calendar);
        if (reason !== undefined) {
          warn('timeline.calendar', `${reason}; dropped, and the timeline uses the day lens`);
          delete timeline['calendar'];
          if (timeline['lens'] === 'calendar') delete timeline['lens'];
        }
      }
      if (Object.keys(timeline).length === 0) delete (source as unknown as Record<string, unknown>)['timeline'];
    }
  }
  const recipes = (source as unknown as Record<string, unknown>)['recipes'];
  if (recipes !== undefined) {
    if (!Array.isArray(recipes)) {
      warn('recipes', 'expected an array of export recipes; dropped');
      delete (source as unknown as Record<string, unknown>)['recipes'];
    } else {
      const kept = recipes.filter((recipe, i) => {
        if (isExportRecipe(recipe)) {
          // A recipe whose options are malformed keeps its selection and loses only the options: the recipe is still
          // a saved selection the writer chose, and the options it cannot read fall back to the template's defaults.
          const options = (recipe as Record<string, unknown>)['options'];
          if (options !== undefined && !isRecipeOptions(options)) {
            warn(`recipes[${i}].options`, 'not a set of recipe options (titlePage, toc, author, charLimit, sceneNumbers, continued, pageSize, paperFrames, bleed, cropMarks, contentsLabel); dropped, and the recipe uses the template defaults');
            delete (recipe as Record<string, unknown>)['options'];
          }
          return true;
        }
        warn(`recipes[${i}]`, 'not an export recipe (name, includeRootIds, format); dropped');
        return false;
      });
      (source as unknown as Record<string, unknown>)['recipes'] = kept;
    }
  }

  // Step 3 — tree
  if (!Array.isArray(source.tree)) {
    fatal('tree', 'expected array');
    return { manifest: source as unknown as Manifest, errors, migrations };
  }

  // Step 3's vocabulary, off `source` like every other step-3 field. Reading
  // `input.vocabulary` instead would, after a migration, compare the *pre*-migration
  // ids while every node validated came from the post-migration tree. The
  // counterfactual is in `test/migration-path.test.ts`: a step that renames a
  // status term leaves the nodes pointing at an id the vocabulary no longer
  // defines, and reading `input` would silence the "unknown vocabulary id"
  // warning that manifest must raise.
  //
  // The terms are normalized here as well, because the writer writes each one's
  // `id`, `name` and `color` unconditionally (manifest-json.ts `term`): a term
  // whose name or color is not a string used to load silently and then make
  // every save throw. A term the writer cannot write is dropped with a warning,
  // and the nodes that named it keep their value as an unknown chip — the same
  // posture §2 gives an unknown vocabulary id on a node.
  let vocabulary: Record<string, unknown>;
  if (isRecord(source.vocabulary)) {
    vocabulary = source.vocabulary;
  } else {
    if (source.vocabulary !== undefined) {
      warn('vocabulary', 'expected an object of statuses and labels; replaced with an empty one, and the project opens with no terms');
    }
    vocabulary = { statuses: [], labels: [] };
    source.vocabulary = vocabulary;
  }
  for (const kind of ['statuses', 'labels'] as const) {
    const terms: unknown = vocabulary[kind];
    if (terms === undefined) {
      vocabulary[kind] = [];
      continue;
    }
    if (!Array.isArray(terms)) {
      warn(`vocabulary.${kind}`, 'expected an array of terms; replaced with an empty one');
      vocabulary[kind] = [];
      continue;
    }
    // The terms are filtered one by one, and an id the bus could not use is a
    // term the load drops: an empty id makes `''` a 'known' status id the bus
    // refuses, and a repeated id makes `vocabulary.upsert` edit only the first
    // match (the same posture the codex ids get).
    const seenTermIds = new Set<string>();
    vocabulary[kind] = terms.filter((term, i) => {
      if (
        !isRecord(term) ||
        typeof term['id'] !== 'string' ||
        typeof term['name'] !== 'string' ||
        typeof term['color'] !== 'string'
      ) {
        warn(`vocabulary.${kind}[${i}]`, 'expected { id, name, color } of strings; dropped, and the nodes that named it show an unknown chip');
        return false;
      }
      const id = term['id'];
      if (id === '') {
        warn(`vocabulary.${kind}[${i}].id`, 'expected a non-empty id; dropped, and the nodes that named it show an unknown chip');
        return false;
      }
      if (seenTermIds.has(id)) {
        warn(`vocabulary.${kind}[${i}].id`, `duplicate id "${id}"; dropped, and the first term keeps it`);
        return false;
      }
      seenTermIds.add(id);
      return true;
    });
  }
  const statusIds = new Set(
    (vocabulary.statuses as unknown[]).filter(isRecord).map((s) => String(s.id)),
  );
  const labelIds = new Set(
    (vocabulary.labels as unknown[]).filter(isRecord).map((s) => String(s.id)),
  );

  source.tree.forEach((raw, i) => {
    const at = `tree[${i}]`;
    if (!isRecord(raw)) {
      fatal(at, 'expected object');
      return;
    }
    const node = raw as Partial<TreeNode> & Record<string, unknown>;

    if (typeof node.id !== 'string' || node.id.length === 0) {
      fatal(`${at}.id`, 'expected non-empty string');
    } else if (!isFixedRootId(node.id) && !isIdWithPrefix('n', node.id)) {
      // §2's field table: `"n_" + 10 base32`, unique, with `root`/`manuscript`/
      // `research` as the reserved exception. Step 3 is "schema validation of
      // every field per the table above", so the *format* of the opaque handle
      // is a load-time contract and not a generation-time convention: a node
      // id is also a filename, and a manifest that carries `id: "chapter-1"`
      // would resolve to a file that the writer can never name.
      fatal(`${at}.id`, 'expected "n_" + 10 Crockford base32 chars, or a reserved root id');
    }
    if (!(node.parentId === null || typeof node.parentId === 'string')) {
      fatal(`${at}.parentId`, 'expected existing node id or null');
    }
    if (typeof node.type !== 'string' || node.type.length === 0) {
      fatal(`${at}.type`, 'expected non-empty string');
    } else if (node.type === 'root' && !isFixedRootId(node.id)) {
      // A `root` type outside the fixed roots is a schema violation, not a
      // media-track unknown type.
      fatal(`${at}.type`, 'only the fixed root may have type "root"');
    }
    if (typeof node.title !== 'string') {
      fatal(`${at}.title`, 'expected string');
    }
    if (typeof node.order !== 'number' || !Number.isInteger(node.order) || node.order < 0) {
      fatal(`${at}.order`, `expected integer ≥ 0, got ${JSON.stringify(node.order)}`);
    } else if (node.order > ORDER_RENORMALIZE_THRESHOLD) {
      warn(`${at}.order`, `order ${node.order} exceeds the renormalize threshold`);
    }

    for (const key of ['status', 'label'] as const) {
      const v = node[key];
      // An absent one gets the null the field table gives it: the writer writes
      // both unconditionally, and `null` is the documented "no status/label".
      if (v === undefined) {
        node[key] = null;
        continue;
      }
      if (v === null) continue;
      if (typeof v !== 'string') {
        fatal(`${at}.${key}`, 'expected vocabulary id or null');
        continue;
      }
      const known = key === 'status' ? statusIds : labelIds;
      // Unknown value on load → keep string, surface as chip, never drop data.
      if (known.size > 0 && !known.has(v)) {
        warn(`${at}.${key}`, `unknown vocabulary id "${v}"; kept as-is and shown as an unknown chip`);
      }
    }

    if (!Array.isArray(node.keywords)) {
      fatal(`${at}.keywords`, 'expected string[]');
    } else {
      if (node.keywords.length > MAX_KEYWORDS) {
        fatal(`${at}.keywords`, `max ${MAX_KEYWORDS} per node, got ${node.keywords.length}`);
      }
      node.keywords.forEach((k, j) => {
        if (typeof k !== 'string') fatal(`${at}.keywords[${j}]`, 'expected string');
        else if (k.length > MAX_KEYWORD_CHARS) {
          fatal(`${at}.keywords[${j}]`, `max ${MAX_KEYWORD_CHARS} chars, got ${k.length}`);
        }
      });
    }

    if (typeof node.synopsis !== 'string' || node.synopsis.length > MAX_SYNOPSIS) {
      fatal(`${at}.synopsis`, `expected string ≤ ${MAX_SYNOPSIS} chars`);
    }
    if (typeof node.notes !== 'string' || node.notes.length > MAX_NOTES) {
      fatal(`${at}.notes`, `expected string ≤ ${MAX_NOTES} chars`);
    }
    // The stamps are deleted rather than only reported: the writer writes a
    // present stamp unconditionally and refuses one that is not a string, so a
    // value kept here would make every save of this project throw. "Ignoring
    // field" has to mean the field is gone, the same way `kind` below is.
    if (node.createdAt !== undefined && !isIsoDate(node.createdAt)) {
      warn(`${at}.createdAt`, 'expected ISO-8601 date string; ignoring field');
      delete node.createdAt;
    }
    if (node.updatedAt !== undefined && !isIsoDate(node.updatedAt)) {
      warn(`${at}.updatedAt`, 'expected ISO-8601 date string; ignoring field');
      delete node.updatedAt;
    }
    // The media-track fields (project-format.md §2's media note). A kind is kept as the string it is, even an unknown
    // one, because the next version may add a kind this build does not know. A shot or container metadata value that
    // is not an object is dropped with a warning, the same way a malformed timestamp is: the engines read these
    // tolerantly, and a value that is not even an object cannot be read at all.
    if (node.kind !== undefined && typeof node.kind !== 'string') {
      warn(`${at}.kind`, 'expected a string; ignoring field');
      delete node.kind;
    }
    // The scene style (exporter.md §2): a string is kept as written, even one this build does not know, and named once so
    // the writer learns it will print as a normal scene; anything that is not a string cannot be one and goes.
    if (node.style !== undefined) {
      if (typeof node.style !== 'string') {
        warn(`${at}.style`, 'expected a string; ignoring field');
        delete node.style;
      } else if (!(SCENE_STYLES as readonly string[]).includes(node.style)) {
        warn(`${at}.style`, `unknown scene style "${node.style}"; kept as-is, and exports render the scene as normal`);
      }
    }
    for (const key of ['shot', 'dialogue', 'comic', 'comicPage'] as const) {
      const value = node[key];
      if (value === undefined) continue;
      if (!isRecord(value)) {
        warn(`${at}.${key}`, 'expected an object; ignoring field');
        delete node[key];
        continue;
      }
      // The writer writes this value as the JSON it is, so a value JSON cannot
      // hold — a number that is not finite, a BigInt, a value that is not there
      // — would make every save of this project refuse. The field goes instead,
      // the same way a malformed timestamp goes.
      const problem = jsonValueProblem(value);
      if (problem !== undefined) {
        warn(`${at}.${key}${problem.path}`, `expected a value JSON can hold (${problem.reason}); ignoring field`);
        delete node[key];
      }
    }
  });

  // Step 3 — codex[]. Additive in v1: absent = empty codex, so absence is
  // fine and only a *present but wrong* shape is fatal, mirroring the `tree`
  // branch above. Without the shape check every contract below would be
  // reachable only through a hand-built `CodexEntry`, which is not how a
  // manifest arrives — it arrives as JSON.
  //
  // **The two referential contracts (`attachments`, `sources[].docId`) are
  // deliberately NOT done here**, and the reason is an ordering fact rather than
  // a tidiness one: step 4 imports orphan `docs/*.md` as Recovered documents
  // *after* this returns, so an attachment naming a document that exists only as
  // a file is dangling here and resolved two steps later. Dropping it here would
  // delete exactly the link §2 step 4 exists to preserve — and `read.ts`'s
  // `dropDanglingAttachments` already runs over the whole codex once, after the
  // imports, which is the only point at which the answer is knowable. One
  // implementation, in the one place the question has an answer.
  validateCodex(source.codex, { fatal, warn });

  // Step 3 — the furniture the author's own saved work lives in: `filters[]`
  // (binder-filters §4) and `goals[]` (goals-progress §2.2/§3). Both are
  // additive, both are the author's, and both are dropped entry by entry when
  // they cannot be read — a broken saved query or goal must never block a
  // project load. The goal's node ids come from the tree above, so a goal whose
  // folder is gone can be kept and flagged rather than refused.
  const nodeIds = new Set<string>();
  for (const raw of source.tree as unknown[]) {
    if (isRecord(raw) && typeof raw['id'] === 'string') nodeIds.add(raw['id']);
  }
  validateFilters(source, warn);
  validateGoals(source, nodeIds, warn);
  validatePictures(source, nodeIds, warn);

  // Step 3 — derived (rebuildable; absence is not an error)
  if (source.derived !== undefined && !isRecord(source.derived)) {
    warn('derived', 'expected object; will be recomputed on open');
  } else if (isRecord(source.derived)) {
    // The counts are a cache, and a cache holds JSON numbers: a count that is
    // not one is dropped here. The writer would write it as a quoted string
    // (`n_x: "abc"`, through `scalar`), which is valid JSON and a count the
    // next load drops again — so the load drops it now, and says so. An empty
    // map is recomputed on open.
    const counts = source.derived['wordCounts'];
    if (counts !== undefined && !isRecord(counts)) {
      warn('derived.wordCounts', 'expected an object of counts; replaced with an empty one, and the counts are recomputed on open');
      source.derived['wordCounts'] = {};
    } else if (isRecord(counts)) {
      for (const [id, count] of Object.entries(counts)) {
        if (isJsonNumber(count)) continue;
        // The counts are recomputed on open only when the map ends up empty: a
        // map with a count left in it is left as it is (§2's "allowed stale"),
        // so this id's count stays missing until the document is written again.
        warn(`derived.wordCounts.${id}`, 'expected a number; dropped, and the counts are recomputed on open only when the map ends up empty');
        delete counts[id];
      }
    }
    const ruleVersion = source.derived['ruleVersion'];
    if (ruleVersion !== undefined && !(isJsonNumber(ruleVersion) && Number.isInteger(ruleVersion) && ruleVersion >= 1)) {
      warn('derived.ruleVersion', 'expected a whole number from 1; treated as absent, and the counts are recomputed on open when the engine counts with a newer rule');
      delete source.derived['ruleVersion'];
    }
  }

  return { manifest: source as unknown as Manifest, errors, migrations };
}

/**
 * Step 3's `codex[]` subsection — [codex.md §2's eight field contracts](docs/architecture/codex.md),
 * on the manifest.
 *
 * ## Why this is not latent
 *
 * `codex.upsert` pushes into `state.manifest.codex` and the shipped pipeline
 * dispatches it. Without this check a create op carrying `aliases:
 * ['Elena','elena']` and 21 `exclude` phrases — both §2 violations — lands in
 * the manifest, and every one of 24 probed violations validated **silently**.
 * The harness's `codex.write` is not the first writer; §9's `codex.upsert` is.
 *
 * ## The shape check comes first, and it is not optional bookkeeping
 *
 * `codex` absent is fine (additive, codex.md §10 K4); `codex` present and not an array is
 * **fatal**, mirroring the `tree` branch. Every contract below reads
 * `entry.field`, so without this a `codex: "not-an-array"` manifest skips all
 * eight and arrives at the loader as a string where an array of entries is
 * expected — which is not a degradation, it is a crash further in.
 *
 * ## The failure behaviour is the one §2 states, not a stricter one
 *
 * Each of the eight rows in §2's contract table names what happens on
 * violation, and four of them are *not* refusals: two coerce, two drop. A
 * validation step that invented a stricter rule would refuse projects §2 says
 * load — so this mirrors the table, and the tests assert the *lenient* half
 * (a duplicate name is kept, an over-long description is kept) as loudly as the
 * strict half. Two limits (2000 description, 32 × 64 keywords) are shared with
 * the bus rather than retyped; see the module header.
 */
function validateCodex(
  raw: unknown,
  sink: {
    fatal: (path: string, message: string) => void;
    warn: (path: string, message: string) => void;
  },
): void {
  const { fatal, warn } = sink;
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    fatal('codex', 'expected array');
    return;
  }

  // Names first, then per-entry: two contracts are about the *set* of names
  // (a duplicate name, an alias colliding with another entry's name), so a
  // single forward pass cannot judge either.
  //
  // **The owner travels with the name.** "An alias equal to another entry's name"
  // is not a spelling comparison — an alias `"Sten"` next to an entry named
  // `Sten` is the case §2 names, and a map holding bare names answers it wrong,
  // because the string it returns is equal to the alias and so compares as "not
  // another one". The index is what makes the question askable.
  //
  // The **array position** travels with each entry rather than being recovered
  // from the array later: §2.3's contract is that a violation is reported "with
  // node id and field path", and a path built from a filtered list would point
  // at the wrong entry as soon as one non-object preceded it.
  const entries: Array<{ at: string; entry: Record<string, unknown> }> = [];
  raw.forEach((candidate, i) => {
    if (!isRecord(candidate)) {
      fatal(`codex[${i}]`, 'expected object');
      return;
    }
    entries.push({ at: `codex[${i}]`, entry: candidate });
  });

  const nameOwners = new Map<string, { name: string; at: string }>();
  for (const { at, entry } of entries) {
    const name = entry['name'];
    if (typeof name !== 'string' || name.trim() === '') continue;
    const key = name.toLowerCase();
    if (!nameOwners.has(key)) nameOwners.set(key, { name, at });
  }

  const seenIds = new Set<string>();

  entries.forEach(({ at, entry: entryNodeRaw }) => {
    const entryNode = entryNodeRaw as Record<string, unknown> & {
      includePolicy?: unknown;
      origin?: unknown;
      type?: unknown;
    };

    // The writer writes the entry's lists, its description and its case flag
    // unconditionally (manifest-json.ts `codexEntry`), and refuses a value it
    // cannot encode. The spec gives each an absent meaning — no aliases, no
    // exclusions, no attachments, no keywords, no citations, an empty
    // description (which is dropped from assembly), detection case-insensitive —
    // so the load gives an absent field that meaning rather than keeping a
    // value every save would die on.
    for (const key of ['aliases', 'exclude', 'attachments', 'keywords', 'sources'] as const) {
      if (entryNode[key] === undefined) entryNode[key] = [];
    }
    if (entryNode.description === undefined) entryNode.description = '';
    if (entryNode.caseSensitive === undefined) entryNode.caseSensitive = false;

    // --- id ---------------------------------------------------------------
    const id = entryNode.id;
    if (typeof id !== 'string' || id.length === 0) {
      fatal(`${at}.id`, 'expected non-empty string');
    } else {
      // The id is also a filename (`codex/<id>.md`, §3), exactly as `tree[].id`
      // is (`docs/<id>.md`) — so the format of the opaque handle is a load-time
      // contract, and a `c_x` id names a file the writer can never produce and
      // the §5.4 rebuild can never scan.
      if (!isIdWithPrefix('c', id)) {
        fatal(`${at}.id`, 'expected "c_" + 10 Crockford base32 chars');
      }
      if (seenIds.has(id)) {
        fatal(`${at}.id`, `duplicate id "${id}"`);
      }
      seenIds.add(id);
    }

    // --- name -------------------------------------------------------------
    const name = entryNode.name;
    if (typeof name !== 'string') {
      fatal(`${at}.name`, 'expected string');
    } else if (name.trim().length === 0) {
      // §2: "Required, non-empty after trim." The bus already refuses this
      // so a blank name can only arrive from a hand edit, a sync
      // conflict or a foreign writer — which is precisely the surface this step
      // exists for.
      fatal(`${at}.name`, 'expected non-empty string after trim');
    } else if ([...name].length > CODEX_NAME_MAX) {
      warn(`${at}.name`, `name is ${[...name].length} characters, over the ${CODEX_NAME_MAX} limit; kept as written`);
    } else {
      const owner = nameOwners.get(name.toLowerCase());
      if (owner !== undefined && owner.at !== at) {
        // §2: "Load-time duplicate (case-insensitive) → keep both, surface
        // 'duplicate codex name' warning chip; writer never silently renames."
        // Kept, not renamed — the second spelling may be the correct one and the
        // user has to choose. Compared by **position**, not by string, so an
        // entry repeated verbatim still reports itself as the duplicate.
        warn(
          `${at}.name`,
          `duplicate codex name "${name}" (also ${owner.at}.name "${owner.name}"); both entries are kept and nothing is renamed`,
        );
      }
    }

    // --- aliases ----------------------------------------------------------
    // §2: "Deduped, case-insensitive vs `name` and each other; alias equal to
    // another entry's name → load warning, detection resolves to the entry
    // owning it as `name`."
    const aliases = entryNode.aliases;
    if (aliases !== undefined) {
      if (!Array.isArray(aliases)) {
        fatal(`${at}.aliases`, 'expected string[]');
      } else {
        const kept: string[] = [];
        const seenHere = new Set<string>();
        const nameKey = typeof name === 'string' ? name.toLowerCase() : undefined;
        aliases.forEach((alias, j) => {
          const where = `${at}.aliases[${j}]`;
          if (typeof alias !== 'string') {
            fatal(where, 'expected string');
            return;
          }
          const length = [...alias].length;
          if (length < 1 || length > CODEX_ALIAS_CHARS_MAX) {
            // Reported and **kept**. The dedupe is the only thing §2's row tells
            // the loader to remove, and an alias is a name the author typed:
            // dropping it on load would silently un-mention a character, and the
            // limit is stated on the *writer* that produces aliases, not as a
            // reason to forget one.
            warn(where, `alias is ${length} characters, must be 1–${CODEX_ALIAS_CHARS_MAX}; kept as written`);
            kept.push(alias);
            return;
          }
          const key = alias.toLowerCase();
          if (key === nameKey) {
            // An alias equal to its own name adds nothing to detection and is
            // dropped — §2 says "deduped … vs `name`", and the detection engine
            // would resolve it to this entry through the name path anyway.
            warn(where, `alias "${alias}" duplicates this entry's own name; dropped`);
            return;
          }
          if (seenHere.has(key)) {
            warn(where, `duplicate alias "${alias}"; dropped`);
            return;
          }
          const owner = nameOwners.get(key);
          if (owner !== undefined && owner.at !== at) {
            // Kept: §2 says detection resolves it to the entry owning the
            // *name*, which requires the alias to still be there to resolve.
            warn(
              where,
              `alias "${alias}" is the name of ${owner.at} ("${owner.name}"); detection resolves it to that entry`,
            );
          }
          seenHere.add(key);
          kept.push(alias);
        });
        entryNode.aliases = kept;
      }
    }
    if (Array.isArray(aliases) && aliases.length > CODEX_ALIASES_MAX) {
      warn(`${at}.aliases`, `${aliases.length} aliases, over the ${CODEX_ALIASES_MAX} limit; kept as written`);
    }

    // --- type -------------------------------------------------------------
    // An unknown type is a v0.2 type and is **kept**, not coerced; only a
    // missing/empty one becomes 'other'. See `coerceType`.
    //
    // A kept unknown still says something, because that is what this file
    // already does for every other kept unknown (`tree[].status` → "unknown
    // vocabulary id … kept as-is"): a value the UI cannot render is a chip the
    // user sees, and a value nobody is told about is a value nobody can fix.
    const type = coerceType(entryNode.type);
    if (typeof entryNode.type === 'string' && entryNode.type !== '') {
      if (!(CODEX_TYPES as readonly string[]).includes(entryNode.type)) {
        warn(
          `${at}.type`,
          `"${entryNode.type}" is not a v0.1 codex type; kept as-is and shown as an unknown-type chip (v0.1: ${CODEX_TYPES.join(', ')})`,
        );
      }
    } else {
      entryNode.type = type.value;
      warn(`${at}.type`, `expected one of ${CODEX_TYPES.join(', ')}; wrote "${type.value}"`);
    }

    // --- description ------------------------------------------------------
    const description = entryNode.description;
    if (description !== undefined && typeof description !== 'string') {
      fatal(`${at}.description`, 'expected string');
    } else if (typeof description === 'string' && [...description].length > CODEX_DESCRIPTION_MAX) {
      // §2's contract for description is about *assembly* ("empty description =
      // dropped from assembly"), and the bus refuses an over-long one as a hard
      // limit. Here the value is kept whole and reported: truncation would
      // silently edit the AI-facing payload, which is the one field in this
      // table whose loss is not recoverable from the redundancy file's body.
      warn(`${at}.description`, `description is ${[...description].length} characters, over the ${CODEX_DESCRIPTION_MAX} limit; kept whole, not truncated`);
    }

    // --- includePolicy ----------------------------------------------------
    const rawPolicy = entryNode.includePolicy;
    const policy = coerceIncludePolicy(rawPolicy);
    if (policy.coerced) {
      // The **incoming** value is named, and it is read into `rawPolicy` above
      // because the assignment below overwrites it. Interpolating
      // `entryNode.includePolicy` here instead prints the value just written, so
      // the report reads `unknown policy "detected"; coerced to "detected"` —
      // a complaint that names nothing the user can find in their file.
      entryNode.includePolicy = policy.value;
      warn(
        `${at}.includePolicy`,
        `unknown policy ${JSON.stringify(rawPolicy)}; coerced to "${policy.value}" (valid: ${CODEX_INCLUDE_POLICIES.join(', ')})`,
      );
    }

    // --- caseSensitive ----------------------------------------------------
    const caseSensitive = entryNode.caseSensitive;
    if (caseSensitive !== undefined && typeof caseSensitive !== 'boolean') {
      fatal(`${at}.caseSensitive`, 'expected boolean');
    }

    // --- exclude ----------------------------------------------------------
    const exclude = entryNode.exclude;
    if (exclude !== undefined) {
      if (!Array.isArray(exclude)) {
        fatal(`${at}.exclude`, 'expected string[]');
      } else {
        if (exclude.length > CODEX_EXCLUDE_MAX) {
          warn(`${at}.exclude`, `${exclude.length} phrases, over the ${CODEX_EXCLUDE_MAX} limit; kept as written`);
        }
        exclude.forEach((phrase, j) => {
          if (typeof phrase !== 'string') {
            fatal(`${at}.exclude[${j}]`, 'expected string');
          } else if ([...phrase].length > CODEX_EXCLUDE_CHARS_MAX) {
            warn(`${at}.exclude[${j}]`, `phrase is ${[...phrase].length} characters, over the ${CODEX_EXCLUDE_CHARS_MAX} limit; kept as written`);
          }
        });
      }
    }

    // --- attachments ------------------------------------------------------
    // Shape only. Referential integrity is `read.ts`'s, once, after §2 step 4.
    const attachments = entryNode.attachments;
    if (attachments !== undefined) {
      if (!Array.isArray(attachments)) {
        fatal(`${at}.attachments`, 'expected string[]');
      } else {
        attachments.forEach((target, j) => {
          if (typeof target !== 'string') {
            fatal(`${at}.attachments[${j}]`, 'expected string');
          }
        });
      }
    }

    // --- visualRefs -------------------------------------------------------
    // video-prompt-pack.md §3: asset ids. Shape only here. A reference to a file that is not in `assets/` is kept, not dropped: the
    // pack and the codex panel report it as missing (only the host can list that folder, and the writer fixes it there).
    const visualRefs = entryNode.visualRefs;
    if (visualRefs !== undefined) {
      if (!Array.isArray(visualRefs)) {
        fatal(`${at}.visualRefs`, 'expected string[]');
      } else {
        visualRefs.forEach((target, j) => {
          if (typeof target !== 'string') fatal(`${at}.visualRefs[${j}]`, 'expected string');
        });
      }
    }

    // --- keywords ---------------------------------------------------------
    // §2: "Max 32 × 64 chars, same limits as node keywords". The counts are the
    // node constants, not the bus's, because the node limits are the definition
    // this row refers to.
    const keywords = entryNode.keywords;
    if (keywords !== undefined) {
      if (!Array.isArray(keywords)) {
        fatal(`${at}.keywords`, 'expected string[]');
      } else {
        if (keywords.length > MAX_KEYWORDS) {
          warn(`${at}.keywords`, `${keywords.length} keywords, over the ${MAX_KEYWORDS} limit; kept as written`);
        }
        keywords.forEach((k, j) => {
          if (typeof k !== 'string') {
            fatal(`${at}.keywords[${j}]`, 'expected string');
          } else if ([...k].length > MAX_KEYWORD_CHARS) {
            warn(`${at}.keywords[${j}]`, `keyword is ${[...k].length} characters, over the ${MAX_KEYWORD_CHARS} limit; kept as written`);
          }
        });
      }
    }

    // --- origin -----------------------------------------------------------
    // Absence is `'manual'` (project-format §2: "missing `origin` = 'manual'"),
    // which is a stated default and not a coercion; only an unrecognised *value*
    // coerces, to `'agent'`.
    if (entryNode.origin === undefined || entryNode.origin === null) {
      entryNode.origin = 'manual';
    } else {
      const rawOrigin = entryNode.origin;
      const origin = coerceOrigin(rawOrigin);
      if (origin.coerced) {
        // `rawOrigin` for the same reason as `rawPolicy`: the assignment overwrites.
        entryNode.origin = origin.value;
        warn(
          `${at}.origin`,
          `unknown origin ${JSON.stringify(rawOrigin)}; coerced to "${origin.value}" (valid: ${CODEX_ORIGINS.join(', ')})`,
        );
      }
    }

    // --- sources ----------------------------------------------------------
    const sources = entryNode.sources;
    if (sources !== undefined) {
      if (!Array.isArray(sources)) {
        fatal(`${at}.sources`, 'expected array');
      } else {
        if (sources.length > CODEX_SOURCES_MAX) {
          // Kept, not truncated: §2's provenance semantics make `sources[]`
          // display data in v0.1 (codex.md §2's closing paragraph), and a
          // silently dropped citation is the one loss a reader cannot detect.
          warn(`${at}.sources`, `${sources.length} sources, over the ${CODEX_SOURCES_MAX} limit; kept as written`);
        }
        const kept: unknown[] = [];
        sources.forEach((source, j) => {
          const where = `${at}.sources[${j}]`;
          if (!isRecord(source)) {
            fatal(where, 'expected object');
            kept.push(source);
            return;
          }
          if (typeof source['docId'] !== 'string') {
            fatal(`${where}.docId`, 'expected string');
          }
          if (typeof source['quote'] !== 'string') {
            fatal(`${where}.quote`, 'expected string');
          }
          // A present offset or timestamp of the wrong type cannot be written back as
          // the spec's value (manifest-json.ts), so the citation is dropped here with
          // a warning, the same way an unknown coercible value is. Kept, it would load
          // silently and break the next save.
          const offsetProblem = citationOffsetProblem(source);
          if (offsetProblem !== undefined) {
            warn(where, `${offsetProblem}; citation dropped`);
            return;
          }
          kept.push(source);
          // The dangling `docId` drop is `read.ts`'s, for the same reason
          // `attachments` is: the orphan-import step runs after this one.
        });
        if (kept.length !== sources.length) entryNode.sources = kept;
      }
    }

    // --- timestamps -------------------------------------------------------
    for (const key of ['createdAt', 'updatedAt'] as const) {
      const stamp = entryNode[key];
      if (stamp !== undefined && !isIsoDate(stamp)) {
        // Warning, not fatal, and the same choice `tree[]` makes: a §5.4-rebuilt
        // entry genuinely has no known creation time and codex.md §3's file has
        // no key for it, so absence is normal and a malformed stamp is a
        // foreign writer rather than a broken project. `null` is malformed here
        // too — the writer refuses a stamp that is not a string — and the field
        // is deleted, not merely reported, so "ignoring field" leaves nothing
        // behind that the next save would die on.
        warn(`${at}.${key}`, 'expected ISO-8601 date string; ignoring field');
        delete entryNode[key];
      }
    }
  });
}

/**
 * Step 3's `filters[]` — [binder-filters §4](docs/architecture/binder-filters.md).
 *
 * ## The convention, and why it is this one
 *
 * A saved filter is a *view* over the tree, not the tree. binder-filters §4 says
 * it in so many words: "malformed criterion objects → the whole filter is
 * dropped with a load warning (a broken saved query must never block a project
 * load)". So a malformed filter is dropped with a warning and the load goes on,
 * which is the same convention `recipes[]` already sets in this file.
 *
 * ## The two halves of the rule
 *
 * - A **required** field the filter cannot do without (its `id`, its `name`,
 *   its `criteria`, its two stamps) takes the filter with it: the writer writes
 *   those unconditionally, so a filter that is missing one is a filter the
 *   writer cannot write back without inventing a value.
 * - An **optional** field that is malformed (the `root`, a criterion key this
 *   build does not know) is dropped on its own and the filter is kept, because
 *   the field has a documented meaning when it is absent — an unscoped filter
 *   searches both roots, and a filter without one criterion searches on the
 *   rest. binder-filters §4: "unknown criteria keys are dropped with the
 *   one-time unknown-field notice". The key list is the bus's own export, so
 *   the load and the command boundary read one record of it.
 *
 * The id is checked as the bus checks it and must be unique in the array: an
 * id no command accepts makes the filter uneditable, and the undo of a delete
 * of it refuses, and a repeated id makes every update-by-id target the first
 * match only.
 */
function validateFilters(source: Record<string, unknown>, warn: (path: string, message: string) => void): void {
  const raw = source['filters'];
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    warn('filters', 'expected an array of saved filters; dropped');
    delete source['filters'];
    return;
  }
  const seenIds = new Set<string>();
  const kept = raw.filter((filter, i) => {
    if (!isSavedFilter(filter)) {
      warn(
        `filters[${i}]`,
        'not a saved filter (an id "q_" + 10 base32 chars, a name the bus accepts, criteria, createdAt, updatedAt); dropped',
      );
      return false;
    }
    const record = filter as Record<string, unknown>;
    const id = record['id'] as string;
    if (seenIds.has(id)) {
      warn(`filters[${i}].id`, `duplicate id "${id}"; dropped, and the first filter keeps it`);
      return false;
    }
    seenIds.add(id);
    const criteria = record['criteria'] as Record<string, unknown>;
    for (const key of Object.keys(criteria)) {
      if ((CRITERIA_KEYS as readonly string[]).includes(key)) continue;
      warn(`filters[${i}].criteria.${key}`, `unknown criterion "${key}"; dropped, and the filter searches on the rest`);
      delete criteria[key];
    }
    const root = record['root'];
    if (root !== undefined && !(FILTER_ROOTS as readonly unknown[]).includes(root)) {
      warn(
        `filters[${i}].root`,
        `unknown root ${JSON.stringify(root)}; dropped, and the filter searches both roots`,
      );
      delete record['root'];
    }
    return true;
  });
  source['filters'] = kept;
}

/**
 * Step 3's `assets[]` and `assetLinks[]` — [pictures.md §2.1](docs/architecture/pictures.md).
 *
 * Nothing here refuses a project and nothing here deletes a picture entry. A record or link that cannot be read is
 * moved to `unreadableAssets` / `unreadableAssetLinks` exactly as stored, and the serializer writes it back in its own
 * array, so a build that does not understand an entry never destroys it. A link that names a picture or a binder
 * item that is not there is kept and named: the item may come back with an undo, and the picture's file may be
 * mid-restore.
 */
function validatePictures(
  source: Record<string, unknown>,
  nodeIds: ReadonlySet<string>,
  warn: (path: string, message: string) => void,
): void {
  const keep = (key: 'unreadableAssets' | 'unreadableAssetLinks', unreadable: readonly unknown[]): void => {
    const earlier = Array.isArray(source[key]) ? (source[key] as unknown[]) : [];
    if (earlier.length + unreadable.length > 0) source[key] = [...earlier, ...unreadable];
  };

  let assetIds: ReadonlySet<string> | undefined;
  if (source['assets'] !== undefined) {
    const read = readAssetRecords(source['assets']);
    for (const notice of read.notices) warn(notice.path, notice.message);
    source['assets'] = [...read.records];
    keep('unreadableAssets', read.unreadable);
    assetIds = new Set(read.records.map((record) => record.id));
  }
  if (source['assetLinks'] !== undefined) {
    const read = readAssetLinks(source['assetLinks']);
    for (const notice of read.notices) warn(notice.path, notice.message);
    source['assetLinks'] = [...read.links];
    keep('unreadableAssetLinks', read.unreadable);
    // The reader already names a repeated id and a second card; the rest are the dangling references it cannot see.
    const context = assetIds === undefined ? { nodeIds } : { nodeIds, assetIds };
    for (const issue of validateLinkSet(read.links, context)) {
      if (issue.code === 'unknown-asset' || issue.code === 'unknown-node' || issue.code === 'card-target') {
        warn(issue.path, `${issue.message}; kept as written`);
      }
    }
  }
}
/**
 * Step 3's `goals[]` — [goals-progress §2.2 and §3](docs/architecture/goals-progress.md).
 *
 * The convention is the one `filters[]` above uses and the one `recipes[]`
 * already set: a goal that cannot be read is dropped with a warning, and the
 * load goes on. goals-progress §3 names it for the two fields it cares most
 * about — "unknown comparator/metric → goal dropped with load warning" — and
 * §2.2 names the one case that is *not* a drop: "dangling nodeId → kept but
 * flagged 'target missing' in the UI, matches nothing (same posture as unknown
 * vocabulary ids; never blocks load)".
 *
 * The optional fields are dropped one by one rather than taking the goal with
 * them: a deadline that names no day makes a goal open-ended, an `archived`
 * that is not a boolean makes it un-archived, and a `resetDay` that names no
 * day in the goal's window makes it reset on the window's default day — each
 * is the field's documented meaning when it is absent.
 *
 * The id is checked as the bus checks it (`g_` + 10 Crockford chars) and must
 * be unique in the array, and a weekly or monthly goal must keep §9.3's
 * invariants — manuscript root, `words`, `at-least`, no deadline — because
 * every `project.saveGoal` and its undo inverse refuse one that does not: a
 * loaded goal the bus refuses is a goal the author can never edit, or undo the
 * deletion of, again. The deadline is the one invariant an optional field can
 * repair, so it is dropped on its own and the goal is kept.
 *
 * An id is registered as taken only by a goal that is kept, so a goal dropped
 * over another field does not make a later, well-formed goal with the same id
 * a duplicate of a goal that is not there.
 */
function validateGoals(
  source: Record<string, unknown>,
  nodeIds: ReadonlySet<string>,
  warn: (path: string, message: string) => void,
): void {
  const raw = source['goals'];
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    warn('goals', 'expected an array of project goals; dropped');
    delete source['goals'];
    return;
  }
  const seenIds = new Set<string>();
  const kept = raw.filter((candidate, i) => {
    if (!isRecord(candidate)) {
      warn(`goals[${i}]`, 'not a project goal; dropped');
      return false;
    }
    const goal = candidate;

    // --- the fields a goal cannot do without -----------------------------
    if (!isFurnitureId('g', goal['id'])) {
      warn(`goals[${i}]`, 'expected an id "g_" + 10 base32 chars; goal dropped');
      return false;
    }
    const id = goal['id'];
    if (seenIds.has(id)) {
      warn(`goals[${i}].id`, `duplicate id "${id}"; dropped, and the first goal keeps it`);
      return false;
    }
    if (typeof goal['nodeId'] !== 'string' || goal['nodeId'] === '') {
      warn(`goals[${i}]`, 'expected the node id it counts; goal dropped');
      return false;
    }
    const comparator = goal['comparator'];
    if (typeof comparator !== 'string' || !(GOAL_COMPARATORS as readonly string[]).includes(comparator)) {
      warn(`goals[${i}]`, `expected a comparator of ${GOAL_COMPARATORS.join(', ')}; goal dropped`);
      return false;
    }
    const target = goal['target'];
    if (typeof target !== 'number' || !Number.isSafeInteger(target) || target <= 0) {
      warn(`goals[${i}]`, 'expected a target of a positive whole number; goal dropped');
      return false;
    }
    if (!isIsoDate(goal['createdAt']) || !isIsoDate(goal['updatedAt'])) {
      warn(`goals[${i}]`, 'expected ISO-8601 createdAt and updatedAt; goal dropped');
      return false;
    }

    // --- the optional fields ---------------------------------------------
    const metric = goal['metric'];
    if (metric === undefined) {
      // manifest.ts: "Absent (an older manifest) means words." Materialising it
      // is what the writer needs — it writes the metric unconditionally — and
      // it is the meaning the spec already gives the absence.
      goal['metric'] = 'words';
    } else if (typeof metric !== 'string' || !(GOAL_METRICS as readonly string[]).includes(metric)) {
      warn(`goals[${i}]`, `expected a metric of ${GOAL_METRICS.join(', ')}; goal dropped`);
      return false;
    }
    const kind = goal['kind'];
    if (kind !== undefined && (typeof kind !== 'string' || !(GOAL_KINDS as readonly string[]).includes(kind))) {
      warn(`goals[${i}]`, `expected a kind of ${GOAL_KINDS.join(', ')}; goal dropped`);
      return false;
    }
    const resetDay = goal['resetDay'];
    if (resetDay !== undefined) {
      const window = typeof kind === 'string' ? kind : 'project';
      if (resetDay === null) {
        // The bus reads `null` as absent (goals-progress §4: "null reads as
        // absent"), and absent means the window's default day — so the field
        // goes quietly and the goal keeps its window.
        delete goal['resetDay'];
      } else if (window === 'project') {
        // goals-progress §2.2: "Weekly and monthly goals only (a project goal
        // carrying one is refused at save and dropped on load)."
        warn(`goals[${i}]`, 'a project goal carries no reset day; goal dropped');
        return false;
      } else {
        const weekday = typeof resetDay === 'number' && Number.isInteger(resetDay) && resetDay >= 0 && resetDay <= 6;
        const monthDay =
          resetDay === 'last' || (typeof resetDay === 'number' && Number.isInteger(resetDay) && resetDay >= 1 && resetDay <= 28);
        if (!(window === 'weekly' ? weekday : monthDay)) {
          // The field goes, the goal stays: an absent reset day is the spec's
          // default (the locale's first weekday, or the 1st), and dropping the
          // whole goal would lose id, target, comparator and stamps over an
          // optional field.
          warn(
            `goals[${i}].resetDay`,
            'expected a weekday (0–6) for a weekly goal, or a day of the month (1–28, or "last") for a monthly one; dropped, and the goal resets on its window’s default day',
          );
          delete goal['resetDay'];
        }
      }
    }
    // goals-progress §9.3: a weekly or monthly goal attaches to the manuscript
    // root, counts words, is `at-least` and takes no deadline. The bus enforces
    // all four on every save and every undo, so a goal that breaks one of the
    // first three is a goal no command can update, and the undo of a delete of
    // it refuses — dropped. The deadline is repaired instead: "no deadline" is
    // the field's documented meaning when absent, so the field goes and the
    // goal stays.
    if (kind === 'weekly' || kind === 'monthly') {
      const broken =
        goal['nodeId'] !== 'manuscript'
          ? 'attaches to the manuscript root'
          : goal['metric'] !== 'words'
            ? 'counts words'
            : comparator !== 'at-least'
              ? 'is at-least'
              : undefined;
      if (broken !== undefined) {
        warn(`goals[${i}]`, `a ${kind} goal ${broken} (goals-progress §9.3), and the bus refuses one that does not; goal dropped`);
        return false;
      }
      if (goal['deadline'] !== undefined && goal['deadline'] !== null) {
        warn(`goals[${i}].deadline`, `a ${kind} goal recurs, so it takes no deadline; dropped, and the goal is kept`);
        delete goal['deadline'];
      }
    }
    const deadline = goal['deadline'];
    // `null` is the bus's "no deadline": the bus reads a deadline of `null` as
    // an absent one (`descriptors-furniture.ts`, which tests the field against
    // both `undefined` and `null`), so it goes quietly here too, the way a
    // `resetDay` of null goes: the file says the same thing as an absent field,
    // and there is nothing to warn about.
    if (deadline === null) {
      delete goal['deadline'];
    } else if (deadline !== undefined && !isCalendarDay(deadline)) {
      warn(`goals[${i}].deadline`, 'expected a calendar day (YYYY-MM-DD); dropped, and the goal is open-ended');
      delete goal['deadline'];
    }
    if (goal['archived'] !== undefined && typeof goal['archived'] !== 'boolean') {
      warn(`goals[${i}].archived`, 'expected true or false; dropped');
      delete goal['archived'];
    }

    // --- the node it counts ----------------------------------------------
    // §2.2: a dangling nodeId is kept and flagged, never a refusal — the goal
    // is the author's, and the folder it named may come back.
    if (!nodeIds.has(goal['nodeId'] as string)) {
      warn(
        `goals[${i}].nodeId`,
        `the node "${String(goal['nodeId'])}" is not in this project; kept, and the goal matches nothing`,
      );
    }
    // The id is registered only here, and not one check earlier: a goal dropped
    // above never kept its id, so a later well-formed goal with the same id is
    // not a duplicate of a goal that is not there. The message above then tells
    // the truth — the first goal really does keep the id.
    seenIds.add(id);
    return true;
  });
  source['goals'] = kept;
}

/** Step 4: referential integrity. */
function validateReferences(
  manifest: Manifest,
  docFiles: readonly string[],
): { errors: ValidationError[]; orphans: string[] } {
  const errors: ValidationError[] = [];
  const tree = manifest.tree;

  const seen = new Set<string>();
  tree.forEach((node, i) => {
    if (seen.has(node.id)) {
      errors.push({ path: `tree[${i}].id`, message: `duplicate id "${node.id}"`, fatal: true });
    }
    seen.add(node.id);
  });

  tree.forEach((node, i) => {
    if (node.parentId !== null && !seen.has(node.parentId)) {
      errors.push({
        path: `tree[${i}].parentId`,
        message: `parent "${node.parentId}" does not resolve`,
        fatal: true,
      });
    }
  });

  // Cycle detection: a parent walk from any node must terminate at a null parent.
  for (const [i, node] of tree.entries()) {
    const seenOnPath = new Set<string>([node.id]);
    let cursor: TreeNode | undefined = node;
    while (cursor?.parentId) {
      if (seenOnPath.has(cursor.parentId)) {
        errors.push({
          path: `tree[${i}].parentId`,
          message: `cycle through "${cursor.parentId}"`,
          fatal: true,
        });
        break;
      }
      seenOnPath.add(cursor.parentId);
      cursor = tree.find((n) => n.id === cursor?.parentId);
    }
  }

  // A body node must have its file in docs/: the name its kind gives, or the `.md` a save wrote before the kind had
  // one (dual read, project-format.md §3 and the media-track note).
  const files = new Set(docFiles);
  const orphans: string[] = [];
  tree.forEach((node, i) => {
    if (!isBodyType(node.type)) return;
    const names = bodyNamesOf(node);
    if (!names.some((name) => files.has(name))) {
      errors.push({
        path: `tree[${i}].id`,
        message: `document "${node.id}" has no docs/${names[0]}`,
        fatal: true,
      });
    }
  });

  // orphan files are imported as "Recovered", never deleted. A file is owned when some body node names it.
  const owned = new Set(tree.filter((n) => isBodyType(n.type)).flatMap((n) => bodyNamesOf(n)));
  for (const file of files) {
    if (!owned.has(file)) orphans.push(file);
  }

  return { errors, orphans };
}

export interface ValidateOptions {
  /** `docs/*.md` basenames present on disk — needed for step 4. */
  docFiles?: readonly string[];
  /**
   * Which steps this build knows, and which version it is at. Defaults to
   * {@link PRODUCTION_FORMAT}; the substitution exists so §6's migration branch
   * can be reached in a test while `FORMAT_VERSION` is still 1, and nothing in
   * this package passes anything else.
   */
  format?: FormatContext;
}

/**
 * Full load-time validation. Returns a report; `ok` is false when any *fatal*
 * error was found. Warnings never block a load.
 *
 * Throws `MigrationError` — and only that — when §6's registry cannot carry a
 * manifest to the current version. Every other failure is collected, so a caller
 * that only reads the report still sees one and only one reason a load stopped.
 */
export function validateManifest(input: unknown, options: ValidateOptions = {}): ValidationReport {
  const { manifest, errors: fieldErrors, migrations } = validateFields(
    input,
    options.format ?? PRODUCTION_FORMAT,
  );
  if (!manifest) {
    return { ok: false, errors: fieldErrors, warnings: [], orphans: [], migrations };
  }

  const ref = validateReferences(manifest, options.docFiles ?? []);
  const all = [...fieldErrors, ...ref.errors];
  const errors = all.filter((e) => e.fatal);
  const warnings = all.filter((e) => !e.fatal);

  return { ok: errors.length === 0, errors, warnings, orphans: ref.orphans, migrations, manifest };
}
