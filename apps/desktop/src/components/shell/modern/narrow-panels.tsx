/**
 * Modern's narrow layout (modern-interface.md §13, §9.2, §9.5, §9.7; M11, #312): below 960 px (`NARROW_QUERY`) the page fills the
 * width, the top ornament is a compact capsule (title, **+**, **⋯**) and the bottom ornament a tab bar (Write, Binder, Views, Ask,
 * Search; #480), which narrow-modern.css draws; the bottom ornament draws the Binder tab, which opens the drawer here. This component adds what only the narrow layout has:
 *
 * - The binder as a **drawer** from the inline-start edge (opened by the tab bar's **Binder**), built from #307's sidebar
 *   (binder-sidebar.tsx's tablist and panel, sidebar-model.ts's tabs): Binder, Findings, Activity, Trace with Classic's ids, over the
 *   same panels, the binder footer in the same **Goals and sprint** disclosure. The Codex is the page's own view here too.
 * - Scene info as a **bottom sheet** (scene-info.tsx, at most 80% of the height) and the agent window as a **full-height sheet**
 *   (companion.tsx); they keep their own components, and narrow-sync.ts keeps the three to one at a time through the workspace's
 *   `openPanel` (`NarrowPanel` gains 'agent').
 * - One **scrim** under the open panel, a tap on which closes it; everything else on the stage is `inert` while a panel is open, so
 *   neither Tab nor a tap reaches behind it (notices and modal dialogs excepted: they have their own rules). Scene info kept open
 *   (**Keep open**, #364) is the exception: a sheet below the page with no scrim, the page live above it.
 * - **Focus**: in as a panel opens (the drawer's current tab; Scene info and the agent window move it themselves), and back to the
 *   panel's button as it closes (the binder's button, the title capsule, **Ask**), unless the writer has already moved it (ui-modules
 *   §1, decisions.md "Panels return focus to their opener"). Close, Escape and the scrim close each.
 *
 * Rendered before the page (§9.1 reading order: top ornament, binder, page), so its layout effect, which lifts `inert` from the stage
 * as a panel closes, runs before the companion window's, which then gives focus back to Ask.
 */
/* lingui-set comment="Modern interface, the narrow layout below 960 px: the binder's button and drawer." */

