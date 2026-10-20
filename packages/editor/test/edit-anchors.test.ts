/**
 * [edit-anchors.md] §3 — the resolution ladder, one fixture per rung.
 *
 * ## What is being tested, and what would pass anyway
 *
 * The ladder's failure mode is not a refusal; it is a **range that is wrong while
 * reporting success**. `status: 'ok'` says nothing about whether the range it
 * returned addresses the text the plan meant, and a ladder that returned
 * `anchor.from`/`anchor.to` unconditionally would pass every "it resolved" assertion
 * in this file. So every successful resolution here is checked three ways: the
 * **method** it claims, the **range** it names, and — the one that catches a
 * constant-offset bug of the kind the projection map once had — that the body
 * at the returned range is the anchored text, or scores at least §3's floor against
 * it. A resolution that reports a method and moves the cursor nowhere is the failure
 * this row exists to prevent.
 *
 * ## One fixture per rung, deliberately
 *
 * Steps 1, 2 and 4 all resolve by finding `exact` in the body; a fixture built for
 * one of them passes for the others, so a ladder with step 3 deleted would go green
 * here. Each rung's fixture is therefore built to **defeat** the others, and each
 * test asserts the method it must have taken:
 *
 * - rung 1 needs the offsets to still be right, so a body with any drift fails it;
 * - rung 2 needs the text *moved but present*, so a body with unchanged offsets fails it;
 * - rung 3 needs the text **absent** (so 2 and 4 cannot answer) but locatable from
 *   both context sides — which is why it asserts the measured similarity;
 * - rung 4 needs the text **further than ±2000** from where the anchor said, so the
 *   near-offset window misses it.
 *
 * ## The library is only reached on step 3, and that is measured
 *
 * §4 requires `diff-match-patch` to be lazy, and this file asserts it with a
 * **counting locator**: steps 1, 2 and 4 must not call it at all. Every other claim
 * about the fuzzy rung runs against the **real** `preloadAnchorLibraries()`, because
 * a stubbed Bitap would make the rung pass without the library ever working — and
 * the two directions that matter are both present: a locator that returns a *wrong*
 * answer must make the rung refuse (so the result depends on it), and a locator that
 * is the real one must find a pattern the test then locates independently.
 */
import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import {
  anchorLibrariesLoaded,
  bindAnchorLibraries,
  boundAnchorLocator,
  contextMatches,
  editBudget,
  preloadAnchorLibraries,
  resolveAnchor,
  similarity,
  CONTEXT_CHARS,
  CONTEXT_MATCH_FLOOR,
  FUZZY_SIMILARITY_FLOOR,
  LOCATOR_CONFIGURATION,
  MATCH_MAX_BITS,
  MAX_CANDIDATES,
  MAX_EXACT_CHARS,
  NEAR_OFFSET_WINDOW,
  type AnchorResolution,
  type BitapLocator,
  type TextAnchor,
} from '../src/index.js';

const TICK_REVISION = 7;

/**
 * §2's capture, verbatim: `exact` = `body.slice(from, to)`, `prefix`/`suffix` = up to
 * **32** characters either side, `capturedRevision` from the store. Every fixture's
 * anchor is built through this, so no test hand-writes context and one of them
 * accidentally agrees with its own assertion.
 */
const capture = (body: string, needle: string, revision = TICK_REVISION): TextAnchor => {
  const from = body.indexOf(needle);
  if (from === -1) throw new Error(`fixture: "${needle}" is not in the body it was captured from`);
  return {
    from,
    to: from + needle.length,
    exact: needle,
    prefix: body.slice(Math.max(0, from - CONTEXT_CHARS), from),
    suffix: body.slice(from + needle.length, from + needle.length + CONTEXT_CHARS),
    capturedRevision: revision,
  };
};

/** `assertOk` in one place, so a refusal in a test that expects success fails by name. */
const expectOk = (resolution: AnchorResolution) => {
  if (resolution.status !== 'ok') {
    throw new Error(`expected an ok resolution, got unresolvable: ${resolution.reason}`);
  }
  return resolution;
};

const expectUnresolvable = (resolution: AnchorResolution) => {
  if (resolution.status !== 'unresolvable') {
    throw new Error(
      `expected unresolvable, got ${resolution.method} at ${resolution.range.from}-${resolution.range.to}`,
    );
  }
  return resolution;
};

/** Filler that cannot contain any of the fixtures' phrases: one repeated letter. */
const filler = (length: number, char = 'x'): string => char.repeat(length);

