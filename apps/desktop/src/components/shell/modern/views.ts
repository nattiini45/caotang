/**
 * Modern's views (modern-interface.md §6, §7.2, §7.3): **Write**, **Board** and **Codex** in the bottom ornament, and the two other
 * Classic centre views (the timeline and the pictures), which **⋯** reaches. Pure, and read from the view state `Workspace` already
 * keeps, so nothing is added to it:
 *
 * - Write is the centre's `editor`, Board its `corkboard`, and the timeline and the pictures are themselves.
 * - Codex is the rail's `codex` tab. In Classic that tab shows `CodexPanel` in the rail; Modern's sidebar has no Codex tab (§7.2), so
 *   the same state shows the same `CodexPanel` on the page. Opening a codex entry from anywhere (`openCodexEntry`, a mention chip)
 *   already selects that tab, so it opens the Codex view on that entry with no Modern code of its own.
 */

import type { CenterMode } from '../../Binder.js';
import type { RailTab, ShellView } from '../regions.js';
import type { ModernView } from './layout.js';

/** The bottom ornament's radio group, in order. */
export const ORNAMENT_VIEWS = ['write', 'board', 'codex'] as const satisfies readonly ModernView[];
export type OrnamentView = (typeof ORNAMENT_VIEWS)[number];

/** The views **⋯** lists, after the three of the ornament. */
export const MENU_VIEWS = ['timeline', 'pictures'] as const satisfies readonly ModernView[];

const CENTER_OF: Readonly<Record<Exclude<ModernView, 'codex'>, CenterMode>> = {
  write: 'editor',
  board: 'corkboard',
  timeline: 'timeline',
  pictures: 'pictures',
};

/** The Classic id a view's radio keeps (Classic's `center-editor`, `center-corkboard`), so tests and links still find it. */
export function viewControlId(view: ModernView): string {
  return view === 'codex' ? 'center-codex' : `center-${CENTER_OF[view]}`;
}

/** The view the page shows for the workspace's view state. */
export function modernViewOf(rail: RailTab, center: CenterMode): ModernView {
  if (rail === 'codex') return 'codex';
  switch (center) {
    case 'editor':
      return 'write';
    case 'corkboard':
      return 'board';
    default:
      return center;
  }
}

/** The rail tab to go back to when the Codex view is left: the binder, the tab Modern's sidebar opens on. */
export const RAIL_AFTER_CODEX: RailTab = 'binder';

/** Shows a view, through the workspace's own setters. */
export function chooseView(view: Pick<ShellView, 'rail' | 'setRail' | 'setCenter'>, next: ModernView): void {
  if (next === 'codex') {
    if (view.rail !== 'codex') view.setRail('codex');
    return;
  }
  if (view.rail === 'codex') view.setRail(RAIL_AFTER_CODEX);
  view.setCenter(CENTER_OF[next]);
}
