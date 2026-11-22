/**
 * SRT and WebVTT captions as cues (av-script.md §3 E6, issue #287). Text in, cues out: the timings, the words, the speaker each
 * cue names, the NOTE blocks between them, and a count of everything the format carries that an AV script does not.
 *
 * Pure and DOM-free, so the same reader runs on the main thread, in the preview's `'self'` Worker and in Node. It takes the decoded
 * text, not bytes: the preview decodes with `@caotang/import-read/text`, which owns the encodings and their caps.
 *
 * WebVTT is a W3C Candidate Recommendation (`WEBVTT`, `hh:mm:ss.ttt` with a period, ` --> `, the `<v Speaker>` voice span). SRT has
 * no official specification: `HH:MM:SS,mmm` with a comma, a mandatory index in most writers' files and no standard speaker markup,
 * so a speaker is read from a `Name:` or `- Name:` prefix and named as the practice it is. Both are read tolerantly: a period in an
 * SRT file, a missing index, a missing `WEBVTT` header and cue settings are read, not refused, and what is dropped is counted.
 *
 * Nothing here decides what the episode looks like; `episode.ts` builds that from these cues.
 */

import { SCRIPT_LABEL_PATTERN } from '@caotang/bus';

/** Which timed-text format the file is. */
export type CaptionsFormat = 'srt' | 'vtt';

/** One cue: its wall-clock span, its words with the inline markup removed, and the speaker it names when it names one. */
export interface CaptionCue {
  readonly startSec: number;
  readonly endSec: number;
  readonly text: string;
  /** From a `<v Speaker>` span, else a `Name:` or `- Name:` prefix. Absent when the cue names nobody. */
  readonly speaker?: string;
  /** The cue's own identifier line, when it had one (WebVTT) or an index (SRT). Kept for the report, never written. */
  readonly id?: string;
}

/** A WebVTT `NOTE` block, and the cue it stands before (`cues.length` when it follows the last cue). */
export interface CaptionNote {
  readonly beforeCue: number;
  readonly text: string;
}

/**
 * What the format carries that an AV script does not, as a code and a count so the app names it in the writer's language.
 * `sample` is the first thing of its kind, shown verbatim so the writer can find it in their own file.
 */
export type CaptionsLossKind =
  | 'styling'
  | 'cue-settings'
  | 'inline-timestamp'
  | 'style-block'
  | 'region-block'
  | 'cue-id'
  | 'coordinates'
  | 'empty-cue'
  | 'bad-timing'
  | 'out-of-order'
  | 'overlap'
  | 'short-cue'
  | 'two-speakers'
  | 'stray-text'
  | 'srt-period';

export interface CaptionsLoss {
  readonly kind: CaptionsLossKind;
  readonly count: number;
  readonly sample?: string;
}

export interface CaptionsRead {
  readonly format: CaptionsFormat;
  readonly cues: readonly CaptionCue[];
  readonly notes: readonly CaptionNote[];
  readonly losses: readonly CaptionsLoss[];
  /** The title the file names itself: WebVTT's header text after `WEBVTT`. Absent when it names none. */
  readonly title?: string;
}

export type CaptionsResult =
  | { readonly ok: true; readonly value: CaptionsRead }
  | { readonly ok: false; readonly error: { readonly code: 'no-cues' | 'too-many-cues'; readonly message: string } };

/**
 * The cues one import reads. A cue every two seconds for three hours is 5,400, so this is far past any real transcript and still
 * bounded: the episode body is built from every cue, and an unbounded file would build an unbounded string.
 */
export const MAX_CUES = 20_000;

/** A timestamp: `hh:mm:ss.ttt`, `mm:ss.ttt`, and the same with SRT's comma. Hours are optional; frames are never read (SD4). */
function stamp(raw: string): number | null {
  const parts = raw.trim().split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const secondsField = (parts[parts.length - 1] ?? '').replace(',', '.');
  if (!/^\d{1,2}(?:\.\d{1,3})?$/.test(secondsField)) return null;
  const seconds = Number(secondsField);
  const minutes = Number(parts[parts.length - 2]);
  const hours = parts.length === 3 ? Number(parts[0]) : 0;
  if (!Number.isFinite(seconds) || !Number.isFinite(minutes) || !Number.isFinite(hours)) return null;
  if (!/^\d{1,2}$/.test(parts[parts.length - 2] ?? '') || (parts.length === 3 && !/^\d{1,3}$/.test(parts[0] ?? ''))) return null;
  if (seconds >= 60 || minutes >= 60) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

const ARROW = '-->';

/** The inline markup WebVTT allows inside a cue's words: a voice, a class span, bold/italic/underline, a language, ruby, a timestamp. */
const TAG = /<\/?(?:v|c|b|i|u|lang|ruby|rt)(?:[.\s][^>]*)?>|<\/?v>|<\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}>/g;
const VOICE = /<v(?:\.[^\s>]*)?[ \t]+([^>]*)>/g;
const IS_TIMESTAMP_TAG = /^<\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}>$/;
const IS_VOICE_TAG = /^<v[.\s>]/;

