/**
 * Modern's binder tab bar and sidebar (M6, #307; modern-interface.md §6, §7.2, §8.5, §9.1, §9.5, §9.6). The `sidebar` slot.
 *
 * A slim glass **tab bar** at the inline-start edge holds **Binder**, **Findings** (its open count always visible) and **Agent**
 * (the agent's Activity and Trace logs; #479), and a decorative minimap of the scenes' status dots. It grows into the **sidebar** beside it, the page's height, with its own tabs **Binder**, **Findings** (with the open count),
 * **Activity** and **Trace**: a tablist with Classic's keys and ids (`railTabId`, `keyStep`), over the same panels Classic's rail shows.
 * The Binder tab is the same `Binder` (toolbar, script import actions, filter bar, tree), and under it the same `BinderFooter` in one
 * disclosure, **Goals and sprint**.
 *
 * Opening (§8.5): a hover held for 140 ms opens it without moving focus; a click, Enter or Space opens it and moves focus to the current
 * row (Binder) or the current tab (Findings, Agent); Ctrl+Alt+F opens it on the filter. It closes 420 ms after the pointer leaves, unless it
 * is pinned or focus is inside; Escape closes it and returns focus to the button that opened it. **Keep open** (`aria-pressed`) pins
 * it, and the page moves over; the pin is kept in this browser (sidebar-model.ts). A scene chosen in an unpinned sidebar closes it on
 * the editor. Nothing is hover-only: a tap opens it as a click does. Closed, the sidebar is `inert`, so Tab never reaches a hidden row.
 *
 * Words a stopped tab kept are offered in the footer, as in Classic; since that sits in a closed disclosure of a closed sidebar here, they
 * are also announced on the status line, with a link that opens them.
 */
