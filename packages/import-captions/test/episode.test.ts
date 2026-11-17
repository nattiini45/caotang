/**
 * Cues to an episode (issue #287). The body is checked with **the AV script's own parser** (`parseEpisode`, av-script.md §3–§4),
 * not with this package's own idea of the grammar: every line's speaker, words and declared duration have to come back as the
 * script will read them, and a NOTE has to come back as text rather than as a speaker.
 */

import { describe, expect, it } from 'vitest';
import { parseEpisode, type ScriptLine } from '@caotang/script';

import { parseCaptions, type CaptionsRead } from '../src/cues.js';
import { buildEpisode, clock, durationBracket, speakerLabel } from '../src/episode.js';

function cuesOf(text: string): CaptionsRead {
  const result = parseCaptions(text);
  if (!result.ok) throw new Error(`refused: ${result.error.code}`);
  return result.value;
}

const TWO_SPEAKERS = [
  'WEBVTT',
  '',
  'NOTE Recorded on the pier',
  '',
  '00:00:01.000 --> 00:00:04.000',
  '<v Ada>We lit the lamp.</v>',
  '',
  '00:00:04.500 --> 00:00:06.000',
  '<v Bob>And then we waited.</v>',
  '',
  '00:00:20.000 --> 00:00:22.000',
  '<v Ada>Much later.</v>',
  '',
].join('\n');

function speech(lines: readonly ScriptLine[]): ScriptLine[] {
  return lines.filter((line) => line.kind === 'speech' || line.kind === 'narration');
}

describe('the episode body, read back by the script parser', () => {
  it('writes one speech line per cue with the declared duration, and the parser agrees', () => {
    const built = buildEpisode(cuesOf(TWO_SPEAKERS), { mergeSameSpeaker: false, silence: 'leave', title: 'Episode 12' });
    const parsed = parseEpisode(built.body);
    expect(parsed.title).toBe('Episode 12');
    expect(parsed.segments.length).toBe(2);
    const first = speech(parsed.segments[0]!.lines);
    expect(first.map((line) => [line.speaker, line.text, line.durationSec, line.declared])).toEqual([
      ['Ada', 'We lit the lamp.', 3, true],
      ['Bob', 'And then we waited.', 1.5, true],
    ]);
    expect(speech(parsed.segments[1]!.lines).map((line) => [line.speaker, line.durationSec])).toEqual([['Ada', 2]]);
  });

  it('keeps a NOTE as a text line, never as a speaker, even when it holds a colon', () => {
    const read = cuesOf(['WEBVTT', '', 'NOTE Host: check this', '', '00:00.000 --> 00:01.000', '<v Ada>Words.</v>', ''].join('\n'));
    const parsed = parseEpisode(buildEpisode(read).body);
    const lines = parsed.segments[0]!.lines;
    expect(lines.filter((line) => line.kind === 'text').map((line) => line.text)).toEqual(['> Host: check this']);
    expect(speech(lines).map((line) => line.speaker)).toEqual(['Ada']);
  });

  it('starts a new segment at a gap of the chosen size, and names the gap time it leaves outside the runtime', () => {
    const read = cuesOf(TWO_SPEAKERS);
    const built = buildEpisode(read, { mergeSameSpeaker: false, gapSegmentSec: 3, silence: 'leave' });
    expect(built.segments.length).toBe(2);
    expect(built.gapSec).toBe(14);
    expect(built.seconds).toBe(6.5);
    expect(buildEpisode(read, { gapSegmentSec: 0 }).segments.length).toBe(1);
    expect(buildEpisode(read, { gapSegmentSec: 30 }).segments.length).toBe(1);
  });

  it('folds a small gap into the line before it by default, so the total is the file’s wall clock', () => {
    const read = cuesOf(TWO_SPEAKERS);
    const folded = buildEpisode(read, { mergeSameSpeaker: false, gapSegmentSec: 3, silence: 'fold' });
    // 3 s + the 0.5 s gap, then 1.5 s, then 2 s: the 14 s segment gap stays outside.
    expect(folded.seconds).toBe(7);
    expect(folded.foldedSec).toBe(0.5);
    const parsed = parseEpisode(folded.body);
    expect(speech(parsed.segments[0]!.lines).map((line) => line.durationSec)).toEqual([3.5, 1.5]);
    const left = buildEpisode(read, { mergeSameSpeaker: false, gapSegmentSec: 3, silence: 'leave' });
    expect(left.leftOutSec).toBe(0.5);
    expect(left.seconds).toBe(6.5);
  });

  it('merges consecutive cues of one speaker, and the merged line spans them both', () => {
    const read = cuesOf([
      'WEBVTT', '',
      '00:00.000 --> 00:02.000', '<v Ada>One sentence</v>', '',
      '00:02.100 --> 00:04.000', '<v Ada>that keeps going.</v>', '',
      '00:04.100 --> 00:05.000', '<v Bob>Another speaker.</v>', '',
    ].join('\n'));
    const merged = buildEpisode(read, { mergeSameSpeaker: true });
    expect(merged.lines).toBe(2);
    expect(merged.merged).toBe(1);
    const parsed = parseEpisode(merged.body);
    expect(speech(parsed.segments[0]!.lines).map((line) => [line.speaker, line.text, line.durationSec])).toEqual([
      // The merged line spans 0–4 s, and the 0.1 s before the next speaker is folded into it (the default).
      ['Ada', 'One sentence that keeps going.', 4.1],
      ['Bob', 'Another speaker.', 0.9],
    ]);
    expect(buildEpisode(read, { mergeSameSpeaker: false }).lines).toBe(3);
  });

  it('leaves a cue with no span untimed rather than inventing a duration', () => {
    const read = cuesOf(['WEBVTT', '', '00:01.000 --> 00:01.000', '<v Ada>No time.</v>', ''].join('\n'));
    const built = buildEpisode(read);
    expect(built.losses.find((loss) => loss.kind === 'untimed-line')?.count).toBe(1);
    const line = speech(parseEpisode(built.body).segments[0]!.lines)[0]!;
    expect(line.declared).toBe(false);
    expect(built.body).toContain('Ada: No time.');
  });

  it('names the leading offset, which the script cannot store because lines hold durations', () => {
    const built = buildEpisode(cuesOf(TWO_SPEAKERS));
    expect(built.leadingSec).toBe(1);
  });

  it('counts a parenthetical as a modifier, not as spoken words', () => {
    const read = cuesOf(['WEBVTT', '', '00:00.000 --> 00:02.000', '<v Ada>Two words (laughs)</v>', ''].join('\n'));
    const built = buildEpisode(read);
    expect(built.words).toBe(2);
    const line = speech(parseEpisode(built.body).segments[0]!.lines)[0]!;
    expect(line.text).toBe('Two words');
    expect(line.modifiers).toEqual(['laughs']);
  });
});