import { t } from '@lingui/core/macro';
import { useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';

import './narrow-modern.css';

import { isImeEnter } from '../../../app/keymap.js';
import type { NarrowPanel } from '../../../app/narrow-model.js';
import { railTabId } from '../ClassicShell.js';
import type { RailTab, ShellRegions } from '../regions.js';
import { ASK_ID, COMPANION_ID } from './companion-actions.js';
import { SidebarPanel, SidebarTabList } from './binder-sidebar.js';
import { Icon } from './icons.js';
import { BINDER_BUTTON_ID, DRAWER_ID } from './narrow-ids.js';
import { shownPanel, syncNarrow, type NarrowState } from './narrow-sync.js';
import { SCENE_INFO_ID } from './scene-info-model.js';
import { closeSceneInfo, openSceneInfo, sceneInfoReturnTarget, sceneInfoState, subscribeSceneInfo } from './scene-info-store.js';
import { SIDEBAR_TABS, agentTab, isSidebarTab, sidebarTabFor, type SidebarTab } from './sidebar-model.js';
import { sidebarChannel } from './requests.js';
import { useVisualKeyboard } from './use-visual-keyboard.js';

/** The drawer's id and its button's (narrow-ids.ts): Classic's narrow ids, so the workspace's own focus rule for the rail drawer finds them. */
export { BINDER_BUTTON_ID, DRAWER_ID };
/** The drawer's tabs, in the arrow keys' order: #307's sidebar tabs (sidebar-model.ts); the Codex is the page's view. */
export const DRAWER_TABS: readonly SidebarTab[] = SIDEBAR_TABS;
/** The tab the drawer shows for the workspace's rail: #307's rule, its own tab or Binder while the page shows the Codex. */
export const drawerTabFor = sidebarTabFor;

const EMPTY: NarrowState = { panel: null, agent: false, info: false, rail: 'binder' };
const MARK = 'data-narrow-inert';

/** The element each panel is; what stays reachable while it is open. */
function panelElement(panel: NarrowPanel): HTMLElement | null {
  const id = panel === 'rail' ? DRAWER_ID : panel === 'inspector' ? SCENE_INFO_ID : COMPANION_ID;
  return document.getElementById(id);
}

/** Whether focus can land on an element now: drawn, and not inside anything inert. */
function reachable(element: HTMLElement | null): element is HTMLElement {
  return element !== null && element.isConnected && element.closest('[inert]') === null && element.getClientRects().length > 0;
}

/** Where focus goes back to as a panel closes: its button. */
function returnTarget(panel: NarrowPanel): HTMLElement | null {
  if (panel === 'rail') return document.getElementById(BINDER_BUTTON_ID);
  if (panel === 'agent') return document.getElementById(ASK_ID);
  // Scene info: where it gives focus back (its opener, or the text a route came from), else the title capsule.
  const back = sceneInfoReturnTarget();
  return reachable(back) ? back : document.querySelector<HTMLElement>('[data-testid="modern-title-capsule"]');
}

export function NarrowPanels({ regions, pageId, lastAgent = null }: { regions: ShellRegions; pageId: string; lastAgent?: SidebarTab | null }): ReactNode {
  useVisualKeyboard();
  const { view } = regions;
  const info = useSyncExternalStore(subscribeSceneInfo, sceneInfoState, sceneInfoState);
  const drawer = useRef<HTMLElement>(null);
  const state: NarrowState = { panel: view.openPanel, agent: view.agentOpen, info: info.open, rail: view.rail };
  const shown = view.hideRails ? null : shownPanel(state);
  const drawerOpen = shown === 'rail';
  // Scene info kept open (Keep open) is not modal: no scrim, and the page stays live above it (#364).
  const modal = shown === 'inspector' && info.docked ? null : shown;
  const tab = drawerTabFor(view.rail);
  useLayoutEffect(() => sidebarChannel.listen(({ tab: requested }) => {
    const next = requested === 'agent' ? agentTab(lastAgent) : requested;
    view.setRail(next);
    view.setPanel('rail');
  }));
  // The binder footer's "Goals and sprint" disclosure, as in #307's sidebar; closed each time the narrow layout starts.
  const [goalsOpen, setGoalsOpen] = useState(false);

  // One at a time (narrow-sync.ts). In a layout effect, so two sheets are never painted together. The first narrow render starts
  // from nothing open, so a wide window's open agent window and docked Scene info become one sheet, the agent's.
  const last = useRef<NarrowState>(EMPTY);
  const { setPanel, setAgentOpen } = view;
  useLayoutEffect(() => {
    // Focus mode hides the open sheet without closing it: its hidden `openPanel` is not a close, so nothing syncs until it ends.
    if (view.hideRails) return;
    const previous = last.current;
    last.current = state;
    const change = syncNarrow(previous, state);
    if (change.panel !== undefined) setPanel(change.panel);
    if (change.agent !== undefined) setAgentOpen(change.agent);
    if (change.info === true) openSceneInfo();
    if (change.info === false) closeSceneInfo({ returnFocus: false });
  });
  // Leaving the narrow layout (or Modern) never leaves an agent panel the other layout cannot show.
  useLayoutEffect(
    () => () => {
      if (last.current.panel === 'agent') setPanel(null);
      for (const element of Array.from(document.querySelectorAll(`[${MARK}]`))) {
        element.removeAttribute('inert');
        element.removeAttribute(MARK);
      }
    },
    [setPanel],
  );

  // Inert behind the open panel, and focus in and back. Runs on every render: a slot's root that remounted is caught again.
  const before = useRef<NarrowPanel | null>(null);
  useLayoutEffect(() => {
    const stage = drawer.current?.closest('.modern-stage') ?? document.querySelector('.modern-stage');
    const open = modal === null ? null : panelElement(modal);
    // Lifted wherever this set it, even off a stage that has moved on.
    if (modal === null) {
      for (const element of Array.from(document.querySelectorAll(`[${MARK}]`))) {
        element.removeAttribute('inert');
        element.removeAttribute(MARK);
      }
    }
    if (stage !== null) {
      for (const child of Array.from(stage.children)) {
        if (!(child instanceof HTMLElement)) continue;
        const keep =
          child === open ||
          child.id === DRAWER_ID ||
          child.tagName === 'DIALOG' ||
          child.classList.contains('modern-narrow-scrim') ||
          child.classList.contains('modern-notices') ||
          child.classList.contains('modern-wallpaper');
        const mine = child.hasAttribute(MARK);
        if (modal !== null && !keep && !child.hasAttribute('inert')) {
          child.setAttribute('inert', '');
          child.setAttribute(MARK, '');
        } else if ((modal === null || keep) && mine) {
          child.removeAttribute('inert');
          child.removeAttribute(MARK);
        }
      }
    }
    const was = before.current;
    before.current = shown;
    if (was === shown) return;
    if (shown === 'rail') {
      // The drawer's current tab, as Classic's drawer does; the workspace's own rule finds the same tab by its id.
      document.getElementById(railTabId(drawerTabFor(view.rail)))?.focus();
      return;
    }
    if (was === null || shown !== null) return;
    // Closed: focus back to the panel's button, unless the writer already put it somewhere else.
    const active = document.activeElement;
    const left = panelElement(was);
    const lost = active === null || active === document.body || !reachable(active as HTMLElement) || (left?.contains(active) ?? false);
    if (lost) (returnTarget(was) ?? document.getElementById(pageId))?.focus();
  });

  const close = (): void => {
    if (shown === 'agent') setAgentOpen(false);
    else if (shown === 'inspector') closeSceneInfo();
    else setPanel(null);
  };
  const choose = (next: RailTab): void => {
    if (isSidebarTab(next) && next !== view.rail) view.setRail(next);
  };
  // Escape closes the drawer after anything inside it (a menu, a rename, a dialog the binder opened) has had the key.
  const onDrawerKey = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape' || event.defaultPrevented || isImeEnter(event)) return;
    if (event.target instanceof Element && event.target.closest('dialog') !== null) return;
    event.preventDefault();
    setPanel(null);
  };

  if (view.hideRails) return null;
  return (
    <>
      <nav
        ref={drawer}
        id={DRAWER_ID}
        className={`modern-drawer mat-thick${drawerOpen ? ' is-open' : ''}`}
        aria-label={t`Binder`}
        data-testid="modern-drawer"
        data-state={drawerOpen ? 'open' : 'closed'}
        inert={!drawerOpen}
        onKeyDown={onDrawerKey}
      >
        <div className="modern-drawer-head">
          <span className="modern-drawer-title" aria-hidden="true">
            {t`Binder`}
          </span>
          <button
            type="button"
            className="modern-capsule is-icon"
            aria-label={t`Close panels`}
            title={t`Close panels`}
            data-testid="modern-drawer-close"
            onClick={() => setPanel(null)}
          >
            <Icon name="close" />
          </button>
        </div>
        <SidebarTabList tab={tab} findingsBadge={regions.findingsBadge} onSelect={choose} className="modern-drawer-tabs" />
        <SidebarPanel
          regions={regions}
          tab={tab}
          goalsOpen={goalsOpen}
          onToggleGoals={() => setGoalsOpen((was) => !was)}
          className="modern-drawer-panel"
        />
      </nav>
      {/* Always drawn while narrow, so the tap that closes a panel never falls through to the page under it. */}
      <div
        className={`modern-narrow-scrim${modal === null ? '' : ' is-open'}`}
        aria-hidden="true"
        data-testid="modern-narrow-scrim"
        data-panel={shown ?? 'none'}
        onClick={close}
      />
    </>
  );
}
