/**
 * Modern's narrow layout (modern-interface.md §13, §9.2, §9.5, §9.7; M11, #312): below 960 px (`NARROW_QUERY`) the page fills the
 * width, the top ornament is a compact capsule (title, **⋯**) and the bottom ornament a tab bar (Write, Board, Codex, Ask, Search),
 * which narrow-modern.css draws. This component adds what only the narrow layout has:
 *
 * - The **binder's button** at the top bar's inline-start end, and the binder as a **drawer** from that edge: the same tabs as the wide
 *   sidebar (Binder, Findings, Activity, Trace, Classic's ids), over the same panels. The Codex is the page's own view here too.
 * - Scene info as a **bottom sheet** (scene-info.tsx, at most 80% of the height) and the agent window as a **full-height sheet**
 *   (companion.tsx); they keep their own components, and narrow-sync.ts keeps the three to one at a time through the workspace's
 *   `openPanel` (`NarrowPanel` gains 'agent').
 * - One **scrim** under the open panel, a tap on which closes it; everything else on the stage is `inert` while a panel is open, so
 *   neither Tab nor a tap reaches behind it (notices and modal dialogs excepted: they have their own rules).
 * - **Focus**: in as a panel opens (the drawer's current tab; Scene info and the agent window move it themselves), and back to the
 *   panel's button as it closes (the binder's button, the title capsule, **Ask**), unless the writer has already moved it (ui-modules
 *   §1, decisions.md "Panels return focus to their opener"). Close, Escape and the scrim close each.
 *
 * Rendered before the page (§9.1 reading order: top ornament, binder, page), so its layout effect, which lifts `inert` from the stage
 * as a panel closes, runs before the companion window's, which then gives focus back to Ask.
 */
/* lingui-set comment="Modern interface, the narrow layout below 960 px: the binder's button and drawer." */

