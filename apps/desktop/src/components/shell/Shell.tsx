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

import { currentInterface, setModernShellLoader, subscribeInterface } from '../../app/interface.js';
import { ClassicLayout, classicFrameClass } from './ClassicShell.js';
import type * as ModernShellExports from './modern/modern-shell.js';
import type { ShellRegions } from './regions.js';

type ModernShellModule = typeof ModernShellExports;

let modernShell: Promise<ModernShellModule> | null = null;
let modernLoaded: ModernShellModule | null = null;

/** Loads the `modern-shell` chunk, once; a failed load is forgotten, so the next choice of Modern asks again. */
function loadModernShell(): Promise<ModernShellModule> {
  modernShell ??= import('./modern/modern-shell.js').then(
    async (module) => {
      // Below 960 px the narrow layout's own chunk too (#312), so Modern is never laid out without the styles its width needs.
      await module.modernReady();
      modernLoaded = module;
      return module;
    },
    (error: unknown) => {
      modernShell = null;
      throw error;
    },
  );
  return modernShell;
}

// The interface loads the chunk before it says Modern is on (interface.ts); this module is evaluated with the app, before main.tsx
// decides the first interface.
setModernShellLoader(loadModernShell);

export function Shell({ regions, children }: { regions: ShellRegions; children?: ReactNode }): ReactNode {
  const shell = useSyncExternalStore(subscribeInterface, currentInterface);
  const modern = shell === 'modern' ? modernLoaded : null;
  if (modern !== null) {
    const { ModernShell } = modern;
    return (
      <div className="modern-frame" data-testid="shell" data-state={shell}>
        <ModernShell regions={regions} />
        {children}
      </div>
    );
  }
  return (
    <div className={classicFrameClass(regions.view.hideRails)} data-testid="shell" data-state={shell}>
      <ClassicLayout regions={regions} />
      {children}
    </div>
  );
}
