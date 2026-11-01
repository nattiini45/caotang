/**
 * The binder tab bar and sidebar's rules (components/shell/modern/sidebar-model.ts; modern-interface.md §7.2, §8.5) and the minimap's
 * dots (components/shell/minimap.ts): the tabs and their keys, which tab Manuscript and Panels open, the delays, when the sidebar may
 * close, and the pin kept in local storage.
 */
import type { ProjectState, TreeNode } from '@caotang/store';
import { describe, expect, it } from 'vitest';

import { keyStep } from '../src/components/shell/ClassicShell.js';
import { MINIMAP_MAX, minimapDots } from '../src/components/shell/minimap.js';
import {
  BINDER_PINNED_KEY,
  CLOSE_DELAY_MS,
  HOVER_OPEN_MS,
  SIDEBAR_TABS,
  currentBinderPinned,
  isSidebarTab,
  mayClose,
  panelsTab,
  readBinderPinned,
  setBinderPinned,
  sidebarTabFor,
  subscribeBinderPinned,
  writeBinderPinned,
  type PinStore,
} from '../src/components/shell/modern/sidebar-model.js';

function memory(initial: Record<string, string> = {}): PinStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

describe('the sidebar tabs', () => {
  it('are Binder, Findings, Activity and Trace, in that order; the codex is a view in Modern, not a tab', () => {
    expect(SIDEBAR_TABS).toEqual(['binder', 'findings', 'activity', 'trace']);
    expect(isSidebarTab('codex')).toBe(false);
    expect(sidebarTabFor('codex')).toBe('binder');
    for (const tab of SIDEBAR_TABS) expect(sidebarTabFor(tab)).toBe(tab);
  });

  it('walk with Classic’s keys: arrows wrap, Home and End go to the ends, other keys do nothing', () => {
    expect(keyStep(SIDEBAR_TABS, 'binder', 'ArrowRight')).toBe('findings');
    expect(keyStep(SIDEBAR_TABS, 'binder', 'ArrowDown')).toBe('findings');
    expect(keyStep(SIDEBAR_TABS, 'binder', 'ArrowLeft')).toBe('trace');
    expect(keyStep(SIDEBAR_TABS, 'trace', 'ArrowRight')).toBe('binder');
    expect(keyStep(SIDEBAR_TABS, 'activity', 'Home')).toBe('binder');
    expect(keyStep(SIDEBAR_TABS, 'findings', 'End')).toBe('trace');
    expect(keyStep(SIDEBAR_TABS, 'findings', 'a')).toBeNull();
  });

  it('Panels opens the last other tab shown, and Findings the first time', () => {
    expect(panelsTab(null)).toBe('findings');
    expect(panelsTab('binder')).toBe('findings');
    expect(panelsTab('trace')).toBe('trace');
    expect(panelsTab('activity')).toBe('activity');
  });
});

describe('opening and closing', () => {
  it('hover-intent is 140 ms and the close delay 420 ms', () => {
    expect(HOVER_OPEN_MS).toBe(140);
    expect(CLOSE_DELAY_MS).toBe(420);
  });

  it('the sidebar may close only when it is not pinned, holds no focus and has no pointer over it', () => {
    expect(mayClose({ pinned: false, focusInside: false, pointerInside: false })).toBe(true);
    expect(mayClose({ pinned: true, focusInside: false, pointerInside: false })).toBe(false);
    expect(mayClose({ pinned: false, focusInside: true, pointerInside: false })).toBe(false);
    expect(mayClose({ pinned: false, focusInside: false, pointerInside: true })).toBe(false);
  });
});

describe('the pin', () => {
  it('is "true" under caotang.modern.binderPinned; anything else, nothing, or an unreadable store is not pinned', () => {
    expect(BINDER_PINNED_KEY).toBe('caotang.modern.binderPinned');
    expect(readBinderPinned(memory({ [BINDER_PINNED_KEY]: 'true' }))).toBe(true);
    expect(readBinderPinned(memory({ [BINDER_PINNED_KEY]: '1' }))).toBe(false);
    expect(readBinderPinned(memory())).toBe(false);
    expect(readBinderPinned(null)).toBe(false);
    const broken: PinStore = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(readBinderPinned(broken)).toBe(false);
    expect(() => writeBinderPinned(true, broken)).not.toThrow();
  });

  it('is written as "true" and removed when unpinned', () => {
    const store = memory();
    writeBinderPinned(true, store);
    expect(store.data.get(BINDER_PINNED_KEY)).toBe('true');
    writeBinderPinned(false, store);
    expect(store.data.has(BINDER_PINNED_KEY)).toBe(false);
  });

  it('is a store: setting it tells subscribers once per change, and keeps it', () => {
    const store = memory();
    let calls = 0;
    const stop = subscribeBinderPinned(() => {
      calls += 1;
    });
    const before = currentBinderPinned();
    setBinderPinned(!before, store);
    setBinderPinned(!before, store);
    expect(currentBinderPinned()).toBe(!before);
    expect(calls).toBe(1);
    expect(readBinderPinned(store)).toBe(!before);
    setBinderPinned(before, store);
    expect(calls).toBe(2);
    stop();
    setBinderPinned(!before, store);
    expect(calls).toBe(2);
    setBinderPinned(before, store);
  });
});

describe('the minimap', () => {
  function node(id: string, parentId: string | null, order: number, type: TreeNode['type'], status: string | null = null): TreeNode {
    return { id, parentId, order, type, title: id, status } as unknown as TreeNode;
  }
  function project(tree: TreeNode[]): ProjectState {
    return {
      manifest: {
        tree,
        vocabulary: {
          statuses: [
            { id: 'draft', name: 'Draft', color: '#d97706' },
            { id: 'done', name: 'Done', color: '#16a34a' },
          ],
          labels: [],
        },
      },
    } as unknown as ProjectState;
  }

  it('lists the manuscript’s documents depth first in sibling order, with their status colours and the open one marked', () => {
    const state = project([
      node('root', null, 0, 'root'),
      node('manuscript', 'root', 0, 'root'),
      node('research', 'root', 1, 'root'),
      node('ch2', 'manuscript', 1, 'folder'),
      node('ch1', 'manuscript', 0, 'folder'),
      node('s3', 'ch2', 0, 'document', 'done'),
      node('s2', 'ch1', 1, 'document'),
      node('s1', 'ch1', 0, 'document', 'draft'),
      node('note', 'research', 0, 'document', 'done'),
      node('lost', 'ch1', 2, 'document', 'gone'),
    ]);
    expect(minimapDots(state, 's2')).toEqual([
      { id: 's1', color: '#d97706', current: false },
      { id: 's2', color: null, current: true },
      { id: 'lost', color: null, current: false },
      { id: 's3', color: '#16a34a', current: false },
    ]);
  });

  it(`stops at ${MINIMAP_MAX} dots`, () => {
    const tree = [node('root', null, 0, 'root'), node('manuscript', 'root', 0, 'root')];
    for (let at = 0; at < MINIMAP_MAX + 10; at += 1) tree.push(node(`s${at}`, 'manuscript', at, 'document'));
    expect(minimapDots(project(tree), null)).toHaveLength(MINIMAP_MAX);
    expect(minimapDots(project(tree), null, 3).map((dot) => dot.id)).toEqual(['s0', 's1', 's2']);
  });
});
