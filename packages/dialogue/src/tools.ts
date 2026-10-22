/**
 * The two dialogue agent tools — [dialogue-narrative.md §7](../../../docs/architecture/dialogue-narrative.md),
 * registry rows 22 (`dialogue.draft`, write-confirm) and 23 (`dialogue.table`, read) of agent-harness.md §3.
 *
 * Each tool is declared in the shape the harness registry reads (`kind`, `meta`, `params` as the harness's
 * `ObjectSpec`, the `schema` the harness derives from `params` with its own `toJsonSchema`, and a port name).
 * The handlers are harness ports: each returns the bus's `Result<ToolValue, CommandError>`, the shape
 * `ToolPort` names, so registration maps each `port` to its handler. Two things belong to the integration,
 * not this module: the harness's closed `PortToolName`, `TOOL_NAMES` and `TOOL_METADATA` must widen to take
 * these two names, and the drafted body is written through the bus after approval.
 *
 * The model call that writes the Ink is the agent loop's (the same arrangement as `scene.draft`):
 * the loop stages the draft as `proposal`, and `dialogue.draft` checks it and builds the card.
 */

import type { CommandError, CommandErrorCode, JsonSchema, ParamSpec, Result, ToolValue } from '@caotang/bus';
import { err, ok, param, refusal, toJsonSchema } from '@caotang/bus';
import { estimateTokens } from '@caotang/codex';
import type { RandomBytes } from '@caotang/ids';
import type { ProjectState } from '@caotang/store';

import { compileInk, type InkMessage } from './compile.js';
import { dialogueSourcesIn, resolveContainer } from './container.js';
import { checkDraft, planDraft } from './draft.js';
import { beatIds, parseInk } from './ink-parse.js';
import { readDialogueMeta, type DialogueContainerMeta } from './kinds.js';
import { ensureLineIds, lineIdsOf, stripLineIdTags } from './line-ids.js';
import { buildRows, toCsv, toJsonRows } from './table.js';
import { unreachableNodes, validateContainer } from './validate.js';

export const DIALOGUE_TOOL_NAMES = ['dialogue.draft', 'dialogue.table'] as const;
export type DialogueToolName = (typeof DIALOGUE_TOOL_NAMES)[number];

/** The harness's object spec, the type of every tool's params. The harness's index does not export the name, so it is read off `ParamSpec`. */
type ObjectSpec = Extract<ParamSpec, { readonly kind: 'object' }>;

export function isDialogueToolName(value: unknown): value is DialogueToolName {
  return (DIALOGUE_TOOL_NAMES as readonly unknown[]).includes(value);
}

/** The harness's risk column, restricted to what these two tools use. */
export type DialogueToolRisk = 'read' | 'write-confirm';

/**
 * Mirrors the harness's `ToolMetadata` fields. `name` is this module's name type, because the harness's
 * `ToolName` is closed at its own rows until integration widens it. `surface` is `extension`: the track is post-v0.1.
 */
export interface DialogueToolMeta {
  readonly name: DialogueToolName;
  readonly risk: DialogueToolRisk;
  readonly undoable: boolean;
  readonly response_token_cap: number;
  readonly descriptionVersion: number;
  readonly description: string;
  readonly surface: 'extension';
  /** Every module row is deferred: the planner declares it only once `tool.search` or a preload loads it (agent-harness §3). */
  readonly load: 'deferred';
  /** Extra search terms for `tool.search`; never shown to the model. */
  readonly keywords: readonly string[];
}

/**
 * One registry entry, in the harness's `PortEntry` shape: `kind`, `meta`, `params`, the derived `schema`, and
 * the port it runs as. The only difference from the harness's own type is that `meta.name` and `port` take
 * this module's names; see the header.
 */
export interface DialogueToolEntry {
  readonly kind: 'port';
  readonly meta: DialogueToolMeta;
  readonly params: ObjectSpec;
  /** Derived from `params` by the harness's `toJsonSchema`. Never written by hand. */
  readonly schema: JsonSchema;
  readonly port: DialogueToolName;
}

/** The Ink block the agent loop drafted for one `dialogue.draft` call. Staged by the loop, never by the model's params. */
export interface DialogueProposal {
  readonly ink: string;
}

