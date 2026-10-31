// i18n: package-refs
/**
 * The task list of a turn (agent-harness §8): what the writer asks while waiting, answered from the events the loop already
 * emits. `reduceTaskList` folds one turn's events into a short checklist, with one item in progress at a time, and
 * `headerLineOf` words the item the agent header shows.
 *
 * The list is derived, not declared: it comes from the plan cards and the status cards, so it costs no model tokens, is a
 * pure function of the event stream (an eval can assert it), and cannot claim work that did not run. It is never sent to the
 * model. Nothing here touches the DOM.
 */

import type { MessageRef } from '@caotang/i18n';

import { isToolName, type ToolName } from '../metadata.js';
import type { CallParams } from '../types.js';
import type { PlanCardView, PlanStepView, StatusCard, StatusState } from './cards.js';
import { DEFAULT_MAX_MODEL_CALLS, type AgentEvent, type TurnPhase } from './events.js';

/* ------------------------------------------------------------------ *
 * Phrases — one per tool, so an item reads as a sentence about its target.
 * ------------------------------------------------------------------ */

/** An item's two lines: the imperative one the list shows, and the present-tense one the header shows while it runs. */
export interface TaskPhrase {
  readonly content: string;
  readonly activeForm: string;
  /** I7: the same two lines as message references, so the app may render them in another language. */
  readonly contentRef?: MessageRef;
  readonly activeFormRef?: MessageRef;
}

export type TaskPhraseFn = (params: CallParams) => TaskPhrase;

const TARGET_CHARS = 40;

/** A document or entry name, cut so a long title cannot fill the header. The ref carries the cut name as its value. */
function clipped(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > TARGET_CHARS ? `${trimmed.slice(0, TARGET_CHARS - 1).trimEnd()}…` : trimmed;
}

/** A document or entry name as an item quotes it in English. */
function quoted(name: string): string {
  return `“${clipped(name)}”`;
}

