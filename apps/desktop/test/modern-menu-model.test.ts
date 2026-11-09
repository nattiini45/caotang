import { checkMachine } from '@caotang/machine/testing';
import { describe, expect, it } from 'vitest';

import { menuMachine, menuStep, menuTable, type MenuEvent, type MenuState } from '../src/components/shell/modern/menu-model.js';

const states: MenuState[] = [0, 1, 2].flatMap((opening) => [
  { kind: 'closed', opening },
  { kind: 'open', opening },
  { kind: 'closing', opening },
]);
const events: MenuEvent[] = [
  { type: 'open' },
  { type: 'close' },
  { type: 'toggle' },
  { type: 'closed', opening: 0 },
  { type: 'closed', opening: 1 },
  { type: 'closed', opening: 2 },
];

describe('the Modern menu phase machine', () => {
  it('checks every phase and event, including current and stale animation completions', () => {
    expect(menuTable.initial).toBe('closed');
    expect(menuTable.final).toEqual([]);
    expect(checkMachine(menuMachine, { states, events })).toEqual([]);
  });

  it('only starts closing an open menu, and ignores repeated dismissals', () => {
    const closed: MenuState = { kind: 'closed', opening: 0 };
    expect(menuStep(closed, { type: 'close' })).toBe(closed);
    const open = menuStep(closed, { type: 'open' });
    expect(open).toEqual({ kind: 'open', opening: 1 });
    const closing = menuStep(open, { type: 'close' });
    expect(closing).toEqual({ kind: 'closing', opening: 1 });
    expect(menuStep(closing, { type: 'close' })).toBe(closing);
    expect(menuStep(closing, { type: 'closed', opening: 1 })).toEqual({ kind: 'closed', opening: 1 });
  });

  it('toggles closed to open to closing, then reopens immediately during a close', () => {
    let state: MenuState = { kind: 'closed', opening: 0 };
    for (const expected of [
      { kind: 'open', opening: 1 },
      { kind: 'closing', opening: 1 },
      { kind: 'open', opening: 2 },
    ]) {
      state = menuStep(state, { type: 'toggle' });
      expect(state).toEqual(expected);
    }
    expect(menuStep(state, { type: 'closed', opening: 1 })).toBe(state);
    const closing = menuStep(state, { type: 'close' });
    expect(menuStep(closing, { type: 'closed', opening: 1 })).toBe(closing);
    expect(menuStep(closing, { type: 'closed', opening: 2 })).toEqual({ kind: 'closed', opening: 2 });
  });

  it('gives each explicit opening a fresh key, including a shortcut while already open', () => {
    for (const state of states) {
      expect(menuStep(state, { type: 'open' })).toEqual({ kind: 'open', opening: state.opening + 1 });
    }
  });

  it('keeps the same object for every unlisted event and every obsolete completion', () => {
    for (const state of states) {
      for (const event of events) {
        if (menuTable.on[state.kind][event.type] === undefined || (event.type === 'closed' && event.opening !== state.opening)) {
          expect(menuStep(state, event)).toBe(state);
        }
      }
    }
  });
});
