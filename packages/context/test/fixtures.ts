/**
 * The fixture project the context tests assemble. It is small enough to read, and it has
 * each case the layers handle: a focus with a long body (so the continue tail is a real
 * tail), a blank synopsis, an empty focus (draft stand-in), a forward scene, research that
 * is not in manuscript order, and a codex with every policy and every suppression.
 *
 * The tree and the codex are built in a shuffled order when `shuffled` is set. The assembly
 * must not notice: it is the same project, and the same prompt comes out of it.
 */

import type { ActivityEntry } from '@caotang/bus';
import { createMentionIndex, type MentionIndex } from '@caotang/codex';
import {
  addDocument,
  addFolder,
  createEmptyManifest,
  createProjectState,
  nodeById,
  type CodexEntry,
  type ProjectState,
} from '@caotang/store';

import { DEFAULT_CONTINUATION_CHARS, type AppSnapshot, type RecentTurn } from '../src/index.js';

export const FOCUS_ID = 'n_ch3';
export const EMPTY_ID = 'n_ch4';
export const SELECTION_TEXT = 'Hale has been asking about you';

export const CH1 = [
  'Elena reached the harbor town at the end of a long afternoon, with rain on her coat and a map case under one arm.',
  'The chandler and his wife gave her the room above the shop without asking for references, which was the first kind thing anyone had done since the coach left the hills.',
  'From the window she could see the breakwater, the ferry sheds and the squat lighthouse at its end, its lamp not yet lit.',
  'She unpacked the maps first. Every one of them had been drawn by someone else, and she trusted none of them.',
].join('\n\n');

export const CH2 = [
  'Morning brought the fishermen down to the slip, and with them the questions. Captain Hale wanted to know whether the new cartographer was the one who had been asking about the old sea wall.',
  'Elena said she was. Hale grunted, which she took for permission, and went back to his nets.',
  'The day went on like that: small kindnesses, small suspicions, and a steady grey light that never quite became sun.',
].join('\n\n');

export const CH3 = [
  'The fog lifted off the harbor a little after dawn, and Elena watched the boats come in from the north wall. She had walked out to the breakwater before anyone was awake, because the maps disagreed about where the old channel ran, and she wanted to see the water for herself.',
  'The lighthouse keeper was already on the gallery. He did not wave. When she reached the foot of the tower he came down the iron stair with a lantern he did not need, and looked at her map case as if it had insulted him.',
  'Her name is Mara, the keeper said, though he did not say whether he meant it as an introduction or a warning. Mara keeps the light. Mara keeps the log. Mara does not care for people who draw things they have not measured.',
  'Elena said that she measured everything she drew. Mara laughed, once, the way a gull does when it is not pleased with the weather. Then she asked which map had put the old channel on the east side of the breakwater, and Elena showed her.',
  'The keeper’s cottage stood a little back from the tower, with a garden of salt-burnt cabbages and a bench nobody had sat on in years. Mara did not invite her in. She made tea on a spirit stove in the open doorway and handed Elena a cup without a saucer, as though the cup were a test of something.',
  'Elena asked about the log. Mara said that it recorded the lamp, the weather, and the boats that passed within sight of the light, and that it had never once recorded a boat that was not there. She said this with a flatness that made Elena want to ask a second question, and she did not.',
  'Overhead the gulls were working the wind above the sheds, and below them the tide had turned. Mara checked her watch against the bell in the tower, wrote something in a small black book, and said that the channel would be passable by noon if the fog held off.',
  'Elena had heard the same thing from three people already that morning. Each of them had given a different hour, and each of them had looked at the sea before they gave it.',
  'They walked the tide line together for an hour. Mara knew the sandbars by their colour and the wrecks by their names. She had been keeping the log since her father died, and she had never once written down a guess.',
  'At the seaward end of the breakwater the water was clear enough to see the stones of the old wall, running out under the surface in a straight line that no current would have made. Mara crouched beside it and put her palm flat on the wet granite.',
  'This is the wall the fog law was written for, she said. Nobody built it to stop the sea. They built it to keep the town from sailing out of sight of the light, so that the fog could never hide a boat from the people who were paid to watch for it.',
  'Elena asked who had been paid to watch. Mara did not answer that. She stood, brushed her hands on her coat, and looked back at the harbor, where Captain Hale was shouting at a boy about a rope.',
  'Hale has been asking about you, Mara said. He thinks the cartographer is working for the ferry company. He thinks the ferry company wants the channel closed so the wolf can be sold to the rich men on the far shore.',
  'The wolf is a dog, Elena said. A grey one, with a limp. I saw it sleeping in the chandler yard.',
  'Mara looked at her for a long time. Then she said that Elena should go back to the town and draw the channel exactly as the water showed it, and that she should not show the drawing to Hale, or to the Silver Gull, or to anyone who asked for a copy.',
  'Elena went back along the breakwater with the wind in her face. The light came on behind her, a little late, and she did not turn round to watch it.',
].join('\n\n');

