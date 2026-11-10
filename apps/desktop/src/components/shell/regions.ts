/**
 * The regions a shell arranges — modern-interface.md §4.1. `Workspace` keeps every piece of state and every handler; its render
 * builds the feature elements once and hands them, with the shell actions and the view state, to a shell component. A shell
 * decides where each region goes and never re-implements what is inside one, so switching shells re-parents the same instances.
 */

import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';

import type { ProjectState } from '@caotang/store';

import type { ZoomLevel } from '../../app/corkboard-model.js';
import type { FindingView } from '../../app/findings-model.js';
import type { NarrowPanel } from '../../app/narrow-model.js';
import type { NewKind } from '../../app/new-menu.js';
import type { SaveState } from '../../app/session.js';
import type { TargetProgress } from '../../app/session-progress.js';
import type { ShellAction } from '../../app/shell-actions.js';
import type { CenterMode } from '../Binder.js';
import type { SettingsSection } from '../Settings.js';
import type { MenuAnchor } from '../shared.js';
import type { MinimapDot } from './minimap.js';

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
  /** Counts the filter chord's requests (Ctrl+Alt+F): a shell whose binder floats (Modern's sidebar) opens it on a new one. */
  readonly filterRequest: number;
  /** Counts the documents chosen in the binder (a row, or **Open in editor**): Modern closes an unpinned sidebar on each. */
  readonly binderChoice: number;
  /** Counts the requests from outside the rail to show one of its tabs (Show in Findings, the section route): Modern's sidebar opens on
   *  a new one even when its tab is already the current one. */
  readonly railRequest: number;
  /** The Board's card size (S/M/L), which the corkboard and the shot board share: Modern shows it in the top ornament (§7.3). */
  readonly zoom: ZoomLevel;
  readonly setZoom: (zoom: ZoomLevel) => void;
}

/**
 * Today's progress and the save state as values, for a shell that shows them in its own place (Modern's Scene info › Progress,
 * modern-interface.md §6, §7.3). Classic shows them in the editor's footer and the toolbar, through `editor` and `saveState`.
 */
export interface ShellProgress {
  /** Today's words and the daily target, the reading the editor's `TargetQuickSet` shows. */
  readonly target: TargetProgress;
  /** Saves the daily target (the app setting), as the editor's quick-set does. */
  readonly setTarget: (words: number) => void;
  readonly saveState: SaveState;
  readonly stopCause?: 'newer-text' | 'updated';
  /** Export a backup, the save state's own button on a failed save. */
  readonly exportBackup: () => void;
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
  readonly openSettings: (section: SettingsSection) => void;
  /** Opens the agent. With text, the Intent box holds it and nothing is sent. */
  readonly openAgent: (text: string | null) => void;
  /** Shows the selected node's scene info (the inspector), on its synopsis. */
  readonly openSceneInfo: () => void;
}

/** The one New (app/new-menu.ts, #477): where new things go and how to make one. */
export interface ShellCreate {
  /** The chapter New puts things into, by title; `null` when a chapter is made first. */
  readonly target: string | null;
  /** Makes one item of `kind` (and its chapter first when there is none), then opens it. */
  readonly make: (kind: NewKind) => void;
  /** A hall's preferred order of the kinds (#430); none keeps the base order. */
  readonly order?: readonly string[];
}

export interface ShellRegions {
  readonly documentKind?: 'scene' | 'screenplay' | 'dialogue' | 'storyboard' | 'comic-page' | null;
  /** The New menu's model and its one action (#477). */
  readonly create: ShellCreate;
  /** A hall's preferred order of the views (#430, #482); none keeps Write, Board, Timeline, Codex, Pictures. */
  readonly viewOrder?: readonly string[];
  readonly projectName: string;
  /** The shell actions (app/shell-actions.ts), in order. */
  readonly actions: readonly ShellAction[];
  readonly view: ShellView;
  /** The rail's tab panels: the binder (its toolbar, import actions, filter bar and tree), the codex, findings, activity and the trace. */
  readonly binder: ReactNode;
  /** The binder's footer (saved filters, goals, the sprint timer, totals, History, kept words): under the tree in Classic, under
   *  **Goals and sprint** in Modern's sidebar. */
  readonly binderFooter: ReactNode;
  /** The manuscript's scenes as status dots, for Modern's decorative minimap on the binder tab bar. */
  readonly minimap: readonly MinimapDot[];
  readonly codex: ReactNode;
  readonly findings: ReactNode;
  /** The open findings, which the Findings tab shows as a count. */
  readonly findingsBadge: number;
  /** The open findings that quote the selected scene, in the Findings tab's order: Modern's Scene info lists them (§7.2). */
  readonly sceneFindings: readonly FindingView[];
  /** Shows the Findings tab on a finding's fact group, as the timeline's **Open in Findings** does. */
  readonly showInFindings: (factGroup: string) => void;
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
  readonly progress: ShellProgress;
  /** What the palette searches and runs (Modern only mounts it). */
  readonly search: ShellSearch;
}