/**
 * The context a dialogue port runs in. It is a subset of the harness's `PortContext`, so a registry passes its
 * own context in: `proposal` arrives as `unknown` and is checked here.
 */
export interface DialogueToolContext {
  readonly state: ProjectState;
  /** The loop's staged draft. Required by `dialogue.draft`, unused by `dialogue.table`. */
  readonly proposal?: unknown;
  /** The container's metadata, by node id. Absent means the defaults. */
  readonly metaFor?: (nodeId: string) => DialogueContainerMeta | undefined;
  /** Randomness for minted line ids. Injectable so a fixture mints the same ids every run. */
  readonly randomBytes?: RandomBytes;
}

export type DialogueToolResult = Result<ToolValue, CommandError>;

const TABLE_TOKEN_CAP = 8000;

const DRAFT_DESCRIPTION =
  'Draft dialogue beats as Ink text for one dialogue container, after the named knots or at the end of an empty container. The proposed Ink is compile-checked before the card is shown: a compile error blocks it, and a new warning is shown for explicit approval. Write-confirm: nothing is written until the writer approves. Never touches other documents.';

const TABLE_DESCRIPTION =
  'Read the dialogue table of one dialogue container: one row per spoken line and choice label, with its line id, speaker, text, context, character limit and locale. It reports the engine target and locale of the container, and says when the export writes a Yarn Spinner strings file instead of this table. Read-only. Pass a title or an id. A container whose lines lack ids says how many. A table over 8,000 tokens is refused: export it with export.compile instead.';

const DRAFT_PARAMS: ObjectSpec = param.object(
  'The container, the brief, and where the draft goes.',
  {
    doc: param.string('The dialogue container, by title or id.', { nonBlank: true }),
    instruction: param.string('The creative brief for the beats.', { nonBlank: true }),
    fromBeats: param.list(
      'Knot or stitch ids to continue from. The draft goes after the last one. Omit to append at the end.',
      param.string('A knot id, or knot.stitch.', { nonBlank: true }),
      { maxItems: 20, unique: true },
    ),
    target_lines: param.integer('A hint for the drafting prompt: about how many spoken lines to write.', { minimum: 1, maximum: 200 }),
  },
  ['doc', 'instruction'],
);

const TABLE_PARAMS: ObjectSpec = param.object(
  'The container and the output form.',
  {
    doc: param.string('The dialogue container, by title or id.', { nonBlank: true }),
    format: param.choice('csv (the default) or json.', ['csv', 'json'], { default: 'csv' }),
    includeConditions: param.boolean('Adds a condition column for choices. Defaults to false.', { default: false }),
  },
  ['doc'],
);

function entryOf(meta: DialogueToolMeta, params: ObjectSpec): DialogueToolEntry {
  return { kind: 'port', meta, params, schema: toJsonSchema(params), port: meta.name };
}

/** The two entries, in the harness's entry shape. Registration maps each `port` to its handler below. */
export const DIALOGUE_TOOL_ENTRIES: readonly DialogueToolEntry[] = [
  entryOf(
    {
      name: 'dialogue.draft',
      risk: 'write-confirm',
      undoable: true,
      response_token_cap: 2000,
      descriptionVersion: 1,
      description: DRAFT_DESCRIPTION,
      surface: 'extension',
      load: 'deferred',
      keywords: ['dialogue', 'cutscene', 'ink', 'interactive', 'narrative', 'branching'],
    },
    DRAFT_PARAMS,
  ),
  entryOf(
    {
      name: 'dialogue.table',
      risk: 'read',
      undoable: false,
      response_token_cap: TABLE_TOKEN_CAP,
      descriptionVersion: 2,
      description: TABLE_DESCRIPTION,
      surface: 'extension',
      load: 'deferred',
      keywords: ['dialogue', 'cutscene', 'ink', 'interactive', 'narrative', 'table'],
    },
    TABLE_PARAMS,
  ),
];

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function messagesOf(list: readonly InkMessage[]): string {
  return list.map((m) => m.text).join('; ');
}

/** A refusal in the bus's shape: a closed code, what happened, and the next step the model should take. */
function refuse(code: CommandErrorCode, message: string, correctiveHint: string, target?: string): Result<never, CommandError> {
  return err(refusal(code, message, { correctiveHint, ...(target === undefined ? {} : { target }) }));
}

