/**
 * M4's provisional notices (#305): the storage banner, the picture notices and the status line, unchanged, floating at the top centre
 * on paper. #311 replaces this with the toast capsule and the glass notice (modern-interface.md §8.6) and deletes this file.
 */

import type { ReactNode } from 'react';

import type { ModernSlotProps } from './slots.js';

export function InterimNotices({ regions }: ModernSlotProps): ReactNode {
  return (
    <div className="modern-notices" data-testid="modern-notices">
      {regions.storageBanner}
      {/* The picture-aware notices take the general banner's place, never sit beside it. */}
      {regions.storageBanner === null ? regions.pictureNotices : null}
      {regions.status}
    </div>
  );
}
