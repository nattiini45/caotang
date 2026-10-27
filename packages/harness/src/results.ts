/**
 * What a tool answers — [agent-harness.md §3](../../../docs/architecture/agent-harness.md), "Result schemas".
 *
 * Every callable row declares the shape of `ToolValue.data` in the same `ParamSpec` vocabulary its params use, and the registry
 * derives `resultSchema` from it exactly as it derives `schema` from `params`. Two readers use it: an outside host (the MCP
 * server advertises it as `outputSchema`) and the tests (`testing.ts` checks every successful value against its row, so a field
 * that is renamed or dropped fails with the JSON path). The model never reads a result schema: it still receives
 * `{ tool, ok, data }`, and a schema in the prompt would spend the context that tool deferral saves.
 *
 * `ToolResults` is the same declaration as a TypeScript type, for code that reads a result by key. It is written by hand beside
 * the spec, and `SpecAgrees` (checked in `test/result-types.test.ts`) fails the build when the two disagree on which keys a result
 * has and which of them are required.
 *
 * **Open or closed.** A closed row refuses a key its spec does not list. The thirteen callable v0.1 rows and `tool.search` are
 * closed. The rest are open (`resultClosed: false`): they list what they return, and a key not yet listed is allowed, so a
 * declaration can never break a tool. `RESULT_CLOSED` is the checklist; the target is every row closed.
 */

import { COHERENCE_REVIEW_RESULT, COHERENCE_SCAN_RESULT, COHERENCE_SET_STATUS_RESULT } from '@caotang/coherence';
import { DIALOGUE_DRAFT_RESULT, DIALOGUE_TABLE_RESULT } from '@caotang/dialogue';
import { TOOL_SEARCH_RESULT } from '@caotang/mcp-client';

import type { ToolData, ToolValue } from '@caotang/bus';

import type { ToolName } from './metadata.js';
import { param, type ObjectSpec } from './schema.js';

/* ------------------------------------------------------------------ *
 * Shared pieces
 * ------------------------------------------------------------------ */

const ref = (what: string) =>
  param.object(`The ${what}.`, { id: param.string(`The ${what}'s id.`), title: param.string(`The ${what}'s title.`) }, ['id', 'title']);

const strings = (what: string) => param.list(what, param.string('One entry.'));

/** One node a change touched, as `ToolValue.affected` names it. Not part of `data`. */
type Ref = { readonly id: string; readonly title: string };

/* ------------------------------------------------------------------ *
 * The thirteen callable v0.1 rows
 * ------------------------------------------------------------------ */

export const projectOverviewResult = param.object(
  'The open project at a glance.',
  {
    title: param.string('The project name.'),
    empty: param.boolean('True when the project has no documents.'),
    tree: param.list(
      'Every part of the binder, with what each holds.',
      param.object(
        'One part.',
        {
          id: param.string('The node id.'),
          title: param.string('The title.'),
          type: param.string('folder, document or another node type.'),
          status: param.nullable(param.string('The status id, when one is set.')),
          children: param.list(
            'What the part holds, as many as the response cap allowed.',
            param.object(
              'One child.',
              {
                id: param.string('The node id.'),
                title: param.string('The title.'),
                type: param.string('The node type.'),
                status: param.nullable(param.string('The status id, when one is set.')),
              },
              ['id', 'title', 'type', 'status'],
            ),
          ),
          childrenTotal: param.integer('How many children the part holds, when the list is shorter.'),
        },
        ['id', 'title', 'type', 'status', 'children'],
      ),
    ),
    vocabulary: param.object(
      'The statuses and labels the project defines.',
      {
        statuses: param.list('The statuses.', param.object('One term.', { id: param.string('Its id.'), name: param.string('Its name.') }, ['id', 'name'])),
        labels: param.list('The labels.', param.object('One term.', { id: param.string('Its id.'), name: param.string('Its name.') }, ['id', 'name'])),
      },
      ['statuses', 'labels'],
    ),
    totalWords: param.integer('Words in the documents the agent may read.'),
    session: param.nullable(
      param.object(
        'Today\'s writing against the session target.',
        { todayWords: param.integer('Words written today.'), target: param.nullable(param.integer('The session target, when one is set.')) },
        ['todayWords', 'target'],
      ),
    ),
    savedFilters: param.integer('How many binder filters are saved.'),
    filters: param.list('The saved filters.', param.object('One filter.', { id: param.string('Its id.'), name: param.string('Its name.') }, ['id', 'name'])),
    goals: param.list(
      'The writing goals.',
      param.object('One goal.', { id: param.string('Its id.'), name: param.string('Its target\'s title.'), target: param.number('Its target.') }, ['id', 'name', 'target']),
    ),
    withheld: param.integer('How many nodes a rule keeps from the agent, when any.'),
  },
  ['title', 'empty', 'tree', 'vocabulary', 'totalWords', 'session', 'savedFilters', 'filters', 'goals'],
);

