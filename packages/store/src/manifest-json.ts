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

import { CHAR_LIMIT_MAX, RECIPE_SCRIPT_FONTS, SCENE_NUMBER_OPTIONS, type HookCheck, type ProjectHook, type ProjectMacro } from '@caotang/bus';
import type { PermissionRule } from './agent-rules.js';
import { jsonValueProblem } from './json-value.js';
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

/**
 * How a value that cannot be written is named in the error that says so.
 *
 * A refused write has to be *actionable*: the caller has to be able to say
 * which field was missing, and the field's name is in the message — the value
 * is only there so a wrong *type* can be told from a missing one.
 */
function describeValue(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (typeof value === 'string') return `the string ${JSON.stringify(value)}`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return Array.isArray(value) ? 'a list' : 'an object';
}

/**
 * A JSON string for a field the writer must have.
 *
 * `JSON.stringify(undefined)` is `undefined`, and the emitter pasted it into
 * the file as the bare word `undefined` — which is not JSON, so the manifest a
 * save had just written could not be parsed by the next open. A field that
 * cannot be encoded is a **refusal**, not a warning: the write fails before
 * anything reaches the disk, and the error names the field.
 *
 * `field` is the field's name in the manifest, so the error can say which one
 * is missing rather than only that something is.
 */
function str(value: string, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`cannot write "${field}": expected a string, got ${describeValue(value)}`);
  }
  return JSON.stringify(value);
}

function scalar(value: string | number | boolean | null, field: string): string {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    // `String()` writes a non-finite number bare (`from: NaN`), which is not
    // JSON and fails the next load, so the write is refused and the field is
    // named. The load drops the values that could get here (validate.ts), and
    // this is the second guard.
    if (!Number.isFinite(value)) {
      throw new Error(`cannot write "${field}": ${String(value)} is not a JSON number`);
    }
    return String(value);
  }
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return str(value, field);
  throw new Error(
    `cannot write "${field}": expected a string, a number, a boolean or null, got ${describeValue(value)}`,
  );
}

/**
 * A JSON value for a saved-filter criterion or a node's media metadata.
 *
 * A filter criterion's value is a string, a number, a boolean, null or a list
 * of strings (binder-filters §2's criteria, and validate.ts `isCriterionValue`
 * — the load drops a filter whose criterion the writer could not write back);
 * a node's `shot`/`dialogue` metadata goes through here as the object it is
 * (project-format.md §2's media note). Either way the value is written as the
 * JSON it is, bare, so the file reads as JSON rather than as a quoted list.
 *
 * The whole value is checked, not only its top: a number has to be finite and
 * a BigInt cannot appear at all, because `JSON.stringify` writes NaN and
 * Infinity as `null` — a save that silently changes the value — and throws an
 * unnamed `TypeError` for a BigInt. A node's media metadata is an object, so a
 * check of the top alone would never see what is inside it. Both are refusals
 * here, naming the field, so the write either tells the truth or does not
 * happen.
 */
function criterion(value: unknown, field: string): string {
  const problem = jsonValueProblem(value);
  if (problem !== undefined) {
    throw new Error(`cannot write "${field}${problem.path}": ${problem.reason}`);
  }
  const text = JSON.stringify(value);
  if (text === undefined) {
    throw new Error(`cannot write "${field}": the value cannot be written as JSON`);
  }
  return text;
}

/** A JSON object key. A key is always a string, so this cannot fail. */
function key(name: string): string {
  return JSON.stringify(name);
}

/** Scalar arrays stay inline (`"keywords": []`) — they are short by contract. */
function inlineArray(values: readonly unknown[], field: string): string {
  if (values.length === 0) return '[]';
  return `[${values.map((v) => scalar(v as string, field)).join(', ')}]`;
}

/** One object element per line. `depth` is the indent level of the key itself. */
function objectArray(items: readonly string[], depth: number): string {
  if (items.length === 0) return '[]';
  const inner = INDENT.repeat(depth + 1);
  return `[\n${items.map((i) => `${inner}${i}`).join(',\n')}\n${INDENT.repeat(depth)}]`;
}

