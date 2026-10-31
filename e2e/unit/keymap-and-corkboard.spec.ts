import { expect, test } from '@playwright/test';

import { isImeEnter, resolveKey, shortcutLabel, type KeyFacts } from '../../apps/desktop/src/app/keymap.js';
import {
  cardsOf,
  planCardDrop,
  resolveScope,
  scopePath,
  zoneForCard,
} from '../../apps/desktop/src/app/corkboard-model.js';

import { IDS, project } from './fixtures.js';

function keys(key: string, mods: Partial<Omit<KeyFacts, 'key'>> = {}): KeyFacts {
  return { key, code: '', ctrl: false, meta: false, shift: false, alt: false, composing: false, altGraph: false, ...mods };
}

const BINDER = { inTextField: false, inBinder: true };
const ELSEWHERE = { inTextField: false, inBinder: false };
const TYPING = { inTextField: true, inBinder: true };
const CARD = { inTextField: false, inBinder: false, inCorkboard: true };
const AGENT_INTENT = { inTextField: true, inBinder: false, inAgent: true, inAgentIntent: true };

test.describe('the keyboard map', () => {
  test('a corkboard card selects with Enter or Space, renames with F2, asks to delete with Delete, and opens its menu on Shift+F10', () => {
    expect(resolveKey(keys('Enter'), CARD)).toBe('select-card');
    expect(resolveKey(keys(' '), CARD)).toBe('select-card');
    expect(resolveKey(keys('F2'), CARD)).toBe('rename');
    expect(resolveKey(keys('Delete'), CARD)).toBe('delete');
    expect(resolveKey(keys('F10', { shift: true }), CARD)).toBe('open-menu');
    expect(shortcutLabel('select-card')).toBe('Enter or Space');
    expect(shortcutLabel('open-menu')).toBe('Shift+F10');
  });

  test('the card keys do not leak: Shift+Enter, Shift+F10 outside a card, and the bare arrows on a card are not card actions', () => {
    expect(resolveKey(keys('Enter', { shift: true }), CARD)).toBeNull();
    expect(resolveKey(keys('F10', { shift: true }), ELSEWHERE)).toBeNull();
    expect(resolveKey(keys('F10', { shift: true }), BINDER)).toBeNull();
    expect(resolveKey(keys(' '), ELSEWHERE)).toBeNull();
    expect(resolveKey(keys('Enter'), ELSEWHERE)).toBeNull();
    expect(resolveKey(keys('ArrowDown'), CARD)).toBeNull();
    expect(resolveKey(keys('F2', { ctrl: true }), CARD)).toBeNull();
    expect(resolveKey(keys('Enter', { ctrl: true }), CARD)).toBe('open-in-editor');
    expect(resolveKey(keys(' '), { inTextField: true, inBinder: false, inCorkboard: true })).toBeNull();
  });

  test('the chords work from anywhere the user is not typing', () => {
    expect(resolveKey(keys('n', { ctrl: true }), ELSEWHERE)).toBe('new-document');
    expect(resolveKey(keys('N', { meta: true }), BINDER)).toBe('new-document');
    expect(resolveKey(keys('z', { ctrl: true }), ELSEWHERE)).toBe('undo');
    expect(resolveKey(keys('Enter', { ctrl: true }), ELSEWHERE)).toBe('open-in-editor');
    expect(resolveKey(keys('F', { ctrl: true, shift: true }), ELSEWHERE)).toBe('focus-mode');
    expect(resolveKey(keys('Escape'), TYPING)).toBe('escape');
  });

  test('a key typed into a field is never a shortcut: undo, open and the bare keys yield to it', () => {
    expect(resolveKey(keys('z', { ctrl: true }), TYPING)).toBeNull();
    expect(resolveKey(keys('Enter', { ctrl: true }), TYPING)).toBeNull();
    expect(resolveKey(keys('F2'), TYPING)).toBeNull();
    expect(resolveKey(keys('Delete'), TYPING)).toBeNull();
    expect(resolveKey(keys('ArrowDown'), TYPING)).toBeNull();
  });

  test('the binder keys act only on the binder', () => {
    expect(resolveKey(keys('F2'), BINDER)).toBe('rename');
    expect(resolveKey(keys('Delete'), BINDER)).toBe('delete');
    expect(resolveKey(keys('ArrowUp'), BINDER)).toBe('move-up');
    expect(resolveKey(keys('ArrowDown'), BINDER)).toBe('move-down');
    expect(resolveKey(keys('ArrowLeft'), BINDER)).toBe('move-left');
    expect(resolveKey(keys('ArrowRight'), BINDER)).toBe('move-right');
    expect(resolveKey(keys('F2'), ELSEWHERE)).toBeNull();
    expect(resolveKey(keys('ArrowDown'), ELSEWHERE)).toBeNull();
  });

  test('in a right-to-left interface the binder and card arrows read in reading order, and Up and Down are unchanged', () => {
    const rtl = { ...BINDER, rtl: true };
    expect(resolveKey(keys('ArrowRight'), rtl)).toBe('move-left');
    expect(resolveKey(keys('ArrowLeft'), rtl)).toBe('move-right');
    expect(resolveKey(keys('ArrowUp'), rtl)).toBe('move-up');
    expect(resolveKey(keys('ArrowDown'), rtl)).toBe('move-down');
  });

  test('a modifier that is not part of the map means nothing, rather than something close to it', () => {
    expect(resolveKey(keys('n', { ctrl: true, alt: true }), ELSEWHERE)).toBeNull();
    expect(resolveKey(keys('F2', { ctrl: true }), BINDER)).toBeNull();
    expect(resolveKey(keys('n', { ctrl: true, shift: true }), ELSEWHERE)).toBeNull();
    expect(resolveKey(keys('a'), BINDER)).toBeNull();
  });

  test('in the agent panel, Escape stops a turn only with the Intent box empty, and Enter and Ctrl+Enter send and steer', () => {
    expect(resolveKey(keys('Escape'), { ...AGENT_INTENT, agentIntentEmpty: true })).toBe('agent-stop');
    expect(resolveKey(keys('Escape'), { inTextField: false, inBinder: false, inAgent: true, agentIntentEmpty: true })).toBe('agent-stop');
    // With text in the box, Escape leaves the turn alone.
    expect(resolveKey(keys('Escape'), { ...AGENT_INTENT, agentIntentEmpty: false })).toBe('escape');
    // Outside the panel it is the app's ordinary Escape.
    expect(resolveKey(keys('Escape'), ELSEWHERE)).toBe('escape');
    expect(resolveKey(keys('Enter'), AGENT_INTENT)).toBe('agent-send');
    expect(resolveKey(keys('Enter', { ctrl: true }), AGENT_INTENT)).toBe('agent-steer');
    expect(resolveKey(keys('Enter', { meta: true }), AGENT_INTENT)).toBe('agent-steer');
    // Anywhere else Ctrl+Enter keeps its meaning: a line break in a field, open-in-editor outside one.
    expect(resolveKey(keys('Enter', { ctrl: true }), TYPING)).toBeNull();
    expect(resolveKey(keys('Enter', { ctrl: true }), ELSEWHERE)).toBe('open-in-editor');
  });

  test('the composing fact is isComposing, or the older Windows keyCode 229', () => {
    expect(isImeEnter({ isComposing: true })).toBe(true);
    expect(isImeEnter({ keyCode: 229 })).toBe(true);
    expect(isImeEnter({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(isImeEnter({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(isImeEnter({})).toBe(false);
  });

  test('an Enter that commits an IME candidate is never an app action', () => {
    // Send, steer and open: every Enter chord in the map yields while the candidate window owns the key.
    expect(resolveKey(keys('Enter', { composing: true }), AGENT_INTENT)).toBeNull();
    expect(resolveKey(keys('Enter', { ctrl: true, composing: true }), AGENT_INTENT)).toBeNull();
    expect(resolveKey(keys('Enter', { meta: true, composing: true }), AGENT_INTENT)).toBeNull();
    expect(resolveKey(keys('Enter', { ctrl: true, composing: true }), ELSEWHERE)).toBeNull();
    expect(resolveKey(keys('Enter', { ctrl: true, composing: true }), BINDER)).toBeNull();
    // A card's Enter selects it, so the same Enter while composing must not.
    expect(resolveKey(keys('Enter', { composing: true }), CARD)).toBeNull();
    // Not composing, the same keys keep their meaning.
    expect(resolveKey(keys('Enter'), AGENT_INTENT)).toBe('agent-send');
    expect(resolveKey(keys('Enter', { ctrl: true }), ELSEWHERE)).toBe('open-in-editor');
    expect(resolveKey(keys('Enter'), CARD)).toBe('select-card');
  });

  test('composing does not silence the other keys: only Enter belongs to the input method', () => {
    expect(resolveKey(keys('n', { ctrl: true, composing: true }), ELSEWHERE)).toBe('new-document');
    expect(resolveKey(keys('z', { ctrl: true, composing: true }), ELSEWHERE)).toBe('undo');
    expect(resolveKey(keys('F2', { composing: true }), BINDER)).toBe('rename');
    expect(resolveKey(keys('Delete', { composing: true }), BINDER)).toBe('delete');
    expect(resolveKey(keys('ArrowDown', { composing: true }), BINDER)).toBe('move-down');
    expect(resolveKey(keys('Escape', { composing: true }), ELSEWHERE)).toBe('escape');
    expect(resolveKey(keys(' ', { composing: true }), CARD)).toBe('select-card');
  });

  test('a shortcut on a layout that prints another script resolves through the physical key', () => {
    // ui-modules §2.5 (#189): the printed character is not the Latin letter the chord names, so `code` names it.
    expect(resolveKey(keys('т', { code: 'KeyN', ctrl: true }), ELSEWHERE)).toBe('new-document');
    expect(resolveKey(keys('я', { code: 'KeyZ', ctrl: true }), TYPING)).toBeNull();
    expect(resolveKey(keys('ש', { code: 'KeyF', ctrl: true, shift: true }), ELSEWHERE)).toBe('focus-mode');
    expect(resolveKey(keys('ب', { code: 'KeyF', ctrl: true, alt: true }), ELSEWHERE)).toBe('focus-filter');
    expect(resolveKey(keys('ν', { code: 'KeyN', ctrl: true }), ELSEWHERE)).toBe('new-document');
  });

  test('a shortcut follows the printed ASCII character, not the physical key: AZERTY Z is undo, QWERTZ Z is undo', () => {
    // AZERTY prints `z` on the physical `KeyW`; the shortcut stays with the character the writer sees.
    expect(resolveKey(keys('z', { code: 'KeyW', ctrl: true }), ELSEWHERE)).toBe('undo');
    // QWERTZ swaps Y and Z; `z` is still undo.
    expect(resolveKey(keys('z', { code: 'KeyY', ctrl: true }), ELSEWHERE)).toBe('undo');
    // A named key is never remapped through its code, even were a code to look like a letter.
    expect(resolveKey(keys('Enter', { code: 'NumpadEnter', ctrl: true }), ELSEWHERE)).toBe('open-in-editor');
    expect(resolveKey(keys('F10', { code: 'KeyF', shift: true }), CARD)).toBe('open-menu');
  });

  test('a key typed with AltGraph is a character, never a chord, even though Windows reports Ctrl+Alt', () => {
    // German AltGr+Q is `@`; Hungarian AltGr+F is `[`. Both arrive as Ctrl+Alt and must do nothing.
    expect(resolveKey(keys('@', { code: 'KeyQ', ctrl: true, alt: true, altGraph: true }), TYPING)).toBeNull();
    expect(resolveKey(keys('[', { code: 'KeyF', ctrl: true, alt: true, altGraph: true }), TYPING)).toBeNull();
    // The AltGraph fact wins before the chord, even when the printed key is the chord's own letter.
    expect(resolveKey(keys('f', { code: 'KeyF', ctrl: true, alt: true, altGraph: true }), ELSEWHERE)).toBeNull();
    expect(resolveKey(keys('n', { code: 'KeyN', ctrl: true, altGraph: true }), ELSEWHERE)).toBeNull();
    // Ctrl+Alt without AltGraph keeps the documented filter chord.
    expect(resolveKey(keys('f', { code: 'KeyF', ctrl: true, alt: true }), ELSEWHERE)).toBe('focus-filter');
  });

  test('each action has the label a control shows for it', () => {
    expect(shortcutLabel('agent-send')).toBe('Enter');
    expect(shortcutLabel('agent-steer')).toBe('Ctrl+Enter');
    expect(shortcutLabel('agent-stop')).toBe('Esc');
    expect(shortcutLabel('new-document')).toBe('Ctrl+N');
    expect(shortcutLabel('open-in-editor')).toBe('Ctrl+Enter');
    expect(shortcutLabel('focus-mode')).toBe('Ctrl+Shift+F');
  });
});

test.describe('the corkboard scope', () => {
  test('no scope, or a scope that no longer names a container, shows the manuscript', () => {
    const state = project();
    expect(resolveScope(state, null).id).toBe('manuscript');
    expect(resolveScope(state, IDS.sceneA).id).toBe('manuscript');
    expect(resolveScope(state, 'n_GONE000000').id).toBe('manuscript');
  });

  test('a folder is the scope, and its cards are its children in sibling order', () => {
    const state = project();
    const scope = resolveScope(state, IDS.chapterOne);
    expect(scope.id).toBe(IDS.chapterOne);
    expect(cardsOf(state, scope).map((node) => node.title)).toEqual(['Scene A', 'Scene B', 'Scene C', 'Deep']);
  });

  test('the breadcrumb runs from the manuscript down to the scope', () => {
    const state = project();
    expect(scopePath(state, resolveScope(state, null))).toEqual(['Manuscript']);
    expect(scopePath(state, resolveScope(state, IDS.chapterOne))).toEqual(['Manuscript', 'Chapter 1']);
    expect(scopePath(state, resolveScope(state, IDS.deep))).toEqual(['Manuscript', 'Chapter 1', 'Deep']);
  });

  test('a card drop is the binder drop: a card is placed beside a card, and an empty-area drop appends', () => {
    const state = project();
    expect(planCardDrop(state, IDS.sceneC, { cardId: IDS.sceneA, zone: 'before' })).toEqual({
      ok: true,
      newParentId: IDS.chapterOne,
      index: 0,
    });
    expect(planCardDrop(state, IDS.sceneA, { scopeId: IDS.chapterOne })).toEqual({
      ok: true,
      newParentId: IDS.chapterOne,
      index: 3,
    });
  });

  test('the left and right halves of a card are before and after', () => {
    expect(zoneForCard(0.2)).toBe('before');
    expect(zoneForCard(0.8)).toBe('after');
  });
});
