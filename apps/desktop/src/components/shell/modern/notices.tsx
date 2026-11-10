/**
 * Modern's notices (modern-interface.md §8.6; M10, #311): the `notices` slot. Classic's status line, the storage banner and the
 * picture-aware storage notices become toast capsules of glass at the top centre of the stage. Each keeps its own element, so its role
 * (`status`, or `alert` for an error), its words, its link and its buttons are Classic's, and so is the rule: a notice stays until it
 * is dismissed or replaced, and nothing here dismisses one on a timer (WCAG 2.2.1). The stale-tab notice stays a dialog.
 *
 * Each notice sits in a toast of its own (surfaces-modern.css): a toast whose notice renders nothing takes no room, and a new toast
 * arrives with a short slide (none under reduced motion).
 */

import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';

import { topModal } from '../../modal.js';
import { modalStack } from '../../modal-stack.js';

import type { ModernSlotProps } from './slots.js';

export function ModernNotices({ regions }: ModernSlotProps): ReactNode {
  const state = useSyncExternalStore(modalStack.subscribe, modalStack.getSnapshot);
  const ref = useRef<HTMLDivElement>(null);
  const covered = state.kind === 'open';
  const top = state.entries.at(-1)?.id;
  useEffect(() => {
    const notices = ref.current;
    const dialog = topModal();
    if (!covered || notices === null || dialog === null) return;
    const announcements = (['status', 'alert'] as const).map((role) => {
      const node = document.createElement('div');
      node.className = 'visually-hidden';
      node.setAttribute('role', role);
      node.setAttribute('aria-live', role === 'alert' ? 'assertive' : 'polite');
      node.setAttribute('aria-atomic', 'true');
      node.dataset['testid'] = `modal-notice-${role}`;
      dialog.append(node);
      return { role, node };
    });
    const update = (): void => {
      for (const { role, node } of announcements) {
        const message = Array.from(notices.querySelectorAll(`[role="${role}"]`)).map((notice) => {
          const text = notice.cloneNode(true) as HTMLElement;
          for (const control of text.querySelectorAll('button:not([class~="status-link"]), input, select, textarea')) control.remove();
          return text.textContent?.trim();
        }).join('\n');
        if (node.textContent !== message) node.textContent = message;
      }
    };
    const observer = new MutationObserver(update);
    observer.observe(notices, { childList: true, subtree: true, characterData: true });
    queueMicrotask(update);
    return () => {
      observer.disconnect();
      for (const { node } of announcements) node.remove();
    };
  }, [covered, top]);
  return (
    <div ref={ref} className="modern-notices" data-testid="modern-notices" data-state={covered ? 'covered' : 'visible'} inert={covered}>
      {regions.storageBanner === null ? null : (
        <div className="modern-toast" data-testid="modern-toast">
          {regions.storageBanner}
        </div>
      )}
      {/* The picture-aware notices take the general banner's place, never sit beside it. */}
      {regions.storageBanner === null ? (
        <div className="modern-toast" data-testid="modern-toast">
          {regions.pictureNotices}
        </div>
      ) : null}
      {regions.status === null ? null : (
        <div className="modern-toast" data-testid="modern-toast">
          {regions.status}
        </div>
      )}
    </div>
  );
}