function oneLine(pairs: readonly [string, string][]): string {
  return `{ ${pairs.map(([k, v]) => `${key(k)}: ${v}`).join(', ')} }`;
}

function term(t: VocabularyTerm): string {
  return oneLine([
    ['id', str(t.id, 'vocabulary.id')],
    ['name', str(t.name, 'vocabulary.name')],
    ['color', str(t.color, 'vocabulary.color')],
  ]);
}

/**
 * The node fields the serializer writes only when they are present, with the writer for each.
 *
 * One record of what a node can carry: the serializer writes from this table, and the load's gate
 * (`test/read-refusal.test.ts`) builds its fixture from it, so a field added to a node cannot be
 * written without the gate seeing it too — the two halves cannot drift apart into a field the
 * writer writes and the load does not know.
 */
export const OPTIONAL_NODE_FIELDS: readonly OptionalNodeField[] = [
  { key: 'kind', value: (node: TreeNode) => node.kind, write: (value) => str(value as string, 'node.kind') },
  { key: 'shot', value: (node: TreeNode) => node.shot, write: (value) => criterion(value, 'node.shot') },
  { key: 'dialogue', value: (node: TreeNode) => node.dialogue, write: (value) => criterion(value, 'node.dialogue') },
  { key: 'style', value: (node: TreeNode) => node.style, write: (value) => str(value as string, 'node.style') },
  { key: 'createdAt', value: (node: TreeNode) => node.createdAt, write: (value) => str(value as string, 'node.createdAt') },
  { key: 'updatedAt', value: (node: TreeNode) => node.updatedAt, write: (value) => str(value as string, 'node.updatedAt') },
];

/** One optional node field: where its value is, and how it is written. */
interface OptionalNodeField {
  /** The manifest key it is written under. */
  readonly key: 'kind' | 'shot' | 'dialogue' | 'style' | 'createdAt' | 'updatedAt';
  /** The node's value for it, or `undefined` when the node does not carry it. */
  readonly value: (node: TreeNode) => unknown;
  /** The text the serializer writes for it. */
  readonly write: (value: unknown) => string;
}

function node(n: TreeNode): string {
  const pairs: [string, string][] = [
    ['id', str(n.id, 'node.id')],
    ['parentId', n.parentId === null ? 'null' : str(n.parentId, 'node.parentId')],
    ['type', str(n.type, 'node.type')],
    ['title', str(n.title, 'node.title')],
    ['order', scalar(n.order, 'node.order')],
    ['status', n.status === null ? 'null' : str(n.status, 'node.status')],
    ['label', n.label === null ? 'null' : str(n.label, 'node.label')],
    ['keywords', inlineArray(n.keywords, 'node.keywords')],
    ['synopsis', str(n.synopsis, 'node.synopsis')],
    ['notes', str(n.notes, 'node.notes')],
  ];
  // The fields that are written only when they are present (project-format.md §2's media note, and the additive
  // timestamps): a project with no media nodes and no timestamps round-trips with no new key. A shot's and a
  // container's metadata is held as an object the storyboard and dialogue engines read, so it is written as one line of
  // JSON: one node, one line, as the tree rule asks, and the key order is the one the engine gave it.
  //
  // The table is the writer's own record of them, so the load's gate can build its fixture from it and a field added to
  // a node cannot be written without the gate seeing it too.
  for (const field of OPTIONAL_NODE_FIELDS) {
    const value = field.value(n);
    if (value === undefined) continue;
    pairs.push([field.key, field.write(value)]);
  }
  return oneLine(pairs);
}