const PARAGRAPH_BEFORE = 'The harbour master kept the log by hand, and the wind kept the rest. ';
const PARAGRAPH_AFTER =
  ' She counted the boats twice, because the first count was always the hopeful one.';
const SENTENCE = 'The ferry was late, as always.';

const baseBody = (): string => `${PARAGRAPH_BEFORE}${SENTENCE}${PARAGRAPH_AFTER}`;

/**
 * A locator that records every call, and that reaches **no further than the real one
 * is configured to** — ±{@link NEAR_OFFSET_WINDOW} around the expected position.
 *
 * That fidelity is load-bearing rather than decorative: a locator that searched the
 * whole body would find the context for a text that has moved 3000 characters, and
 * so would answer step 3 where the real library answers step 4 — which would make
 * the unique-global fixture below pass on the wrong rung, and quietly leave step 4
 * unreached.
 */
const countingLocator = (): { locator: BitapLocator; calls: () => number } => {
  let calls = 0;
  const locator: BitapLocator = (text, pattern, loc) => {
    calls += 1;
    const at = text.indexOf(pattern, Math.max(0, loc - NEAR_OFFSET_WINDOW));
    if (at === -1) return -1;
    return Math.abs(at - loc) <= NEAR_OFFSET_WINDOW ? at : -1;
  };
  return { locator, calls: () => calls };
};

afterEach(() => {
  // The locator is module-level state, so a test that binds one must release it: a
  // leaked locator would make a later "the library is never touched" assertion pass
  // for the wrong reason, and would make `preloadAnchorLibraries()` hand back the
  // stub instead of loading the real Bitap.
  bindAnchorLibraries();
});

