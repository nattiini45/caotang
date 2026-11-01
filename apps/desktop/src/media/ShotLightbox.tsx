/**
 * The lightbox over a shot card's image (storyboard.md §3.1): the picture at full size, over the board, for the writer to look at
 * closely. It is view state: it changes nothing in the project. Escape and the Close button both dismiss it. Focus moves to Close when
 * it opens, stays inside the dialog while it is open (Tab and Shift+Tab wrap around it), and goes back to the element that opened it
 * when it closes.
 */

import { t } from '@lingui/core/macro';
import { accessibleText } from '../i18n/accessible-text.js';
import { isolate } from '@caotang/i18n';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';


/* lingui-set comment="The shot picture viewer. Interpolated values: title is the shot's title." */
export interface ShotLightboxProps {
  /** The picture's object URL, as the card's image slot reads it. */
  readonly url: string;
  /** The shot's title, which the picture is labelled with. */
  readonly title: string;
  /** The picture's alt text, when it has one of its own (a registry picture). Absent: the title. Empty marks a decorative picture. */
  readonly alt?: string;
  /** The line under the picture. Absent: the title. `null`: no line. */
  readonly caption?: string | null;
  /** The element that opened the lightbox, which gets focus back when it closes. Absent: the element focused when it opened. */
  readonly returnFocusTo?: HTMLElement | null;
  readonly onClose: () => void;
}

/** The elements a Tab can land on inside the dialog. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ShotLightbox({ url, title, alt, caption, returnFocusTo, onClose }: ShotLightboxProps): ReactNode {
  useLingui();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  // The latest onClose, read when a key is pressed. The listener below is set up once per opening, so a parent that passes a new
  // callback on each render neither moves the focus again nor drops the listener.
  const closeNow = useRef(onClose);
  useEffect(() => {
    closeNow.current = onClose;
  });

  useEffect(() => {
    const opener = returnFocusTo !== undefined ? returnFocusTo : document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeNow.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      // The opener may have gone (its card was removed while the picture was open), and then there is nothing to return to.
      if (opener !== null && opener.isConnected) opener.focus();
    };
  }, [returnFocusTo]);

  /** Tab and Shift+Tab stay inside the dialog: from its last element they go to its first, and back from the first to the last. */
  const onDialogKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) {
      event.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || !dialog.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else if (active === last || !dialog.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div ref={dialogRef} className="sb-lightbox" role="dialog" aria-modal="true" aria-label={accessibleText(t`Image of ${{ title: isolate(title) }}`)} onKeyDown={onDialogKey}>
      <div className="sb-lightbox-backdrop" onClick={onClose} aria-hidden="true" />
      <figure className="sb-lightbox-frame">
        <img src={url} alt={alt ?? title} />
        {caption === null ? null : <figcaption dir="auto">{caption ?? title}</figcaption>}
      </figure>
      <button ref={closeRef} type="button" className="button is-quiet sb-lightbox-close" onClick={onClose}>
        <Trans>Close</Trans>
      </button>
    </div>
  );
}
