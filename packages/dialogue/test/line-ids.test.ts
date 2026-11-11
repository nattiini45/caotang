import { Story } from 'inkjs';
import { describe, expect, it } from 'vitest';

import { compileInk, ensureLineIds, LINE_ID_PATTERN, lineIdsOf, missingLineIds, mintLineId, parseInk, stripLineIdTags } from '../src/index.js';
import { TAVERN, TAVERN_TAGGED } from './fixtures.js';

/** A deterministic byte source: the same seed gives the same ids, every run (§6, eval-stable minting). */
function seeded(seed: number): (n: number) => Uint8Array {
  let x = seed >>> 0;
  return (n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      out[i] = (x >>> 24) & 0xff;
    }
    return out;
  };
}

/** Everything the runtime prints when the body is played through, choosing the first choice each time. */
function playthrough(body: string): string[] {
  const compiled = compileInk(body);
  if (compiled.json === null) throw new Error('the body does not compile');
  const story = new Story(compiled.json);
  const out: string[] = [];
  for (let guard = 0; guard < 50; guard += 1) {
    while (story.canContinue) out.push(story.Continue() ?? '');
    if (story.currentChoices.length === 0) break;
    story.ChooseChoiceIndex(0);
  }
  return out;
}

describe('the line id shape', () => {
  it('mints l_ plus ten Crockford characters, and a choice label adds _c', () => {
    const line = mintLineId('line', { randomBytes: seeded(7) });
    const choice = mintLineId('choice', { randomBytes: seeded(7) });
    expect(line).toMatch(LINE_ID_PATTERN);
    expect(choice).toMatch(LINE_ID_PATTERN);
    expect(choice).toBe(`${line}_c`);
  });

  it('never draws the letters Crockford leaves out: I, L, O, U', () => {
    const drawn = mintLineId('line', { randomBytes: (n) => new Uint8Array(n).map((_, i) => i * 37) });
    expect(drawn).not.toMatch(/[ILOU]/);
  });

  it('re-rolls past a taken or retired candidate, so an id is never reused', () => {
    const first = mintLineId('line', { randomBytes: seeded(42) });
    const next = mintLineId('line', { randomBytes: seeded(42), retired: new Set([first]) });
    expect(next).not.toBe(first);
    expect(next).toMatch(LINE_ID_PATTERN);
  });

  it('gives up with an error when the random source repeats', () => {
    expect(() => mintLineId('line', { randomBytes: () => new Uint8Array(10).fill(3), taken: new Set(['l_3333333333']) })).toThrow(/could not mint/);
  });
});