export const readTreeResult = param.object(
  'The nodes under the start node, in binder order.',
  {
    root: ref('start node'),
    depth: param.integer('The levels read below the start node.'),
    include: param.choice('What each node carries beyond its place.', ['counts', 'synopsis', 'none']),
    nodes: param.list(
      'The nodes, as many as the response cap allowed.',
      param.object(
        'One node.',
        {
          id: param.string('The node id.'),
          title: param.string('The title.'),
          type: param.string('The node type.'),
          parentId: param.nullable(param.string('The parent\'s id.')),
          order: param.number('The position among its siblings.'),
          depth: param.integer('Levels below the start node.'),
          status: param.nullable(param.string('The status id.')),
          label: param.nullable(param.string('The label id.')),
          synopsis: param.string('The synopsis, when include is synopsis.'),
          words: param.integer('The word count, when include is counts.'),
        },
        ['id', 'title', 'type', 'parentId', 'order', 'depth', 'status', 'label'],
      ),
    ),
    total: param.integer('How many nodes the read found.'),
    truncated: param.boolean('True when the list stops short of total.'),
    withheld: param.integer('How many nodes a rule keeps from the agent, when any.'),
    note: param.string('Why and where the list was cut.'),
  },
  ['root', 'depth', 'include', 'nodes', 'total', 'truncated'],
);

export const docReadResult = param.object(
  'The document, as text (detailed) or as structure and a lead (concise).',
  {
    doc: ref('document'),
    range: param.object(
      'The range read, when one was asked for.',
      { from: param.integer('Start offset.'), to: param.integer('End offset.'), length: param.integer('The body length.') },
      ['from', 'to', 'length'],
    ),
    format: param.choice('The form the answer is in.', ['detailed', 'concise']),
    text: param.string('The text, when detailed.'),
    words: param.integer('The word count, when detailed.'),
    characters: param.integer('The character count, when detailed.'),
    structure: param.object(
      'The document\'s shape, when concise.',
      {
        words: param.integer('Words.'),
        characters: param.integer('Characters.'),
        paragraphs: param.integer('Paragraphs.'),
        scenes: param.integer('Scenes.'),
        headings: param.list('The first headings.', param.object('One heading.', { level: param.integer('1 to 6.'), text: param.string('Its text.') }, ['level', 'text'])),
      },
      ['words', 'characters', 'paragraphs', 'scenes', 'headings'],
    ),
    synopsis: param.string('The synopsis, when concise.'),
    lead: param.string('The first words, when concise.'),
  },
  ['doc', 'format'],
);

export const notesReadResult = param.object(
  'The inspector fields asked for.',
  {
    doc: ref('document'),
    synopsis: param.string('The synopsis.'),
    keywords: strings('The keywords.'),
    notes: param.string('The notes, cut to the response cap when long.'),
  },
  ['doc'],
);

export const metaSetResult = param.object(
  'The nodes changed, and the patch applied to each.',
  {
    changed: param.list('The nodes changed.', param.object('One node.', { id: param.string('Its id.'), title: param.string('Its title.') }, ['id', 'title'])),
    patch: param.object(
      'The fields that were set.',
      {
        status: param.string('The status id.'),
        label: param.string('The label id.'),
        keywords_add: strings('Keywords added.'),
        keywords_remove: strings('Keywords removed.'),
      },
      [],
    ),
  },
  ['changed', 'patch'],
);

export const notesAppendResult = param.object(
  'The document, and how much was appended to its notes.',
  { doc: ref('document'), appended: param.integer('Characters appended.') },
  ['doc', 'appended'],
);

