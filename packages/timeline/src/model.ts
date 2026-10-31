/**
 * The timeline's data shapes — [timeline.md §3.1](../../../docs/architecture/timeline.md).
 *
 * Everything here is plain data in the canonical logical order (part, then day, then reading index). The project
 * language's direction is a field on the model and is applied only when a projection turns it into coordinates
 * (`projectTimeline`), so a tool reading the arrays never needs to know which way the book is read.
 */

import type { FindingSeverity, MentionCacheSource, MentionDetector, StoryPart, TimelineMode } from '@caotang/coherence';

import type { CalendarLens } from './calendar.js';
import type { TimelineLabels } from './labels.js';

export type { StoryPart, TimelineMode };

/** The part order of every canonical array and of the story axis. */
export const PART_ORDER: readonly StoryPart[] = ['prologue', 'main', 'epilogue'];

export const PART_RANK: Readonly<Record<StoryPart, number>> = { prologue: 0, main: 1, epilogue: 2 };

export type TimelineAxis = 'story' | 'narrative' | 'braid';

/** §3.5's seven lane sources; `none` is the packed single lane. */
export const LANE_KEYS = ['none', 'pov', 'character', 'mode', 'folder', 'location', 'thread'] as const;
export type LaneKey = (typeof LANE_KEYS)[number];

export type StoryZoom = 'day' | 'week' | 'month' | 'fit';
export type NarrativeZoom = 'scene' | 'chapter' | 'act';
export type Zoom = StoryZoom | NarrativeZoom;

/** What a zoom shows as blocks: scenes as they are, one block per chapter folder, or one per act folder. */
export type SemanticLevel = 'scene' | 'chapter' | 'act';

export type Medium = 'prose' | 'screenplay' | 'dialogue' | 'storyboard' | 'comic';
export type ItemKind = 'scene' | 'folder-band' | 'picture' | 'shot-strip' | 'page-strip';

/** What an item's `measure` counts. Only `words` and `pages` size a scene; the others measure a medium's own nodes. */
export type MeasureUnit = 'words' | 'pages' | 'lines' | 'shots' | 'panels';

/**
 * How many words one unit stands for when a scope mixes units and the narrative slots need one scale (§9.3). A page is the
 * manuscript convention of about 250 words. The two units that never size a scene are here so the table is total; a slot is
 * only ever a proportion, so the figures are an estimate and nothing is stored or shown as words.
 */
export const WORDS_PER_UNIT: Readonly<Record<MeasureUnit, number>> = { words: 1, pages: 250, lines: 12, shots: 30, panels: 40 };

/** Above this many characters in scope the subway overlay starts off (§3.9). */
export const PRESENCE_DEFAULT_LIMIT = 30;

/** The order `stats.mediums` lists the media in. */
export const MEDIUM_ORDER: readonly Medium[] = ['prose', 'screenplay', 'dialogue', 'storyboard', 'comic'];

/** What a dialogue container's Ink says about its shape, read from the parse and never stored. */
export interface BranchFacts {
  /** Knots and stitches. */
  beats: number;
  choices: number;
  /** Distinct diverts from one beat to another. */
  links: number;
}

/**
 * A scene's declared tie to a node of another medium. `nodeId` is what the shell opens in that medium's own view.
 * When the declaration names a node that is gone, `nodeId` is absent and `broken` is set: the item stays, with no target,
 * and `ref` keeps the id the declaration names so the view can say what is missing. Nothing is re-matched by title.
 */
export interface MediaLink {
  medium: 'dialogue' | 'comic';
  nodeId?: string;
  ref?: string;
  broken?: true;
  title?: string;
  branches?: BranchFacts;
}

/** One card of a strip: a shot or a comic page, numbered by its place among its siblings (storyboard.md §2.2). */
export interface StripCell {
  /** The node the shell opens: the shot card, or the comic page. */
  nodeId: string;
  /** 1-based and derived from sibling order, never stored. */
  number: number;
  title: string;
  /** A picture-registry id: the shot's image, or the first panel's picture on a page. */
  assetId?: string;
  /** Shots: seconds, when the shot has a duration. */
  durationSec?: number;
  /** Pages: panels on the page. */
  panels?: number;
}

export interface TimelineOptions {
  axis: TimelineAxis;
  /** Default `none`. */
  groupBy?: LaneKey;
  /** Default `day` on the story and braid axes, `scene` on the narrative axis. */
  zoom?: Zoom;
  /** Default {@link dayLens}. */
  lens?: CalendarLens;
  /** A folder or document id: only the scenes under it. Absent is the whole manuscript. */
  scope?: string;
  /**
   * Character and location lanes also take entries a scene names without declaring them, drawn hollow (`inferred`).
   * Needs `detector` or `mentions`; without either nothing is detected and nothing is guessed.
   */
  includeDetectedMentions?: boolean;
  detector?: MentionDetector;
  mentions?: MentionCacheSource;
  /** Default `open`: open findings only, never dismissed ones. */
  findings?: 'open' | 'none';
  /** Default true: runs of empty days of {@link GAP_COMPRESSION_DAYS} or more collapse into a break. */
  compressGaps?: boolean;
  /** The words the model needs, in the label locale. Default English. */
  labels?: TimelineLabels;
}

