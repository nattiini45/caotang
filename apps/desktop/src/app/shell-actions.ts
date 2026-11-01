/**
 * The shell actions — modern-interface.md §4.2. One list of the controls a shell offers beyond its panels and views (Projects,
 * Project details, Undo, Focus mode, Skills, Instructions, Compile…, Export bundle, Save to folder, Settings and the theme), and
 * the surfaces that render it: Classic's wide toolbar and Classic's narrow **More** menu (ui-modules §1). Modern's **⋯** menu and
 * the palette render from the same list when they are built.
 *
 * Pure on purpose: the shell turns an action into a button or a menu item, and this module decides what the actions are, in what
 * order, with which words, and where each surface puts them, so a test can hold every surface against the list without a browser.
 */

import { shortcutLabel, type KeyAction } from './keymap.js';
import type { Theme } from './theme.js';

/** Every shell action, in the order the surfaces list them. */
export const SHELL_ACTION_IDS = [
  'projects',
  'details',
  'undo',
  'focus',
  'skills',
  'instructions',
  'compile',
  'bundle',
  'folder',
  'settings',
  'theme',
] as const;

export type ShellActionId = (typeof SHELL_ACTION_IDS)[number];

/** What an action is about. A surface may group by it; Classic's More menu draws a rule between some of the groups. */
export type ShellActionGroup = 'project' | 'writing' | 'agent' | 'output' | 'app';

export interface ShellAction {
  readonly id: ShellActionId;
  /** The visible words: a menu item's label, and a toolbar button's unless `toolbarLabel` is set. */
  readonly label: string;
  /** Shorter words for a toolbar button, where the toolbar has less room than a menu (Classic's **Focus**). */
  readonly toolbarLabel?: string;
  /** The sentence a toolbar button shows as its title: what the action does, with its chord when the toolbar shows one. */
  readonly hint?: string;
  /** An accessible name that a toolbar button sets beside its words (the theme toggle names itself by its words). */
  readonly ariaLabel?: string;
  /** For a toggle: whether it is on now (focus mode). Absent for an action that is not a toggle. */
  readonly pressed?: boolean;
  readonly disabled: boolean;
  /** The chord that does the same anywhere in the workspace, for a surface that shows shortcut labels (keymap.ts). */
  readonly shortcut?: KeyAction;
  readonly group: ShellActionGroup;
  /** Whether the action exists in the narrow layout (below 960 px), where Classic lists it in the More menu. */
  readonly narrow: boolean;
  readonly run: () => void;
}

/** What the actions' words and states depend on, read from the workspace each render. */
export interface ShellActionFacts {
  /** The label of the step Undo would take back, or `null` when there is nothing to undo. */
  readonly undoLabel: string | null;
  readonly focusMode: boolean;
  readonly theme: Theme;
  /** Whether the browser has a folder picker (`folderAccessSupported`): Save to folder exists only where it does. */
  readonly folderPicker: boolean;
}

/** One handler per action. A record, so an action added to the list without a handler does not compile. */
export type ShellActionHandlers = Readonly<Record<ShellActionId, () => void>>;

