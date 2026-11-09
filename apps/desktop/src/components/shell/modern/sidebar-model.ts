/**
 * The binder tab bar and sidebar's rules (modern-interface.md §7.2, §8.5), pure so the unit specs read them without React: the
 * sidebar's tabs and their order, which tab **Binder**, **Findings** and **Agent** open (#479), the hover-intent and close delays, when a pointer
 * leaving closes the sidebar, and the pin, a view preference kept in this browser (`caotang.modern.binderPinned`).
 *
 * The pin is also a tiny store (subscribe and read), so the stage's layout (#306's `modernLayout`) can move the page over for a pinned
 * sidebar without reaching into the component.
 */

import { assertNever, type Machine, type MachineTable } from '@caotang/machine';

import type { RailTab } from '../regions.js';

/** The sidebar's own tabs (§7.2). The codex is a view of the page in Modern, not a sidebar tab. */
export type SidebarTab = Exclude<RailTab, 'codex'>;

/** The sidebar's tabs in the order the arrow keys walk them (WAI-ARIA tabs, Classic's keys). */
export const SIDEBAR_TABS: readonly SidebarTab[] = ['binder', 'findings', 'activity', 'trace'];

/** A hover held this long over the tab bar opens the sidebar (§8.5). */
export const HOVER_OPEN_MS = 140;
/** The sidebar closes this long after the pointer leaves it, unless it is pinned or focus is inside it (§8.5). */
export const CLOSE_DELAY_MS = 420;

/** Local storage key of the pin. The value `'true'` means pinned; anything else, or no key, means not pinned. */
export const BINDER_PINNED_KEY = 'caotang.modern.binderPinned';

export function isSidebarTab(tab: RailTab): tab is SidebarTab {
  return (SIDEBAR_TABS as readonly RailTab[]).includes(tab);
}

/** The tab the sidebar shows for the workspace's rail: the codex is the page's view in Modern, so the sidebar falls back to Binder. */
export function sidebarTabFor(rail: RailTab): SidebarTab {
  return isSidebarTab(rail) ? rail : 'binder';
}

/** The tab bar's three openers (#479): Binder, Findings and Agent, the agent's two logs (Activity and Trace) behind one. */
export type SidebarOpener = 'binder' | 'findings' | 'agent';

/** The opener a tab belongs to. */
export function openerOf(tab: SidebarTab): SidebarOpener {
  return tab === 'activity' || tab === 'trace' ? 'agent' : tab;
}

/** The tab **Agent** opens: the agent log shown last, or Activity the first time. */
export function agentTab(lastAgent: SidebarTab | null): SidebarTab {
  return lastAgent === 'trace' ? 'trace' : 'activity';
}

/** Whether a sidebar that is open may close now: never while pinned, while focus is inside, or while the pointer is over it. */
export function mayClose(facts: { readonly pinned: boolean; readonly focusInside: boolean; readonly pointerInside: boolean }): boolean {
  return !facts.pinned && !facts.focusInside && !facts.pointerInside;
}

export type SidebarState =
  | { readonly kind: 'closed'; readonly intent: 'none' | 'hover' }
  | { readonly kind: 'opened-hover' }
  | { readonly kind: 'opened-press' }
  | { readonly kind: 'pinned' }
  | { readonly kind: 'closing'; readonly by: 'hover' | 'press' };

export type SidebarEvent =
  | { readonly type: 'hover' }
  | { readonly type: 'hover-elapsed' }
  | { readonly type: 'enter' }
  | { readonly type: 'leave' }
  | { readonly type: 'close-elapsed'; readonly focusInside: boolean; readonly pointerInside: boolean }
  | { readonly type: 'press'; readonly toggle: boolean }
  | { readonly type: 'open' }
  | { readonly type: 'pin'; readonly pinned: boolean }
  | { readonly type: 'escape' }
  | { readonly type: 'scene-chosen' };

