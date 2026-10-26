/**
 * The allowlist of bus primitives exposed as tools (agent-harness.md §3, "Primitives as deferred tools"): the first wave the owner
 * approved on issue #56. Each is a deferred extension row, so it costs the planner nothing until `tool.search` loads it. The limits
 * and value lists are the bus's own, read here so a tool never keeps a copy that could drift.
 */

import {
  FILTER_LIST_MAX,
  FILTER_NAME_MAX,
  FILTER_TAG_MAX,
  FILTER_TEXT_MAX,
  GOAL_COMPARATORS,
  GOAL_KINDS,
  GOAL_METRICS,
  INSTRUCTIONS_MAX_CHARS,
  MEMORY_BODY_MAX_CHARS,
  MEMORY_TITLE_MAX_CHARS,
  MEMORY_TYPES,
  MONTHLY_RESET_MAX,
  NOTES_MAX,
  SEARCH_SURFACES,
  SYNOPSIS_MAX,
  VOCABULARY_NAME_MAX,
  ok,
  slugOf,
  textDigest,
  type CommandError,
  type Result,
} from '@caotang/bus';
import { nodeById, type AgentFiles } from '@caotang/store';

import { failure, invalidParams } from '../errors.js';
import { resolveNode, DOCUMENT, TARGET, type NodeFilter } from '../resolve.js';
import { param } from '../schema.js';
import type { CallParams, PrepareContext } from '../types.js';
import { primitiveTool, type PrimitiveTool } from './primitive.js';

const KEYWORD_LIST_MAX = FILTER_LIST_MAX;

type Mapped = Result<Readonly<Record<string, unknown>>, CommandError>;

/** The keys of `params` named in `keys`, in that order, left out when absent. */
function pick(params: CallParams, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (params[key] !== undefined) out[key] = params[key];
  return out;
}

function text(params: CallParams, key: string): string {
  const value = params[key];
  return typeof value === 'string' ? value : '';
}

function titleIn(context: PrepareContext, id: unknown): string {
  return nodeById(context.state, String(id))?.title ?? String(id);
}

/** `notes.set`, as the model reaches it: replace the whole notes field, behind a confirm card with the old and the new text. */
const notesReplace = primitiveTool({
  tool: 'notes.replace',
  command: 'notes.set',
  description: `Replace the whole inspector notes of one document, at most ${NOTES_MAX} characters. The card shows the old and the new notes as a word-by-word difference. Use notes.append to add to the notes without rewriting them. Undo restores the prior notes exactly.`,
  descriptionVersion: 1,
  keywords: ['notes', 'rewrite', 'replace', 'inspector'],
  response_token_cap: 500,
  params: param.object(
    'The document, and the notes that replace its current notes.',
    {
      doc: param.string('The document: a title, or an id. An ambiguous title lists its candidates.', { nonBlank: true }),
      notes: param.string(`The new notes, in full, at most ${NOTES_MAX} characters. An empty string clears the notes.`, { maxLength: NOTES_MAX }),
    },
    ['doc', 'notes'],
  ),
  toCommand: (params, context): Mapped => {
    const node = resolveNode(context.state, text(params, 'doc'), DOCUMENT, 'document', 'params.doc');
    return node.ok ? ok({ nodeId: node.value.id, notes: text(params, 'notes') }) : node;
  },
  preview: (command, context) => ({
    doc: titleIn(context, command['nodeId']),
    before: nodeById(context.state, String(command['nodeId']))?.notes ?? '',
    after: text(command, 'notes'),
  }),
  report: (command, _outcome, context) => ({
    data: { doc: { id: command['nodeId'], title: titleIn(context, command['nodeId']) }, characters: text(command, 'notes').length },
    summary: `replaced the notes of "${titleIn(context, command['nodeId'])}" (${text(command, 'notes').length} characters)`,
  }),
});

const synopsisSet = primitiveTool({
  tool: 'synopsis.set',
  command: 'binder.setSynopsis',
  description: `Set the synopsis of one document or folder to the text given, at most ${SYNOPSIS_MAX} characters, replacing any synopsis it has. To draft synopses from the text of documents, use synopsis.fill instead. Undo restores the prior synopsis.`,
  descriptionVersion: 1,
  keywords: ['synopsis', 'summary', 'blurb', 'binder'],
  response_token_cap: 500,
  params: param.object(
    'The document or folder, and its new synopsis.',
    {
      doc: param.string('The document or folder: a title, or an id. An ambiguous title lists its candidates.', { nonBlank: true }),
      synopsis: param.string(`The synopsis, at most ${SYNOPSIS_MAX} characters. An empty string clears it.`, { maxLength: SYNOPSIS_MAX }),
    },
    ['doc', 'synopsis'],
  ),
  toCommand: (params, context): Mapped => {
    const node = resolveNode(context.state, text(params, 'doc'), TARGET, 'document or folder', 'params.doc');
    return node.ok ? ok({ nodeId: node.value.id, synopsis: text(params, 'synopsis') }) : node;
  },
  report: (command, _outcome, context) => ({
    data: { doc: { id: command['nodeId'], title: titleIn(context, command['nodeId']) }, characters: text(command, 'synopsis').length },
    summary: `set the synopsis of "${titleIn(context, command['nodeId'])}" (${text(command, 'synopsis').length} characters)`,
  }),
});

