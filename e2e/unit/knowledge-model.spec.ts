import { expect, test } from '@playwright/test';
import { emptyCoherenceFile, type CoherenceFile, type KnowledgeFact } from '../../packages/coherence/src/index.js';

import { binderScenes, characterCandidates, knowledgeRows, pairWords } from '../../apps/desktop/src/app/knowledge-model.js';
import type { CodexEntry } from '../../packages/store/src/index.js';
import { IDS, project } from './fixtures.js';
import { withoutIsolates } from '../support.js';

const NOW = '2026-10-08T09:00:00.000Z';
const ANNA = 'c_ANNA000001';
const BEN = 'c_BEN0000001';
const HEIR = 'k_SECRET0001';

function entry(id: string, name: string, type = 'character'): CodexEntry {
  return {
    id,
    name,
    aliases: [],
    type,
    description: '',
    includePolicy: 'detected',
    caseSensitive: false,
    exclude: [],
    attachments: [],
    keywords: [],
    origin: 'manual',
    sources: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const fact: KnowledgeFact = { id: HEIR, text: 'Mara is the heir', createdAt: NOW, updatedAt: NOW };

function fileWith(sceneMeta: CoherenceFile['sceneMeta']): CoherenceFile {
  return { ...emptyCoherenceFile(), knowledge: [fact], sceneMeta };
}

test.describe('the Knowledge list model (coherence.md §4.4, §8)', () => {
  test('lists the documents in binder order, folders walked in place and the research documents after the manuscript', () => {
    expect(binderScenes(project()).map((scene) => scene.title)).toEqual(['Scene A', 'Scene B', 'Scene C', 'Deep scene', 'Scene D', 'Note']);
  });

  test('derives a fact’s ledger from the scenes, in binder order, and counts the declarations a removal would take', () => {
    const state = project();
    state.manifest.codex = [entry(ANNA, 'Anna'), entry(BEN, 'Ben')];
    const file = fileWith({
      [IDS.sceneD]: { learns: [{ entryId: BEN, factId: HEIR }] },
      [IDS.sceneA]: { knows: [{ entryId: ANNA, factId: HEIR }], learns: [{ entryId: ANNA, factId: HEIR }] },
    });
    const [row] = knowledgeRows(state, file);
    expect(row?.learns.map((line) => `${line.who} in ${line.title}`)).toEqual(['Anna in Scene A', 'Ben in Scene D']);
    expect(row?.knows.map((line) => `${line.who} in ${line.title}`)).toEqual(['Anna in Scene A']);
    expect(row?.declarations).toBe(3);
  });

  test('marks a learning in a dream as one the scan does not count, and names a character that is gone', () => {
    const state = project();
    state.manifest.codex = [entry(ANNA, 'Anna')];
    const file = fileWith({
      [IDS.sceneA]: { timelineMode: 'dream', learns: [{ entryId: ANNA, factId: HEIR }] },
      [IDS.sceneB]: { learns: [{ entryId: BEN, factId: HEIR }] },
    });
    const [row] = knowledgeRows(state, file);
    expect(row?.learns.map((line) => [line.title, line.counts])).toEqual([['Scene A', false], ['Scene B', true]]);
    expect(row?.learns[1]?.who).toBe('a character that is gone');
  });

  test('names the codex entry a fact is about, and nothing when there is no file', () => {
    const state = project();
    state.manifest.codex = [entry(ANNA, 'Anna')];
    const linked: CoherenceFile = { ...fileWith({}), knowledge: [{ ...fact, entryId: ANNA }] };
    expect(knowledgeRows(state, linked)[0]?.about).toBe('Anna');
    expect(knowledgeRows(state, undefined)).toEqual([]);
  });

  test('offers the characters by name and leaves the other kinds of entry out', () => {
    const entries = [entry(BEN, 'ben'), entry('c_PLACE00001', 'The Lighthouse', 'location'), entry(ANNA, 'Anna')];
    expect(characterCandidates(entries, 'en').map((candidate) => candidate.name)).toEqual(['Anna', 'ben']);
  });

  test('sorts the characters by the project language, not the interface’s (i18n.md §4.3, D9)', () => {
    const entries = [entry('c_AALAND0001', 'Åland'), entry('c_ZEBRA00001', 'Zebra')];
    expect(characterCandidates(entries, 'sv').map((candidate) => candidate.name)).toEqual(['Zebra', 'Åland']);
    expect(characterCandidates(entries, 'en').map((candidate) => candidate.name)).toEqual(['Åland', 'Zebra']);
  });

  test('reads a declared pair as the character and the fact, each by name', () => {
    const entries = [entry(ANNA, 'Anna')];
    expect(withoutIsolates(pairWords({ entryId: ANNA, factId: HEIR }, entries, [fact]))).toBe('Anna: Mara is the heir');
    expect(withoutIsolates(pairWords({ entryId: BEN, factId: 'k_GONE000001' }, entries, [fact]))).toBe('a character that is gone: a fact that is gone');
  });
});
