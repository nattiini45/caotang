/**
 * Modern's notices (modern-interface.md §8.6; M10, #311): the `notices` slot. Classic's status line, the storage banner and the
 * picture-aware storage notices become toast capsules of glass at the top centre of the stage. Each keeps its own element, so its role
 * (`status`, or `alert` for an error), its words, its link and its buttons are Classic's, and so is the rule: a notice stays until it
 * is dismissed or replaced, and nothing here dismisses one on a timer (WCAG 2.2.1). The stale-tab notice stays a dialog.
 *
 * Each notice sits in a toast of its own (surfaces-modern.css): a toast whose notice renders nothing takes no room, and a new toast
 * arrives with a short slide (none under reduced motion).
 */

import type { ReactNode } from 'react';

import type { ModernSlotProps } from './slots.js';

export function ModernNotices({ regions }: ModernSlotProps): ReactNode {
  return (
    <div className="modern-notices" data-testid="modern-notices">
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
