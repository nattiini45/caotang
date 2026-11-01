/**
 * The stage's geometry (modern-interface.md §8.4, §11): where the page sits, as the custom properties shell-modern.css reads. Pure, so
 * #306's `modernLayout` and the unit specs use it without React. Written through the CSSOM (React's `style` prop), which
 * `style-src 'self'` does not govern.
 */

import type { CSSProperties } from 'react';

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

