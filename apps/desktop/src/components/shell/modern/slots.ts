/**
 * Modern's slots (modern-interface.md §4.3, §6, §9.1): the places in `ModernShell` that the later Modern issues fill. M4 (#305) builds
 * the stage, the page and the materials; each slot below is either a provisional control of M4's, so Modern (Preview) stays usable,
 * or empty. An issue fills its slot by building its component under `components/shell/modern/` and changing its one line in
 * {@link MODERN_SLOTS}; it deletes the provisional file it replaces. Nothing else in `ModernShell` needs to change, and the slots are
 * independent lines, so the issues merge without touching each other.
 *
 * | Slot             | Issue | M4 fills it with                                   | DOM place (§9.1)                      |
 * |------------------|-------|----------------------------------------------------|----------------------------------------|
 * | `notices`        | #311  | `InterimNotices` (status line, storage notices)    | after the skip link                    |
 * | `topOrnament`    | #306  | `InterimTopOrnament` (name, save state, More menu) | before the binder                      |
 * | `sidebar`        | #307  | `BinderSidebar` (built: binder-sidebar.tsx)        | before the page                        |
 * | `bottomOrnament` | #306  | `InterimBottomOrnament` (the centre views)         | after the page                         |
 * | `sceneInfo`      | #308  | nothing (the inspector waits for Scene info)       | after the bottom ornament              |
 * | `companion`      | #309  | nothing (the agent drawer stays on the page)       | after Scene info                       |
 * | `palette`        | #310  | nothing                                            | last, before the dialogs               |
 *
 * Each slot is a component that receives the regions (the same feature elements Classic shows, and the view state) and the page's
 * id. A slot never reads the interface (§4.3 rule 1): it is Modern by being here. Room a slot takes from the page (the sidebar at the
 * inline-start edge, the companion at the inline-end) is the stage's geometry, `StageGeometry` in stage.tsx, which #306's
 * `modernLayout` computes; until then a filled sidebar slot gives the stage `has-sidebar`.
 */

import type { ComponentType } from 'react';

import type { ShellRegions } from '../regions.js';
import { BinderSidebar } from './binder-sidebar.js';
import { InterimBottomOrnament, InterimTopOrnament } from './interim-ornaments.js';
import { InterimNotices } from './interim-notices.js';
import { Palette } from './palette.js';

/** What every slot receives. */
export interface ModernSlotProps {
  readonly regions: ShellRegions;
  /** The id of the page (`main`), for a control that moves focus to it or names it (`aria-controls`). */
  readonly pageId: string;
}

export type ModernSlot = ComponentType<ModernSlotProps>;

export interface ModernSlots {
  /** Toasts and notices at the top centre (§8.6): the status line, the storage banner, the picture notices. #311. */
  readonly notices: ModernSlot | null;
  /** The glass capsule on the page's top edge (§6, §8.1): the title capsule and **⋯**. #306. */
  readonly topOrnament: ModernSlot | null;
  /** The binder tab bar that grows into the sidebar (§8.5). #307. */
  readonly sidebar: ModernSlot | null;
  /** The glass capsule on the page's bottom edge: Write, Board, Codex, Ask, Search (§6). #306. */
  readonly bottomOrnament: ModernSlot | null;
  /** Scene info, the thick-glass popover from the title capsule, or docked beside the page (§7.5, §8.2). #308. */
  readonly sceneInfo: ModernSlot | null;
  /** The agent's companion window beside the page (§8.10). #309; until then the agent drawer stays on the page. */
  readonly companion: ModernSlot | null;
  /** The palette, Ctrl+K (§8.9). #310. */
  readonly palette: ModernSlot | null;
}

/** The slots as M4 ships them. One line per slot; an issue changes only its own. */
export const MODERN_SLOTS: ModernSlots = {
  notices: InterimNotices,
  topOrnament: InterimTopOrnament,
  sidebar: BinderSidebar,
  bottomOrnament: InterimBottomOrnament,
  sceneInfo: null,
  companion: null,
  palette: Palette,
};

