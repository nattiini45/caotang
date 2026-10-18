/**
 * Manifest serializer — [project-format.md §2](docs/architecture/project-format.md).
 *
 * §2 is normative about layout, not just about content: pretty-printed JSON,
 * 2-space indent, keys in a fixed order, and one array element per line for
 * `tree[]`. That exists so that a rename, a reorder, or an agent edit produces
 * a one-line git diff instead of a reformatted file — the whole point of the
 * opaque-id design. So this is a hand-written emitter, not `JSON.stringify`:
 * `JSON.stringify` cannot express the fixed key order or the one-element-per-
 * line rule, and a post-hoc formatter would fight every future writer.
 *
 * Only the schema is emitted. Unknown fields found on load are deliberately
 * dropped here — §6: "unknown fields on load are preserved in memory and
 * dropped on next save, with a one-time notice."
 *
 * **The `formatVersion` written here is a transcription, not an assertion.**
 * §6 says "writers always save at the current version (no rolling forward on
 * unrelated edits)", and the parenthetical is the clause that does the work: a
 * caller holding a v1-shaped object has not been migrated, so stamping v2 over
 * it *is* rolling the version forward on an unrelated edit — and the file it
 * produces claims a shape it does not have, which the next open then validates
 * against the wrong schema because the version gate now believes it is current.
 * That only the §6 registry knows the migration steps proves the writer cannot
 * *fix* such a manifest, not that it may mislabel it. The writer does not
 * migrate, and it does not lie about what it wrote.
 * So a manifest whose own `formatVersion` is not this build's is refused, in
 * both directions, and the load path is where a version changes.
 */

import { CHAR_LIMIT_MAX, SCENE_NUMBER_OPTIONS } from '@caotang/bus';
import type {
  CodexEntry,
  Derived,
  ExportRecipe,
  Manifest,
  ProjectIdentity,
  SavedFilter,
  ProjectGoal,
  TreeNode,
  VocabularyTerm,
} from './manifest.js';
import {
  PRODUCTION_FORMAT,
  MigrationError,
  readFormatVersion,
  type FormatContext,
} from './migrations.js';

const INDENT = '  ';

function str(value: string): string {
  return JSON.stringify(value);
}

function scalar(value: string | number | null): string {
  return value === null ? 'null' : typeof value === 'number' ? String(value) : str(value);
}

/** Scalar arrays stay inline (`"keywords": []`) — they are short by contract. */
function inlineArray(values: readonly unknown[]): string {
  if (values.length === 0) return '[]';
  return `[${values.map((v) => scalar(v as string)).join(', ')}]`;
}

/** One object element per line. `depth` is the indent level of the key itself. */
function objectArray(items: readonly string[], depth: number): string {
  if (items.length === 0) return '[]';
  const inner = INDENT.repeat(depth + 1);
  return `[\n${items.map((i) => `${inner}${i}`).join(',\n')}\n${INDENT.repeat(depth)}]`;
}

function oneLine(pairs: readonly [string, string][]): string {
  return `{ ${pairs.map(([k, v]) => `${str(k)}: ${v}`).join(', ')} }`;
}

function term(t: VocabularyTerm): string {
  return oneLine([
    ['id', str(t.id)],
    ['name', str(t.name)],
    ['color', str(t.color)],
  ]);
}

function node(n: TreeNode): string {
  const pairs: [string, string][] = [
    ['id', str(n.id)],
    ['parentId', n.parentId === null ? 'null' : str(n.parentId)],
    ['type', str(n.type)],
    ['title', str(n.title)],
    ['order', String(n.order)],
    ['status', n.status === null ? 'null' : str(n.status)],
    ['label', n.label === null ? 'null' : str(n.label)],
    ['keywords', inlineArray(n.keywords)],
    ['synopsis', str(n.synopsis)],
    ['notes', str(n.notes)],
  ];
  // The media-track fields (project-format.md §2's media note) follow the same rule: written only when present, so a
  // project with no media nodes round-trips with no new key. A shot's and a container's metadata is held as an
  // object the storyboard and dialogue engines read, so it is written as one line of JSON: one node, one line, as the
  // tree rule asks, and the key order is the one the engine gave it.
  if (n.kind !== undefined) pairs.push(['kind', str(n.kind)]);
  if (n.shot !== undefined) pairs.push(['shot', JSON.stringify(n.shot)]);
  if (n.dialogue !== undefined) pairs.push(['dialogue', JSON.stringify(n.dialogue)]);
  // Additive timestamps are emitted only when present, so
  // that a project which never sets them round-trips unchanged.
  if (n.createdAt !== undefined) pairs.push(['createdAt', str(n.createdAt)]);
  if (n.updatedAt !== undefined) pairs.push(['updatedAt', str(n.updatedAt)]);
  return oneLine(pairs);
}

