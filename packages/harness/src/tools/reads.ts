/**
 * The four read tools — agent-harness.md §3 rows 1–4. None of them dispatches a
 * command: a read reads the store, and command-bus §9 says reads are not commands.
 *
 * Each `prepare` computes its whole value up front, so a read that cannot answer
 * is refused before the caller sees anything partial.
 */

import { ok, type CommandError, type Result } from '@caotang/bus';
import type { ProjectState, TreeNode } from '@caotang/store';

import { capOf } from '../metadata.js';
import { charBudget, estimateTokens, fitsCap } from '../tokens.js';
import { failure, invalidParams, notFound } from '../errors.js';
import { childrenOf, descendantsOf, DOCUMENT, resolveId, resolveNode } from '../resolve.js';
import { firstCodePoints } from '../util.js';
import { param, type ObjectSpec } from '../schema.js';
import type { CallParams, PreparedCall, PrepareContext, ToolValue } from '../types.js';
import { bodyOf, wordsOfDocument } from './common.js';

/** Characters a read's JSON wrapper takes beyond its rows, reserved from the cap. */
const WRAPPER_RESERVE_CHARS = 400;

function readOnly(value: ToolValue): PreparedCall {
  return { commands: [], finish: () => ok(value) };
}

function fail<T>(error: CommandError): Result<T, CommandError> {
  return failure(error) as Result<T, CommandError>;
}

/* ------------------------------------------------------------------ *
 * project.overview
 * ------------------------------------------------------------------ */

export const projectOverviewParams: ObjectSpec = param.object('No parameters: the overview of the open project.', {}, []);

/**
 * The empty-project note, for the caller's write mode. The agent in the app may write, so the note names the tool that makes
 * chapters. An external caller of a read-only harness is told where chapters are made, and no write tool is named to it.
 */
function emptyNoteFor(writes: boolean): string {
  return writes
    ? 'The project has no documents yet. Use binder.restructure to create chapters.'
    : 'The project has no documents yet. Chapters are made in Caotang, because this server is read-only.';
}

export function prepareProjectOverview(_params: CallParams, context: PrepareContext): Result<PreparedCall, CommandError> {
  const { state } = context;
  const documents = state.manifest.tree.filter(DOCUMENT);
  const totalWords = documents.reduce((sum, node) => sum + wordsOfDocument(state, node.id), 0);
  const empty = documents.length === 0;

  // Level one is every part of the binder; level two is what each part holds. A
  // long binder shows fewer level-two rows, and says so, rather than overrunning
  // the cap: the rest is one binder.read_tree call away.
  const parts = childrenOf(state, 'root');
  const childrenOfId = (id: string) => childrenOf(state, id);
  const tree = (limit: number) =>
    parts.map((level1) => {
      const kids = childrenOfId(level1.id);
      return {
        id: level1.id,
        title: level1.title,
        type: level1.type,
        status: level1.status,
        children: kids.slice(0, limit).map((level2) => ({
          id: level2.id,
          title: level2.title,
          type: level2.type,
          status: level2.status,
        })),
        ...(kids.length > limit ? { childrenTotal: kids.length } : {}),
      };
    });

  const session = context.session?.();
  // A goal has no name of its own (goals-progress §2.2): the name a reader sees is its target's title, which keeps this key.
  const goals = (state.manifest.goals ?? []).map((goal) => ({
    id: goal.id,
    name: state.manifest.tree.find((node) => node.id === goal.nodeId)?.title ?? goal.nodeId,
    target: goal.target,
  }));
  const build = (limit: number) => ({
    title: state.manifest.project.name,
    empty,
    tree: tree(limit),
    vocabulary: {
      statuses: state.manifest.vocabulary.statuses.map((term) => ({ id: term.id, name: term.name })),
      labels: state.manifest.vocabulary.labels.map((term) => ({ id: term.id, name: term.name })),
    },
    totalWords,
    session: session === undefined ? null : { todayWords: session.todayWords, target: session.target ?? null },
    savedFilters: state.manifest.filters?.length ?? 0,
    filters: (state.manifest.filters ?? []).map((filter) => ({ id: filter.id, name: filter.name })),
    goals,
  });

  const widest = Math.max(0, ...parts.map((part) => childrenOfId(part.id).length));
  let limit = widest;
  while (limit > 0 && !fitsCap(build(limit), capOf('project.overview'))) limit = Math.floor(limit / 2);
  const data = build(limit);
  const trimmed = limit < widest;

  const notes = [
    ...(empty ? [emptyNoteFor(context.writes !== false)] : []),
    ...(trimmed
      ? [`The tree shows ${limit} of its widest part's children. Use binder.read_tree on a part to see the rest.`]
      : []),
    ...(goals.length > 0
      ? [
          'Goal rows carry name and target only. Progress and pace need the goal’s node and comparator, which the stored goal does not yet record.',
        ]
      : []),
  ];

  return ok(
    readOnly({
      data,
      summary: `"${state.manifest.project.name}": ${documents.length} documents, ${totalWords} words`,
      affected: [],
      ...(notes.length === 0 ? {} : { notes }),
    }),
  );
}

