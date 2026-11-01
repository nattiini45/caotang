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
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';

import '../../../tokens/modern.css';
import './shell-modern.css';

import { LazyBoundary } from '../../lazy-view.js';
import { OpenOnDesktop } from '../../narrow.js';
import type { ShellRegions } from '../regions.js';
import { MODERN_SLOTS, type ModernSlot, type ModernSlots } from './slots.js';
import { Page, Stage, type StageGeometry } from './stage.js';

export { MODERN_SLOTS, type ModernSlot, type ModernSlotProps, type ModernSlots } from './slots.js';
export { Page, Stage, geometryProperties, type StageGeometry } from './stage.js';

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
  /** The page's place; the stylesheet's defaults when left out (#306's modernLayout supplies it). */
  geometry?: StageGeometry;
}): ReactNode {
  const { view } = regions;
  const sidebar = slots.sidebar !== null && !view.hideRails && !view.narrow;
  const slot = (Slot: ModernSlot | null): ReactNode => (Slot === null ? null : <Slot regions={regions} pageId={PAGE_ID} />);
  const skip = (event: ReactMouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    document.getElementById(PAGE_ID)?.focus();
  };

  return (
    <Stage sidebar={sidebar} {...(geometry === undefined ? {} : { geometry })}>
      <a className="modern-skip" href={`#${PAGE_ID}`} onClick={skip}>
        <Trans>Skip to the page</Trans>
      </a>
      {slot(slots.notices)}
      {slot(slots.topOrnament)}
      {sidebar ? slot(slots.sidebar) : null}
      <Page id={PAGE_ID} label={regions.projectName} view={view.center}>
        <PageContent regions={regions} agentOnPage={slots.companion === null} />
      </Page>
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
function PageContent({ regions, agentOnPage }: { regions: ShellRegions; agentOnPage: boolean }): ReactNode {
  const { center, setCenter, narrow, hideRails } = regions.view;
  return (
    <>
      {regions.media}
      {regions.editor}
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