export const synopsisFillResult = param.object(
  'The synopses written.',
  {
    rows: param.list(
      'One row per document.',
      param.object(
        'One document.',
        { doc: ref('document'), action: param.choice('Whether the document had a synopsis.', ['create', 'replace']), words: param.integer('Words in the new synopsis.') },
        ['doc', 'action', 'words'],
      ),
    ),
    count: param.integer('How many synopses were set.'),
  },
  ['rows', 'count'],
);

export const sceneDraftResult = param.object(
  'Where the draft went.',
  {
    doc: ref('document'),
    mode: param.choice('How the draft was placed.', ['draft', 'continue', 'rewrite_selection']),
    words: param.integer('Words in the draft.'),
    range: param.object('The range the draft took.', { from: param.integer('Start offset.'), to: param.integer('End offset.') }, ['from', 'to']),
    revision: param.integer('The document\'s revision after the write.'),
  },
  ['doc', 'mode', 'words', 'range', 'revision'],
);

export const restructureResult = param.object(
  'The batch that ran.',
  { applied: param.integer('How many operations ran.'), operations: strings('One line per operation.') },
  ['applied', 'operations'],
);

export const continuityScanResult = param.object(
  'The findings, checked.',
  {
    scope: strings('The titles of the documents checked.'),
    aspects: strings('The aspects asked for.'),
    findings: param.list(
      'One entry per problem.',
      param.object(
        'One finding.',
        {
          aspect: param.choice('What the problem concerns.', ['timeline', 'characters', 'props', 'custom']),
          severity: param.choice('How much it matters.', ['info', 'minor', 'major']),
          docs: strings('The documents the problem spans.'),
          quote: param.string('The quoted span.'),
          note: param.string('What conflicts.'),
        },
        ['aspect', 'severity', 'docs', 'quote', 'note'],
      ),
    ),
    count: param.integer('How many findings.'),
  },
  ['scope', 'aspects', 'findings', 'count'],
);

export const exportCompileResult = param.object(
  'What was compiled, and what the exporter reported.',
  {
    scope: param.choice('The whole manuscript or a part of it.', ['manuscript', 'part']),
    format: param.string('The export format.'),
    command: param.choice('The command that ran.', ['export.compile', 'export.compileSelection']),
    includeRootIds: strings('The nodes a part export started from.'),
    result: param.nullable(param.freeObject('What the exporter reported for the artifact.')),
    recipe: param.string('The recipe applied, when one was named.'),
  },
  ['scope', 'format', 'command', 'includeRootIds', 'result'],
);

export const codexReadResult = param.object(
  'The codex entries matched.',
  {
    entries: param.list('The entries, as many as the limit allowed.', param.freeObject('One codex entry.')),
    total: param.integer('How many entries matched.'),
    truncated: param.boolean('True when the list stops short of total.'),
    withheld: param.integer('How many entries a rule keeps from the agent, when any.'),
    note: param.string('Why the list was cut.'),
  },
  ['entries', 'total', 'truncated'],
);

export const codexWriteResult = param.object(
  'The entries written.',
  {
    created: strings('The ids of the entries created.'),
    updated: strings('The ids of the entries updated.'),
    attachmentChanges: param.integer('How many attachments changed.'),
    diffs: param.list('One diff per entry, as many as the response cap allowed.', param.freeObject('One entry\'s old and new fields.')),
    diffsOmitted: param.integer('How many diffs the cap left out.'),
  },
  ['created', 'updated', 'attachmentChanges', 'diffs'],
);

/* ------------------------------------------------------------------ *
 * The extension rows
 * ------------------------------------------------------------------ */

export const docImportResult = param.object(
  'The document that was created.',
  {
    doc: ref('document'),
    parent: param.object('The folder it went under.', { title: param.string('Its title.') }, ['title']),
    words: param.integer('Words imported.'),
    characters: param.integer('Characters stored.'),
    scan: param.freeObject('Passages that read like instructions to a model, when any.'),
  },
  ['doc', 'parent', 'words', 'characters'],
);

export const codexImportResult = param.object(
  'The entries created from the document.',
  {
    created: strings('The ids of the entries created.'),
    attached: param.integer('How many entries were attached to the document.'),
    origin: param.choice('Always import.', ['import']),
    diffs: param.list('One card per entry, as many as the response cap allowed.', param.freeObject('One entry as imported.')),
    diffsOmitted: param.integer('How many cards the cap left out.'),
    scan: param.freeObject('Passages that read like instructions to a model, when any.'),
  },
  ['created', 'attached', 'origin', 'diffs'],
);

