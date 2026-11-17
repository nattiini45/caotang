/**
 * The timed-text reader (issue #287): SRT and WebVTT fixtures, the speakers each format names, and every loss counted.
 * The fixtures are synthetic and hold the shapes the tools write: SRT's comma milliseconds and wrapped lines, WebVTT's voice
 * spans, NOTE, STYLE and REGION blocks and cue settings, Descript's `Name:` labels and Whisper's unlabelled SRT.
 */

import { describe, expect, it } from 'vitest';

import { MAX_CUES, parseCaptions, type CaptionsLossKind, type CaptionsRead } from '../src/cues.js';

function read(text: string): CaptionsRead {
  const result = parseCaptions(text);
  if (!result.ok) throw new Error(`refused: ${result.error.code}`);
  return result.value;
}

function lossOf(value: CaptionsRead, kind: CaptionsLossKind): number {
  return value.losses.find((loss) => loss.kind === kind)?.count ?? 0;
}

const SRT = ['1', '00:00:01,000 --> 00:00:04,500', 'Hello there,', 'this is a wrapped caption.', '', '2', '00:00:05,000 --> 00:00:07,000', '- Ada: Second cue.', ''].join('\n');

const VTT = [
  'WEBVTT - The Lighthouse Keeper',
  '',
  'STYLE',
  '::cue { color: white }',
  '',
  'REGION',
  'id:r1 width:40%',
  '',
  'NOTE Editor: check the spelling',
  '',
  'intro',
  '00:00:01.000 --> 00:00:04.500 align:start position:0%',
  '<v Ada>Hello &amp; welcome</v>',
  '',
  '00:00:05.000 --> 00:00:07.000',
  '<v Bob>Second <b>cue</b><00:00:06.000> here.',
  '',
  'NOTE a trailing thought',
  '',
].join('\n');

describe('SRT', () => {
  it('reads the comma milliseconds, joins a wrapped cue and takes the dash speaker prefix', () => {
    const value = read(SRT);
    expect(value.format).toBe('srt');
    expect(value.cues).toEqual([
      { startSec: 1, endSec: 4.5, text: 'Hello there, this is a wrapped caption.', id: '1' },
      { startSec: 5, endSec: 7, text: 'Second cue.', speaker: 'Ada', id: '2' },
    ]);
  });

  it('does not count the format’s own index as something the writer loses', () => {
    expect(lossOf(read(SRT), 'cue-id')).toBe(0);
  });

  it('reads a Descript speaker label with no dash, and leaves a Whisper cue without one', () => {
    const value = read(['1', '00:00:00,000 --> 00:00:02,000', 'Ada Lovelace: We lit the lamp.', '', '2', '00:00:02,000 --> 00:00:04,000', 'And then we waited.', ''].join('\n'));
    expect(value.cues[0]).toMatchObject({ speaker: 'Ada Lovelace', text: 'We lit the lamp.' });
    expect(value.cues[1]?.speaker).toBeUndefined();
  });

  it('reads hours, and a file without indices', () => {
    const value = read(['01:02:03,250 --> 01:02:05,000', 'Late in the episode.', ''].join('\n'));
    expect(value.cues[0]).toMatchObject({ startSec: 3723.25, endSec: 3725 });
  });

  it('reads a period separator as the tolerant case it is, and says so once', () => {
    const value = read(['1', '00:00:01.000 --> 00:00:02.000', 'One.', '', '2', '00:00:02.000 --> 00:00:03.000', 'Two.', ''].join('\n'));
    expect(value.cues.length).toBe(2);
    expect(lossOf(value, 'srt-period')).toBe(1);
  });

  it('counts SRT cue coordinates apart from other settings', () => {
    const value = read(['1', '00:00:01,000 --> 00:00:02,000 X1:100 X2:200 Y1:50 Y2:100', 'Positioned.', ''].join('\n'));
    expect(lossOf(value, 'coordinates')).toBe(1);
    expect(lossOf(value, 'cue-settings')).toBe(0);
  });

  it('never reads a timecode as a speaker: the label must start with a letter', () => {
    const value = read(['1', '00:00:01,000 --> 00:00:02,000', '00:01 something happened', ''].join('\n'));
    expect(value.cues[0]?.speaker).toBeUndefined();
    expect(value.cues[0]?.text).toBe('00:01 something happened');
  });

  it('keeps a URL whole rather than reading its scheme as a speaker', () => {
    const value = read(['1', '00:00:01,000 --> 00:00:02,000', 'See https://example.com/a', ''].join('\n'));
    expect(value.cues[0]?.text).toBe('See https://example.com/a');
    expect(value.cues[0]?.speaker).toBeUndefined();
  });
});

