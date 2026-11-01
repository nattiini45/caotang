/**
 * The agent's companion window (M8, #309; modern-interface.md §7.4, §8.3, §8.4, §8.10, §8.11, §9.1): Modern's `companion` slot. A
 * non-modal `aside` named "Agent", of thick glass, at the page's inline-end edge, hosting the workspace's own `AgentPanel` with
 * `placement="window"` (always open, **Agent**, **Mode**, **Stop** and **Close** in its header, the Intent box in its footer).
 *
 * - It opens from **Ask** (#306, through companion-actions.ts), from Ctrl+J (Cmd+J, the keymap's `agent-toggle`, which only this
 *   listener asks for), and from every `runAgentIntent` caller, all through the workspace's `agentOpen`. It morphs out of whatever
 *   opened it and shrinks back into **Ask** (§8.3); under reduced motion it fades in 120 ms and closes at once.
 * - Above 1,280 px the page moves over and recedes (`scale(.985)`, not under reduced motion); from 1,280 px down the window overlaps the
 *   page as a sheet over a scrim (§8.4), and below 960 px it is a full-width sheet.
 * - Escape inside it keeps Classic's meaning first (AgentPanel: with the Intent box empty and a stoppable turn, Escape stops it);
 *   otherwise Escape, **Close**, Ctrl+J or a click on the scrim closes it, and focus returns to **Ask** (the opener, or the page, until
 *   **Ask** exists) unless the writer has already moved it. A turn keeps running while the window is closed: the panel stays mounted,
 *   hidden, so its Intent draft survives too.
 *
 * Focus mode hides the window with the rails (§8.8).
 */
/* lingui-set comment="Modern interface: the agent's companion window." */

import { t } from '@lingui/core/macro';
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';

import './companion.css';

import { isImeEnter, keyFacts, resolveKey } from '../../../app/keymap.js';
import { LazyBoundary } from '../../lazy-view.js';
import type { ShellView } from '../regions.js';
import { ASK_ID, COMPANION_ID, noteCompanionOpener, takeCompanionOpener, toggleCompanion } from './companion-actions.js';
import { durationMs, morphFrames, type Box } from './companion-model.js';
import type { ModernSlotProps } from './slots.js';

/** The controls a click may open the window from: the morph's origin when no control named itself. */
const OPENER = 'button, a[href], [role="button"], [role="menuitem"], [role="option"], [role="radio"]';