/** The proposal as a port context carries it. Anything but an object with Ink text is no proposal. */
export function asDialogueProposal(value: unknown): DialogueProposal | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const ink = (value as { readonly ink?: unknown }).ink;
  return typeof ink === 'string' ? { ink } : undefined;
}

/** The line ids every dialogue container in the project already holds: the set a new id must avoid. */
function projectLineIds(state: ProjectState): Set<string> {
  const ids = new Set<string>();
  for (const source of dialogueSourcesIn(state)) for (const line of lineIdsOf(source.body)) ids.add(line.lineId);
  return ids;
}

/** `dialogue.table`: the rows of one container, as CSV or JSON, refused above the token cap. */
export function dialogueTableTool(params: Readonly<Record<string, unknown>>, context: DialogueToolContext): DialogueToolResult {
  const resolved = resolveContainer(context.state, textOf(params.doc));
  if (!resolved.ok) return err(resolved.error);
  const title = resolved.node.title;
  const compiled = compileInk(resolved.body);
  if (!compiled.ok) {
    return refuse('invalid-params', `the Ink in "${title}" does not compile, so it has no table`, `fix the Ink first. The compiler says: ${messagesOf(compiled.errors)}`, 'params.doc');
  }
  const read = readDialogueMeta(resolved.node.dialogue);
  const meta = context.metaFor?.(resolved.node.id) ?? read.meta;
  // The exporter's rule: the container's locBaseline, else the project's language, with no further check.
  const projectLanguage = context.state.manifest.project.language?.trim() ?? '';
  const locale = meta.locBaseline ?? projectLanguage;
  const rows = buildRows([{ id: resolved.node.id, title, body: resolved.body, meta }], {
    entries: context.state.manifest.codex ?? [],
    locale: projectLanguage,
  });
  const includeConditions = params.includeConditions === true;
  const json = params.format === 'json';
  const missing = rows.filter((row) => row.missing).length;
  const payload = json ? JSON.stringify(toJsonRows(rows)) : toCsv(rows, { includeConditions, includeLocale: true });
  const tokens = estimateTokens(payload);
  if (tokens > TABLE_TOKEN_CAP) {
    return refuse(
      'limit-exceeded',
      `the table for "${title}" is about ${tokens} tokens, over the ${TABLE_TOKEN_CAP}-token cap`,
      'export it with export.compile for the artifact',
      'params.doc',
    );
  }
  const data: Record<string, unknown> = {
    containerId: resolved.node.id,
    title,
    format: json ? 'json' : 'csv',
    rows: rows.length,
    missingLineIds: missing,
    engineTarget: meta.engineTarget ?? null,
    locale: locale === '' ? null : locale,
    ...(json ? { table: toJsonRows(rows) } : { csv: payload }),
  };
  // Fixed strings only: a hand-edited setting never reaches the model through a note.
  const notes: string[] = [];
  if (missing > 0) notes.push(`${missing} spoken line(s) have no line id. The save path mints them when autoLineIds is on.`);
  if (meta.engineTarget === 'yarn-csv') {
    notes.push(
      "This container's engine target is yarn-csv, so the export writes a Yarn Spinner strings file for it, `<base> (dialogue, Yarn).csv`, not the dialogue table.",
    );
  }
  notes.push('The charLimit column is empty because this tool has no export recipe; an empty column does not mean the export leaves it unconstrained.');
  if (locale === '') notes.push('The container has no locale and the project has no language, so the locale column is empty.');
  if (read.notes.length > 0) notes.push('A container setting could not be used and was ignored.');
  const value: ToolValue = {
    data,
    summary: `${rows.length} row(s) from "${title}"; ${missing} without a line id.`,
    affected: [],
    notes,
  };
  return ok(value);
}

/**
 * `dialogue.draft`: the staged draft, placed and gated. The candidate body is returned in `data.body`, the
 * text a write would store once the writer approves; nothing is written here. A refusal names the compile
 * error, the beat that is missing, or the text that would not play.
 */
