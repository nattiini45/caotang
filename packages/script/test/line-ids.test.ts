/**
 * Line and cue ids (av-script.md §2, §3): minted on save into a trailing tag, surviving an edit of the words, a malformed
 * tag left alone and reported, a duplicate reported with the second line on a session-local id, and an unknown label
 * surviving the round trip.
 */

import { describe, expect, it } from 'vitest';

import { ensureScriptLineIds, isMintedScriptId, mintScriptId, parseEpisode } from '../src/index.js';

/** A random source that counts up, so each mint is different and every run mints the same ids. */
function counter(): (n: number) => Uint8Array {
  let next = 0;
  return (n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) out[i] = next++ % 256;
    return out;
  };
}

describe('minting', () => {
  it('mints sl_ for a line and sc_ for a cue, ten Crockford characters each', () => {
    expect(mintScriptId('line', { randomBytes: counter() })).toBe('sl_0123456789');
    const cue = mintScriptId('cue', { randomBytes: counter() });
    expect(cue).toBe('sc_0123456789');
    expect(isMintedScriptId(cue, 'cue')).toBe(true);
    expect(isMintedScriptId(cue, 'line')).toBe(false);
  });

  it('re-rolls an id already taken or retired', () => {
    const id = mintScriptId('line', { randomBytes: counter(), taken: new Set(['sl_0123456789']), retired: new Set(['sl_ABCDEFGHJK']) });
    // The first draw (0…9) is taken and the second (A…K) retired, so the third draw is the one minted.
    expect(id).toBe('sl_MNPQRSTVWX');
  });

  it('throws when the random source only repeats a taken id', () => {
    const same = (n: number) => new Uint8Array(n);
    expect(() => mintScriptId('line', { randomBytes: same, taken: new Set(['sl_0000000000']) })).toThrow(/repeats/);
  });
});

