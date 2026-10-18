/**
 * The Source tab's element menu, as plain data (screenplay.md §3, "element palette"). The menu lists the elements a line of
 * a scene can be, marks the one the caret's line is, and offers each with the edit that rewrites the line as that element.
 * The rewriting is the screenplay engine's (`convertLine`), so the menu and the parser agree on what each line is.
 *
 * It is an editor affordance over the parse layer, not a command: the edit is ordinary text, and it reaches the store the
 * way typing does, through the autosave. Nothing here touches the store, the session or the DOM.
 */

import { LINE_ELEMENT_TYPES, convertLine, lineElementAt, type LineConversion, type LineElementType } from './engines.js';

/** The menu's name, which its tests find it by. */
export const ELEMENT_MENU_LABEL = 'Element of this line';

/** The words each entry shows. */
export const ELEMENT_LABEL: Readonly<Record<LineElementType, string>> = {
  scene_heading: 'Scene heading',
  action: 'Action',
  character: 'Character',
  parenthetical: 'Parenthetical',
  dialogue: 'Dialogue',
  transition: 'Transition',
  centered: 'Centered',
  note: 'Note',
  page_break: 'Page break',
};

/** One entry: an element, the key that chooses it in the open menu, whether the line is it, and the edit, or `null` when it cannot be. */
export interface ElementEntry {
  readonly type: LineElementType;
  readonly label: string;
  /** The digit that chooses the entry while the menu is open: 1 for the first entry, up to 9. */
  readonly shortcut: string;
  readonly checked: boolean;
  readonly edit: LineConversion | null;
}

/** The menu's entries for the line the caret is on, in the order the menu lists them. */
export function elementEntries(text: string, caret: number): ElementEntry[] {
  const current = lineElementAt(text, caret);
  return LINE_ELEMENT_TYPES.map((type, index) => ({
    type,
    label: ELEMENT_LABEL[type],
    shortcut: String(index + 1),
    checked: current === type,
    edit: convertLine(text, caret, type),
  }));
}

/** Whether a key opens the menu: Ctrl+E, or Cmd+E on macOS, with no other modifier. */
export function opensElementMenu(event: {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'e';
}