function source(source: CodexEntry['sources'][number]): string {
  // codex.md §2's EntrySource, in its own key order. The optional fields are written
  // when present and only then, so a citation with none of them is unchanged.
  const fields: [string, string][] = [
    ['docId', str(source.docId)],
    ['quote', str(source.quote)],
  ];
  // The offsets go through JSON's own number encoding, not String(): String() writes
  // a non-numeric value bare (`from: zero`), which is not JSON and fails the next
  // load. The loader drops such a citation (validate.ts), so this is the second guard,
  // and it keeps the file parseable even when a value somehow got past the first.
  if (source.from !== undefined) fields.push(['from', JSON.stringify(source.from)]);
  if (source.to !== undefined) fields.push(['to', JSON.stringify(source.to)]);
  if (source.extractedAt !== undefined) fields.push(['extractedAt', str(source.extractedAt)]);
  return oneLine(fields);
}

function codexEntry(c: CodexEntry): string {
  const pairs: [string, string][] = [
    ['id', str(c.id)],
    ['name', str(c.name)],
    ['aliases', inlineArray(c.aliases)],
    ['type', str(c.type)],
    ['description', str(c.description)],
    ['includePolicy', str(c.includePolicy)],
    ['caseSensitive', String(c.caseSensitive)],
    ['exclude', inlineArray(c.exclude)],
    ['attachments', inlineArray(c.attachments)],
    ['keywords', inlineArray(c.keywords)],
    // video-prompt-pack.md §3: written only when there are some, so an entry without them is byte-identical to before.
    ...(c.visualRefs === undefined || c.visualRefs.length === 0 ? [] : [['visualRefs', inlineArray(c.visualRefs)] as [string, string]]),
    ['origin', str(c.origin)],
    ['sources', objectArray(c.sources.map(source), 2)],
  ];
  // An entry restored by the §5.4 rebuild has no recorded timestamps, because
  // codex.md §3's redundancy file does not carry them. Omitted rather than
  // invented — same rule as the additive tree-node timestamps above.
  if (c.createdAt !== undefined) pairs.push(['createdAt', str(c.createdAt)]);
  if (c.updatedAt !== undefined) pairs.push(['updatedAt', str(c.updatedAt)]);
  return oneLine(pairs);
}

/**
 * binder-filters §2. `root` is written only when the filter is scoped, so an unscoped filter round-trips with no new key.
 * The bug this replaces dropped the root on every save.
 */
function savedFilter(f: SavedFilter): string {
  const pairs: [string, string][] = [
    ['id', str(f.id)],
    ['name', str(f.name)],
  ];
  if (f.root !== undefined) pairs.push(['root', str(f.root)]);
  pairs.push(['criteria', inlineObject(f.criteria)], ['createdAt', str(f.createdAt)], ['updatedAt', str(f.updatedAt)]);
  return oneLine(pairs);
}

/**
 * goals-progress §2.2. `deadline` and `archived` are written only when present, so an open-ended goal carries no
 * empty key. A goal of the pre-spec shape is no longer written at all.
 */
function projectGoal(g: ProjectGoal): string {
  const pairs: [string, string][] = [
    ['id', str(g.id)],
    ['nodeId', str(g.nodeId)],
    ['metric', str(g.metric)],
  ];
  // goals-progress §9.3: a session kind is written only when there is one, so a project goal round-trips with no new key.
  if (g.kind !== undefined && g.kind !== 'project') pairs.push(['kind', str(g.kind)]);
  // goals-progress §9.3: a reset day is written only when the writer chose one, so a goal with the default window keeps its bytes.
  if (g.resetDay !== undefined) pairs.push(['resetDay', g.resetDay === 'last' ? str('last') : String(g.resetDay)]);
  pairs.push(['comparator', str(g.comparator)], ['target', String(g.target)]);
  if (g.deadline !== undefined) pairs.push(['deadline', str(g.deadline)]);
  if (g.archived !== undefined) pairs.push(['archived', String(g.archived)]);
  pairs.push(['createdAt', str(g.createdAt)], ['updatedAt', str(g.updatedAt)]);
  return oneLine(pairs);
}

