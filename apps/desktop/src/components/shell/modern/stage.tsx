/**
 * The stage and the page (modern-interface.md §5.3, §6): the shell-only containers M4 (#305) builds. The **stage** is the wallpaper
 * and everything floating on it; the **page** is one floating sheet of paper, centred in the room the sidebar and the companion
 * leave, holding the centre content.
 *
 * Geometry is custom properties on the stage (shell-modern.css has the defaults). {@link StageGeometry} sets them through the CSSOM
 * (React's `style` prop), which `style-src 'self'` does not govern (§11); #306's `modernLayout` computes it.
 */

import type { ReactNode } from 'react';

import { geometryProperties, type StageGeometry } from './geometry.js';

export { geometryProperties, type StageGeometry } from './geometry.js';

export function Stage({
  geometry,
  sidebar,
  children,
}: {
  geometry?: StageGeometry;
  /** Whether a sidebar takes room at the inline-start edge (until a geometry says how much). */
  sidebar: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <div className={`modern-stage${sidebar ? ' has-sidebar' : ''}`} data-testid="modern-stage" style={geometryProperties(geometry)}>
      {/* Decorative: drawn once by the stylesheet, fixed, never animated, and hidden from assistive technology (§5.3). */}
      <div className="modern-wallpaper" aria-hidden="true" data-testid="modern-wallpaper" />
      {children}
    </div>
  );
}

/** The page: paper, never glass. A `main` named by the project's title (§9.1); `view` names the centre view for #306's morph. */
export function Page({ id, label, view, children }: { id: string; label: string; view: string; children: ReactNode }): ReactNode {
  return (
    <div className="modern-page-area">
      <main id={id} className="modern-page mat-paper" aria-label={label} data-view={view} tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