const ENTITIES: Readonly<Record<string, string>> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&lrm;': '\u200e', '&rlm;': '\u200f', '&nbsp;': ' ' };

function unescape(text: string): string {
  return text.replace(/&(?:amp|lt|gt|lrm|rlm|nbsp);/g, (whole) => ENTITIES[whole] ?? whole);
}

/** A label the AV script grammar reads as a speaker: the bus's own pattern (av-script.md §3), never a copy of it. */
const NAME_LABEL = SCRIPT_LABEL_PATTERN;

/** The speaker a `Name:` or `- Name:` prefix names, as Descript's "show speakers" and most SRT tools write it. */
function prefixedSpeaker(line: string): { readonly speaker: string; readonly rest: string } | null {
  const match = /^[ \t]*(?:-[ \t]*)?([^:]{1,40}):(?:[ \t]+|$)(.*)$/.exec(line);
  if (match === null) return null;
  const label = (match[1] ?? '').trim();
  if (!NAME_LABEL.test(label)) return null;
  return { speaker: label, rest: match[2] ?? '' };
}

/** Counts one loss of a kind, keeping the first sample so the report can name it. */
class Losses {
  private readonly held = new Map<CaptionsLossKind, { count: number; sample?: string }>();

  add(kind: CaptionsLossKind, sample?: string): void {
    const held = this.held.get(kind);
    if (held === undefined) this.held.set(kind, sample === undefined ? { count: 1 } : { count: 1, sample });
    else {
      held.count += 1;
      if (held.sample === undefined && sample !== undefined) held.sample = sample;
    }
  }

  list(): CaptionsLoss[] {
    return [...this.held.entries()].map(([kind, held]) => ({ kind, count: held.count, ...(held.sample === undefined ? {} : { sample: held.sample }) }));
  }
}

const isBlank = (line: string): boolean => line.trim() === '';

/** Reads a cue's words: the voice spans' names, the words without any inline markup, and what was dropped. */
function wordsOf(raw: readonly string[], losses: Losses): { readonly text: string; readonly speaker?: string } {
  const joined = raw.join('\n');
  const voices: string[] = [];
  for (const match of joined.matchAll(VOICE)) {
    const name = (match[1] ?? '').trim();
    if (name !== '' && !voices.includes(name)) voices.push(name);
  }
  if (voices.length > 1) losses.add('two-speakers', voices.join(' / '));
  const tags = joined.match(TAG) ?? [];
  for (const tag of tags) {
    // A closing tag is the same run as its opening one, and a voice span is kept as the speaker, so neither is a loss.
    if (tag.startsWith('</') || IS_VOICE_TAG.test(tag)) continue;
    if (IS_TIMESTAMP_TAG.test(tag)) losses.add('inline-timestamp', tag);
    else losses.add('styling', tag);
  }
  const stripped = unescape(joined.replace(TAG, ''));
  const lines = stripped.split('\n').map((line) => line.trim());
  if (voices.length > 0) {
    const text = lines.filter((line) => line !== '').join(' ').replace(/[ \t]{2,}/g, ' ').trim();
    return { text, speaker: voices[0] as string };
  }
  const first = lines.find((line) => line !== '') ?? '';
  const prefixed = prefixedSpeaker(first);
  if (prefixed !== null) {
    const rest = [prefixed.rest, ...lines.slice(lines.indexOf(first) + 1)].filter((line) => line !== '').join(' ');
    return { text: rest.replace(/[ \t]{2,}/g, ' ').trim(), speaker: prefixed.speaker };
  }
  return { text: lines.filter((line) => line !== '').join(' ').replace(/[ \t]{2,}/g, ' ').trim() };
}

/**
 * Reads SRT or WebVTT text. The format is the `WEBVTT` header when it is there, else SRT; a file with neither a header nor one
 * timing line is refused, because there is nothing to time. Every cue is kept, including one whose span is zero or backwards: the
 * episode builder decides what to do with it and the report names it.
 */
