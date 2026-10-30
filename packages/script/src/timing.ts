/**
 * Timing brackets — [av-script.md §3](../../../docs/architecture/av-script.md), the bullet "Timing brackets".
 *
 * A bracket at the end of a line or cue is a **duration** (`[m:ss]`, `[h:mm:ss]`, `[Ns]`, `[N.Ns]`, above zero) or, on a
 * cue only, an **offset** (`[at m:ss]`, `[at Ns]`, zero allowed). Brackets are read right to left from the end of the
 * line. A line holds at most one duration and a cue at most one offset: reading stops at the first bracket that is not a
 * timing bracket or would be a second of its kind (or an offset on a speech line), and that bracket and everything
 * before it stay words. Nothing is dropped quietly: a bracket that looks like a timing and does not parse is named, and
 * when reading stops, the stop bracket and every well-formed timing bracket before it that was therefore not applied are
 * named too, each with the reason.
 */

import type { ScriptNoticeKind } from './model.js';

/** What one bracket's inside says. */
export type BracketReading =
  | { readonly kind: 'duration'; readonly seconds: number }
  | { readonly kind: 'offset'; readonly seconds: number }
  /** It looks like a timing and does not parse; the reason says why. */
  | { readonly kind: 'invalid'; readonly reason: string }
  /** It is not trying to be a timing (`[laughs]`). */
  | { readonly kind: 'words' };

/** Something the reading of one line reports. */
export interface TimingNotice {
  readonly kind: ScriptNoticeKind;
  readonly message: string;
}

export interface TimingRead {
  /** The line's words with the applied brackets taken off the end. Every bracket that was not applied stays here. */
  readonly words: string;
  readonly durationSec?: number;
  readonly offsetSec?: number;
  readonly notices: readonly TimingNotice[];
}

const TWO_DIGITS = /^\d{2}$/;

/** Seconds from `m:ss`, `h:mm:ss` or `Ns`, or the reason the value is not one. `hours` allows the three-field form. */
function clockSeconds(value: string, hours: boolean): number | string {
  const seconds = /^(\d+(?:\.\d+)?)s$/i.exec(value);
  if (seconds) return Number(seconds[1]);
  const fields = value.split(':');
  if (fields.length === 2 || (hours && fields.length === 3)) {
    if (!fields.every((f) => /^\d+$/.test(f))) return 'its fields must be whole numbers';
    const [first, ...rest] = fields as [string, ...string[]];
    if (!rest.every((f) => TWO_DIGITS.test(f))) return 'the minutes and seconds fields take two digits, as in [1:05]';
    if (fields.length === 2 && first.length > 2) return 'the minutes field runs 0–59; write an hour as [h:mm:ss]';
    const numbers = fields.map(Number);
    const tail = numbers.slice(fields.length === 3 ? 1 : 0);
    if (tail.some((n) => n > 59)) return 'the minutes and seconds fields run 00–59';
    return numbers.reduce((total, n) => total * 60 + n, 0);
  }
  if (fields.length === 3) return 'an offset is [at m:ss] or [at Ns], with no hours field';
  return 'it is not minutes and seconds ([m:ss]) or seconds ([Ns])';
}

/** True when a bracket's inside is trying to be a timing: an `at` prefix, or digits with only timing punctuation. */
function looksLikeTiming(inner: string): boolean {
  const t = inner.trim();
  if (/^at(?:\s|$)/i.test(t)) return true;
  return /\d/.test(t) && /^[-+\d:.,\s]*s?$/i.test(t);
}

/** What one bracket's inside says (§3). */
export function readBracket(inner: string): BracketReading {
  const t = inner.trim();
  const offset = /^at\s+(.+)$/i.exec(t);
  if (offset) {
    const value = (offset[1] ?? '').trim();
    if (value.startsWith('-')) return { kind: 'invalid', reason: 'an offset cannot be negative' };
    const seconds = clockSeconds(value, false);
    if (typeof seconds === 'string') return { kind: 'invalid', reason: seconds };
    return { kind: 'offset', seconds };
  }
  if (!looksLikeTiming(t)) return { kind: 'words' };
  if (/^at$/i.test(t)) return { kind: 'invalid', reason: 'the offset has no time after "at"' };
  if (t.startsWith('-')) return { kind: 'invalid', reason: 'a duration cannot be negative' };
  if (/^\d+(?:\.\d+)?$/.test(t)) return { kind: 'invalid', reason: 'a number needs a unit: write [m:ss] or [Ns]' };
  const seconds = clockSeconds(t, true);
  if (typeof seconds === 'string') return { kind: 'invalid', reason: seconds };
  if (seconds <= 0) return { kind: 'invalid', reason: 'a duration must be greater than zero' };
  return { kind: 'duration', seconds };
}