function source(source: CodexEntry['sources'][number]): string {
  // codex.md §2's EntrySource, in its own key order. The optional fields are written
  // when present and only then, so a citation with none of them is unchanged.
  const fields: [string, string][] = [
    ['docId', str(source.docId, 'source.docId')],
    ['quote', str(source.quote, 'source.quote')],
  ];
  // The offsets go through `scalar`, whose number branch refuses a non-finite
  // value rather than writing it bare (`from: NaN` is not JSON and fails the
  // next load). The loader drops a citation with such an offset (validate.ts),
  // so this is the second guard: a value that somehow got past the first
  // refuses the save, and a serializer refusal leaves `caotang.json` itself
  // unwritten, so the file stays parseable either way.
  if (source.from !== undefined) fields.push(['from', scalar(source.from, 'source.from')]);
  if (source.to !== undefined) fields.push(['to', scalar(source.to, 'source.to')]);
  if (source.extractedAt !== undefined) fields.push(['extractedAt', str(source.extractedAt, 'source.extractedAt')]);
  return oneLine(fields);
}

function codexEntry(c: CodexEntry): string {
  const pairs: [string, string][] = [
    ['id', str(c.id, 'codex.id')],
    ['name', str(c.name, 'codex.name')],
    ['aliases', inlineArray(c.aliases, 'codex.aliases')],
    ['type', str(c.type, 'codex.type')],
    ['description', str(c.description, 'codex.description')],
    ['includePolicy', str(c.includePolicy, 'codex.includePolicy')],
    ['caseSensitive', scalar(c.caseSensitive, 'codex.caseSensitive')],
    ['exclude', inlineArray(c.exclude, 'codex.exclude')],
    ['attachments', inlineArray(c.attachments, 'codex.attachments')],
    ['keywords', inlineArray(c.keywords, 'codex.keywords')],
    // video-prompt-pack.md §3: written only when there are some, so an entry without them is byte-identical to before.
    ...(c.visualRefs === undefined || c.visualRefs.length === 0
      ? []
      : [['visualRefs', inlineArray(c.visualRefs, 'codex.visualRefs')] as [string, string]]),
    ['origin', str(c.origin, 'codex.origin')],
    ['sources', objectArray(c.sources.map(source), 2)],
  ];
  // An entry restored by the §5.4 rebuild has no recorded timestamps, because
  // codex.md §3's redundancy file does not carry them. Omitted rather than
  // invented — same rule as the additive tree-node timestamps above.
  if (c.createdAt !== undefined) pairs.push(['createdAt', str(c.createdAt, 'codex.createdAt')]);
  if (c.updatedAt !== undefined) pairs.push(['updatedAt', str(c.updatedAt, 'codex.updatedAt')]);
  return oneLine(pairs);
}

/**
 * binder-filters §2. `root` is written only when the filter is scoped, so an unscoped filter round-trips with no new key.
 * The bug this replaces dropped the root on every save.
 */
function savedFilter(f: SavedFilter): string {
  const pairs: [string, string][] = [
    ['id', str(f.id, 'filter.id')],
    ['name', str(f.name, 'filter.name')],
  ];
  if (f.root !== undefined) pairs.push(['root', str(f.root, 'filter.root')]);
  pairs.push(
    ['criteria', inlineObject(f.criteria)],
    ['createdAt', str(f.createdAt, 'filter.createdAt')],
    ['updatedAt', str(f.updatedAt, 'filter.updatedAt')],
  );
  return oneLine(pairs);
}

/**
 * goals-progress §2.2. `deadline` and `archived` are written only when present, so an open-ended goal carries no
 * empty key. A goal of the pre-spec shape is no longer written at all.
 */
