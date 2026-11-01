/**
 * Every word the model writes, supplied by the caller so the interface and an export can each use their own language.
 * The model itself never formats a sentence of its own: it calls these.
 */

import type { StoryPart, TimelineMode } from './model.js';

export interface ItemNameParts {
  title: string;
  part: StoryPart;
  /** An explicit `main` overriding an inherited prologue or epilogue: named "main story", never after the folder. */
  partOverride: boolean;
  /** The lens's long label of the first day, absent for an undated scene. */
  dayLabel?: string;
  /** The lens's long label of the last day when the scene declares a duration. */
  endLabel?: string;
  durationDays?: number;
  mode: TimelineMode;
  povName?: string;
  folderTitle?: string;
  /** Titles of the scenes an open overlap finding pairs this one with. */
  overlaps: string[];
  openFindings: number;
  partNote: boolean;
}

export interface TimelineLabels {
  partName(part: StoryPart): string;
  modeName(mode: TimelineMode): string;
  /** The tag a mode carries beside its glyph; absent for modes that carry none. */
  modeTag?(mode: TimelineMode): string | undefined;
  lane: {
    all: string;
    noPov: string;
    noCharacter: string;
    noLocation: string;
    noThread: string;
    /** `main`, `parallel`, `frame`, `dream` or `backstory`: the mode lane groups of §3.5. */
    modeGroup(group: string): string;
  };
  gapBreak(days: number): string;
  timeSkipBreak: string;
  /** `span` is the lens's span between the zones, absent when they overlap in days. `anchor` is the lens's label of the day it is measured from. */
  foldLabel(part: StoryPart, span: string | undefined, anchor: string | undefined): string;
  foldAnnounce(part: StoryPart, label: string): string;
  afterHint(dayLabel: string): string;
  itemName(parts: ItemNameParts): string;
}

const MODE_NAMES: Record<TimelineMode, string> = {
  linear: 'linear',
  flashback: 'flashback',
  'flash-forward': 'flash-forward',
  parallel: 'parallel strand',
  frame: 'frame',
  dream: 'dream',
  mythic: 'mythic',
  backstory: 'backstory',
  simultaneous: 'simultaneous',
  circular: 'circular',
  'time-skip': 'time skip',
};

const PART_NAMES: Record<StoryPart, string> = { prologue: 'Prologue', main: 'Main story', epilogue: 'Epilogue' };

const MODE_GROUPS: Record<string, string> = {
  main: 'Main',
  parallel: 'Parallel strand',
  frame: 'Frame',
  dream: 'Dream & mythic',
  backstory: 'Backstory',
};

const MODE_TAGS: Partial<Record<TimelineMode, string>> = { backstory: 'Backstory' };

export const ENGLISH_LABELS: TimelineLabels = {
  partName: (part) => PART_NAMES[part],
  modeName: (mode) => MODE_NAMES[mode],
  modeTag: (mode) => MODE_TAGS[mode],
  lane: {
    all: 'All scenes',
    noPov: 'No POV',
    noCharacter: 'No character',
    noLocation: 'Unplaced',
    noThread: 'No thread',
    modeGroup: (group) => MODE_GROUPS[group] ?? group,
  },
  gapBreak: (days) => `+${days.toLocaleString('en-US')} ${days === 1 ? 'day' : 'days'}`,
  timeSkipBreak: 'Time skip (declared)',
  foldLabel: (part, span, anchor) => {
    const name = PART_NAMES[part];
    if (span === undefined) return name;
    return part === 'prologue' ? `${name} \u00b7 ${span} before ${anchor ?? 'the main story'}` : `${name} \u00b7 ${span} later`;
  },
  foldAnnounce: (part, label) => {
    const rest = label.includes(' \u00b7 ') ? label.slice(label.indexOf(' \u00b7 ') + 3) : label;
    return `Fold: ${PART_NAMES[part].toLowerCase()}, ${rest}`;
  },
  afterHint: (dayLabel) => `after ${dayLabel}`,
  itemName: (p) => {
    const pieces: string[] = [];
    const title = `\u2018${p.title}\u2019`;
    if (p.part !== 'main') pieces.push(`${PART_NAMES[p.part]}: ${title}`);
    else if (p.partOverride) pieces.push(`${PART_NAMES.main}: ${title}`);
    else pieces.push(title);
    if (p.dayLabel === undefined) pieces.push('undated');
    else {
      pieces.push(p.endLabel !== undefined ? `${p.dayLabel} to ${p.endLabel}` : p.dayLabel);
      if (p.durationDays !== undefined && p.durationDays > 0) pieces.push(`${p.durationDays} ${p.durationDays === 1 ? 'day' : 'days'}`);
    }
    pieces.push(MODE_NAMES[p.mode]);
    if (p.povName !== undefined) pieces.push(`POV ${p.povName}`);
    if (p.folderTitle !== undefined) pieces.push(p.folderTitle);
    if (p.partNote) pieces.push('dated inside the main story');
    if (p.overlaps.length > 0) pieces.push(`overlaps ${p.overlaps.map((t) => `\u2018${t}\u2019`).join(', ')}`);
    if (p.openFindings > 0) pieces.push(`${p.openFindings} open ${p.openFindings === 1 ? 'finding' : 'findings'}`);
    return pieces.join(', ');
  },
};
