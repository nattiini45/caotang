import { expect, test } from '@playwright/test';

import { resolveKey, shortcutLabel, type KeyContext, type KeyFacts } from '../../apps/desktop/src/app/keymap.js';

/**
 * The keymap matrix (modern-interface.md §8.11, §15.1, M8 #309): every chord the keymap knows resolves the same in both shells, and
 * Modern adds its own chords and nothing else. Ctrl+J (Cmd+J) toggles the agent's companion window in Modern only, before the
 * text-field rule (so it works while typing), and yields to a composing input method and to AltGr.
 *
 * The matrix walks every key below with every modifier combination, in every context the app passes, three ways: no shell (every
 * caller today), Classic, and Modern. Classic must equal no shell everywhere; Modern must equal it everywhere except Modern's own
 * chords, listed in MODERN_CHORDS (Ctrl+J, the agent window; Ctrl+K, #310's palette) and MODERN_SHIFT_CHORDS (Ctrl+Shift+N, + New).
 */

const KEYS = [
  'a', 'b', 'e', 'f', 'i', 'j', 'k', 'n', 's', 'y', 'z', 'J', 'K', 'N', 'Z', '1', '9', ' ',
  'Enter', 'Escape', 'Tab', 'F2', 'F6', 'F10', 'Delete', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End',
] as const;

const MODIFIERS = ['ctrl', 'meta', 'shift', 'alt'] as const;

/** Every subset of the modifiers. */
function modifierSets(): Partial<Record<(typeof MODIFIERS)[number], boolean>>[] {
  const sets: Partial<Record<(typeof MODIFIERS)[number], boolean>>[] = [];
  for (let mask = 0; mask < 1 << MODIFIERS.length; mask += 1) {
    sets.push(Object.fromEntries(MODIFIERS.map((name, index) => [name, (mask & (1 << index)) !== 0])));
  }
  return sets;
}

function keys(key: string, mods: Partial<Omit<KeyFacts, 'key'>> = {}): KeyFacts {
  return { key, code: '', altGraph: false, ctrl: false, meta: false, shift: false, alt: false, composing: false, ...mods };
}

const CONTEXTS: Readonly<Record<string, KeyContext>> = {
  elsewhere: { inTextField: false, inBinder: false },
  typing: { inTextField: true, inBinder: false },
  binder: { inTextField: false, inBinder: true },
  'binder, right to left': { inTextField: false, inBinder: true, rtl: true },
  card: { inTextField: false, inBinder: false, inCorkboard: true },
  'agent panel': { inTextField: false, inBinder: false, inAgent: true, agentIntentEmpty: true },
  'agent intent, empty': { inTextField: true, inBinder: false, inAgent: true, inAgentIntent: true, agentIntentEmpty: true },
  'agent intent, typed': { inTextField: true, inBinder: false, inAgent: true, inAgentIntent: true, agentIntentEmpty: false },
};

/** Modern's own chords: the letter with the command modifier alone, and the action. */
const MODERN_CHORDS: Readonly<Record<string, string>> = { j: 'agent-toggle', k: 'palette' };
/** Modern's own chords with the command modifier and Shift: Ctrl+Shift+N (Cmd+Shift+N) opens + New (#483). */
const MODERN_SHIFT_CHORDS: Readonly<Record<string, string>> = { n: 'new-menu' };

function isModernChord(facts: KeyFacts): string | null {
  const command = facts.ctrl || facts.meta;
  if (!command || facts.alt || facts.altGraph || facts.composing === true) return null;
  return (facts.shift ? MODERN_SHIFT_CHORDS : MODERN_CHORDS)[facts.key.toLowerCase()] ?? null;
}