export const shotsDeriveResult = param.object(
  'The storyboard that was created.',
  {
    folder: param.string('The storyboard folder\'s title.'),
    scene: param.string('The scene\'s title.'),
    shots: param.integer('How many shots were created.'),
  },
  ['folder', 'scene', 'shots'],
);

export const shotsAnnotateResult = param.object(
  'How many shots changed.',
  { changed: param.integer('Shots changed.'), unchanged: param.integer('Shots that already had these values.') },
  ['changed', 'unchanged'],
);

export const promptDraftResult = param.object(
  'The prompts written.',
  { vendor: param.string('The vendor template.'), writes: param.integer('How many shots got a prompt.') },
  ['vendor', 'writes'],
);

export const promptVariantResult = param.object(
  'Three alternatives for one field of one shot. Nothing is written until one is picked.',
  {
    shotId: param.string('The shot.'),
    shotNumber: param.integer('The shot\'s number.'),
    vendor: param.string('The vendor template.'),
    variation: param.string('What varies.'),
    field: param.choice('The field the alternatives replace.', ['prompt.camera', 'prompt.style', 'audio.ambient']),
    current: param.string('The field now.'),
    alternatives: param.list('The alternatives.', param.freeObject('One alternative.')),
    base: param.string('The shot\'s vendor record at staging, as JSON.'),
    model: param.string('The model that wrote them.'),
  },
  ['shotId', 'shotNumber', 'vendor', 'variation', 'field', 'current', 'alternatives', 'base', 'model'],
);

export const skillLoadResult = param.object(
  'The skill, loaded for this turn.',
  {
    skill: param.string('The skill\'s name.'),
    label: param.string('The label the writer sees.'),
    instructions: param.string('The skill\'s instructions.'),
    note: param.string('What the build cannot yet read of the skill.'),
  },
  ['skill', 'label', 'instructions'],
);

export const memoryReadResult = param.object(
  'One memory note, or the list of notes with the instructions file.',
  {
    slug: param.string('The note\'s slug, when one was read.'),
    type: param.string('The note\'s type, when one was read.'),
    title: param.string('The note\'s title, when one was read.'),
    body: param.string('The note\'s text, when one was read.'),
    origin: param.string('Who wrote the note, when one was read.'),
    digest: param.string('The digest of the note, when one was read.'),
    instructions: param.object(
      'CAOTANG.md, when the list was read.',
      { file: param.nullable(param.string('Its path.')), characters: param.integer('Its length.'), digest: param.string('Its digest.') },
      ['file', 'characters', 'digest'],
    ),
    notes: param.list(
      'The notes, when the list was read.',
      param.object(
        'One note.',
        {
          slug: param.string('Its slug.'),
          type: param.string('Its type.'),
          title: param.string('Its title.'),
          origin: param.string('Who wrote it.'),
          characters: param.integer('Its length.'),
          digest: param.string('Its digest.'),
        },
        ['slug', 'type', 'title', 'origin', 'characters', 'digest'],
      ),
    ),
    noteLimit: param.object('The size limit of one note.', { bodyCharacters: param.integer('Characters.') }, ['bodyCharacters']),
    unreadable: strings('The files that could not be read.'),
  },
  [],
);

export const agentDelegateResult = param.object(
  'What the delegated agent found, framed as data.',
  {
    notice: param.string('The fixed notice that the result is data and approves nothing.'),
    agent: param.choice('Which agent ran.', ['reader', 'general']),
    agentPath: param.string('Where the agent sat in the turn.'),
    status: param.choice('How the agent ended.', ['done', 'partial', 'failed']),
    summary: param.string('The agent\'s summary.'),
    proposedSteps: param.list('The steps the agent would take.', param.freeObject('One plan step.')),
    read: strings('The ids of the documents the agent read.'),
    usage: param.object(
      'What the agent used.',
      { modelCalls: param.integer('Model calls.'), promptTokens: param.integer('Prompt tokens.'), completionTokens: param.integer('Completion tokens.') },
      ['modelCalls', 'promptTokens', 'completionTokens'],
    ),
  },
  ['notice', 'agent', 'agentPath', 'status', 'summary', 'proposedSteps', 'read', 'usage'],
);