/* ------------------------------------------------------------------ *
 * binder.read_tree
 * ------------------------------------------------------------------ */

export const readTreeParams: ObjectSpec = param.object(
  'Which part of the binder to read.',
  {
    root: param.string('A node id to start from: root (the default), manuscript, research, or any id.', { nonBlank: true }),
    depth: param.integer('Levels below the start node to include: 1 to 3.', { minimum: 1, maximum: 3, default: 2 }),
    include: param.choice(
      'Per node: word counts (default), the synopsis, or nothing extra.',
      ['counts', 'synopsis', 'none'],
      { default: 'counts' },
    ),
  },
  [],
);

interface TreeRow {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly parentId: string | null;
  readonly order: number;
  readonly depth: number;
  readonly status: string | null;
  readonly label: string | null;
  readonly synopsis?: string;
  readonly words?: number;
}

function wordsUnder(state: ProjectState, node: TreeNode): number {
  if (node.type === 'document') return wordsOfDocument(state, node.id);
  return descendantsOf(state, node.id)
    .filter((child) => child.type === 'document')
    .reduce((sum, child) => sum + wordsOfDocument(state, child.id), 0);
}

export function prepareReadTree(params: CallParams, context: PrepareContext): Result<PreparedCall, CommandError> {
  const { state } = context;
  const rootRef = typeof params['root'] === 'string' ? params['root'] : 'root';
  const start = resolveId(state, rootRef, 'params.root');
  if (!start.ok) {
    return fail(notFound(`no node with id "${rootRef}"`, 'use project.overview to list the top-level ids, then pass one of them as root', 'params.root'));
  }
  const depth = typeof params['depth'] === 'number' ? params['depth'] : 2;
  const include = typeof params['include'] === 'string' ? params['include'] : 'counts';

  const rows: TreeRow[] = [];
  const visit = (node: TreeNode, level: number): void => {
    rows.push({
      id: node.id,
      title: node.title,
      type: node.type,
      parentId: node.parentId,
      order: node.order,
      depth: level,
      status: node.status,
      label: node.label,
      ...(include === 'synopsis' ? { synopsis: node.synopsis } : {}),
      ...(include === 'counts' ? { words: wordsUnder(state, node) } : {}),
    });
    if (level < depth) for (const child of childrenOf(state, node.id)) visit(child, level + 1);
  };
  visit(start.value, 0);

  // Truncation is by size, in binder order, and it is said aloud: a cut response
  // that looked complete would be a silent failure of the read.
  const budget = charBudget(readTreeCap()) - WRAPPER_RESERVE_CHARS;
  let used = 0;
  const shown: TreeRow[] = [];
  for (const row of rows) {
    const size = JSON.stringify(row).length + 1;
    if (used + size > budget) break;
    used += size;
    shown.push(row);
  }
  const truncated = shown.length < rows.length;
  const data = {
    root: { id: start.value.id, title: start.value.title },
    depth,
    include,
    nodes: shown,
    total: rows.length,
    truncated,
    ...(truncated
      ? {
          note: `Truncated at about ${readTreeCap()} tokens: showed ${shown.length} of ${rows.length} nodes. Narrow root to a chapter's id, or lower depth.`,
        }
      : {}),
  };
  return ok(
    readOnly({
      data,
      summary: `${shown.length} of ${rows.length} nodes under "${start.value.title}"`,
      affected: [],
    }),
  );
}