import { plural, t } from '@lingui/core/macro';
import { useLayoutEffect, useRef, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';

import './narrow-modern.css';

import { isImeEnter } from '../../../app/keymap.js';
import type { NarrowPanel } from '../../../app/narrow-model.js';
import { LazyBoundary } from '../../lazy-view.js';
import { keyStep, railTabId } from '../ClassicShell.js';
import type { RailTab, ShellRegions } from '../regions.js';
import { ASK_ID, COMPANION_ID } from './companion-actions.js';
import { Icon } from './icons.js';
import { shownPanel, syncNarrow, type NarrowState } from './narrow-sync.js';
import { SCENE_INFO_ID } from './scene-info-model.js';
import { closeSceneInfo, openSceneInfo, sceneInfoReturnTarget, sceneInfoState, subscribeSceneInfo } from './scene-info-store.js';

/** The drawer's id and its button's: Classic's narrow ids, so the workspace's own focus rule for the rail drawer finds them. */
export const DRAWER_ID = 'narrow-rail';
export const BINDER_BUTTON_ID = 'narrow-toggle-rail';
/** The drawer's tabs, in the arrow keys' order: the wide sidebar's (#307); the Codex is the page's view. */
export const DRAWER_TABS: readonly RailTab[] = ['binder', 'findings', 'activity', 'trace'];
/** The tab the drawer shows for the workspace's rail: its own, or Binder while the page shows the Codex. */
export function drawerTabFor(rail: RailTab): RailTab {
  return DRAWER_TABS.includes(rail) ? rail : 'binder';
}

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

export function NarrowPanels({ regions, pageId }: { regions: ShellRegions; pageId: string }): ReactNode {
  const { view } = regions;
  const info = useSyncExternalStore(subscribeSceneInfo, sceneInfoState, sceneInfoState);
  const drawer = useRef<HTMLElement>(null);
  const state: NarrowState = { panel: view.openPanel, agent: view.agentOpen, info: info.open, rail: view.rail };
  const shown = view.hideRails ? null : shownPanel(state);
  const drawerOpen = shown === 'rail';
  const tab = drawerTabFor(view.rail);

  // One at a time (narrow-sync.ts). In a layout effect, so two sheets are never painted together. The first narrow render starts
  // from nothing open, so a wide window's open agent window and docked Scene info become one sheet, the agent's.
  const last = useRef<NarrowState>(EMPTY);
  const { setPanel, setAgentOpen } = view;
  useLayoutEffect(() => {
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
    const open = shown === null ? null : panelElement(shown);
    // Lifted wherever this set it, even off a stage that has moved on.
    if (shown === null) {
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
        if (shown !== null && !keep && !child.hasAttribute('inert')) {
          child.setAttribute('inert', '');
          child.setAttribute(MARK, '');
        } else if ((shown === null || keep) && mine) {
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
    if (next !== view.rail) view.setRail(next);
  };
  const onTabKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const next = keyStep(DRAWER_TABS, tab, event.key);
    if (next === null) return;
    event.preventDefault();
    choose(next);
    document.getElementById(railTabId(next))?.focus();
  };
  // Escape closes the drawer after anything inside it (a menu, a rename, a dialog the binder opened) has had the key.
  const onDrawerKey = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape' || event.defaultPrevented || isImeEnter(event)) return;
    if (event.target instanceof Element && event.target.closest('dialog') !== null) return;
    event.preventDefault();
    setPanel(null);
  };

  if (view.hideRails) return null;
  const footer = (regions as ShellRegions & { readonly binderFooter?: ReactNode }).binderFooter ?? null;
  return (
    <>
      <button
        type="button"
        id={BINDER_BUTTON_ID}
        className="modern-capsule is-icon modern-narrow-binder mat-thick"
        aria-label={t`Binder`}
        title={t`Binder`}
        aria-expanded={drawerOpen}
        aria-controls={DRAWER_ID}
        data-testid="modern-narrow-binder"
        onClick={() => setPanel(drawerOpen ? null : 'rail')}
      >
        <Icon name="binder" />
      </button>
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
        <div role="tablist" aria-label={t`Panels`} className="rail-tabs modern-drawer-tabs" onKeyDown={onTabKey}>
          <DrawerTab tab="binder" current={tab} label={t`Binder`} onSelect={choose} />
          <DrawerTab tab="findings" current={tab} label={t`Findings`} badge={regions.findingsBadge} onSelect={choose} />
          <DrawerTab tab="activity" current={tab} label={t`Activity`} onSelect={choose} />
          <DrawerTab tab="trace" current={tab} label={t`Trace`} onSelect={choose} />
        </div>
        <div role="tabpanel" id="rail-panel" aria-labelledby={railTabId(tab)} className="rail-panel modern-drawer-panel">
          {tab === 'binder' ? (
            <>
              {regions.binder}
              {footer}
            </>
          ) : tab === 'findings' ? (
            <LazyBoundary label={t`Findings`}>{regions.findings}</LazyBoundary>
          ) : tab === 'trace' ? (
            <LazyBoundary label={t`Trace`}>{regions.trace}</LazyBoundary>
          ) : (
            <LazyBoundary label={t`Activity`}>{regions.activity}</LazyBoundary>
          )}
        </div>
      </nav>
      {/* Always drawn while narrow, so the tap that closes a panel never falls through to the page under it. */}
      <div
        className={`modern-narrow-scrim${shown === null ? '' : ' is-open'}`}
        aria-hidden="true"
        data-testid="modern-narrow-scrim"
        data-panel={shown ?? 'none'}
        onClick={close}
      />
    </>
  );
}

/** One drawer tab: Classic's rail tab (roving tabindex, the tabpanel named by its id). */
function DrawerTab({
  tab,
  current,
  label,
  badge = 0,
  onSelect,
}: {
  tab: RailTab;
  current: RailTab;
  label: string;
  badge?: number;
  onSelect: (tab: RailTab) => void;
}): ReactNode {
  return (
    <button
      type="button"
      role="tab"
      id={railTabId(tab)}
      aria-selected={current === tab}
      aria-controls="rail-panel"
      tabIndex={current === tab ? 0 : -1}
      className={`rail-tab${current === tab ? ' is-current' : ''}`}
      onClick={() => onSelect(tab)}
    >
      {label}
      {badge > 0 ? (
        <span className="rail-badge" aria-label={t`${plural(badge, { one: '# open', other: '# open' })}`} data-testid={`${tab}-badge`}>
          {badge}
        </span>
      ) : null}
    </button>
  );
}
