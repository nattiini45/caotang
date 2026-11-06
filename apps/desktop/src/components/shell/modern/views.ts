/**
 * Modern's views (modern-interface.md §6, §7.2, §7.3): **Write**, **Board**, **Timeline**, **Codex** and **Pictures**, all in the
 * bottom ornament (#475). Pure, and read from the view state `Workspace` already
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

/** The bottom ornament's radio group, in order: every view, always shown (#475). */
export const ORNAMENT_VIEWS = ['write', 'board', 'timeline', 'codex', 'pictures'] as const satisfies readonly ModernView[];
export type OrnamentView = (typeof ORNAMENT_VIEWS)[number];

/**
 * The views in a hall's order (#430's `prominence.views`, #482): the hall's views first, then the rest in the base order. Unknown or
 * repeated names are ignored and nothing is dropped, so every view stays one click away.
 */
export function orderViews(hint?: readonly string[]): ModernView[] {
  const first = (hint ?? []).filter((name, at, all): name is OrnamentView => (ORNAMENT_VIEWS as readonly string[]).includes(name) && all.indexOf(name) === at);
  return [...first, ...ORNAMENT_VIEWS.filter((name) => !first.includes(name))];
}

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
