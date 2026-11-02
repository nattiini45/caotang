/**
 * Modern's narrow panels kept to one at a time (modern-interface.md §13; M11, #312), apart from any renderer so the rule is unit-tested.
 *
 * Below 960 px three things open over the page: the binder drawer, Scene info's bottom sheet and the agent's full-height sheet. Each
 * keeps its own state where it already lives: the drawer is the workspace's `openPanel` ('rail'), the agent window is the workspace's
 * `agentOpen` (Classic's drawer and Modern's window share it), and Scene info is its own store (scene-info-store.ts). The workspace's
 * `openPanel` is the one that says which is open (`NarrowPanel` gains 'agent'), so the other two follow it, and it follows them:
 *
 * - The one that opened last wins: an agent request (Ask, Ctrl+J, an empty state's agent request, the palette) opens the agent sheet
 *   over whatever was open; Scene info opening (the title capsule, Edit synopsis) opens the sheet; the binder's button opens the drawer.
 * - Closing the open one (Close, Escape, the scrim, Ask or Ctrl+J again) leaves nothing open.
 * - The Codex is a view of the page in Modern, not a panel: a codex request (a mention chip) that also asks for the narrow rail shows
 *   the Codex view and leaves the drawer closed.
 */

import type { NarrowPanel } from '../../../app/narrow-model.js';
import type { RailTab } from '../regions.js';

export interface NarrowState {
  /** The workspace's open narrow panel. */
  readonly panel: NarrowPanel | null;
  /** The workspace's `agentOpen`. */
  readonly agent: boolean;
  /** Scene info's store: open. */
  readonly info: boolean;
  /** The workspace's rail tab ('codex' is Modern's Codex view). */
  readonly rail: RailTab;
}

/** What to change so the three agree; a field left out is already right. */
export interface NarrowChange {
  readonly panel?: NarrowPanel | null;
  readonly agent?: boolean;
  readonly info?: boolean;
}

/** The panel the writer sees: what is open, whatever the workspace has caught up with. */
export function shownPanel(state: NarrowState): NarrowPanel | null {
  if (state.agent) return 'agent';
  if (state.info) return 'inspector';
  return state.panel === 'rail' ? 'rail' : null;
}

/** The change that brings `next` into agreement, given the state it came from. */
export function syncNarrow(previous: NarrowState, next: NarrowState): NarrowChange {
  const want = wanted(previous, next);
  const change: { panel?: NarrowPanel | null; agent?: boolean; info?: boolean } = {};
  if (want.panel !== next.panel) change.panel = want.panel;
  if (want.agent !== next.agent) change.agent = want.agent;
  if (want.info !== next.info) change.info = want.info;
  return change;
}

function wanted(previous: NarrowState, next: NarrowState): { panel: NarrowPanel | null; agent: boolean; info: boolean } {
  const only = (panel: NarrowPanel | null) => ({ panel, agent: panel === 'agent', info: panel === 'inspector' });
  // Opening wins over everything else in the same change, the agent first (an agent request also clears the panel).
  if (next.agent && !previous.agent) return only('agent');
  if (next.info && !previous.info) return only('inspector');
  if (next.panel !== previous.panel) {
    // A codex request asks for the rail; in Modern the Codex is the page's view, so the drawer stays closed.
    if (next.panel === 'rail' && next.rail === 'codex' && previous.rail !== 'codex') return only(null);
    return only(next.panel);
  }
  if (next.rail === 'codex' && previous.rail !== 'codex' && next.panel === 'rail') return only(null);
  // A sheet that closed by itself closes its panel.
  if (!next.agent && previous.agent && next.panel === 'agent') return only(null);
  if (!next.info && previous.info && next.panel === 'inspector') return only(null);
  // Nothing moved: the one shown stays, and the others agree with it.
  return only(shownPanel(next));
}
