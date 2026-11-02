/**
 * The Modern shell — modern-interface.md §4, §5.3, §6, §9.1. The `modern-shell` chunk: loaded only while Modern is on
 * (app/interface.ts), with its stylesheets, so Classic's first load carries none of it (§12).
 *
 * It arranges the regions `Workspace` built on a **stage** (the wallpaper) around one **page** of paper that holds the centre content:
 * the editor (kept mounted, as in Classic), a media view, the corkboard, the timeline or the pictures. Everything else goes in a slot
 * (slots.ts), in the DOM order of §9.1: the skip link, notices, the top ornament, the binder, the page, the bottom ornament, Scene
 * info, the companion window, the palette. The dialogs are not here: Shell.tsx puts them after this, in the frame both shells share.
 *
 * A shell never re-implements a feature (§4.3): every control here calls a handler `Workspace` already has.
 */
/* lingui-set comment="Modern interface: the stage and the page." */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLayoutEffect, useRef, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';

import '../../../tokens/modern.css';
import './shell-modern.css';
import './surfaces-modern.css';
import './editor-modern.css';

import { LazyBoundary } from '../../lazy-view.js';
import { OpenOnDesktop } from '../../narrow.js';
import type { ShellRegions } from '../regions.js';
import { modernLayout, type ModernView } from './layout.js';
import { installMorph, morphPage } from './morph.js';
import { useSceneInfo } from './scene-info-store.js';
import { currentBinderPinned, subscribeBinderPinned } from './sidebar-model.js';
import { MODERN_SLOTS, type ModernSlot, type ModernSlots } from './slots.js';
import { Page, Stage, type StageGeometry } from './stage.js';
import { modernViewOf } from './views.js';

export { MODERN_SLOTS, type ModernSlot, type ModernSlotProps, type ModernSlots } from './slots.js';
export { Page, Stage, geometryProperties, type StageGeometry } from './stage.js';
export { modernLayout, type ModernLayout, type ModernView } from './layout.js';

/** The window's size, as a store React reads (one listener on `resize`). The same object until the size changes. */
let viewport = { width: 0, height: 0 };
function readViewport(): { width: number; height: number } {
  if (viewport.width !== window.innerWidth || viewport.height !== window.innerHeight) {
    viewport = { width: window.innerWidth, height: window.innerHeight };
  }
  return viewport;
}
function subscribeViewport(listener: () => void): () => void {
  window.addEventListener('resize', listener);
  return () => window.removeEventListener('resize', listener);
}

// Dialogs grow out of their openers while Modern is on, on the projects screen as in a project (§8.3).
installMorph();

/** The page's id: the skip link's target, and what a slot names with `aria-controls`. */
export const PAGE_ID = 'modern-page';

export function ModernShell({
  regions,
  slots = MODERN_SLOTS,
  geometry,
}: {
  regions: ShellRegions;
  /** The slots to fill; the shipped ones by default. Tests pass their own. */
  slots?: ModernSlots;
  /** The page's place; {@link modernLayout}'s for the window's size and the view when left out. Tests pass their own. */
  geometry?: StageGeometry;
}): ReactNode {
  const { view } = regions;
  const sidebar = slots.sidebar !== null && !view.hideRails && !view.narrow;
  // The sidebar slot is #307's tab bar, which always takes its room; the sidebar beside it moves the page over only while pinned.
  const pinned = useSyncExternalStore(subscribeBinderPinned, currentBinderPinned);
  const current = modernViewOf(view.rail, view.center);
  const size = useSyncExternalStore(subscribeViewport, readViewport);
  // The windows at the inline-end edge, as their own components decide whether they show (focus mode hides both): the agent window
  // (#309) while the workspace's agentOpen is set, exactly CompanionWindow's `open`; a docked Scene info (#308). The stage's inline
  // geometry is the one source of the page's room, so the stylesheets' own --area-end rules never apply; modernLayout stacks the two.
  const sceneInfo = useSceneInfo();
  const agent = slots.companion !== null && view.agentOpen && !view.hideRails;
  const info = slots.sceneInfo !== null && sceneInfo.open && sceneInfo.docked && !view.hideRails;
  const layout = modernLayout({ viewport: size, view: current, sidebar: sidebar && pinned, binderBar: sidebar, agent, info });
  const placed = geometry ?? layout.geometry;
  const slot = (Slot: ModernSlot | null): ReactNode => (Slot === null ? null : <Slot regions={regions} pageId={PAGE_ID} />);
  const skip = (event: ReactMouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    document.getElementById(PAGE_ID)?.focus();
  };

  return (
    <Stage sidebar={sidebar} geometry={placed}>
      <a className="modern-skip" href={`#${PAGE_ID}`} onClick={skip}>
        <Trans>Skip to the page</Trans>
      </a>
      {slot(slots.notices)}
      {slot(slots.topOrnament)}
      {sidebar ? slot(slots.sidebar) : null}
      <Page id={PAGE_ID} label={regions.projectName} view={current}>
        <PageContent regions={regions} view={current} agentOnPage={slots.companion === null} />
      </Page>
      <PageMorph view={current} />
      {slot(slots.bottomOrnament)}
      {slot(slots.sceneInfo)}
      {slot(slots.companion)}
      {slot(slots.palette)}
    </Stage>
  );
}

/**
 * The centre content on the page, as Classic's centre has it below its view switch: a media node's view, the editor (always mounted,
 * so its undo history and its place survive a view change), the corkboard, the pictures or the timeline. The agent drawer stays at
 * the page's foot until the companion slot (#309) takes it.
 */
function PageContent({ regions, view, agentOnPage }: { regions: ShellRegions; view: ModernView; agentOnPage: boolean }): ReactNode {
  const { setCenter, narrow, hideRails } = regions.view;
  // In Codex the centre is still whatever it was; the page shows the codex instead, with the editor kept mounted but hidden.
  const center = view === 'codex' ? null : regions.view.center;
  return (
    <>
      {view === 'codex' ? null : regions.media}
      <div className="modern-editor-host" hidden={view === 'codex'}>
        {regions.editor}
      </div>
      {view === 'codex' ? <div className="modern-codex-view">{regions.codex}</div> : null}
      {center === 'corkboard' && regions.media === null && narrow ? (
        <OpenOnDesktop
          feature="corkboard"
          actions={
            <button type="button" className="button" onClick={() => setCenter('editor')}>
              <Trans>Back to the editor</Trans>
            </button>
          }
        />
      ) : null}
      {center === 'corkboard' && regions.media === null && !narrow ? regions.corkboard : null}
      {center === 'pictures' ? <LazyBoundary label={t`the pictures`}>{regions.pictures}</LazyBoundary> : null}
      {center === 'timeline' ? <LazyBoundary label={t`the timeline`}>{regions.timeline}</LazyBoundary> : null}
      {agentOnPage && !hideRails ? <LazyBoundary label={t`the agent`}>{regions.agent}</LazyBoundary> : null}
    </>
  );
}

/**
 * The page's morph on a view change (§8.3): the new view fades and scales in while the page's width follows modernLayout's
 * `--page-w`. Nothing on the first render, and nothing under reduced motion (the tokens' durations are 0).
 */
function PageMorph({ view }: { view: ModernView }): null {
  const last = useRef(view);
  useLayoutEffect(() => {
    if (last.current === view) return;
    last.current = view;
    const page = document.getElementById(PAGE_ID);
    if (page !== null) morphPage(page);
  }, [view]);
  return null;
}