function readTreeCap(): number {
  return capOf('binder.read_tree');
}

/* ------------------------------------------------------------------ *
 * doc.read
 * ------------------------------------------------------------------ */

/** agent-harness §3 row 3: 25k tokens. A larger document is returned concise, with a note. */
const DOC_READ_CAP = capOf('doc.read');
const LEAD_CODE_POINTS = 280;

export const docReadParams: ObjectSpec = param.object(
  'Which document to read, and how much of it.',
  {
    doc: param.string('The document: a title, or an id. An ambiguous title lists its candidates.', { nonBlank: true }),
    range: param.object(
      'A character range in the body projection, from and to, 0-indexed. Omit for the whole body.',
      {
        from: param.integer('Start offset, at least 0.', { minimum: 0 }),
        to: param.integer('End offset, at least from.', { minimum: 0 }),
      },
      ['from', 'to'],
    ),
    response_format: param.choice(
      "'detailed' returns the text. 'concise' returns structure and a lead.",
      ['concise', 'detailed'],
      { default: 'detailed' },
    ),
  },
  ['doc'],
);

export function refineDocRead(params: CallParams): CommandError | undefined {
  const range = params['range'];
  if (range === undefined || typeof range !== 'object' || range === null) return undefined;
  const { from, to } = range as { from: number; to: number };
  if (from > to) {
    return invalidParams(
      `params.range.from (${from}) is past params.range.to (${to})`,
      'ranges run forward: from must be at most to',
      'params.range',
    );
  }
  return undefined;
}

function headingsOf(body: string): { level: number; text: string }[] {
  const out: { level: number; text: string }[] = [];
  for (const line of body.split('\n')) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (match !== null && match[1] !== undefined) out.push({ level: match[1].length, text: (match[2] ?? '').trim() });
    if (out.length === 20) break;
  }
  return out;
}

function countParagraphs(body: string): number {
  return body.split(/\n\s*\n/).filter((block) => block.trim().length > 0).length;
}

function countScenes(body: string): number {
  if (body.trim().length === 0) return 0;
  const separators = body.split('\n').filter((line) => /^\s*\*\*\*\s*$/.test(line)).length;
  return separators + 1;
}