function textOf(params: CallParams, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function listOf(params: CallParams, key: string): readonly unknown[] {
  const value = params[key];
  return Array.isArray(value) ? value : [];
}

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

const phrase = (content: string, activeForm: string, contentRef?: MessageRef, activeFormRef?: MessageRef): TaskPhrase => ({
  content,
  activeForm,
  ...(contentRef === undefined ? {} : { contentRef }),
  ...(activeFormRef === undefined ? {} : { activeFormRef }),
});

// Literal references at the call site keep every fixed phrase visible to catalogue extraction.
const plain = (content: MessageRef, activeForm: MessageRef): TaskPhrase =>
  phrase(content.message, activeForm.message, content, activeForm);

/**
 * One phrase per registry tool, including the extension rows. Keyed by `ToolName`, so a row added to the registry without
 * a phrase here does not compile, and `test/agent/progress.test.ts` reads `harness.tools()` back to prove it. The text
 * is fixed wording plus the call's own params: a tool's description is never used (descriptions of external tools are untrusted).
 */
export const TASK_PHRASES: Readonly<Record<ToolName, TaskPhraseFn>> = {
  'project.overview': () => plain({ id: 'harness.progress.projectOverview.content', message: 'Read the project overview' }, { id: 'harness.progress.projectOverview.active', message: 'Reading the project overview' }),
  'binder.read_tree': () => plain({ id: 'harness.progress.binderReadTree.content', message: 'Read the binder' }, { id: 'harness.progress.binderReadTree.active', message: 'Reading the binder' }),
  'doc.read': (params) => {
    const doc = textOf(params, 'doc');
    if (doc === undefined) return plain(
      { id: 'harness.progress.docRead.bare.content', message: 'Read a document' },
      { id: 'harness.progress.docRead.bare.active', message: 'Reading a document' },
    );
    return phrase(`Read ${quoted(doc)}`, `Reading ${quoted(doc)}`,
      { id: 'harness.progress.docRead.content', message: 'Read “{doc}”', values: { doc: clipped(doc) } },
      { id: 'harness.progress.docRead.active', message: 'Reading “{doc}”', values: { doc: clipped(doc) } },
    );
  },
  'notes.read': (params) => {
    const doc = textOf(params, 'doc');
    return doc === undefined
      ? plain({ id: 'harness.progress.notesRead.bare.content', message: 'Read notes' }, { id: 'harness.progress.notesRead.bare.active', message: 'Reading notes' })
      : phrase(
          `Read the notes of ${quoted(doc)}`,
          `Reading the notes of ${quoted(doc)}`,
          { id: 'harness.progress.notesRead.content', message: 'Read the notes of “{doc}”', values: { doc: clipped(doc) } },
          { id: 'harness.progress.notesRead.active', message: 'Reading the notes of “{doc}”', values: { doc: clipped(doc) } },
        );
  },
  'meta.set': (params) => {
    const targets = listOf(params, 'targets');
    const only = targets.length === 1 && typeof targets[0] === 'string' ? targets[0] : undefined;
    if (only !== undefined) {
      return phrase(
        `Update ${quoted(only)}`,
        `Updating ${quoted(only)}`,
        { id: 'harness.progress.metaSet.one', message: 'Update “{target}”', values: { target: clipped(only) } },
        { id: 'harness.progress.metaSet.one.active', message: 'Updating “{target}”', values: { target: clipped(only) } },
      );
    }
    if (targets.length === 0) return plain({ id: 'harness.progress.metaSet.none.content', message: 'Update document details' }, { id: 'harness.progress.metaSet.none.active', message: 'Updating document details' });
    return phrase(
      `Update ${counted(targets.length, 'document', 'documents')}`,
      `Updating ${counted(targets.length, 'document', 'documents')}`,
      {
        id: 'harness.progress.metaSet.content',
        message: 'Update {count, plural, one {# document} other {# documents}}',
        values: { count: targets.length },
      },
      {
        id: 'harness.progress.metaSet.active',
        message: 'Updating {count, plural, one {# document} other {# documents}}',
        values: { count: targets.length },
      },
    );
  },
  'notes.append': (params) => {
    const doc = textOf(params, 'doc');
    return doc === undefined
      ? plain({ id: 'harness.progress.notesAppend.bare.content', message: 'Add to the notes' }, { id: 'harness.progress.notesAppend.bare.active', message: 'Adding to the notes' })
      : phrase(
          `Add to the notes of ${quoted(doc)}`,
          `Adding to the notes of ${quoted(doc)}`,
          { id: 'harness.progress.notesAppend.content', message: 'Add to the notes of “{doc}”', values: { doc: clipped(doc) } },
          { id: 'harness.progress.notesAppend.active', message: 'Adding to the notes of “{doc}”', values: { doc: clipped(doc) } },
        );
  },
  'synopsis.fill': (params) => {
    const docs = listOf(params, 'docs');
    const only = docs.length === 1 && typeof docs[0] === 'string' ? docs[0] : undefined;
    if (only !== undefined) {
      return phrase(
        `Fill the synopsis of ${quoted(only)}`,
        `Filling the synopsis of ${quoted(only)}`,
        { id: 'harness.progress.synopsisFill.one', message: 'Fill the synopsis of “{doc}”', values: { doc: clipped(only) } },
        { id: 'harness.progress.synopsisFill.one.active', message: 'Filling the synopsis of “{doc}”', values: { doc: clipped(only) } },
      );
    }
    if (docs.length === 0) return plain({ id: 'harness.progress.synopsisFill.none.content', message: 'Fill synopses' }, { id: 'harness.progress.synopsisFill.none.active', message: 'Filling synopses' });
    return phrase(
      `Fill ${counted(docs.length, 'synopsis', 'synopses')}`,
      `Filling ${counted(docs.length, 'synopsis', 'synopses')}`,
      {
        id: 'harness.progress.synopsisFill.content',
        message: 'Fill {count, plural, one {# synopsis} other {# synopses}}',
        values: { count: docs.length },
      },
      {
        id: 'harness.progress.synopsisFill.active',
        message: 'Filling {count, plural, one {# synopsis} other {# synopses}}',
        values: { count: docs.length },
      },
    );
  },
  'scene.draft': (params) => {
    const doc = textOf(params, 'doc');
    if (doc === undefined) return plain(
      { id: 'harness.progress.sceneDraft.bare.content', message: 'Draft a scene' },
      { id: 'harness.progress.sceneDraft.bare.active', message: 'Drafting a scene' },
    );
    return phrase(`Draft ${quoted(doc)}`, `Drafting ${quoted(doc)}`,
      { id: 'harness.progress.sceneDraft.content', message: 'Draft “{doc}”', values: { doc: clipped(doc) } },
      { id: 'harness.progress.sceneDraft.active', message: 'Drafting “{doc}”', values: { doc: clipped(doc) } },
    );
  },
  'binder.restructure': (params) => {
    const changes = listOf(params, 'ops').length;
    if (changes === 0) return plain({ id: 'harness.progress.binderRestructure.none.content', message: 'Restructure the binder' }, { id: 'harness.progress.binderRestructure.none.active', message: 'Restructuring the binder' });
    const what = counted(changes, 'change', 'changes');
    return phrase(
      `Restructure the binder (${what})`,
      `Restructuring the binder (${what})`,
      {
        id: 'harness.progress.binderRestructure.content',
        message: 'Restructure the binder ({count, plural, one {# change} other {# changes}})',
        values: { count: changes },
      },
      {
        id: 'harness.progress.binderRestructure.active',
        message: 'Restructuring the binder ({count, plural, one {# change} other {# changes}})',
        values: { count: changes },
      },
    );
  },
  'continuity.scan': () => plain({ id: 'harness.progress.continuityScan.content', message: 'Scan for continuity problems' }, { id: 'harness.progress.continuityScan.active', message: 'Scanning for continuity problems' }),
  'export.compile': (params) => {
    const format = textOf(params, 'format');
    return format === undefined
      ? plain({ id: 'harness.progress.exportCompile.none.content', message: 'Compile an export' }, { id: 'harness.progress.exportCompile.none.active', message: 'Compiling an export' })
      : phrase(
          `Compile a ${format} export`,
          `Compiling a ${format} export`,
          { id: 'harness.progress.exportCompile.content', message: 'Compile a {format} export', values: { format } },
          { id: 'harness.progress.exportCompile.active', message: 'Compiling a {format} export', values: { format } },
        );
  },
  'codex.read': (params) => {
    const query = textOf(params, 'query');
    return query === undefined
      ? plain({ id: 'harness.progress.codexRead.bare.content', message: 'Read the codex' }, { id: 'harness.progress.codexRead.bare.active', message: 'Reading the codex' })
      : phrase(
          `Look up ${quoted(query)} in the codex`,
          `Looking up ${quoted(query)} in the codex`,
          { id: 'harness.progress.codexRead.content', message: 'Look up “{query}” in the codex', values: { query: clipped(query) } },
          { id: 'harness.progress.codexRead.active', message: 'Looking up “{query}” in the codex', values: { query: clipped(query) } },
        );
  },
  'codex.write': (params) => {
    const entries = listOf(params, 'entries').length;
    if (entries === 0) return plain({ id: 'harness.progress.codexWrite.none.content', message: 'Write codex entries' }, { id: 'harness.progress.codexWrite.none.active', message: 'Writing codex entries' });
    return phrase(
      `Write ${counted(entries, 'codex entry', 'codex entries')}`,
      `Writing ${counted(entries, 'codex entry', 'codex entries')}`,
      {
        id: 'harness.progress.codexWrite.content',
        message: 'Write {count, plural, one {# codex entry} other {# codex entries}}',
        values: { count: entries },
      },
      {
        id: 'harness.progress.codexWrite.active',
        message: 'Writing {count, plural, one {# codex entry} other {# codex entries}}',
        values: { count: entries },
      },
    );
  },
  'agent.plan': () => plain({ id: 'harness.progress.agentPlan.content', message: 'Plan' }, { id: 'harness.progress.agentPlan.active', message: 'Planning' }),
  'doc.import': (params) => {
    const title = textOf(params, 'title');
    return title === undefined
      ? plain({ id: 'harness.progress.docImport.bare.content', message: 'Import a document' }, { id: 'harness.progress.docImport.bare.active', message: 'Importing a document' })
      : phrase(
          `Import ${quoted(title)}`,
          `Importing ${quoted(title)}`,
          { id: 'harness.progress.docImport.content', message: 'Import “{title}”', values: { title: clipped(title) } },
          { id: 'harness.progress.docImport.active', message: 'Importing “{title}”', values: { title: clipped(title) } },
        );
  },
  'codex.import': (params) => {
    const entries = listOf(params, 'entries').length;
    if (entries === 0) return plain({ id: 'harness.progress.codexImport.none.content', message: 'Import codex entries' }, { id: 'harness.progress.codexImport.none.active', message: 'Importing codex entries' });
    return phrase(
      `Import ${counted(entries, 'codex entry', 'codex entries')}`,
      `Importing ${counted(entries, 'codex entry', 'codex entries')}`,
      {
        id: 'harness.progress.codexImport.content',
        message: 'Import {count, plural, one {# codex entry} other {# codex entries}}',
        values: { count: entries },
      },
      {
        id: 'harness.progress.codexImport.active',
        message: 'Importing {count, plural, one {# codex entry} other {# codex entries}}',
        values: { count: entries },
      },
    );
  },
  'coherence.scan': () => plain({ id: 'harness.progress.coherenceScan.content', message: 'Scan for coherence problems' }, { id: 'harness.progress.coherenceScan.active', message: 'Scanning for coherence problems' }),
  'coherence.review': () => plain({ id: 'harness.progress.coherenceReview.content', message: 'Review the story for coherence' }, { id: 'harness.progress.coherenceReview.active', message: 'Reviewing the story for coherence' }),
  'coherence.setFindingStatus': () => plain({ id: 'harness.progress.setFindingStatus.content', message: 'Update a finding' }, { id: 'harness.progress.setFindingStatus.active', message: 'Updating a finding' }),
  'tool.search': () => plain({ id: 'harness.progress.toolSearch.content', message: 'Search for tools' }, { id: 'harness.progress.toolSearch.active', message: 'Searching for tools' }),
  'shots.derive': () => plain({ id: 'harness.progress.shotsDerive.content', message: 'Derive shots' }, { id: 'harness.progress.shotsDerive.active', message: 'Deriving shots' }),
  'shots.annotate': () => plain({ id: 'harness.progress.shotsAnnotate.content', message: 'Annotate shots' }, { id: 'harness.progress.shotsAnnotate.active', message: 'Annotating shots' }),
  'prompt.draft': () => plain({ id: 'harness.progress.promptDraft.content', message: 'Draft video prompts' }, { id: 'harness.progress.promptDraft.active', message: 'Drafting video prompts' }),
  'prompt.variant': () => plain({ id: 'harness.progress.promptVariant.content', message: 'Draft a prompt variant' }, { id: 'harness.progress.promptVariant.active', message: 'Drafting a prompt variant' }),
  'dialogue.draft': (params) => {
    const doc = textOf(params, 'doc');
    if (doc === undefined) return plain(
      { id: 'harness.progress.dialogueDraft.bare.content', message: 'Draft dialogue' },
      { id: 'harness.progress.dialogueDraft.bare.active', message: 'Drafting dialogue' },
    );
    return phrase(`Draft dialogue in ${quoted(doc)}`, `Drafting dialogue in ${quoted(doc)}`,
      { id: 'harness.progress.dialogueDraft.content', message: 'Draft dialogue in “{doc}”', values: { doc: clipped(doc) } },
      { id: 'harness.progress.dialogueDraft.active', message: 'Drafting dialogue in “{doc}”', values: { doc: clipped(doc) } },
    );
  },
  'dialogue.table': (params) => {
    const doc = textOf(params, 'doc');
    if (doc === undefined) return plain(
      { id: 'harness.progress.dialogueTable.bare.content', message: 'Export a dialogue table' },
      { id: 'harness.progress.dialogueTable.bare.active', message: 'Exporting a dialogue table' },
    );
    return phrase(`Export the dialogue table of ${quoted(doc)}`, `Exporting the dialogue table of ${quoted(doc)}`,
      { id: 'harness.progress.dialogueTable.content', message: 'Export the dialogue table of “{doc}”', values: { doc: clipped(doc) } },
      { id: 'harness.progress.dialogueTable.active', message: 'Exporting the dialogue table of “{doc}”', values: { doc: clipped(doc) } },
    );
  },
  'skill.load': (params) => {
    const name = textOf(params, 'name');
    return name === undefined
      ? plain({ id: 'harness.progress.skillLoad.bare.content', message: 'Read a skill' }, { id: 'harness.progress.skillLoad.bare.active', message: 'Reading a skill' })
      : phrase(
          `Read the skill ${quoted(name)}`,
          `Reading the skill ${quoted(name)}`,
          { id: 'harness.progress.skillLoad.content', message: 'Read the skill “{name}”', values: { name: clipped(name) } },
          { id: 'harness.progress.skillLoad.active', message: 'Reading the skill “{name}”', values: { name: clipped(name) } },
        );
  },
  'agent.delegate': (params) => {
    const agent = textOf(params, 'agent');
    return agent === undefined
      ? plain({ id: 'harness.progress.agentDelegate.bare.content', message: 'Hand work to a helper agent' }, { id: 'harness.progress.agentDelegate.bare.active', message: 'Handing work to a helper agent' })
      : phrase(
          `Hand work to the ${agent} agent`,
          `Handing work to the ${agent} agent`,
          { id: 'harness.progress.agentDelegate.content', message: 'Hand work to the {agent} agent', values: { agent } },
          { id: 'harness.progress.agentDelegate.active', message: 'Handing work to the {agent} agent', values: { agent } },
        );
  },
  'notes.replace': (params) => {
    const doc = textOf(params, 'doc');
    if (doc === undefined) return plain(
      { id: 'harness.progress.notesReplace.bare.content', message: 'Rewrite notes' },
      { id: 'harness.progress.notesReplace.bare.active', message: 'Rewriting notes' },
    );
    return phrase(`Rewrite the notes of ${quoted(doc)}`, `Rewriting the notes of ${quoted(doc)}`,
      { id: 'harness.progress.notesReplace.content', message: 'Rewrite the notes of “{doc}”', values: { doc: clipped(doc) } },
      { id: 'harness.progress.notesReplace.active', message: 'Rewriting the notes of “{doc}”', values: { doc: clipped(doc) } },
    );
  },
  'synopsis.set': (params) => {
    const doc = textOf(params, 'doc');
    if (doc === undefined) return plain(
      { id: 'harness.progress.synopsisSet.bare.content', message: 'Set a synopsis' },
      { id: 'harness.progress.synopsisSet.bare.active', message: 'Setting a synopsis' },
    );
    return phrase(`Set the synopsis of ${quoted(doc)}`, `Setting the synopsis of ${quoted(doc)}`,
      { id: 'harness.progress.synopsisSet.content', message: 'Set the synopsis of “{doc}”', values: { doc: clipped(doc) } },
      { id: 'harness.progress.synopsisSet.active', message: 'Setting the synopsis of “{doc}”', values: { doc: clipped(doc) } },
    );
  },
  'vocabulary.upsert': (params) => {
    const name = textOf(params, 'name');
    const kind = textOf(params, 'kind') ?? 'status';
    return name === undefined
      ? phrase(
          `Change the ${kind} vocabulary`,
          `Changing the ${kind} vocabulary`,
          { id: 'harness.progress.vocabularyUpsert.kind', message: 'Change the {kind} vocabulary', values: { kind } },
          { id: 'harness.progress.vocabularyUpsert.kind.active', message: 'Changing the {kind} vocabulary', values: { kind } },
        )
      : phrase(
          `Add or change the ${kind} ${quoted(name)}`,
          `Adding or changing the ${kind} ${quoted(name)}`,
          {
            id: 'harness.progress.vocabularyUpsert.content',
            message: 'Add or change the {kind} “{name}”',
            values: { kind, name: clipped(name) },
          },
          {
            id: 'harness.progress.vocabularyUpsert.active',
            message: 'Adding or changing the {kind} “{name}”',
            values: { kind, name: clipped(name) },
          },
        );
  },
  'filter.save': (params) => {
    const name = textOf(params, 'name');
    return name === undefined
      ? plain({ id: 'harness.progress.filterSave.bare.content', message: 'Save a filter' }, { id: 'harness.progress.filterSave.bare.active', message: 'Saving a filter' })
      : phrase(
          `Save the filter ${quoted(name)}`,
          `Saving the filter ${quoted(name)}`,
          { id: 'harness.progress.filterSave.content', message: 'Save the filter “{name}”', values: { name: clipped(name) } },
          { id: 'harness.progress.filterSave.active', message: 'Saving the filter “{name}”', values: { name: clipped(name) } },
        );
  },
  'goal.save': (params) => {
    const node = textOf(params, 'node');
    return node === undefined
      ? plain({ id: 'harness.progress.goalSave.bare.content', message: 'Set a goal' }, { id: 'harness.progress.goalSave.bare.active', message: 'Setting a goal' })
      : phrase(
          `Set a goal for ${quoted(node)}`,
          `Setting a goal for ${quoted(node)}`,
          { id: 'harness.progress.goalSave.content', message: 'Set a goal for “{node}”', values: { node: clipped(node) } },
          { id: 'harness.progress.goalSave.active', message: 'Setting a goal for “{node}”', values: { node: clipped(node) } },
        );
  },
  'timeline.read': () => plain({ id: 'harness.progress.timelineRead.content', message: 'Read the timeline' }, { id: 'harness.progress.timelineRead.active', message: 'Reading the timeline' }),
  'pictures.list': () => plain({ id: 'harness.progress.picturesList.content', message: 'List the pictures' }, { id: 'harness.progress.picturesList.active', message: 'Listing the pictures' }),
  'pictures.view': () => plain({ id: 'harness.progress.picturesView.content', message: 'Look at the pictures' }, { id: 'harness.progress.picturesView.active', message: 'Looking at the pictures' }),
  'pictures.annotate': () => plain({ id: 'harness.progress.picturesAnnotate.content', message: 'Update the picture details' }, { id: 'harness.progress.picturesAnnotate.active', message: 'Updating the picture details' }),
  'pictures.attach': () => plain({ id: 'harness.progress.picturesAttach.content', message: 'Change the picture placements' }, { id: 'harness.progress.picturesAttach.active', message: 'Changing the picture placements' }),
  'pictures.import': () => plain({ id: 'harness.progress.picturesImport.content', message: 'Import the staged picture' }, { id: 'harness.progress.picturesImport.active', message: 'Importing the staged picture' }),
  'pictures.place': () => plain({ id: 'harness.progress.picturesPlace.content', message: 'Place the picture in the document' }, { id: 'harness.progress.picturesPlace.active', message: 'Placing the picture in the document' }),
  'pictures.transcribe': () => plain({ id: 'harness.progress.picturesTranscribe.content', message: 'Transcribe the handwritten pages' }, { id: 'harness.progress.picturesTranscribe.active', message: 'Transcribing the handwritten pages' }),
  'comic.derive': () => plain({ id: 'harness.progress.comicDerive.content', message: 'Derive comic pages from the script' }, { id: 'harness.progress.comicDerive.active', message: 'Deriving comic pages from the script' }),
  'comic.letter': () => plain({ id: 'harness.progress.comicLetter.content', message: 'Letter the comic page' }, { id: 'harness.progress.comicLetter.active', message: 'Lettering the comic page' }),
  'comic.scriptFromPages': () => plain({ id: 'harness.progress.comicScriptFromPages.content', message: 'Write a comic script from the pages' }, { id: 'harness.progress.comicScriptFromPages.active', message: 'Writing a comic script from the pages' }),
  'timeline.edit': (params) => {
    const ops = listOf(params, 'ops').length;
    if (ops === 0) return plain({ id: 'harness.progress.timelineEdit.bare.content', message: 'Edit the timeline' }, { id: 'harness.progress.timelineEdit.bare.active', message: 'Editing the timeline' });
    return phrase(
      `Edit the timeline (${counted(ops, 'change', 'changes')})`,
      `Editing the timeline (${counted(ops, 'change', 'changes')})`,
      { id: 'harness.progress.timelineEdit.content', message: 'Edit the timeline ({count, plural, one {# change} other {# changes}})', values: { count: ops } },
      { id: 'harness.progress.timelineEdit.active', message: 'Editing the timeline ({count, plural, one {# change} other {# changes}})', values: { count: ops } },
    );
  },
};

/** Gives a reference its name for display: a document id its title. The reducer stays pure; the caller supplies the project's titles. */
export type NameOf = (ref: string) => string;

const REF_KEYS = ['doc', 'docs', 'targets'];

/** The params with the document references in them shown by name. */
function named(params: CallParams, nameOf: NameOf): CallParams {
  const shown: Record<string, unknown> = { ...params };
  for (const key of REF_KEYS) {
    const value = params[key];
    if (typeof value === 'string') shown[key] = nameOf(value);
    else if (Array.isArray(value)) shown[key] = value.map((entry) => (typeof entry === 'string' ? nameOf(entry) : entry));
  }
  return shown;
}

/** A line terminator: none can stand in a name the parsers below accept (the `.` of the patterns they replace). */
const LINE_BREAK = /[\n\r\u2028\u2029]/;

/**
 * `mcp__<server>__<alias>`: the name an external tool is given (extensibility §3.5), split at the first `__` after a server key of at
 * least one character. A scan rather than a pattern, because the name is the server's own text and a backtracking split of it is
 * quadratic.
 */
function externalName(tool: string): { readonly server: string; readonly alias: string } | null {
  if (!tool.startsWith('mcp__') || LINE_BREAK.test(tool)) return null;
  const split = tool.indexOf('__', 6);
  if (split < 0 || split + 2 >= tool.length) return null;
  return { server: tool.slice(5, split), alias: tool.slice(split + 2) };
}

/**
 * The phrase of any tool a card can name. A native tool takes its table row. An external tool takes a generic phrase built from
 * the server key and the alias in its qualified name, never from its description, which is untrusted input (extensibility §4).
 */
export function phraseFor(tool: string, params: CallParams, nameOf?: NameOf): TaskPhrase {
  if (isToolName(tool)) return TASK_PHRASES[tool](nameOf === undefined ? params : named(params, nameOf));
  const external = externalName(tool);
  if (external !== null) {
    const call = `“${external.alias}” on “${external.server}”`;
    return phrase(`Call ${call}`, `Calling ${call}`);
  }
  return phrase(`Run ${tool}`, `Running ${tool}`);
}

/* ------------------------------------------------------------------ *
 * The list
 * ------------------------------------------------------------------ */

export type TaskState = 'pending' | 'waiting' | 'in_progress' | 'done' | 'skipped' | 'failed';

export interface TaskItem {
  /** Stable within a turn: `${seq}:${origin}` for a plan step, `reads:${round}` for a round of reads, `plan` for the planner row. */
  readonly key: string;
  /** The imperative line, e.g. "Draft “The Landing”". */
  readonly content: string;
  /** The present-tense line the header shows while the item runs, e.g. "Drafting “The Landing”". */
  readonly activeForm: string;
  /** I7: the item's two lines as message references; absent only on a caller-made list the fold did not build. */
  readonly contentRef?: MessageRef;
  readonly activeFormRef?: MessageRef;
  readonly state: TaskState;
  readonly tool?: string;
  /** The status card's call id, once the item has run. Links the item to its card. */
  readonly callId?: string;
  /** The first sentence of the refusal, for a failed item. */
  readonly reason?: string;
}

/** What the fold remembers between events. Part of the value so the reducer stays a pure function of the list and the event. */
interface Track {
  /** The groups opened so far: a plan card, a one-step confirm card or a single call each open one. */
  readonly groups: number;
  /** The planner rounds started so far; a round's reads are one item. */
  readonly round: number;
  /** The plan card the turn is deciding or running. A later plan card appends its steps; the same card shown again re-derives them. */
  readonly plan: { readonly seq: number; readonly root: string; readonly approved: boolean } | null;
  /** The cards that appeared waiting for a decision since the last plan event: the ids the next card's steps own. */
  readonly fresh: readonly { readonly id: string; readonly tool: string }[];
  /** Which item each status card belongs to. */
  readonly owner: Readonly<Record<string, string>>;
  readonly calls: Readonly<Record<string, StatusState>>;
  /** The scene whose draft is streaming, before its card is shown. */
  readonly drafting: string | null;
  /** The card waiting for the writer, if any. */
  readonly awaiting: {
    readonly kind: 'plan' | 'confirm';
    readonly steps: number;
    readonly content: string;
    readonly contentRef?: MessageRef;
  } | null;
}

export interface TaskList {
  readonly turnId: string;
  readonly items: readonly TaskItem[];
  readonly modelCalls: { readonly used: number; readonly limit: number };
  readonly phase: TurnPhase | 'idle';
  readonly track: Track;
}

export function emptyTaskList(turnId: string, limit: number = DEFAULT_MAX_MODEL_CALLS): TaskList {
  return {
    turnId,
    items: [],
    modelCalls: { used: 0, limit },
    phase: 'idle',
    track: { groups: 0, round: 0, plan: null, fresh: [], owner: {}, calls: {}, drafting: null, awaiting: null },
  };
}

/** The first sentence of a refusal: what the item shows as its reason. */
export function firstSentence(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  const match = /^.*?[.!?](?=\s|$)/.exec(line);
  return (match?.[0] ?? line).trim();
}

const PLAN_KEY = 'plan';
const READ_CALL = /:r\d+(?:\.confirm)?$/;

/**
 * The call id a plan's step ids are built from: the id less its trailing `.<step>` and any `.retry<n>` before it, or undefined when it
 * has no step suffix. Read from the end in one pass, because a pattern with a repeated retry group backtracks quadratically.
 */
export function planCallRoot(id: string): string | undefined {
  const digitsBefore = (end: number): number => {
    let start = end;
    while (start > 0 && id.charCodeAt(start - 1) >= 48 && id.charCodeAt(start - 1) <= 57) start--;
    return start;
  };
  const step = digitsBefore(id.length);
  if (step === id.length || step === 0 || id[step - 1] !== '.') return undefined;
  let end = step - 1;
  for (;;) {
    const digits = digitsBefore(end);
    if (digits === end || digits < 6 || id.slice(digits - 6, digits) !== '.retry') break;
    end = digits - 6;
  }
  const root = id.slice(0, end);
  return LINE_BREAK.test(root) ? undefined : root;
}

function isSettled(phase: TurnPhase | 'idle'): boolean {
  return phase === 'done' || phase === 'failed' || phase === 'cancelled';
}

const stepKey = (seq: number, origin: number): string => `${seq}:${origin}`;
const groupOf = (key: string): string => (key.includes(':') ? key.slice(0, key.indexOf(':')) : key);

/** The step's item: its words from the phrase table, its state from the card it is on. */
function itemOfStep(seq: number, step: PlanStepView, existing: TaskItem | undefined, nameOf?: NameOf): TaskItem {
  const words = phraseFor(step.tool, step.params, nameOf);
  const state: TaskState = step.status === 'done' ? 'done' : step.status === 'refused' ? 'failed' : 'waiting';
  const reason = step.status === 'refused' && step.error !== undefined ? firstSentence(step.error.message) : '';
  return {
    key: stepKey(seq, step.origin),
    ...words,
    state,
    tool: step.tool,
    ...(existing?.callId !== undefined && state === 'done' ? { callId: existing.callId } : {}),
    ...(reason === '' ? {} : { reason }),
  };
}

/** Replaces the items of one group, in place when the group is there and at the end when it is new. */
function withGroup(items: readonly TaskItem[], seq: number, next: readonly TaskItem[]): readonly TaskItem[] {
  const prefix = `${seq}`;
  const at = items.findIndex((item) => groupOf(item.key) === prefix);
  const rest = items.filter((item) => groupOf(item.key) !== prefix);
  if (at === -1) return [...rest, ...next];
  return [...rest.slice(0, at), ...next, ...rest.slice(at)];
}

function replaceItem(items: readonly TaskItem[], key: string, change: (item: TaskItem) => TaskItem): readonly TaskItem[] {
  return items.map((item) => (item.key === key ? change(item) : item));
}

/** The reads item of a round, from the cards that belong to it. */
function readsItem(list: TaskList, key: string, items: readonly TaskItem[]): readonly TaskItem[] {
  const ids = Object.keys(list.track.owner).filter((id) => list.track.owner[id] === key);
  const states = ids.map((id) => list.track.calls[id]);
  const state: TaskState = states.includes('running')
    ? 'in_progress'
    : states.includes('pending-approval')
      ? 'waiting'
      : states.length > 0 && states.every((value) => value === 'failed')
        ? 'failed'
        : states.length > 0 && states.every((value) => value === 'cancelled')
          ? 'skipped'
          : 'done';
  const content = ids.length > 1 ? `Read the project (${ids.length} reads)` : 'Read the project';
  const activeForm = ids.length > 1 ? `Reading the project (${ids.length} reads)` : 'Reading the project';
  const contentRef: MessageRef =
    ids.length > 1
      ? {
          id: 'harness.progress.reads.content',
          message: 'Read the project ({count, plural, one {# read} other {# reads}})',
          values: { count: ids.length },
        }
      : { id: 'harness.progress.reads.one.content', message: 'Read the project' };
  const activeFormRef: MessageRef =
    ids.length > 1
      ? {
          id: 'harness.progress.reads.active',
          message: 'Reading the project ({count, plural, one {# read} other {# reads}})',
          values: { count: ids.length },
        }
      : { id: 'harness.progress.reads.one.active', message: 'Reading the project' };
  const exists = items.some((item) => item.key === key);
  const base: TaskItem = { key, content, activeForm, contentRef, activeFormRef, state };
  return exists
    ? replaceItem(items, key, (item) => ({ ...item, content, activeForm, contentRef, activeFormRef, state }))
    : [...items, base];
}

/** What a status card moves its item to. `pending-approval` leaves the item as the plan card put it. */
function cardState(card: StatusCard, item: TaskItem): TaskItem {
  switch (card.status) {
    case 'running':
      return { ...item, state: 'in_progress', callId: card.callId };
    case 'done':
      return { ...item, state: 'done', callId: card.callId };
    case 'failed': {
      const reason = card.error === undefined ? '' : firstSentence(card.error);
      return { ...item, state: 'failed', callId: card.callId, ...(reason === '' ? {} : { reason }) };
    }
    case 'cancelled':
      return { ...item, state: 'skipped', callId: card.callId };
    default:
      return item;
  }
}

function onCard(list: TaskList, card: StatusCard, nameOf?: NameOf): TaskList {
  const calls = { ...list.track.calls, [card.id]: card.status };
  let track: Track = { ...list.track, calls };
  let items = list.items;
  let key = track.owner[card.id];
  if (key === undefined) {
    if (card.status === 'pending-approval') {
      return { ...list, track: { ...track, fresh: [...track.fresh, { id: card.id, tool: card.tool }] } };
    }
    if (READ_CALL.test(card.id)) {
      key = `reads:${track.round}`;
      track = { ...track, owner: { ...track.owner, [card.id]: key } };
    } else {
      // A call with no card before it: a write that needs no approval, or a step refused before any card was shown for it.
      const seq = track.groups + 1;
      key = stepKey(seq, 0);
      track = { ...track, groups: seq, owner: { ...track.owner, [card.id]: key } };
      items = [...items, { key, ...phraseFor(card.tool, card.args, nameOf), state: 'pending', tool: card.tool }];
    }
  }
  const next: TaskList = { ...list, items, track };
  if (key.startsWith('reads:')) return finish({ ...next, items: readsItem(next, key, items) }, card.status === 'running' || card.status === 'done');
  return finish({ ...next, items: replaceItem(items, key, (item) => cardState(card, item)) }, card.status === 'running' || card.status === 'done');
}

function onPlan(list: TaskList, card: PlanCardView, nameOf?: NameOf): TaskList {
  const { track } = list;
  const pending = card.steps.filter((step) => step.status !== 'done');
  const awaitingLine = phraseFor(pending[0]?.tool ?? card.steps[0]?.tool ?? 'agent.plan', pending[0]?.params ?? {}, nameOf);
  const awaiting: Track['awaiting'] = {
    kind: card.kind,
    steps: pending.length,
    content: awaitingLine.content,
    ...(awaitingLine.contentRef === undefined ? {} : { contentRef: awaitingLine.contentRef }),
  };

  if (card.kind === 'confirm') {
    const step = card.steps[0];
    if (step === undefined) return list;
    const candidate = [...track.fresh].reverse().find((entry) => entry.tool === step.tool);
    let items = list.items;
    let next: Track = { ...track, fresh: [], awaiting };
    if (candidate !== undefined && READ_CALL.test(candidate.id)) {
      // A read the document guard held back: it waits on its round's reads item.
      const key = `reads:${track.round}`;
      next = { ...next, owner: { ...next.owner, [candidate.id]: key }, calls: { ...next.calls, [candidate.id]: 'pending-approval' } };
      return finish({ ...list, track: next, items: readsItem({ ...list, track: next }, key, items) }, false);
    }
    let key: string | undefined;
    if (candidate !== undefined) {
      const seq = track.groups + 1;
      key = stepKey(seq, step.origin);
      next = { ...next, groups: seq, owner: { ...next.owner, [candidate.id]: key } };
      items = [...items, itemOfStep(seq, step, undefined, nameOf)];
    } else {
      // A step of the plan that is running, asking on a card of its own (an external write).
      key = [...items].reverse().find((item) => item.tool === step.tool && (item.state === 'pending' || item.state === 'waiting'))?.key;
    }
    if (key === undefined) return finish({ ...list, track: next }, false);
    const target = key;
    return finish({ ...list, track: next, items: replaceItem(items, target, (item) => (step.status === 'refused' ? itemOfStep(Number(groupOf(target)), step, item, nameOf) : { ...item, state: 'waiting' })) }, false);
  }

  const root = track.fresh[0] === undefined ? undefined : (planCallRoot(track.fresh[0].id) ?? track.fresh[0].id);
  const current = track.plan;
  const reshown = current !== null && (root === undefined ? !current.approved : root === current.root);
  const seq = reshown ? current.seq : track.groups + 1;
  const owner: Record<string, string> = { ...track.owner };
  for (const entry of track.fresh) {
    const tail = /\.(\d+)$/.exec(entry.id)?.[1];
    const step = tail === undefined ? undefined : card.steps.find((candidate) => candidate.index === Number(tail));
    if (step !== undefined) owner[entry.id] = stepKey(seq, step.origin);
  }
  const before = list.items.filter((item) => groupOf(item.key) === `${seq}`);
  const shown = card.steps.map((step) => itemOfStep(seq, step, before.find((item) => item.key === stepKey(seq, step.origin)), nameOf));
  // A step the card no longer holds was dropped before it ran.
  const dropped = before.filter((item) => !shown.some((entry) => entry.key === item.key)).map((item): TaskItem => (item.state === 'done' ? item : { ...item, state: 'skipped' }));
  const next: Track = {
    ...track,
    groups: reshown ? track.groups : seq,
    plan: { seq, root: root ?? current?.root ?? '', approved: false },
    fresh: [],
    owner,
    drafting: null,
    awaiting,
  };
  return finish({ ...list, track: next, items: withGroup(list.items, seq, [...shown, ...dropped]) }, false);
}

/** The turn is over: whatever has not run will not. */
function settle(list: TaskList): TaskList {
  const items = list.items.map((item): TaskItem => (item.state === 'pending' || item.state === 'waiting' || item.state === 'in_progress' ? { ...item, state: 'skipped' } : item));
  return finish({ ...list, items, track: { ...list.track, awaiting: null, drafting: null } }, false);
}

function onPhase(list: TaskList, phase: TurnPhase): TaskList {
  let next: TaskList = { ...list, phase };
  if (phase === 'planning') next = { ...next, track: { ...next.track, round: next.track.round + 1, drafting: null } };
  if (phase === 'retrying') next = { ...next, track: { ...next.track, drafting: null } };
  if (phase === 'running') {
    // The writer approved: what waited for a decision now waits its turn.
    const items = next.items.map((item): TaskItem => (item.state === 'waiting' ? { ...item, state: 'pending' } : item));
    const plan = next.track.plan === null ? null : { ...next.track.plan, approved: true };
    next = { ...next, items, track: { ...next.track, plan, awaiting: null, drafting: null } };
  }
  if (isSettled(phase)) return settle(next);
  return finish(next, phase === 'running');
}

/**
 * The normalising pass every fold ends in. The planner row is in progress while the model is being asked and nothing else runs;
 * a running turn always has its next pending item in progress; and no list ever holds two items in progress.
 */
function finish(list: TaskList, promote: boolean): TaskList {
  let items = list.items;
  const running = (item: TaskItem): boolean => item.key !== PLAN_KEY && item.state === 'in_progress';
  if (promote && list.phase === 'running' && !items.some(running)) {
    const next = items.findIndex((item) => item.key !== PLAN_KEY && item.state === 'pending');
    if (next !== -1) items = items.map((item, index) => (index === next ? { ...item, state: 'in_progress' } : item));
  }
  const asking = list.phase === 'planning' || list.phase === 'retrying';
  const contentRef: MessageRef = { id: 'harness.progress.plan.content', message: 'Plan' };
  if (asking && !items.some((item) => item.key === PLAN_KEY)) {
    items = [{ key: PLAN_KEY, content: 'Plan', activeForm: 'Planning', contentRef, state: 'in_progress' }, ...items];
  }
  const busy = items.some(running);
  const activeForm = list.track.drafting !== null ? `Drafting ${quoted(list.track.drafting)}` : list.phase === 'retrying' ? 'Trying again' : 'Planning';
  const activeFormRef: MessageRef =
    list.track.drafting !== null
      ? {
          id: 'harness.progress.plan.drafting',
          message: 'Drafting “{scene}”',
          values: { scene: clipped(list.track.drafting) },
        }
      : list.phase === 'retrying'
        ? { id: 'harness.progress.plan.retrying', message: 'Trying again' }
        : { id: 'harness.progress.plan.active', message: 'Planning' };
  items = items.map((item) =>
    item.key === PLAN_KEY ? { ...item, contentRef, activeForm, activeFormRef, state: asking && !busy ? 'in_progress' : 'done' } : item,
  );
  const last = items.map(running).lastIndexOf(true);
  items = items.map((item, index) => (running(item) && index !== last ? { ...item, state: 'pending' } : item));
  return { ...list, items };
}

/**
 * Folds one event into a turn's task list. An event for another turn returns the list unchanged, as `reduceTurn` does, so a
 * caller may pass every event through every list it holds. Events that change nothing the list shows (a streamed delta) return
 * the list itself.
 */
export function reduceTaskList(list: TaskList, event: AgentEvent, nameOf?: NameOf): TaskList {
  if (event.turnId !== list.turnId) return list;
  switch (event.type) {
    case 'turn':
      return onPhase(list, event.phase);
    case 'model.call':
      return list.modelCalls.used === event.used && list.modelCalls.limit === event.limit
        ? list
        : { ...list, modelCalls: { used: event.used, limit: event.limit } };
    case 'draft.delta': {
      // Only the first delta of a draft names a scene: the rest change nothing the header shows.
      const scene = nameOf === undefined ? event.docTitle : nameOf(event.docTitle);
      return event.start === true && list.track.drafting !== scene ? finish({ ...list, track: { ...list.track, drafting: scene } }, false) : list;
    }
    case 'card':
      return onCard(list, event.card, nameOf);
    case 'plan':
      return onPlan(list, event.card, nameOf);
    case 'report':
      return settle({ ...list, phase: isSettled(list.phase) ? list.phase : event.report.status === 'cancelled' ? 'cancelled' : event.report.status === 'failed' ? 'failed' : 'done' });
    default:
      return list;
  }
}

/** Plural of "step", for the header. */
function stepsOf(count: number): string {
  return counted(count, 'step', 'steps');
}

/**
 * The line the agent header shows: "Step 3 of 5 · Drafting “The Landing”" while an item runs (the planner row is one of the
 * items, as the checklist shows it), "Waiting for you · Plan, 3 steps" while a card waits. `null` when the turn is not running, or has nothing to say yet:
 * the header then keeps its own words. It changes when the active step changes and not when text streams.
 */
export function headerLineOf(list: TaskList): string | null {
  if (list.phase === 'idle' || isSettled(list.phase)) return null;
  const { awaiting } = list.track;
  if (list.phase === 'awaiting-approval' && awaiting !== null) {
    return awaiting.kind === 'plan' ? `Waiting for you · Plan, ${stepsOf(awaiting.steps)}` : `Waiting for you · ${awaiting.content}`;
  }
  const active = list.items.find((item) => item.state === 'in_progress');
  if (active === undefined) return null;
  const steps = list.items.filter((item) => item.state !== 'skipped');
  return `Step ${steps.indexOf(active) + 1} of ${steps.length} · ${active.activeForm}`;
}

// The app renders nested phrases before the frame; headless callers keep the original English values.
export function headerRefOf(list: TaskList, render?: (ref: MessageRef) => string): MessageRef | null {
  if (list.phase === 'idle' || isSettled(list.phase)) return null;
  const { awaiting } = list.track;
  if (list.phase === 'awaiting-approval' && awaiting !== null) {
    return awaiting.kind === 'plan'
      ? {
          id: 'harness.progress.header.waitingPlan',
          message: 'Waiting for you · Plan, {count, plural, one {# step} other {# steps}}',
          values: { count: awaiting.steps },
        }
      : {
          id: 'harness.progress.header.waitingConfirm', message: 'Waiting for you · {content}',
          values: { content: render !== undefined && awaiting.contentRef !== undefined ? render(awaiting.contentRef) : awaiting.content },
        };
  }
  const active = list.items.find((item) => item.state === 'in_progress');
  if (active === undefined) return null;
  const steps = list.items.filter((item) => item.state !== 'skipped');
  return {
    id: 'harness.progress.header.step',
    message: 'Step {step} of {total} · {activeForm}',
    values: { step: steps.indexOf(active) + 1, total: steps.length, activeForm: render !== undefined && active.activeFormRef !== undefined ? render(active.activeFormRef) : active.activeForm },
  };
}

/** How close a turn is to its model-call bound: `limit` at the bound, `near` one call short of it (the last two calls). */
export function budgetLevelOf(modelCalls: TaskList['modelCalls']): 'ok' | 'near' | 'limit' {
  if (modelCalls.used >= modelCalls.limit) return 'limit';
  return modelCalls.used === modelCalls.limit - 1 && modelCalls.limit > 1 ? 'near' : 'ok';
}
