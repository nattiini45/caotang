import { expect, test } from '@playwright/test';

import { resolveKey, shortcutLabel, type KeyFacts } from '../../apps/desktop/src/app/keymap.js';
import {
  cardsOf,
  planCardDrop,
  resolveScope,
  scopePath,
  zoneForCard,
} from '../../apps/desktop/src/app/corkboard-model.js';

import { IDS, project } from './fixtures.js';

function keys(key: string, mods: Partial<Omit<KeyFacts, 'key'>> = {}): KeyFacts {
  return { key, ctrl: false, meta: false, shift: false, alt: false, ...mods };
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