describe('edit-anchors §3 — the ladder, one fixture per rung', () => {
  it('step 1 — exact: the offsets still address the anchored text, and only step 1 can say so', () => {
    const body = baseBody();
    const anchor = capture(body, SENTENCE);
    const spy = countingLocator();
    bindAnchorLibraries(spy.locator);

    const resolution = expectOk(resolveAnchor(anchor, body, TICK_REVISION));

    expect(resolution.method).toBe('exact');
    expect(resolution.range).toEqual({ from: anchor.from, to: anchor.to });
    expect(body.slice(resolution.range.from, resolution.range.to)).toBe(anchor.exact);
    expect(resolution.revisionDrift).toBe(0);
    // §4's lazy boundary: the library was never needed for this answer.
    expect(spy.calls()).toBe(0);
  });

  it('step 2 — near-offset: the text moved but is still in the window, and its context still matches', () => {
    const original = baseBody();
    const anchor = capture(original, SENTENCE);
    const inserted = 'A gull settled on the rail and watched them do nothing at all. ';
    const body = `${inserted}${original}`;

    const spy = countingLocator();
    bindAnchorLibraries(spy.locator);
    const resolution = expectOk(resolveAnchor(anchor, body, TICK_REVISION + 2));

    expect(resolution.method).toBe('near-offset');
    expect(resolution.range).toEqual({ from: anchor.from + inserted.length, to: anchor.to + inserted.length });
    // The visible change the row demands: the anchored text is at the returned
    // range, and the offsets the anchor carried no longer address it.
    expect(body.slice(resolution.range.from, resolution.range.to)).toBe(SENTENCE);
    expect(body.slice(anchor.from, anchor.to)).not.toBe(SENTENCE);
    expect(resolution.revisionDrift).toBe(2);
    expect(spy.calls()).toBe(0);
  });

  it('step 3 — context-fuzzy: the anchored text is GONE, so only the context can find it', async () => {
    const original = baseBody();
    const anchor = capture(original, SENTENCE);
    // Two characters of drift, so the text no longer occurs anywhere in the body:
    // steps 2 and 4 both search for `exact` and therefore cannot answer this.
    const drifted = 'The ferry ran late, as always.';
    const body = baseBody().replace(SENTENCE, drifted);
    expect(body).not.toContain(SENTENCE);

    await preloadAnchorLibraries();
    const resolution = expectOk(resolveAnchor(anchor, body, TICK_REVISION + 1));

    expect(resolution.method).toBe('context-fuzzy');
    const between = body.slice(
      resolution.range.from,
      resolution.range.to,
    );
    // §3's floor, measured here rather than assumed: the rung passes because the
    // text between the located context sides is ≥ 0.85 similar to `exact`.
    expect(similarity(between, anchor.exact)).toBeGreaterThanOrEqual(FUZZY_SIMILARITY_FLOOR);
    expect(body.slice(resolution.range.from, resolution.range.to)).toContain(between);
    // And the range visibly moved: it addresses the drifted sentence, not the offsets.
    expect(resolution.range.from).toBe(body.indexOf(drifted));
    expect(resolution.range.to).toBe(body.indexOf(drifted) + drifted.length);
  });

  it('step 4 — unique-global: 3000 characters away, past the ±2000 window, still exactly one hit', async () => {
    const original = baseBody();
    const anchor = capture(original, SENTENCE);
    const gap = filler(3000);
    const body = `${gap}${original}`;
    expect(Math.abs(body.indexOf(SENTENCE) - anchor.from)).toBeGreaterThan(NEAR_OFFSET_WINDOW);

    const spy = countingLocator();
    bindAnchorLibraries(spy.locator);
    const resolution = expectOk(resolveAnchor(anchor, body, TICK_REVISION + 5));

    expect(resolution.method).toBe('unique-global');
    expect(resolution.range).toEqual({ from: anchor.from + gap.length, to: anchor.to + gap.length });
    expect(body.slice(resolution.range.from, resolution.range.to)).toBe(SENTENCE);
    // Step 3 tried first and declined, so the locator was asked at least once — which
    // is what makes "steps 1–2 never touch it" above a statement about rungs 1 and 2
    // rather than about a ladder that skipped the fuzzy rung entirely.
    expect(spy.calls()).toBeGreaterThan(0);
  });

  it('step 5 — unresolvable: two hits, neither with matching context, and ≤ 3 ranked candidates', async () => {
    const original = baseBody();
    const anchor = capture(original, SENTENCE);
    // The anchor's own offsets are stale (text inserted above), so step 1 cannot
    // answer, and the sentence now occurs twice with different surroundings — so
    // step 2 sees two in-window hits, step 3 sees more than one candidate range, and
    // step 4 sees two global hits. Nothing may guess between them.
    const decoy = `Nothing of the sort here. ${SENTENCE} The kettle had gone cold.`;
    const body = `A gull settled on the rail. ${original}\n\n${decoy}`;
    await preloadAnchorLibraries();

    const resolution = expectUnresolvable(resolveAnchor(anchor, body, TICK_REVISION + 1));

    expect(resolution.candidates.length).toBeGreaterThan(0);
    expect(resolution.candidates.length).toBeLessThanOrEqual(MAX_CANDIDATES);
    for (const candidate of resolution.candidates) {
      expect(candidate.similarity).toBeGreaterThan(0);
      expect(candidate.to).toBeGreaterThan(candidate.from);
    }
    // Ranked by similarity, which is §3's "candidates (up to 3, offsets + similarity)".
    const scores = resolution.candidates.map((candidate) => candidate.similarity);
    expect([...scores].sort((left, right) => right - left)).toEqual(scores);
    expect(resolution.reason).toMatch(/appears 2 times/);
    expect(resolution.revisionDrift).toBe(1);
  });

  it('step 5 — unresolvable: one hit whose context does not match, refused by the context check', async () => {
    const original = baseBody();
    const anchor = capture(original, SENTENCE);
    // The same sentence, surrounded by different text: a unique hit the context
    // check must refuse, which is the refusing side of §3's 80% rule.
    const body = `Completely unrelated opening. ${SENTENCE} A different closing thought entirely.`;
    await preloadAnchorLibraries();

    const resolution = expectUnresolvable(resolveAnchor(anchor, body, TICK_REVISION));

    expect(resolution.reason).toMatch(/appears once, but the context around it no longer matches/);
    expect(resolution.candidates).toHaveLength(1);
  });

  it('step 5 — the cap is §3’s "up to 3", and a fixture that reaches it is the only thing that says so', async () => {
    // **Found, and it is the row's own shape.** §3 step 5 says
    // *"candidates (up to 3, offsets + similarity)"*, and the two assertions
    // elsewhere in this file are `> 0` and `<= MAX_CANDIDATES` over a fixture that
    // produces **two** candidates — so **any** cap at or above 2 satisfies both.
    // Measured in both directions before this test existed: `MAX_CANDIDATES = 99`
    // and dropping the `.slice()` in `rankCandidates` both left **all 24 green**.
    //
    // So the fixture has to *reach* the cap, which means enough occurrences of
    // `exact` that the cap is what decides how many come back. Six here, none with
    // context matching the anchor's: step 2 needs exactly one in-window hit and
    // step 4 exactly one global hit, so with six of each both decline and step 5 is
    // the only rung left. **A body with a single occurrence resolves at step 2 and
    // never reaches step 5 at all** — which is how this test's first draft passed
    // in isolation and failed the full suite, since it asserted 6 occurrences over
    // a body that carried 1.
    //
    // One occurrence is **lower-cased**: `findOccurrences` still finds it (it is
    // case-insensitive) but `similarity` scores it well below the rest, so ranking
    // is observable rather than a list of equal numbers, and "no survivor is the
    // case-variant" is a second signal that the cap is a bound and not a name.
    await preloadAnchorLibraries();
    const original = baseBody();
    const anchor = capture(original, SENTENCE);
    const decoy = (label: string, sentence: string): string =>
      `Nothing of the sort here, ${label}. ${sentence} The kettle had gone cold.`;
    const body = [
      decoy('one', SENTENCE),
      decoy('two', SENTENCE.toLowerCase()),
      decoy('three', SENTENCE),
      decoy('four', SENTENCE),
      decoy('five', SENTENCE),
      original,
    ].join('\n\n');

    const resolution = expectUnresolvable(resolveAnchor(anchor, body, TICK_REVISION + 1));

    // Six occurrences exist; §3 allows three through. Counted **case-insensitively**,
    // because that is the population `findOccurrences` actually sees — a
    // case-sensitive count of this same body returns 5 and would assert a fixture
    // that does not exist. `toHaveLength` is the load-bearing half; the earlier
    // `<=` form is satisfied by an unbounded list.
    expect(body.toLowerCase().split(SENTENCE.toLowerCase()).length - 1).toBe(6);
    expect(resolution.candidates).toHaveLength(MAX_CANDIDATES);
    // Still §3's shape: offsets, plus the similarity that ranked them.
    for (const candidate of resolution.candidates) {
      expect(candidate.to).toBeGreaterThan(candidate.from);
      expect(body.slice(candidate.from, candidate.to).toLowerCase()).toBe(
        SENTENCE.toLowerCase(),
      );
    }
    const scores = resolution.candidates.map((candidate) => candidate.similarity);
    expect([...scores].sort((left, right) => right - left)).toEqual(scores);
    // Ranked out, which is what a cap does: the case-variant scores far below the
    // five exact hits, so none of the three survivors may be it.
    expect(scores.every((score) => score === 1)).toBe(true);
  });

  it('§6 fixtures — an empty body, out-of-range offsets and an over-long `exact` all refuse with reasons', async () => {
    await preloadAnchorLibraries();
    const anchor = capture(baseBody(), SENTENCE);

    const empty = expectUnresolvable(resolveAnchor(anchor, '', TICK_REVISION));
    expect(empty.reason).toMatch(/no longer appears anywhere/);
    expect(empty.candidates).toHaveLength(0);

    const beyondEnd = expectUnresolvable(
      resolveAnchor({ ...anchor, from: 9_999, to: 10_050 }, 'a short body', TICK_REVISION),
    );
    expect(beyondEnd.reason).toMatch(/no longer appears anywhere/);

    const overLong = expectUnresolvable(
      resolveAnchor({ ...anchor, exact: 'z'.repeat(MAX_EXACT_CHARS + 1) }, baseBody(), TICK_REVISION),
    );
    expect(overLong.reason).toMatch(new RegExp(`bounds that field at ${MAX_EXACT_CHARS}`));

    const noText = expectUnresolvable(resolveAnchor({ ...anchor, exact: '' }, baseBody(), TICK_REVISION));
    expect(noText.reason).toMatch(/carries no `exact` text/);
  });
});

