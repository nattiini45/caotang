/**
 * §8's activity row, over every apply the store actually ships.
 *
 * ## What this file is, and where the refusal is
 *
 * An apply reports `{ affected, summary }`, and `execute()` **refuses**
 * a dispatch that reported nothing, so that half of §8 is already enforced at
 * runtime: a store apply that forgot to report cannot return `ok`. That is why
 * this file is not a test of *whether* the applies report — the pipeline's own
 * refusal fails such a test loudly, and `commands.test.ts` would be full of red if
 * one had.
 *
 * What runtime cannot check is the part that actually goes wrong: a row that is
 * *present* and *technically* valid while saying the wrong thing. The three
 * properties asserted here are all invisible to the type checker and to the
 * pipeline's refusal:
 *
 * 1. **§8's "human titles, not bare ids."** The `affectedOf` helper falls back to
 *    the id when an id does not resolve, so a validator that admitted a bad id
 *    would produce a row full of raw ids and still pass every type check. Every
 *    affected title must differ from its own id.
 * 2. **The title is the one the command produced, not the one the node had.**
 *    A rename's row is the interesting case: a title read from the *pre*-apply
 *    snapshot — which is all the bus can reach — would be the title the node used
 *    to have, describing a different command. The bus holds a stale snapshot by
 *    design, so this is the property that proves the title came from the apply.
 * 3. **The affected set is the nodes whose content changed, not the nodes the
 *    request named.** A delete's row is the other end: the removed subtree's
 *    titles cannot be resolved at all after the effect, because the nodes are
 *    gone, so a row that lists them is only possible if the apply captured them
 *    while it still could.
 *
 * ## The registry is the checklist
 *
 * The cases below are typed out — params have to be — and the **coverage
 * assertion is the guard**: every name in `createProjectCommandRegistry()` must
 * appear here exactly once. A new apply therefore cannot be added without deciding
 * what its row says, and cannot be added by forgetting, which is the whole failure
 * mode this file exists to close. That is the same shape as the permission matrix guard,
 * which takes its names from the registry instead of listing them.
 */

import { describe, expect, it } from 'vitest';
import {
  createActivityLog,
  createIdempotencyCache,
  createUndoStore,
  createViewState,
  execute,
  type ActivityEntry,
  type ActivityLog,
  type BusContext,
  type Command,
  type CommandName,
  type ExecutionOutcome,
  type UndoStore,
} from '@caotang/bus';

import {
  addDocument,
  addFolder,
  createEmptyManifest,
  createProjectCommandRegistry,
  createProjectState,
  emptyCoherenceState,
  type CoherenceState,
  type ProjectState,
} from '../src/index.js';

const OPENED = new Date('2026-10-02T15:00:00.000Z');
const CHAPTER_ONE = 'n_CHAPTERONE0';
const CHAPTER_TWO = 'n_CHAPTERTWO0';
const LANDING = 'n_LANDING00000';
const STORM = 'n_STORM000000';
const OTHER = 'n_OTHER000000';
const ENTRY = 'c_ELENA000000';
const CELLAR = 'n_CELLAR000000';

const TICK = 1_760_000_000_000;
const clock = { now: () => TICK };

interface Harness {
  readonly bus: BusContext<ProjectState>;
  readonly log: ActivityLog;
  readonly notified: ExecutionOutcome[];
  run(command: Command): ExecutionOutcome;
  /** The single row the command wrote. */
  row(name: CommandName): ActivityEntry;
}

function harnessOver(state: ProjectState): Harness {
  const registry = createProjectCommandRegistry({ clock });
  const notified: ExecutionOutcome[] = [];
  const undo: UndoStore = createUndoStore({
    dispatch: (command) => execute(command, bus, registry),
  });
  const log = createActivityLog();
  const bus: BusContext<ProjectState> = {
    state,
    view: createViewState(),
    read: () => state,
    undo,
    log,
    idempotency: createIdempotencyCache(),
    notify: (outcome) => notified.push(outcome),
  };
  return {
    bus,
    log,
    notified,
    run(command) {
      const result = execute(command, bus, registry);
      if (!result.ok) throw new Error(`${command.name} was refused: ${result.error.message}`);
      return result.value;
    },
    row(name) {
      const rows = log.entries().filter((entry) => entry.command === name);
      if (rows.length !== 1) throw new Error(`expected exactly one ${name} row, found ${rows.length}`);
      return rows[0]!;
    },
  };
}