/** The default continue tail of CH3: its last 3,000 characters, the text the model is sent. */
export const TAIL = CH3.slice(-DEFAULT_CONTINUATION_CHARS);

export const CH5 = [
  'The storm broke on the third night. Waves took the breakwater’s outer stones, and by morning the quay was a field of splintered timber.',
  'Elena walked the length of it with her notebook, counting what could be saved and what had only been loved.',
].join('\n\n');

export const RESEARCH_NOTES = 'Fog rolls in at dusk. Record the hour, not the feeling.';

export const TURNS: readonly RecentTurn[] = [
  { turnId: 't_1', intent: 'Plan the harbor chapters from my notes.' },
  { turnId: 't_2', intent: 'Draft chapter 2 from the notes, keeping Hale gruff.' },
  { turnId: 't_3', intent: 'Tighten the opening of chapter 3 by about forty words.' },
];

export const ACTIVITY: readonly ActivityEntry[] = [
  activity('t_1', 'g_t1', 'created Act I and Act II'),
  activity('t_2', 'g_t2', 'wrote 212 words into Chapter 2'),
  activity('t_3', 'g_t3', 'trimmed 41 words from Chapter 3'),
  activity('t_3', 'g_t3', 'set the status of Chapter 3 to revised'),
];

function activity(turnId: string, undoGroupId: string, summary: string): ActivityEntry {
  return {
    at: 0,
    command: 'doc.write',
    issuedBy: 'agent',
    turnId,
    callId: `${turnId}-call`,
    undoGroupId,
    source: 'native',
    affected: [],
    summary,
  };
}

/** A codex entry with the manifest's shape and benign defaults. */
export function entry(name: string, overrides: Partial<CodexEntry> = {}): CodexEntry {
  return {
    id: `c_${name.replace(/\s+/g, '_')}`,
    name,
    aliases: [],
    type: 'character',
    description: `About ${name}.`,
    includePolicy: 'detected',
    caseSensitive: false,
    exclude: [],
    attachments: [],
    keywords: [],
    origin: 'manual',
    sources: [],
    ...overrides,
  };
}

export const CODEX: readonly CodexEntry[] = [
  entry('Elena', {
    aliases: ['Ellie'],
    type: 'character',
    description: 'Elena Voss maps the harbor for the port authority. She distrusts maps she did not draw.',
  }),
  entry('Harbor', {
    type: 'location',
    includePolicy: 'always',
    description: 'A fog-bound port town on the north coast, built around a breakwater.',
  }),
  entry('Mara', {
    type: 'character',
    includePolicy: 'manual',
    attachments: ['n_act1'],
    description: 'Mara keeps the lighthouse log and says little.',
  }),
  entry('Captain Hale', {
    type: 'character',
    description: 'Captain Hale commands the ferry and distrusts strangers.',
  }),
  entry('Lighthouse', {
    type: 'location',
    description: 'The squat light at the end of the breakwater.',
  }),
  entry('Wolf', {
    type: 'object',
    includePolicy: 'never',
    description: 'PRIVATE: the wolf in chapter five is a dog. Do not reveal this.',
  }),
  entry('Fog Law', {
    type: 'lore',
    description: '',
  }),
  entry('Silver Gull', {
    type: 'object',
    includePolicy: 'manual',
    attachments: ['n_ch5'],
    description: 'A ferry that is not supposed to exist.',
  }),
];

/** The fixture's ids for the tree, for tests that name a node. */
export const IDS = {
  act1: 'n_act1',
  ch1: 'n_ch1',
  ch2: 'n_ch2',
  ch3: 'n_ch3',
  act2: 'n_act2',
  ch4: 'n_ch4',
  ch5: 'n_ch5',
  notes: 'n_notes',
} as const;

