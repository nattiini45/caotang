import { expect, test } from '@playwright/test';

import { childrenOf, planKeyboardMove } from '../../apps/desktop/src/app/binder-model.js';
import { resolveKey, shortcutLabel } from '../../apps/desktop/src/app/keymap.js';
import { hasDivider, splitNotes } from '../../apps/desktop/src/app/notes-model.js';
import { crossedTarget, ringOffset } from '../../apps/desktop/src/app/session-progress.js';
import { IDS, project } from './fixtures.js';

const BINDER = { inTextField: false, inBinder: true };
const CORKBOARD = { inTextField: false, inBinder: false, inCorkboard: true };
const SHELL = { inTextField: false, inBinder: false };

function key(name: string, modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) {
  return { key: name, code: '', altGraph: false, ctrl: modifiers.ctrl === true, meta: false, shift: modifiers.shift === true, alt: modifiers.alt === true };
}

test.describe('the keymap for the filter and the reorder chords (binder-filters §5, ui-modules §2.5, §3.2)', () => {
  test('Ctrl+Alt+F focuses the filter field, and Ctrl+Shift+F stays focus mode', () => {
    expect(resolveKey(key('f', { ctrl: true, alt: true }), SHELL)).toBe('focus-filter');
    expect(resolveKey(key('F', { ctrl: true, shift: true }), SHELL)).toBe('focus-mode');
    expect(shortcutLabel('focus-filter')).toBe('Ctrl+Alt+F');
    expect(shortcutLabel('focus-mode')).toBe('Ctrl+Shift+F');
  });

  test('Alt+arrow reorders in the binder, and reparents with Left and Right', () => {
    expect(resolveKey(key('ArrowUp', { alt: true }), BINDER)).toBe('reorder-up');
    expect(resolveKey(key('ArrowDown', { alt: true }), BINDER)).toBe('reorder-down');
    expect(resolveKey(key('ArrowLeft', { alt: true }), BINDER)).toBe('reparent-out');
    expect(resolveKey(key('ArrowRight', { alt: true }), BINDER)).toBe('reparent-in');
    expect(shortcutLabel('reorder-up')).toBe('Alt+Up');
  });

  test('on a corkboard card, Alt+Left and Alt+Up both move the card earlier, and a bare arrow moves the focus, not the card', () => {
    expect(resolveKey(key('ArrowLeft', { alt: true }), CORKBOARD)).toBe('reorder-up');
    expect(resolveKey(key('ArrowRight', { alt: true }), CORKBOARD)).toBe('reorder-down');
    expect(resolveKey(key('ArrowUp'), CORKBOARD)).toBeNull();
  });

  test('a key typed into a field is never a reorder, and the shell has no arrow chords', () => {
    expect(resolveKey(key('ArrowUp', { alt: true }), { inTextField: true, inBinder: true })).toBeNull();
    expect(resolveKey(key('ArrowUp', { alt: true }), SHELL)).toBeNull();
    expect(resolveKey(key('f', { ctrl: true, alt: true }), { inTextField: true, inBinder: false })).toBe('focus-filter');
  });
});

