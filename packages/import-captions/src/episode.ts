/**
 * Cues to one AV script episode (av-script.md §3 and §4, issue #287): a `#` title, `##` segments, and one `SPEAKER: words [Ns]`
 * speech line per cue or merged run, with the duration **declared** from the cue's own timings so no speech-rate estimate is involved.
 *
 * The script stores durations, not offsets (§4, SD4), so the wall clock a caption file carries has to go somewhere. Three rules,
 * each the writer's choice and each reported:
 *
 * - A gap of at least `gapSegmentSec` starts a **new segment**. The gap is then outside the episode's runtime, and the report says
 *   how much time that is.
 * - A smaller gap is **folded into the line before it** (the default), which keeps the episode's total equal to the file's wall
 *   clock, or **left out**, which keeps every line's spoken length exact and shortens the total. The report names the seconds either way.
 * - Consecutive cues of one speaker inside a segment are **merged** into one line by default, because a caption file breaks a sentence
 *   every 42 characters. The report counts the merges.
 *
 * A WebVTT `NOTE` becomes a quoted text line (`> …`), which the grammar reads as text and never as a speaker, whatever words it holds.
 */

import { SCRIPT_LABEL_PATTERN } from '@caotang/bus';
import { DEFAULT_CUE_VOCABULARY, NARRATION_LABEL } from '@caotang/script';

import type { CaptionCue, CaptionsLoss, CaptionsRead } from './cues.js';

/** What the episode builder changed that the caption file did not say. */
export type EpisodeLossKind = 'speaker-renamed' | 'speaker-cue-word' | 'untimed-line' | 'text-bracket';

export interface EpisodeLoss {
  readonly kind: EpisodeLossKind;
  readonly count: number;
  readonly sample?: string;
}

export type ImportCaptionsLoss = CaptionsLoss | EpisodeLoss;

export interface EpisodeOptions {
  /** Merge consecutive cues of one speaker inside a segment. Default true. */
  readonly mergeSameSpeaker?: boolean;
  /** A gap of at least this many seconds starts a new segment. 0 keeps one segment. Default 3. */
  readonly gapSegmentSec?: number;
  /** What a gap smaller than that becomes. Default `fold`. */
  readonly silence?: 'fold' | 'leave';
  /** The episode's title. The file's own title, else the file name, is the caller's to pass. */
  readonly title?: string;
}

/** One speech line as the episode holds it, with the cues it came from so the report can be exact. */
export interface EpisodeLine {
  readonly speaker: string;
  readonly text: string;
  /** The declared duration in seconds, including any folded silence. 0 when the cue's own span was zero or backwards. */
  readonly seconds: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly cues: number;
  readonly notes: readonly string[];
}

export interface EpisodeSegment {
  readonly title: string;
  readonly startSec: number;
  readonly lines: readonly EpisodeLine[];
  readonly notes: readonly string[];
}

export interface BuiltEpisode {
  readonly title: string;
  readonly body: string;
  readonly segments: readonly EpisodeSegment[];
  readonly lines: number;
  readonly cues: number;
  /** The spoken words, counted the way the script counts them: the label, the brackets and the notes are not words. */
  readonly words: number;
  readonly merged: number;
  readonly foldedSec: number;
  readonly leftOutSec: number;
  readonly gapSec: number;
  readonly leadingSec: number;
  readonly seconds: number;
  readonly losses: readonly ImportCaptionsLoss[];
}

const rounded = (sec: number): number => Math.round(sec * 1000) / 1000;

/** A duration bracket's seconds: `[12s]`, `[12.5s]`, never more than milliseconds, which is all a caption file carries. */
export function durationBracket(sec: number): string {
  const value = rounded(sec);
  const text = Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  return `[${text}s]`;
}