const briefParts = {
  briefId: param.string('The brief to name when applying.'),
  revision: param.integer('The revision the brief was made against.'),
  expiresAt: param.string('When the brief stops being accepted, as an ISO time.'),
  framing: param.string('What the host is told about the messages.'),
  messages: param.list(
    'The messages for the host\'s model.',
    param.object('One message.', { role: param.string('system or user.'), content: param.string('Its text.') }, ['role', 'content']),
  ),
  reply: param.string('What to do with the reply.'),
  applyWith: param.freeObject('The params to pass to the apply tool, less the reply.'),
  applyTool: param.choice('The tool that applies the reply.', ['scene.apply', 'dialogue.apply']),
  droppedContext: strings('What the context assembly left out.'),
};
const briefRequired = ['briefId', 'revision', 'expiresAt', 'framing', 'messages', 'reply', 'applyWith', 'applyTool', 'droppedContext'] as const;

export const sceneBriefResult = param.object(
  'The messages scene.draft would send, and how to apply the reply.',
  { doc: ref('document'), mode: param.choice('How the draft will be placed.', ['draft', 'continue', 'rewrite_selection']), ...briefParts },
  ['doc', 'mode', ...briefRequired],
);

export const dialogueBriefResult = param.object(
  'The messages dialogue.draft would send, and how to apply the reply.',
  { container: ref('container'), ...briefParts },
  ['container', ...briefRequired],
);

/* The seven allowlisted primitives (tools/primitive-tools.ts). */

export const notesReplaceResult = param.object(
  'The document, and how long its notes now are.',
  { doc: ref('document'), characters: param.integer('Characters in the new notes.') },
  ['doc', 'characters'],
);

export const synopsisSetResult = param.object(
  'The document, and how long its synopsis now is.',
  { doc: ref('node'), characters: param.integer('Characters in the new synopsis.') },
  ['doc', 'characters'],
);

export const vocabularyUpsertResult = param.object(
  'The term that was added or changed.',
  {
    kind: param.choice('Whether the term is a status or a label.', ['status', 'label']),
    id: param.nullable(param.string('The term\'s id.')),
    name: param.string('Its name.'),
    color: param.string('Its colour.'),
    added: param.boolean('True when the term is new.'),
  },
  ['kind', 'id', 'name', 'added'],
);

export const filterSaveResult = param.object(
  'The filter that was saved.',
  { id: param.nullable(param.string('The filter\'s id.')), name: param.string('Its name.') },
  ['id', 'name'],
);

export const goalSaveResult = param.object(
  'The goal that was saved.',
  { id: param.nullable(param.string('The goal\'s id.')), node: param.string('The node it targets.'), target: param.number('Its target.') },
  ['id', 'node', 'target'],
);

export const memoryWriteResult = param.object(
  'The note that was saved.',
  { slug: param.string('Its slug.'), created: param.boolean('True when the note is new.'), digest: param.string('The digest of its text.') },
  ['slug', 'created', 'digest'],
);

export const instructionsProposeResult = param.object(
  'CAOTANG.md as it now stands.',
  { file: param.choice('Always CAOTANG.md.', ['CAOTANG.md']), characters: param.integer('Its length.'), digest: param.string('The digest of its text.') },
  ['file', 'characters', 'digest'],
);

/* ------------------------------------------------------------------ *
 * The table
 * ------------------------------------------------------------------ */

/** A tool that can be called: every registry row but the plan protocol. */
export type CallableToolName = Exclude<ToolName, 'agent.plan'>;