describe('§3’s context check — 80%, from both sides', () => {
  const base = (): TextAnchor => ({
    from: 10,
    to: 14,
    exact: 'TEXT',
    prefix: '',
    suffix: '',
    capturedRevision: 1,
  });

  it('passes at exactly the floor and refuses just below it', () => {
    const anchor = { ...base(), prefix: 'abcdefghij' };
    const body = 'xx' + 'abcdefghXX' + 'yy';

    // 8 of 10 characters match = exactly 0.8. A check written `>` instead of `>=`
    // would refuse this, and a check that can only refuse would pass every fixture
    // that never lands on the boundary — so both sides are here.
    const matches = [...'abcdefghij'].filter((char, at) => char === body[2 + at]);
    expect(matches).toHaveLength(8);
    expect(contextMatches(anchor, body, { from: 12, to: 16 })).toBe(true);

    // 7 of 10 is one character short of the floor.
    const belowFloor = `xx${'abcdefgXXX'}yy`;
    expect(contextMatches(anchor, belowFloor, { from: 12, to: 16 })).toBe(false);
  });

  it('is case-insensitive, and skips a side that is empty or has nothing to compare', () => {
    const anchor = { ...base(), prefix: 'ABCDEFGHIJ', suffix: 'KLMNOPQRST' };
    expect(
      contextMatches(anchor, 'abcdefghijTEXTklmnopqrst', { from: 10, to: 14 }),
    ).toBe(true);

    // §3: "empty prefix/suffix skipped" — so an anchor at the document edge is
    // judged on the context it does carry.
    const edge = { ...base(), prefix: '', suffix: 'KLMNOPQRST' };
    expect(contextMatches(edge, 'XXXXTEXTklmnopqrst', { from: 4, to: 8 })).toBe(true);
    // And a side whose leading characters ran off the front of the body is judged on
    // the characters that are still there: a 4-character prefix whose first two
    // characters no longer exist, and whose last two do and match.
    const truncated = { ...base(), prefix: 'ZZab', suffix: '' };
    expect(contextMatches(truncated, 'ab', { from: 2, to: 6 })).toBe(true);
  });

  it('counts only the characters available, right-aligned to the range edge', () => {
    // A 32-character prefix, of which the body now offers only the last 17: text
    // above the target was deleted, so the target moved *up*. The characters that
    // still correspond to the anchor are its tail — `prefix[k]` sits at
    // `from - prefix.length + k`, so its last character is the one before the range.
    // Left-aligning the window would compare 'abcdefg…' against 'qrstuvw…' and refuse
    // a context that is intact, and would refuse every anchor a deletion above it
    // has pushed up.
    const anchor = { ...base(), prefix: 'abcdefghijklmnopqrstuvwxyz012345', suffix: 'and the rest' };
    const body = `qrstuvwxyz012345${'TEXT'}${anchor.suffix}`;
    const from = body.indexOf('TEXT');
    expect(from).toBe(16);
    expect(contextMatches(anchor, body, { from, to: from + 4 })).toBe(true);

    // And the floor still bites when the available characters are genuinely wrong:
    // the same length, entirely different text.
    const wrong = `XXXXXXXXXXXXXXXXX${'TEXT'}${anchor.suffix}`;
    expect(contextMatches(anchor, wrong, { from, to: from + 4 })).toBe(false);
  });
});

