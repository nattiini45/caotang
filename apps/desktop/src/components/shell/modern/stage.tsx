/**
 * The stage and the page (modern-interface.md §5.3, §6): the shell-only containers M4 (#305) builds. The **stage** is the wallpaper
 * and everything floating on it; the **page** is one floating sheet of paper, centred in the room the sidebar and the companion
 * leave, holding the centre content.
 *
 * Geometry is custom properties on the stage (shell-modern.css has the defaults). {@link StageGeometry} sets them through the CSSOM
 * (React's `style` prop), which `style-src 'self'` does not govern (§11); #306's `modernLayout` computes it.
 */

import type { CSSProperties, ReactNode } from 'react';

/** The page's place on the stage, in CSS px. A value left out keeps the stylesheet's default. */
export interface StageGeometry {
  /** The page's width (the view's own width, clamped to the room left). Default 780. */
  readonly pageWidth?: number;
  /** From the stage's top to the page's top edge. Default max(84, 11% of the height). */
  readonly pageTop?: number;
  /** From the page's bottom edge to the stage's bottom, the bottom ornament's room. Default 112. */
  readonly pageBottom?: number;
  /** Room taken at the inline-start edge (the sidebar), before the page area. Default 0, or the sidebar's with `has-sidebar`. */
  readonly areaStart?: number;
  /** Room taken at the inline-end edge (the companion window, a docked Scene info). Default 0. */
  readonly areaEnd?: number;
}

const PROPERTIES: Readonly<Record<keyof StageGeometry, string>> = {
  pageWidth: '--page-w',
  pageTop: '--page-top',
  pageBottom: '--page-bottom',
  areaStart: '--area-start',
  areaEnd: '--area-end',
};

/** The custom properties a geometry sets on the stage, or `undefined` when it sets none (so no style is written). */
export function geometryProperties(geometry: StageGeometry | undefined): CSSProperties | undefined {
  if (geometry === undefined) return undefined;
  const style: Record<string, string> = {};
  for (const key of Object.keys(PROPERTIES) as (keyof StageGeometry)[]) {
    const value = geometry[key];
    if (value !== undefined && Number.isFinite(value)) style[PROPERTIES[key]] = `${Math.max(0, Math.round(value))}px`;
  }
  return Object.keys(style).length === 0 ? undefined : (style as CSSProperties);
}

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