test.describe('the keyboard move plan (ui-modules §2.5): the drop index convention, and the refusals', () => {
  test('a node at the top cannot move up, and a node at the bottom cannot move down', () => {
    const state = project();
    const siblings = childrenOf(state, IDS.chapterOne);
    const first = siblings[0];
    const last = siblings[siblings.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    if (first === undefined || last === undefined) return;
    expect(planKeyboardMove(state, first.id, 'up')).toEqual({ ok: false, reason: 'same-place' });
    expect(planKeyboardMove(state, last.id, 'down')).toEqual({ ok: false, reason: 'same-place' });
  });

  test('moving a node up or down lands it beside its neighbour, under the same parent', () => {
    const state = project();
    const siblings = childrenOf(state, IDS.chapterOne);
    const second = siblings[1];
    if (second === undefined) throw new Error('the fixture chapter needs two scenes');
    expect(planKeyboardMove(state, second.id, 'up')).toEqual({ ok: true, newParentId: IDS.chapterOne, index: 0 });
    const first = siblings[0];
    if (first === undefined) throw new Error('the fixture chapter needs a scene');
    expect(planKeyboardMove(state, first.id, 'down')).toEqual({ ok: true, newParentId: IDS.chapterOne, index: 1 });
  });

  test('a scene cannot leave its chapter for the manuscript, and a folder moves into the folder before it', () => {
    const state = project();
    const siblings = childrenOf(state, IDS.chapterOne);
    const scene = siblings[0];
    if (scene === undefined) throw new Error('the fixture chapter needs a scene');
    // Out of the chapter would leave the scene directly under the manuscript, which holds chapters only (ui-modules §2.4).
    expect(planKeyboardMove(state, scene.id, 'out')).toEqual({ ok: false, reason: 'chapterless' });

    const second = siblings[1];
    if (second === undefined) throw new Error('the fixture chapter needs two scenes');
    // The scene before the second one is the first scene, and a document holds nothing, so 'in' is refused there.
    expect(planKeyboardMove(state, second.id, 'in')).toEqual({ ok: false, reason: 'not-a-container' });
    expect(planKeyboardMove(state, scene.id, 'in')).toEqual({ ok: false, reason: 'no-target' });
    // Chapter 2 follows Chapter 1, a folder, so 'in' puts it at the end of Chapter 1, which then holds a chapter: a part (#269).
    expect(planKeyboardMove(state, IDS.chapterTwo, 'in')).toEqual({ ok: true, newParentId: IDS.chapterOne, index: 4 });
  });

  test('a folder comes out of a part, and a scene comes out of a chapter into the part it sits in', () => {
    const state = project();
    // Deep is a chapter inside Chapter 1 (a part). Out puts it beside Chapter 1, in the manuscript.
    expect(planKeyboardMove(state, IDS.deep, 'out')).toEqual({ ok: true, newParentId: 'manuscript', index: 1 });
    // Its scene comes out into Chapter 1, after Deep: a part may hold a scene, as an interlude.
    expect(planKeyboardMove(state, IDS.deepScene, 'out')).toEqual({ ok: true, newParentId: IDS.chapterOne, index: 4 });
  });

  test('a section is a fixed root and cannot be moved at all', () => {
    expect(planKeyboardMove(project(), 'manuscript', 'down')).toEqual({ ok: false, reason: 'fixed-root' });
  });
});

test.describe('the one-shot target notice and the session ring (goals-progress §2.1)', () => {
  test('the notice is given once, on the reading that first meets the target, and again only on a new day', () => {
    expect(crossedTarget({ met: false, day: null }, { met: true, day: '2026-10-08' })).toBe(true);
    expect(crossedTarget({ met: true, day: '2026-10-08' }, { met: true, day: '2026-10-08' })).toBe(false);
    expect(crossedTarget({ met: false, day: '2026-10-08' }, { met: true, day: '2026-10-08' })).toBe(false);
    expect(crossedTarget({ met: false, day: '2026-10-07' }, { met: true, day: '2026-10-08' })).toBe(true);
    expect(crossedTarget({ met: true, day: null }, { met: false, day: '2026-10-08' })).toBe(false);
  });

  test('the ring offset empties as the share fills, and clamps outside zero to one', () => {
    expect(ringOffset(0, 100)).toBe(100);
    expect(ringOffset(0.25, 100)).toBe(75);
    expect(ringOffset(1, 100)).toBe(0);
    expect(ringOffset(3, 100)).toBe(0);
    expect(ringOffset(-1, 100)).toBe(100);
  });
});

test.describe('the notes divider (ui-modules §4.1, notes.append)', () => {
  test('the agent divider is a separator, and the writer’s lines around it are text runs', () => {
    const notes = 'First thought.\n\n— agent, 2026-10-08\nThe agent’s note.\n\nAfter that.';
    expect(splitNotes(notes)).toEqual([
      { kind: 'text', text: 'First thought.' },
      { kind: 'divider', date: '2026-10-08' },
      { kind: 'text', text: 'The agent’s note.\n\nAfter that.' },
    ]);
    expect(hasDivider(notes)).toBe(true);
  });

  test('notes with no divider are one run, and a divider-shaped line that is not the agent’s is text', () => {
    expect(splitNotes('Just a note.')).toEqual([{ kind: 'text', text: 'Just a note.' }]);
    expect(hasDivider('— agent, not a date')).toBe(false);
    expect(splitNotes('')).toEqual([]);
  });
});