describe('the speaker label the grammar can hold', () => {
  it('keeps a name the grammar reads, in any script', () => {
    expect(speakerLabel('Ada Lovelace').label).toBe('Ada Lovelace');
    expect(speakerLabel('HOST_A').label).toBe('HOST_A');
    expect(speakerLabel('王芳').label).toBe('王芳');
    expect(speakerLabel(undefined).label).toBe('NARRATION');
    expect(speakerLabel('   ').label).toBe('NARRATION');
  });

  it('changes a name the grammar cannot hold as little as it can, and reports both spellings', () => {
    const renamed = speakerLabel('Ada (host)');
    expect(renamed.label).toBe('Ada host');
    expect(renamed.loss).toEqual({ kind: 'speaker-renamed', count: 1, sample: 'Ada (host) → Ada host' });
    expect(speakerLabel('2Pac').label).toBe('Pac');
    expect(speakerLabel('***').label).toBe('NARRATION');
    expect(speakerLabel('x'.repeat(60)).label.length).toBe(40);
  });

  it('never lets a speaker be one of the show’s cue words, which would make the line a cue', () => {
    const collision = speakerLabel('Music');
    expect(collision.label).toBe('Music_');
    expect(collision.loss?.kind).toBe('speaker-cue-word');
    const read = cuesOf(['WEBVTT', '', '00:00.000 --> 00:02.000', '<v Music>Not a cue.</v>', ''].join('\n'));
    const built = buildEpisode(read);
    const line = speech(parseEpisode(built.body).segments[0]!.lines)[0]!;
    expect(line.speaker).toBe('Music_');
    expect(parseEpisode(built.body).segments[0]!.cues.length).toBe(0);
  });

  it('counts a bracket of timings inside the cue’s own words, which the grammar keeps as words', () => {
    const read = cuesOf(['WEBVTT', '', '00:00.000 --> 00:02.000', '<v Ada>It said [12s]</v>', ''].join('\n'));
    const built = buildEpisode(read);
    expect(built.losses.find((loss) => loss.kind === 'text-bracket')?.count).toBe(1);
    const line = speech(parseEpisode(built.body).segments[0]!.lines)[0]!;
    expect(line.text).toBe('It said [12s]');
    expect(line.durationSec).toBe(2);
  });
});

describe('the two spellings the body uses', () => {
  it('writes a duration in seconds with at most milliseconds, and never a zero', () => {
    expect(durationBracket(12)).toBe('[12s]');
    expect(durationBracket(12.5)).toBe('[12.5s]');
    expect(durationBracket(12.3456)).toBe('[12.346s]');
    expect(durationBracket(0.0004)).toBe('[0s]');
  });

  it('writes a clock position with hours only when there are hours', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(7.9)).toBe('0:07');
    expect(clock(62)).toBe('1:02');
    expect(clock(3723)).toBe('1:02:03');
  });
});
