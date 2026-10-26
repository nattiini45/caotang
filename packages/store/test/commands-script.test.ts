/**
 * The script and dialogue commands end to end — screenplay.md §2.2, dialogue-narrative.md §2.1 and §4.
 *
 * Each test dispatches a real command through the shipped `execute()` over the store's state with the shipped undo store,
 * so the assertions are what the manifest and the body records hold afterwards, and whether one `undo()` put them back.
 */
import { describe, expect, it } from 'vitest';
import { newId } from '@caotang/ids';
import {
  createActivityLog,
  createIdempotencyCache,
  createUndoStore,
  createViewState,
  execute,
  type BusContext,
  type CommandName,
  type CommandRegistry,
  type ExecutionOutcome,
  type UndoStore,
} from '@caotang/bus';

import {
  MemoryArtifactFs,
  addDocument,
  addFolder,
  createEmptyManifest,
  createProjectCommandRegistry,
  createProjectState,
  getBody,
  nodeById,
  readProject,
  writeProject,
  type ProjectState,
  type TreeNode,
} from '../src/index.js';
import { IMPORTED_DIALOGUE_CHAPTER, IMPORTED_SCENES_CHAPTER } from '../src/commands-script.js';

const OPENED = new Date('2026-10-02T15:00:00.000Z');
const LATER_MS = Date.parse('2026-10-08T09:00:00.000Z');
const LATER = new Date(LATER_MS).toISOString();
// Ids are "n_" or "c_" and ten Crockford base32 characters, which leave out I, L, O and U (project-format.md §2): the
// reload in the round-trip test validates them, so the fixtures have to pass that check.
const CHAPTER = 'n_CHAPTER001';
const ALICE = 'c_ANNA000001';

/** A two-act script: a section with a synopsis, a sequence inside it, and scenes under each. */
const SCRIPT = [
  '# Act One',
  '= The setup',
  '## Sequence A',
  'INT. HOUSE - DAY',
  '',
  'Alice waves.',
  '',
  'EXT. STREET - NIGHT',
  '= Rain',
  '',
  'Rain falls.',
  '',
  '# Act Two',
  '',
  'INT. CELLAR - NIGHT',
  '',
  'Cold.',
  '',
].join('\n');

const FDX = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<FinalDraft DocumentType="Script" Template="No" Version="5">',
  '  <Content>',
  '    <Paragraph Type="Scene Heading"><Text>INT. HOUSE - DAY</Text></Paragraph>',
  '    <Paragraph Type="Action"><Text>Alice waves.</Text></Paragraph>',
  '  </Content>',
  '</FinalDraft>',
].join('\n');

interface Harness {
  readonly state: ProjectState;
  readonly bus: BusContext<ProjectState>;
  readonly registry: CommandRegistry;
  readonly undo: UndoStore;
}

function makeState(): ProjectState {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', OPENED));
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 1', now: OPENED, id: CHAPTER });
  addDocument(state, { parentId: CHAPTER, title: 'The Landing', body: 'The ferry was late.', now: OPENED, id: 'n_SCENE00001' });
  state.manifest.codex = [
    {
      id: ALICE,
      name: 'Alice',
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
      createdAt: OPENED.toISOString(),
      updatedAt: OPENED.toISOString(),
    },
  ];
  return state;
}

function harness(): Harness {
  const state = makeState();
  const registry = createProjectCommandRegistry({ clock: { now: () => LATER_MS } });
  const undo = createUndoStore({ dispatch: (command) => execute(command, bus, registry) });
  const bus: BusContext<ProjectState> = {
    state,
    view: createViewState(),
    read: () => state,
    undo,
    log: createActivityLog(),
    idempotency: createIdempotencyCache(),
    notify: () => {},
  };
  return { state, bus, registry, undo };
}

function send(h: Harness, name: CommandName, params: Record<string, unknown>) {
  return execute({ id: newId('cmd'), name, params, issuedBy: 'user', createdAt: LATER_MS }, h.bus, h.registry);
}

function succeed(h: Harness, name: CommandName, params: Record<string, unknown>): ExecutionOutcome {
  const result = send(h, name, params);
  if (!result.ok) throw new Error(`${name} was refused: ${result.error.message}`);
  return result.value;
}