/** Each callable row's result spec, keyed by tool name. A row left out is a compile error. */
export const RESULT_SPECS = {
  'project.overview': projectOverviewResult,
  'binder.read_tree': readTreeResult,
  'doc.read': docReadResult,
  'notes.read': notesReadResult,
  'meta.set': metaSetResult,
  'notes.append': notesAppendResult,
  'synopsis.fill': synopsisFillResult,
  'scene.draft': sceneDraftResult,
  'binder.restructure': restructureResult,
  'continuity.scan': continuityScanResult,
  'export.compile': exportCompileResult,
  'codex.read': codexReadResult,
  'codex.write': codexWriteResult,
  'doc.import': docImportResult,
  'codex.import': codexImportResult,
  'coherence.scan': COHERENCE_SCAN_RESULT,
  'coherence.review': COHERENCE_REVIEW_RESULT,
  'coherence.setFindingStatus': COHERENCE_SET_STATUS_RESULT,
  'tool.search': TOOL_SEARCH_RESULT,
  'shots.derive': shotsDeriveResult,
  'shots.annotate': shotsAnnotateResult,
  'prompt.draft': promptDraftResult,
  'prompt.variant': promptVariantResult,
  'dialogue.draft': DIALOGUE_DRAFT_RESULT,
  'dialogue.table': DIALOGUE_TABLE_RESULT,
  'skill.load': skillLoadResult,
  'memory.read': memoryReadResult,
  'agent.delegate': agentDelegateResult,
  'scene.brief': sceneBriefResult,
  'scene.apply': sceneDraftResult,
  'dialogue.brief': dialogueBriefResult,
  'dialogue.apply': DIALOGUE_DRAFT_RESULT,
  'notes.replace': notesReplaceResult,
  'synopsis.set': synopsisSetResult,
  'vocabulary.upsert': vocabularyUpsertResult,
  'filter.save': filterSaveResult,
  'goal.save': goalSaveResult,
  'memory.write': memoryWriteResult,
  'instructions.propose': instructionsProposeResult,
} satisfies Record<CallableToolName, ObjectSpec>;

/** The rows whose result spec is complete, so a key it does not list is refused. The checklist of open rows is every name not here. */
export const RESULT_CLOSED: ReadonlySet<CallableToolName> = new Set<CallableToolName>([
  'project.overview',
  'binder.read_tree',
  'doc.read',
  'notes.read',
  'meta.set',
  'notes.append',
  'synopsis.fill',
  'scene.draft',
  'binder.restructure',
  'continuity.scan',
  'export.compile',
  'codex.read',
  'codex.write',
  'tool.search',
]);

/* ------------------------------------------------------------------ *
 * The typed map
 * ------------------------------------------------------------------ */

type Words = number;
type Text = string;
type Names = readonly string[];

/** One card of the codex, as `@caotang/codex` shapes it. Declared open in the spec: an entry carries what its type needs. */
type CodexCard = Readonly<Record<string, unknown>>;

type Brief = {
  readonly briefId: string;
  readonly revision: number;
  readonly expiresAt: string;
  readonly framing: string;
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  readonly reply: string;
  readonly applyWith: Readonly<Record<string, unknown>>;
  readonly applyTool: 'scene.apply' | 'dialogue.apply';
  readonly droppedContext: Names;
};

type DialogueDraft = {
  readonly container: string;
  readonly newBeats: Names;
  readonly warnings: Names;
};

type SceneDraft = {
  readonly doc: Ref;
  readonly mode: 'draft' | 'continue' | 'rewrite_selection';
  readonly words: Words;
  readonly range: { readonly from: number; readonly to: number };
  readonly revision: number;
};

type FindingGroupData = {
  readonly checkId: string;
  readonly factGroup: string;
  readonly type: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly count: number;
  readonly findingIds: Names;
  readonly docIds: Names;
};

type VocabularyTerm = { readonly id: string; readonly name: string };

/**
 * What `ToolValue.data` holds on success, by tool. Hand-written beside the specs above; `SpecAgrees` keeps the two in step.
 * An optional key is one the spec does not require.
 */