export function parseCaptions(text: string): CaptionsResult {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const losses = new Losses();
  const cues: CaptionCue[] = [];
  const notes: CaptionNote[] = [];
  let format: CaptionsFormat = 'srt';
  let at = 0;
  let title: string | undefined;

  while (at < lines.length && isBlank(lines[at] as string)) at += 1;
  if ((lines[at] ?? '').trimStart().startsWith('WEBVTT')) {
    format = 'vtt';
    const header = (lines[at] as string).trim();
    const named = header.slice('WEBVTT'.length).replace(/^[-–—: \t]+/, '').trim();
    if (named !== '') title = named;
    at += 1;
    // Header metadata (`Kind: captions`, `Language: en`) runs to the first blank line and is not a cue.
    while (at < lines.length && !isBlank(lines[at] as string)) at += 1;
  }

  let lastEnd = 0;
  let sawPeriodInSrt = false;

  while (at < lines.length) {
    if (isBlank(lines[at] as string)) {
      at += 1;
      continue;
    }
    const line = (lines[at] as string).trim();

    if (format === 'vtt' && /^NOTE(?:[ \t]|$)/.test(line)) {
      const body = [line.slice('NOTE'.length).trim()];
      at += 1;
      while (at < lines.length && !isBlank(lines[at] as string)) {
        body.push((lines[at] as string).trim());
        at += 1;
      }
      const text = body.filter((part) => part !== '').join('\n');
      if (text !== '') notes.push({ beforeCue: cues.length, text });
      continue;
    }
    if (format === 'vtt' && /^(?:STYLE|REGION)(?:[ \t]|$)/.test(line)) {
      const kind = line.startsWith('STYLE') ? 'style-block' : 'region-block';
      losses.add(kind);
      at += 1;
      while (at < lines.length && !isBlank(lines[at] as string)) at += 1;
      continue;
    }

    let id: string | undefined;
    if (!line.includes(ARROW) && at + 1 < lines.length && (lines[at + 1] as string).includes(ARROW)) {
      id = line;
      // SRT's index is the format's own numbering, not something the writer wrote and loses; a WebVTT cue identifier is.
      if (!(format === 'srt' && /^\d+$/.test(line))) losses.add('cue-id', line);
      at += 1;
    }
    const timing = (lines[at] ?? '').trim();
    if (!timing.includes(ARROW)) {
      losses.add('stray-text', timing);
      at += 1;
      while (at < lines.length && !isBlank(lines[at] as string)) at += 1;
      continue;
    }

    const [leftRaw, rightRaw = ''] = timing.split(ARROW);
    const rightParts = rightRaw.trim().split(/[ \t]+/);
    const start = stamp(leftRaw ?? '');
    const end = stamp(rightParts[0] ?? '');
    if (format === 'srt' && (leftRaw ?? '').includes('.') && !sawPeriodInSrt) {
      sawPeriodInSrt = true;
      losses.add('srt-period', timing);
    }
    const settings = rightParts.slice(1);
    if (settings.length > 0) {
      // SRT's optional cue coordinates are settings too, but they are a different thing to lose.
      const coordinates = settings.every((setting) => /^[XY][12]:/.test(setting));
      losses.add(coordinates ? 'coordinates' : 'cue-settings', settings.join(' '));
    }
    at += 1;
    const body: string[] = [];
    while (at < lines.length && !isBlank(lines[at] as string)) {
      body.push(lines[at] as string);
      at += 1;
    }

    if (start === null || end === null) {
      losses.add('bad-timing', timing);
      continue;
    }
    const words = wordsOf(body, losses);
    if (words.text === '') {
      losses.add('empty-cue', timing);
      continue;
    }
    if (cues.length > 0 && start < (cues[cues.length - 1] as CaptionCue).startSec) losses.add('out-of-order', timing);
    if (start < lastEnd) losses.add('overlap', timing);
    if (end <= start) losses.add('short-cue', timing);
    lastEnd = Math.max(lastEnd, end);
    cues.push({ startSec: start, endSec: end, text: words.text, ...(words.speaker === undefined ? {} : { speaker: words.speaker }), ...(id === undefined ? {} : { id }) });
    if (cues.length > MAX_CUES) {
      return { ok: false, error: { code: 'too-many-cues', message: `The file has more than ${MAX_CUES} cues.` } };
    }
  }

  if (cues.length === 0) {
    return { ok: false, error: { code: 'no-cues', message: 'No timed cue was found in the file.' } };
  }
  return { ok: true, value: { format, cues, notes, losses: losses.list(), ...(title === undefined ? {} : { title }) } };
}
