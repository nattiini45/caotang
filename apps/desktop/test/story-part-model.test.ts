import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyCoherenceFile, type CoherenceFile, type SceneMeta } from '@caotang/coherence';
import { addDocument, addFolder, createEmptyManifest, createProjectState, type ProjectState } from '@caotang/store';

import { dayLabel, inheritedStoryPartOf, storyPartLabel } from '../src/app/findings-model.js';
import { activateCatalogue, activateEnglish } from '../src/i18n/runtime.js';

beforeEach(activateEnglish);
afterEach(activateEnglish);

const NOW = new Date('2026-10-01T09:00:00.000Z');

function project(): ProjectState {
  const state = createProjectState(createEmptyManifest('Fixture', NOW), { now: NOW });
  addFolder(state, { id: 'fPro', parentId: 'manuscript', title: 'Before', now: NOW });
  addFolder(state, { id: 'fInner', parentId: 'fPro', title: 'Inner', now: NOW });
  addDocument(state, { id: 'sIn', parentId: 'fInner', title: 'Inside', body: '', now: NOW });
  addDocument(state, { id: 'sTop', parentId: 'manuscript', title: 'Top', body: '', now: NOW });
  return state;
}

const fileOf = (sceneMeta: Record<string, SceneMeta>): CoherenceFile => ({ ...emptyCoherenceFile(), sceneMeta });

describe('the Story part select (coherence.md §5.2.2, §8)', () => {
  it('names the part the scene would inherit from the nearest folder that declares one', () => {
    const state = project();
    expect(inheritedStoryPartOf(state, fileOf({ fPro: { storyPart: 'prologue' } }), 'sIn')).toBe('prologue');
    expect(inheritedStoryPartOf(state, fileOf({ fPro: { storyPart: 'prologue' }, fInner: { storyPart: 'epilogue' } }), 'sIn')).toBe('epilogue');
    expect(inheritedStoryPartOf(state, fileOf({ fPro: { storyPart: 'prologue' } }), 'sTop')).toBe('main');
    expect(inheritedStoryPartOf(state, undefined, 'sIn')).toBe('main');
  });

  it('ignores the node’s own declaration, so an explicit main still shows what clearing it returns to', () => {
    const state = project();
    const file = fileOf({ fPro: { storyPart: 'prologue' }, sIn: { storyPart: 'main' } });
    expect(inheritedStoryPartOf(state, file, 'sIn')).toBe('prologue');
    expect(file.sceneMeta['sIn']).toEqual({ storyPart: 'main' });
  });

  it('shows what a folder inherits from the folder above it', () => {
    const state = project();
    expect(inheritedStoryPartOf(state, fileOf({ fPro: { storyPart: 'epilogue' }, fInner: { storyPart: 'main' } }), 'fInner')).toBe('epilogue');
  });

  it('labels the three parts in words, and a negative day with a true minus sign', () => {
    expect(['main', 'prologue', 'epilogue'].map((part) => storyPartLabel(part as 'main'))).toEqual(['Main story', 'Prologue', 'Epilogue']);
    expect(dayLabel(-14)).toContain('−14');
    expect(dayLabel(-14)).not.toContain('-');
    expect(dayLabel(0)).toContain('0');
    expect(dayLabel(3650)).toContain('3,650');
    expect(dayLabel(-10_000_000)).toContain('−10,000,000');
  });

  it('translates the labels after activation', async () => {
    await activateCatalogue('en-XA');
    expect(storyPartLabel('prologue')).toContain('⟦');
    expect(dayLabel(5)).toContain('⟦');
  });
});