function undoGroup(h: Harness, outcome: ExecutionOutcome): void {
  if (outcome.undoGroupId === undefined) throw new Error('the command registered no undo group');
  const undone = h.undo.undo(outcome.undoGroupId);
  if (!undone.ok) throw new Error(`undo refused: ${undone.error.message}`);
  expect(undone.value.failures).toEqual([]);
}

function byTitle(state: ProjectState, title: string): TreeNode {
  const node = state.manifest.tree.find((n) => n.title === title);
  if (node === undefined) throw new Error(`no node titled "${title}"`);
  return node;
}

/** The parts of a state an undo must return: the tree, the body records and the derived counts. */
function snapshotOf(state: ProjectState): string {
  return JSON.stringify({
    tree: state.manifest.tree,
    documents: [...state.documents.values()],
    wordCounts: state.manifest.derived.wordCounts,
    computedAt: state.manifest.derived.computedAt,
  });
}

describe('screenplay.import', () => {
  it('maps sections to nested folders and scenes to screenplay documents, with bodies and synopses', () => {
    const h = harness();
    const outcome = succeed(h, 'screenplay.import', { format: 'fountain', text: SCRIPT });
    const result = outcome.result as { scenes: number; folders: number; notices: string[] };
    expect(result.scenes).toBe(3);
    expect(result.folders).toBe(3);

    const actOne = byTitle(h.state, 'Act One');
    const sequence = byTitle(h.state, 'Sequence A');
    const actTwo = byTitle(h.state, 'Act Two');
    expect(actOne).toMatchObject({ type: 'folder', parentId: 'manuscript', synopsis: 'The setup', createdAt: LATER });
    expect(sequence.parentId).toBe(actOne.id);
    expect(actTwo.parentId).toBe('manuscript');

    const house = byTitle(h.state, 'INT. HOUSE - DAY');
    expect(house).toMatchObject({ type: 'document', kind: 'screenplay', parentId: sequence.id, synopsis: '' });
    expect(getBody(h.state, house.id)).toBe('INT. HOUSE - DAY\n\nAlice waves.');

    const street = byTitle(h.state, 'EXT. STREET - NIGHT');
    expect(street).toMatchObject({ kind: 'screenplay', parentId: sequence.id, synopsis: 'Rain' });
    expect(getBody(h.state, street.id)).not.toContain('= Rain');

    const cellar = byTitle(h.state, 'INT. CELLAR - NIGHT');
    expect(cellar.parentId).toBe(actTwo.id);
  });

  it('nests a section under the nearest shallower section above it, so a skipped level does not misnest', () => {
    const h = harness();
    // Two sections at depth two with no depth one above them: both are children of the import's parent, and the second is
    // not a child of the first. Each scene sits under the section it follows.
    succeed(h, 'screenplay.import', {
      format: 'fountain',
      text: ['## Sequence A', '', 'INT. HOUSE - DAY', '', 'Alice waves.', '', '## Sequence B', '', 'EXT. STREET - NIGHT', '', 'Rain falls.', ''].join('\n'),
      parentId: CHAPTER,
    });
    expect(byTitle(h.state, 'Sequence A').parentId).toBe(CHAPTER);
    expect(byTitle(h.state, 'Sequence B').parentId).toBe(CHAPTER);
    expect(byTitle(h.state, 'INT. HOUSE - DAY').parentId).toBe(byTitle(h.state, 'Sequence A').id);
    expect(byTitle(h.state, 'EXT. STREET - NIGHT').parentId).toBe(byTitle(h.state, 'Sequence B').id);
  });

  it('a depth-three section under an act is a child of the act, and so is the section beside it', () => {
    const h = harness();
    // The depth-two level is skipped, so each beat must take the act as its parent, not the beat before it.
    succeed(h, 'screenplay.import', {
      format: 'fountain',
      text: ['# Act One', '', '### Beat X', '', 'INT. HOUSE - DAY', '', 'Alice waves.', '', '### Beat Y', '', 'EXT. STREET - NIGHT', '', 'Rain falls.', ''].join('\n'),
      parentId: CHAPTER,
    });
    const act = byTitle(h.state, 'Act One');
    expect(act.parentId).toBe(CHAPTER);
    expect(byTitle(h.state, 'Beat X').parentId).toBe(act.id);
    expect(byTitle(h.state, 'Beat Y').parentId).toBe(act.id);
    expect(byTitle(h.state, 'EXT. STREET - NIGHT').parentId).toBe(byTitle(h.state, 'Beat Y').id);
  });

  it('is one undo group: one undo removes every node it made and leaves the state as it was', () => {
    const h = harness();
    const before = snapshotOf(h.state);
    const outcome = succeed(h, 'screenplay.import', { format: 'fountain', text: SCRIPT, parentId: CHAPTER });
    expect(h.state.manifest.tree.length).toBeGreaterThan(4);
    undoGroup(h, outcome);
    expect(snapshotOf(h.state)).toBe(before);
  });

  it('reads FDX as well, into the same shape', () => {
    const h = harness();
    succeed(h, 'screenplay.import', { format: 'fdx', text: FDX, parentId: CHAPTER });
    const house = byTitle(h.state, 'INT. HOUSE - DAY');
    expect(house).toMatchObject({ kind: 'screenplay', parentId: CHAPTER });
    expect(getBody(h.state, house.id)).toContain('INT. HOUSE - DAY');
  });

  it('keeps the scene number of an FDX heading in the scene, and reads its title page', () => {
    const h = harness();
    const xml = [
      '<FinalDraft DocumentType="Script">',
      '  <TitlePage><Content><Paragraph><Text>Title: The Lighthouse</Text></Paragraph></Content></TitlePage>',
      '  <Content>',
      '    <Paragraph Type="Scene Heading" Number="2A"><Text>INT. HOUSE - DAY</Text></Paragraph>',
      '    <Paragraph Type="Action"><Text>Alice waves.</Text></Paragraph>',
      '  </Content>',
      '</FinalDraft>',
    ].join('\n');
    const outcome = succeed(h, 'screenplay.import', { format: 'fdx', text: xml, parentId: CHAPTER });
    const house = byTitle(h.state, 'INT. HOUSE - DAY');
    expect(getBody(h.state, house.id).startsWith('INT. HOUSE - DAY #2A#')).toBe(true);
    expect(JSON.stringify(outcome)).toContain('The title page was read but not stored');
  });

  it('refuses a file with nothing to import, and leaves the state untouched', () => {
    const h = harness();
    const before = snapshotOf(h.state);
    const result = send(h, 'screenplay.import', { format: 'fountain', text: 'Title: The Lighthouse\n' });
    expect(result.ok).toBe(false);
    expect(snapshotOf(h.state)).toBe(before);
  });

  it('is saved under the kind\'s own file names, and loads back with the same bodies and kinds', async () => {
    const h = harness();
    succeed(h, 'screenplay.import', { format: 'fountain', text: SCRIPT, parentId: CHAPTER });
    const fs = new MemoryArtifactFs();
    await writeProject(fs, h.state, { now: new Date(LATER_MS) });
    const house = byTitle(h.state, 'INT. HOUSE - DAY');
    expect(await fs.exists(`docs/${house.id}.fountain`)).toBe(true);
    expect(await fs.exists(`docs/${house.id}.md`)).toBe(false);

    const loaded = await readProject(fs, { now: new Date(LATER_MS) });
    const back = byTitle(loaded.state, 'INT. HOUSE - DAY');
    expect(back).toMatchObject({ kind: 'screenplay', synopsis: '' });
    expect(getBody(loaded.state, back.id)).toBe(getBody(h.state, house.id));
  });

  // The chapter rule: a scene the file puts before any section, imported into the
  // manuscript, goes into one chapter the import makes, not directly under the manuscript. The undo takes that chapter too.
  it('puts the scenes before the first section into an "Imported scenes" chapter when it imports into the manuscript', () => {
    const h = harness();
    const before = snapshotOf(h.state);
    const text = ['INT. HOUSE - DAY', '', 'Alice waves.', '', 'EXT. STREET - NIGHT', '', 'Rain falls.', '', '# Act One', '', 'INT. CELLAR - NIGHT', '', 'Dark.', ''].join('\n');
    const outcome = succeed(h, 'screenplay.import', { format: 'fountain', text });
    const chapter = byTitle(h.state, IMPORTED_SCENES_CHAPTER);
    expect(chapter).toMatchObject({ type: 'folder', parentId: 'manuscript' });
    expect(byTitle(h.state, 'INT. HOUSE - DAY').parentId).toBe(chapter.id);
    expect(byTitle(h.state, 'EXT. STREET - NIGHT').parentId).toBe(chapter.id);
    expect(byTitle(h.state, 'INT. CELLAR - NIGHT').parentId).toBe(byTitle(h.state, 'Act One').id);
    expect(h.state.manifest.tree.filter((node) => node.parentId === 'manuscript' && node.type === 'document')).toEqual([]);
    const result = outcome.result as { folders: number; notices: string[] };
    expect(result.folders).toBe(1);
    expect(result.notices).toContain(`The scenes before the first section went into a new chapter, "${IMPORTED_SCENES_CHAPTER}", because a document goes inside a chapter.`);
    undoGroup(h, outcome);
    expect(snapshotOf(h.state)).toBe(before);
  });

  it('keeps the scenes it imports in the binder under the parent it was given', () => {
    const h = harness();
    succeed(h, 'screenplay.import', { format: 'fountain', text: SCRIPT, parentId: CHAPTER });
    // The chapter already held "The Landing"; the sections land beside it, under the parent that was named.
    expect(byTitle(h.state, 'Act One').parentId).toBe(CHAPTER);
    expect(byTitle(h.state, 'Act Two').parentId).toBe(CHAPTER);
    expect(h.state.manifest.tree.filter((n) => n.parentId === CHAPTER).map((n) => n.title)).toEqual([
      'The Landing',
      'Act One',
      'Act Two',
    ]);
  });
});

