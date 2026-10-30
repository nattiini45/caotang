/**
 * Timing brackets and estimates (av-script.md §3 "Timing brackets", §4): the grammar, the right-to-left reading, each
 * unparseable bracket staying text and named, the stop rule's notices, and the speech-rate estimate.
 */

import { describe, expect, it } from 'vitest';

import { parseEpisode, readBracket, readTiming, SPEECH_RATE_PRESETS, speechRateOf } from '../src/index.js';

describe('the bracket grammar', () => {
  it.each([
    ['0:15', 15],
    ['1:05', 65],
    ['59:59', 3599],
    ['1:00:00', 3600],
    ['2:03:04', 7384],
    ['12s', 12],
    ['0.5s', 0.5],
    ['2.25s', 2.25],
  ])('reads [%s] as a duration of %s seconds', (inner, seconds) => {
    expect(readBracket(inner)).toEqual({ kind: 'duration', seconds });
  });

  it.each([
    ['at 0:04', 4],
    ['at 0:00', 0],
    ['at 0s', 0],
    ['at 1.5s', 1.5],
  ])('reads [%s] as an offset of %s seconds, zero allowed', (inner, seconds) => {
    expect(readBracket(inner)).toEqual({ kind: 'offset', seconds });
  });

  it.each([
    ['1:75', /00–59/],
    ['0', /needs a unit/],
    ['-5s', /negative/],
    ['0s', /greater than zero/],
    ['0:00', /greater than zero/],
    ['1:5', /two digits/],
    ['100:00', /0–59/],
    ['at -1s', /negative/],
    ['at 1:00:00', /no hours field/],
    ['at', /no time/],
  ])('refuses [%s] as a timing, with the reason', (inner, reason) => {
    const reading = readBracket(inner);
    expect(reading.kind).toBe('invalid');
    expect(reading.kind === 'invalid' ? reading.reason : '').toMatch(reason);
  });

  it.each(['laughs', 'beat', 'sic', 'Track 2 of the album'])('reads [%s] as words, not a timing', (inner) => {
    expect(readBracket(inner)).toEqual({ kind: 'words' });
  });
});

describe('each unparseable bracket stays in the text and is named with its line', () => {
  it.each([
    ['HOST: Hello [1:75]', '[1:75]', 'bracket-unparsed'],
    ['HOST: Hello [0]', '[0]', 'bracket-unparsed'],
    ['HOST: Hello [-5s]', '[-5s]', 'bracket-unparsed'],
    ['HOST: Hello [0s]', '[0s]', 'bracket-unparsed'],
    ['HOST: Hello [at 0:04]', '[at 0:04]', 'bracket-misplaced'],
    ['HOST: Hello [0:15', '[0:15', 'bracket-unclosed'],
  ])('%s', (source, bracket, kind) => {
    const episode = parseEpisode(`## A\n${source}`);
    const line = episode.segments[0]?.lines[0];
    expect(line?.text).toContain(bracket);
    expect(line?.declared).toBe(false);
    expect(episode.notices).toEqual([expect.objectContaining({ kind, line: 2, message: expect.stringContaining(bracket) })]);
  });

  it('times an unparseable line by its estimate and never by the bracket', () => {
    const line = parseEpisode('## A\nHOST: Hello [1:75]').segments[0]?.lines[0];
    // "Hello [1:75]" is two whitespace tokens at 150 wpm: 0.8 s, marked as an estimate.
    expect(line).toMatchObject({ durationSec: 0.8, declared: false });
  });
});