function projectGoal(g: ProjectGoal): string {
  const pairs: [string, string][] = [
    ['id', str(g.id, 'goal.id')],
    ['nodeId', str(g.nodeId, 'goal.nodeId')],
    ['metric', str(g.metric, 'goal.metric')],
  ];
  // goals-progress §9.3: a session kind is written only when there is one, so a project goal round-trips with no new key.
  if (g.kind !== undefined && g.kind !== 'project') pairs.push(['kind', str(g.kind, 'goal.kind')]);
  // goals-progress §9.3: a reset day is written only when the writer chose one, so a goal with the default window keeps its bytes.
  if (g.resetDay !== undefined) {
    pairs.push([
      'resetDay',
      g.resetDay === 'last' ? str('last', 'goal.resetDay') : scalar(g.resetDay, 'goal.resetDay'),
    ]);
  }
  pairs.push(['comparator', str(g.comparator, 'goal.comparator')], ['target', scalar(g.target, 'goal.target')]);
  if (g.deadline !== undefined) pairs.push(['deadline', str(g.deadline, 'goal.deadline')]);
  if (g.archived !== undefined) pairs.push(['archived', scalar(g.archived, 'goal.archived')]);
  pairs.push(['createdAt', str(g.createdAt, 'goal.createdAt')], ['updatedAt', str(g.updatedAt, 'goal.updatedAt')]);
  return oneLine(pairs);
}

/**
 * extensibility.md §10. A macro is a block, not a line: its fields one to a line and its steps one to a line, so a changed step is a one-line
 * diff. A step's params and the macro's param spec are written as the JSON they are, in the key order they hold.
 */
function macroBlock(m: ProjectMacro): string {
  const inner = INDENT.repeat(3);
  const steps = m.steps.map((step) =>
    oneLine([
      ['tool', str(step.tool, 'macro.step.tool')],
      ['params', criterion(step.params, 'macro.step.params')],
      ['expect', str(step.expect, 'macro.step.expect')],
    ]),
  );
  return [
    '{',
    `${inner}"id": ${str(m.id, 'macro.id')},`,
    `${inner}"slug": ${str(m.slug, 'macro.slug')},`,
    `${inner}"name": ${str(m.name, 'macro.name')},`,
    `${inner}"description": ${str(m.description, 'macro.description')},`,
    `${inner}"params": ${criterion(m.params, 'macro.params')},`,
    `${inner}"steps": ${objectArray(steps, 3)}`,
    `${INDENT.repeat(2)}}`,
  ].join('\n');
}

/**
 * agent-harness §4, Rules. One rule per line under `agent.rules`, keys in a fixed order; `scope`, `access` and `note` are written only
 * when present, so a rule round-trips with no new key. A project with no rules, no hooks and no other `agent` key writes no `agent` key at all.
 */
function agentRule(r: PermissionRule): string {
  const pairs: [string, string][] = [['effect', str(r.effect, 'rule.effect')], ['tool', str(r.tool, 'rule.tool')]];
  if (r.scope !== undefined) {
    pairs.push(['scope', 'subtree' in r.scope ? oneLine([['subtree', str(r.scope.subtree, 'rule.scope')]]) : oneLine([['path', str(r.scope.path, 'rule.scope')]])]);
  }
  if (r.access !== undefined) pairs.push(['access', str(r.access, 'rule.access')]);
  if (r.note !== undefined) pairs.push(['note', str(r.note, 'rule.note')]);
  return oneLine(pairs);
}

/** A hook's check, with a pattern list one pattern to a line so a changed pattern is a one-line diff. */
function hookCheck(check: HookCheck, depth: number): string {
  if (check.kind !== 'pattern') return criterion(check, 'hook.handler.check');
  const patterns = check.patterns.map((p) => oneLine([['match', str(p.match, 'hook.pattern.match')], ['message', str(p.message, 'hook.pattern.message')]]));
  return `{ "kind": "pattern", "patterns": ${objectArray(patterns, depth)} }`;
}

/**
 * hooks.md. A hook is a block, not a line: its fields one to a line, in a fixed order, and the optional ones only when present, so a
 * hook round-trips with no new key.
 */
function hookBlock(h: ProjectHook): string {
  const inner = INDENT.repeat(4);
  const lines = [
    `${inner}"id": ${str(h.id, 'hook.id')},`,
    `${inner}"name": ${str(h.name, 'hook.name')},`,
    `${inner}"event": ${str(h.event, 'hook.event')},`,
  ];
  if (h.matcher !== undefined) lines.push(`${inner}"matcher": ${criterion(h.matcher, 'hook.matcher')},`);
  lines.push(`${inner}"handler": { "kind": "check", "check": ${hookCheck(h.handler.check, 4)} },`);
  if (h.onBlock !== undefined) lines.push(`${inner}"onBlock": ${str(h.onBlock, 'hook.onBlock')},`);
  if (h.failClosed !== undefined) lines.push(`${inner}"failClosed": ${scalar(h.failClosed, 'hook.failClosed')},`);
  lines.push(`${inner}"enabled": ${scalar(h.enabled, 'hook.enabled')}`);
  return ['{', ...lines, `${INDENT.repeat(3)}}`].join('\n');
}

