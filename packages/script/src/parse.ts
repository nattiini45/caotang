/**
 * The episode parser — [av-script.md §3](../../../docs/architecture/av-script.md).
 *
 * The body is Markdown a writer can read without Caotang, parsed as text the way Fountain and the comic script are. `#`
 * before the first segment is the episode's title; each `##` heading starts a segment; every other non-blank line is a
 * line or a cue. A line `LABEL: text` (the colon followed by a space, a tab or the end of the line, so `10:30` and a URL
 * are not labels) is classified in this order, once, with the label compared without case:
 *
 * 1. **Cue** — the label is in the show's cue vocabulary.
 * 2. **Narration** — the label is `NARRATION`.
 * 3. **Speech** — any other label shaped like a name (`SCRIPT_LABEL_PATTERN`), resolved against the codex when one is given.
 * 4. **Text** — anything else. Never dropped.
 *
 * Nothing here writes to the body. What it cannot use (a bracket that does not parse, a malformed or duplicated id tag,
 * a speaker the codex does not know) stays in the text and is named in the notices with its line.
 */

import { SCRIPT_LABEL_PATTERN } from '@caotang/bus';
import { caseFold } from '@caotang/codex';
import { countBody, type CodexEntry } from '@caotang/store';

import { isMintedScriptId } from './line-ids.js';
import type { ParsedEpisode, ScriptCue, ScriptLine, ScriptNotice, ScriptSegment } from './model.js';
import { cueVocabularyOf, NARRATION_LABEL, speechRateOf, type ShowMeta } from './settings.js';
import { resolveScriptSpeaker } from './speakers.js';
import { readTiming } from './timing.js';
import { roundSeconds, scriptTotals, segmentTiming } from './totals.js';

/** True for a space or a tab. */
const isBlank = (ch: string | undefined): boolean => ch === ' ' || ch === '\t';