describe('WebVTT', () => {
  it('reads the header title, the voice spans, the entities and the NOTE blocks in their places', () => {
    const value = read(VTT);
    expect(value.format).toBe('vtt');
    expect(value.title).toBe('The Lighthouse Keeper');
    expect(value.cues).toEqual([
      { startSec: 1, endSec: 4.5, text: 'Hello & welcome', speaker: 'Ada', id: 'intro' },
      { startSec: 5, endSec: 7, text: 'Second cue here.', speaker: 'Bob' },
    ]);
    expect(value.notes).toEqual([
      { beforeCue: 0, text: 'Editor: check the spelling' },
      { beforeCue: 2, text: 'a trailing thought' },
    ]);
  });

  it('counts the styling, the inline timestamp, the settings, the identifier and the two blocks it drops', () => {
    const value = read(VTT);
    expect(lossOf(value, 'styling')).toBe(1);
    expect(lossOf(value, 'inline-timestamp')).toBe(1);
    expect(lossOf(value, 'cue-settings')).toBe(1);
    expect(lossOf(value, 'cue-id')).toBe(1);
    expect(lossOf(value, 'style-block')).toBe(1);
    expect(lossOf(value, 'region-block')).toBe(1);
  });

  it('reads a voice span with classes, and names a cue that carries two speakers', () => {
    const value = read(['WEBVTT', '', '00:00.000 --> 00:02.000', '<v.loud Ada>One</v> <v Bob>Two</v>', ''].join('\n'));
    expect(value.cues[0]).toMatchObject({ speaker: 'Ada', text: 'One Two' });
    expect(value.losses.find((loss) => loss.kind === 'two-speakers')?.sample).toBe('Ada / Bob');
  });

  it('reads minutes-only timestamps and a header with no title', () => {
    const value = read(['WEBVTT', '', '00:01.500 --> 00:03.000', 'Words.', ''].join('\n'));
    expect(value.title).toBeUndefined();
    expect(value.cues[0]).toMatchObject({ startSec: 1.5, endSec: 3 });
  });

  it('keeps a NOTE that holds a colon as a note, never as a cue', () => {
    const value = read(['WEBVTT', '', 'NOTE Host: this is not speech', '', '00:00.000 --> 00:01.000', 'Words.', ''].join('\n'));
    expect(value.cues.length).toBe(1);
    expect(value.notes).toEqual([{ beforeCue: 0, text: 'Host: this is not speech' }]);
  });

  it('unescapes the five entities WebVTT defines and keeps a no-break space as a space', () => {
    const value = read(['WEBVTT', '', '00:00.000 --> 00:01.000', '&lt;tag&gt; &amp; more&nbsp;words', ''].join('\n'));
    expect(value.cues[0]?.text).toBe('<tag> & more words');
  });
});

describe('what the reader refuses and what it counts', () => {
  it('refuses a file with no timing line at all', () => {
    const result = parseCaptions('Just some words.\n\nAnd more.\n');
    expect(result).toEqual({ ok: false, error: { code: 'no-cues', message: 'No timed cue was found in the file.' } });
  });

  it('refuses a file past the cue cap rather than building an unbounded episode', () => {
    const many = Array.from({ length: MAX_CUES + 2 }, (_unused, index) => `${index + 1}\n00:00:01,000 --> 00:00:02,000\nWords.\n`).join('\n');
    const result = parseCaptions(many);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('too-many-cues');
  });

  it('drops a cue whose timing does not parse, and names it', () => {
    const value = read(['1', '00:00:99,000 --> 00:00:02,000', 'Bad.', '', '2', '00:00:01,000 --> 00:00:02,000', 'Good.', ''].join('\n'));
    expect(value.cues.length).toBe(1);
    expect(value.losses.find((loss) => loss.kind === 'bad-timing')?.sample).toContain('00:00:99,000');
  });

  it('counts an empty cue, a zero-length cue, an overlap and a cue out of order, and keeps them all', () => {
    const value = read([
      '1', '00:00:05,000 --> 00:00:06,000', 'Later first.', '',
      '2', '00:00:01,000 --> 00:00:07,000', 'Earlier second.', '',
      '3', '00:00:02,000 --> 00:00:02,000', 'No time at all.', '',
      '4', '00:00:08,000 --> 00:00:09,000', '', '',
    ].join('\n'));
    expect(value.cues.length).toBe(3);
    expect(lossOf(value, 'out-of-order')).toBe(1);
    // The second cue starts before the first ends, and the third starts before the second ends: two overlaps, both kept.
    expect(lossOf(value, 'overlap')).toBe(2);
    expect(lossOf(value, 'short-cue')).toBe(1);
    expect(lossOf(value, 'empty-cue')).toBe(1);
  });

  it('counts text that belongs to no cue instead of dropping it quietly', () => {
    const value = read(['WEBVTT', '', 'loose words with no timing', '', '00:00.000 --> 00:01.000', 'Words.', ''].join('\n'));
    expect(lossOf(value, 'stray-text')).toBe(1);
    expect(value.losses.find((loss) => loss.kind === 'stray-text')?.sample).toBe('loose words with no timing');
  });

  it('reads CRLF line endings, which every Windows caption tool writes', () => {
    const value = read(SRT.replace(/\n/g, '\r\n'));
    expect(value.cues.length).toBe(2);
    expect(value.cues[1]?.speaker).toBe('Ada');
  });
});