const AGENT_KNOWN = new Set(['rules', 'hooks']);

/** The keys under `agent` this build does not know, in the order they were read: written back as they were. */
function agentExtras(agent: NonNullable<Manifest['agent']>): [string, unknown][] {
  return Object.entries(agent).filter(([name, value]) => !AGENT_KNOWN.has(name) && value !== undefined);
}

function hasAgentBlock(agent: Manifest['agent']): agent is NonNullable<Manifest['agent']> {
  if (agent === undefined) return false;
  return (agent.rules?.length ?? 0) > 0 || (agent.hooks?.length ?? 0) > 0 || agentExtras(agent).length > 0;
}

function agentBlock(agent: NonNullable<Manifest['agent']>): string {
  const members: string[] = [];
  if (agent.rules !== undefined && agent.rules.length > 0) members.push(`${INDENT.repeat(2)}"rules": ${objectArray(agent.rules.map(agentRule), 2)}`);
  if (agent.hooks !== undefined && agent.hooks.length > 0) members.push(`${INDENT.repeat(2)}"hooks": ${objectArray(agent.hooks.map(hookBlock), 2)}`);
  for (const [name, value] of agentExtras(agent)) members.push(`${INDENT.repeat(2)}${key(name)}: ${criterion(value, `agent.${name}`)}`);
  return [`${INDENT}"agent": {`, members.join(',\n'), `${INDENT}},`].join('\n');
}

/** Best-effort inline rendering for a free-form map (saved-filter criteria). */
function inlineObject(value: Record<string, unknown>): string {
  const parts = Object.entries(value).map(([k, v]) => `${key(k)}: ${criterion(v, `filter.criteria.${k}`)}`);
  if (parts.length === 0) return '{}';
  return `{ ${parts.join(', ')} }`;
}

function projectIdentity(p: ProjectIdentity): string {
  // The EPUB floor (epub-metadata.md) is written only when present, in the order it
  // is specified, so a project that never set one round-trips with no new key.
  const lines = [
    `${INDENT}"project": {`,
    `${INDENT}${INDENT}"id": ${str(p.id, 'project.id')},`,
    `${INDENT}${INDENT}"name": ${str(p.name, 'project.name')},`,
    `${INDENT}${INDENT}"createdAt": ${str(p.createdAt, 'project.createdAt')},`,
    `${INDENT}${INDENT}"modifiedAt": ${str(p.modifiedAt, 'project.modifiedAt')}`,
  ];
  const optional: string[] = [];
  if (p.language !== undefined) optional.push(`${INDENT}${INDENT}"language": ${str(p.language, 'project.language')}`);
  if (p.identifier !== undefined) optional.push(`${INDENT}${INDENT}"identifier": ${projectIdentifier(p.identifier)}`);
  if (p.coverAssetId !== undefined) {
    optional.push(
      `${INDENT}${INDENT}"coverAssetId": ${p.coverAssetId === null ? 'null' : str(p.coverAssetId, 'project.coverAssetId')}`,
    );
  }
  if (p.author !== undefined) optional.push(`${INDENT}${INDENT}"author": ${str(p.author, 'project.author')}`);
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
  const fields = [`"uuid": ${str(id.uuid, 'project.identifier.uuid')}`];
  if (id.isbn !== undefined) {
    fields.push(`"isbn": ${id.isbn === null ? 'null' : str(id.isbn, 'project.identifier.isbn')}`);
  }
  return `{ ${fields.join(', ')} }`;
}

