/**
 * The Source tab's element menu, as plain data (screenplay.md §3, "element palette"). The menu lists the elements a line of
 * a scene can be, marks the one the caret's line is, and offers each with the edit that rewrites the line as that element.
 * The rewriting is the screenplay engine's (`convertLine`), so the menu and the parser agree on what each line is.
 *
 * Beside it are the chords: one per element, and two routes to what the binder keeps about the scene (its section and synopsis),
 * which the Source tab's key handler reads here and hands to the shell.
 *
 * It is an editor affordance over the parse layer, not a command: the edit is ordinary text, and it reaches the store the
 * way typing does, through the autosave. Nothing here touches the store, the session or the DOM.
 */

import { chordKey } from '../app/keymap.js';
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

/** The chord of an element as the writer reads it: "Ctrl+Shift+3", or "Cmd+Alt+3" on a Mac. */
export function chordLabel(type: LineElementType, platform: ChordPlatform): string {
  return `${CHORD_FAMILY[platform].label}+${LINE_ELEMENT_TYPES.indexOf(type) + 1}`;
}

/** The whole family as the writer reads it: "Ctrl+Shift+1 to 9". */
export function chordRange(platform: ChordPlatform): string {
  return `${CHORD_FAMILY[platform].label}+1 to ${LINE_ELEMENT_TYPES.length}`;
}

/** The chord of an element as `aria-keyshortcuts` spells it. */
export function chordAria(type: LineElementType, platform: ChordPlatform): string {
  return `${CHORD_FAMILY[platform].aria}+${LINE_ELEMENT_TYPES.indexOf(type) + 1}`;
}

/** The parts of a key event the chord reads. A DOM `KeyboardEvent` has all of them. */
export interface ChordEvent {
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
 * Whether a key event holds exactly the platform's family, and is a keystroke a chord may take. A key held down, a key pressed while
 * an input method composes, and AltGraph (which a layout types characters with, and which Windows also reports as Ctrl+Alt) never are.
 */
function familyHeld(event: ChordEvent, platform: ChordPlatform): boolean {
  if (event.repeat || event.isComposing === true) return false;
  if (event.getModifierState?.('AltGraph') === true) return false;
  const family = CHORD_FAMILY[platform];
  return event.ctrlKey === family.ctrl && event.metaKey === family.meta && event.altKey === family.alt && event.shiftKey === family.shift;
}

/**
 * The element a key event chooses, or `null` when it is not an element chord. The key is the physical digit (`event.code`), so
 * a layout that types a symbol on that key still chooses; the modifiers must be exactly the platform's family. A key held down,
 * a key pressed while an input method composes, and AltGraph (which a layout types characters with) are never a chord.
 */
export function elementChord(event: ChordEvent, platform: ChordPlatform): LineElementType | null {
  if (!familyHeld(event, platform)) return null;
  if (event.code.length !== 6 || !event.code.startsWith('Digit')) return null;
  return LINE_ELEMENT_TYPES[event.code.charCodeAt(5) - 49] ?? null;
}

/**
 * The two routes from the Source tab to what the binder keeps about the scene (screenplay.md §2.2, §3). A section is a binder
 * folder and a scene's synopsis is the binder's synopsis field, so neither is a line the element menu could write: the routes
 * take the writer to them instead. `section` selects the folder the scene is in and focuses its row in the binder; `synopsis`
 * focuses the scene's synopsis in the inspector.
 */
export type SourceRoute = 'section' | 'synopsis';

/** The letter each route takes after the family's modifiers: S for the section, Y for the synopsis. */
const ROUTE_KEY: Readonly<Record<SourceRoute, string>> = { section: 's', synopsis: 'y' };

/** The routes, in the order the guide and the field's `aria-keyshortcuts` list them. */
export const SOURCE_ROUTES: readonly SourceRoute[] = ['section', 'synopsis'];

/** The parts of a key event a route chord reads: the chord's facts and the typed key. */
export interface RouteChordEvent extends ChordEvent {
  readonly key: string;
}

/**
 * The route a key event asks for, or `null`. The modifiers are the element chords' family, with the same refusals (AltGraph, a held
 * key, a composing input method). The letter is read as the app's chords read it (`chordKey`): the typed letter, so the key labelled
 * Y is Y on QWERTZ too, and the physical key only when the typed one is a character outside ASCII (Option on a Mac types `ß` on S).
 */
export function routeChord(event: RouteChordEvent, platform: ChordPlatform): SourceRoute | null {
  if (!familyHeld(event, platform)) return null;
  const key = chordKey(event.key, event.code);
  return SOURCE_ROUTES.find((route) => ROUTE_KEY[route] === key) ?? null;
}

/** A route's chord as the writer reads it: "Ctrl+Shift+S", or "Cmd+Alt+S" on a Mac. */
export function routeLabel(route: SourceRoute, platform: ChordPlatform): string {
  return `${CHORD_FAMILY[platform].label}+${ROUTE_KEY[route].toUpperCase()}`;
}

/** A route's chord as `aria-keyshortcuts` spells it. */
export function routeAria(route: SourceRoute, platform: ChordPlatform): string {
  return `${CHORD_FAMILY[platform].aria}+${ROUTE_KEY[route].toUpperCase()}`;
}

/**
 * Whether a key opens the menu: Ctrl+E, or Cmd+E on macOS, with no other modifier. The key is read as the app's chords read it
 * (`chordKey`), so the physical E opens it on a non-Latin layout too.
 */
export function opensElementMenu(event: {
  readonly key: string;
  readonly code?: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && chordKey(event.key, event.code ?? '') === 'e';
}
