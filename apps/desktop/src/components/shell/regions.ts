/**
 * The regions a shell arranges — modern-interface.md §4.1. `Workspace` keeps every piece of state and every handler; its render
 * builds the feature elements once and hands them, with the shell actions and the view state, to a shell component. A shell
 * decides where each region goes and never re-implements what is inside one, so switching shells re-parents the same instances.
 */

import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';

import type { NarrowPanel } from '../../app/narrow-model.js';
import type { ShellAction } from '../../app/shell-actions.js';
import type { CenterMode } from '../Binder.js';
import type { MenuAnchor } from '../shared.js';

export type RailTab = 'binder' | 'codex' | 'activity' | 'trace' | 'findings';

/** The view state a shell needs to arrange the regions, with the setters that change it. The state itself lives in `Workspace`. */
export interface ShellView {
  readonly rail: RailTab;
  readonly setRail: (tab: RailTab) => void;
  readonly center: CenterMode;
  readonly setCenter: (mode: CenterMode) => void;
  readonly focusMode: boolean;
  /** Focus mode is on and the Writing setting hides the rails with it (ui-modules §5.2). */
  readonly hideRails: boolean;
  /** The window is below 960 px (`NARROW_QUERY`). */
  readonly narrow: boolean;
  readonly agentOpen: boolean;
  /** The narrow layout's open panel (ui-modules §1), or `null`. Always `null` in a wide window and while the rails are hidden. */
  readonly openPanel: NarrowPanel | null;
  readonly setPanel: (panel: NarrowPanel | null) => void;
  /** Where the narrow layout's More menu is open, or `null` while it is closed. */
  readonly overflow: MenuAnchor | null;
  readonly openOverflow: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly closeOverflow: () => void;
}

export interface ShellRegions {
  readonly projectName: string;
  /** The shell actions (app/shell-actions.ts), in order. */
  readonly actions: readonly ShellAction[];
  readonly view: ShellView;
  /** The rail's tab panels: the binder with its footer, the codex, findings, activity and the trace. */
  readonly binder: ReactNode;
  readonly codex: ReactNode;
  readonly findings: ReactNode;
  /** The open findings, which the Findings tab shows as a count. */
  readonly findingsBadge: number;
  readonly activity: ReactNode;
  readonly trace: ReactNode;
  readonly inspector: ReactNode;
  /** The editor, kept mounted while another view is shown so its undo history, caret and scroll survive. */
  readonly editor: ReactNode;
  readonly corkboard: ReactNode;
  /** The timeline view (timeline.md), a lazy chunk the shell shows inside a loading boundary. */
  readonly timeline: ReactNode;
  /** The picture board (pictures.md §7), a lazy chunk the shell shows inside a loading boundary. */
  readonly pictures: ReactNode;
  /** A media node's own view (a screenplay scene, a storyboard, a dialogue), or its "Open on desktop", or `null`. */
  readonly media: ReactNode;
  readonly agent: ReactNode;
  /** The storage banner, or `null` when it is not shown. */
  readonly storageBanner: ReactNode;
  /** The picture-aware storage notices (pictures.md §6.5), shown only while the general banner is not. */
  readonly pictureNotices: ReactNode;
  /** The status line, or `null` when there is no message. */
  readonly status: ReactNode;
  readonly saveState: ReactNode;
}
