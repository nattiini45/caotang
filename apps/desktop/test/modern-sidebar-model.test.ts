/**
 * The binder tab bar and sidebar's rules (components/shell/modern/sidebar-model.ts; modern-interface.md §7.2, §8.5) and the minimap's
 * dots (components/shell/minimap.ts): the tabs and their keys, which tab Binder, Findings and Agent open, the delays, when the sidebar may
 * close, and the pin kept in local storage.
 */
import type { ProjectState, TreeNode } from '@caotang/store';
import { checkMachine } from '@caotang/machine/testing';
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
  agentTab,
  openerOf,
  readBinderPinned,
  setBinderPinned,
  sidebarTabFor,
  sidebarMachine,
  sidebarReducer,
  subscribeBinderPinned,
  writeBinderPinned,
  type PinStore,
  type SidebarState,
  type SidebarEvent,
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

  it('Agent opens the agent log shown last, and Activity the first time (#479)', () => {
    expect(agentTab(null)).toBe('activity');
    expect(agentTab('binder')).toBe('activity');
    expect(agentTab('trace')).toBe('trace');
    expect(agentTab('activity')).toBe('activity');
  });

  it('each tab belongs to one opener: Binder, Findings, or Agent for both logs', () => {
    expect(openerOf('binder')).toBe('binder');
    expect(openerOf('findings')).toBe('findings');
    expect(openerOf('activity')).toBe('agent');
    expect(openerOf('trace')).toBe('agent');
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

describe('the sidebar lifecycle', () => {
  const closed: SidebarState = { kind: 'closed', intent: 'none' };
  const elapsed: SidebarEvent = { type: 'close-elapsed', focusInside: false, pointerInside: false };

  it('agrees with its table for every phase, event and guarded outcome', () => {
    expect(checkMachine(sidebarMachine, {
      states: [closed, { kind: 'closed', intent: 'hover' }, { kind: 'opened-hover' }, { kind: 'opened-press' },
        { kind: 'pinned' }, { kind: 'closing', by: 'hover' }, { kind: 'closing', by: 'press' }],
      events: [{ type: 'hover' }, { type: 'hover-elapsed' }, { type: 'enter' }, { type: 'leave' }, elapsed,
        { ...elapsed, focusInside: true }, { ...elapsed, pointerInside: true },
        { type: 'press', toggle: true }, { type: 'press', toggle: false }, { type: 'open' },
        { type: 'pin', pinned: true }, { type: 'pin', pinned: false }, { type: 'escape' }, { type: 'scene-chosen' }],
    })).toEqual([]);
  });

  it('cancels hover intent when the pointer leaves or a press takes over', () => {
    const pending = sidebarReducer(closed, { type: 'hover' });
    expect(pending).toEqual({ kind: 'closed', intent: 'hover' });
    expect(sidebarReducer(pending, { type: 'hover-elapsed' })).toEqual({ kind: 'opened-hover' });
    const left = sidebarReducer(pending, { type: 'leave' });
    expect(sidebarReducer(left, { type: 'hover-elapsed' })).toBe(left);
    const pressed = sidebarReducer(pending, { type: 'press', toggle: true });
    expect(pressed).toEqual({ kind: 'opened-press' });
    expect(sidebarReducer(pressed, { type: 'hover-elapsed' })).toBe(pressed);
  });

  it('keeps pending hover intent when the bar entry arrives before the containing nav entry', () => {
    const pending = sidebarReducer(closed, { type: 'hover' });
    const entered = sidebarReducer(pending, { type: 'enter' });
    expect(entered).toBe(pending);
    expect(sidebarReducer(entered, { type: 'hover-elapsed' })).toEqual({ kind: 'opened-hover' });
  });

  it('a press takes over a hover-open, including during its delayed close, and the next press closes', () => {
    for (const state of [{ kind: 'opened-hover' }, { kind: 'closing', by: 'hover' }] as const) {
      const pressed = sidebarReducer(state, { type: 'press', toggle: true });
      expect(pressed.kind).toBe('opened-press');
      expect(sidebarReducer(pressed, { type: 'press', toggle: true })).toEqual(closed);
      expect(sidebarReducer(pressed, { type: 'press', toggle: false }).kind).toBe('opened-press');
    }
  });

  it('delays closing, rechecks pointer and focus, and cancels the pending close on reentry or an external open', () => {
    for (const kind of ['opened-hover', 'opened-press'] as const) {
      const state: SidebarState = { kind };
      const closing = sidebarReducer(state, { type: 'leave' });
      expect(closing.kind).toBe('closing');
      expect(sidebarReducer(closing, elapsed)).toEqual(closed);
      expect(sidebarReducer(closing, { ...elapsed, focusInside: true })).toEqual(state);
      expect(sidebarReducer(closing, { ...elapsed, pointerInside: true })).toEqual(state);
      const entered = sidebarReducer(closing, { type: 'enter' });
      expect(entered).toEqual(state);
      expect(sidebarReducer(entered, elapsed)).toBe(entered);
      const reopened = sidebarReducer(closing, { type: 'open' });
      expect(reopened.kind).toBe('opened-press');
      expect(sidebarReducer(reopened, elapsed)).toBe(reopened);
    }
  });

  it('pinning cancels a pending close, and unpinning keeps the sidebar deliberately open', () => {
    const pinned = sidebarReducer({ kind: 'closing', by: 'hover' }, { type: 'pin', pinned: true });
    expect(pinned.kind).toBe('pinned');
    for (const event of [elapsed, { type: 'leave' }, { type: 'escape' }, { type: 'scene-chosen' }] as const) {
      expect(sidebarReducer(pinned, event)).toBe(pinned);
    }
    const unpinned = sidebarReducer(pinned, { type: 'pin', pinned: false });
    expect(unpinned.kind).toBe('opened-press');
    expect(sidebarReducer(unpinned, { type: 'scene-chosen' })).toEqual(closed);
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
