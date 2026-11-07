/**
 * The binder tab bar and sidebar's rules (modern-interface.md §7.2, §8.5), pure so the unit specs read them without React: the
 * sidebar's tabs and their order, which tab **Binder**, **Findings** and **Agent** open (#479), the hover-intent and close delays, when a pointer
 * leaving closes the sidebar, and the pin, a view preference kept in this browser (`caotang.modern.binderPinned`).
 *
 * The pin is also a tiny store (subscribe and read), so the stage's layout (#306's `modernLayout`) can move the page over for a pinned
 * sidebar without reaching into the component.
 */

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