export interface ToolResults {
  'project.overview': {
    readonly title: string;
    readonly empty: boolean;
    readonly tree: readonly {
      readonly id: string;
      readonly title: string;
      readonly type: string;
      readonly status: string | null;
      readonly children: readonly { readonly id: string; readonly title: string; readonly type: string; readonly status: string | null }[];
      readonly childrenTotal?: number;
    }[];
    readonly vocabulary: { readonly statuses: readonly VocabularyTerm[]; readonly labels: readonly VocabularyTerm[] };
    readonly totalWords: Words;
    readonly session: { readonly todayWords: Words; readonly target: number | null } | null;
    readonly savedFilters: number;
    readonly filters: readonly { readonly id: string; readonly name: string }[];
    readonly goals: readonly { readonly id: string; readonly name: string; readonly target: number }[];
    readonly withheld?: number;
  };
  'binder.read_tree': {
    readonly root: Ref;
    readonly depth: number;
    readonly include: 'counts' | 'synopsis' | 'none';
    readonly nodes: readonly {
      readonly id: string;
      readonly title: string;
      readonly type: string;
      readonly parentId: string | null;
      readonly order: number;
      readonly depth: number;
      readonly status: string | null;
      readonly label: string | null;
      readonly synopsis?: string;
      readonly words?: Words;
    }[];
    readonly total: number;
    readonly truncated: boolean;
    readonly withheld?: number;
    readonly note?: Text;
  };
  'doc.read': {
    readonly doc: Ref;
    readonly range?: { readonly from: number; readonly to: number; readonly length: number };
    readonly format: 'detailed' | 'concise';
    readonly text?: Text;
    readonly words?: Words;
    readonly characters?: number;
    readonly structure?: {
      readonly words: Words;
      readonly characters: number;
      readonly paragraphs: number;
      readonly scenes: number;
      readonly headings: readonly { readonly level: number; readonly text: string }[];
    };
    readonly synopsis?: Text;
    readonly lead?: Text;
  };
  'notes.read': { readonly doc: Ref; readonly synopsis?: Text; readonly keywords?: Names; readonly notes?: Text };
  'meta.set': {
    readonly changed: readonly Ref[];
    readonly patch: {
      readonly status?: string;
      readonly label?: string;
      readonly keywords_add?: Names;
      readonly keywords_remove?: Names;
    };
  };
  'notes.append': { readonly doc: Ref; readonly appended: number };
  'synopsis.fill': {
    readonly rows: readonly { readonly doc: Ref; readonly action: 'create' | 'replace'; readonly words: Words }[];
    readonly count: number;
  };
  'scene.draft': SceneDraft;
  'binder.restructure': { readonly applied: number; readonly operations: Names };
  'continuity.scan': {
    readonly scope: Names;
    readonly aspects: Names;
    readonly findings: readonly {
      readonly aspect: 'timeline' | 'characters' | 'props' | 'custom';
      readonly severity: 'info' | 'minor' | 'major';
      readonly docs: Names;
      readonly quote: string;
      readonly note: string;
    }[];
    readonly count: number;
  };
  'export.compile': {
    readonly scope: 'manuscript' | 'part';
    readonly format: string;
    readonly command: 'export.compile' | 'export.compileSelection';
    readonly includeRootIds: Names;
    readonly result: Readonly<Record<string, unknown>> | null;
    readonly recipe?: string;
  };
  'codex.read': {
    readonly entries: readonly CodexCard[];
    readonly total: number;
    readonly truncated: boolean;
    readonly withheld?: number;
    readonly note?: Text;
  };
  'codex.write': {
    readonly created: Names;
    readonly updated: Names;
    readonly attachmentChanges: number;
    readonly diffs: readonly CodexCard[];
    readonly diffsOmitted?: number;
  };
  'doc.import': {
    readonly doc: Ref;
    readonly parent: { readonly title: string };
    readonly words: Words;
    readonly characters: number;
    readonly scan?: Readonly<Record<string, unknown>>;
  };
  'codex.import': {
    readonly created: Names;
    readonly attached: number;
    readonly origin: 'import';
    readonly diffs: readonly CodexCard[];
    readonly diffsOmitted?: number;
    readonly scan?: Readonly<Record<string, unknown>>;
  };
  'coherence.scan': {
    readonly runId: string;
    readonly status: 'complete' | 'partial' | 'discarded';
    readonly findingsUpserted: number;
    readonly documents: number;
    readonly groups: readonly FindingGroupData[];
    readonly notes: Names;
  };
  'coherence.review': {
    readonly runId: string;
    readonly status: 'complete' | 'partial';
    readonly findingsUpserted: number;
    readonly groups: readonly FindingGroupData[];
    readonly notes: Names;
  };
  'coherence.setFindingStatus': { readonly findingId: string; readonly status: 'fixed'; readonly alreadyFixed: boolean };
  'tool.search': {
    readonly matches: readonly {
      readonly source: 'native' | 'external';
      readonly name: string;
      readonly serverKey?: string;
      readonly serverName?: string;
      readonly toolName?: string;
      readonly excerpt: string;
      readonly risk: 'read' | 'write';
    }[];
    readonly surfaced: Names;
  };
  'shots.derive': { readonly folder: string; readonly scene: string; readonly shots: number };
  'shots.annotate': { readonly changed: number; readonly unchanged: number };
  'prompt.draft': { readonly vendor: string; readonly writes: number };
  'prompt.variant': {
    readonly shotId: string;
    readonly shotNumber: number;
    readonly vendor: string;
    readonly variation: string;
    readonly field: 'prompt.camera' | 'prompt.style' | 'audio.ambient';
    readonly current: string;
    readonly alternatives: readonly Readonly<Record<string, unknown>>[];
    readonly base: string;
    readonly model: string;
  };
  'dialogue.draft': DialogueDraft;
  'dialogue.table': {
    readonly containerId: string;
    readonly title: string;
    readonly format: 'csv' | 'json';
    readonly rows: number;
    readonly missingLineIds: number;
    readonly engineTarget: string | null;
    readonly locale: string | null;
    readonly table?: readonly Readonly<Record<string, unknown>>[];
    readonly csv?: string;
  };
  'skill.load': { readonly skill: string; readonly label: string; readonly instructions: string; readonly note?: string };
  'memory.read': {
    readonly slug?: string;
    readonly type?: string;
    readonly title?: string;
    readonly body?: string;
    readonly origin?: string;
    readonly digest?: string;
    readonly instructions?: { readonly file: string | null; readonly characters: number; readonly digest: string };
    readonly notes?: readonly {
      readonly slug: string;
      readonly type: string;
      readonly title: string;
      readonly origin: string;
      readonly characters: number;
      readonly digest: string;
    }[];
    readonly noteLimit?: { readonly bodyCharacters: number };
    readonly unreadable?: Names;
  };
  'agent.delegate': {
    readonly notice: string;
    readonly agent: 'reader' | 'general';
    readonly agentPath: string;
    readonly status: 'done' | 'partial' | 'failed';
    readonly summary: string;
    readonly proposedSteps: readonly Readonly<Record<string, unknown>>[];
    readonly read: Names;
    readonly usage: { readonly modelCalls: number; readonly promptTokens: number; readonly completionTokens: number };
  };
  'scene.brief': Brief & { readonly doc: Ref; readonly mode: 'draft' | 'continue' | 'rewrite_selection' };
  'scene.apply': SceneDraft;
  'dialogue.brief': Brief & { readonly container: Ref };
  'dialogue.apply': DialogueDraft;
  'notes.replace': { readonly doc: Ref; readonly characters: number };
  'synopsis.set': { readonly doc: Ref; readonly characters: number };
  'vocabulary.upsert': {
    readonly kind: 'status' | 'label';
    readonly id: string | null;
    readonly name: string;
    readonly color?: string;
    readonly added: boolean;
  };
  'filter.save': { readonly id: string | null; readonly name: string };
  'goal.save': { readonly id: string | null; readonly node: string; readonly target: number };
  'memory.write': { readonly slug: string; readonly created: boolean; readonly digest: string };
  'instructions.propose': { readonly file: 'CAOTANG.md'; readonly characters: number; readonly digest: string };
}