/** Best-effort inline rendering for a free-form map (saved-filter criteria). */
function inlineObject(value: Record<string, unknown>): string {
  const parts = Object.entries(value).map(([k, v]) => `${str(k)}: ${scalar(v as string)}`);
  if (parts.length === 0) return '{}';
  return `{ ${parts.join(', ')} }`;
}

function projectIdentity(p: ProjectIdentity): string {
  // The EPUB floor (epub-metadata.md) is written only when present, in the order it
  // is specified, so a project that never set one round-trips with no new key.
  const lines = [
    `${INDENT}"project": {`,
    `${INDENT}${INDENT}"id": ${str(p.id)},`,
    `${INDENT}${INDENT}"name": ${str(p.name)},`,
    `${INDENT}${INDENT}"createdAt": ${str(p.createdAt)},`,
    `${INDENT}${INDENT}"modifiedAt": ${str(p.modifiedAt)}`,
  ];
  const optional: string[] = [];
  if (p.language !== undefined) optional.push(`${INDENT}${INDENT}"language": ${str(p.language)}`);
  if (p.identifier !== undefined) optional.push(`${INDENT}${INDENT}"identifier": ${projectIdentifier(p.identifier)}`);
  if (p.coverAssetId !== undefined) {
    optional.push(`${INDENT}${INDENT}"coverAssetId": ${p.coverAssetId === null ? 'null' : str(p.coverAssetId)}`);
  }
  if (p.author !== undefined) optional.push(`${INDENT}${INDENT}"author": ${str(p.author)}`);
  if (optional.length > 0) {
    lines[lines.length - 1] = `${lines[lines.length - 1]},`;
    optional.forEach((line, i) => lines.push(i === optional.length - 1 ? line : `${line},`));
  }
  lines.push(`${INDENT}},`);
  return lines.join('\n');
}

/** `{ "uuid": …, "isbn": … }` on one line, the isbn only when set (epub-metadata.md). */
function projectIdentifier(id: NonNullable<ProjectIdentity['identifier']>): string {
  // `isbn: null` is written as null, not omitted: it is the one value a writer sets to
  // say "no ISBN yet", and dropping the key would make the save say something else.
  const fields = [`"uuid": ${str(id.uuid)}`];
  if (id.isbn !== undefined) fields.push(`"isbn": ${id.isbn === null ? 'null' : str(id.isbn)}`);
  return `{ ${fields.join(', ')} }`;
}

/** exporter.md §2's recipe, in the key order it is specified in. */
function exportRecipe(r: ExportRecipe): string {
  const fields: [string, string][] = [
    ['name', str(r.name)],
    ['includeRootIds', `[${r.includeRootIds.map((id) => str(id)).join(', ')}]`],
    ['format', str(r.format)],
  ];
  if (r.templateId !== undefined) fields.push(['templateId', str(r.templateId)]);
  // The options object is written only when the recipe has one, and only the keys it sets, so a recipe saved
  // without options round-trips with no new key (the same rule as the additive node timestamps above).
  if (r.options !== undefined) fields.push(['options', recipeOptions(r.options)]);
  return oneLine(fields);
}

/**
 * exporter.md §2's options, in the order the type declares them, and only the keys that are set. Each value is written only when it has
 * the type the load keeps (validate.ts's `isRecipeOptions`), so a value of another type can never reach the file unquoted.
 */
function recipeOptions(o: NonNullable<ExportRecipe['options']>): string {
  const pairs: [string, string][] = [];
  if (typeof o.titlePage === 'boolean') pairs.push(['titlePage', String(o.titlePage)]);
  if (typeof o.toc === 'boolean') pairs.push(['toc', String(o.toc)]);
  if (typeof o.author === 'string') pairs.push(['author', str(o.author)]);
  const limit: unknown = o.charLimit;
  if (typeof limit === 'number' && Number.isSafeInteger(limit) && limit >= 1 && limit <= CHAR_LIMIT_MAX) {
    pairs.push(['charLimit', String(limit)]);
  }
  const numbers: unknown = o.sceneNumbers;
  // The placements the bus accepts, from its own export, so a placement it gains is written, not dropped.
  if (typeof numbers === 'string' && (SCENE_NUMBER_OPTIONS as readonly string[]).includes(numbers)) pairs.push(['sceneNumbers', str(numbers)]);
  if (typeof o.continued === 'boolean') pairs.push(['continued', String(o.continued)]);
  return pairs.length === 0 ? '{}' : oneLine(pairs);
}

