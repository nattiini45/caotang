/**
 * The regions a shell arranges — modern-interface.md §4.1. `Workspace` keeps every piece of state and every handler; its render
 * builds the feature elements once and hands them, with the shell actions and the view state, to a shell component. A shell
 * decides where each region goes and never re-implements what is inside one, so switching shells re-parents the same instances.
 */

import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';

import type { ProjectState } from '@caotang/store';

import type { NarrowPanel } from '../../app/narrow-model.js';
import type { ShellAction } from '../../app/shell-actions.js';
import type { CenterMode } from '../Binder.js';
import type { SettingsSection } from '../Settings.js';
import type { MenuAnchor } from '../shared.js';

/** What the agent is doing: a turn working, a card waiting for the writer's answer, or nothing. */
export type AgentActivity = 'idle' | 'working' | 'waiting';

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
  /** Opens or closes the agent: Classic's drawer, Modern's companion window (modern-interface.md §8.10). */
  readonly setAgentOpen: (open: boolean) => void;
  /** What the agent is doing, so a control can show a turn that keeps running while the agent is out of sight (§8.10, **Ask**). */
  readonly agentActivity: AgentActivity;
  /** The narrow layout's open panel (ui-modules §1), or `null`. Always `null` in a wide window and while the rails are hidden. */
  readonly openPanel: NarrowPanel | null;
  readonly setPanel: (panel: NarrowPanel | null) => void;
  /** Where the narrow layout's More menu is open, or `null` while it is closed. */
  readonly overflow: MenuAnchor | null;
  readonly openOverflow: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly closeOverflow: () => void;
}

/**
 * What Modern's palette (modern-interface.md §8.9, app/palette-model.ts) searches, and the handlers it runs beyond the shell actions
 * and the view's setters. Each handler is one `Workspace` already uses elsewhere (§4.3 rule 3).
 */
export interface ShellSearch {
  /** The project, for its scenes, folders and codex entries. */
  readonly state: ProjectState;
  /** The document open in the editor, or `null`. */
  readonly activeDocId: string | null;
  /** A binder node chosen: a document opens in the editor, a folder on the board, as choosing it in the binder does. */
  readonly openNode: (nodeId: string) => void;
  /** A codex entry chosen: the codex shows it, as a mention chip does. */
  readonly openCodexEntry: (entryId: string) => void;
  /** The codex without an entry. */
  readonly showCodex: () => void;
  readonly openSettings: (section: SettingsSection) => void;
  /** Opens the agent. With text, the Intent box holds it and nothing is sent. */
  readonly openAgent: (text: string | null) => void;
  /** Shows the selected node's scene info (the inspector), on its synopsis. */
  readonly openSceneInfo: () => void;
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
  /** The agent panel as Classic's drawer, at the foot of the centre. */
  readonly agent: ReactNode;
  /** The same agent panel for a window of its own (`placement="window"`): always open, with **Close** in its header. Modern's companion. */
  readonly agentWindow: ReactNode;
  /** The storage banner, or `null` when it is not shown. */
  readonly storageBanner: ReactNode;
  /** The picture-aware storage notices (pictures.md §6.5), shown only while the general banner is not. */
  readonly pictureNotices: ReactNode;
  /** The status line, or `null` when there is no message. */
  readonly status: ReactNode;
  readonly saveState: ReactNode;
  /** What the palette searches and runs (Modern only mounts it). */
  readonly search: ShellSearch;
}