const vocabularyUpsert = primitiveTool({
  tool: 'vocabulary.upsert',
  command: 'vocabulary.upsert',
  description:
    'Add a status or a label to the project vocabulary, or rename or recolour one by its id. A new term gets an id from its name, lowercased with each run of other characters turned into a hyphen ("In Review" becomes in-review), and a repeat of an id gets -2, -3; the result returns it, and meta.set uses it. A step that adds a term may be followed by a meta.set step that uses it in the same plan. Undo removes the new term or restores the old name and colour.',
  descriptionVersion: 1,
  keywords: ['status', 'label', 'vocabulary', 'colour', 'color', 'term'],
  response_token_cap: 500,
  params: param.object(
    'The vocabulary term to add or change.',
    {
      kind: param.choice('Which vocabulary: status or label.', ['status', 'label']),
      id: param.string('The id of an existing term to rename or recolour. Leave it out to add a new term.', { nonBlank: true }),
      name: param.string('The term’s name, which must differ from every other term of that kind.', { nonBlank: true, maxLength: VOCABULARY_NAME_MAX }),
      color: param.string('A hex colour such as #3fa66a.', { nonBlank: true }),
    },
    ['kind', 'name', 'color'],
  ),
  toCommand: (params): Mapped => ok(pick(params, ['kind', 'id', 'name', 'color'])),
  report: (command, outcome) => {
    const id = (outcome.result as { readonly id?: unknown } | undefined)?.id;
    const added = command['id'] === undefined;
    return {
      data: { kind: command['kind'], id: typeof id === 'string' ? id : null, name: command['name'], color: command['color'], added },
      summary: `${added ? 'added' : 'changed'} the ${String(command['kind'])} "${String(command['name'])}"`,
    };
  },
});

const filterSave = primitiveTool({
  tool: 'filter.save',
  command: 'binder.saveFilter',
  description:
    'Save a named filter over the binder, a conjunction of the criteria given (an empty criteria object matches everything), or change a saved one by its id from project.overview. Status and label criteria name ids from the project vocabulary. The filter appears in the binder’s saved filters. Undo removes a new filter or restores the old one.',
  descriptionVersion: 1,
  keywords: ['filter', 'saved search', 'query', 'binder', 'criteria'],
  response_token_cap: 500,
  params: param.object(
    'The filter to save.',
    {
      id: param.string('The id of a saved filter to change (q_ and ten characters). Leave it out to save a new filter.', { nonBlank: true }),
      name: param.string(`The filter’s name, at most ${FILTER_NAME_MAX} characters.`, { nonBlank: true }),
      root: param.choice('Search only this root. Leave it out to search both.', ['manuscript', 'research']),
      criteria: param.object(
        'What a node must match, every criterion given at once.',
        {
          text: param.string(`Words to find, case-insensitive, at most ${FILTER_TEXT_MAX} characters.`, { nonBlank: true, maxLength: FILTER_TEXT_MAX }),
          textIn: param.list('Where text is searched. Leave it out for all three.', param.choice('A surface.', SEARCH_SURFACES), {
            minItems: 1,
            maxItems: SEARCH_SURFACES.length,
            unique: true,
          }),
          statusId: param.string('A status id from the project vocabulary.', { nonBlank: true }),
          labelId: param.string('A label id from the project vocabulary.', { nonBlank: true }),
          keywordsAll: param.list('Keywords the node must all carry.', param.string('One keyword.', { nonBlank: true, maxLength: FILTER_TAG_MAX }), {
            maxItems: KEYWORD_LIST_MAX,
          }),
          keywordsAny: param.list('Keywords the node must carry at least one of.', param.string('One keyword.', { nonBlank: true, maxLength: FILTER_TAG_MAX }), {
            maxItems: KEYWORD_LIST_MAX,
          }),
          minWords: param.integer('At least this many words (a folder counts its subtree).', { minimum: 0 }),
          maxWords: param.integer('At most this many words (a folder counts its subtree).', { minimum: 0 }),
          createdWithinDays: param.integer('Created in the last this many days.', { minimum: 1 }),
          modifiedWithinDays: param.integer('Changed in the last this many days.', { minimum: 1 }),
        },
        [],
      ),
    },
    ['name', 'criteria'],
  ),
  toCommand: (params): Mapped => ok({ filter: pick(params, ['id', 'name', 'root', 'criteria']) }),
  report: (command, outcome) => {
    const filterId = (outcome.result as { readonly filterId?: unknown } | undefined)?.filterId;
    const filter = command['filter'] as { readonly name?: unknown };
    return {
      data: { id: typeof filterId === 'string' ? filterId : null, name: filter.name },
      summary: `saved the filter "${String(filter.name)}"`,
    };
  },
});

