/**
 * The one New (app/new-menu.ts, #477) and the views' order (components/shell/modern/views.ts, #475, #482): what New lists, where
 * it puts things, and how a hall reorders both without dropping anything.
 */
import { addDocument, addFolder, createEmptyManifest, createProjectState, type ProjectState } from '@caotang/store';
import { beforeEach, describe, expect, it } from 'vitest';

import { NEW_KINDS, chapterOf, newGroups, newPlan, newTarget, orderNewKinds } from '../src/app/new-menu.js';
import { ORNAMENT_VIEWS, orderViews } from '../src/components/shell/modern/views.js';
import { activateEnglish } from '../src/i18n/runtime.js';

const NOW = new Date(Date.UTC(2026, 10, 6, 10, 0, 0));

function project(): ProjectState {
  const state = createProjectState(createEmptyManifest('Harbour Book', NOW), { now: NOW });
  addFolder(state, { id: 'fOne', parentId: 'manuscript', title: 'Chapter 1', now: NOW });
  addDocument(state, { id: 'sOne', parentId: 'fOne', title: 'Dawn', body: '', now: NOW });
  addFolder(state, { id: 'fTwo', parentId: 'manuscript', title: 'Chapter 2', now: NOW });
  addDocument(state, { id: 'sTwo', parentId: 'fTwo', title: 'Pier', body: '', now: NOW });
  addDocument(state, { id: 'sNote', parentId: 'research', title: 'Timetable', body: '', now: NOW });
  return state;
}

beforeEach(() => activateEnglish());

describe('the New list', () => {
  it('lists every kind once, prose first, then script and story', () => {
    const groups = newGroups();
    expect(groups.map((group) => group.id)).toEqual(['write', 'script']);
    expect(groups.flatMap((group) => group.entries.map((entry) => entry.kind))).toEqual([...NEW_KINDS]);
    expect(groups[1]?.entries.map((entry) => entry.label)).toEqual(['Screenplay scene', 'Dialogue (Ink)', 'Storyboard', 'Comic']);
    expect(groups.flatMap((group) => group.entries).every((entry) => entry.testId === `new-${entry.kind}` && entry.detail.length > 0)).toBe(true);
  });

  it('a hall reorders the kinds but never drops one', () => {
    expect(orderNewKinds(['comic', 'nope', 'comic', 'scene'])).toEqual(['comic', 'scene', 'chapter', 'screenplay', 'dialogue', 'storyboard']);
    expect(newGroups(['comic'])[1]?.entries[0]?.kind).toBe('comic');
  });
});

describe('where New puts things', () => {
  it('goes into the selection’s chapter, else the open document’s', () => {
    const state = project();
    expect(newTarget(state, 'sTwo', 'sOne')?.id).toBe('fTwo');
    expect(newTarget(state, 'fOne', null)?.id).toBe('fOne');
    expect(newTarget(state, null, 'sOne')?.id).toBe('fOne');
    expect(newTarget(state, 'sNote', 'sTwo')?.id).toBe('fTwo');
    expect(newTarget(state, null, null)).toBeNull();
  });

  it('never takes a storyboard or comic book as a chapter', () => {
    const state = project();
    addFolder(state, { id: 'fBoard', parentId: 'fOne', title: 'Board', now: NOW });
    const board = state.manifest.tree.find((node) => node.id === 'fBoard');
    if (board !== undefined) board.kind = 'storyboard';
    expect(chapterOf(state, 'fBoard')?.id).toBe('fOne');
  });

  it('makes a chapter first when there is none to go into', () => {
    const state = project();
    const plan = newPlan(state, 'comic', null, 'en');
    expect(plan).toEqual([
      { parentId: 'manuscript', spec: { type: 'folder', title: 'Chapter 3' } },
      { parentId: '$chapter', spec: { type: 'folder', kind: 'comic', title: 'Untitled comic' } },
    ]);
  });

  it('puts each kind into the target chapter, and a chapter beside it', () => {
    const state = project();
    const target = newTarget(state, 'sOne', null);
    expect(newPlan(state, 'screenplay', target, 'en')).toEqual([{ parentId: 'fOne', spec: { type: 'document', kind: 'screenplay', title: 'Untitled scene' } }]);
    expect(newPlan(state, 'dialogue', target, 'en')[0]?.spec).toEqual({ type: 'dialogue', kind: 'branching', title: 'Untitled dialogue' });
    expect(newPlan(state, 'chapter', target, 'en')).toEqual([{ parentId: 'manuscript', spec: { type: 'folder', title: 'Chapter 3' } }]);
  });
});

describe('the views bar', () => {
  it('shows all five views, and a hall only reorders them', () => {
    expect(ORNAMENT_VIEWS).toEqual(['write', 'board', 'timeline', 'codex', 'pictures']);
    expect(orderViews()).toEqual([...ORNAMENT_VIEWS]);
    expect(orderViews(['pictures', 'x', 'pictures'])).toEqual(['pictures', 'write', 'board', 'timeline', 'codex']);
  });
});
