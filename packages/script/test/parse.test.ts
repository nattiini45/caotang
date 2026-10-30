/**
 * The episode parser (av-script.md §3): segments, the classification order, cues, modifiers, the speaker rule and the
 * notices. One fixture per markup rule; the timing brackets have their own file (timing.test.ts).
 */

import type { CodexEntry } from '@caotang/store';
import { describe, expect, it } from 'vitest';

import { parseEpisode } from '../src/index.js';

/** The spec's own example (§3), with the minted tag on the narration line. */
const EXAMPLE = [
  '# Episode 12 — The Long Way Round',
  '',
  '## Cold open',
  '',
  'MUSIC: Theme, in and under [0:12]',
  'NARRATION: Previously, on the show. [0:08] <!-- lineId: sl_0K3M9T2Q7X -->',
  '',
  '## Segment 1 — The interview',
  '',
  'HOST_A: Welcome back. (over the theme) [0:15]',
  'SFX: Door slam [at 0:04]',
  'HOST_B: Did we record that?',
  'AD: Midroll, reads live [0:30]',
  '',
  '## Outro',
  '',
  'HOST_A: See you next week.',
  'MUSIC: Theme out, fade under',
].join('\n');

function character(id: string, name: string, aliases: string[] = []): CodexEntry {
  return {
    id,
    name,
    aliases,
    type: 'character',
    description: '',
    includePolicy: 'auto',
    caseSensitive: false,
    exclude: [],
    attachments: [],
    keywords: [],
    origin: 'user',
    sources: [],
  } as unknown as CodexEntry;
}

describe('an episode parses to segments, lines and cues', () => {
  it('reads the spec example: the title, three segments, their lines and cues', () => {
    const episode = parseEpisode(EXAMPLE);
    expect(episode.title).toBe('Episode 12 — The Long Way Round');
    expect(episode.segments.map((s) => [s.id, s.title])).toEqual([
      ['segment-1', 'Cold open'],
      ['segment-2', 'Segment 1 — The interview'],
      ['segment-3', 'Outro'],
    ]);
    const [cold, interview, outro] = episode.segments;
    expect(cold?.cues.map((c) => [c.kind, c.text, c.forSec, c.under])).toEqual([['music', 'Theme, in and under', 12, true]]);
    expect(cold?.lines.map((l) => [l.kind, l.text, l.durationSec, l.declared, l.id, l.minted])).toEqual([
      ['narration', 'Previously, on the show.', 8, true, 'sl_0K3M9T2Q7X', true],
    ]);
    expect(interview?.lines.map((l) => [l.kind, l.speaker, l.text])).toEqual([
      ['speech', 'HOST_A', 'Welcome back.'],
      ['speech', 'HOST_B', 'Did we record that?'],
    ]);
    expect(interview?.cues.map((c) => [c.kind, c.atSec, c.atDeclared, c.forSec])).toEqual([
      ['sfx', 4, true, undefined],
      // After HOST_A's declared 15 s and HOST_B's four words, estimated at 150 wpm as 1.6 s.
      ['ad', 16.6, false, 30],
    ]);
    expect(outro?.cues[0]?.under).toBe(true);
    expect(episode.notices).toEqual([]);
  });

  it('keeps a parenthetical as a modifier and out of the words', () => {
    const line = parseEpisode(EXAMPLE).segments[1]?.lines[0];
    expect(line?.modifiers).toEqual(['over the theme']);
    expect(line?.text).toBe('Welcome back.');
    expect(line?.words).toBe(2);
  });

  it('sets a cue as a bed from an (under) modifier as well as from text that ends in "under"', () => {
    const cues = parseEpisode('## A\n\nMUSIC: Theme (under)\nSFX: Footsteps under the bridge\nAMBIENCE: Rain, fade under.').segments[0]?.cues;
    expect(cues?.map((c) => c.under)).toEqual([true, false, true]);
  });

  it('puts lines before the first heading in segment-0, and a later # heading is text', () => {
    const episode = parseEpisode('# Title\nHOST: Hello there.\n## One\n# Not a title\n### A sub-heading');
    expect(episode.title).toBe('Title');
    expect(episode.segments.map((s) => s.id)).toEqual(['segment-0', 'segment-1']);
    expect(episode.segments[1]?.lines.map((l) => [l.kind, l.text])).toEqual([
      ['text', '# Not a title'],
      ['text', '### A sub-heading'],
    ]);
  });

  it('reads an empty ## heading as a segment with an empty title, and CRLF line endings as LF', () => {
    const episode = parseEpisode('##\r\nHOST: One two.\r\n## Two\r\n');
    expect(episode.segments.map((s) => [s.title, s.lines.length])).toEqual([
      ['', 1],
      ['Two', 0],
    ]);
    expect(episode.segments[0]?.lines[0]?.text).toBe('One two.');
  });
});