/** exporter.md §2's recipe, in the key order it is specified in. */
function exportRecipe(r: ExportRecipe): string {
  const fields: [string, string][] = [
    ['name', str(r.name, 'recipe.name')],
    ['includeRootIds', `[${r.includeRootIds.map((id) => str(id, 'recipe.includeRootIds')).join(', ')}]`],
    ['format', str(r.format, 'recipe.format')],
  ];
  if (r.templateId !== undefined) fields.push(['templateId', str(r.templateId, 'recipe.templateId')]);
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
  if (typeof o.author === 'string') pairs.push(['author', str(o.author, 'recipe.options.author')]);
  const limit: unknown = o.charLimit;
  if (typeof limit === 'number' && Number.isSafeInteger(limit) && limit >= 1 && limit <= CHAR_LIMIT_MAX) {
    pairs.push(['charLimit', String(limit)]);
  }
  const numbers: unknown = o.sceneNumbers;
  // The placements the bus accepts, from its own export, so a placement it gains is written, not dropped.
  if (typeof numbers === 'string' && (SCENE_NUMBER_OPTIONS as readonly string[]).includes(numbers)) {
    pairs.push(['sceneNumbers', str(numbers, 'recipe.options.sceneNumbers')]);
  }
  if (typeof o.continued === 'boolean') pairs.push(['continued', String(o.continued)]);
  if (o.pageSize === 'A4' || o.pageSize === 'Letter') {
    pairs.push(['pageSize', str(o.pageSize, 'recipe.options.pageSize')]);
  }
  const font: unknown = o.scriptFont;
  if (typeof font === 'string' && (RECIPE_SCRIPT_FONTS as readonly string[]).includes(font)) {
    pairs.push(['scriptFont', str(font, 'recipe.options.scriptFont')]);
  }
  if (typeof o.paperFrames === 'boolean') pairs.push(['paperFrames', String(o.paperFrames)]);
  if (typeof o.colourEmoji === 'boolean') pairs.push(['colourEmoji', String(o.colourEmoji)]);
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
                // The count goes through `scalar`, whose number branch refuses a
                // non-finite value rather than writing it bare (`wordCounts` is
                // JSON, and a bare `Infinity` is not). The loader drops a count
                // that is not a number (validate.ts), so this is the second guard.
                `${INDENT.repeat(3)}${key(k)}: ${scalar(d.wordCounts[k] ?? 0, `derived.wordCounts.${k}`)}${
                  i < keys.length - 1 ? ',' : ''
                }`,
            )
            .join('\n'),
          `${INDENT.repeat(2)}},`,
        ].join('\n');
  return [
    `${INDENT}"derived": {`,
    body,
    // Only a version above 1 is written, so a project that was never rebuilt keeps its bytes.
    `${INDENT.repeat(2)}"computedAt": ${str(d.computedAt, 'derived.computedAt')}${d.ruleVersion !== undefined && d.ruleVersion > 1 ? ',' : ''}`,
    ...(d.ruleVersion !== undefined && d.ruleVersion > 1
      ? [`${INDENT.repeat(2)}"ruleVersion": ${scalar(d.ruleVersion, 'derived.ruleVersion')}`]
      : []),
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

  const parts: string[] = ['{', `${INDENT}"app": ${str(manifest.app, 'manifest.app')},`];
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
  if (manifest.disabledSkills !== undefined) {
    parts.push(`${INDENT}"disabledSkills": ${inlineArray(manifest.disabledSkills, 'disabledSkills')},`);
  }
  if (manifest.macros !== undefined && manifest.macros.length > 0) {
    parts.push(`${INDENT}"macros": ${objectArray(manifest.macros.map(macroBlock), 1)},`);
  }
  if (hasAgentBlock(manifest.agent)) {
    parts.push(agentBlock(manifest.agent));
  }

  // Drop the trailing comma of the last member, then close.
  const last = parts.length - 1;
  parts[last] = (parts[last] as string).replace(/,$/, '');
  return `${parts.join('\n')}\n}\n`;
}
