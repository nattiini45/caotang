/**
 * Scene info (modern-interface.md §6, §7.3, §7.5, §8.2, §8.3; #308, M7): the inspector in Modern. A non-modal `role="dialog"` of thick
 * glass that grows out of the title capsule and shrinks back into it, holding the same `Inspector` with the same ids (so the routes to
 * `#inspector-synopsis` keep working), grouped for a popover: the scene's first fields, then **Notes** and **Story details** as
 * disclosures. Below them, **Progress**: today's words and the daily target (the same `TargetQuickSet` as the editor's footer) and the
 * save state in words.
 *
 * - Opening: the title capsule (scene-info-store.ts, `useSceneInfoOpener`), anything that calls `openSceneInfo` (the palette), and the
 *   routes **Edit synopsis** and Ctrl+Shift+Y, which arrive as an inspector request (app/inspector-request.ts) and open it on the
 *   synopsis. Focus moves to the first field as the morph starts, not when it ends (§8.3).
 * - Closing: the opener, **Close**, a click outside, or Escape. Escape in a field commits the field first (its blur writes the draft,
 *   as everywhere else), then closes, and focus returns to the opener (§8.2). A menu or form inside that answers Escape itself keeps
 *   it.
 * - **Keep open** docks it beside the page as a companion panel: a click outside no longer closes it, Escape gives focus back to the
 *   opener and leaves it open. The page moves over for it; from 1,280 px down it overlaps the page as a sheet (§8.4). Focus mode hides
 *   it, as the Writing setting hides Classic's inspector (§8.8).
 *
 * The title capsule is #306's: it registers itself through `useSceneInfoOpener` (scene-info-store.ts), and nothing here changes when it
 * does. Until then the routes open Scene info at the top centre, and focus goes back to where the writer was, or to the page.
 */
/* lingui-set comment="Modern interface: Scene info, the inspector as a popover from the title capsule." */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';

import './scene-info.css';

import { saveStateWords } from '../../../app/integrity-model.js';
import { onInspectorRequest } from '../../../app/inspector-request.js';
import type { InspectorGrouping } from '../../Inspector.js';
import { TargetQuickSet } from '../../TargetQuickSet.js';
import type { ShellRegions } from '../regions.js';
import { SCENE_INFO_ID, durationMs, entranceOf, morphFrom, placePopover, type Box, type Placement } from './scene-info-model.js';
import {
  closeSceneInfo,
  openSceneInfo,
  resetSceneInfo,
  sceneInfoOpener,
  sceneInfoReturnTarget,
  setSceneInfoDocked,
  useSceneInfo,
  type SceneInfoFocus,
} from './scene-info-store.js';
import type { ModernSlotProps } from './slots.js';

export function SceneInfo({ regions }: ModernSlotProps): ReactNode {
  const info = useSceneInfo();

  // The routes (Edit synopsis, Ctrl+Shift+Y): open on the synopsis now, so the route's own focus finds the field in this frame.
  useEffect(
    () =>
      onInspectorRequest((detail, event) => {
        event.preventDefault();
        flushSync(() => openSceneInfo({ focus: detail.field }));
      }),
    [],
  );
  // The workspace leaving (back to Projects) closes it, so the next project does not open on Scene info.
  useEffect(() => () => resetSceneInfo(), []);

  // Focus mode hides Scene info with the rails (§8.8); its state stays, so leaving focus mode brings a docked one back.
  const shown = info.open && !regions.view.hideRails;
  // Below 960 px it is the narrow layout's bottom sheet (§13, #312): never docked beside a page that fills the width.
  const narrow = regions.view.narrow;
  return shown ? (
    <SceneInfoPanel regions={regions} docked={info.docked && !narrow} sheet={narrow} focus={info.focus} request={info.request} />
  ) : null;
}

