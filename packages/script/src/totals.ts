/**
 * Segment timing and episode totals — [av-script.md §4](../../../docs/architecture/av-script.md).
 *
 * A cue ends at `atSec + forSec` when it has a duration; a cue with no `forSec` is a point and ends at its `atSec`,
 * except an `under` cue (a bed), which ends at the segment's speech end. A segment's speech end is the sum of its timed
 * lines, and its duration is the later of its speech end and its last cue end. A segment is timed when it has at least
 * one timed line or one cue with a declared `forSec`; any other segment is untimed, left out of the total and listed in
 * `ScriptTotals.untimed`, as `animaticTotals` lists an untimed shot. Seconds are rounded to two places, as there.
 */

import type { ScriptCue, ScriptLine, ScriptSegment, ScriptTotals } from './model.js';

/** Two decimal places, the rounding `animaticTotals` uses. */
export function roundSeconds(seconds: number): number {
  return Math.round(seconds * 100) / 100;
}

/** The timing of one segment's lines and cues: its speech end, its duration, and whether it is timed at all. */
export interface SegmentTiming {
  readonly speechEndSec: number;
  /** Absent when the segment is untimed. */
  readonly durationSec?: number;
  readonly timed: boolean;
}

/** One segment's timing (§4). */
export function segmentTiming(lines: readonly ScriptLine[], cues: readonly ScriptCue[]): SegmentTiming {
  let speechEnd = 0;
  let timedLine = false;
  for (const line of lines) {
    if (line.durationSec === undefined) continue;
    speechEnd += line.durationSec;
    timedLine = true;
  }
  const timedCue = cues.some((cue) => cue.forSec !== undefined);
  if (!timedLine && !timedCue) return { speechEndSec: roundSeconds(speechEnd), timed: false };
  let end = speechEnd;
  for (const cue of cues) {
    const cueEnd = cue.forSec !== undefined ? cue.atSec + cue.forSec : cue.under ? speechEnd : cue.atSec;
    if (cueEnd > end) end = cueEnd;
  }
  return { speechEndSec: roundSeconds(speechEnd), durationSec: roundSeconds(end), timed: true };
}

/** The episode totals over its segments, in body order: the `AnimaticTotals` shape (§2). */
export function scriptTotals(segments: readonly Pick<ScriptSegment, 'id' | 'durationSec'>[]): ScriptTotals {
  let seconds = 0;
  let timedCount = 0;
  const untimed: string[] = [];
  for (const segment of segments) {
    if (segment.durationSec === undefined) {
      untimed.push(segment.id);
    } else {
      seconds += segment.durationSec;
      timedCount += 1;
    }
  }
  return { seconds: roundSeconds(seconds), timedCount, untimed };
}