describe('ensureLineIds', () => {
  it('gives every spoken line and choice label an id, and the result still compiles', () => {
    const result = ensureLineIds(TAVERN, { randomBytes: seeded(1) });
    expect(result.unplaceable).toEqual([]);
    expect(result.minted).toHaveLength(10);
    expect(missingLineIds(result.body)).toEqual([]);
    expect(compileInk(result.body).ok).toBe(true);
  });

  it('writes the tag where §2.2 places it: inside a bracket, or at the end of a plain line', () => {
    const body = ensureLineIds(TAVERN, { randomBytes: seeded(2) }).body;
    expect(body).toMatch(/\* \[Order an ale # lineId: l_[0-9A-Z]{10}_c\] -> ale/);
    expect(body).toMatch(/The innkeeper looks up\. # lineId: l_[0-9A-Z]{10}\n/);
    expect(body).toMatch(/You slip out the door\. # lineId: l_[0-9A-Z]{10}\n/);
  });

  it('is deterministic for a seed: the same body and the same seed give the same output', () => {
    const one = ensureLineIds(TAVERN, { randomBytes: seeded(9) }).body;
    const two = ensureLineIds(TAVERN, { randomBytes: seeded(9) }).body;
    expect(one).toBe(two);
  });

  it('does nothing on a body that already has every id: idempotent', () => {
    const first = ensureLineIds(TAVERN, { randomBytes: seeded(3) }).body;
    const second = ensureLineIds(first, { randomBytes: seeded(4) });
    expect(second.minted).toEqual([]);
    expect(second.body).toBe(first);
  });

  it('leaves the existing ids of a tagged body untouched', () => {
    const result = ensureLineIds(TAVERN_TAGGED, { randomBytes: seeded(5) });
    expect(result.minted).toEqual([]);
    expect(result.body).toBe(TAVERN_TAGGED);
    expect(lineIdsOf(TAVERN_TAGGED).map((l) => l.lineId)).toContain('l_0000000006');
  });

  it('keeps an id stable across an edit of the line text, because the id lives in the text', () => {
    const tagged = ensureLineIds(TAVERN, { randomBytes: seeded(6) }).body;
    const before = parseInk(tagged).lines.find((l) => l.text.startsWith('The innkeeper'))?.lineId;
    const edited = tagged.replace('The innkeeper looks up.', 'The innkeeper glances up, slowly.');
    const after = parseInk(edited).lines.find((l) => l.text.startsWith('The innkeeper'))?.lineId;
    expect(before).toBeDefined();
    expect(after).toBe(before);
  });

  it('places a line that has a divert under a tag-only line, and the runtime prints exactly what it printed before', () => {
    const body = '-> s\n=== s ===\nHello there. -> t\n=== t ===\nBye.\n-> END\n';
    const result = ensureLineIds(body, { randomBytes: seeded(8) });
    expect(result.minted).toHaveLength(2);
    expect(parseInk(result.body).lines.find((l) => l.text === 'Hello there.')?.tagAbove).toBe(true);
    expect(compileInk(result.body).ok).toBe(true);
    expect(playthrough(result.body)).toEqual(playthrough(body));
  });

  it('places a bracketed choice tag inside the brackets, and the choice text and output stay as they were', () => {
    const body = '-> s\n=== s ===\n* [Yes]\n  Good, then.\n  -> t\n=== t ===\nBye.\n-> END\n';
    const result = ensureLineIds(body, { randomBytes: seeded(13) });
    expect(compileInk(result.body).ok).toBe(true);
    expect(playthrough(result.body)).toEqual(playthrough(body));
  });

  it('refuses to place an id on a choice tail with a divert, and says why', () => {
    const body = '-> s\n=== s ===\n* [Yes] Oh yes. -> t\n=== t ===\nBye.\n-> END\n';
    const result = ensureLineIds(body, { randomBytes: seeded(10) });
    expect(result.unplaceable.map((u) => [u.text, u.line])).toEqual([['Oh yes.', 3]]);
    expect(result.unplaceable[0]?.reason).toMatch(/divert/);
    expect(missingLineIds(result.body).map((l) => l.text)).toEqual(['Oh yes.']);
  });

  it('never overwrites a malformed tag, and never mints beside one', () => {
    const body = '-> s\n=== s ===\nHi. # lineId: l_OOPS\n-> END\n';
    const result = ensureLineIds(body, { randomBytes: seeded(11) });
    expect(result.minted).toEqual([]);
    expect(result.body).toBe(body);
  });

  it('keeps an id when words follow it in the tag comment, and never mints beside it (#325)', () => {
    const body = '-> s\n=== s ===\nHi. # lineId: l_0000000001 and more\n-> END\n';
    expect(parseInk(body).lines.find((l) => l.text.startsWith('Hi.'))?.lineId).toBe('l_0000000001');
    const result = ensureLineIds(body, { randomBytes: seeded(31) });
    expect(result.minted).toEqual([]);
    expect(result.body).toBe(body);
  });

  it('avoids the ids a caller says are taken elsewhere in the project', () => {
    const first = ensureLineIds(TAVERN, { randomBytes: seeded(12) });
    const taken = new Set(first.minted.map((m) => m.lineId));
    const second = ensureLineIds(TAVERN, { randomBytes: seeded(12), taken });
    expect(second.minted).toHaveLength(10);
    expect(second.minted.filter((m) => taken.has(m.lineId))).toEqual([]);
  });
});

describe('stripLineIdTags', () => {
  it('removes every lineId tag, valid or malformed, and leaves the text and the other tags as they were', () => {
    const draft = 'Hi. # lineId: l_0000000001\n  # lineId: l_OOPS\n* [Yes # lineId: l_0000000002_c] -> END\nBye. # mood: warm # lineId: l_0000000003\n';
    const result = stripLineIdTags(draft);
    expect(result.removed).toBe(4);
    expect(result.ink).toBe('Hi.\n\n* [Yes] -> END\nBye. # mood: warm\n');
    expect(result.ink).not.toMatch(/lineId/);
  });

  it('returns the text unchanged, and removes nothing, when the draft carries no tag', () => {
    const draft = '=== reply ===\nThanks for the drink. # mood: warm\n-> END\n';
    expect(stripLineIdTags(draft)).toEqual({ ink: draft, removed: 0 });
  });

  it('mints a fresh id for each line of a stripped draft, and the result still compiles', () => {
    const stripped = stripLineIdTags('=== reply ===\nThanks. # lineId: l_0000000001\n-> END\n');
    const result = ensureLineIds(stripped.ink, { randomBytes: seeded(21) });
    expect(missingLineIds(result.body)).toEqual([]);
    expect(lineIdsOf(result.body).map((l) => l.lineId)).not.toContain('l_0000000001');
    expect(compileInk(result.body).ok).toBe(true);
  });
});
