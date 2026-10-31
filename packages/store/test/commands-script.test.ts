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
import { CODEX_DESCRIPTION_MAX, CODEX_NAME_MAX, SCREENPLAY_IMPORT_SEEDS_MAX } from '@caotang/bus';
import { FDX_SEED_DESCRIPTION_MAX, FDX_SEED_NAME_MAX, FDX_SEEDS_MAX } from '@caotang/screenplay';
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

  // Issue #265: Final Draft's scene title names the node, its colour becomes a label, and the ticked cast rows become codex
  // entries, all in the one undo group.
  const OUTLINED = [
    '<FinalDraft DocumentType="Script" Version="6">',
    '  <Content>',
    '    <Paragraph Type="Outline 1"><Text>ACT ONE</Text></Paragraph>',
    '    <Paragraph Type="Summary"><Text>Anna arrives.</Text></Paragraph>',
    '    <Paragraph Type="Scene Heading" Number="1"><SceneProperties Title="Anna arrives" Color="#FFFF00000000"/><Text>INT. STATION - NIGHT</Text></Paragraph>',
    '    <Paragraph Type="Action"><Text>ANNA drags a suitcase.</Text></Paragraph>',
    '    <Paragraph Type="Scene Heading" Number="2"><SceneProperties Title="" Color="#F0F000000000"/><Text>EXT. LIBRARY - NIGHT</Text></Paragraph>',
    '    <Paragraph Type="Action"><Text>Alice waves Anna in.</Text></Paragraph>',
    '    <Paragraph Type="Scene Heading" Number="3"><SceneProperties Color="#00000000FFFF"/><Text>INT. LIBRARY - NIGHT</Text></Paragraph>',
    '    <Paragraph Type="Action"><Text>Books.</Text></Paragraph>',
    '  </Content>',
    '</FinalDraft>',
  ].join('\n');

  /** The state an undo must return, codex and labels included. */
  function fullSnapshot(state: ProjectState): string {
    return JSON.stringify({ base: snapshotOf(state), codex: state.manifest.codex, labels: state.manifest.vocabulary.labels });
  }

  it('names an FDX scene by its SceneProperties title, keeps the heading in the text, and makes outline elements folders', () => {
    const h = harness();
    succeed(h, 'screenplay.import', { format: 'fdx', text: OUTLINED, parentId: CHAPTER });
    const act = byTitle(h.state, 'ACT ONE');
    expect(act).toMatchObject({ type: 'folder', parentId: CHAPTER, synopsis: 'Anna arrives.' });
    const station = byTitle(h.state, 'Anna arrives');
    expect(station.parentId).toBe(act.id);
    expect(getBody(h.state, station.id).startsWith('INT. STATION - NIGHT #1#')).toBe(true);
    // A blank title leaves the heading as the node title.
    expect(byTitle(h.state, 'EXT. LIBRARY - NIGHT').parentId).toBe(act.id);
  });

  it('maps scene colours to labels: a near colour shares one new label, an existing label of a near colour is reused', () => {
    const h = harness();
    h.state.manifest.vocabulary.labels.push({ id: 'night', name: 'Night', color: '#0a0af0' });
    const outcome = succeed(h, 'screenplay.import', { format: 'fdx', text: OUTLINED, parentId: CHAPTER });
    const red = h.state.manifest.vocabulary.labels.find((term) => term.name === 'Red');
    expect(red).toEqual({ id: 'red', name: 'Red', color: '#ff0000' });
    expect(byTitle(h.state, 'Anna arrives').label).toBe('red');
    expect(byTitle(h.state, 'EXT. LIBRARY - NIGHT').label).toBe('red');
    expect(byTitle(h.state, 'INT. LIBRARY - NIGHT').label).toBe('night');
    expect(h.state.manifest.vocabulary.labels).toHaveLength(2);
    expect(JSON.stringify(outcome)).toContain('Scene colours added the label \\"Red\\"');
  });

  it('creates the ticked codex rows attached to the first scene that names them, skips a name the codex holds, and one undo removes it all', () => {
    const h = harness();
    const before = fullSnapshot(h.state);
    const outcome = succeed(h, 'screenplay.import', {
      format: 'fdx',
      text: OUTLINED,
      parentId: CHAPTER,
      codex: [
        { name: 'ANNA', type: 'character', description: 'a pilot' },
        { name: 'LIBRARY', type: 'location' },
        { name: 'ALICE', type: 'character' },
        { name: 'GHOST', type: 'character' },
      ],
    });
    const codex = h.state.manifest.codex ?? [];
    const anna = codex.find((entry) => entry.name === 'ANNA');
    expect(anna).toMatchObject({ type: 'character', description: 'a pilot', origin: 'import', includePolicy: 'detected' });
    expect(anna?.attachments).toEqual([byTitle(h.state, 'Anna arrives').id]);
    expect(anna?.sources[0]).toMatchObject({ docId: byTitle(h.state, 'Anna arrives').id, quote: 'ANNA drags a suitcase.' });
    const library = codex.find((entry) => entry.name === 'LIBRARY');
    expect(library?.attachments).toEqual([byTitle(h.state, 'EXT. LIBRARY - NIGHT').id]);
    // "Alice" is in the codex already: never merged, never duplicated.
    expect(codex.filter((entry) => entry.name.toLowerCase() === 'alice')).toHaveLength(1);
    expect(codex.find((entry) => entry.name === 'GHOST')?.attachments).toEqual([]);
    const text = JSON.stringify(outcome);
    expect(text).toContain('an import never merges into an entry');
    expect(text).toContain('not named in any imported scene');
    expect(outcome.result).toMatchObject({ codexEntries: 3, labels: 2 });
    undoGroup(h, outcome);
    expect(fullSnapshot(h.state)).toBe(before);
  });

  it('adds a row with the include policy it carries (a flagged row is manual), detected without one', () => {
    const h = harness();
    succeed(h, 'screenplay.import', {
      format: 'fdx',
      text: OUTLINED,
      parentId: CHAPTER,
      codex: [
        { name: 'ANNA', type: 'character', includePolicy: 'manual' },
        { name: 'LIBRARY', type: 'location' },
      ],
    });
    const codex = h.state.manifest.codex ?? [];
    expect(codex.find((entry) => entry.name === 'ANNA')?.includePolicy).toBe('manual');
    expect(codex.find((entry) => entry.name === 'LIBRARY')?.includePolicy).toBe('detected');
  });

  // The FDX reader offers only rows the command accepts: its limits are the bus's (pawcommit-review F1 on #321).
  it('offers seeds within the limits screenplay.import checks', () => {
    expect(FDX_SEEDS_MAX).toBe(SCREENPLAY_IMPORT_SEEDS_MAX);
    expect(FDX_SEED_NAME_MAX).toBe(CODEX_NAME_MAX);
    expect(FDX_SEED_DESCRIPTION_MAX).toBe(CODEX_DESCRIPTION_MAX);
  });

  it('leaves a project with no codex without one after the undo', () => {
    const h = harness();
    delete h.state.manifest.codex;
    const outcome = succeed(h, 'screenplay.import', { format: 'fdx', text: OUTLINED, parentId: CHAPTER, codex: [{ name: 'ANNA', type: 'character' }] });
    expect(h.state.manifest.codex).toHaveLength(1);
    undoGroup(h, outcome);
    expect('codex' in h.state.manifest).toBe(false);
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

describe('the AV script: a show folder, an episode, and their settings (av-script.md §2)', () => {
  /** A show folder in the chapter and an episode in it, made through `binder.create` with the two new kinds. */
  function makeShow(h: Harness): { readonly show: string; readonly episode: string } {
    succeed(h, 'binder.create', { parentId: CHAPTER, type: 'folder', title: 'The Long Way', kind: 'show' });
    const show = byTitle(h.state, 'The Long Way').id;
    succeed(h, 'binder.create', { parentId: show, type: 'document', title: 'Episode 12', kind: 'av-script' });
    return { show, episode: byTitle(h.state, 'Episode 12').id };
  }

  it('makes a show folder and an episode document that carry their kinds', () => {
    const h = harness();
    const { show, episode } = makeShow(h);
    expect(nodeById(h.state, show)).toMatchObject({ type: 'folder', kind: 'show' });
    expect(nodeById(h.state, episode)).toMatchObject({ type: 'document', kind: 'av-script' });
    expect(getBody(h.state, episode)).toBe('');
  });

  it('sets the show settings a patch names, a null clears one, and the record goes with its last key', () => {
    const h = harness();
    const { show } = makeShow(h);
    succeed(h, 'script.setShowMeta', { nodeId: show, patch: { ratePreset: 'broadcast', cueVocabulary: ['music', 'bed'], targetRuntimeSec: 1800 } });
    expect(nodeById(h.state, show)?.showMeta).toEqual({ ratePreset: 'broadcast', cueVocabulary: ['music', 'bed'], targetRuntimeSec: 1800 });
    expect(nodeById(h.state, show)?.updatedAt).toBe(LATER);
    succeed(h, 'script.setShowMeta', { nodeId: show, patch: { cueVocabulary: null, targetRuntimeSec: null } });
    expect(nodeById(h.state, show)?.showMeta).toEqual({ ratePreset: 'broadcast' });
    succeed(h, 'script.setShowMeta', { nodeId: show, patch: { ratePreset: null } });
    expect(nodeById(h.state, show)?.showMeta).toBeUndefined();
  });

  it('sets the episode settings, and one undo restores the record and the stamp it held before', () => {
    const h = harness();
    const { episode } = makeShow(h);
    const before = snapshotOf(h.state);
    const first = succeed(h, 'script.setEpisodeMeta', {
      nodeId: episode,
      patch: { audioUrl: 'https://cdn.example.com/12.mp3', audioBytes: 1024, audioMime: 'audio/mpeg' },
    });
    const afterFirst = snapshotOf(h.state);
    const second = succeed(h, 'script.setEpisodeMeta', { nodeId: episode, patch: { audioBytes: null, episode: 12 } });
    expect(nodeById(h.state, episode)?.episodeMeta).toEqual({ audioUrl: 'https://cdn.example.com/12.mp3', audioMime: 'audio/mpeg', episode: 12 });
    undoGroup(h, second);
    expect(snapshotOf(h.state)).toBe(afterFirst);
    undoGroup(h, first);
    expect(snapshotOf(h.state)).toBe(before);
  });

  it('refuses show settings on an episode and episode settings on a show, and changes nothing', () => {
    const h = harness();
    const { show, episode } = makeShow(h);
    const before = snapshotOf(h.state);
    expect(send(h, 'script.setShowMeta', { nodeId: episode, patch: { author: 'A' } }).ok).toBe(false);
    expect(send(h, 'script.setEpisodeMeta', { nodeId: show, patch: { episode: 1 } }).ok).toBe(false);
    expect(snapshotOf(h.state)).toBe(before);
  });

  it('writes both records to caotang.json and reads them back unchanged, with no notice', async () => {
    const h = harness();
    const { show, episode } = makeShow(h);
    succeed(h, 'script.setShowMeta', { nodeId: show, patch: { speechRateWpm: 160, explicit: false, cueVocabulary: ['music', 'O.C.'] } });
    succeed(h, 'script.setEpisodeMeta', { nodeId: episode, patch: { season: 2, episodeType: 'bonus' } });
    const fs = new MemoryArtifactFs();
    await writeProject(fs, h.state, { now: new Date(LATER_MS) });
    // The episode body stays docs/<id>.md: bodyExtensionOf falls through to .md for any kind but screenplay (av-script.md §2).
    expect(await fs.exists(`docs/${episode}.md`)).toBe(true);
    const loaded = await readProject(fs, { now: new Date(LATER_MS) });
    expect(nodeById(loaded.state, show)?.showMeta).toEqual({ speechRateWpm: 160, explicit: false, cueVocabulary: ['music', 'O.C.'] });
    expect(nodeById(loaded.state, episode)?.episodeMeta).toEqual({ season: 2, episodeType: 'bonus' });
    expect(nodeById(loaded.state, episode)?.kind).toBe('av-script');
    expect(loaded.notices.filter((n) => n.droppedField !== undefined)).toEqual([]);
  });
});