export interface FindingRef {
  id: string;
  checkId: string;
  severity: FindingSeverity;
  type: string;
  groupKey: string;
}

export type PatternName = 'solid' | 'hatched' | 'translucent' | 'double-edge' | 'bracket' | 'dashed';

/** What a chip shows besides colour: a glyph and a pattern, always both (§3.6). */
export interface ModeGlyph {
  glyph: string;
  pattern: PatternName;
}

export type FrameBracket = 'open' | 'close' | 'both';

export interface TimelineItem {
  /** `${nodeId}@${laneId}`: stable across rebuilds, and distinct for one scene shown in several lanes. */
  key: string;
  nodeId: string;
  kind: ItemKind;
  medium: Medium;
  /** The effective part, computed from the tree and never stored. */
  part: StoryPart;
  lane: string;
  /** Stacking row inside the lane and part zone. Always 0 on the narrative axis. */
  row: number;
  /** Story days (`windowOf`), possibly negative; absent when the scene has no `dayOffset`. */
  start?: number;
  end?: number;
  /** Declared values, as written. */
  dayOffset?: number;
  durationDays?: number;
  /** Dense 0-based slot of the scene among the scenes shown. */
  readingIndex: number;
  /** Words for prose, estimated pages for a screenplay, pages for a comic script that has its book. A strip counts its cells. */
  measure: number;
  measureUnit?: MeasureUnit;
  mode: TimelineMode;
  glyph: ModeGlyph;
  findings: FindingRef[];
  partNote?: 'dated-inside-main';
  /** An explicit `main` sits under an inherited prologue or epilogue. */
  partOverride?: boolean;
  /** The lane membership was detected, not declared: draw hollow and dotted. */
  inferred?: boolean;
  /** The scene sits in an `after` cycle. */
  inCycle?: boolean;
  /** Index of the axis segment holding the item (story and braid axes, scheduled items only). */
  segment?: number;
  bracket?: FrameBracket;
  /** A dream or mythic scene draws a dotted tether to this day. */
  tetherDay?: number;
  /** Items stacked in one column share it: simultaneous scenes of one lane on one day. */
  group?: string;
  label: string;
  a11yLabel: string;
  title: string;
  folderId: string | null;
  pov?: string;
  /**
   * The glyph of the medium the scene shares with another node: a branch for a scene with a dialogue container, a page
   * for a comic script. Drawn beside the mode glyph and named in text, never the only signal.
   */
  mediumGlyph?: string;
  /** Declared ties to nodes of other media, kept (as broken) when the target is gone. */
  links?: MediaLink[];
  /** Strips only: the node the strip hangs under (a scene, or a comic book with no script), whose day and part it inherits. */
  hostId?: string;
  /** Strips only: the folder whose children are the cells. */
  sourceId?: string;
  /** Strips only: the cards, in sibling order. */
  cells?: StripCell[];
  /** Shot strips only: the seconds of the shots that have a duration; a shot with none is left out (storyboard.md §2.2). */
  runtimeSec?: number;
  /** Shot strips only: shots left out of {@link runtimeSec} because they have no duration. */
  unmeasured?: number;
  /** Page strips only: the book's own reading direction, which is never the project's or the interface's (§3.2). */
  direction?: 'ltr' | 'rtl';
  /** Strips only: the node the shell opens, in the medium's own view: the shots folder (its board) or the first page. */
  open?: string;
}

export interface Lane {
  id: string;
  key: LaneKey;
  label: string;
  /** The value that makes the lane: a codex entry id, a thread handle, a folder id, a mode group, a POV name. */
  value?: string;
  /** Rows needed: the most rows any part zone stacks in this lane (at least 1). */
  rows: number;
  /** Scenes in the lane. */
  count: number;
}

/** `startDay` is the first occupied day and `endDay` the exclusive end of the last window. Both absent for a zone of undated scenes. */
export interface PartZone {
  part: StoryPart;
  startDay?: number;
  endDay?: number;
  firstReading?: number;
  lastReading?: number;
  /** Scenes in the part, scheduled or not, each counted once however many lanes show it. */
  count: number;
}

export interface AxisSegment {
  part: StoryPart;
  /** First occupied day. */
  from: number;
  /** Exclusive end. */
  to: number;
  /** Days laid out before this segment, summed over the segments ahead of it. */
  daysBefore: number;
  /** Gap breaks and folds ahead of it, for the fixed-width separators. */
  breaksBefore: number;
  foldsBefore: number;
}

export interface AxisBreak {
  part: StoryPart;
  /** Index of the segment that follows the break. */
  segment: number;
  fromDay: number;
  toDay: number;
  days: number;
  kind: 'gap' | 'time-skip';
  label: string;
  /** An open `timeline.gap` finding on the scene after the break. */
  findingId?: string;
}