/** The opener's box, for anchoring and the morph. */
function boxOf(element: Element | null): Box | null {
  if (element === null) return null;
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

/** Puts the popover at its place, or clears the place for the docked panel, which the stylesheet places. */
function applyPlacement(element: HTMLElement, placement: Placement | null): void {
  const { style } = element;
  if (placement === null) {
    for (const property of ['left', 'top', 'bottom', 'width', 'max-height']) style.removeProperty(property);
    delete element.dataset['side'];
    return;
  }
  style.setProperty('left', `${placement.left}px`);
  style.setProperty('top', placement.top === null ? 'auto' : `${placement.top}px`);
  style.setProperty('bottom', placement.bottom === null ? 'auto' : `${placement.bottom}px`);
  style.setProperty('width', `${placement.width}px`);
  style.setProperty('max-height', `${placement.maxHeight}px`);
  element.dataset['side'] = placement.side;
}

function reducedMotionFade(element: HTMLElement): number {
  return durationMs(getComputedStyle(element).getPropertyValue('--dur-fade')) || 120;
}

function SceneInfoPanel({
  regions,
  docked,
  sheet,
  focus,
  request,
}: {
  regions: ShellRegions;
  docked: boolean;
  /** The narrow layout's bottom sheet (§13): placed by the stylesheet, at most 80% of the height, closed by the scrim. */
  sheet: boolean;
  focus: SceneInfoFocus;
  request: number;
}): ReactNode {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const progressId = useId();
  const projectId = useId();
  // The popover's place, from its opener, kept in the window on a resize (§8.2), written through the CSSOM (§11). Docked, the
  // stylesheet places it.
  useLayoutEffect(() => {
    const element = panel.current;
    if (element === null) return;
    if (docked || sheet) {
      applyPlacement(element, null);
      return;
    }
    const place = (): void =>
      applyPlacement(element, placePopover(boxOf(sceneInfoOpener()), { width: window.innerWidth, height: window.innerHeight }));
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [docked, sheet]);

  // The entrance, once per opening (§8.3): a FLIP morph from the opener's box through the Web Animations API, or a fade in place
  // under reduced motion. Nothing waits for it: the panel is interactive and focused at once.
  useLayoutEffect(() => {
    const element = panel.current;
    if (element === null) return;
    const anchor = boxOf(sceneInfoOpener());
    const openMs = durationMs(getComputedStyle(element).getPropertyValue('--dur-3'));
    const kind = entranceOf(openMs, anchor !== null);
    element.dataset['entrance'] = kind;
    if (typeof element.animate !== 'function') return;
    // The narrow sheet rises from the bottom edge (§13); under reduced motion it fades in place.
    if (sheet) {
      element.dataset['entrance'] = openMs === 0 ? 'fade' : 'rise';
      if (openMs === 0) {
        element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: reducedMotionFade(element), easing: 'ease-out' });
        return;
      }
      const rise = getComputedStyle(element).getPropertyValue('--ease-spring').trim() || 'ease-out';
      element.animate([{ transform: 'translateY(100%)' }, { transform: 'none' }], { duration: openMs, easing: rise });
      return;
    }
    if (kind === 'fade' || anchor === null) {
      element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: reducedMotionFade(element), easing: 'ease-out' });
      return;
    }
    const target = boxOf(element);
    if (target === null) return;
    const easing = getComputedStyle(element).getPropertyValue('--ease-spring').trim() || 'ease-out';
    element.animate([{ transform: morphFrom(anchor, target) }, { transform: 'none' }], { duration: openMs, easing });
    // The content fades in after the first third of the morph.
    const body = element.querySelector<HTMLElement>('.scene-info-content');
    body?.animate([{ opacity: 0 }, { opacity: 0, offset: 0.33 }, { opacity: 1 }], { duration: openMs, easing: 'linear' });
  }, [sheet]);

  // Focus moves in as it opens (§8.2, §9.2): to the synopsis, the first field, or the dialog itself when nothing is selected. A second
  // request while open (a route) moves it again.
  useEffect(() => {
    const element = panel.current;
    if (element === null) return;
    const field = element.querySelector<HTMLElement>('#inspector-synopsis');
    (field ?? element).focus();
    // `focus` is read for its change: a route asks for the synopsis, which is the first field too.
  }, [request, focus]);

  // A click outside closes the popover, and focus stays where the writer clicked (§8.2). Not docked: a docked panel stays. A click in
  // the opener is the opener's own toggle, and one in a modal dialog opened from here (a vocabulary editor) is not outside.
  // The narrow sheet leaves this to its scrim (narrow-panels.tsx): everything else is inert, and a close on the press would let the
  // release land on the page under the scrim.
  useEffect(() => {
    if (docked || sheet) return;
    const onDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panel.current?.contains(target)) return;
      if (sceneInfoOpener()?.contains(target)) return;
      if (target instanceof Element && target.closest('[aria-modal="true"]') !== null) return;
      closeSceneInfo({ returnFocus: false });
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [docked, sheet]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // A menu, a picker or the target form inside answers its own Escape first; an input method's Escape is its own.
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return;
    event.preventDefault();
    // Escape in a field commits it first: the field's blur writes its draft (useDebouncedText), as leaving it any other way does.
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== panel.current && panel.current?.contains(active)) active.blur();
    if (docked) sceneInfoReturnTarget()?.focus();
    else closeSceneInfo();
  };

  const grouping: InspectorGrouping = 'disclosures';
  const inspector = isValidElement<{ grouping?: InspectorGrouping }>(regions.inspector)
    ? cloneElement(regions.inspector, { grouping })
    : regions.inspector;
  const { progress } = regions;
  const save = saveStateWords(progress.saveState);
  // The project's line (§7.1): its name, which opens Project details, as the title capsule's project name does.
  const details = regions.actions.find((action) => action.id === 'details');

  return (
    <div
      ref={panel}
      id={SCENE_INFO_ID}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      className={`scene-info${sheet ? ' is-sheet' : docked ? ' is-docked' : ' is-popover'}`}
      data-testid="scene-info"
      onKeyDown={onKeyDown}
    >
      {/* The glass is a layer of its own: a backdrop filter on the dialog would make it the box its menus' fixed positions are
          measured from (CSS Filter Effects), and a status or label menu would open in the wrong place. */}
      <div className="scene-info-glass mat-thick" aria-hidden="true" />
      <div className="scene-info-content">
        <div className="scene-info-head">
          <h2 id={titleId} className="scene-info-heading">
            <Trans>Scene info</Trans>
          </h2>
          {/* No page to keep it beside in the narrow layout. */}
          {sheet ? null : (
            <button
              type="button"
              className="modern-capsule"
              aria-pressed={docked}
              title={t`Keep Scene info open beside the page`}
              onClick={() => setSceneInfoDocked(!docked)}
            >
              <Trans>Keep open</Trans>
            </button>
          )}
          <button type="button" className="modern-capsule" onClick={() => closeSceneInfo()}>
            <Trans>Close</Trans>
          </button>
        </div>
        <div className="scene-info-body">
          {details === undefined ? null : (
            <p className="scene-info-project" data-testid="scene-info-project">
              <span id={`${projectId}-label`} className="field-label">
                <Trans>Project</Trans>
              </span>
              <button
                type="button"
                id={`${projectId}-name`}
                className="modern-capsule"
                aria-labelledby={`${projectId}-label ${projectId}-name`}
                title={details.hint ?? details.label}
                onClick={details.run}
              >
                <bdi>{regions.projectName}</bdi>
              </button>
            </p>
          )}
          {inspector}
          <section className="scene-info-progress" aria-labelledby={progressId} data-testid="scene-info-progress">
            <h3 id={progressId} className="field-label">
              <Trans>Progress</Trans>
            </h3>
            <TargetQuickSet progress={progress.target} onSetTarget={progress.setTarget} />
            <p className="scene-info-save" data-testid="scene-info-save-state" data-state={progress.saveState}>
              {save.text}
              {save.offersBackup ? (
                <>
                  {' '}
                  <button type="button" className="button is-quiet" onClick={progress.exportBackup}>
                    <Trans>Export a backup</Trans>
                  </button>
                </>
              ) : null}
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