describe('§4’s lazy boundary — measured, and with a control', () => {
  it('the real preload binds a Bitap that finds a pattern with one edit in it', async () => {
    const locator = await preloadAnchorLibraries();
    expect(anchorLibrariesLoaded()).toBe(true);
    expect(boundAnchorLocator()).toBe(locator);

    // A control on the *mechanism*, not on the ladder: a stub that answered `0`
    // would also satisfy "something is bound".

    const text = `aaaa ${'b'.repeat(20)} cccc`;
    const located = locator(text, `${'b'.repeat(19)}d`, text.indexOf('b'));
    expect(located).toBeGreaterThan(0);
    expect(text.slice(located, located + 20)).toHaveLength(20);
    // The ceiling is real, and it is a throw rather than a decline: a 33-character
    // pattern is what §2's bound exists to prevent, and this is what happens if it
    // ever does not.
    expect(() => locator(text, 'b'.repeat(MATCH_MAX_BITS + 1), 0)).toThrow(/too long/i);
  });

  it('step 3 refuses when the locator is wrong, so its success depends on the locator', async () => {
    const original = baseBody();
    const anchor = capture(original, SENTENCE);
    const body = baseBody().replace(SENTENCE, 'The ferry ran late, as always.');

    await preloadAnchorLibraries();
    expect(expectOk(resolveAnchor(anchor, body, TICK_REVISION + 1)).method).toBe('context-fuzzy');

    // A locator that always reports offset 0 is wrong for this document, and the
    // rung must notice rather than apply a context from the top of the file.
    bindAnchorLibraries(() => 0);
    const refused = expectUnresolvable(resolveAnchor(anchor, body, TICK_REVISION + 1));
    expect(refused.reason).toMatch(/no longer appears anywhere/);
  });

  it('step 3 refuses, and says so by name, when no locator is bound at all', () => {
    // The unbound case is reachable because `bindAnchorLibraries()` with no argument
    // releases — so the module boots here in exactly the state a product caller is
    // in if it resolves without awaiting the preload.
    bindAnchorLibraries();
    expect(anchorLibrariesLoaded()).toBe(false);

    const anchor = capture(baseBody(), SENTENCE);
    const body = baseBody().replace(SENTENCE, 'The ferry ran late, as always.');
    const resolution = resolveAnchor(anchor, body, TICK_REVISION + 1);

    expect(resolution.status).toBe('unresolvable');
    if (resolution.status === 'unresolvable') {
      expect(resolution.reason).toMatch(/locator is not loaded/);
    }
  });

  it('a context longer than the library’s pattern ceiling refuses instead of throwing', async () => {
    // `Match_MaxBits = 32` and `match_bitap_` *throws* above it. §2 bounds a capture
    // to 32 context characters, but `TextAnchor` bounds nothing and §2 lets the user
    // edit an anchor inline — so this is a reachable input, and the rung has to
    // decline rather than let a recoverable drift crash the turn.
    await preloadAnchorLibraries();
    expect(MATCH_MAX_BITS).toBe(CONTEXT_CHARS);

    const anchor: TextAnchor = {
      from: 40,
      to: 44,
      exact: SENTENCE,
      prefix: 'x'.repeat(MATCH_MAX_BITS + 1),
      suffix: 'yyyy',
      capturedRevision: 1,
    };
    const body = `zz ${anchor.prefix} ${'The ferry ran late, as always.'} ${anchor.suffix} zz`;

    const resolution = resolveAnchor(anchor, body, 2);
    expect(resolution.status).toBe('unresolvable');
  });

  it('§3’s ±2000 window is the bound: 1500 resolves fuzzily, 2500 does not', async () => {
    const original = baseBody();
    const anchor = capture(original, SENTENCE);
    const drifted = 'The ferry ran late, as always.';
    const shifted = baseBody().replace(SENTENCE, drifted);

    await preloadAnchorLibraries();

    const near = `${filler(1500)}${shifted}`;
    const nearResolution = expectOk(resolveAnchor(anchor, near, TICK_REVISION + 1));
    expect(nearResolution.method).toBe('context-fuzzy');
    expect(near.slice(nearResolution.range.from, nearResolution.range.to)).toContain(drifted);

    const far = `${filler(2500)}${shifted}`;
    const farResolution = resolveAnchor(anchor, far, TICK_REVISION + 1);
    // Outside the window the fuzzy rung cannot locate the context, and because the
    // anchored text itself is gone there is nothing for step 4 either — so the
    // ladder refuses rather than reaching further than §3 allows.
    expect(farResolution.status).toBe('unresolvable');
  });

  it('§3’s edit budget is enforced by the ladder, in both directions', async () => {
    await preloadAnchorLibraries();
    // A 10-character prefix: §3's budget is `max(2, ⌈10/10⌉)` = 2 edits.
    const anchor: TextAnchor = {
      from: 20,
      to: 24,
      exact: SENTENCE,
      prefix: 'abcdefghij',
      suffix: 'klmnopqrst',
      capturedRevision: 1,
    };
    const drifted = 'The ferry ran late, as always.';
    const anchoredOn = (body: string, prefix: string): TextAnchor => ({
      ...anchor,
      from: body.indexOf(prefix),
      to: body.indexOf(prefix) + 4,
    });

    // Two edits: inside the budget, so the rung resolves.
    const twoEdits = `xx abcXefghYj ${drifted} klmnopqrst yy`;
    expect(
      expectOk(resolveAnchor(anchoredOn(twoEdits, 'abcXefghYj'), twoEdits, 2)).method,
    ).toBe('context-fuzzy');

    // Three: outside it, so the rung refuses — **even though the library proposed
    // it**, which is the whole reason the gate lives here. The control is one line
    // above: `expectOk` on the two-edit fixture proves the locator found *something*
    // in the same document shape.
    const threeEdits = `xx abcXefghYZ ${drifted} klmnopqrst yy`;
    const refused = expectUnresolvable(resolveAnchor(anchoredOn(threeEdits, 'abcXefghYZ'), threeEdits, 2));
    expect(refused.reason).toMatch(/no longer appears anywhere/);

    // The budget itself, so the refusals above are about the library's limit rather
    // than about a number that was mistyped once.
    expect(editBudget(10)).toBe(2);
    expect(editBudget(100)).toBe(10);
    expect(editBudget(1)).toBe(2);
  });

  it('the engine the loader built really carries §3’s window, not the library default', async () => {
    // The configuration is two **field assignments** because the pinned constructor
    // ignores its arguments, so it is the one thing in this file that could be set
    // wrong and still typecheck. Asserted against the numbers, and against the
    // reach they produce, because "assigned" and "in effect" are different claims.
    expect(LOCATOR_CONFIGURATION).toEqual({ Match_Threshold: 1, Match_Distance: 2000 });

    await preloadAnchorLibraries();
    const locator = boundAnchorLocator()!;
    const source = readFileSync(
      new URL('../node_modules/diff-match-patch/index.js', import.meta.url),
      'utf8',
    );
    // The constructor really does read no arguments — this is the fact the whole
    // field-assignment shape rests on.
    expect(source).toContain('var diff_match_patch = function() {');

    const anchor = capture(baseBody(), SENTENCE);
    const shifted = baseBody().replace(SENTENCE, 'The ferry ran late, as always.');
    const at = (gap: number): AnchorResolution => resolveAnchor(anchor, `${filler(gap)}${shifted}`, 1);

    expect(at(NEAR_OFFSET_WINDOW - 1).status).toBe('ok');
    expect(at(NEAR_OFFSET_WINDOW + 100).status).toBe('unresolvable');
    expect(locator).toBeTypeOf('function');
  });

  it('step 4 is not reached when the locator is unbound, and the refusal says which rung is missing', () => {
    // **The header's rule, measured.** §4's lazy boundary is a boundary only if
    // the ladder can say when it is short: a ladder that reaches step 3 with
    // nothing bound refuses and names the reason, and does not skip to step 4.
    //
    // This fixture is the one that catches the skip: the anchored text is
    // **present and unique** in the body, 3000 characters away — so step 2's
    // window misses it and step 4's global search finds exactly one hit whose
    // context still matches. Step 4 would answer `ok`, and the result would say
    // `unique-global` and nothing about the rung that was skipped.
    //
    // The same fixture with a locator bound is the **control**: it is the
    // existing step-4 test above, and it proves the rung answers when the
    // ladder is whole.
    bindAnchorLibraries();
    expect(anchorLibrariesLoaded()).toBe(false);

    const original = baseBody();
    const anchor = capture(original, SENTENCE);
    const body = `${filler(3000)}${original}`;
    expect(Math.abs(body.indexOf(SENTENCE) - anchor.from)).toBeGreaterThan(NEAR_OFFSET_WINDOW);

    const resolution = resolveAnchor(anchor, body, TICK_REVISION + 5);
    expect(resolution.status).toBe('unresolvable');
    if (resolution.status === 'unresolvable') {
      expect(resolution.reason).toMatch(/locator is not loaded/);
    }
  });

  it('when step 2 already checked the single occurrence, the refusal says the context failed', () => {
    // The honest-reason rule in the other direction. The fixture above puts the
    // only occurrence **outside** the ±2000 window, so step 2 never saw it and
    // the missing-rung wording is the true one. Here the only occurrence is
    // **inside** the window: step 2 ran the context check on this exact hit and
    // it failed. The context was asked and answered "no", so the refusal must
    // report the context failure — claiming the check "could not run" would
    // name a rung that is not the one whose answer decided the outcome.
    bindAnchorLibraries();
    expect(anchorLibrariesLoaded()).toBe(false);

    const original = baseBody();
    const anchor = capture(original, SENTENCE);
    // Both captured context sides are replaced wholesale, the sentence itself
    // stays unique and moves by only a few characters — well inside the window.
    const body = `${filler(40, 'a')} ${SENTENCE} ${filler(40, 'b')}`;
    expect(Math.abs(body.indexOf(SENTENCE) - anchor.from)).toBeLessThan(NEAR_OFFSET_WINDOW);

    const resolution = expectUnresolvable(resolveAnchor(anchor, body, TICK_REVISION + 5));
    expect(resolution.reason).toMatch(/context around it no longer matches/);
    expect(resolution.reason).not.toMatch(/the rung that would have checked its context could not run/);
    // The missing locator is still disclosed — the ladder really is one rung
    // short — but as the addition to the honest primary reason, not as it.
    expect(resolution.reason).toMatch(/locator is not loaded/);
  });
});