/* lingui-set comment="Modern interface: the binder tab bar and the sidebar beside it." */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import {
  useEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import { isImeEnter } from '../../../app/keymap.js';
import { focusEditorWhenReady } from '../../../app/editor-ready.js';
import { LazyBoundary } from '../../lazy-view.js';
import { useReport } from '../../shared.js';
import { modalOpenedFrom } from '../../modal.js';
import { modalStack } from '../../modal-stack.js';
import { RailTabButton, keyStep, railTabId } from '../ClassicShell.js';
import type { RailTab } from '../regions.js';
import './binder-sidebar.css';
import { Icon } from './icons.js';
import {
  CLOSE_DELAY_MS,
  HOVER_OPEN_MS,
  SIDEBAR_TABS,
  currentBinderPinned,
  isSidebarTab,
  sidebarReducer,
  agentTab,
  openerOf,
  setBinderPinned,
  sidebarTabFor,
  subscribeBinderPinned,
  type SidebarTab,
} from './sidebar-model.js';
import type { ModernSlotProps } from './slots.js';
import { sidebarChannel } from './requests.js';

/** The sidebar's id, which the tab bar's buttons control. */
export const SIDEBAR_ID = 'modern-sidebar';
/** The tab bar's openers (#479). Binder keeps the id Manuscript had, so a link or a test that found it still does. */
export const MANUSCRIPT_ID = 'modern-binder-manuscript';
export const FINDINGS_OPENER_ID = 'modern-binder-findings';
export const AGENT_OPENER_ID = 'modern-binder-agent';
const GOALS_ID = 'modern-binder-goals';

type Opener = typeof MANUSCRIPT_ID | typeof FINDINGS_OPENER_ID | typeof AGENT_OPENER_ID;
type FocusTarget = 'row' | 'tab' | 'opener' | 'page' | 'kept';

interface FocusRequest {
  readonly target: FocusTarget;
  /** The element id a `tab` or `opener` request focuses. */
  readonly id: string;
  readonly serial: number;
}

/** The filter chord's last request this sidebar has seen, kept across a remount (focus mode hides the sidebar and brings it back). */
let lastFilterRequest = 0;
/** The stops whose kept words were announced, so a remount does not say it twice. */
const announcedStops = new Set<string>();

export function BinderSidebar({ regions, pageId, lastAgent = null }: ModernSlotProps): ReactNode {
  const { view } = regions;
  const report = useReport();
  const pinned = useSyncExternalStore(subscribeBinderPinned, currentBinderPinned);
  const [state, dispatch] = useReducer(sidebarReducer, pinned ? { kind: 'pinned' } : { kind: 'closed', intent: 'none' });
  const [opener, setOpener] = useState<Opener>(MANUSCRIPT_ID);
  const [goalsOpen, setGoalsOpen] = useState(false);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const pointerInside = useRef(false);

  const tab = sidebarTabFor(view.rail);
  const shown = state.kind !== 'closed';
  if (pinned !== (state.kind === 'pinned')) dispatch({ type: 'pin', pinned });

  const requestFocus = (target: FocusTarget, id = ''): void =>
    setFocusRequest((previous) => ({ target, id, serial: (previous?.serial ?? 0) + 1 }));

  // Ctrl+Alt+F: a new request opens the sidebar in the same render that shows the binder, so the field Workspace focuses after that
  // render is reachable (a closed sidebar is inert).
  const [seenFilter, setSeenFilter] = useState(() => lastFilterRequest);
  if (view.filterRequest !== seenFilter) {
    setSeenFilter(view.filterRequest);
    if (view.filterRequest > 0) {
      dispatch({ type: 'open' });
    }
  }
  // A sidebar tab chosen from outside (a timeline fact's "Open in Findings", the screenplay's section route) opens the sidebar on it.
  // A request counts too (Scene info's Show in Findings, the section route), so a tab that is already the current one still opens.
  const [seenRail, setSeenRail] = useState(view.rail);
  const [seenRequest, setSeenRequest] = useState(view.railRequest);
  if (view.rail !== seenRail || view.railRequest !== seenRequest) {
    setSeenRail(view.rail);
    setSeenRequest(view.railRequest);
    if (isSidebarTab(view.rail)) {
      dispatch({ type: 'open' });
    }
  }
  // A scene chosen in an unpinned sidebar closes it on the editor (§8.5), as the narrow drawer closes.
  const [seenChoice, setSeenChoice] = useState(view.binderChoice);
  if (view.binderChoice !== seenChoice) {
    setSeenChoice(view.binderChoice);
    if (!pinned && shown) {
      dispatch({ type: 'scene-chosen' });
      requestFocus('page');
    }
  }

  useEffect(() => {
    lastFilterRequest = view.filterRequest;
  }, [view.filterRequest]);

  useEffect(() => modalStack.subscribe(() => {
    if (modalOpenedFrom(navRef.current)) dispatch({ type: 'open' });
  }), []);

  useEffect(() => {
    if (state.kind === 'closed' && state.intent === 'hover') {
      const timer = setTimeout(() => dispatch({ type: 'hover-elapsed' }), HOVER_OPEN_MS);
      return () => clearTimeout(timer);
    }
    if (state.kind === 'closing') {
      const timer = setTimeout(() => dispatch({
        type: 'close-elapsed',
        focusInside: navRef.current?.contains(document.activeElement) === true || modalOpenedFrom(navRef.current),
        pointerInside: pointerInside.current,
      }), CLOSE_DELAY_MS);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [state]);

  /** Shows a sidebar tab, as the rail's tabs do (the workspace keeps which one). */
  const choose = (next: RailTab): void => {
    if (!isSidebarTab(next) || next === view.rail) return;
    setSeenRail(next);
    view.setRail(next);
  };

  /** Binder, Findings and Agent: open on their tab and move focus in, or close a sidebar they opened when pressed again. */
  const press = (next: SidebarTab, from: Opener, toggle = true): void => {
    const event = { type: 'press', toggle: toggle && tab === next } as const;
    dispatch(event);
    if (sidebarReducer(state, event).kind === 'closed') return;
    setOpener(from);
    choose(next);
    requestFocus(next === 'binder' ? 'row' : 'tab', railTabId(next));
  };

  useEffect(() => sidebarChannel.listen(({ tab: requested }) => {
    const next = requested === 'agent' ? agentTab(lastAgent) : requested;
    if (!isSidebarTab(next)) return;
    press(next, ({ binder: MANUSCRIPT_ID, findings: FINDINGS_OPENER_ID, agent: AGENT_OPENER_ID } as const)[openerOf(next)], false);
  }));

  const close = (): void => {
    dispatch({ type: 'escape' });
    requestFocus('opener', opener);
  };

  const togglePin = (): void => {
    setBinderPinned(!pinned);
    // Unpinned with focus on the button, the sidebar stays until focus or the pointer leaves it.
  };

  // A hover held over the tab bar opens the sidebar, focus stays where it was. Touch has no hover: a tap is a click.
  const onBarPointerEnter = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === 'touch' || shown) return;
    dispatch({ type: 'hover' });
  };
  const onPointerEnter = (): void => {
    pointerInside.current = true;
    dispatch({ type: 'enter' });
  };
  const onPointerLeave = (): void => {
    pointerInside.current = false;
    dispatch({ type: 'leave' });
  };
  const onBlur = (event: ReactFocusEvent<HTMLElement>): void => {
    if (navRef.current?.contains(event.relatedTarget as Node | null) === true) return;
    if (shown && !pinned) dispatch({ type: 'leave' });
  };
  // Escape closes an unpinned sidebar and returns focus to its button, after anything inside it (a menu, a rename) has had the key.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape' || event.isDefaultPrevented() || isImeEnter(event)) return;
    // A dialog inside the sidebar has the key first and alone: it cancels itself, and the sidebar stays.
    if (event.target instanceof Element && event.target.closest('dialog') !== null) return;
    if (!shown || pinned) return;
    event.preventDefault();
    close();
  };


  // Focus moves after the render that made its target reachable.
  useEffect(() => {
    if (focusRequest === null) return;
    const nav = navRef.current;
    let target: HTMLElement | null = null;
    if (focusRequest.target === 'row') {
      target =
        nav?.querySelector<HTMLElement>('.binder-tree [role="treeitem"][tabindex="0"]') ??
        nav?.querySelector<HTMLElement>('.binder-tree [role="treeitem"]') ??
        document.getElementById(focusRequest.id);
    } else if (focusRequest.target === 'tab' || focusRequest.target === 'opener') {
      target = document.getElementById(focusRequest.id);
    } else if (focusRequest.target === 'kept') {
      target = nav?.querySelector<HTMLElement>('[data-testid="unsent-words"] button') ?? null;
    } else {
      const page = document.getElementById(pageId);
      return page === null ? undefined : focusEditorWhenReady(page, nav);
    }
    target?.focus();
    return undefined;
  }, [focusRequest, pageId]);

  // Kept words from a stopped tab: announced once on the status line, with a link that opens them (§7.2).
  const setRail = view.setRail;
  useEffect(() => {
    if (tab !== 'binder') return;
    const stops = Array.from(navRef.current?.querySelectorAll('[data-testid="unsent-words"] [data-stop]') ?? [])
      .map((element) => element.getAttribute('data-stop'))
      .filter((stop): stop is string => stop !== null);
    if (stops.every((stop) => announcedStops.has(stop))) return;
    for (const stop of stops) announcedStops.add(stop);
    report({
      text: t`A stopped tab kept some words. They are in the binder, under Goals and sprint: `,
      tone: 'info',
      link: {
        label: t`show them`,
        after: '.',
        onClick: () => {
          setSeenRail('binder');
          setRail('binder');
          dispatch({ type: 'open' });
          setGoalsOpen(true);
          setFocusRequest((previous) => ({ target: 'kept', id: '', serial: (previous?.serial ?? 0) + 1 }));
        },
      },
    });
  }, [tab, report, setRail]);

  return (
    <nav
      ref={navRef}
      className={`modern-binder${shown ? ' is-open' : ''}${pinned ? ' is-pinned' : ''}`}
      aria-label={t`Binder`}
      data-testid="modern-binder"
      data-state={shown ? 'open' : 'closed'}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    >
      <div className="modern-binder-bar mat-glass" data-testid="modern-binder-bar" onPointerEnter={onBarPointerEnter}>
        <button
          type="button"
          id={MANUSCRIPT_ID}
          className="modern-binder-button"
          aria-expanded={shown && openerOf(tab) === 'binder'}
          aria-controls={SIDEBAR_ID}
          onClick={() => press('binder', MANUSCRIPT_ID)}
        >
          <Icon name="manuscript" />
          <span className="modern-binder-label">
            <Trans>Binder</Trans>
          </span>
        </button>
        <button
          type="button"
          id={FINDINGS_OPENER_ID}
          className="modern-binder-button"
          aria-expanded={shown && openerOf(tab) === 'findings'}
          aria-controls={SIDEBAR_ID}
          onClick={() => press('findings', FINDINGS_OPENER_ID)}
        >
          <Icon name="findings" />
          <span className="modern-binder-label">
            <Trans>Findings</Trans>
          </span>
          {regions.findingsBadge > 0 ? (
            <span className="modern-binder-count" data-testid="modern-binder-findings-count">
              {regions.findingsBadge}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          id={AGENT_OPENER_ID}
          className="modern-binder-button"
          aria-expanded={shown && openerOf(tab) === 'agent'}
          aria-controls={SIDEBAR_ID}
          onClick={() => press(agentTab(lastAgent), AGENT_OPENER_ID)}
        >
          <Icon name="agent" />
          <span className="modern-binder-label">
            <Trans>Agent</Trans>
          </span>
        </button>
        {/* Decorative (§9.1): the scenes' status dots, the open scene marked. Hidden from assistive technology. */}
        <div className="modern-minimap" aria-hidden="true" data-testid="modern-minimap">
          {regions.minimap.map((dot) => (
            <span
              key={dot.id}
              className={`modern-minimap-dot${dot.current ? ' is-current' : ''}${dot.color === null ? ' is-empty' : ''}`}
              style={dot.color === null ? undefined : { backgroundColor: dot.color }}
            />
          ))}
        </div>
      </div>

      <div id={SIDEBAR_ID} className="modern-sidebar mat-thick" data-testid="modern-sidebar" data-panel-state={state.kind} inert={!shown}>
        {/* One row (#360): the four tabs as one segmented control, and Keep open as an icon toggle at its end. */}
        <div className="modern-sidebar-head">
          <SidebarTabList tab={tab} findingsBadge={regions.findingsBadge} onSelect={choose} />
          <button
            type="button"
            className="modern-sidebar-pin k-icon-button"
            aria-pressed={pinned}
            aria-label={t`Keep open`}
            title={t`Keep open`}
            data-testid="modern-binder-pin"
            onClick={togglePin}
          >
            <Icon name="pin" />
          </button>
        </div>
        <SidebarPanel regions={regions} tab={tab} goalsOpen={goalsOpen} onToggleGoals={() => setGoalsOpen((was) => !was)} />
      </div>
    </nav>
  );
}

/**
 * The sidebar's tablist (§7.2): Binder, Findings (with the open count), Activity and Trace, Classic's rail tabs and ids, walked by
 * Classic's arrow keys. Shared with the narrow layout's drawer (#312), which shows the same tabs over the same panels.
 */
export function SidebarTabList({
  tab,
  findingsBadge,
  onSelect,
  className = 'modern-sidebar-tabs',
}: {
  tab: SidebarTab;
  findingsBadge: number;
  onSelect: (tab: RailTab) => void;
  /** The class the wide sidebar's or the drawer's stylesheet draws it by. */
  className?: string;
}): ReactNode {
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const next = keyStep(SIDEBAR_TABS, tab, event.key);
    if (next === null) return;
    event.preventDefault();
    onSelect(next);
    document.getElementById(railTabId(next))?.focus();
  };
  return (
    <div role="tablist" aria-label={t`Panels`} className={`rail-tabs ${className}`} onKeyDown={onKeyDown}>
      <RailTabButton tab="binder" current={tab} label={t`Binder`} onSelect={onSelect} />
      <RailTabButton tab="findings" current={tab} label={t`Findings`} badge={findingsBadge} onSelect={onSelect} />
      <RailTabButton tab="activity" current={tab} label={t`Activity`} onSelect={onSelect} />
      <RailTabButton tab="trace" current={tab} label={t`Trace`} onSelect={onSelect} />
    </div>
  );
}

/**
 * The tab's panel: the binder (toolbar, filter, tree) with the binder footer in one **Goals and sprint** disclosure under it, or the
 * findings, the activity or the trace. Shared with the narrow drawer (#312); only one of the two is ever drawn, so the ids stay unique.
 */
export function SidebarPanel({
  regions,
  tab,
  goalsOpen,
  onToggleGoals,
  className = 'modern-sidebar-panel',
}: {
  regions: ModernSlotProps['regions'];
  tab: SidebarTab;
  goalsOpen: boolean;
  onToggleGoals: () => void;
  className?: string;
}): ReactNode {
  return (
    <div role="tabpanel" id="rail-panel" aria-labelledby={railTabId(tab)} className={`rail-panel ${className}`}>
      {tab === 'binder' ? (
        <>
          {regions.binder}
          <div className="modern-sidebar-goals">
            <button type="button" className="modern-sidebar-disclosure" aria-expanded={goalsOpen} aria-controls={GOALS_ID} onClick={onToggleGoals}>
              <Trans>Goals and sprint</Trans>
            </button>
            <div id={GOALS_ID} hidden={!goalsOpen}>
              {regions.binderFooter}
            </div>
          </div>
        </>
      ) : tab === 'findings' ? (
        <LazyBoundary label={t`Findings`}>{regions.findings}</LazyBoundary>
      ) : tab === 'trace' ? (
        <LazyBoundary label={t`Trace`}>{regions.trace}</LazyBoundary>
      ) : (
        <LazyBoundary label={t`Activity`}>{regions.activity}</LazyBoundary>
      )}
    </div>
  );
}