describe('dialogue.importInk', () => {
  const CONTAINERS = [
    { title: 'Greeting', body: '=== Greeting ===\nHello.\n-> END\n' },
    { title: 'Farewell', body: '=== Farewell ===\nBye.\n-> END\n' },
  ];

  it('creates one branching dialogue container per planned container, in order, with its Ink body', () => {
    const h = harness();
    const outcome = succeed(h, 'dialogue.importInk', { containers: CONTAINERS, parentId: CHAPTER });
    const ids = (outcome.result as { nodeIds: string[] }).nodeIds;
    expect(ids).toHaveLength(2);
    const [greeting, farewell] = ids.map((id) => nodeById(h.state, id));
    expect(greeting).toMatchObject({ type: 'dialogue', kind: 'branching', title: 'Greeting', parentId: CHAPTER });
    expect(farewell).toMatchObject({ type: 'dialogue', kind: 'branching', title: 'Farewell', parentId: CHAPTER });
    expect(getBody(h.state, ids[0] ?? '')).toBe(CONTAINERS[0]?.body);
    expect(getBody(h.state, ids[1] ?? '')).toBe(CONTAINERS[1]?.body);
  });

  it('is one undo group, and one undo removes every container it made', () => {
    const h = harness();
    const before = snapshotOf(h.state);
    const outcome = succeed(h, 'dialogue.importInk', { containers: CONTAINERS, parentId: CHAPTER });
    undoGroup(h, outcome);
    expect(snapshotOf(h.state)).toBe(before);
  });

  // The caller mints line ids into the planned bodies before the one dispatch (dialogue-narrative.md A3): the command
  // stores the bodies it is given, writes no container setting, and one undo takes the ids with the containers.
  it('stores bodies that already carry minted line ids, leaves autoLineIds unset, and one undo removes both', () => {
    const tagged = [
      { title: 'Greeting', body: '=== Greeting ===\nHello. # lineId: l_0123456789\n-> END\n' },
      { title: 'Farewell', body: '=== Farewell ===\nBye. # lineId: l_ABCDEFGHJK\n-> END\n' },
    ];
    const h = harness();
    const before = snapshotOf(h.state);
    const outcome = succeed(h, 'dialogue.importInk', { containers: tagged, parentId: CHAPTER });
    const ids = (outcome.result as { nodeIds: string[] }).nodeIds;
    expect(ids.map((id) => getBody(h.state, id))).toEqual(tagged.map((c) => c.body));
    for (const id of ids) expect(nodeById(h.state, id)?.dialogue).toBeUndefined();
    undoGroup(h, outcome);
    expect(snapshotOf(h.state)).toBe(before);
  });

  // The chapter rule: containers imported into the manuscript go into one "Imported dialogue" chapter.
  it('puts the containers into an "Imported dialogue" chapter when it imports into the manuscript, and the undo takes the chapter too', () => {
    const h = harness();
    const before = snapshotOf(h.state);
    const outcome = succeed(h, 'dialogue.importInk', { containers: CONTAINERS });
    const chapter = byTitle(h.state, IMPORTED_DIALOGUE_CHAPTER);
    expect(chapter).toMatchObject({ type: 'folder', parentId: 'manuscript' });
    const result = outcome.result as { parentId: string; nodeIds: string[] };
    expect(result.parentId).toBe(chapter.id);
    expect(result.nodeIds).toHaveLength(2);
    for (const id of result.nodeIds) expect(nodeById(h.state, id)?.parentId).toBe(chapter.id);
    undoGroup(h, outcome);
    expect(snapshotOf(h.state)).toBe(before);
  });
});