test.describe('the keymap in both shells', () => {
  test('Classic resolves every key exactly as the keymap did before shells, in every context', () => {
    const changed: string[] = [];
    for (const [name, context] of Object.entries(CONTEXTS)) {
      for (const key of KEYS) {
        for (const mods of modifierSets()) {
          const facts = keys(key, mods);
          const before = resolveKey(facts, context);
          const classic = resolveKey(facts, { ...context, shell: 'classic' });
          if (classic !== before) changed.push(`${name} ${JSON.stringify(mods)} ${key}: ${String(before)} → ${String(classic)}`);
        }
      }
    }
    expect(changed).toEqual([]);
  });

  test('Modern adds its own chords and changes nothing else', () => {
    const changed: string[] = [];
    let added = 0;
    for (const [name, context] of Object.entries(CONTEXTS)) {
      for (const key of KEYS) {
        for (const mods of modifierSets()) {
          const facts = keys(key, mods);
          const before = resolveKey(facts, context);
          const modern = resolveKey(facts, { ...context, shell: 'modern' });
          const own = isModernChord(facts);
          if (own !== null) {
            added += 1;
            if (modern !== own) changed.push(`${name} ${JSON.stringify(mods)} ${key}: expected ${own}, got ${String(modern)}`);
          } else if (modern !== before) {
            changed.push(`${name} ${JSON.stringify(mods)} ${key}: ${String(before)} → ${String(modern)}`);
          }
        }
      }
    }
    expect(changed).toEqual([]);
    // Each of Modern's chords (Ctrl+J, Ctrl+K, Ctrl+Shift+N) as Ctrl, Cmd and Ctrl+Cmd, lower and upper case, in every context: the
    // matrix did reach every new chord.
    expect(added).toBe(Object.keys(CONTEXTS).length * (Object.keys(MODERN_CHORDS).length + Object.keys(MODERN_SHIFT_CHORDS).length) * 2 * 3);
  });

  test('the existing chords keep their meaning in both shells', () => {
    const chords: readonly [KeyFacts, KeyContext, string | null][] = [
      [keys('n', { ctrl: true }), CONTEXTS['elsewhere']!, 'new-document'],
      [keys('z', { ctrl: true }), CONTEXTS['elsewhere']!, 'undo'],
      [keys('z', { ctrl: true }), CONTEXTS['typing']!, null],
      [keys('f', { ctrl: true, shift: true }), CONTEXTS['typing']!, 'focus-mode'],
      [keys('f', { ctrl: true, alt: true }), CONTEXTS['typing']!, 'focus-filter'],
      [keys('Enter', { ctrl: true }), CONTEXTS['elsewhere']!, 'open-in-editor'],
      [keys('Enter'), CONTEXTS['agent intent, typed']!, 'agent-send'],
      [keys('Enter', { ctrl: true }), CONTEXTS['agent intent, typed']!, 'agent-steer'],
      [keys('Escape'), CONTEXTS['agent intent, empty']!, 'agent-stop'],
      [keys('Escape'), CONTEXTS['agent intent, typed']!, 'escape'],
      [keys('F2'), CONTEXTS['binder']!, 'rename'],
      [keys('Delete'), CONTEXTS['card']!, 'delete'],
      [keys('ArrowUp', { alt: true }), CONTEXTS['binder']!, 'reorder-up'],
      [keys('ArrowLeft'), CONTEXTS['binder, right to left']!, 'move-right'],
      [keys('F10', { shift: true }), CONTEXTS['card']!, 'open-menu'],
      // The screenplay's and the editor's chords are not the keymap's: they stay free in both shells.
      [keys('e', { ctrl: true }), CONTEXTS['typing']!, null],
      [keys('b', { ctrl: true }), CONTEXTS['typing']!, null],
      [keys('i', { ctrl: true }), CONTEXTS['typing']!, null],
    ];
    for (const shell of [undefined, 'classic', 'modern'] as const) {
      for (const [facts, context, action] of chords) {
        expect(resolveKey(facts, shell === undefined ? context : { ...context, shell }), `${shell ?? 'no shell'}: ${JSON.stringify(facts)}`).toBe(action);
      }
    }
  });

  test('Ctrl+J and Cmd+J toggle the agent window in Modern, while typing too, and mean nothing in Classic', () => {
    for (const mods of [{ ctrl: true }, { meta: true }]) {
      expect(resolveKey(keys('j', mods), { ...CONTEXTS['typing']!, shell: 'modern' })).toBe('agent-toggle');
      expect(resolveKey(keys('j', mods), { ...CONTEXTS['agent intent, typed']!, shell: 'modern' })).toBe('agent-toggle');
      expect(resolveKey(keys('j', mods), { ...CONTEXTS['elsewhere']!, shell: 'modern' })).toBe('agent-toggle');
      expect(resolveKey(keys('j', mods), { ...CONTEXTS['elsewhere']!, shell: 'classic' })).toBeNull();
      expect(resolveKey(keys('j', mods), CONTEXTS['elsewhere']!)).toBeNull();
    }
    // Shift, Alt, or no command modifier: not the chord (Ctrl+Shift+J is developer tools).
    expect(resolveKey(keys('j', { ctrl: true, shift: true }), { ...CONTEXTS['elsewhere']!, shell: 'modern' })).toBeNull();
    expect(resolveKey(keys('j', { ctrl: true, alt: true }), { ...CONTEXTS['elsewhere']!, shell: 'modern' })).toBeNull();
    expect(resolveKey(keys('j'), { ...CONTEXTS['elsewhere']!, shell: 'modern' })).toBeNull();
  });

  test('Ctrl+J yields to a composing input method and to AltGr, and reads through the physical key on another script', () => {
    const modern = { ...CONTEXTS['typing']!, shell: 'modern' as const };
    expect(resolveKey(keys('j', { ctrl: true, composing: true }), modern)).toBeNull();
    expect(resolveKey(keys('j', { ctrl: true, alt: true, altGraph: true }), modern)).toBeNull();
    // Russian: the key labelled J prints "о"; the chord reads the physical KeyJ.
    expect(resolveKey(keys('о', { ctrl: true, code: 'KeyJ' }), modern)).toBe('agent-toggle');
  });

  test('the window’s Close names the chord in the interface’s key names', () => {
    expect(shortcutLabel('agent-toggle')).toBe('Ctrl+J');
  });
});
