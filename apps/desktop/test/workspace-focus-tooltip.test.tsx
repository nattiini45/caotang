/**
 * The Focus button's tooltip names the focus-mode chord through the same translated, layout-aware label the other
 * controls show (`shortcutLabel` over `keyboardLayoutStore`, subscribed as in EditorPane), so a non-Latin layout or a
 * translated interface language reaches the tooltip too (ui-modules §2.5). The visible copy stays "Focus", and
 * `aria-pressed` carries the state, exactly as before.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { shortcutLabel } from '../src/app/keymap.js';

const workspace = readFileSync(fileURLToPath(new URL('../src/components/Workspace.tsx', import.meta.url)), 'utf8');

describe('the Focus button’s tooltip', () => {
  it('builds the title from the translated focus-mode label, not a hard-coded chord', () => {
    expect(workspace).toContain("title={t`Focus mode (${{ shortcut: shortcutLabel('focus-mode', keyboardLayout) }})`}");
    expect(workspace).not.toContain('Focus mode (Ctrl+Shift+F)');
  });

  it('reads the keyboard layout through the same store subscription as EditorPane', () => {
    expect(workspace).toContain('useSyncExternalStore(keyboardLayoutStore.subscribe, keyboardLayoutStore.snapshot)');
    expect(workspace).toContain("keyboardLayoutStore, resolveKey, shortcutLabel } from '../app/keymap.js'");
  });

  it('keeps the visible Focus copy and the pressed state', () => {
    expect(workspace).toContain('aria-pressed={focusMode}');
    expect(workspace).toContain('<Trans>Focus</Trans>');
  });

  it('renders the same English copy as before when no layout is known, and the printed key when one is', () => {
    expect(`Focus mode (${shortcutLabel('focus-mode')})`).toBe('Focus mode (Ctrl+Shift+F)');
    expect(`Focus mode (${shortcutLabel('focus-mode', new Map([['KeyF', 'ф']]))})`).toBe('Focus mode (Ctrl+Shift+Ф)');
  });
});