export interface AxisFold {
  fromPart: StoryPart;
  toPart: StoryPart;
  /** The part the fold is named for: the one that is not the main story. */
  part: StoryPart;
  segment: number;
  /** Days between the two zones' nearest edges when positive; absent when the zones overlap in days. */
  spanDays?: number;
  label: string;
  a11yLabel: string;
}

export interface AxisTick {
  day: number;
  level: 0 | 1 | 2 | 3;
  label: string;
  segment: number;
  part: StoryPart;
}

export interface AxisModel {
  kind: TimelineAxis;
  /** Story days: one run per occupied stretch of a part, in part order. Empty on the narrative axis. */
  segments: AxisSegment[];
  breaks: AxisBreak[];
  folds: AxisFold[];
  ticks: AxisTick[];
  /**
   * Reading slots, one per scene shown: the measure of the scene in each. When every scene counts the same unit these are
   * that unit; when the scope mixes units (prose in words, a screenplay in pages) they are all in words-equivalent
   * (`WORDS_PER_UNIT`), so a script page does not draw as a sliver beside a chapter.
   */
  measures: number[];
  /** The unit of {@link measures}: one scene unit, `words-equivalent` for a mixed scope, absent when no scene is shown. */
  measureUnit?: MeasureUnit | 'words-equivalent';
  pxPerDay: number;
}

export type ConnectorKind = 'after' | 'thread' | 'braid' | 'presence' | 'finding';

export interface Connector {
  id: string;
  kind: ConnectorKind;
  /** Item key, or `slot:<nodeId>` for a braid connector's narrative end. */
  from: string;
  to: string;
  fromNode: string;
  toNode: string;
  /** `presence`: the item keys the polyline passes, in story order (narrative order on the narrative axis). */
  path?: string[];
  characterId?: string;
  threadId?: string;
  checkId?: string;
  severity?: FindingSeverity;
  findingId?: string;
  /** An `after` link the days contradict. */
  violation?: boolean;
  /** An `after` link inside a cycle. */
  cycle?: boolean;
  emphasised?: boolean;
  /** `slot` runs from a reading slot to its day; `return` links a circular scene back to the first scene. */
  variant?: 'slot' | 'return';
}

export interface ChainStep {
  item: TimelineItem;
  /** The scene is on an `after` cycle. */
  inCycle: boolean;
  /** An `after` target that is dated: the day the scene must come after, with its label. */
  anchor?: { nodeId: string; day: number; hint: string };
}

export interface Chain {
  id: string;
  part: StoryPart;
  steps: ChainStep[];
  /** True when the chain contains a cycle, so it is drawn broken with an error glyph. */
  cycle: boolean;
}

export interface FolderBand {
  nodeId: string;
  title: string;
  parentId: string | null;
  depth: number;
  part: StoryPart;
  firstReading: number;
  lastReading: number;
  count: number;
  /** The folder's own declared span (its `dayOffset` and `durationDays`), when it declares one. */
  start?: number;
  end?: number;
}

/** A run of consecutive reading slots in one declared part, drawn as a band on the narrative axis. */
export interface PartRun {
  part: StoryPart;
  firstReading: number;
  lastReading: number;
  count: number;
}

export interface AggregateBlock {
  id: string;
  nodeId: string;
  label: string;
  part: StoryPart;
  level: 'chapter' | 'act';
  count: number;
  firstReading: number;
  lastReading: number;
  start?: number;
  end?: number;
  openFindings: number;
}

export interface AppearanceSpan {
  characterId: string;
  name: string;
  scenes: number;
  first: { part: StoryPart; day: number; nodeId: string };
  last: { part: StoryPart; day: number; nodeId: string };
}

export interface TimelineModel {
  axis: AxisModel;
  /** Logical order: part, scheduled before undated, day, reading index, lane. Never mirrored. */
  items: TimelineItem[];
  /**
   * Shot strips and page strips, in the same canonical order. They are not in `items`: every consumer of `items` (the grid,
   * the Agenda, the CSV, the shelf) stays one row per scene, and a strip inherits its host's day and part instead of
   * having its own.
   */
  strips: TimelineItem[];
  lanes: Lane[];
  /** Always in the order prologue, main, epilogue; parts with no scene are omitted. */
  zones: PartZone[];
  connectors: Connector[];
  unscheduled: { sequenced: Chain[]; loose: TimelineItem[] };
  bands: FolderBand[];
  partRuns: PartRun[];
  blocks: AggregateBlock[];
  appearances: AppearanceSpan[];
  /** Simultaneous scenes stacked in one column. */
  simultaneous: { id: string; part: StoryPart; day: number; keys: string[] }[];
  /** The project language's direction, for the projection to apply. */
  direction: 'ltr' | 'rtl';
  options: { axis: TimelineAxis; groupBy: LaneKey; zoom: Zoom; level: SemanticLevel; scope?: string; compressGaps: boolean };
  stats: {
    scenes: number;
    scheduled: number;
    share: number;
    characters: number;
    /** False above {@link PRESENCE_DEFAULT_LIMIT} characters in scope: the subway overlay then starts off. */
    presenceDefaultOn: boolean;
    /** The media in scope, scenes and strips, in a fixed order. More than one is a mixed scope. */
    mediums: Medium[];
  };
}