describe('the classification order: cue, then narration, then speech, then text', () => {
  it('reads MUSIC:, Music: and music: as the same cue', () => {
    const cues = parseEpisode('## A\nMUSIC: one\nMusic: two\nmusic: three').segments[0]?.cues;
    expect(cues?.map((c) => [c.kind, c.label])).toEqual([
      ['music', 'MUSIC'],
      ['music', 'Music'],
      ['music', 'music'],
    ]);
  });

  it('checks the vocabulary before the speaker rule, so SFX: is never a speaker even when the codex has one', () => {
    const episode = parseEpisode('## A\nSFX: Bang', { codex: [character('c_SFX0000001', 'SFX')] });
    expect(episode.segments[0]?.cues).toHaveLength(1);
    expect(episode.segments[0]?.lines).toHaveLength(0);
  });

  it("uses the show's own cue vocabulary, keeping its label's spelling as the cue kind", () => {
    const episode = parseEpisode('## A\nbed: Strings\nO.C.: The crowd\nMUSIC: not a cue here', { show: { cueVocabulary: ['BED', 'O.C.'] } });
    const segment = episode.segments[0];
    expect(segment?.cues.map((c) => [c.kind, c.label])).toEqual([
      ['BED', 'bed'],
      ['O.C.', 'O.C.'],
    ]);
    expect(segment?.lines.map((l) => [l.kind, l.label])).toEqual([['speech', 'MUSIC']]);
  });

  it('reads NARRATION in any case as narration, spoken by the show default speaker', () => {
    const lines = parseEpisode('## A\nnarration: Once.\nNarration: Twice.', { show: { defaultSpeaker: 'c_HOST000001' } }).segments[0]?.lines;
    expect(lines?.map((l) => [l.kind, l.speaker])).toEqual([
      ['narration', 'c_HOST000001'],
      ['narration', 'c_HOST000001'],
    ]);
    expect(parseEpisode('## A\nNARRATION: Once.').segments[0]?.lines[0]?.speaker).toBeUndefined();
  });

  it('reads a name-shaped label as speech: letters in any script, digits, spaces, _, -, . and \'', () => {
    const labels = ["Dr. O'Neil", 'HOST_A', 'Guest-2', '王芳', 'Anna Maria'];
    const lines = parseEpisode(`## A\n${labels.map((l) => `${l}: Hi.`).join('\n')}`).segments[0]?.lines;
    expect(lines?.map((l) => [l.kind, l.speaker])).toEqual(labels.map((l) => ['speech', l]));
  });

  it('reads anything else as text, never dropped: no colon, a label not shaped like a name, a colon with no space after it', () => {
    const body = ['## A', 'Just a sentence.', '2nd act: begins', 'A label longer than forty characters in all: x', 'At 10:30 we start', 'See https://example.com'].join('\n');
    const lines = parseEpisode(body).segments[0]?.lines;
    expect(lines?.map((l) => [l.kind, l.text])).toEqual([
      ['text', 'Just a sentence.'],
      ['text', '2nd act: begins'],
      ['text', 'A label longer than forty characters in all: x'],
      ['text', 'At 10:30 we start'],
      ['text', 'See https://example.com'],
    ]);
    expect(lines?.every((l) => l.durationSec === undefined)).toBe(true);
  });

  it('reads a label with nothing after it as an empty, untimed speech line', () => {
    const line = parseEpisode('## A\nHOST:').segments[0]?.lines[0];
    expect(line).toMatchObject({ kind: 'speech', speaker: 'HOST', text: '', words: 0, declared: false });
    expect(line?.durationSec).toBeUndefined();
  });
});