describe('brackets are read right to left, and reading stops at the first one that cannot apply', () => {
  it('applies a cue offset and a duration, offset first', () => {
    const cue = parseEpisode('## A\nSFX: Door slam [at 0:04] [2s]').segments[0]?.cues[0];
    expect(cue).toMatchObject({ text: 'Door slam', atSec: 4, atDeclared: true, forSec: 2 });
  });

  it('keeps a bracket inside the words as words', () => {
    const line = parseEpisode('## A\nHOST: The [redacted] file is here. [0:05]').segments[0]?.lines[0];
    expect(line).toMatchObject({ text: 'The [redacted] file is here.', durationSec: 5, declared: true });
  });

  it('stops at a second duration on a line, and names the stop bracket and the timing before it that was not applied', () => {
    const episode = parseEpisode('## A\nSFX: Door slam [at 0:04] [2s] [3s]');
    const cue = episode.segments[0]?.cues[0];
    expect(cue).toMatchObject({ text: 'Door slam [at 0:04] [2s]', forSec: 3, atDeclared: false });
    expect(episode.notices.map((n) => n.message)).toEqual([
      'the duration [2s] is a second duration on this line, so it stays in the text',
      'the offset [at 0:04] was not applied because reading stopped at the second duration [2s]',
    ]);
    expect(episode.notices.every((n) => n.line === 2)).toBe(true);
  });

  it('stops at a second duration on a speech line', () => {
    const episode = parseEpisode('## A\nHOST: Hi [0:05] [0:06]');
    expect(episode.segments[0]?.lines[0]).toMatchObject({ text: 'Hi [0:05]', durationSec: 6, declared: true });
    expect(episode.notices.map((n) => n.kind)).toEqual(['bracket-misplaced']);
  });

  it('stops at a second offset on a cue', () => {
    const episode = parseEpisode('## A\nSFX: Bang [at 1s] [at 2s]');
    expect(episode.segments[0]?.cues[0]).toMatchObject({ text: 'Bang [at 1s]', atSec: 2 });
    expect(episode.notices.map((n) => n.kind)).toEqual(['bracket-misplaced']);
  });

  it('stops at an offset on a speech line and names the duration before it', () => {
    const episode = parseEpisode('## A\nHOST: Hi [0:05] [at 1s]');
    expect(episode.segments[0]?.lines[0]).toMatchObject({ text: 'Hi [0:05] [at 1s]', declared: false });
    expect(episode.notices.map((n) => n.message)).toEqual([
      'the offset [at 1s] is on a speech line, and only a cue takes an offset, so it stays in the text',
      'the duration [0:05] was not applied because reading stopped at the offset [at 1s] on a speech line',
    ]);
  });

  it('stops at an unparseable bracket and names the timing before it', () => {
    const episode = parseEpisode('## A\nHOST: Hi [0:05] [1:75]');
    expect(episode.notices.map((n) => n.kind)).toEqual(['bracket-unparsed', 'bracket-not-applied']);
    expect(episode.notices[1]?.message).toBe(
      'the duration [0:05] was not applied because reading stopped at the bracket [1:75], which is not a timing',
    );
  });

  it('stops quietly at a bracket of words, and names it only when it kept a timing from applying', () => {
    expect(parseEpisode('## A\nHOST: Hi [laughs]').notices).toEqual([]);
    const episode = parseEpisode('## A\nHOST: Hi [0:05] [laughs]');
    expect(episode.notices.map((n) => n.kind)).toEqual(['bracket-misplaced', 'bracket-not-applied']);
  });

  it('names the timing before an unclosed bracket', () => {
    const read = readTiming('Hi [0:05] [0:15', 'line');
    expect(read.notices.map((n) => n.kind)).toEqual(['bracket-unclosed', 'bracket-not-applied']);
    expect(read.durationSec).toBeUndefined();
  });

  it('reads brackets before the id tag, which sits after them', () => {
    const line = parseEpisode('## A\nHOST: Hi there. [0:03] <!-- lineId: sl_0K3M9T2Q7X -->').segments[0]?.lines[0];
    expect(line).toMatchObject({ text: 'Hi there.', durationSec: 3, declared: true, id: 'sl_0K3M9T2Q7X' });
  });
});

describe('a line without a declared duration is estimated from the speech rate', () => {
  it('has the two presets: 150 wpm narration and 170 wpm broadcast, narration when nothing is set', () => {
    expect(SPEECH_RATE_PRESETS).toEqual({ narration: 150, broadcast: 170 });
    expect(speechRateOf()).toBe(150);
    expect(speechRateOf({ ratePreset: 'broadcast' })).toBe(170);
    expect(speechRateOf({ ratePreset: 'broadcast', speechRateWpm: 200 })).toBe(200);
  });

  it('estimates words over the rate, counting only the words (not the label, modifiers, brackets or tag)', () => {
    const words = Array.from({ length: 30 }, () => 'word').join(' ');
    const narration = parseEpisode(`## A\nHOST: ${words} (OFF) <!-- lineId: sl_0K3M9T2Q7X -->`).segments[0]?.lines[0];
    expect(narration).toMatchObject({ words: 30, durationSec: 12, declared: false });
    const broadcast = parseEpisode(`## A\nHOST: ${words}`, { show: { ratePreset: 'broadcast' } }).segments[0]?.lines[0];
    expect(broadcast?.durationSec).toBe(10.59);
  });

  it('counts unspaced scripts with the word-count rule', () => {
    // 我们 / 今天 / 开始 — Intl.Segmenter splits the run into words, as countBody does.
    const line = parseEpisode('## A\n王芳: 我们今天开始').segments[0]?.lines[0];
    expect(line?.words).toBeGreaterThan(1);
    expect(line?.declared).toBe(false);
  });

  it('lets a declared duration win over the estimate', () => {
    const line = parseEpisode('## A\nHOST: A great many words here, far more than one second. [1s]').segments[0]?.lines[0];
    expect(line).toMatchObject({ durationSec: 1, declared: true });
  });
});