export function prepareDocRead(params: CallParams, context: PrepareContext): Result<PreparedCall, CommandError> {
  const { state } = context;
  const ref = typeof params['doc'] === 'string' ? params['doc'] : '';
  const node = resolveNode(state, ref, DOCUMENT, 'document', 'params.doc');
  if (!node.ok) return fail(node.error);

  const body = bodyOf(state, node.value.id);
  const notes: string[] = [];
  let text = body;
  let range: { from: number; to: number; length: number } | undefined;
  const requested = params['range'] as { from: number; to: number } | undefined;
  if (requested !== undefined) {
    const from = Math.min(requested.from, body.length);
    const to = Math.min(requested.to, body.length);
    text = body.slice(from, to);
    range = { from, to, length: body.length };
    if (requested.from > body.length) {
      notes.push(`The range starts past the end of the body (${body.length} characters), so the result is empty.`);
    } else if (requested.to > body.length) {
      notes.push(`The range was clamped to the end of the body (${body.length} characters).`);
    }
  }

  const asked = typeof params['response_format'] === 'string' ? params['response_format'] : 'detailed';
  const base = { doc: { id: node.value.id, title: node.value.title }, ...(range === undefined ? {} : { range }) };
  const words = wordsOfDocument(state, node.value.id);
  const detailed = { ...base, format: 'detailed', text, words, characters: body.length };
  const concise = {
    ...base,
    format: 'concise',
    structure: {
      words,
      characters: body.length,
      paragraphs: countParagraphs(body),
      scenes: countScenes(body),
      headings: headingsOf(body),
    },
    synopsis: node.value.synopsis,
    lead: firstCodePoints(body.trimStart(), LEAD_CODE_POINTS),
  };
  // The cap is measured on the whole response, as the runtime measures it, so the
  // choice here and the guard there cannot disagree about the same answer.
  const wantsDetailed = asked !== 'concise';
  const fits = fitsCap(detailed, DOC_READ_CAP);
  if (wantsDetailed && !fits) {
    notes.push(
      `This document is about ${estimateTokens(text)} tokens, over the ${DOC_READ_CAP}-token cap, so it is returned concise. Read it in ranges to get the text in pieces.`,
    );
  }
  const data = wantsDetailed && fits ? detailed : concise;
  const format = data.format;
  return ok(
    readOnly({
      data,
      summary: `read "${node.value.title}" (${format}${range === undefined ? '' : `, ${range.from}–${range.to}`})`,
      affected: [],
      ...(notes.length === 0 ? {} : { notes }),
    }),
  );
}

/* ------------------------------------------------------------------ *
 * notes.read
 * ------------------------------------------------------------------ */

const NOTE_FIELDS = ['synopsis', 'notes', 'keywords'] as const;
const NOTES_READ_CAP = capOf('notes.read');

export const notesReadParams: ObjectSpec = param.object(
  'Which document, and which inspector fields.',
  {
    doc: param.string('The document: a title, or an id. An ambiguous title lists its candidates.', { nonBlank: true }),
    fields: param.either('The fields to read: a list of synopsis, notes and keywords, or "all" (the default).', [
      param.list('A list of the fields to read, in the order given.', param.choice('One field.', [...NOTE_FIELDS]), {
        minItems: 1,
        unique: true,
      }),
      param.choice('Every field.', ['all'], { default: 'all' }),
    ]),
  },
  ['doc'],
);

export function prepareNotesRead(params: CallParams, context: PrepareContext): Result<PreparedCall, CommandError> {
  const { state } = context;
  const ref = typeof params['doc'] === 'string' ? params['doc'] : '';
  const node = resolveNode(state, ref, DOCUMENT, 'document', 'params.doc');
  if (!node.ok) return fail(node.error);

  const requested = params['fields'];
  // Listed in the order the caller gave, so the response reads as the request did.
  // "all" is the spec's own listing order.
  const fields: readonly string[] =
    requested === undefined || requested === 'all' ? [...NOTE_FIELDS] : (requested as readonly string[]);
  const notes: string[] = [];
  const data: Record<string, unknown> = { doc: { id: node.value.id, title: node.value.title } };
  for (const field of fields) {
    if (field === 'synopsis') data['synopsis'] = node.value.synopsis;
    if (field === 'keywords') data['keywords'] = [...node.value.keywords];
    if (field === 'notes') {
      // The notes field may hold up to 50k characters, which can exceed the cap by
      // itself. It is shortened until the whole response fits, and the cut is named.
      let text = node.value.notes;
      let cut = false;
      while (text.length > 0 && !fitsCap({ ...data, notes: text }, NOTES_READ_CAP)) {
        text = text.slice(0, Math.floor(text.length * 0.8));
        cut = true;
      }
      if (cut) {
        notes.push(`The notes are longer than the ${NOTES_READ_CAP}-token cap, so they are cut. Read the rest in a later call.`);
      }
      data['notes'] = text;
    }
  }
  return ok(
    readOnly({
      data,
      summary: `read the ${fields.join(', ')} of "${node.value.title}"`,
      affected: [],
      ...(notes.length === 0 ? {} : { notes }),
    }),
  );
}