export const sidebarTable: MachineTable<SidebarState, SidebarEvent> = {
  id: 'modern.sidebar',
  initial: 'closed',
  final: [],
  on: {
    closed: {
      hover: ['closed'], 'hover-elapsed': ['closed', 'opened-hover'], enter: ['closed'], leave: ['closed'],
      press: ['opened-press'], open: ['opened-press'], pin: ['pinned', 'opened-press'],
    },
    'opened-hover': {
      leave: ['closing'], press: ['opened-press'], open: ['opened-press'], pin: ['pinned', 'opened-press'],
      escape: ['closed'], 'scene-chosen': ['closed'],
    },
    'opened-press': {
      leave: ['closing'], press: ['closed', 'opened-press'], open: ['opened-press'], pin: ['pinned', 'opened-press'],
      escape: ['closed'], 'scene-chosen': ['closed'],
    },
    pinned: { press: ['pinned'], open: ['pinned'], pin: ['pinned', 'opened-press'] },
    closing: {
      enter: ['opened-hover', 'opened-press'], leave: ['closing'],
      'close-elapsed': ['closed', 'opened-hover', 'opened-press'], press: ['closed', 'opened-press'],
      open: ['opened-press'], pin: ['pinned', 'opened-press'], escape: ['closed'], 'scene-chosen': ['closed'],
    },
  },
};

export function sidebarReducer(state: SidebarState, event: SidebarEvent): SidebarState {
  switch (event.type) {
    case 'hover':
      return state.kind === 'closed' ? { kind: 'closed', intent: 'hover' } : state;
    case 'hover-elapsed':
      return state.kind === 'closed' && state.intent === 'hover' ? { kind: 'opened-hover' } : state;
    case 'enter':
      if (state.kind === 'closing') return { kind: state.by === 'hover' ? 'opened-hover' : 'opened-press' };
      return state.kind === 'closed' ? { kind: 'closed', intent: 'none' } : state;
    case 'leave':
      if (state.kind === 'closed') return { kind: 'closed', intent: 'none' };
      if (state.kind === 'pinned') return state;
      return { kind: 'closing', by: state.kind === 'closing' ? state.by : state.kind === 'opened-hover' ? 'hover' : 'press' };
    case 'close-elapsed':
      if (state.kind !== 'closing') return state;
      return !event.focusInside && !event.pointerInside
        ? { kind: 'closed', intent: 'none' }
        : { kind: state.by === 'hover' ? 'opened-hover' : 'opened-press' };
    case 'press':
      if (state.kind === 'pinned') return state;
      if (event.toggle && (state.kind === 'opened-press' || (state.kind === 'closing' && state.by === 'press'))) {
        return { kind: 'closed', intent: 'none' };
      }
      return { kind: 'opened-press' };
    case 'open':
      return state.kind === 'pinned' ? state : { kind: 'opened-press' };
    case 'pin':
      return { kind: event.pinned ? 'pinned' : 'opened-press' };
    case 'escape':
    case 'scene-chosen':
      return state.kind === 'pinned' || state.kind === 'closed' ? state : { kind: 'closed', intent: 'none' };
    default:
      return assertNever(event);
  }
}

export const sidebarMachine: Machine<SidebarState, SidebarEvent> = { table: sidebarTable, step: sidebarReducer };

/** The part of `Storage` the pin uses. */
export type PinStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function local(): PinStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The stored pin; not pinned when nothing is stored or the store cannot be read. */
export function readBinderPinned(store: PinStore | null = local()): boolean {
  try {
    return store?.getItem(BINDER_PINNED_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Keeps the pin. A store that refuses only loses the memory: the pin still holds for this visit. */
export function writeBinderPinned(pinned: boolean, store: PinStore | null = local()): void {
  try {
    if (pinned) store?.setItem(BINDER_PINNED_KEY, 'true');
    else store?.removeItem(BINDER_PINNED_KEY);
  } catch {
    // Not kept: the pin applies to this visit only.
  }
}

let pinned: boolean | null = null;
const listeners = new Set<() => void>();

/** The pin now (read from storage once, then kept here). */
export function currentBinderPinned(): boolean {
  pinned ??= readBinderPinned();
  return pinned;
}

/** Calls `listener` whenever the pin changes; returns the unsubscribe. */
export function subscribeBinderPinned(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Pins or unpins the sidebar, keeps the choice, and tells every subscriber. */
export function setBinderPinned(next: boolean, store: PinStore | null = local()): void {
  writeBinderPinned(next, store);
  if (pinned === next) return;
  pinned = next;
  for (const listener of listeners) listener();
}