/** A goal attaches to the manuscript root or a folder (goals-progress §2.2). */
const GOAL_TARGET: NodeFilter = (node) => node.type === 'folder' || node.id === 'manuscript';

const goalSave = primitiveTool({
  tool: 'goal.save',
  command: 'project.saveGoal',
  description:
    'Set a word goal on the manuscript or a folder, or change one by its id from project.overview. A project goal counts the words under its node, with a comparator (at-least, at-most or about) and a target. A weekly or monthly goal counts the words written in the week or month, so it sits on the manuscript, is at-least and takes no deadline. Undo removes a new goal or restores the old one.',
  descriptionVersion: 1,
  keywords: ['goal', 'target', 'word count', 'deadline', 'progress', 'weekly', 'monthly'],
  response_token_cap: 500,
  params: param.object(
    'The goal to set.',
    {
      id: param.string('The id of a goal to change (g_ and ten characters). Leave it out to set a new goal.', { nonBlank: true }),
      node: param.string('The manuscript, or a folder: a title, or an id.', { nonBlank: true }),
      metric: param.choice('What is counted. Defaults to words.', GOAL_METRICS),
      kind: param.choice('project (the default), or a weekly or monthly writing pace.', GOAL_KINDS),
      resetDay: param.either('Weekly: the weekday the week starts on, 0 (Sunday) to 6. Monthly: a day 1 to 28, or "last". A project goal takes none.', [
        param.integer('A weekday 0 to 6, or a day of the month 1 to 28.', { minimum: 0, maximum: MONTHLY_RESET_MAX }),
        param.choice('The month’s last day.', ['last']),
      ]),
      comparator: param.choice('at-least for a drafting goal, at-most for a length cap, about for within 10 percent.', GOAL_COMPARATORS),
      target: param.integer('The target, above zero.', { minimum: 1 }),
      deadline: param.string('A date such as 2026-10-31. Leave it out for an open-ended goal.', { nonBlank: true }),
      archived: param.boolean('True to hide a completed or abandoned goal from the rail.'),
    },
    ['node', 'comparator', 'target'],
  ),
  toCommand: (params, context): Mapped => {
    const node = resolveNode(context.state, text(params, 'node'), GOAL_TARGET, 'folder or the manuscript', 'params.node');
    if (!node.ok) return node;
    return ok({ goal: { ...pick(params, ['id']), nodeId: node.value.id, ...pick(params, ['metric', 'kind', 'resetDay', 'comparator', 'target', 'deadline', 'archived']) } });
  },
  report: (command, outcome, context) => {
    const goalId = (outcome.result as { readonly goalId?: unknown } | undefined)?.goalId;
    const goal = command['goal'] as { readonly nodeId?: unknown; readonly target?: unknown };
    return {
      data: { id: typeof goalId === 'string' ? goalId : null, node: goal.nodeId, target: goal.target },
      summary: `saved a goal of ${String(goal.target)} for "${titleIn(context, goal.nodeId)}"`,
    };
  },
});

/** The slug of a topic file path: `memory/<slug>.md`. */
const slugOfPath = (path: string): string => path.slice('memory/'.length, -'.md'.length);

/** The slug a note is written under: the one the caller named, the one a note of that title has, or one made from the title that no other note holds. */
function slugFor(files: AgentFiles, params: CallParams): Result<string, CommandError> {
  const named = params['slug'];
  if (typeof named === 'string') return ok(named);
  const title = text(params, 'title').trim();
  const same = files.memory.find((note) => note.title.trim().toLowerCase() === title.toLowerCase());
  if (same !== undefined) return ok(same.slug);
  const base = slugOf(title);
  if (base === '') {
    return failure(invalidParams('the title has no letter or digit to make a slug from', 'give the note a title in words, or pass a slug', 'params.title')) as Result<string, CommandError>;
  }
  const taken = new Set([...files.memory.map((note) => note.slug), ...[...files.declined.keys()].map(slugOfPath), ...files.unreadable.filter((path) => path.startsWith('memory/')).map(slugOfPath)]);
  let slug = base;
  for (let n = 2; taken.has(slug); n += 1) slug = `${base.slice(0, 60)}-${n}`;
  return ok(slug);
}

