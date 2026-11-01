import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import {
  CLASSIC_MENU_SECTIONS,
  CLASSIC_TOOLBAR,
  SHELL_ACTION_IDS,
  classicMenu,
  classicToolbarSlot,
  shellActions,
  type ShellActionFacts,
  type ShellActionHandlers,
  type ShellActionId,
} from '../../apps/desktop/src/app/shell-actions.js';

/**
 * The shell actions (app/shell-actions.ts; modern-interface.md §4.2): one list behind Classic's wide toolbar and its narrow More
 * menu. Every surface shows exactly the list: an action no surface shows, or a surface entry the list does not hold, fails here.
 */

const FACTS: ShellActionFacts = { undoLabel: 'Typing', focusMode: false, theme: 'light', folderPicker: true };

/** Handlers that record which action ran, so a surface entry can be traced back to the action it calls. */
function recorder(): { readonly ran: ShellActionId[]; readonly run: ShellActionHandlers } {
  const ran: ShellActionId[] = [];
  const run = Object.fromEntries(SHELL_ACTION_IDS.map((id) => [id, () => ran.push(id)])) as unknown as ShellActionHandlers;
  return { ran, run };
}

const sorted = (ids: readonly string[]): string[] => [...ids].sort();

for (const folderPicker of [true, false]) {
  const where = folderPicker ? 'with a folder picker' : 'without a folder picker';

  test(`the wide toolbar shows every action of the list and nothing else, ${where}`, () => {
    const actions = shellActions({ ...FACTS, folderPicker }, recorder().run);
    const shown = (['start', 'title', 'end'] as const).flatMap((slot) => classicToolbarSlot(actions, slot).map((action) => action.id));
    expect(new Set(shown).size).toBe(shown.length);
    expect(sorted(shown)).toEqual(sorted(actions.map((action) => action.id)));
    // A slot names only ids the list can hold, so the toolbar never draws a button the list does not have.
    for (const ids of Object.values(CLASSIC_TOOLBAR)) for (const id of ids) expect(SHELL_ACTION_IDS).toContain(id);
  });

  test(`the narrow More menu shows every narrow action of the list and nothing else, ${where}`, () => {
    const { ran, run } = recorder();
    const actions = shellActions({ ...FACTS, folderPicker }, run);
    const items = classicMenu(actions);
    expect(items.map((item) => item.key)).toEqual(actions.filter((action) => action.narrow).map((action) => action.id));
    // Each item calls its own action's handler, the same one the toolbar button calls.
    for (const item of items) item.onSelect();
    expect(ran).toEqual(items.map((item) => item.key));
  });
}

test('the list holds the eleven Classic actions, Save to folder only where the browser has a folder picker', () => {
  const ids = shellActions(FACTS, recorder().run).map((action) => action.id);
  expect(ids).toEqual([...SHELL_ACTION_IDS]);
  expect(ids).toHaveLength(11);
  expect(shellActions({ ...FACTS, folderPicker: false }, recorder().run).map((action) => action.id)).toEqual(
    SHELL_ACTION_IDS.filter((id) => id !== 'folder'),
  );
  // Every action exists in the narrow layout: the More menu is where a phone reaches it.
  expect(shellActions(FACTS, recorder().run).every((action) => action.narrow)).toBe(true);
});

test('the More menu reads as it always has: the same words, the same order and the same three rules', () => {
  const items = classicMenu(shellActions(FACTS, recorder().run));
  expect(items.map((item) => [item.label, item.separatorBefore === true])).toEqual([
    ['Projects', false],
    ['Project details', false],
    ['Undo', false],
    ['Focus mode', false],
    ['Skills', true],
    ['Instructions', false],
    ['Compile…', true],
    ['Export bundle', false],
    ['Save to folder', false],
    ['Settings', true],
    ['Dark theme', false],
  ]);
  // Every group has a section, so no action falls outside the menu's rules.
  for (const action of shellActions(FACTS, recorder().run)) {
    expect(CLASSIC_MENU_SECTIONS.some((groups) => groups.includes(action.group))).toBe(true);
  }
});

test('the words and states follow the workspace: undo, focus mode and the theme', () => {
  const byId = (facts: ShellActionFacts) => new Map(shellActions(facts, recorder().run).map((action) => [action.id, action]));

  const idle = byId({ ...FACTS, undoLabel: null });
  expect(idle.get('undo')).toMatchObject({ disabled: true, hint: 'Nothing to undo', shortcut: 'undo' });
  expect(classicMenu([...idle.values()]).find((item) => item.key === 'undo')?.disabled).toBe(true);
  expect(byId(FACTS).get('undo')).toMatchObject({ disabled: false, hint: 'Undo: Typing' });

  expect(byId(FACTS).get('focus')).toMatchObject({ label: 'Focus mode', toolbarLabel: 'Focus', pressed: false, shortcut: 'focus-mode' });
  expect(byId({ ...FACTS, focusMode: true }).get('focus')).toMatchObject({ label: 'Leave focus mode', toolbarLabel: 'Focus', pressed: true });
  // The toolbar's title names the chord through the keymap's own label.
  expect(byId(FACTS).get('focus')?.hint).toBe('Focus mode (Ctrl+Shift+F)');

  expect(byId(FACTS).get('theme')).toMatchObject({ label: 'Dark theme', ariaLabel: 'Dark theme', hint: 'Use the dark theme' });
  expect(byId({ ...FACTS, theme: 'dark' }).get('theme')).toMatchObject({ label: 'Light theme', ariaLabel: 'Light theme', hint: 'Use the light theme' });

  expect(byId(FACTS).get('details')?.hint).toBe('Project details: title, author, language, ISBN and cover');
});

test('the Classic shell draws no action of its own: its toolbar and More menu come from the list', () => {
  const shell = readFileSync(new URL('../../apps/desktop/src/components/shell/ClassicShell.tsx', import.meta.url), 'utf8');
  const workspace = readFileSync(new URL('../../apps/desktop/src/components/Workspace.tsx', import.meta.url), 'utf8');
  const words = shellActions(FACTS, recorder().run).flatMap((action) => [action.label, action.toolbarLabel ?? action.label]);
  for (const source of [shell, workspace]) {
    for (const word of [...words, 'Leave focus mode', 'Light theme', 'Focus']) {
      // A hand-kept button or menu item would carry its words as JSX text or as a string literal.
      expect(source.split('\n').some((row) => row.trim() === word)).toBe(false);
      expect(source).not.toContain(`'${word}'`);
    }
  }
  expect(shell).toContain("classicToolbarSlot(actions, 'start')");
  expect(shell).toContain("classicToolbarSlot(actions, 'end')");
  expect(shell).toContain('items={classicMenu(actions)}');
  expect(workspace).not.toContain('overflowItems');
});
