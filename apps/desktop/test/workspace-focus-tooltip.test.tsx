/**
 * The Focus button's tooltip names the focus-mode chord through the same translated, layout-aware label the other
 * controls show (`shortcutLabel` over `keyboardLayoutStore`, subscribed as in EditorPane), so a non-Latin layout or a
 * translated interface language reaches the tooltip too (ui-modules §2.5). The visible copy stays "Focus", and
 * `aria-pressed` carries the state, exactly as before. Since #330 the words are the shell actions' (app/shell-actions.ts), the
 * Workspace hands them the layout it subscribes to, and the Classic shell's toolbar button draws them.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { shortcutLabel } from '../src/app/keymap.js';

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const workspace = read('../src/components/Workspace.tsx');
const actions = read('../src/app/shell-actions.ts');
const shell = read('../src/components/shell/ClassicShell.tsx');

describe('the Focus button’s tooltip', () => {
  it('builds the title from the translated focus-mode label, not a hard-coded chord', () => {
    expect(actions).toContain("hint: t`Focus mode (${{ shortcut: shortcutLabel('focus-mode', facts.keyboardLayout) }})`");
    expect(actions).not.toContain('Focus mode (Ctrl+Shift+F)');
    expect(shell).toContain('title={action.hint}');
  });

  it('reads the keyboard layout through the same store subscription as EditorPane', () => {
    expect(workspace).toContain('useSyncExternalStore(keyboardLayoutStore.subscribe, keyboardLayoutStore.snapshot)');
    expect(workspace).toContain("keyboardLayoutStore, resolveKey } from '../app/keymap.js'");
    // The layout reaches the shell actions as one of their facts.
    expect(workspace).toContain('folderPicker: folderAccessSupported(), keyboardLayout }');
  });

  it('keeps the visible Focus copy and the pressed state', () => {
    expect(actions).toContain('pressed: facts.focusMode,');
    expect(shell).toContain('aria-pressed={action.pressed}');
    expect(actions).toContain('toolbarLabel: t`Focus`');
  });

  it('renders the same English copy as before when no layout is known, and the printed key when one is', () => {
    expect(`Focus mode (${shortcutLabel('focus-mode')})`).toBe('Focus mode (Ctrl+Shift+F)');
    expect(`Focus mode (${shortcutLabel('focus-mode', new Map([['KeyF', 'ф']]))})`).toBe('Focus mode (Ctrl+Shift+Ф)');
  });
});