/** The data type of a call to `N`: the row's own when `N` is a literal tool name, any JSON object otherwise. */
export type ResultData<N extends string> = N extends keyof ToolResults ? ToolResults[N] : ToolData;

/** A successful call to `N`, typed by its row. */
export type ResultOf<N extends keyof ToolResults> = ToolValue<ToolResults[N]>;

/**
 * Whether a value came from the row `name`, so its `data` can be read by key. The value is known by the call that made it: a tool's
 * answer has its row's shape, which the tests hold every tool to (`testing.ts`), so the production reader does not check it again.
 */
export function isResultOf<N extends keyof ToolResults>(name: N, tool: string, _value: ToolValue): _value is ResultOf<N> {
  return tool === name;
}

/* ------------------------------------------------------------------ *
 * Spec and type must agree
 * ------------------------------------------------------------------ */

type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T];
type RequiredKeys<T> = Exclude<keyof T, OptionalKeys<T>>;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * True when a spec built with `param.object` and the type it stands for list the same keys and require the same ones. The
 * check is on the top level of the result, which is where a renamed or dropped field is most likely; the runtime check
 * (`testing.ts`) walks the nesting.
 */
export type SpecAgrees<S extends { readonly properties: object; readonly required: readonly string[] }, T> =
  Same<keyof S['properties'], keyof T> extends true ? Same<S['required'][number], RequiredKeys<T>> : false;

/** Every entry of `ToolResults` against its spec: a `false` here is a compile error where `RESULT_AGREEMENT` is declared. */
export type ResultAgreement = { readonly [N in keyof ToolResults]: SpecAgrees<(typeof RESULT_SPECS)[N], ToolResults[N]> };