describe('dialogue.setMeta', () => {
  function makeContainer(h: Harness): string {
    succeed(h, 'dialogue.importInk', { containers: [{ title: 'Greeting', body: '=== Greeting ===\nHi.\n-> END\n' }], parentId: CHAPTER });
    return byTitle(h.state, 'Greeting').id;
  }

  it('sets the settings a patch names, and a null clears one', () => {
    const h = harness();
    const id = makeContainer(h);
    succeed(h, 'dialogue.setMeta', {
      nodeId: id,
      patch: { speaker: ALICE, engineTarget: 'ink-json', autoLineIds: true, locBaseline: 'en-GB' },
    });
    expect(nodeById(h.state, id)?.dialogue).toEqual({ speaker: ALICE, engineTarget: 'ink-json', autoLineIds: true, locBaseline: 'en-GB' });

    succeed(h, 'dialogue.setMeta', { nodeId: id, patch: { speaker: null, locBaseline: null } });
    expect(nodeById(h.state, id)?.dialogue).toEqual({ engineTarget: 'ink-json', autoLineIds: true });
    expect(nodeById(h.state, id)?.updatedAt).toBe(LATER);
  });

  it('removes the record when the last setting is cleared', () => {
    const h = harness();
    const id = makeContainer(h);
    succeed(h, 'dialogue.setMeta', { nodeId: id, patch: { engineTarget: 'generic-csv' } });
    succeed(h, 'dialogue.setMeta', { nodeId: id, patch: { engineTarget: null } });
    expect(nodeById(h.state, id)?.dialogue).toBeUndefined();
  });

  it('keeps an explicit false for line ids: it is a choice, and it is not cleared', () => {
    const h = harness();
    const id = makeContainer(h);
    succeed(h, 'dialogue.setMeta', { nodeId: id, patch: { autoLineIds: false } });
    expect(nodeById(h.state, id)?.dialogue).toEqual({ autoLineIds: false });
  });

  it('undoes to the exact record and stamp it held before, through a second change', () => {
    const h = harness();
    const id = makeContainer(h);
    const beforeFirst = snapshotOf(h.state);
    const first = succeed(h, 'dialogue.setMeta', { nodeId: id, patch: { engineTarget: 'yarn-csv' } });
    const afterFirst = snapshotOf(h.state);
    const second = succeed(h, 'dialogue.setMeta', { nodeId: id, patch: { engineTarget: null, autoLineIds: true } });
    undoGroup(h, second);
    expect(snapshotOf(h.state)).toBe(afterFirst);
    undoGroup(h, first);
    expect(snapshotOf(h.state)).toBe(beforeFirst);
  });

  it('refuses a speaker that is not in the codex, and leaves the record as it was', () => {
    const h = harness();
    const id = makeContainer(h);
    const before = snapshotOf(h.state);
    const result = send(h, 'dialogue.setMeta', { nodeId: id, patch: { speaker: 'c_NOBODY0000' } });
    expect(result.ok).toBe(false);
    expect(snapshotOf(h.state)).toBe(before);
  });
});
