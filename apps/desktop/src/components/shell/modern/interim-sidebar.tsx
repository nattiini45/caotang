/**
 * M4's provisional binder (#305): the same `Binder` with its footer, on paper at the inline-start edge, so Modern (Preview) can open a
 * scene. #307 replaces this with the glass tab bar that grows into the sidebar (modern-interface.md §8.5) and deletes this file.
 */
/* lingui-set comment="Modern interface, provisional binder panel." */

import { t } from '@lingui/core/macro';
import type { ReactNode } from 'react';

import type { ModernSlotProps } from './slots.js';

export function InterimSidebar({ regions }: ModernSlotProps): ReactNode {
  if (regions.view.hideRails || regions.view.narrow) return null;
  return (
    <nav className="modern-sidebar" aria-label={t`Binder`} data-testid="modern-sidebar">
      {regions.binder}
    </nav>
  );
}