/** A wall-clock position as a segment heading shows it: `0:07`, `1:02:03`. */
export function clock(sec: number): string {
  const whole = Math.floor(rounded(sec));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

const ALLOWED = /[^\p{L}\p{N} _.'-]/gu;

/**
 * The label the grammar reads as a speaker (§3): it must start with a letter and hold only letters, digits, spaces, `_`, `-`, `.` and
 * `'`, at most 40 characters, and it must not be one of the show's cue words, which would make the line a cue instead of speech.
 * A name that cannot be held is changed as little as possible and the change is reported with both spellings.
 */
export function speakerLabel(raw: string | undefined, vocabulary: readonly string[] = DEFAULT_CUE_VOCABULARY): { readonly label: string; readonly loss?: EpisodeLoss } {
  const name = (raw ?? '').trim();
  if (name === '') return { label: NARRATION_LABEL };
  let label = name.replace(ALLOWED, ' ').replace(/\s{2,}/g, ' ').trim().replace(/^[^\p{L}]+/u, '').slice(0, 40).trim();
  const unusable = label === '' || !SCRIPT_LABEL_PATTERN.test(label);
  if (unusable) label = NARRATION_LABEL;
  // The script's parser reads the narration label case-insensitively as the show's own narration, so a caption speaker actually
  // named `Narration` would lose its name and become the default speaker. It is a reserved label, like a cue word. A name that
  // could not be held at all is narration by intent, so the fallback keeps the label as it is.
  if (!unusable && label.toLowerCase() === NARRATION_LABEL.toLowerCase()) {
    return { label: `${label}_`, loss: { kind: 'speaker-renamed', count: 1, sample: `${name} → ${label}_` } };
  }
  if (vocabulary.some((word) => word.toLowerCase() === label.toLowerCase())) {
    return { label: `${label}_`, loss: { kind: 'speaker-cue-word', count: 1, sample: `${name} → ${label}_` } };
  }
  if (label !== name) return { label, loss: { kind: 'speaker-renamed', count: 1, sample: `${name} → ${label}` } };
  return { label };
}

/** A bracket at the end of a cue's words that the grammar would try to read as a timing (§3), so the writer knows why it is words. */
const TRAILING_TIMING = /\[(?:at[ \t]+)?\d[\d:.,]*\p{L}{0,2}\]$/u;

function wordsIn(text: string): number {
  // The script counts the words only: a parenthetical is a modifier, not speech (§3, §4).
  return text.replace(/\([^()]*\)/g, ' ').split(/\s+/).filter((word) => word !== '').length;
}

/** Adds one loss of a kind, keeping the first sample. */
function addLoss(held: Map<string, { count: number; sample?: string }>, kind: string, sample?: string): void {
  const at = held.get(kind);
  if (at === undefined) held.set(kind, sample === undefined ? { count: 1 } : { count: 1, sample });
  else {
    at.count += 1;
    if (at.sample === undefined && sample !== undefined) at.sample = sample;
  }
}

/** Builds the episode body from the cues, with the writer's three choices applied and everything they cost counted. */
export function buildEpisode(read: CaptionsRead, options: EpisodeOptions = {}): BuiltEpisode {
  const merge = options.mergeSameSpeaker ?? true;
  const gapAt = Math.max(0, options.gapSegmentSec ?? 3);
  const silence = options.silence ?? 'fold';
  const named = (options.title ?? read.title ?? '').trim();
  const title = named === '' ? 'Captions' : named;

  const held = new Map<string, { count: number; sample?: string }>();
  const notesBefore = new Map<number, string[]>();
  for (const note of read.notes) {
    const at = notesBefore.get(note.beforeCue) ?? [];
    at.push(note.text);
    notesBefore.set(note.beforeCue, at);
  }

  interface Draft { speaker: string; text: string; startSec: number; endSec: number; cues: number; notes: string[] }
  const segments: { startSec: number; lines: Draft[]; notes: string[] }[] = [];
  let current: { startSec: number; lines: Draft[]; notes: string[] } | null = null;
  let merged = 0;
  let foldedSec = 0;
  let leftOutSec = 0;
  let gapSec = 0;
  let previousEnd: number | null = null;
  const leadingSec = rounded(Math.max(0, (read.cues[0] as CaptionCue | undefined)?.startSec ?? 0));

  read.cues.forEach((cue, index) => {
    const notes = notesBefore.get(index) ?? [];
    const { label, loss } = speakerLabel(cue.speaker);
    if (loss !== undefined) addLoss(held, loss.kind, loss.sample);
    if (TRAILING_TIMING.test(cue.text)) addLoss(held, 'text-bracket', cue.text.slice(-24));
    const span = rounded(cue.endSec - cue.startSec);
    if (span <= 0) addLoss(held, 'untimed-line', `${clock(cue.startSec)} ${cue.text.slice(0, 40)}`);

    const gap = previousEnd === null ? 0 : rounded(cue.startSec - previousEnd);
    const breaks = current !== null && gapAt > 0 && gap >= gapAt;
    if (current === null || breaks) {
      if (breaks) gapSec += gap;
      current = { startSec: cue.startSec, lines: [], notes: [] };
      segments.push(current);
    }
    const last = current.lines[current.lines.length - 1];
    // A note sits at a cue boundary, so merging across one would move it ahead of the words it followed. The note ends the line.
    if (merge && last !== undefined && last.speaker === label && !breaks && notes.length === 0) {
      // One speaker continuing: the words join, the span runs to the later cue, and the small gap inside is part of the line.
      const inner = rounded(cue.startSec - last.endSec);
      if (inner > 0) foldedSec += inner;
      last.text = `${last.text} ${cue.text}`.trim();
      last.endSec = Math.max(last.endSec, cue.endSec);
      last.cues += 1;
      last.notes.push(...notes);
      merged += 1;
    } else {
      if (last !== undefined && gap > 0) {
        // Silence folds onto the line before only when that line has a span of its own: a zero-span cue takes no duration, so
        // the gap after it is left out rather than becoming that cue's length.
        const lastOwn = rounded(Math.max(0, last.endSec - last.startSec));
        if (silence === 'fold' && lastOwn > 0) foldedSec += gap;
        else leftOutSec += gap;
      }
      current.lines.push({ speaker: label, text: cue.text, startSec: cue.startSec, endSec: cue.endSec, cues: 1, notes: [...notes] });
    }
    previousEnd = Math.max(previousEnd ?? 0, cue.endSec);
  });

  const trailing = notesBefore.get(read.cues.length) ?? [];
  const lastSegment = segments[segments.length - 1];
  if (trailing.length > 0 && lastSegment !== undefined) lastSegment.notes.push(...trailing);

  const out: EpisodeSegment[] = [];
  const body: string[] = [`# ${title}`, ''];
  let words = 0;
  let lineCount = 0;
  let seconds = 0;

  segments.forEach((segment, index) => {
    const heading = `Segment ${index + 1} (${clock(segment.startSec)})`;
    body.push(`## ${heading}`, '');
    const lines: EpisodeLine[] = [];
    segment.lines.forEach((draft, at) => {
      const next = segment.lines[at + 1];
      const own = rounded(Math.max(0, draft.endSec - draft.startSec));
      const after = next === undefined ? 0 : rounded(Math.max(0, next.startSec - draft.endSec));
      // A cue with no span of its own takes no duration bracket, silence or no silence.
      const declared = rounded(own + (silence === 'fold' && own > 0 ? after : 0));
      for (const note of draft.notes) {
        for (const line of note.split('\n')) body.push(`> ${line}`);
        body.push('');
      }
      body.push(`${draft.speaker}: ${draft.text}${declared > 0 ? ` ${durationBracket(declared)}` : ''}`);
      words += wordsIn(draft.text);
      seconds += declared;
      lineCount += 1;
      lines.push({ speaker: draft.speaker, text: draft.text, seconds: declared, startSec: draft.startSec, endSec: draft.endSec, cues: draft.cues, notes: draft.notes });
    });
    // A note after the last cue belongs after the segment's speech, where the file put it.
    for (const note of segment.notes) {
      for (const line of note.split('\n')) body.push(`> ${line}`);
      body.push('');
    }
    body.push('');
    out.push({ title: heading, startSec: segment.startSec, lines, notes: segment.notes });
  });

  const own: ImportCaptionsLoss[] = [...held.entries()].map(([kind, value]) => ({ kind: kind as EpisodeLossKind, count: value.count, ...(value.sample === undefined ? {} : { sample: value.sample }) }));
  return {
    title,
    body: `${body.join('\n').trimEnd()}\n`,
    segments: out,
    lines: lineCount,
    cues: read.cues.length,
    words,
    merged,
    foldedSec: rounded(foldedSec),
    leftOutSec: rounded(leftOutSec),
    gapSec: rounded(gapSec),
    leadingSec,
    seconds: rounded(seconds),
    losses: [...read.losses, ...own],
  };
}