export interface FixtureOptions {
  /** Build the tree and the codex in a different insertion order. The prompt must not change. */
  readonly shuffled?: boolean;
  /** Give the focus chapter a mention cache, as continuity.scan may read it. */
  readonly mentions?: boolean;
}

export function buildState(shuffled = false): ProjectState {
  const manifest = createEmptyManifest('Harbor Notes', new Date('2026-10-01T09:00:00.000Z'));
  const state = createProjectState(manifest);

  const manuscript = nodeById(state, 'manuscript');
  if (manuscript !== undefined) {
    manuscript.synopsis = 'The whole novel: a town that keeps its secrets in the fog.';
  }

  const documents = [
    { id: IDS.ch1, title: 'Chapter 1', body: CH1, synopsis: 'Elena reaches the harbor town and takes a room above the chandlery.' },
    { id: IDS.ch2, title: 'Chapter 2', body: CH2, synopsis: '' },
    { id: IDS.ch3, title: 'Chapter 3', body: CH3, synopsis: 'Elena meets Mara at the lighthouse and learns about the fog law.' },
    { id: IDS.ch4, title: 'Chapter 4', body: '', synopsis: 'The storm breaks over the breakwater.' },
    { id: IDS.ch5, title: 'Chapter 5', body: CH5, synopsis: 'Aftermath on the quay.' },
  ];
  const folders = [
    { id: IDS.act1, title: 'Act I', synopsis: 'Arrival and the first clues.', parent: 'manuscript' },
    { id: IDS.act2, title: 'Act II', synopsis: 'The storm.', parent: 'manuscript' },
  ];
  const parents: Record<string, string> = {
    [IDS.ch1]: IDS.act1,
    [IDS.ch2]: IDS.act1,
    [IDS.ch3]: IDS.act1,
    [IDS.ch4]: IDS.act2,
    [IDS.ch5]: IDS.act2,
  };

  // Shuffling the insertion order changes the array the store holds, and `addDocument`
  // numbers siblings by insertion. The sibling order is pinned below, so the shuffled
  // project is the same project: the assembly must read the same order either way.
  const ordered = shuffled ? [...documents].reverse() : documents;
  const folderOrder = shuffled ? [...folders].reverse() : folders;
  for (const folder of folderOrder) {
    addFolder(state, { parentId: folder.parent, title: folder.title, id: folder.id });
    const node = nodeById(state, folder.id);
    if (node !== undefined) node.synopsis = folder.synopsis;
  }
  for (const doc of ordered) {
    addDocument(state, {
      parentId: parents[doc.id] ?? 'manuscript',
      title: doc.title,
      body: doc.body,
      synopsis: doc.synopsis,
      id: doc.id,
    });
  }
  addDocument(state, {
    parentId: 'research',
    title: 'Research notes',
    body: RESEARCH_NOTES,
    synopsis: 'Fog behaviour.',
    id: IDS.notes,
  });

  for (const [id, order] of Object.entries(SIBLING_ORDER)) {
    const node = nodeById(state, id);
    if (node !== undefined) node.order = order;
  }

  const codex = shuffled ? [...CODEX].reverse() : [...CODEX];
  state.manifest.codex = codex.map((item) => ({ ...item, aliases: [...item.aliases] }));
  return state;
}

/** Sibling order, pinned: gaps of ten, as the store encodes them (project-format §2). */
const SIBLING_ORDER: Readonly<Record<string, number>> = {
  [IDS.act1]: 10,
  [IDS.act2]: 20,
  [IDS.ch1]: 10,
  [IDS.ch2]: 20,
  [IDS.ch3]: 30,
  [IDS.ch4]: 10,
  [IDS.ch5]: 20,
  [IDS.notes]: 10,
};

export function buildApp(options: FixtureOptions = {}): AppSnapshot {
  const state = buildState(options.shuffled === true);
  const mentions: MentionIndex | undefined = options.mentions === true ? createMentionIndex() : undefined;
  return {
    state,
    tools: TOOL_SURFACE,
    session: { todayWords: 412, target: 1_000 },
    turns: TURNS,
    activity: ACTIVITY,
    ...(mentions === undefined ? {} : { mentions }),
  };
}

export const TOOL_SURFACE = [
  { name: 'project.overview', signature: 'project.overview()' },
  { name: 'doc.read', signature: 'doc.read(doc, range?, response_format?)' },
  { name: 'scene.draft', signature: 'scene.draft(doc, instruction, mode?, target_words?, selection?)' },
  { name: 'codex.write', signature: 'codex.write(entries)' },
];