describe('§3’s case-insensitive search — offsets in the body’s own coordinates', () => {
  /** U+0130: the one character whose lower case is *longer* than it is. */
  const DOTTED_I = 'İ';

  it('resolves to the anchored text when the body carries a character whose lower case is longer', () => {
    // `toLowerCase()` is not length-preserving: U+0130 lower-cases to `i` plus
    // U+0307, two code units. So an offset computed on a lower-cased copy of
    // the body is not an offset into the body, and every hit that follows such
    // a character is shifted by one code unit per character.
    //
    // The shift here is three code units, and the ladder's own context check
    // does not catch it: the suffix it compares is right-aligned and still
    // scores 100%. So the rung answers `ok` — with a range that addresses
    // `target wor` instead of `the target`, and an apply that would replace
    // the wrong ten characters.
    const body = `${DOTTED_I.repeat(3)} The target words here`;
    const anchor: TextAnchor = {
      // Stale by one character, so step 1 cannot answer and the search has to.
      from: 5,
      to: 15,
      exact: 'the target',
      prefix: '',
      suffix: ' words here',
      capturedRevision: 1,
    };
    expect(body.slice(anchor.from, anchor.to)).not.toBe(anchor.exact);

    const resolution = expectOk(resolveAnchor(anchor, body, 2));
    expect(resolution.method).toBe('near-offset');
    // The range the rung names has to be the anchored text's own range.
    expect(resolution.range).toEqual({ from: 4, to: 14 });
    expect(body.slice(resolution.range.from, resolution.range.to).toLowerCase()).toBe('the target');
  });

  it('resolves to the anchored text on the global rung too, not only the near one', () => {
    // The **second** call site of the same search, and the one a fix that only
    // patched the near-offset rung would miss. The text is 3000 characters away
    // — past §3's ±2000 window — so the near-offset rung cannot see it and the
    // unique-global rung answers it. The offsets it names are the same offsets,
    // and they have to be the body's own.
    const spy = countingLocator();
    bindAnchorLibraries(spy.locator);

    const body = `${filler(3000)}${DOTTED_I.repeat(3)} The target words here`;
    const anchor: TextAnchor = {
      from: 5,
      to: 15,
      exact: 'the target',
      prefix: '',
      suffix: ' words here',
      capturedRevision: 1,
    };

    const resolution = expectOk(resolveAnchor(anchor, body, 2));
    expect(resolution.method).toBe('unique-global');
    expect(resolution.range).toEqual({ from: 3004, to: 3014 });
    expect(body.slice(resolution.range.from, resolution.range.to).toLowerCase()).toBe('the target');
  });

  it('matches Greek across a case-only edit, where the fold must unify final sigma with medial sigma', () => {
    // Unicode's Final_Sigma rule is **contextual**: `Σ` lower-cases to `ς` only
    // at the end of a word, and a per-character fold cannot see the context —
    // it always answers `σ`. So `ΛΟΓΟΣ` folds to `λογοσ` while the same word
    // already spelled lowercase carries `ς`, and a search that folds both sides
    // per character without normalizing the two sigmas never matches: a
    // case-only edit of a Greek word would fall through to the step-5 refusal.
    // The fold normalizes `ς` → `σ` on both sides, which is length-preserving,
    // so the offsets below are still the body's own.
    const upper = 'Η πρόταση ΛΟΓΟΣ περιέχει τελικό σίγμα.';
    const lower = upper.toLowerCase();
    expect(lower).toContain('λογος');
    expect(lower.indexOf('λογος')).toBe(upper.indexOf('ΛΟΓΟΣ'));

    // Upper-cased capture, lower-cased body: the whole-string fold of the body
    // produced the final sigma, the per-character fold of the needle did not.
    const down = expectOk(resolveAnchor(capture(upper, 'ΛΟΓΟΣ'), lower, TICK_REVISION + 1));
    expect(down.method).toBe('near-offset');
    expect(lower.slice(down.range.from, down.range.to)).toBe('λογος');

    // And the mirror: a lower-cased capture resolved against the upper-cased
    // body, the direction a shouty rewrite of the same sentence produces.
    const up = expectOk(resolveAnchor(capture(lower, 'λογος'), upper, TICK_REVISION + 1));
    expect(up.method).toBe('near-offset');
    expect(upper.slice(up.range.from, up.range.to)).toBe('ΛΟΓΟΣ');
  });
});

describe('the library the ladder is measured against', () => {
  it('match_main takes three arguments — §3’s fourth parameter does not exist', () => {
    // The finding in `edit-anchors.ts`'s header, asserted rather than narrated: the
    // budget is enforced by the ladder because the library cannot be told it. If a
    // future bump of this pin gains a `maxbits` argument, this test is the thing that
    // says so, and the header can be rewritten to delegate.
    const source = readFileSync(
      new URL('../node_modules/diff-match-patch/index.js', import.meta.url),
      'utf8',
    );
    const signature = source.match(/prototype\.match_main = function\(([^)]*)\)/);
    expect(signature).not.toBeNull();
    expect((signature?.[1] ?? '').split(',')).toHaveLength(3);
    expect(source).toContain('d < pattern.length');
    // And the window is ours to set, not the library's default of 1000.
    expect(source).toContain('this.Match_Distance = 1000');
    expect(NEAR_OFFSET_WINDOW).toBe(2000);
    expect(CONTEXT_MATCH_FLOOR).toBe(0.8);
    expect(FUZZY_SIMILARITY_FLOOR).toBe(0.85);
  });
});