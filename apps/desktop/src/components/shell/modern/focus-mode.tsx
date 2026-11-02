/**
 * Focus mode in Modern (modern-interface.md §8.8). Its own lazy chunk, loaded the first time focus mode is turned on, so Modern's first
 * load does not carry it (§12).
 *
 * While the Writing setting hides the rails with focus mode, the ornaments, the binder tab bar (and a sidebar it opened), Scene info and
 * the agent window fade away; they stay mounted, with their state. They come back while the pointer is near an edge of the window or
 * over one of them, while focus is in one of them by the keyboard (Tab reaches them where they are), and after a key pressed outside a
 * text field, or Tab, F6 or Escape anywhere; typing in the text never brings them back. They fade again a moment after none of that
 * holds. The fade is `--dur-2`, which reduced motion makes 0, so nothing fades then.
 *
 * A **Leave focus mode** glass capsule stays at the top while focus mode is on, whatever the setting, so the button that left the mode
 * is always there (ui-modules §1). It runs the same shell action as **⋯** › Leave focus mode, the palette and Ctrl+Shift+F.
 */

import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';

import type { ShellRegions } from '../regions.js';
import './focus-modern.css';

/** What fades in focus mode, with the menus it opens: the pointer over any of them, or keyboard focus in one, keeps them shown. */
export const FOCUS_CHROME = ['.modern-ornament', '.modern-binder', '.scene-info', '.modern-companion', '.modern-menu-popover', '.modern-popover'].join();
/** How near an edge of the window the pointer brings them back, in CSS px. */
export const EDGE_PX = 56;
/** How long they stay after nothing holds them any more, in ms. */
export const HIDE_DELAY_MS = 600;

/** Whether a point is within {@link EDGE_PX} of an edge of a window this size. */
export function nearEdge(x: number, y: number, width: number, height: number): boolean {
  return x < EDGE_PX || y < EDGE_PX || x > width - EDGE_PX || y > height - EDGE_PX;
}

/** Whether a key brings them back: Tab, F6 or Escape anywhere; any key while focus is not in a text field. Typing never does. */
export function revealsOnKey(key: string, inTextField: boolean): boolean {
  return key === 'Tab' || key === 'F6' || key === 'Escape' || !inTextField;
}

function inTextField(target: EventTarget | null): boolean {
  return target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement || (target instanceof HTMLElement && target.isContentEditable);
}

function inChrome(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(FOCUS_CHROME) !== null;
}

export function FocusMode({ regions, pageId }: { regions: ShellRegions; pageId: string }): ReactNode {
  const capsule = useRef<HTMLDivElement>(null);
  const hides = regions.view.hideRails;
  const leave = regions.actions.find((action) => action.id === 'focus');

  // The stage's data-focus: 'hidden' or 'shown' while the chrome fades, absent otherwise. Written straight to the DOM, so a Tab's own
  // keydown shows the chrome before the browser moves focus.
  useEffect(() => {
    const stage = capsule.current?.closest<HTMLElement>('.modern-stage');
    if (!hides || stage === null || stage === undefined) return;
    let alive = true;
    let pointer = false;
    let key = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Focus there holds them only when the keyboard put it there: a click, or focus handed back to ⋯ after a click in its menu, does not.
    let keyboard = false;
    const focused = (): boolean => keyboard && inChrome(document.activeElement);
    const update = (): void => {
      if (!alive) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (pointer || key || focused()) stage.dataset['focus'] = 'shown';
      else if (stage.dataset['focus'] !== 'hidden') {
        timer = setTimeout(() => {
          timer = undefined;
          if (!(pointer || key || focused())) stage.dataset['focus'] = 'hidden';
        }, HIDE_DELAY_MS);
      }
    };
    const onPointer = (event: PointerEvent): void => {
      pointer = nearEdge(event.clientX, event.clientY, window.innerWidth, window.innerHeight) || inChrome(event.target);
      if (!pointer) key = false;
      update();
    };
    const onPointerDown = (): void => {
      keyboard = false;
    };
    const onKey = (event: KeyboardEvent): void => {
      keyboard = true;
      key = revealsOnKey(event.key, inTextField(event.target));
      update();
    };
    // Focus that lands outside the chrome (a Tab past it, a click on the page) ends a key's reveal.
    const onFocusIn = (event: FocusEvent): void => {
      if (!inChrome(event.target)) key = false;
      update();
    };
    const onFocusOut = (): void => {
      setTimeout(update, 0);
    };
    stage.dataset['focus'] = 'hidden';
    update();
    window.addEventListener('pointermove', onPointer, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener('pointermove', onPointer, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      delete stage.dataset['focus'];
    };
  }, [hides]);

  return (
    <div ref={capsule} className="modern-focus-leave mat-glass" data-testid="modern-focus-leave">
      {leave === undefined ? null : (
        <button
          type="button"
          className="modern-capsule"
          title={leave.hint}
          onClick={() => {
            leave.run();
            document.getElementById(pageId)?.focus();
          }}
        >
          {leave.label}
        </button>
      )}
    </div>
  );
}