let ordinal = 0;
function cmd(name: CommandName, params: Record<string, unknown>): Command {
  ordinal += 1;
  return {
    id: `cmd_B19TEST${String(ordinal).padStart(4, '0')}`,
    name,
    params,
    issuedBy: 'user',
    createdAt: TICK - 1_000,
  };
}

interface Case {
  readonly name: CommandName;
  readonly params: Record<string, unknown>;
  /**
   * The affected titles, sorted by the test. **Titles, not ids**, because the
   * title is §8's requirement and the id is the mechanical half; a `binder.create`
   * mints an id no table could know.
   */
  readonly titles: readonly string[];
  /** The affected ids, when the table can know them. */
  readonly ids?: readonly string[];
  /** A phrase the digest must contain, so a digest cannot regress to a restatement of the name. */
  readonly digestMentions: string;
  /** The case needs a coherence file in the state: the coherence applies change one. */
  readonly coherence?: boolean;
  /** The case needs a dialogue container in the state: the settings command names one. */
  readonly dialogue?: boolean;
  /** The case needs a skill in the state: the skill commands name one. */
  readonly skill?: boolean;
  /** The case needs a memory note in the state: the memory commands name one. */
  readonly memory?: boolean;
}

/** The finding the coherence cases act on: one open finding that quotes the storm scene. */
const FINDING_ID = 'f_AAAAAAAAAA';

/** The run the discard case removes. The finding above was made by it and nobody touched it, so the discard takes it too. */
const RUN_ID = 'r_AAAAAAAAAA';

/** The knowledge fact the knowledge cases act on, with one scene that learns it, so the removal has a declaration to take. */
const FACT_ID = 'k_AAAAAAAAAA';
const CHARACTER_ID = 'c_AAAAAAAAAA';

