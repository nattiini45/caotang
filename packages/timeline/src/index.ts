/**
 * `@caotang/timeline` — the pure timeline model and layout (timeline.md §3). No DOM, no React and no message library:
 * the desktop view, the exporter and the MCP server share one `buildTimeline`, and every word it writes comes in
 * through `TimelineLabels` and the `CalendarLens`.
 */

export * from './model.js';
export { buildTimeline, defaultAxisFor } from './build.js';
export { GAP_COMPRESSION_DAYS, buildStoryAxis, pxPerDayOf, projectTimeline, segmentIndexOf, semanticLevelOf } from './axis.js';
export type { AxisScene, Box, ProjectionOptions, StoryAxisInput, StoryAxisParts, TimelineGeometry } from './axis.js';
export { MinHeap, packRows, type Interval } from './packing.js';
export { MODE_LANE_ORDER, MODE_RENDER, glyphOf, knownMode, type ModeLaneGroup, type ModeRender } from './mode-render.js';
export {
  COMIC_ADAPTER,
  COMIC_GLYPH,
  DIALOGUE_ADAPTER,
  DIALOGUE_GLYPH,
  MEDIUM_ADAPTERS,
  PROSE_ADAPTER,
  SCREENPLAY_ADAPTER,
  STORYBOARD_ADAPTER,
  STORYBOARD_GLYPH,
  adapterFor,
  attachmentsOf,
  createMediaContext,
  folderStripsOf,
  unitOf,
  type MediaContext,
  type MediumAdapter,
  type SceneAttachment,
  type StripDraft,
} from './media.js';
export { mediaEntriesOf, unattachedStrips, type MediaEntry } from './navigate.js';
export { MAX_TICKS, type CalendarLens, type Tick } from './calendar.js';
export {
  CALENDAR_LIMITS,
  CALENDAR_VERSION,
  contiguousYear,
  leapCycleYears,
  normalizeCalendarDefinition,
  shownYear,
  type CalendarDefinition,
  type CalendarEpoch,
  type CalendarEra,
  type CalendarIntercalary,
  type CalendarLeapRule,
  type CalendarMonth,
  type CalendarProblem,
  type CalendarProblemCode,
  type CalendarValidation,
  type LeapEffect,
  type YearZeroPolicy,
} from './calendar-definition.js';
export {
  createCalendarCycle,
  type CalendarCycle,
  type CalendarDate,
  type CalendarDateRequest,
  type YearSlot,
} from './calendar-cycle.js';
export {
  createCalendarLens,
  projectLensOf,
  validateCalendarDefinition,
  type ProjectLens,
  type ProjectLensSettings,
} from './calendar-lens.js';
export { createIntegerCodec, type IntegerCodec } from './integer-text.js';
export {
  ENGLISH_DAY_LENS_MESSAGES,
  MONTH_DAYS,
  WEEK_DAYS,
  YEAR_DAYS,
  createDayLens,
  dayLens,
  type DayLensMessages,
  type DayLensOptions,
} from './day-lens.js';
export { ENGLISH_LABELS, type ItemNameParts, type TimelineLabels } from './labels.js';
export { buildShelf, findCycles, type ShelfInput } from './shelf.js';