describe('speakers resolve against the codex', () => {
  const codex = [character('c_ELENA00001', 'Elena', ['Host A'])];

  it('resolves a name or alias to the codex id, without case', () => {
    const lines = parseEpisode('## A\nELENA: Hi.\nhost a: Hello.', { codex }).segments[0]?.lines;
    expect(lines?.map((l) => [l.speaker, l.label])).toEqual([
      ['c_ELENA00001', 'ELENA'],
      ['c_ELENA00001', 'host a'],
    ]);
  });

  it('keeps an unknown label as a speech line under the typed name, and reports it with both fixes', () => {
    const episode = parseEpisode('## A\nBED: Low strings', { codex });
    expect(episode.segments[0]?.lines[0]).toMatchObject({ kind: 'speech', speaker: 'BED', text: 'Low strings' });
    expect(episode.notices).toEqual([
      expect.objectContaining({ kind: 'speaker-unknown', line: 2, message: expect.stringMatching(/add BED to the codex, or add it to the show's cue vocabulary/) }),
    ]);
  });

  it('keeps a label two codex characters answer to under the typed name, and names both', () => {
    const twins = [...codex, character('c_ELENA00002', 'Elena Two', ['Host A'])];
    const episode = parseEpisode('## A\nHost A: Hello.', { codex: twins });
    expect(episode.segments[0]?.lines[0]).toMatchObject({ kind: 'speech', speaker: 'Host A', text: 'Hello.' });
    expect(episode.notices).toEqual([
      expect.objectContaining({ kind: 'speaker-ambiguous', line: 2, message: expect.stringMatching(/Host A names more than one character in the codex \(Elena and Elena Two\)/) }),
    ]);
  });

  it('reports no unknown speaker when no codex is given', () => {
    expect(parseEpisode('## A\nBED: Low strings').notices).toEqual([]);
  });
});

describe('a cue offset is declared or derived from the timed lines before it', () => {
  it('derives atSec as the sum of the timed lines before the cue in its segment, 0 when none precede it', () => {
    const cues = parseEpisode('## A\nSFX: first\nHOST: one [5s]\nHOST: two [0:10]\nSFX: later\n## B\nSFX: fresh').segments.flatMap((s) => s.cues);
    expect(cues.map((c) => [c.text, c.atSec, c.atDeclared])).toEqual([
      ['first', 0, false],
      ['later', 15, false],
      ['fresh', 0, false],
    ]);
  });

  it('counts an estimated line toward a later cue offset', () => {
    // Fifteen words at 150 wpm is six seconds.
    const words = Array.from({ length: 15 }, () => 'word').join(' ');
    const cue = parseEpisode(`## A\nHOST: ${words}\nSFX: after`).segments[0]?.cues[0];
    expect(cue?.atSec).toBe(6);
  });
});

describe('long runs of spaces and tabs cost one pass', () => {
  it('parses and mints over lines of 50,000 tabs in well under a second', async () => {
    const { ensureScriptLineIds } = await import('../src/index.js');
    const tabs = '\t'.repeat(50_000);
    const body = [`## A${tabs}x`, `HOST:${tabs}hi${tabs}<!--${tabs}x`, `SFX: [at${tabs}`, `${tabs}:${tabs}`, `HOST: x${tabs}`, `HOST: ${'<!-- lineId:'.repeat(20_000)} -->`].join('\n');
    const started = Date.now();
    const episode = parseEpisode(body);
    ensureScriptLineIds(body);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(episode.segments).toHaveLength(1);
  });
});
