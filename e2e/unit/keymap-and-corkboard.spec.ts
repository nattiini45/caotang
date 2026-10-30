import { expect, test } from '@playwright/test';

import { chordKey, keyFacts, resolveKey, shortcutLabel, type KeyFacts } from '../../apps/desktop/src/app/keymap.js';
import {
  cardsOf,
  planCardDrop,
  resolveScope,
  scopePath,
  zoneForCard,
} from '../../apps/desktop/src/app/corkboard-model.js';

import { IDS, project } from './fixtures.js';

function keys(key: string, mods: Partial<Omit<KeyFacts, 'key'>> = {}): KeyFacts {
  return { key, code: '', altGraph: false, ctrl: false, meta: false, shift: false, alt: false, ...mods };
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

  test('while an input method composes, no key is a shortcut: the Enter that confirms a candidate does not send (#188)', () => {
    const composing = { composing: true } as const;
    expect(resolveKey(keys('Enter', composing), AGENT_INTENT)).toBeNull();
    expect(resolveKey(keys('Enter', { ...composing, ctrl: true }), AGENT_INTENT)).toBeNull();
    expect(resolveKey(keys('Escape', composing), { ...AGENT_INTENT, agentIntentEmpty: true })).toBeNull();
    expect(resolveKey(keys('Escape', composing), TYPING)).toBeNull();
    expect(resolveKey(keys('Enter', composing), CARD)).toBeNull();
    expect(resolveKey(keys('Enter', { ...composing, ctrl: true }), ELSEWHERE)).toBeNull();
    expect(resolveKey(keys('n', { ...composing, ctrl: true }), ELSEWHERE)).toBeNull();
    expect(resolveKey(keys('ArrowDown', composing), BINDER)).toBeNull();
    // The composition over, the same keys mean what they did.
    expect(resolveKey(keys('Enter', { composing: false }), AGENT_INTENT)).toBe('agent-send');
    expect(resolveKey(keys('Enter'), AGENT_INTENT)).toBe('agent-send');
    expect(resolveKey(keys('Enter', { composing: false }), CARD)).toBe('select-card');
  });

  test('on a plain US layout the chords read the key, with or without the physical code', () => {
    expect(resolveKey(keys('z', { code: 'KeyZ', ctrl: true }), ELSEWHERE)).toBe('undo');
    expect(resolveKey(keys('n', { code: 'KeyN', ctrl: true }), ELSEWHERE)).toBe('new-document');
    expect(resolveKey(keys('F', { code: 'KeyF', ctrl: true, shift: true }), ELSEWHERE)).toBe('focus-mode');
    expect(resolveKey(keys('f', { code: 'KeyF', ctrl: true, alt: true }), TYPING)).toBe('focus-filter');
    expect(resolveKey(keys('Enter', { code: 'Enter', ctrl: true }), ELSEWHERE)).toBe('open-in-editor');
    expect(resolveKey(keys('z', { code: 'KeyZ', ctrl: true }), TYPING)).toBeNull();
  });

  test('on a non-Latin layout a chord falls back to the physical key (Russian, Greek, Hebrew, Arabic)', () => {
    // Russian ЙЦУКЕН: Z is я, N is т, F is а.
    expect(resolveKey(keys('я', { code: 'KeyZ', ctrl: true }), ELSEWHERE)).toBe('undo');
    expect(resolveKey(keys('т', { code: 'KeyN', ctrl: true }), BINDER)).toBe('new-document');
    expect(resolveKey(keys('А', { code: 'KeyF', ctrl: true, shift: true }), ELSEWHERE)).toBe('focus-mode');
    expect(resolveKey(keys('а', { code: 'KeyF', ctrl: true, alt: true }), TYPING)).toBe('focus-filter');
    // A field keeps its own undo on any layout.
    expect(resolveKey(keys('я', { code: 'KeyZ', ctrl: true }), TYPING)).toBeNull();
    // Greek, Hebrew and Arabic.
    expect(resolveKey(keys('ζ', { code: 'KeyZ', meta: true }), ELSEWHERE)).toBe('undo');
    expect(resolveKey(keys('מ', { code: 'KeyN', ctrl: true }), ELSEWHERE)).toBe('new-document');
    expect(resolveKey(keys('כ', { code: 'KeyF', ctrl: true, shift: true }), ELSEWHERE)).toBe('focus-mode');
    expect(resolveKey(keys('ى', { code: 'KeyN', ctrl: true }), ELSEWHERE)).toBe('new-document');
    expect(resolveKey(keys('ب', { code: 'KeyF', ctrl: true, shift: true }), ELSEWHERE)).toBe('focus-mode');
    expect(resolveKey(keys('ئ', { code: 'KeyZ', ctrl: true }), ELSEWHERE)).toBe('undo');
    // The fallback adds no chord: a Russian letter on a key that has none, or with no command modifier, is nothing.
    expect(resolveKey(keys('ф', { code: 'KeyA', ctrl: true }), ELSEWHERE)).toBeNull();
    expect(resolveKey(keys('я', { code: 'KeyZ' }), BINDER)).toBeNull();
  });

  test('on a Latin layout the key wins over the physical key (QWERTZ, AZERTY, Dvorak)', () => {
    // German QWERTZ: the key labelled Z sits where US has Y.
    expect(resolveKey(keys('z', { code: 'KeyY', ctrl: true }), ELSEWHERE)).toBe('undo');
    expect(resolveKey(keys('y', { code: 'KeyZ', ctrl: true }), ELSEWHERE)).toBeNull();
    // French AZERTY: the key labelled Z sits where US has W.
    expect(resolveKey(keys('z', { code: 'KeyW', ctrl: true }), ELSEWHERE)).toBe('undo');
    expect(resolveKey(keys('w', { code: 'KeyZ', ctrl: true }), ELSEWHERE)).toBeNull();
    // ASCII punctuation on a letter key keeps its own key: Dvorak types ; where US has Z.
    expect(resolveKey(keys(';', { code: 'KeyZ', ctrl: true }), ELSEWHERE)).toBeNull();
  });

  test('AltGr is never a Ctrl+Alt chord: German and Hungarian Windows keep their typed characters', () => {
    const altGr = { ctrl: true, alt: true, altGraph: true };
    // German Windows: AltGr+Q types @, AltGr+7 and AltGr+0 type { and }.
    expect(resolveKey(keys('@', { code: 'KeyQ', ...altGr }), TYPING)).toBeNull();
    expect(resolveKey(keys('@', { code: 'KeyQ', ...altGr }), ELSEWHERE)).toBeNull();
    expect(resolveKey(keys('{', { code: 'Digit7', ...altGr }), TYPING)).toBeNull();
    expect(resolveKey(keys('}', { code: 'Digit0', ...altGr }), TYPING)).toBeNull();
    // Hungarian Windows: AltGr+F types [, on the key Ctrl+Alt+F reads.
    expect(resolveKey(keys('[', { code: 'KeyF', ...altGr }), TYPING)).toBeNull();
    // Even a layout whose AltGr+F reports f is not the filter chord, nor is AltGr+F with a non-Latin key.
    expect(resolveKey(keys('f', { code: 'KeyF', ...altGr }), TYPING)).toBeNull();
    expect(resolveKey(keys('а', { code: 'KeyF', ...altGr }), ELSEWHERE)).toBeNull();
    // Without AltGraph, Ctrl+Alt+F stays the filter chord.
    expect(resolveKey(keys('f', { code: 'KeyF', ctrl: true, alt: true }), TYPING)).toBe('focus-filter');
  });

  test('the facts are read from a key event, AltGraph included', () => {
    const event = (altGraph: boolean) => ({
      key: 'я',
      code: 'KeyZ',
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      getModifierState: (name: string) => altGraph && name === 'AltGraph',
    });
    expect(keyFacts(event(false))).toEqual({ key: 'я', code: 'KeyZ', altGraph: false, ctrl: true, meta: false, shift: false, alt: false });
    expect(keyFacts(event(true)).altGraph).toBe(true);
    expect(keyFacts({ key: 'z', code: 'KeyZ', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }).altGraph).toBe(false);
    expect(chordKey('Z', 'KeyY')).toBe('z');
    expect(chordKey('я', 'KeyZ')).toBe('z');
    expect(chordKey('é', 'Digit2')).toBe('2');
    expect(chordKey('ö', 'Semicolon')).toBe('ö');
    expect(chordKey('Enter', 'NumpadEnter')).toBe('Enter');
    expect(chordKey('я', '')).toBe('я');
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
