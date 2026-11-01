/**
 * The companion window's open action, for the controls that open it (modern-interface.md §8.10): **Ask** in the bottom ornament (#306),
 * the palette's "Ask the agent" (#310), and anything else in Modern. It is plain TypeScript with no React, so an ornament imports it
 * without the window's code.
 *
 * The open state is the workspace's own (`ShellView.agentOpen`, set through `ShellView.setAgentOpen`); this module only remembers which
 * control asked, so the window morphs out of it (§8.3). Every `runAgentIntent` caller (an empty state, **Fix with agent**, a finding)
 * opens the window through `agentOpen` too, and the window morphs out of the control that was clicked.
 *
 * **Ask** (#306) uses it like this:
 *
 * ```tsx
 * const ask = askState(regions.view);
 * <button id={ASK_ID} type="button" aria-controls={COMPANION_ID} aria-expanded={ask.expanded} data-activity={ask.activity}
 *   onClick={(event) => toggleCompanion(regions.view, event.currentTarget)}>…</button>
 * ```
 *
 * `ASK_ID` is where focus returns when Escape or **Close** closes the window, and what Ctrl+J morphs out of.
 */

import type { AgentActivity, ShellView } from '../regions.js';

/** The id **Ask** carries (#306): Escape returns focus to it, and the window morphs out of it on Ctrl+J. */
export const ASK_ID = 'modern-ask';
/** The window's id, for `aria-controls`. */
export const COMPANION_ID = 'modern-companion';

/** How long a remembered opener stays the window's origin: the click and the open it causes are one task apart. */
const OPENER_WINDOW_MS = 1500;

let remembered: { readonly element: Element; readonly at: number } | null = null;

/** Remembers the control that is about to open the window, so the window grows out of it. */
export function noteCompanionOpener(element: Element | null): void {
  remembered = element === null ? null : { element, at: Date.now() };
}

/** The control that opened the window just now, if it is still in the document; forgotten once read. */
export function takeCompanionOpener(now: number = Date.now()): Element | null {
  const taken = remembered;
  remembered = null;
  if (taken === null || now - taken.at > OPENER_WINDOW_MS || !taken.element.isConnected) return null;
  return taken.element;
}

/** Opens the window, growing out of `opener` when given. */
export function openCompanion(view: Pick<ShellView, 'setAgentOpen'>, opener: Element | null = null): void {
  noteCompanionOpener(opener);
  view.setAgentOpen(true);
}

/** Opens the window, or closes it when it is open (Ask, Ctrl+J). Closing returns focus to **Ask** when it was in the window. */
export function toggleCompanion(view: Pick<ShellView, 'agentOpen' | 'setAgentOpen'>, opener: Element | null = null): void {
  if (view.agentOpen) view.setAgentOpen(false);
  else openCompanion(view, opener);
}

/** What **Ask** shows: whether the window is open, and what the agent is doing while it may be closed (§8.10). */
export function askState(view: Pick<ShellView, 'agentOpen' | 'agentActivity'>): { readonly expanded: boolean; readonly activity: AgentActivity } {
  return { expanded: view.agentOpen, activity: view.agentActivity };
}
