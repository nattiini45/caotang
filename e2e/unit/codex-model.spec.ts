import { expect, test } from '@playwright/test';

import { setBody, type CodexEntry } from '../../packages/store/src/index.js';

import {
  CodexMentions,
  NO_FILTER,
  appearancesOf,
  groupByType,
  isFiltered,
  matchesFilter,
  totalsOf,
  uniqueName,
} from '../../apps/desktop/src/app/codex-model.js';

import { IDS, project } from './fixtures.js';

/** A codex entry with every field the store gives one, so a test states only what it is about. */
function entry(overrides: Partial<CodexEntry> & { id: string; name: string }): CodexEntry {
  return {
    aliases: [],
    type: 'character',
    description: '',
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

test('entries are grouped by type in the codex order, each group in alphabetical order, and an unknown type comes last', () => {
  const groups = groupByType(
    [
      entry({ id: 'c_0000000001', name: 'zed', type: 'location' }),
      entry({ id: 'c_0000000002', name: 'Bruno', type: 'character' }),
      entry({ id: 'c_0000000003', name: 'anna', type: 'character' }),
      entry({ id: 'c_0000000004', name: 'Mystery', type: 'mystery' }),
      entry({ id: 'c_0000000005', name: 'Keep', type: 'lore' }),
    ],
    'en',
  );

  expect(groups.map((group) => group.type)).toEqual(['character', 'location', 'lore', 'mystery']);
  expect(groups[0]?.entries.map((item) => item.name)).toEqual(['anna', 'Bruno']);
  expect(groups[3]?.label).toBe('mystery');
});

test('a group sorts by the project language, not the interface’s, so a Swedish novel sorts å after z', () => {
  const names = (language: string): readonly string[] =>
    groupByType(
      [
        entry({ id: 'c_0000000001', name: 'Åland' }),
        entry({ id: 'c_0000000002', name: 'Zebra' }),
        entry({ id: 'c_0000000003', name: 'Öre' }),
      ],
      language,
    )[0]?.entries.map((item) => item.name) ?? [];

  expect(names('sv')).toEqual(['Zebra', 'Åland', 'Öre']);
  expect(names('en')).toEqual(['Åland', 'Öre', 'Zebra']);
});

test('the search reads names, aliases and descriptions without regard to case, and the chips narrow the list', () => {
  const elena = entry({
    id: 'c_0000000001',
    name: 'Elena',
    aliases: ['Ellie'],
    description: 'Keeps the lighthouse.',
    includePolicy: 'always',
  });
  const harbour = entry({
    id: 'c_0000000002',
    name: 'Harbour',
    type: 'location',
    description: 'Where the boats land.',
    includePolicy: 'manual',
  });

  expect(matchesFilter(elena, { ...NO_FILTER, query: 'ELLIE' })).toBe(true);
  expect(matchesFilter(elena, { ...NO_FILTER, query: 'lighthouse' })).toBe(true);
  expect(matchesFilter(harbour, { ...NO_FILTER, query: 'lighthouse' })).toBe(false);
  expect(matchesFilter(harbour, { ...NO_FILTER, query: 'land' })).toBe(true);

  expect(matchesFilter(elena, { ...NO_FILTER, types: new Set(['location']) })).toBe(false);
  expect(matchesFilter(elena, { ...NO_FILTER, policies: new Set(['always']) })).toBe(true);
  // The chips and the search compose: both must hold.
  expect(matchesFilter(elena, { query: 'el', types: new Set(['character']), policies: new Set(['manual']) })).toBe(false);

  expect(isFiltered(NO_FILTER)).toBe(false);
  expect(isFiltered({ ...NO_FILTER, query: '   ' })).toBe(false);
  expect(isFiltered({ ...NO_FILTER, policies: new Set(['never']) })).toBe(true);
});

test('a new entry is named so that no entry already has the name, case-insensitively', () => {
  expect(uniqueName([], 'Untitled entry')).toBe('Untitled entry');
  const taken = [
    entry({ id: 'c_0000000001', name: 'untitled ENTRY' }),
    entry({ id: 'c_0000000002', name: 'Untitled entry 2' }),
  ];
  expect(uniqueName(taken, 'Untitled entry')).toBe('Untitled entry 3');
});

test('an entry appears in the documents that mention it, in manuscript order, with a count that includes its aliases', () => {
  const state = project();
  // Scene B is first in the manuscript; the Deep scene is later. The body order is not the manuscript order.
  setBody(state, IDS.deepScene, 'Elena, once more.');
  setBody(state, IDS.sceneB, 'Elena counted the boats. Ellie waved.');
  setBody(state, IDS.sceneA, 'Nothing to see here.');
  const elena = entry({ id: 'c_ELENA00001', name: 'Elena', aliases: ['Ellie'] });
  state.manifest.codex = [elena];

  const mentions = new CodexMentions();
  const entries = mentions.entriesOf(state);

  expect(appearancesOf(state, elena.id, mentions, entries)).toEqual([
    { docId: IDS.sceneB, title: 'Scene B', count: 2 },
    { docId: IDS.deepScene, title: 'Deep scene', count: 1 },
  ]);
  expect(totalsOf(state, mentions, entries).get(elena.id)).toBe(3);
});

test('the mention cache scans a document once, scans it again only when that document changes, and rescans all when the codex changes', () => {
  const state = project();
  setBody(state, IDS.sceneB, 'Elena counted the boats.');
  const elena = entry({ id: 'c_ELENA00001', name: 'Elena' });
  state.manifest.codex = [elena];
  const mentions = new CodexMentions();

  let entries = mentions.entriesOf(state);
  appearancesOf(state, elena.id, mentions, entries);
  const scanned = mentions.documentPasses;
  expect(scanned).toBeGreaterThan(0);

  // Nothing has changed: the second read scans nothing.
  entries = mentions.entriesOf(state);
  appearancesOf(state, elena.id, mentions, entries);
  expect(mentions.documentPasses).toBe(scanned);

  // One document is written: exactly that document is scanned again.
  setBody(state, IDS.sceneD, 'Elena came back.');
  entries = mentions.entriesOf(state);
  expect(appearancesOf(state, elena.id, mentions, entries).map((item) => item.title)).toEqual(['Scene B', 'Scene D']);
  expect(mentions.documentPasses).toBe(scanned + 1);

  // The codex changes (an alias is added): the counts follow it, so a document that now says the alias is counted.
  setBody(state, IDS.note, 'Lena keeps notes.');
  state.manifest.codex = [{ ...elena, aliases: ['Lena'] }];
  entries = mentions.entriesOf(state);
  expect(appearancesOf(state, elena.id, mentions, entries).map((item) => item.title)).toEqual([
    'Scene B',
    'Scene D',
    'Note',
  ]);
});