describe('ensureScriptLineIds: the save step', () => {
  const BODY = ['# Ep', '## Open', 'MUSIC: Theme [0:12]', 'HOST: Hello. [0:03]', 'A plain text line.', 'NARRATION: Once.'].join('\n');

  it('writes a tag after the timing brackets of every cue, speech and narration line, and none on text or headings', () => {
    const result = ensureScriptLineIds(BODY, { randomBytes: counter() });
    const lines = result.body.split('\n');
    expect(lines[0]).toBe('# Ep');
    expect(lines[1]).toBe('## Open');
    expect(lines[2]).toMatch(/^MUSIC: Theme \[0:12\] <!-- lineId: sc_[0-9A-Z]{10} -->$/);
    expect(lines[3]).toMatch(/^HOST: Hello\. \[0:03\] <!-- lineId: sl_[0-9A-Z]{10} -->$/);
    expect(lines[4]).toBe('A plain text line.');
    expect(lines[5]).toMatch(/^NARRATION: Once\. <!-- lineId: sl_[0-9A-Z]{10} -->$/);
    expect(result.minted.map((m) => m.line)).toEqual([3, 4, 6]);
    const parsed = parseEpisode(result.body);
    expect(parsed.segments[0]?.lines.filter((l) => l.kind !== 'text').every((l) => l.minted)).toBe(true);
    expect(parsed.segments[0]?.cues[0]?.minted).toBe(true);
    expect(parsed.segments[0]?.cues[0]?.forSec).toBe(12);
  });

  it('is idempotent: a second save mints nothing and returns the same string', () => {
    const once = ensureScriptLineIds(BODY, { randomBytes: counter() });
    const twice = ensureScriptLineIds(once.body, { randomBytes: counter() });
    expect(twice.minted).toEqual([]);
    expect(twice.body).toBe(once.body);
  });

  it('keeps CRLF line endings', () => {
    const result = ensureScriptLineIds('## A\r\nHOST: Hi.\r\n', { randomBytes: counter() });
    expect(result.body).toMatch(/^## A\r\nHOST: Hi\. <!-- lineId: sl_[0-9A-Z]{10} -->\r\n$/);
  });

  it('reads the show vocabulary, so a custom cue gets an sc_ id', () => {
    const result = ensureScriptLineIds('## A\nBED: Strings', { randomBytes: counter(), vocabulary: ['bed'] });
    expect(result.body).toMatch(/sc_/);
  });
});

describe('a minted id survives an edit of the line\'s words', () => {
  it('keeps the id when the words, the modifiers and the timing change', () => {
    const minted = ensureScriptLineIds('## A\nHOST: Hello there. [0:03]', { randomBytes: counter() });
    const id = parseEpisode(minted.body).segments[0]?.lines[0]?.id;
    expect(id).toMatch(/^sl_/);
    const edited = minted.body.replace('Hello there. [0:03]', 'Hello again, everyone. (warmly) [0:05]');
    const line = parseEpisode(edited).segments[0]?.lines[0];
    expect(line).toMatchObject({ id, minted: true, text: 'Hello again, everyone.', durationSec: 5 });
    expect(ensureScriptLineIds(edited, { randomBytes: counter() }).minted).toEqual([]);
  });

  it('gives a line with no tag a session-local id until the next save', () => {
    const line = parseEpisode('## A\n\nHOST: Hi.').segments[0]?.lines[0];
    expect(line).toMatchObject({ id: '~l3', minted: false });
    const cue = parseEpisode('## A\nSFX: Bang').segments[0]?.cues[0];
    expect(cue).toMatchObject({ id: '~c2', minted: false });
  });
});

describe('a malformed or duplicated tag is reported and never rewritten', () => {
  it('leaves a malformed tag as written, reads the line with a session-local id, and does not mint over it', () => {
    const body = '## A\nHOST: Hi. <!-- lineId: sl_SHORT -->\nSFX: Bang <!-- lineId: sl_0K3M9T2Q7X -->';
    const parsed = parseEpisode(body);
    expect(parsed.segments[0]?.lines[0]).toMatchObject({ id: '~l2', minted: false, text: 'Hi.' });
    // An sl_ id on a cue is the wrong kind: a cue's id starts with sc_.
    expect(parsed.segments[0]?.cues[0]).toMatchObject({ id: '~c3', minted: false });
    expect(parsed.notices.map((n) => [n.kind, n.line])).toEqual([
      ['id-malformed', 2],
      ['id-malformed', 3],
    ]);
    expect(ensureScriptLineIds(body, { randomBytes: counter() })).toEqual({ body, minted: [] });
  });

  it('reports a duplicated id, gives the second line a session-local id, and does not rewrite either', () => {
    const body = '## A\nHOST: One. <!-- lineId: sl_0K3M9T2Q7X -->\nHOST: Two. <!-- lineId: sl_0K3M9T2Q7X -->';
    const parsed = parseEpisode(body);
    expect(parsed.segments[0]?.lines.map((l) => [l.id, l.minted])).toEqual([
      ['sl_0K3M9T2Q7X', true],
      ['~l3', false],
    ]);
    expect(parsed.notices).toEqual([expect.objectContaining({ kind: 'id-duplicate', line: 3 })]);
    expect(ensureScriptLineIds(body, { randomBytes: counter() })).toEqual({ body, minted: [] });
  });
});

describe('an unknown label survives a round trip and is reported', () => {
  it('keeps BED: as a speech line through a save and a parse, with every character of the line', () => {
    const body = '## A\nBED: Low strings, (soft) [0:20]\nHOST: Welcome.';
    const saved = ensureScriptLineIds(body, { randomBytes: counter() });
    expect(saved.body.split('\n')[1]).toMatch(/^BED: Low strings, \(soft\) \[0:20\] <!-- lineId: sl_[0-9A-Z]{10} -->$/);
    const stripped = saved.body.replace(/ <!-- lineId: \S+ -->/g, '');
    expect(stripped).toBe(body);
    const parsed = parseEpisode(saved.body, { codex: [] });
    expect(parsed.segments[0]?.lines[0]).toMatchObject({ kind: 'speech', label: 'BED', speaker: 'BED', durationSec: 20 });
    expect(parsed.notices.filter((n) => n.kind === 'speaker-unknown').map((n) => n.line)).toEqual([2, 3]);
  });
});
