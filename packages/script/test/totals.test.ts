/**
 * Segment timing and episode totals (av-script.md §4): the `animaticTotals` shape, untimed segments left out and listed,
 * cue ends, beds and the start of each timed segment.
 */

import { describe, expect, it } from 'vitest';

import { parseEpisode, scriptTotals } from '../src/index.js';

describe('ScriptTotals is the AnimaticTotals shape', () => {
  it("has animaticTotals' three keys: seconds, timedCount and untimed", () => {
    expect(Object.keys(parseEpisode('## A\nHOST: Hi [1s]').totals)).toEqual(['seconds', 'timedCount', 'untimed']);
  });

  it('sums the timed segments to two places and lists the untimed ones in body order', () => {
    expect(scriptTotals([{ id: 'a', durationSec: 0.1 }, { id: 'b' }, { id: 'c', durationSec: 0.2 }, { id: 'd' }])).toEqual({
      seconds: 0.3,
      timedCount: 2,
      untimed: ['b', 'd'],
    });
  });
});

describe('a segment is timed by its lines and declared cue durations', () => {
  it('treats a cue-only segment with point cues as untimed, excluded from the total', () => {
    const episode = parseEpisode('## Timed\nHOST: Hi [0:10]\n## Cues only\nSFX: Bang\nMUSIC: Sting [at 0:02]\n## Empty\n## Also timed\nHOST: Bye [5s]');
    expect(episode.totals).toEqual({ seconds: 15, timedCount: 2, untimed: ['segment-2', 'segment-3'] });
    expect(episode.segments[1]?.durationSec).toBeUndefined();
    expect(episode.segments[1]?.startSec).toBeUndefined();
  });

  it('times a cue-only segment by a cue with a declared duration', () => {
    const episode = parseEpisode('## Music\nMUSIC: Theme [at 0:02] [0:30]');
    expect(episode.segments[0]?.durationSec).toBe(32);
    expect(episode.totals).toEqual({ seconds: 32, timedCount: 1, untimed: [] });
  });

  it('treats a segment of only untimed lines (text, empty speech) as untimed', () => {
    const episode = parseEpisode('## A\nA stage note.\nHOST:');
    expect(episode.totals.untimed).toEqual(['segment-1']);
  });

  it('runs a segment to the later of its speech end and its last cue end', () => {
    const episode = parseEpisode('## A\nHOST: One [0:10]\nSFX: Tail [at 0:08] [0:05]');
    expect(episode.segments[0]?.durationSec).toBe(13);
  });

  it('ends a bed at the speech end and a point cue at its offset', () => {
    const bed = parseEpisode('## A\nMUSIC: Bed (under) [at 0:30]\nHOST: Words [0:10]');
    // The bed is a point at 30 s with no duration, but a bed ends at the speech end (10 s), so the segment is 10 s.
    expect(bed.segments[0]?.durationSec).toBe(10);
    const point = parseEpisode('## A\nSFX: Late [at 0:30]\nHOST: Words [0:10]');
    expect(point.segments[0]?.durationSec).toBe(30);
  });

  it('starts each timed segment where the timed segments before it end', () => {
    const episode = parseEpisode('## A\nHOST: x [0:10]\n## B\nSFX: point\n## C\nHOST: y [0:05]');
    expect(episode.segments.map((s) => s.startSec)).toEqual([0, undefined, 10]);
    expect(episode.totals.seconds).toBe(15);
  });

  it('counts estimated lines in the total, rounded to two places', () => {
    // Seven words at 150 wpm is 2.8 s; one word is 0.4 s.
    const episode = parseEpisode('## A\nHOST: one two three four five six seven\nHOST: eight');
    expect(episode.totals).toEqual({ seconds: 3.2, timedCount: 1, untimed: [] });
  });
});
