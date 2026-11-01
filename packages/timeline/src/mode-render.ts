/**
 * How each timeline mode renders — [timeline.md §3.6](../../../docs/architecture/timeline.md).
 *
 * A data table beside `EXEMPTIONS` in coherence: a new mode is one row here and one there, and the `Record` type makes
 * a missing row a compile error. Every row has a glyph and a pattern, never colour alone. A scene with no
 * `dayOffset` keeps its glyph and takes the `dashed` pattern, whatever its mode.
 */

import { TIMELINE_MODES } from '@caotang/coherence';

import type { ModeGlyph, PatternName, TimelineMode } from './model.js';

/** The lane a mode takes under group-by mode (§3.5). */
export type ModeLaneGroup = 'main' | 'parallel' | 'frame' | 'dream' | 'backstory';

export interface ModeRender {
  glyph: string;
  pattern: PatternName;
  laneGroup: ModeLaneGroup;
  /** The braid connector is drawn heavier: the scene is told out of day order on purpose. */
  emphasiseConnector: boolean;
  /** `false` keeps the scene out of the overlap visuals (dream and mythic, which are never counted in Main overlap; simultaneous, which is declared). */
  overlapHighlight: boolean;
  /** A dotted tether runs from the bar to the day it is dreamt. */
  tether: boolean;
  /** The first and last scenes of the mode bracket the inner story. */
  bracket: boolean;
  /** Same-day scenes of the mode share one column under a bracket. */
  stacked: boolean;
  /** On the braid axis a connector links the scene back to the first scene. */
  linksToFirst: boolean;
  /** An axis break labelled for it precedes the scene. */
  precededByBreak: boolean;
}

const base: Omit<ModeRender, 'glyph' | 'pattern' | 'laneGroup'> = {
  emphasiseConnector: false,
  overlapHighlight: true,
  tether: false,
  bracket: false,
  stacked: false,
  linksToFirst: false,
  precededByBreak: false,
};

export const MODE_RENDER: Readonly<Record<TimelineMode, ModeRender>> = {
  linear: { ...base, glyph: '\u25ac', pattern: 'solid', laneGroup: 'main' },
  flashback: { ...base, glyph: '\u21b6', pattern: 'solid', laneGroup: 'main', emphasiseConnector: true },
  'flash-forward': { ...base, glyph: '\u21b7', pattern: 'solid', laneGroup: 'main', emphasiseConnector: true },
  backstory: { ...base, glyph: '\u25a8', pattern: 'hatched', laneGroup: 'backstory' },
  dream: { ...base, glyph: '\u263e', pattern: 'translucent', laneGroup: 'dream', overlapHighlight: false, tether: true },
  mythic: { ...base, glyph: '\u2736', pattern: 'translucent', laneGroup: 'dream', overlapHighlight: false, tether: true },
  parallel: { ...base, glyph: '\u2550', pattern: 'double-edge', laneGroup: 'parallel' },
  frame: { ...base, glyph: '[ ]', pattern: 'bracket', laneGroup: 'frame', bracket: true },
  simultaneous: { ...base, glyph: '\u2016', pattern: 'solid', laneGroup: 'main', overlapHighlight: false, stacked: true },
  circular: { ...base, glyph: '\u21bb', pattern: 'solid', laneGroup: 'main', linksToFirst: true },
  'time-skip': { ...base, glyph: '\u21e5', pattern: 'solid', laneGroup: 'main', precededByBreak: true },
};

/** The lane groups in the order the mode lanes run: Frame on top (§3.6), then Main. */
export const MODE_LANE_ORDER: readonly ModeLaneGroup[] = ['frame', 'main', 'parallel', 'dream', 'backstory'];

export function glyphOf(mode: TimelineMode, scheduled: boolean): ModeGlyph {
  const row = MODE_RENDER[mode];
  return { glyph: row.glyph, pattern: scheduled ? row.pattern : 'dashed' };
}

/** A mode name the table does not know reads as `linear`, as an unknown `timelineMode` does on load. */
export function knownMode(value: unknown): TimelineMode {
  return typeof value === 'string' && (TIMELINE_MODES as readonly string[]).includes(value) ? (value as TimelineMode) : 'linear';
}
