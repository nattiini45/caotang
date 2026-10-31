/**
 * The Source tab's element menu, as plain data (screenplay.md §3, "element palette"). The menu lists the elements a line of
 * a scene can be, marks the one the caret's line is, and offers each with the edit that rewrites the line as that element.
 * The rewriting is the screenplay engine's (`convertLine`), so the menu and the parser agree on what each line is.
 *
 * It is an editor affordance over the parse layer, not a command: the edit is ordinary text, and it reaches the store the
 * way typing does, through the autosave. Nothing here touches the store, the session or the DOM.
 */

import { t } from '@lingui/core/macro';
import { layoutLetter, printedKeyLabel, shortcutNames, type KeyboardLayoutMap } from '../app/keymap.js';
import { LINE_ELEMENT_TYPES, convertLine, lineElementAt, type LineConversion, type LineElementType } from './engines.js';


/* lingui-set comment="Screenplay element chords. Interpolated values: label is a modifier key combination; last is the number of the last element." */
/** The menu's name, which its tests find it by. */
export function elementMenuLabel(): string {
  return t`Element of this line`;
}

/** The words each entry shows. */
export const ELEMENT_LABEL: Readonly<Record<LineElementType, string>> = {
  get scene_heading() {
    return t`Scene heading`;
  },
  get action() {
    return t`Action`;
  },
  get character() {
    return t`Character`;
  },
  get parenthetical() {
    return t`Parenthetical`;
  },
  get dialogue() {
    return t`Dialogue`;
  },
  get transition() {
    return t`Transition`;
  },
  get centered() {
    return t`Centered`;
  },
  get note() {
    return t`Note`;
  },
  get page_break() {
    return t`Page break`;
  },
};

/** One entry: an element, the key that chooses it in the open menu, whether the line is it, and the edit, or `null` when it cannot be. */
export interface ElementEntry {
  readonly type: LineElementType;
  readonly label: string;
  /** The digit that chooses the entry while the menu is open: 1 for the first entry, up to 9. */
  readonly shortcut: string;
  readonly checked: boolean;
  readonly edit: LineConversion | null;
  /** The chord that does the same from the text, as the writer reads it ("Ctrl+Shift+3"). Absent when no platform was given. */
  readonly chord?: string;
}

/** The menu's entries for the line the caret is on, in the order the menu lists them. */
export function elementEntries(text: string, caret: number, platform?: ChordPlatform): ElementEntry[] {
  const current = lineElementAt(text, caret);
  return LINE_ELEMENT_TYPES.map((type, index) => ({
    type,
    label: ELEMENT_LABEL[type],
    shortcut: String(index + 1),
    checked: current === type,
    edit: convertLine(text, caret, type),
    ...(platform === undefined ? {} : { chord: chordLabel(type, platform) }),
  }));
}

/** The platform families a chord is defined for. */
export type ChordPlatform = 'mac' | 'other';

interface ChordFamily {
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  /** The modifiers as the writer reads them, and as `aria-keyshortcuts` spells them. */
  readonly label: string;
  readonly aria: string;
}

/**
 * The chord for the Nth element is this family's modifiers and the Nth digit. One entry per platform, so changing the family
 * is a one-line edit. Ctrl+Alt is AltGr on Windows layouts, and Cmd+Shift+3/4 are macOS screenshots, so neither is used.
 */
const CHORD_FAMILY: Readonly<Record<ChordPlatform, ChordFamily>> = {
  other: { ctrl: true, meta: false, alt: false, shift: true, label: 'Ctrl+Shift', aria: 'Control+Shift' },
  mac: { ctrl: false, meta: true, alt: true, shift: false, label: 'Cmd+Alt', aria: 'Meta+Alt' },
};

/** The platform, from `navigator.userAgentData.platform` and then `navigator.platform`. Anything but macOS gets Ctrl+Shift. */
export function chordPlatform(source: { readonly userAgentData?: { readonly platform?: string }; readonly platform?: string } | undefined): ChordPlatform {
  const named = source?.userAgentData?.platform ?? source?.platform ?? '';
  return named.toLowerCase().startsWith('mac') ? 'mac' : 'other';
}

function chordModifierLabel(platform: ChordPlatform): string {
  const names = shortcutNames();
  return platform === 'mac' ? `Cmd+${names.alt}` : `${names.ctrl}+${names.shift}`;
}

/** The chord of an element as the writer reads it: "Ctrl+Shift+3", or "Cmd+Alt+3" on a Mac. */
export function chordLabel(type: LineElementType, platform: ChordPlatform, layout?: KeyboardLayoutMap | null): string {
  const digit = String(LINE_ELEMENT_TYPES.indexOf(type) + 1);
  return `${chordModifierLabel(platform)}+${printedKeyLabel(digit, layout)}`;
}

/** The whole family as the writer reads it: "Ctrl+Shift+1 to 9". */
export function chordRange(platform: ChordPlatform, layout?: KeyboardLayoutMap | null): string {
  const label = chordModifierLabel(platform);
  const last = LINE_ELEMENT_TYPES.length;
  return t`${label}+${{ first: printedKeyLabel('1', layout) }} to ${{ last: printedKeyLabel(String(last), layout) }}`;
}

/** The chord of an element as `aria-keyshortcuts` spells it. */
export function chordAria(type: LineElementType, platform: ChordPlatform): string {
  return `${CHORD_FAMILY[platform].aria}+${LINE_ELEMENT_TYPES.indexOf(type) + 1}`;
}

/** The parts of a key event the chord reads. A DOM `KeyboardEvent` has all of them. */
export interface ChordEvent {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  readonly isComposing?: boolean;
  getModifierState?(key: string): boolean;
}

/**
 * The element a key event chooses, or `null` when it is not an element chord. The key is the physical digit (`event.code`), so
 * a layout that types a symbol on that key still chooses; the modifiers must be exactly the platform's family. A key held down,
 * a key pressed while an input method composes, and AltGraph (which a layout types characters with) are never a chord.
 */
export function elementChord(event: ChordEvent, platform: ChordPlatform): LineElementType | null {
  if (event.repeat || event.isComposing === true) return null;
  if (event.getModifierState?.('AltGraph') === true) return null;
  const family = CHORD_FAMILY[platform];
  if (event.ctrlKey !== family.ctrl || event.metaKey !== family.meta || event.altKey !== family.alt || event.shiftKey !== family.shift) return null;
  if (event.code.length !== 6 || !event.code.startsWith('Digit')) return null;
  return LINE_ELEMENT_TYPES[event.code.charCodeAt(5) - 49] ?? null;
}

/**
 * Whether a key opens the menu: Ctrl+E, or Cmd+E on macOS, with no other modifier. The letter is read through the app's
 * one layout rule (`layoutLetter`), so the printed ASCII letter wins and a layout that prints another script is read
 * through the physical `KeyE` — Ctrl+У on a Russian keyboard opens it. A key held down, a key pressed while an input
 * method composes, and AltGraph (which a layout types characters with) are never the menu chord.
 */
export function opensElementMenu(event: ChordEvent): boolean {
  if (event.repeat || event.isComposing === true) return false;
  if (event.getModifierState?.('AltGraph') === true) return false;
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return false;
  return layoutLetter(event.key, event.code) === 'e';
}