function coherenceWithFinding(): CoherenceState {
  const file = emptyCoherenceState();
  file.runs.push({
    id: RUN_ID,
    at: '2026-10-01T00:00:00.000Z',
    kind: 'deterministic',
    checkIds: [],
    scope: { docIds: [STORM] },
    findingsUpserted: [FINDING_ID],
    status: 'complete',
  });
  file.knowledge.push({ id: FACT_ID, text: 'Mara is the heir', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' });
  file.sceneMeta[STORM] = { learns: [{ entryId: CHARACTER_ID, factId: FACT_ID }] };
  file.findings.push({
    id: FINDING_ID,
    status: 'open',
    updatedAt: '2026-10-01T00:00:00.000Z',
    createdByRunId: RUN_ID,
    evidence: [{ docId: STORM }],
  });
  return file;
}

const CASES: readonly Case[] = [
  {
    name: 'binder.create',
    params: { parentId: CHAPTER_ONE, type: 'document', title: 'Scene 3' },
    titles: ['Scene 3'],
    digestMentions: 'Scene 3',
  },
  {
    name: 'binder.move',
    params: { nodeId: STORM, newParentId: CHAPTER_TWO, index: 0 },
    titles: ['The Storm'],
    ids: [STORM],
    digestMentions: 'Chapter 2',
  },
  {
    // The post-apply title. A row naming "The Letter" would describe the tree as it
    // was before this command, and would still satisfy every type check.
    name: 'binder.rename',
    params: { nodeId: OTHER, title: 'The Letter (revised)' },
    titles: ['The Letter (revised)'],
    ids: [OTHER],
    digestMentions: 'renamed',
  },
  {
    name: 'binder.setSynopsis',
    params: { nodeId: STORM, synopsis: 'The storm arrives.' },
    titles: ['The Storm'],
    ids: [STORM],
    digestMentions: 'synopsis',
  },
  {
    name: 'binder.setMeta',
    params: { nodeId: LANDING, patch: { keywords_add: ['kestrel'] } },
    titles: ['The Landing'],
    ids: [LANDING],
    digestMentions: 'keyword',
  },
  {
    // coherence.md §7.1: the scene's declarations change, and the row names the scene it changed.
    name: 'coherence.setSceneMeta',
    params: { docId: STORM, patch: { dayOffset: 3 } },
    titles: ['The Storm'],
    ids: [STORM],
    // The declaration is named in words (day), not by its patch key (dayOffset).
    digestMentions: 'set day',
    coherence: true,
  },
  {
    // A finding moves to dismissed, and the row names the scene the finding quotes.
    name: 'coherence.setFindingStatus',
    params: { findingId: FINDING_ID, status: 'dismissed', reason: 'false-positive' },
    titles: ['The Storm'],
    ids: [STORM],
    digestMentions: 'dismissed',
    coherence: true,
  },
  {
    // coherence.md §7.1, §8: a run leaves the history with the untouched findings it made. The findings name no
    // scene in the row, because the run is a set of derived state rather than a change to one document.
    name: 'coherence.discardRun',
    params: { runId: RUN_ID },
    titles: [],
    ids: [],
    // The run is named by its kind and scope in words, never by its id (coherence.md §8).
    digestMentions: 'discarded a scan of 1 document',
    coherence: true,
  },
  {
    // coherence.md §4.4, §7.1: a knowledge fact is added, changed and removed, and the row names it by its words, never its id.
    name: 'coherence.addKnowledgeFact',
    params: { text: 'The map is a forgery' },
    titles: [],
    ids: [],
    digestMentions: 'added the knowledge fact “The map is a forgery”',
    coherence: true,
  },
  {
    name: 'coherence.editKnowledgeFact',
    params: { factId: FACT_ID, text: 'Mara is the rightful heir' },
    titles: [],
    ids: [],
    digestMentions: 'changed the knowledge fact “Mara is the rightful heir”',
    coherence: true,
  },
  {
    name: 'coherence.removeKnowledgeFact',
    params: { factId: FACT_ID },
    titles: [],
    ids: [],
    digestMentions: 'removed the knowledge fact “Mara is the heir” and 1 declaration of who learns or knows it',
    coherence: true,
  },
  {
    name: 'notes.set',
    params: { nodeId: STORM, notes: 'Rain all night.' },
    titles: ['The Storm'],
    ids: [STORM],
    digestMentions: 'notes',
  },
  {
    name: 'notes.append',
    params: { nodeId: STORM, text: 'The lighthouse holds.' },
    titles: ['The Storm'],
    ids: [STORM],
    digestMentions: 'notes',
  },
  {
    name: 'doc.write',
    params: { docId: STORM, body: 'The wind came off the water.' },
    titles: ['The Storm'],
    ids: [STORM],
    digestMentions: 'body',
  },
  {
    name: 'editor.insert',
    params: { docId: STORM, offset: 0, text: 'First. ' },
    titles: ['The Storm'],
    ids: [STORM],
    digestMentions: 'offset 0',
  },
  {
    name: 'editor.replaceRange',
    params: { docId: STORM, range: { from: 0, to: 8 }, text: 'The gale' },
    titles: ['The Storm'],
    ids: [STORM],
    digestMentions: 'characters 0-8',
  },
  {
    // The batch: affected is the nodes this batch attached to, and a `create` with
    // no `attachTo` changes no node at all. The other half of that — the empty
    // case — is the second codex.upsert below, because the two are the same claim.
    name: 'codex.upsert',
    params: {
      entries: [
        {
          action: 'create',
          name: 'Marta',
          type: 'character',
          description: 'The keeper who came before.',
          attachTo: [STORM],
        },
      ],
    },
    titles: ['The Storm'],
    ids: [STORM],
    digestMentions: 'created 1',
  },
  {
    name: 'codex.attach',
    params: { entryId: ENTRY, attachTo: [LANDING], detachFrom: [] },
    titles: ['The Landing'],
    ids: [LANDING],
    digestMentions: 'Elena',
  },
  {
    // The pre-delete titles. None of these three nodes resolves after the effect,
    // so a row listing them is only possible from a capture taken while they
    // existed — and the subtree is listed whole, not just the node named.
    name: 'project.deleteNode',
    params: { nodeId: CHAPTER_ONE },
    titles: ['Chapter 1', 'The Landing', 'The Storm'],
    digestMentions: 'Chapter 1',
  },
  // The three view events. They carry the store's registry because the bus's own
  // registry is what `createProjectCommandRegistry()` spreads, and they are here
  // rather than in the bus suite for the reason that matters: **`affected: []` for
  // all three is a claim, and a claim with no test is a comment the next slice
  // rewrites.** Each of them names a node — `view.setScroll`'s `nodeId` especially
  // — so "a view event affects no node" is exactly the kind of statement that
  // decays into a bare id in a field §8 says must hold a human title.
  {
    name: 'view.setSelection',
    params: { nodeIds: [STORM] },
    titles: [],
    digestMentions: 'selected 1 node',
  },
  {
    name: 'view.setActiveDoc',
    params: { docId: STORM },
    titles: [],
    digestMentions: 'active document',
  },
  {
    name: 'view.setScroll',
    params: { nodeId: STORM, offset: 320 },
    titles: [],
    digestMentions: 'offset 320',
  },
  // The two binder-and-corkboard view events, held to the same claim: they name
  // a node and affect none.
  {
    name: 'view.setExpanded',
    params: { nodeId: STORM, expanded: true },
    titles: [],
    digestMentions: 'expanded a folder',
  },
  {
    name: 'view.setCorkboardScope',
    params: { nodeId: STORM },
    titles: [],
    digestMentions: 'showed a container on the corkboard',
  },
  // Project export: the six applies that need no injected port. Each reports the row §8 asks for. The seventh,
  // `project.importAsset`, is implemented only with the asset port, and its row is asserted in commands-project.test.ts.
  {
    name: 'project.rename',
    params: { title: 'The Lantern Keeper' },
    titles: ['The Lantern Keeper'],
    ids: ['root'],
    digestMentions: 'renamed the project',
  },
  {
    name: 'project.setMetadata',
    params: { patch: { author: 'Ada Writer' } },
    titles: ['The Lighthouse Keeper'],
    ids: ['root'],
    digestMentions: "changed the project's author",
  },
  {
    name: 'vocabulary.upsert',
    params: { kind: 'label', name: 'Act 1', color: '#d9a44a' },
    titles: [],
    digestMentions: 'added the label "Act 1"',
  },
  {
    name: 'vocabulary.remove',
    params: { kind: 'status', id: 'final' },
    titles: [],
    digestMentions: 'removed the status "Final"',
  },
  {
    name: 'recipe.save',
    params: { name: 'Beta read', includeRootIds: ['manuscript'], format: 'md' },
    titles: [],
    digestMentions: 'saved the recipe "Beta read"',
  },
  {
    name: 'recipe.delete',
    params: { name: 'Manuscript' },
    titles: [],
    digestMentions: 'deleted the recipe "Manuscript"',
  },
  // The saved-filter and goal commands (binder-filters §5, goals-progress §4). Each names a list, not a node, so the row
  // has no affected entries; the two deletes act on the filter and the goal the fixture seeds.
  {
    name: 'binder.saveFilter',
    params: { filter: { name: 'Sea drafts', criteria: { keywordsAny: ['sea'] } } },
    titles: [],
    digestMentions: 'saved the filter "Sea drafts"',
  },
  {
    name: 'binder.deleteFilter',
    params: { filterId: 'q_FIXTURE001' },
    titles: [],
    digestMentions: 'deleted the saved filter "Drafts"',
  },
  {
    name: 'project.saveGoal',
    params: { goal: { nodeId: CHAPTER_ONE, comparator: 'at-least', target: 800 } },
    titles: [],
    digestMentions: 'set a goal for "Chapter 1"',
  },
  {
    name: 'project.deleteGoal',
    params: { goalId: 'g_FIXTURE001' },
    titles: [],
    digestMentions: 'removed the goal for "Chapter 1"',
  },
  {
    name: 'screenplay.import',
    params: { format: 'fountain', text: 'INT. HOUSE - DAY\n\nAlice waves.\n', parentId: CHAPTER_ONE },
    titles: ['INT. HOUSE - DAY'],
    digestMentions: 'imported a Fountain script: 1 scene and 0 sections',
  },
  {
    name: 'dialogue.importInk',
    params: { containers: [{ title: 'Greeting', body: '=== Greeting ===\nHello.\n-> END\n' }], parentId: CHAPTER_TWO },
    titles: ['Greeting'],
    digestMentions: 'imported 1 dialogue container from an Ink story',
  },
  // The skill commands report no node: a skill is not in the binder. Their digests name the skill.
  { name: 'skill.write', params: { name: 'close-third', path: 'references/voice.md', text: 'Stay close.' }, titles: [], digestMentions: 'added references/voice.md in the skill “close-third”', skill: true },
  { name: 'skill.delete', params: { name: 'close-third' }, titles: [], digestMentions: 'deleted the skill “close-third”', skill: true },
  { name: 'skill.setEnabled', params: { name: 'close-third', enabled: false }, titles: [], digestMentions: 'turned the skill “close-third” off', skill: true },
  // The agent's files report no node: CAOTANG.md and the memory notes are not in the binder. Their digests name the file or the note.
  { name: 'project.setInstructions', params: { text: 'British spelling.' }, titles: [], digestMentions: 'created CAOTANG.md' },
  { name: 'memory.write', params: { slug: 'style-dialogue', type: 'style', title: 'Dialogue tags', body: 'Use said.' }, titles: [], digestMentions: 'saved the memory note “Dialogue tags”' },
  { name: 'memory.forget', params: { slug: 'style-dialogue' }, titles: [], digestMentions: 'forgot the memory note “Dialogue tags”', memory: true },
  {
    name: 'dialogue.setMeta',
    params: { nodeId: CELLAR, patch: { autoLineIds: true } },
    titles: ['The Cellar'],
    digestMentions: 'changed the dialogue settings of "The Cellar"',
    dialogue: true,
  },
];

describe('§8 — the activity row for every shipped store apply', () => {
  it('covers the registry exactly: a new apply cannot be added without a row to assert', () => {
    const registry = createProjectCommandRegistry({ clock });
    // The checklist is over the names that **carry an apply**, not over every name.
    // The store registry is the bus's own plus the thirteen project applies, so the
    // two ways to be wrong are separate: a name with an apply and no case (a new
    // command, unasserted — the defect this file is about), and a name with a case and no
    // apply (a case asserting something that cannot run).
    const implemented = Object.entries(registry)
      .filter(([, entry]) => typeof entry.apply === 'function')
      .map(([name]) => name)
      .sort();
    const withoutApply = Object.entries(registry)
      .filter(([, entry]) => typeof entry.apply !== 'function')
      .map(([name]) => name)
      .sort();

    const covered = CASES.map((c) => c.name).sort();
    expect(covered).toEqual(implemented);
    expect(new Set(covered).size).toBe(covered.length);

    // The unimplemented names are the exporter pair, and naming them here is what stops this list from quietly
    // becoming shorter: if the exporter landed, this assertion fails and demands a row for it. There are also
    // four names that register only when their injected half is supplied (`mcp.invoke` and `mcp.readResource`, extensibility §6, and the
    // storyboard module's three shot commands), so with nothing injected they are unimplemented too, and the
    // rows they write are asserted in their own test files (mcp-invoke-injection, shot-commands).
    // `project.importAsset` registers only with the asset port injected (commands-project.ts), so it is
    // unimplemented here for the same reason `mcp.invoke` is. Its row is asserted with the port in its own test file.
    // `shot.importImage` registers only with both the asset port and the storyboard port, so it
    // is unimplemented here too. Its row is asserted with both ports in `commands-shot-image.test.ts`.
    expect(withoutApply).toEqual([
      'export.compile',
      'export.compileSelection',
      'mcp.invoke',
      'mcp.readResource',
      'project.importAsset',
      'shot.create',
      'shot.importImage',
      'shot.importImages',
      'shot.setMeta',
      'skill.import',
      'storyboard.create',
    ]);
  });

  for (const testCase of CASES) {
    it(`${testCase.name} writes §8's row, with human titles and a digest that says what changed`, () => {
      const state = fixture();
      if (testCase.coherence === true) state.coherence = coherenceWithFinding();
      if (testCase.skill === true) state.skills.set('close-third', [{ path: 'SKILL.md', bytes: new TextEncoder().encode(['---', 'name: close-third', 'description: d', '---', 'Body', ''].join('\n')) }]);
      if (testCase.memory === true) state.agentFiles = { memory: [{ slug: 'style-dialogue', type: 'style', title: 'Dialogue tags', body: 'Use said.', modified: '', origin: 'writer' }], declined: new Map(), unreadable: [] };
      if (testCase.dialogue === true) {
        addDocument(state, { parentId: 'manuscript', title: 'The Cellar', type: 'dialogue', kind: 'branching', body: '=== Cellar ===\nHello.\n-> END\n', now: OPENED, id: CELLAR });
      }
      const h = harnessOver(state);
      h.run(cmd(testCase.name, testCase.params));

      const row = h.row(testCase.name);

      // §8: the digest exists and is a sentence about the change, not the name.
      expect(row.summary).toContain(testCase.digestMentions);
      expect(row.summary).not.toBe(testCase.name);

      // §8: "human titles, not bare ids" — the property `affectedOf`'s fallback
      // exists to make visible, and the one the type checker cannot see.
      expect(row.affected.map((a) => a.title).sort()).toEqual([...testCase.titles].sort());
      for (const affected of row.affected) {
        expect(affected.title).not.toBe(affected.nodeId);
      }
      if (testCase.ids !== undefined) {
        expect(row.affected.map((a) => a.nodeId).sort()).toEqual([...testCase.ids].sort());
      }

      // §3: the same declaration, both consumers. `toBe` and not `toEqual` —
      // the pipeline hands out one array, and a second assembly is the drift.
      expect(h.notified.at(-1)?.affected).toBe(row.affected);
    });
  }
  it('a codex.upsert that attaches nothing reports no affected node, and says so in the digest', () => {
    const h = harnessOver(fixture());
    h.run(
      cmd('codex.upsert', {
        entries: [{ action: 'create', name: 'Marta', type: 'character', description: 'The keeper.' }],
      }),
    );
    // The empty list is a real answer: an unattached codex entry changes no node's
    // rendered content, so §3 has nothing for a subscriber to re-render. What it
    // must NOT do is list the entry's own (absent) attachments or the nodes the
    // batch happened to touch.
    expect(h.row('codex.upsert').affected).toEqual([]);
  });

  it('a setMeta whose keywords were all already present says unchanged rather than claiming an addition', () => {
    const h = harnessOver(fixture());
    // 'sea' is on the fixture node already, so this command writes nothing.
    h.run(cmd('binder.setMeta', { nodeId: LANDING, patch: { keywords_add: ['sea'] } }));
    const row = h.row('binder.setMeta');
    // The reachable-empty branch: §9 admits this command, and a digest built from
    // the keys it was handed would claim a keyword was added. The wording is the
    // whole digest and not a part of it — the empty branch names no field,
    // because a patch can change nothing in any of them and "the keywords"
    // would be a claim about a field the patch never mentioned.
    expect(row.summary).toBe('left "The Landing" unchanged');
    expect(row.affected.map((a) => a.title)).toEqual(['The Landing']);
  });

  it('codex.attach reports the delta, not the request: a re-attach lists no node', () => {
    const h = harnessOver(fixture());
    h.run(cmd('codex.attach', { entryId: ENTRY, attachTo: [LANDING], detachFrom: [] }));
    // The same command again: the id is already attached, so nothing changed and
    // §3 has nothing to re-render. The entry's attachment list is unchanged, and
    // listing it would tell every subscriber to re-render a node that looks the
    // same — the "the delta, not the request" rule, asserted where it bites.
    h.run(cmd('codex.attach', { entryId: ENTRY, attachTo: [LANDING], detachFrom: [] }));
    const rows = h.log.entries().filter((entry) => entry.command === 'codex.attach');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.affected.map((a) => a.nodeId)).toEqual([LANDING]);
    expect(rows[1]!.affected).toEqual([]);
    expect(rows[1]!.summary).toContain('as it was');
  });

  it('every row carries source: native, and none carries a tokensSpent', () => {
    const h = harnessOver(fixture());
    h.run(cmd('notes.set', { nodeId: STORM, notes: 'Rain all night.' }));
    const row = h.row('notes.set');
    // §8 reserves 'mcp' for the v0.2 client and says "default 'native'". Stamped,
    // so a reader never infers it from the absence of a tag.
    expect(row.source).toBe('native');
    // The cost is the gateway's to measure, so a 0 here would be a measurement
    // nobody took.
    expect(row.tokensSpent).toBeUndefined();
  });

  it('a refused command writes no row at all', () => {
    const h = harnessOver(fixture());
    // `binder.setSynopsis` caps at 2000 chars, so this is refused at `validate` —
    // before the effect, and before any apply could have reported.
    const result = execute(
      cmd('binder.setSynopsis', { nodeId: STORM, synopsis: 'x'.repeat(2001) }),
      h.bus,
      createProjectCommandRegistry({ clock }),
    );
    expect(result.ok).toBe(false);
    // §8's "one entry per *executed* command": a row means the bus did something.
    expect(h.log.length).toBe(0);
  });
});

/** The fixture, in miniature: a tree with real titles and a codex entry. */
function fixture(): ProjectState {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', OPENED));
  // One saved filter and one goal, so the two delete cases have a record to remove.
  state.manifest.filters = [
    { id: 'q_FIXTURE001', name: 'Drafts', criteria: { statusId: 'draft' }, createdAt: OPENED.toISOString(), updatedAt: OPENED.toISOString() },
  ];
  state.manifest.goals = [
    { id: 'g_FIXTURE001', nodeId: CHAPTER_ONE, metric: 'words', comparator: 'at-least', target: 500, createdAt: OPENED.toISOString(), updatedAt: OPENED.toISOString() },
  ];
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 1', now: OPENED, id: CHAPTER_ONE });
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 2', now: OPENED, id: CHAPTER_TWO });
  addDocument(state, {
    parentId: CHAPTER_ONE,
    title: 'The Landing',
    body: 'The ferry was late, as always.',
    now: OPENED,
    id: LANDING,
    keywords: ['sea', 'grief'],
  });
  addDocument(state, {
    parentId: CHAPTER_ONE,
    title: 'The Storm',
    // A body, because `editor.replaceRange` validates `range.to` against the body
    // length and an empty one makes a range unnameable.
    body: 'The gale arrived at dawn.',
    now: OPENED,
    id: STORM,
  });
  addDocument(state, { parentId: CHAPTER_TWO, title: 'The Letter', now: OPENED, id: OTHER });
  state.manifest.codex?.push({
    id: ENTRY,
    name: 'Elena',
    aliases: [],
    type: 'character',
    description: 'The keeper.',
    includePolicy: 'detected',
    caseSensitive: false,
    exclude: [],
    attachments: [],
    keywords: [],
    origin: 'manual',
    sources: [],
  });
  return state;
}
