/**
 * What every renderer of a comic page agrees on beyond geometry — comics.md §4 and §5. The comic PDF and the CBZ and EPUB's page raster
 * draw the same balloon the same way: which face its text starts in, the sizes the text is tried at, the line weights and the scalloped
 * outline of a thought. They differ in the surface they draw on, never in these rules, so the numbers live here once.
 *
 * Sizes and weights are in points because that is how the page editor's spec states them; a renderer converts to its own unit.
 */

import { balloonStyleData } from './layout.js';
import { parseEmphasis, toLetteringCaps } from './lettering.js';
import { drawnKind, type Balloon, type ComicBookSettings } from './model.js';

/** The five faces a balloon's text is set in: Comic Neue's four, and Bangers for sound effects. */
export type LetteringFace = 'regular' | 'italic' | 'bold' | 'bold-italic' | 'sfx';

export const LETTERING_MAX_PT = 9;
export const LETTERING_MIN_PT = 4.5;
export const SFX_MAX_PT = 40;
export const SFX_MIN_PT = 8;
export const SIZE_STEP_PT = 0.5;

export const THIN_BORDER_PT = 0.75;
export const BOLD_BORDER_PT = 2.5;
export const BALLOON_LINE_PT = 1;
export const BALLOON_BOLD_LINE_PT = 2;

/** A panel's border weight in points; a border that is not `thin` or `bold` and is not `none` draws as thin. */
export function borderPt(border: string | undefined): number {
  return border === 'none' ? 0 : border === 'bold' ? BOLD_BORDER_PT : THIN_BORDER_PT;
}

/** A balloon outline's line weight in points, for the weight its kind's style names. */
export function balloonLinePt(stroke: 'none' | 'normal' | 'bold'): number {
  return stroke === 'bold' ? BALLOON_BOLD_LINE_PT : stroke === 'normal' ? BALLOON_LINE_PT : 0;
}

/** The face a balloon's text starts in: its kind's, or the face its own `style` names. */
export function balloonBaseFace(balloon: Pick<Balloon, 'kind' | 'style'>): LetteringFace {
  const style = balloonStyleData(balloon.kind);
  const role = balloon.style === 'sfx' || balloon.style === 'lettering' ? balloon.style : style.fontRole;
  if (role === 'sfx') return 'sfx';
  if (style.italic) return 'italic';
  return drawnKind(balloon.kind) === 'shout' ? 'bold' : 'regular';
}

/**
 * The sizes a balloon's text is tried at, largest first: the balloon's own `fontSize` when it has one, otherwise from the face's ceiling
 * down to its floor in half-point steps. The first size at which the text fits its box is the one it is set at; text that fits at none is
 * set at the last.
 */
export function letteringSizesPt(base: LetteringFace, explicit: number | undefined): number[] {
  if (explicit !== undefined && explicit > 0) return [explicit];
  const [max, min] = base === 'sfx' ? [SFX_MAX_PT, SFX_MIN_PT] : [LETTERING_MAX_PT, LETTERING_MIN_PT];
  const sizes: number[] = [];
  for (let size = max; size >= min - 1e-9; size -= SIZE_STEP_PT) sizes.push(size);
  return sizes;
}

export interface FacedRun {
  readonly text: string;
  readonly style: LetteringFace;
}

/** A balloon's text as runs in the faces it is set in, with the capitals made and the `**` markers gone. Emphasis is bold italic, except in sound effects. */
export function balloonRuns(balloon: Balloon, base: LetteringFace, settings: Pick<ComicBookSettings, 'capsTransform' | 'esszett'>, language: string): FacedRun[] {
  const caps = { capsTransform: settings.capsTransform !== false, esszett: settings.esszett === true, language };
  return parseEmphasis(balloon.text).map((run) => ({
    text: toLetteringCaps(run.text, caps),
    style: run.emphasis && base !== 'sfx' ? 'bold-italic' : base,
  }));
}

export type PathOp =
  | readonly ['M', number, number]
  | readonly ['L', number, number]
  | readonly ['C', number, number, number, number, number, number]
  | readonly ['Z'];

/** A scalloped outline: a bump on each of `lobes` equal angles of the ellipse, drawn as cubic curves. The thought balloon's outline. */
export function cloudPathOps(cx: number, cy: number, rx: number, ry: number, lobes: number): PathOp[] {
  const at = (t: number): [number, number] => [cx + rx * Math.cos(t), cy + ry * Math.sin(t)];
  const start = at(0);
  const ops: PathOp[] = [['M', start[0], start[1]]];
  for (let i = 0; i < lobes; i += 1) {
    const t0 = (2 * Math.PI * i) / lobes;
    const t1 = (2 * Math.PI * (i + 1)) / lobes;
    const tm = (t0 + t1) / 2;
    const p0 = at(t0);
    const p1 = at(t1);
    const mid = at(tm);
    const nx = Math.cos(tm) / rx;
    const ny = Math.sin(tm) / ry;
    const norm = Math.hypot(nx, ny) || 1;
    const bump = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) * 0.32;
    const q: [number, number] = [mid[0] + (nx / norm) * bump * 2, mid[1] + (ny / norm) * bump * 2];
    ops.push(['C', p0[0] + ((q[0] - p0[0]) * 2) / 3, p0[1] + ((q[1] - p0[1]) * 2) / 3, p1[0] + ((q[0] - p1[0]) * 2) / 3, p1[1] + ((q[1] - p1[1]) * 2) / 3, p1[0], p1[1]]);
  }
  ops.push(['Z']);
  return ops;
}