/** The bracket as a writer reads it in a notice: its kind in words, then the bracket itself. */
function described(bracket: string, reading: BracketReading): string {
  if (reading.kind === 'duration') return `the duration ${bracket}`;
  if (reading.kind === 'offset') return `the offset ${bracket}`;
  return `the bracket ${bracket}`;
}

/** Every `[…]` in a stretch of text, left to right, with what it says. */
function bracketsIn(text: string): { readonly bracket: string; readonly reading: BracketReading }[] {
  const found: { bracket: string; reading: BracketReading }[] = [];
  for (const match of text.matchAll(/\[([^[\]]*)\]/g)) found.push({ bracket: match[0], reading: readBracket(match[1] ?? '') });
  return found;
}

/**
 * The timing brackets at the end of a line's words, read right to left (§3). `role` is `cue` for a cue, which takes one
 * offset and one duration, and `line` for a speech or narration line, which takes one duration and no offset.
 */
export function readTiming(words: string, role: 'line' | 'cue'): TimingRead {
  let rest = words.replace(/\s+$/u, '');
  let durationSec: number | undefined;
  let offsetSec: number | undefined;
  const notices: TimingNotice[] = [];

  /** A notice for each well-formed timing bracket left of the stop, which reading stopping left unapplied. */
  const notApplied = (before: string, stopWords: string): TimingNotice[] =>
    bracketsIn(before)
      .filter(({ reading }) => reading.kind === 'duration' || (reading.kind === 'offset' && role === 'cue'))
      .map(({ bracket, reading }) => ({
        kind: 'bracket-not-applied' as const,
        message: `${described(bracket, reading)} was not applied because reading stopped at ${stopWords}`,
      }));

  for (;;) {
    if (!rest.endsWith(']')) {
      const open = rest.lastIndexOf('[');
      if (open >= 0 && !rest.includes(']', open)) {
        const tail = rest.slice(open + 1);
        if (looksLikeTiming(tail)) {
          const bracket = rest.slice(open);
          notices.push({ kind: 'bracket-unclosed', message: `the bracket ${bracket} is not closed, so it times nothing and stays in the text` });
          notices.push(...notApplied(rest.slice(0, open), `the unclosed bracket ${bracket}`));
        }
      }
      break;
    }
    const open = rest.lastIndexOf('[');
    if (open < 0) break;
    const bracket = rest.slice(open);
    const inner = bracket.slice(1, -1);
    if (inner.includes(']')) break;
    const reading = readBracket(inner);
    let stop: { readonly words: string; readonly notice?: TimingNotice } | undefined;
    if (reading.kind === 'words') {
      stop = { words: `the bracket ${bracket}` };
    } else if (reading.kind === 'invalid') {
      stop = {
        words: `the bracket ${bracket}, which is not a timing`,
        notice: { kind: 'bracket-unparsed', message: `the bracket ${bracket} is not a timing (${reading.reason}), so it stays in the text` },
      };
    } else if (reading.kind === 'offset' && role === 'line') {
      stop = {
        words: `the offset ${bracket} on a speech line`,
        notice: { kind: 'bracket-misplaced', message: `the offset ${bracket} is on a speech line, and only a cue takes an offset, so it stays in the text` },
      };
    } else if (reading.kind === 'duration' && durationSec !== undefined) {
      stop = {
        words: `the second duration ${bracket}`,
        notice: { kind: 'bracket-misplaced', message: `the duration ${bracket} is a second duration on this line, so it stays in the text` },
      };
    } else if (reading.kind === 'offset' && offsetSec !== undefined) {
      stop = {
        words: `the second offset ${bracket}`,
        notice: { kind: 'bracket-misplaced', message: `the offset ${bracket} is a second offset on this cue, so it stays in the text` },
      };
    }
    if (stop !== undefined) {
      const unapplied = notApplied(rest.slice(0, open), stop.words);
      // A plain bracket of words ends the reading without a notice of its own, unless it kept a timing from being applied.
      const own =
        stop.notice ??
        (unapplied.length > 0
          ? { kind: 'bracket-misplaced' as const, message: `the bracket ${bracket} is not a timing, so the timing before it stays in the text` }
          : undefined);
      if (own !== undefined) notices.push(own);
      notices.push(...unapplied);
      break;
    }
    if (reading.kind === 'duration') durationSec = reading.seconds;
    else if (reading.kind === 'offset') offsetSec = reading.seconds;
    rest = rest.slice(0, open).replace(/\s+$/u, '');
  }

  return {
    words: rest,
    ...(durationSec === undefined ? {} : { durationSec }),
    ...(offsetSec === undefined ? {} : { offsetSec }),
    notices,
  };
}