function derived(d: Derived): string {
  const keys = Object.keys(d.wordCounts).sort();
  const body =
    keys.length === 0
      ? `${INDENT.repeat(2)}"wordCounts": {},`
      : [
          `${INDENT.repeat(2)}"wordCounts": {`,
          keys
            .map(
              (k, i) =>
                `${INDENT.repeat(3)}${str(k)}: ${String(d.wordCounts[k] ?? 0)}${
                  i < keys.length - 1 ? ',' : ''
                }`,
            )
            .join('\n'),
          `${INDENT.repeat(2)}},`,
        ].join('\n');
  return [
    `${INDENT}"derived": {`,
    body,
    `${INDENT.repeat(2)}"computedAt": ${str(d.computedAt)}`,
    `${INDENT}},`,
  ].join('\n');
}

/**
 * Serialize a manifest to its canonical `caotang.json` text.
 *
 * `wordCounts` keys are sorted so that a reorg — which changes no id and no
 * count — produces a byte-identical manifest, keeping the §8 acceptance test's
 * "diff is empty" honest.
 *
 * Throws `MigrationError` when the manifest's own `formatVersion` is not this
 * build's current one — see the module note. A writer has no registry, so it can
 * neither migrate nor vouch for a version it did not receive already correct;
 * the honest answer is to refuse and let the caller route through the load path,
 * which is where §6 puts the upgrade and the notice.
 */
export function serializeManifest(
  manifest: Manifest,
  format: FormatContext = PRODUCTION_FORMAT,
): string {
  const from = readFormatVersion(manifest);
  if (from !== format.current) {
    throw new MigrationError(
      from < format.current
        ? `refusing to stamp a v${format.current} formatVersion on a v${from} manifest: it has not ` +
          `been migrated, and §6's parenthetical — "no rolling forward on unrelated edits" — is ` +
          `what forbids it. Load it first; the §6 registry is the only thing that can upgrade it.`
        : `refusing to stamp a v${format.current} formatVersion on a v${from} manifest: it is ` +
          `newer than this build, and writing it at v${format.current} would drop fields this ` +
          `serializer does not know it has.`,
      from,
      format.current,
    );
  }

  const parts: string[] = ['{', `${INDENT}"app": ${str(manifest.app)},`];
  parts.push(`${INDENT}"formatVersion": ${String(format.current)},`);
  parts.push(projectIdentity(manifest.project));
  parts.push(
    [
      `${INDENT}"vocabulary": {`,
      `${INDENT.repeat(2)}"statuses": ${objectArray(manifest.vocabulary.statuses.map(term), 2)},`,
      `${INDENT.repeat(2)}"labels": ${objectArray(manifest.vocabulary.labels.map(term), 2)}`,
      `${INDENT}},`,
    ].join('\n'),
  );
  parts.push(`${INDENT}"tree": ${objectArray(manifest.tree.map(node), 1)},`);
  parts.push(derived(manifest.derived));

  // Additive arrays are written only when present: absence is a valid v1 state
  // and a load→write cycle must not invent entries the author never made.
  if (manifest.codex !== undefined) {
    parts.push(`${INDENT}"codex": ${objectArray(manifest.codex.map(codexEntry), 1)},`);
  }
  if (manifest.filters !== undefined) {
    parts.push(`${INDENT}"filters": ${objectArray(manifest.filters.map(savedFilter), 1)},`);
  }
  if (manifest.goals !== undefined) {
    parts.push(`${INDENT}"goals": ${objectArray(manifest.goals.map(projectGoal), 1)},`);
  }
  if (manifest.recipes !== undefined) {
    parts.push(`${INDENT}"recipes": ${objectArray(manifest.recipes.map(exportRecipe), 1)},`);
  }

  // Drop the trailing comma of the last member, then close.
  const last = parts.length - 1;
  parts[last] = (parts[last] as string).replace(/,$/, '');
  return `${parts.join('\n')}\n}\n`;
}