export function dialogueDraftTool(params: Readonly<Record<string, unknown>>, context: DialogueToolContext): DialogueToolResult {
  const resolved = resolveContainer(context.state, textOf(params.doc));
  if (!resolved.ok) return err(resolved.error);
  const title = resolved.node.title;
  const proposal = asDialogueProposal(context.proposal);
  if (proposal === undefined) {
    return refuse(
      'invalid-params',
      'no Ink was staged for this call',
      'dialogue.draft runs through the agent loop, which stages the drafted Ink before the card is shown. Ask the agent to draft the beats again.',
      'params',
    );
  }

  // The ids the model typed are not kept (§2.2): strip them, then mint fresh ids for the draft's own lines
  // against every id the project holds. The container's existing lines are left as they are.
  const stripped = stripLineIdTags(proposal.ink);
  const minted = ensureLineIds(stripped.ink, {
    taken: projectLineIds(context.state),
    ...(context.randomBytes === undefined ? {} : { randomBytes: context.randomBytes }),
  });

  const fromBeats = Array.isArray(params.fromBeats) ? params.fromBeats.filter((id): id is string => typeof id === 'string') : [];
  const planned = planDraft(resolved.body, minted.body, fromBeats);
  if (!planned.ok) {
    return refuse(planned.code === 'unknown-beats' ? 'not-found' : 'invalid-params', planned.message, planned.correctiveHint, 'params.fromBeats');
  }
  const check = checkDraft(resolved.body, planned.plan.body);
  if (check.baseErrors.length > 0) {
    return refuse('invalid-params', `the Ink in "${title}" does not compile before any draft`, `fix it first. The compiler says: ${messagesOf(check.baseErrors)}`, 'params.doc');
  }
  if (check.errors.length > 0) {
    return refuse(
      'invalid-params',
      `the draft does not compile, so no card is shown: ${messagesOf(check.errors)}`,
      'draft again with these compile errors fixed',
      'proposal',
    );
  }

  const candidate = planned.plan.body;
  const graph = parseInk(candidate).graph;
  const baseBeats = new Set(beatIds(parseInk(resolved.body).graph));
  const newBeats = beatIds(graph).filter((id) => !baseBeats.has(id));
  const unreached = unreachableNodes(graph).filter((node) => newBeats.includes(node.id));
  const report = validateContainer(resolved.node.id, candidate, { entries: context.state.manifest.codex ?? [] });

  // Drafted text that no path reaches, and a spoken line the table cannot key, both need the writer's approval.
  const warnings: string[] = [...check.newWarnings];
  for (const node of unreached) {
    warnings.push(`"${node.id}" is never diverted to, so no path plays the drafted text. Name it from a choice or a divert in a beat that plays.`);
  }
  for (const line of minted.unplaceable) {
    warnings.push(`line ${line.line} of the draft ("${line.text}") has no line id: ${line.reason}. Move the divert onto its own line, or the table cannot be exported.`);
  }

  const notes: string[] = [];
  if (stripped.removed > 0) notes.push(`${stripped.removed} line id tag(s) in the draft were removed: Caotang mints the ids itself.`);
  const written = parseInk(minted.body).lines.length;
  const target = typeof params.target_lines === 'number' ? params.target_lines : undefined;
  if (target !== undefined && Math.abs(written - target) > target / 2) {
    notes.push(`the draft has ${written} spoken line(s) against a target of ${target}.`);
  }

  const data: Record<string, unknown> = {
    containerId: resolved.node.id,
    title,
    mode: planned.plan.mode,
    insertedAt: planned.plan.insertedAt,
    anchor: planned.plan.anchor,
    newBeats,
    body: candidate,
    warnings,
    requiresApproval: warnings.length > 0 ? 'warnings' : 'none',
    findings: report.findings.map((f) => f.message),
  };
  const summary =
    warnings.length > 0
      ? `Draft for "${title}" compiles with ${warnings.length} warning(s); approval is needed.`
      : `Draft for "${title}" compiles cleanly.`;
  const value: ToolValue = { data, summary, affected: [], ...(notes.length > 0 ? { notes } : {}) };
  return ok(value);
}

/** Runs one dialogue tool by its port name. The registration path calls this for each `port`. */
export function runDialogueTool(name: DialogueToolName, params: Readonly<Record<string, unknown>>, context: DialogueToolContext): DialogueToolResult {
  return name === 'dialogue.draft' ? dialogueDraftTool(params, context) : dialogueTableTool(params, context);
}
