/**
 * The workspace's frame and the shell inside it (modern-interface.md §4.1). `Workspace` hands its regions and its dialogs here; this
 * draws the workspace element and puts the chosen shell's layout in it, then the dialogs after it.
 *
 * The frame is one element in both shells, at the same place in the tree, so a live switch (Settings › Appearance › Interface)
 * replaces only the layout: the dialogs (Settings itself among them) stay mounted, with their drafts and their focus. The feature
 * regions inside the layout are the same elements `Workspace` built, with their state above both shells.
 *
 * The shell follows {@link currentInterface}: Classic until the `modern-shell` chunk has loaded (interface.ts), so Modern never
 * renders without its styles, and Classic's first load never carries Modern's code (§12).
 */

import { useSyncExternalStore, type ReactNode } from 'react';

import { currentInterface, loadedModernShell, subscribeInterface } from '../../app/interface.js';
import { ClassicLayout, classicFrameClass } from './ClassicShell.js';
import type { ShellRegions } from './regions.js';

export function Shell({ regions, children }: { regions: ShellRegions; children?: ReactNode }): ReactNode {
  const shell = useSyncExternalStore(subscribeInterface, currentInterface);
  const modern = shell === 'modern' ? loadedModernShell() : null;
  if (modern !== null) {
    const { ModernShell } = modern;
    return (
      <div className="modern-frame">
        <ModernShell regions={regions} />
        {children}
      </div>
    );
  }
  return (
    <div className={classicFrameClass(regions.view.hideRails)}>
      <ClassicLayout regions={regions} />
      {children}
    </div>
  );
}