/** The selection the rewrite tests capture: the sentence in the focus body, with its offsets. */
export function selectionOfFocus(): { from: number; to: number; exact: string } {
  const from = CH3.indexOf(SELECTION_TEXT);
  if (from < 0) throw new Error('selection text is not in the focus body');
  const to = from + SELECTION_TEXT.length;
  return { from, to, exact: CH3.slice(from, to) };
}

/**
 * A chapter of exactly `length` characters, built from numbered sentences, so no two slices of
 * it read alike. The flow-up tests need a body longer than the tail, and CH3 is too short.
 */
export function longChapter(length: number): string {
  const sentences: string[] = [];
  let total = 0;
  for (let index = 1; total < length; index += 1) {
    const sentence = `Sentence ${index} of the long chapter: the harbor keeps its count, and the fog keeps its secret.`;
    sentences.push(sentence);
    total += sentence.length + 1;
  }
  return sentences.join(' ').slice(0, length);
}

/**
 * A two-chapter project. Chapter 1 has a short synopsis, so the layers above the focus pass up
 * unused budget. Chapter 2 is `length` characters long, and it is the focus.
 */
export function longApp(length: number): AppSnapshot {
  const state = createProjectState(createEmptyManifest('Long Chapter'));
  addDocument(state, {
    parentId: 'manuscript',
    title: 'Chapter 1',
    body: CH1,
    synopsis: 'Short synopsis.',
    id: 'n_long1',
  });
  addDocument(state, {
    parentId: 'manuscript',
    title: 'Chapter 2',
    body: longChapter(length),
    synopsis: 'The long one.',
    id: 'n_long2',
  });
  return { state };
}

export const LONG_FOCUS = 'n_long2';

/** A manuscript of `count` documents, `n_d01` onward, each with a short body and a synopsis. */
export function scopeApp(count: number): { app: AppSnapshot; ids: string[] } {
  const state = createProjectState(createEmptyManifest('Scope'));
  const ids: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    const id = `n_d${String(index).padStart(2, '0')}`;
    ids.push(id);
    addDocument(state, {
      parentId: 'manuscript',
      title: `Part ${index}`,
      body: `Text of part ${index}.`,
      synopsis: `Synopsis ${index}.`,
      id,
    });
  }
  return { app: { state }, ids };
}

/**
 * The fixture project with `count` extra `always` entries, each with a description of `chars`
 * characters, written ahead of the fixture's own codex (or after it, for `rotate`).
 */
export function heavyAlwaysApp(count: number, chars: number, rotate = 0): AppSnapshot {
  const app = buildApp();
  const extra = Array.from({ length: count }, (_, index) =>
    entry(`Rule ${index + 1}`, { type: 'lore', includePolicy: 'always', description: `Rule ${index + 1}: ${'w'.repeat(chars)}` }),
  );
  const codex = [...extra, ...(app.state.manifest.codex ?? [])];
  const rotated = [...codex.slice(rotate), ...codex.slice(0, rotate)];
  app.state.manifest.codex = rotated;
  return app;
}

/** The writer's file in the fixtures that carry instructions. */
export const INSTRUCTIONS_TEXT = [
  'British spelling. Past tense, close third person on Mara.',
  'No semicolons in dialogue.',
  'Never summarise a scene in its last paragraph.',
].join('\n');

/** The memory index the fixtures carry beside it. */
export const MEMORY_INDEX_TEXT = [
  '- [Dialogue tags](style-dialogue.md) (style): Use "said" for tags.',
  '- [Scene endings](process-endings.md) (process): End on a line of dialogue where possible.',
].join('\n') + '\n';

/** The app with the project's agent files set, as a project opened with CAOTANG.md and a memory folder has them. */
export function withInstructions(app: AppSnapshot, options: { instructions?: string; index?: string; path?: 'CAOTANG.md' | 'AGENTS.md' } = {}): AppSnapshot {
  const text = options.instructions ?? INSTRUCTIONS_TEXT;
  app.state.agentFiles = {
    instructions: { path: options.path ?? 'CAOTANG.md', text },
    index: options.index ?? MEMORY_INDEX_TEXT,
    memory: [],
    declined: new Map(),
    unreadable: [],
  };
  return app;
}