const memoryWrite = primitiveTool({
  tool: 'memory.write',
  command: 'memory.write',
  description: `Save one memory note in the project: a habit, a preference or a process the writer wants kept for later requests, such as "no semicolons in dialogue" or "end scenes on a line of dialogue". The note's title and first line join the memory index, which every request carries, so keep both short; the body is at most ${MEMORY_BODY_MAX_CHARS} characters. A story fact, such as a character's handedness, belongs in the codex (codex.write): a title that is a codex entry's name or alias is refused. Writing a title that a note already has updates that note; pass the digest memory.read gave as expectedDigest so a change made since is not overwritten. The card shows the old and the new body as a word-by-word difference. Undo restores the note, or removes it if it was new.`,
  descriptionVersion: 1,
  keywords: ['memory', 'remember', 'preference', 'style', 'habit', 'note', 'instructions'],
  response_token_cap: 500,
  params: param.object(
    'The memory note to save.',
    {
      title: param.string(`A few words naming the habit, at most ${MEMORY_TITLE_MAX_CHARS} characters, on one line.`, { nonBlank: true, maxLength: MEMORY_TITLE_MAX_CHARS }),
      type: param.choice('style (how the prose reads), preference (what the writer likes or avoids), process (how the writer works) or reference (where to look).', MEMORY_TYPES),
      body: param.string(`The note, at most ${MEMORY_BODY_MAX_CHARS} characters. Lead with the rule in one line.`, { nonBlank: true, maxLength: MEMORY_BODY_MAX_CHARS }),
      slug: param.string('The note’s slug, to update one by name. Leave it out to make one from the title.', { nonBlank: true, maxLength: 64 }),
      expectedDigest: param.string('The digest memory.read gave for the note you are changing. Leave it out for a new note.', { nonBlank: true, maxLength: 64 }),
    },
    ['title', 'type', 'body'],
  ),
  toCommand: (params, context): Mapped => {
    const slug = slugFor(context.state.agentFiles, params);
    if (!slug.ok) return slug;
    return ok({ slug: slug.value, type: text(params, 'type'), title: text(params, 'title'), body: text(params, 'body'), ...pick(params, ['expectedDigest']) });
  },
  preview: (command, context) => {
    const held = context.state.agentFiles.memory.find((note) => note.slug === command['slug']);
    return { doc: `Memory note: ${text(command, 'title')}`, before: held?.body ?? '', after: text(command, 'body') };
  },
  report: (command, outcome) => {
    const created = (outcome.result as { readonly created?: unknown } | undefined)?.created === true;
    return {
      data: { slug: command['slug'], created, digest: textDigest(text(command, 'body')) },
      summary: `${created ? 'saved' : 'updated'} the memory note "${text(command, 'title')}"`,
    };
  },
});

const instructionsPropose = primitiveTool({
  tool: 'instructions.propose',
  command: 'project.setInstructions',
  description: `Propose a new CAOTANG.md, the writer's standing instructions that every request carries, such as "British spelling. Past tense, close third person on Mara." Send the whole file, at most ${INSTRUCTIONS_MAX_CHARS} characters; only about 1,500 tokens of it are sent to the model, so keep it short. The writer approves the card, which shows the old and the new text as a word-by-word difference; nothing changes before that. Pass the digest memory.read gave for CAOTANG.md as expectedDigest. Use memory.write for one habit you learned, and keep this for the rules the writer asks to be written down. Undo restores the file as it was.`,
  descriptionVersion: 1,
  keywords: ['instructions', 'CAOTANG.md', 'rules', 'style guide', 'standing', 'house style'],
  response_token_cap: 500,
  params: param.object(
    'The proposed CAOTANG.md.',
    {
      text: param.string(`The whole new CAOTANG.md, at most ${INSTRUCTIONS_MAX_CHARS} characters.`, { maxLength: INSTRUCTIONS_MAX_CHARS }),
      expectedDigest: param.string('The digest memory.read gave for CAOTANG.md. Leave it out when the project has none.', { nonBlank: true, maxLength: 64 }),
    },
    ['text'],
  ),
  toCommand: (params): Mapped => ok({ text: text(params, 'text'), ...pick(params, ['expectedDigest']) }),
  preview: (command, context) => ({ doc: 'CAOTANG.md', before: context.state.agentFiles.instructions?.text ?? '', after: text(command, 'text') }),
  report: (command) => ({
    data: { file: 'CAOTANG.md', characters: text(command, 'text').length, digest: textDigest(text(command, 'text')) },
    summary: `changed CAOTANG.md (${text(command, 'text').length} characters)`,
  }),
});

/** Every primitive exposed as a tool, in registry order. A name is added here by an owner decision (docs/decisions.md). */
export const PRIMITIVE_TOOLS: readonly PrimitiveTool[] = [notesReplace, synopsisSet, vocabularyUpsert, filterSave, goalSave, memoryWrite, instructionsPropose];