/** The list, in order. Save to folder is left out where the browser has no folder picker. */
export function shellActions(facts: ShellActionFacts, run: ShellActionHandlers): readonly ShellAction[] {
  const actions: ShellAction[] = [
    { id: 'projects', label: 'Projects', disabled: false, group: 'project', narrow: true, run: run.projects },
    {
      id: 'details',
      label: 'Project details',
      hint: 'Project details: title, author, language, ISBN and cover',
      disabled: false,
      group: 'project',
      narrow: true,
      run: run.details,
    },
    {
      id: 'undo',
      label: 'Undo',
      hint: facts.undoLabel === null ? 'Nothing to undo' : `Undo: ${facts.undoLabel}`,
      disabled: facts.undoLabel === null,
      shortcut: 'undo',
      group: 'writing',
      narrow: true,
      run: run.undo,
    },
    {
      id: 'focus',
      label: facts.focusMode ? 'Leave focus mode' : 'Focus mode',
      toolbarLabel: 'Focus',
      hint: `Focus mode (${shortcutLabel('focus-mode')})`,
      pressed: facts.focusMode,
      disabled: false,
      shortcut: 'focus-mode',
      group: 'writing',
      narrow: true,
      run: run.focus,
    },
    {
      id: 'skills',
      label: 'Skills',
      hint: 'Reusable writing instructions for the agent',
      disabled: false,
      group: 'agent',
      narrow: true,
      run: run.skills,
    },
    {
      id: 'instructions',
      label: 'Instructions',
      hint: 'CAOTANG.md, your standing instructions, and the notes the agent keeps',
      disabled: false,
      group: 'agent',
      narrow: true,
      run: run.instructions,
    },
    { id: 'compile', label: 'Compile…', disabled: false, group: 'output', narrow: true, run: run.compile },
    { id: 'bundle', label: 'Export bundle', disabled: false, group: 'output', narrow: true, run: run.bundle },
    { id: 'folder', label: 'Save to folder', disabled: false, group: 'output', narrow: true, run: run.folder },
    { id: 'settings', label: 'Settings', disabled: false, group: 'app', narrow: true, run: run.settings },
    {
      id: 'theme',
      label: facts.theme === 'dark' ? 'Light theme' : 'Dark theme',
      ariaLabel: facts.theme === 'dark' ? 'Light theme' : 'Dark theme',
      hint: facts.theme === 'dark' ? 'Use the light theme' : 'Use the dark theme',
      disabled: false,
      group: 'app',
      narrow: true,
      run: run.theme,
    },
  ];
  return facts.folderPicker ? actions : actions.filter((action) => action.id !== 'folder');
}

/**
 * Where Classic's wide toolbar puts each action (ui-modules §1): **Projects** at the start, Project details as the project's name
 * (a button whose title says what it opens), and every other action at the end, in the list's order, before the save state.
 */
export const CLASSIC_TOOLBAR = {
  start: ['projects'],
  title: ['details'],
  end: ['undo', 'focus', 'skills', 'instructions', 'compile', 'bundle', 'folder', 'settings', 'theme'],
} as const satisfies Readonly<Record<string, readonly ShellActionId[]>>;

export type ClassicToolbarSlot = keyof typeof CLASSIC_TOOLBAR;

/** The actions of one slot of Classic's wide toolbar, in the slot's order; an action the list does not hold is skipped. */
export function classicToolbarSlot(actions: readonly ShellAction[], slot: ClassicToolbarSlot): readonly ShellAction[] {
  const ids: readonly ShellActionId[] = CLASSIC_TOOLBAR[slot];
  return ids.flatMap((id) => actions.filter((action) => action.id === id));
}

/**
 * The groups that share a section of Classic's More menu. A rule goes above the first item of every section after the first, so
 * the menu reads as it always has: Projects, Project details, Undo and Focus mode together, then the agent's two, then the outputs,
 * then Settings and the theme.
 */
export const CLASSIC_MENU_SECTIONS: readonly (readonly ShellActionGroup[])[] = [['project', 'writing'], ['agent'], ['output'], ['app']];

/** A More menu item (`MenuItem` in components/shared.tsx takes this shape). */
export interface ShellMenuItem {
  readonly key: ShellActionId;
  readonly label: string;
  readonly disabled?: boolean;
  readonly separatorBefore?: boolean;
  readonly onSelect: () => void;
}

/** Classic's narrow **More** menu: the actions that exist in the narrow layout, in the list's order, with a rule between sections. */
export function classicMenu(actions: readonly ShellAction[]): readonly ShellMenuItem[] {
  const sectionOf = (group: ShellActionGroup): number => CLASSIC_MENU_SECTIONS.findIndex((groups) => groups.includes(group));
  let previous: number | null = null;
  return actions
    .filter((action) => action.narrow)
    .map((action) => {
      const section = sectionOf(action.group);
      const separatorBefore = previous !== null && section !== previous;
      previous = section;
      return {
        key: action.id,
        label: action.label,
        ...(action.disabled ? { disabled: true } : {}),
        ...(separatorBefore ? { separatorBefore: true } : {}),
        onSelect: action.run,
      };
    });
}