export function CompanionWindow({ regions, pageId }: ModernSlotProps): ReactNode {
  const { view } = regions;
  const open = view.agentOpen && !view.hideRails;
  const aside = useRef<HTMLElement>(null);
  const running = useRef<Animation[]>([]);
  // The `open` the last change was handled for: the first render, and React's second run of an effect in development, are not changes.
  const handledOpen = useRef(open);
  // The handlers read the view through a ref, so one listener serves every render.
  const viewRef = useRef<ShellView>(view);
  useLayoutEffect(() => {
    viewRef.current = view;
  });
  // The control the window last grew out of: where focus returns when there is no Ask.
  const opener = useRef<Element | null>(null);

  // Ctrl+J (Cmd+J): resolved before the text-field rule, so it works while typing; it yields to a composing input method (§8.11). A
  // modal dialog keeps its keys. Captured, so an editor that stops a key's propagation does not swallow the chord.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target;
      if (target instanceof Element && target.closest('dialog') !== null) return;
      const inTextField =
        target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement || (target instanceof HTMLElement && target.isContentEditable);
      const action = resolveKey({ ...keyFacts(event), composing: isImeEnter(event) }, { inTextField, inBinder: false, shell: 'modern' });
      if (action !== 'agent-toggle') return;
      // The browser's own Ctrl+J (downloads) is the page's to cancel (§18, Q3).
      event.preventDefault();
      if (viewRef.current.hideRails) return;
      toggleCompanion(viewRef.current, document.getElementById(ASK_ID));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // A click on a control outside the window remembers it, so a `runAgentIntent` caller (an empty state, Fix with agent) is where the
  // window grows from. Captured, so it runs before the control's own handler opens the window; Ask's own note replaces it.
  useEffect(() => {
    const onClick = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Element) || aside.current?.contains(target) === true) return;
      const control = target.closest(OPENER);
      if (control !== null) noteCompanionOpener(control);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  // Open and close. React draws the window `hidden` while closed; the close keeps it drawn by hand while it shrinks back. The first
  // render shows the window as it is, without a morph and without taking focus (a demo the first-run card started opens the agent with
  // the project).
  useLayoutEffect(() => {
    const element = aside.current;
    if (handledOpen.current === open || element === null) return;
    handledOpen.current = open;
    stop(running.current);
    running.current = [];
    if (open) {
      const active = document.activeElement;
      const from = takeCompanionOpener() ?? (active !== null && active !== document.body && !element.contains(active) ? active : document.getElementById(ASK_ID));
      opener.current = from;
      const grow = durationMs(cssToken('--dur-3'));
      const frames = grow === 0 || from === null ? null : morphFrames(box(from), box(element));
      if (frames !== null) {
        element.dataset['morph'] = 'grow';
        const move = element.animate([...frames], { duration: grow, easing: easing('--ease-spring') });
        // The content fades in after the first third.
        const content = element.firstElementChild;
        const fade = content?.animate([{ opacity: 0 }, { opacity: 0, offset: 1 / 3 }, { opacity: 1 }], { duration: grow, easing: 'linear' });
        running.current = fade === undefined ? [move] : [move, fade];
      } else {
        // Reduced motion, or nothing to grow from: the window appears in place with a short fade (§5.5).
        element.dataset['morph'] = 'fade';
        const fadeMs = durationMs(cssToken('--dur-fade')) || 120;
        running.current = [element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: fadeMs, easing: 'linear' })];
      }
      // Focus moves as the morph starts, not when it ends; the window is interactive at once (§8.3).
      focusInto(element);
      return;
    }
    // Focus returns as the close starts, to Ask, unless the writer has already moved it somewhere else.
    const active = document.activeElement;
    const back = opener.current;
    const target = document.getElementById(ASK_ID) ?? (back?.isConnected === true && !element.contains(back) ? back : null);
    if (active === null || active === document.body || element.contains(active)) {
      (target instanceof HTMLElement ? target : document.getElementById(pageId))?.focus();
    }
    const closeMs = durationMs(cssToken('--dur-2'));
    const frames = closeMs === 0 || target === null ? null : morphFrames(box(target), box(element, true));
    if (frames === null) {
      element.dataset['morph'] = 'none';
      return;
    }
    element.dataset['morph'] = 'shrink';
    element.hidden = false;
    const shrink = element.animate([frames[1], frames[0]], { duration: closeMs, easing: easing('--ease-standard'), fill: 'forwards' });
    running.current = [shrink];
    shrink.onfinish = () => {
      // Hidden before the held last frame is let go, so the window never flashes back to full size.
      element.hidden = true;
      shrink.cancel();
      running.current = [];
    };
  }, [open, pageId]);

  useEffect(() => () => stop(running.current), []);

  // Opened before the agent's code has loaded (Ctrl+J as the project opens), focus waits on the window itself; it moves on into the
  // Intent box once the panel is drawn, unless the writer has moved it by then.
  useEffect(() => {
    const element = aside.current;
    if (!open || element === null || typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(() => {
      if (document.activeElement !== element) return;
      if (element.querySelector('.agent-intent input:not(:disabled), [data-testid="agent-close"]') === null) return;
      focusInto(element);
      observer.disconnect();
    });
    observer.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    return () => observer.disconnect();
  }, [open]);

  const close = (): void => view.setAgentOpen(false);
  return (
    <>
      {open ? <div className="modern-companion-scrim is-open" aria-hidden="true" data-testid="modern-companion-scrim" onClick={close} /> : null}
      <aside
        ref={aside}
        id={COMPANION_ID}
        className={`modern-companion mat-thick${open ? ' is-open' : ''}`}
        aria-label={t`Agent`}
        data-testid="modern-companion"
        hidden={!open}
        tabIndex={-1}
      >
        <LazyBoundary label={t`the agent`}>{regions.agentWindow}</LazyBoundary>
      </aside>
    </>
  );
}

/** Focus goes to the Intent box, or to Close while the box is off (no provider), or to the window itself while the panel loads. */
function focusInto(element: HTMLElement): void {
  const intent = element.querySelector<HTMLInputElement>('.agent-intent input:not(:disabled)');
  const closer = element.querySelector<HTMLElement>('[data-testid="agent-close"]');
  (intent ?? closer ?? element).focus();
}

/** An element's box; `reveal` measures one React has just hidden, by showing it for the measure (inside a layout effect, before paint). */
function box(element: HTMLElement | Element, reveal = false): Box {
  const hidden = reveal && element instanceof HTMLElement && element.hidden;
  if (hidden) element.hidden = false;
  const rect = element.getBoundingClientRect();
  if (hidden) element.hidden = true;
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function cssToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name);
}

/** A timing-function token's value: the Web Animations API takes the function itself, not `var()`. */
function easing(name: string): string {
  const value = cssToken(name).trim();
  return value === '' ? 'ease' : value;
}

function stop(animations: readonly Animation[]): void {
  for (const animation of animations) animation.cancel();
}