/** The text without the spaces and tabs at either end. Loops rather than regular expressions, so no input can make them slow. */
function trimSpaces(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isBlank(text[start])) start += 1;
  while (end > start && isBlank(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

/** True for any whitespace character, the set `\s` matches. */
const isSpace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch);

/**
 * Where `<!--`, then blanks, ends at `end` (the start of what follows), as the leftmost index the tag can start at,
 * blanks before the `<!--` included; undefined when no `<!--` sits there.
 */
function tagStartBefore(words: string, end: number): number | undefined {
  let i = end;
  while (i > 0 && isBlank(words[i - 1])) i -= 1;
  if (i < 4 || words.slice(i - 4, i) !== '<!--') return undefined;
  let start = i - 4;
  while (start > 0 && isBlank(words[start - 1])) start -= 1;
  return start;
}

/**
 * The id tag at the end of a line (`<!-- lineId: … -->`): where it starts, and the id as written (possibly malformed,
 * but never holding whitespace). It reads exactly what `/[ \t]*<!--[ \t]*lineId:[ \t]*(\S*?)[ \t]*-->[ \t]*$/` did,
 * leftmost start included, in linear time.
 */
function idTagOf(words: string): { readonly index: number; readonly id: string } | undefined {
  let close = words.length;
  while (close > 0 && isBlank(words[close - 1])) close -= 1;
  close -= 3;
  if (close < 0 || words.slice(close, close + 3) !== '-->') return undefined;
  // The id ends where the blanks before `-->` begin, and starts no earlier than the run of non-space before that.
  let idEnd = close;
  while (idEnd > 0 && isBlank(words[idEnd - 1])) idEnd -= 1;
  let run = idEnd;
  while (run > 0 && !isSpace(words[run - 1])) run -= 1;
  const KEY = 'lineId:';
  let best: { index: number; id: string } | undefined;
  const consider = (keyStart: number, idStart: number): void => {
    const index = tagStartBefore(words, keyStart);
    if (index !== undefined && (best === undefined || index < best.index)) best = { index, id: words.slice(idStart, idEnd) };
  };
  // `lineId:` inside the run, the id being the rest of it.
  for (let at = words.indexOf(KEY, run); at >= 0 && at + KEY.length <= idEnd; at = words.indexOf(KEY, at + 1)) {
    consider(at, at + KEY.length);
  }
  // `lineId:` ending just before the blanks in front of the run, the id being the whole run.
  let keyEnd = run;
  while (keyEnd > 0 && isBlank(words[keyEnd - 1])) keyEnd -= 1;
  if (keyEnd < run && keyEnd >= KEY.length && words.slice(keyEnd - KEY.length, keyEnd) === KEY) {
    consider(keyEnd - KEY.length, run);
  }
  return best;
}

/** An ATX heading: up to three spaces, one to six `#`, then a space or the end, the text, with any closing `#`s taken off. */
function headingOf(text: string): { readonly level: number; readonly title: string } | undefined {
  let i = 0;
  while (i < 3 && text[i] === ' ') i += 1;
  let level = 0;
  while (text[i + level] === '#') level += 1;
  if (level < 1 || level > 6) return undefined;
  const after = text.slice(i + level);
  if (after !== '' && !isBlank(after[0])) return undefined;
  let title = trimSpaces(after);
  // A closing sequence of `#`s, set off by a space, is not part of the title.
  let end = title.length;
  while (end > 0 && title[end - 1] === '#') end -= 1;
  if (end === 0) title = '';
  else if (end < title.length && isBlank(title[end - 1])) title = trimSpaces(title.slice(0, end));
  return { level, title: title.trim() };
}

/** A label: the text before the first colon, when the colon is followed by a space, a tab or the end of the line. */
function labelledOf(text: string): { readonly label: string; readonly words: string } | undefined {
  const colon = text.indexOf(':');
  if (colon < 0) return undefined;
  const next = text[colon + 1];
  if (next !== undefined && !isBlank(next)) return undefined;
  const label = text.slice(0, colon).trim();
  if (label === '') return undefined;
  // Only the blanks after the colon go; trailing ones stay with the words, as they always have.
  let start = colon + 1;
  while (isBlank(text[start])) start += 1;
  return { label, words: text.slice(start) };
}

export type BodyLineRole = 'cue' | 'speech' | 'narration' | 'text';

/** One content line of a body, classified (§3). Headings and blank lines are not listed. */
export interface ClassifiedLine {
  /** 1-based. */
  readonly line: number;
  readonly role: BodyLineRole;
  /** The label as typed, on a cue, speech or narration line. */
  readonly label?: string;
  /** On a cue, the vocabulary label it matched, as the vocabulary spells it. */
  readonly cueKind?: string;
  /** What follows the label, without the id tag. A text line's whole text, trimmed. */
  readonly rest: string;
  /** The id in the line's tag, as written. Absent when the line has no tag. */
  readonly tag?: string;
}

type Scanned =
  | { readonly kind: 'title'; readonly line: number; readonly text: string }
  | { readonly kind: 'segment'; readonly line: number; readonly text: string }
  | { readonly kind: 'content'; readonly entry: ClassifiedLine };

/** The vocabulary as a lookup: the case-folded label to the label as the vocabulary spells it. */
function vocabularyIndex(vocabulary: readonly string[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const label of vocabulary) {
    const key = caseFold(label.trim());
    if (!index.has(key)) index.set(key, label.trim());
  }
  return index;
}

function classify(text: string, line: number, vocabulary: ReadonlyMap<string, string>): ClassifiedLine {
  const labelled = labelledOf(text);
  if (labelled) {
    const { label, words } = labelled;
    const key = caseFold(label);
    const cueKind = vocabulary.get(key);
    const role: BodyLineRole | undefined =
      cueKind !== undefined
        ? 'cue'
        : key === caseFold(NARRATION_LABEL)
          ? 'narration'
          : SCRIPT_LABEL_PATTERN.test(label)
            ? 'speech'
            : undefined;
    if (role !== undefined) {
      const tag = idTagOf(words);
      const rest = tag ? words.slice(0, tag.index) : words;
      return {
        line,
        role,
        label,
        ...(cueKind === undefined ? {} : { cueKind }),
        rest,
        ...(tag ? { tag: tag.id } : {}),
      };
    }
  }
  return { line, role: 'text', rest: text.trim() };
}

function scan(body: string, vocabulary: readonly string[]): Scanned[] {
  const index = vocabularyIndex(vocabulary);
  const out: Scanned[] = [];
  let sawSegment = false;
  let sawTitle = false;
  body.split('\n').forEach((raw, i) => {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (text.trim() === '') return;
    const line = i + 1;
    const heading = headingOf(text);
    if (heading) {
      const { level, title } = heading;
      if (level === 2) {
        sawSegment = true;
        out.push({ kind: 'segment', line, text: title });
        return;
      }
      if (level === 1 && !sawSegment && !sawTitle) {
        sawTitle = true;
        out.push({ kind: 'title', line, text: title });
        return;
      }
    }
    out.push({ kind: 'content', entry: classify(text, line, index) });
  });
  return out;
}

/** Every content line of a body, classified with the vocabulary (absent = the default six). The id mint reads this. */
export function classifyBodyLines(body: string, vocabulary?: readonly string[]): ClassifiedLine[] {
  const out: ClassifiedLine[] = [];
  for (const item of scan(body, vocabulary ?? cueVocabularyOf())) if (item.kind === 'content') out.push(item.entry);
  return out;
}

/** The parentheticals of a stretch of words, and the words without them (§3: kept as modifiers). */
function modifiersOf(words: string): { readonly text: string; readonly modifiers: string[] } {
  const modifiers: string[] = [];
  const text = words
    .replace(/\(([^()]*)\)/g, (_match, inner: string) => {
      const trimmed = inner.trim();
      if (trimmed !== '') modifiers.push(trimmed);
      return ' ';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return { text, modifiers };
}

/** A bed (§3, E4): a `(under)` modifier, or cue text whose last word is "under" (`Theme, in and under`, `fade under`). */
function isBed(text: string, modifiers: readonly string[]): boolean {
  return modifiers.some((m) => caseFold(m) === 'under') || /(?:^|[^\p{L}\p{N}])under[.!]?$/iu.test(text);
}

export interface ParseOptions {
  /** The show's settings: its cue vocabulary, speech rate and default speaker. Absent = the defaults. */
  readonly show?: ShowMeta;
  /** The codex. When given, a speech label resolves against its characters and an unknown one is named in the notices. */
  readonly codex?: readonly CodexEntry[];
}

interface SegmentDraft {
  readonly id: string;
  readonly title: string;
  readonly line: number;
  readonly lines: ScriptLine[];
  readonly cues: ScriptCue[];
  /** The sum of the timed lines so far, for a cue's derived `atSec`. */
  speechSoFar: number;
}

/** Parses an episode body into segments, lines, cues and totals (§2, §3, §4). */
export function parseEpisode(body: string, options: ParseOptions = {}): ParsedEpisode {
  const show = options.show ?? {};
  const rate = speechRateOf(show);
  const notices: ScriptNotice[] = [];
  const seenIds = new Set<string>();
  const drafts: SegmentDraft[] = [];
  let title: string | undefined;
  let current: SegmentDraft | undefined;
  let segmentCount = 0;

  const open = (line: number, heading?: string): SegmentDraft => {
    if (heading !== undefined) segmentCount += 1;
    const draft: SegmentDraft = {
      id: `segment-${heading === undefined ? 0 : segmentCount}`,
      title: heading ?? '',
      line,
      lines: [],
      cues: [],
      speechSoFar: 0,
    };
    drafts.push(draft);
    return draft;
  };

  /** The id a spoken line or cue reads with: its tag when that is a minted id of its kind seen first, else a session-local id. */
  const idFor = (entry: ClassifiedLine, kind: 'line' | 'cue'): { readonly id: string; readonly minted: boolean } => {
    const local = { id: `~${kind === 'cue' ? 'c' : 'l'}${entry.line}`, minted: false };
    if (entry.tag === undefined) return local;
    if (!isMintedScriptId(entry.tag, kind)) {
      notices.push({
        kind: 'id-malformed',
        line: entry.line,
        message: `the lineId tag "${entry.tag}" is not a ${kind === 'cue' ? 'cue id (sc_' : 'line id (sl_'} and ten letters or digits), so it is left as written; fix or remove it and the next save mints one`,
      });
      return local;
    }
    if (seenIds.has(entry.tag)) {
      notices.push({
        kind: 'id-duplicate',
        line: entry.line,
        message: `the id ${entry.tag} is already on an earlier line; remove one of the two tags and the next save mints a new id for that line`,
      });
      return local;
    }
    seenIds.add(entry.tag);
    return { id: entry.tag, minted: true };
  };

  for (const item of scan(body, cueVocabularyOf(show))) {
    if (item.kind === 'title') {
      title = item.text;
      continue;
    }
    if (item.kind === 'segment') {
      current = open(item.line, item.text);
      continue;
    }
    const entry = item.entry;
    const segment = current ?? (current = open(entry.line));

    if (entry.role === 'text') {
      segment.lines.push({
        id: `~l${entry.line}`,
        minted: false,
        kind: 'text',
        text: entry.rest,
        modifiers: [],
        words: countBody(entry.rest).words,
        declared: false,
        line: entry.line,
      });
      continue;
    }

    const role = entry.role === 'cue' ? 'cue' : 'line';
    const timing = readTiming(entry.rest, role);
    for (const notice of timing.notices) notices.push({ kind: notice.kind, line: entry.line, message: notice.message });
    const { text, modifiers } = modifiersOf(timing.words);
    const { id, minted } = idFor(entry, role);

    if (entry.role === 'cue') {
      segment.cues.push({
        id,
        minted,
        kind: entry.cueKind ?? (entry.label ?? '').toLowerCase(),
        label: entry.label ?? '',
        text,
        modifiers,
        atSec: timing.offsetSec ?? roundSeconds(segment.speechSoFar),
        atDeclared: timing.offsetSec !== undefined,
        ...(timing.durationSec === undefined ? {} : { forSec: timing.durationSec }),
        under: isBed(text, modifiers),
        line: entry.line,
      });
      continue;
    }

    const words = countBody(text).words;
    const durationSec = timing.durationSec ?? (words > 0 ? roundSeconds((words * 60) / rate) : undefined);
    if (durationSec !== undefined) segment.speechSoFar += durationSec;
    let speaker: string | undefined;
    if (entry.role === 'narration') {
      speaker = show.defaultSpeaker;
    } else {
      const label = entry.label ?? '';
      speaker = label;
      if (options.codex !== undefined) {
        const resolution = resolveScriptSpeaker(options.codex, label);
        if (resolution.kind === 'resolved') {
          speaker = resolution.entry.id;
        } else if (resolution.kind === 'unknown') {
          notices.push({
            kind: 'speaker-unknown',
            line: entry.line,
            message: `${label} is not a character in the codex, so the line is kept under the typed name; add ${label} to the codex, or add it to the show's cue vocabulary if it was meant as a cue`,
          });
        } else {
          const names = resolution.entries.map((e) => e.name).join(' and ');
          notices.push({
            kind: 'speaker-ambiguous',
            line: entry.line,
            message: `${label} names more than one character in the codex (${names}), so the line is kept under the typed name; give one of them a different name or alias`,
          });
        }
      }
    }
    segment.lines.push({
      id,
      minted,
      kind: entry.role,
      label: entry.label ?? '',
      ...(speaker === undefined ? {} : { speaker }),
      text,
      modifiers,
      words,
      ...(durationSec === undefined ? {} : { durationSec }),
      declared: timing.durationSec !== undefined,
      line: entry.line,
    });
  }

  let clock = 0;
  const segments: ScriptSegment[] = drafts.map((draft) => {
    const timing = segmentTiming(draft.lines, draft.cues);
    const base = { id: draft.id, title: draft.title, lines: draft.lines, cues: draft.cues, line: draft.line };
    if (timing.durationSec === undefined) return base;
    const segment: ScriptSegment = { ...base, startSec: roundSeconds(clock), durationSec: timing.durationSec };
    clock += timing.durationSec;
    return segment;
  });

  return {
    ...(title === undefined ? {} : { title }),
    segments,
    totals: scriptTotals(segments),
    notices,
  };
}
