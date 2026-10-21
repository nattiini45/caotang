// The ambient `diff-match-patch` types travel with the module that imports it, so a
// program that reaches this file through a workspace import (the harness, the MCP
// server, the app) gets them without listing the editor's private d.ts in its include.
// The lint rule's `import` alternative does not apply: ambient.d.ts declares a module
// for a package that ships no types, and a `declare module` file cannot be imported.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./ambient.d.ts" />

/**
 * [edit-anchors.md] §3 — **the resolution ladder**, at apply time.
 *
 * ## What this module is
 *
 * `resolveAnchor(anchor, body)` answers one question: *given the offsets a plan
 * card captured, where in the body as it stands now does that text live?* §3 states
 * five steps, **first match wins**, and step 5 is an outcome rather than a fallback:
 * `{ status: 'unresolvable', reason, candidates, revisionDrift }`, feeding the
 * structured ask-back (agent-harness §2 step 4). The sentence that governs every
 * branch is **"never a silent fallback, never a guess"** — so there is no path here
 * that returns a range it has not verified against the body it was handed.
 *
 * It is **engine-agnostic by construction** (§5): it runs on the body projection —
 * a string — and touches no ProseMirror position, no DOM value and no store. The
 * only import at runtime is `fastest-levenshtein`, which §4 assigns to step 3's
 * similarity scoring and which is ~1 KB, main-bundle, eager.
 *
 * ## The finding: §3's edit-distance budget has no parameter in the pinned library
 *
 * §3 step 3 says *"Bitap-class search, max edit distance ⌈len/10⌉, floor 2"*, and
 * §4 names `diff-match-patch`'s `match_main` as that search. **Measured on
 * `diff-match-patch@1.0.5`, `match_main` takes three arguments — `(text, pattern,
 * loc)` — and the edit budget is not a parameter at all.** `match_bitap_` iterates
 * `d` from `0` to `pattern.length` (an unbounded number of error levels) and stops
 * on a *score*, `errors / pattern.length + proximity / Match_Distance <=
 * Match_Threshold`. So the two knobs are one coupled threshold and a proximity
 * denominator: raising `Match_Threshold` to admit 2 edits also admits a match
 * twice as far away, and no value of it expresses *"at most 2 edits anywhere within
 * 2000 characters"* — which is what §3 asks for.
 *
 * **So the budget is enforced here rather than delegated, and the library is left
 * doing the one thing it is good at.** The locator is configured to
 * `Match_Threshold: 1` (proximity alone never rejects, so nothing inside the window
 * is silently unproposed) and `Match_Distance: NEAR_OFFSET_WINDOW` (the ±2000 of
 * §3's step 2, which is the same neighbourhood step 3 locates in), then §3's
 * `max(2, ⌈len/10⌉)` is applied here with `distance()`. The library **proposes**;
 * the gate **disposes**; and the gate is exact where the library's is a heuristic.
 * Measured, in both directions: with this configuration a prefix 1 999 characters
 * away is located and one 2 100 away is not, and a 10-character context **three**
 * edits from the body's copy is proposed by the library and refused by the gate.
 *
 * ## The third finding: this library's constructor takes no options at all
 *
 * `diff_match_patch` is `function() { … }` — it reads **no arguments**, and its own
 * comment says *"Redefine these in your program to override the defaults"*: the
 * knobs are **fields assigned after construction**. So `new diff_match_patch({
 * Match_Distance: 2000 })` succeeds, binds nothing, and leaves the search at the
 * 1 000-character default — a silent no-op that reads like a configuration, and one
 * this slice's own first draft contained. {@link preloadAnchorLibraries} assigns
 * the fields, and {@link LOCATOR_CONFIGURATION} names them so a test can assert them
 * against the instance the loader actually built.
 *
 *
 *
 * ## The lazy boundary, and why a sync function can have one
 *
 * §4 requires `diff-match-patch` to be **lazy-loaded at the edit-anchors module
 * edge**, so steps 1–2 stay dependency-free, and §3's signature is **synchronous**.
 * A dynamic `import()` is asynchronous, so those two cannot both be satisfied by
 * one call shape. The shape that satisfies both: the library is bound to a
 * module-level {@link BitapLocator} by {@link preloadAnchorLibraries} (the one
 * dynamic import in the package) or injected by {@link bindAnchorLibraries}, and
 * `resolveAnchor` reads whatever is bound. **A ladder that reaches step 3 with
 * nothing bound refuses loudly and names the reason** — it does not skip to step 4,
 * which would be a silent downgrade of the rung the anchor needed, and it does not
 * guess. The apply path awaits the preload first, so in the product step 3 is always
 * available; the refusal exists for the caller that never asked for it.
 */
import { distance } from 'fastest-levenshtein';

import type { TextAnchor } from './seam.js';

/**
 * §7 A2's frozen defaults, as constants. **"Frozen defaults for evals, tunable
 * config"** — so they are named once here and read by name everywhere else, which
 * is what lets a test assert a threshold against the spec sentence it came from
 * rather than against a literal that could have been typed twice.
 */
export const NEAR_OFFSET_WINDOW = 2000;
export const CONTEXT_MATCH_FLOOR = 0.8;
export const FUZZY_SIMILARITY_FLOOR = 0.85;
export const MAX_CANDIDATES = 3;
/** §2: "`exact` ≤ 2000 chars (plan-card previewable)". */
export const MAX_EXACT_CHARS = 2000;
/** §2's context bounds, and the reason {@link TextAnchor.prefix}/`suffix` are ≤ 32. */
export const CONTEXT_CHARS = 32;

/**
 * The pinned library's hard pattern ceiling — `diff-match-patch@1.0.5`'s
 * `Match_MaxBits = 32`, which `match_bitap_` **enforces by throwing**
 * (`"Pattern too long for this browser."`) rather than by returning `-1`.
 *
 * **Measured equal to §2's `CONTEXT_CHARS`, which is why nothing shipped has ever
 * hit it — and why `TextAnchor` cannot be trusted to keep the ladder off it.** §2
 * bounds a *capture* to 32 context characters; the `TextAnchor` interface bounds
 * nothing, and an anchor arriving from a plan card (§2's "the user can edit the
 * anchor inline like any plan param") can carry more. So {@link fuzzyLocate} refuses
 * any context longer than this instead of letting the library throw — the same
 * shape as §3.3's `unknown` fallback, where the library throws rather
 * than degrades. Without this line a hand-edited anchor turns a recoverable drift
 * into a crash in the middle of a turn.
 */
export const MATCH_MAX_BITS = 32;

/** §3's `method` union, verbatim — one row per rung that can succeed. */
export type AnchorMethod = 'exact' | 'near-offset' | 'context-fuzzy' | 'unique-global';

export interface AnchorRange {
  from: number;
  to: number;
}

/** §3's `candidates` element: offsets plus the similarity that ranked it. */
export interface AnchorCandidate extends AnchorRange {
  similarity: number;
}

/**
 * §3's `AnchorResolution`, with one addition the spec's own step 5 requires and its
 * type block omits: `revisionDrift` on the **`unresolvable`** branch as well as the
 * `ok` one. Step 5 says the ask-back carries *"the drift reason, `candidates`, and
 * `revisionDrift`"* — so a refusal that could not report the drift would refuse
 * exactly the payload §3 says the user needs to choose between re-selecting and
 * dropping the step..
 */
export type AnchorResolution =
  | {
      readonly status: 'ok';
      readonly range: AnchorRange;
      readonly method: AnchorMethod;
      readonly revisionDrift: number;
    }
  | {
      readonly status: 'unresolvable';
      readonly reason: string;
      readonly candidates: readonly AnchorCandidate[];
      readonly revisionDrift: number;
    };

/**
 * §3's Bitap-class locate: `diff-match-patch`'s `match_main`, narrowed to the three
 * parameters it actually accepts (see the header). Declared as a type so the
 * ladder's own code has no `import` of the library — which is what makes steps 1–2
 * free of it, and what lets a test inject a locator that counts calls or lies.
 */
export type BitapLocator = (text: string, pattern: string, loc: number) => number;

/**
 * The two fields the ladder sets on the located engine, as data. **A configured
 * value is exactly the kind that can silently stop being set** — it is applied by a
 * library that ignores constructor arguments — so it is one exported record and the
 * test asserts the instance the loader built actually carries it.
 *
 * `Match_Threshold: 1` is what "proximity alone never rejects" means numerically:
 * the library's score is `errors / len + proximity / Match_Distance`, so a
 * threshold of 1 admits every candidate whose distance is inside `Match_Distance`
 * and leaves the edit judgement to the caller. The measured consequence is that the
 * reachable window is `threshold × distance` = **2000**, which is §3's ±2000.
 */
export const LOCATOR_CONFIGURATION = {
  Match_Threshold: 1,
  Match_Distance: NEAR_OFFSET_WINDOW,
} as const;

let boundLocator: BitapLocator | undefined;
let pendingLoad: Promise<BitapLocator> | undefined;

/**
 * Bind the fuzzy locator, or **release it** by calling this with no argument.
 *
 * **The injection seam, and the only way a test can observe which rung touched the
 * library.** Idempotent and total: re-binding replaces, and releasing returns the
 * module to the state it boots in — which matters because the binding is
 * module-level, so a test that bound a locator and left it bound would make every
 * later "the library is never touched" assertion pass for the wrong reason, and
 * {@link preloadAnchorLibraries} would hand back that stale binding instead of
 * loading the real one.
 */
export const bindAnchorLibraries = (locator?: BitapLocator): void => {
  boundLocator = locator;
  pendingLoad = undefined;
};

/** Whether a locator is bound. `false` means steps 3 and 4 cannot run and will say so. */
export const anchorLibrariesLoaded = (): boolean => boundLocator !== undefined;

/** The bound locator, or `undefined`. For tests that assert *which* one ran. */
export const boundAnchorLocator = (): BitapLocator | undefined => boundLocator;

/**
 * §4's lazy load — **the one dynamic `import()` in this package**, and the reason
 * steps 1–2 never load a 30 KB module to answer a question they can answer with a
 * slice comparison.
 *
 * **The configuration is assigned as fields after construction, never passed to the
 * constructor** — the pinned constructor reads no arguments (see the header), so an
 * options object here would be a silent no-op and the search would stay at the
 * library's 1 000-character default. Both numbers are measured in the test file: a
 * prefix 1 999 characters away resolves and the same prefix 2 100 away does not,
 * which is §3's ±2000 and not the library's default 500.
 *
 * **Concurrent callers share one import** (`pendingLoad`), and a failure clears it,
 * so a transient failure is a retry rather than a permanently broken ladder.
 *
 * **A module that exports none of the three shapes throws**, rather than binding a
 * locator that answers `-1` forever: a loader that cannot fail is a loader that
 * turns a packaging accident into a silent "this anchor never resolves".
 */
export const preloadAnchorLibraries = async (): Promise<BitapLocator> => {
  if (boundLocator !== undefined) return boundLocator;
  pendingLoad ??= import('diff-match-patch')
    .then((module) => {
      type Engine = {
        Match_Threshold: number;
        Match_Distance: number;
        match_main(text: string, pattern: string, loc: number): number;
      };
      type EngineConstructor = new () => Engine;
      const namespace = module as unknown as {
        diff_match_patch?: EngineConstructor;
        default?: { diff_match_patch?: EngineConstructor } & EngineConstructor;
      };
      const ctor = namespace.diff_match_patch ?? namespace.default?.diff_match_patch ?? namespace.default;
      if (typeof ctor !== 'function') {
        throw new Error(
          'diff-match-patch@1.0.5 exported none of diff_match_patch, default.diff_match_patch, or a default constructor, so the anchor ladder cannot bind its Bitap locate. Steps 1 and 2 still work; steps 3 and 4 will refuse with that reason.',
        );
      }
      const engine = new ctor();
      // Assigned, not passed. This is the line that makes §3's ±2000 window real, and
      // it is the line the library's own comment ("redefine these in your program")
      // is about.
      engine.Match_Threshold = LOCATOR_CONFIGURATION.Match_Threshold;
      engine.Match_Distance = LOCATOR_CONFIGURATION.Match_Distance;
      boundLocator = (text: string, pattern: string, loc: number): number =>
        engine.match_main(text, pattern, loc);
      return boundLocator;
    })
    .catch((thrown: unknown) => {
      pendingLoad = undefined;
      throw thrown;
    });
  return pendingLoad;
};

/**
 * **Normalized similarity**, §3 step 3's `≥ 0.85` scored against `fastest-levenshtein`
 * (§4's attribution for step-3 similarity).
 *
 * Normalized by the **longer** of the two strings, so the score is symmetric and
 * `1` means identical — a shorter needle inside a longer haystack scores against
 * the haystack's length, which is what keeps the threshold meaning the same thing
 * for a 12-character target and a 400-character one. Two empty strings are `1`:
 * they are identical, and a floor test that refused them would refuse a legitimate
 * deletion target.
 */
export const similarity = (left: string, right: string): number => {
  if (left === right) return 1;
  const longest = Math.max(left.length, right.length);
  if (longest === 0) return 1;
  return 1 - distance(left, right) / longest;
};

/**
 * The one normalization **both** folds apply: `ς` → `σ` and `ſ` → `s`.
 *
 * **It is 1:1, so it is safe for a fold that carries a map back to the source.**
 * A code unit in, a code unit out — so no offset moves, and `origin` and
 * `sourceStart` stay exact.
 *
 * **Both folds need it, and the two folds are two halves of the same rung.** The
 * search folds the body and the needle; the context check folds the captured
 * prefix and suffix against the body's own characters. A normalization that only
 * one of them applies is undone by the other: the search finds the occurrence,
 * and the context check then refuses it over a spelling difference the search
 * had already folded away — which is how a case-only edit of a Greek word ends up
 * in step 5's refusal instead of on a rung.
 *
 * The two replacements are the ones the repo's own matching fold applies
 * (`packages/codex/src/text.ts`), and they exist for Unicode's reason:
 * Final_Sigma is **contextual**, so `Σ` lower-cases to `ς` only at the end of a
 * word, and a per-character fold cannot see the context.
 */
const foldUnit = (character: string): string =>
  character.toLowerCase().replace(/ς/g, 'σ').replace(/ſ/g, 's');

/**
 * §3's context check, as a ratio over the characters available on one side.
 *
 * `"≥ 80% of prefix and suffix characters match at the corresponding positions,
 * case-insensitive"`, with §3's own `"empty prefix/suffix skipped"`.
 *
 * **The comparison is right-aligned, and that is the reading of "corresponding
 * positions" that §2's data shape forces.** A `prefix` is *"up to 32 chars preceding
 * `from`"*, so `prefix[k]` sits at `from - prefix.length + k` — its **last**
 * character is the one immediately before the range. When the body offers fewer
 * characters than the anchor captured (text deleted above the target, or an anchor
 * captured near the document start), the characters that still correspond are the
 * anchor's **tail**, not its head; left-aligning them would compare the anchor
 * against a window shifted by the length difference and refuse a context that is
 * genuinely intact. Where the body has no characters at all on that side the side is
 * skipped, exactly as §3 says for an empty context.
 *
 * **The denominator is the number of comparable characters** (`min` of the two
 * lengths), because the missing ones are not mismatches — they are characters that
 * are not there to compare.
 *
 * **Both sides are folded the way {@link foldUnit} folds them**, so a difference
 * that is only a spelling — a word-final `Σ` against a `ς` — is not counted as a
 * mismatch. The floor is a floor on *drift*, and a spelling is not drift: the
 * search treats the two spellings as the same word, and a context check that
 * disagreed with the search would refuse an occurrence the rung it belongs to
 * has just found.
 *
 * Exported because it is a rule with two sides and §3 states one threshold: a check
 * that can only be observed passing is not a check.
 */
const contextSidePasses = (expected: string, available: string): boolean => {
  if (expected.length === 0 || available.length === 0) return true;
  const skipped = expected.length - available.length;
  let matched = 0;
  let compared = 0;
  for (let i = Math.max(0, skipped); i < expected.length; i += 1) {
    compared += 1;
    if (foldUnit(expected.charAt(i)) === foldUnit(available.charAt(i - skipped))) matched += 1;
  }
  return compared > 0 && matched / compared >= CONTEXT_MATCH_FLOOR;
};

/**
 * §3's context check over a candidate range: `"used by methods 2–4"`.
 *
 * Both sides are checked, and **both are skipped when empty**, so an anchor at the
 * very start or end of a document is judged on whichever context it does carry
 * rather than on a missing side counted as a failure.
 */
export const contextMatches = (anchor: TextAnchor, body: string, range: AnchorRange): boolean => {
  const prefixFrom = Math.max(0, range.from - anchor.prefix.length);
  const prefix = contextSidePasses(anchor.prefix, body.slice(prefixFrom, range.from));
  if (!prefix) return false;
  const suffixTo = Math.min(body.length, range.to + anchor.suffix.length);
  const suffix = contextSidePasses(anchor.suffix, body.slice(range.to, suffixTo));
  return suffix;
};

/**
 * A string's lower-cased copy, **with the map back to the source** that the copy
 * does not carry.
 *
 * `toLowerCase()` is not length-preserving: U+0130 (İ) lower-cases to `i` plus
 * U+0307 — two code units — so an index into the lower-cased string is not an
 * index into the source, and an offset computed on the copy names a different
 * piece of text than the one that was searched.
 *
 * **The folding is one code point at a time**, which is what makes the map
 * exact: every code point contributes a known run of folded units, and the
 * source offsets of that run are known too. Folding the whole string in one
 * call folds the same characters the same way in almost every case but not in
 * every case — Greek's final sigma is `ς` only at the end of a word — and a
 * whole-string fold cannot say which source character produced which folded
 * unit, which is the whole of what the map is for.
 *
 * **The context the per-code-point fold cannot see is normalized instead.**
 * Unicode's Final_Sigma rule makes a whole-string fold of `ΛΟΓΟΣ` end in `ς`
 * while `Σ` folded in isolation is always `σ`, so the two spellings of the same
 * word would never meet in a search. Both are replaced on the way in — by
 * {@link foldUnit}, the same 1:1 normalization the repo's matching fold applies
 * — which unifies the spellings without changing any code-unit count, so
 * `origin` and `sourceStart` stay exact.
 *
 * `sourceStart` carries one entry more than there are code points: the string's
 * own length, so the end of the last code point is the next entry rather than a
 * special case.
 */
interface FoldedText {
  /** The lower-cased text. */
  readonly folded: string;
  /** The source code point each unit of `folded` came from. */
  readonly origin: number[];
  /** Each source code point's offset, plus the string's length at the end. */
  readonly sourceStart: number[];
}

const foldWithMap = (source: string): FoldedText => {
  let folded = '';
  const origin: number[] = [];
  const sourceStart: number[] = [];
  let offset = 0;
  let index = 0;
  for (const character of source) {
    // Length-preserving: both replacements map one code unit to one code unit,
    // so the fold's map back to the source is untouched by them.
    const lowered = foldUnit(character);
    sourceStart.push(offset);
    for (let unit = 0; unit < lowered.length; unit += 1) {
      folded += lowered[unit]!;
      origin.push(index);
    }
    offset += character.length;
    index += 1;
  }
  sourceStart.push(offset);
  return { folded, origin, sourceStart };
};

/**
 * Every case-insensitive occurrence of `needle` whose **start** lies in `[start, end]`.
 *
 * **The offsets are the body's own.** A lower-cased copy of the slice is what
 * the search runs on, and the copy is not the same length as the slice — so the
 * copy's indices are translated back through the fold's map before they are
 * used, and the range a hit names is the range of the **source** characters the
 * hit was made of. A range's length is therefore the matched source length and
 * not the needle's, which are the same thing only when the needle's own fold
 * did not change its length.
 */
const findOccurrences = (body: string, needle: string, start: number, end: number): AnchorRange[] => {
  if (needle.length === 0) return [];
  const from = Math.max(0, start);
  const to = Math.min(body.length, end);
  if (to < from) return [];
  const { folded, origin, sourceStart } = foldWithMap(body.slice(from, to));
  const wanted = foldWithMap(needle).folded;
  if (wanted.length === 0) return [];
  const found: AnchorRange[] = [];
  let at = folded.indexOf(wanted);
  while (at !== -1) {
    const first = origin[at]!;
    const last = origin[at + wanted.length - 1]!;
    found.push({ from: from + sourceStart[first]!, to: from + sourceStart[last + 1]! });
    at = folded.indexOf(wanted, at + 1);
  }
  return found;
};

const sameRange = (left: AnchorRange, right: AnchorRange): boolean =>
  left.from === right.from && left.to === right.to;

/** §3 step 5's `"candidates (up to 3, offsets + similarity)"` — ranked, deduped, capped. */
const rankCandidates = (candidates: readonly AnchorCandidate[]): AnchorCandidate[] => {
  const unique = new Map<string, AnchorCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.from}:${candidate.to}`;
    const seen = unique.get(key);
    if (seen === undefined || candidate.similarity > seen.similarity) {
      unique.set(key, candidate);
    }
  }
  return [...unique.values()]
    .sort((left, right) =>
      right.similarity === left.similarity ? left.from - right.from : right.similarity - left.similarity,
    )
    .slice(0, MAX_CANDIDATES);
};

const candidateFor = (body: string, range: AnchorRange, anchor: TextAnchor): AnchorCandidate => ({
  from: range.from,
  to: range.to,
  similarity: similarity(body.slice(range.from, range.to), anchor.exact),
});

/** §3 step 3's budget: `"max edit distance ⌈len/10⌉, floor 2"`. */
export const editBudget = (patternLength: number): number =>
  Math.max(2, Math.ceil(patternLength / 10));

interface FuzzyOutcome {
  readonly range: AnchorRange | undefined;
  readonly similarity: number;
}

/**
 * §3 step 3, and the only rung that consults the library.
 *
 * Three deliberate limits, each one a refusal rather than an assumption:
 *
 * - **Both context sides must be present.** §2 allows `prefix`/`suffix` to be `''`
 *   at the document's start and end, and §3 step 3 locates `prefix` *"near the
 *   expected position"* then `suffix` — so with either side empty the target's
 *   corresponding edge has no evidence, and assuming it (`to = from + exact.length`)
 *   is precisely the guess §3 step 5 forbids. Such an anchor is served by steps 2
 *   and 4, which search for the text itself and need no context bounding.
 * - **The located window is §3's ±2000**, checked after the library returns, so the
 *   bound is the ladder's and not the library's `Match_Distance`.
 * - **The edit budget is §3's**, applied with `distance()` (see the header).
 */
const fuzzyLocate = (
  anchor: TextAnchor,
  body: string,
  locator: BitapLocator,
): FuzzyOutcome => {
  const missed: FuzzyOutcome = { range: undefined, similarity: 0 };
  if (anchor.prefix.length === 0 || anchor.suffix.length === 0) return missed;

  const locate = (pattern: string, near: number): number | undefined => {
    // See the header: the library throws above its 32-character pattern ceiling
    // rather than declining, so the length is checked here and the rung declines.
    if (pattern.length > MATCH_MAX_BITS) return undefined;
    // `loc` is the *expected* position, not the window's edge. The library scores
    // proximity as `|loc - match| / Match_Distance` and scans both directions from
    // `loc`, so `loc = near` with `Match_Distance = NEAR_OFFSET_WINDOW` is what makes
    // the search §3's ±2000 window around the expected position; passing the
    // window's lower edge instead would reach 2000 characters *after* the anchor
    // and none before it.
    const found = locator(body, pattern, Math.max(0, near));
    if (found < 0) return undefined;
    if (Math.abs(found - near) > NEAR_OFFSET_WINDOW) return undefined;
    const actual = body.slice(found, found + pattern.length);
    if (actual.length !== pattern.length) return undefined;
    if (distance(actual, pattern) > editBudget(pattern.length)) return undefined;
    return found;
  };

  const prefixAt = locate(anchor.prefix, anchor.from);
  if (prefixAt === undefined) return missed;
  // §2's `from` addresses the **target**, not the context: `exact` starts after
  // `prefix`, so the resolved range starts after it too. Returning the prefix's own
  // position would hand the apply path a range that includes 32 characters of
  // surrounding text — which is a *valid-looking* range that replaces the context
  // along with the target, and the one assertion in the test file that compares the
  // resolved `from` with `body.indexOf(text)` is what catches it.
  const bodyStart = prefixAt + anchor.prefix.length;
  const suffixAt = locate(anchor.suffix, bodyStart);
  if (suffixAt === undefined || suffixAt < bodyStart) return missed;

  const between = body.slice(bodyStart, suffixAt);
  const score = similarity(between, anchor.exact);
  if (score < FUZZY_SIMILARITY_FLOOR) return { range: undefined, similarity: score };
  return { range: { from: bodyStart, to: suffixAt }, similarity: score };
};

/**
 * §3's ladder, in order, **first match wins**.
 *
 * The signature is §3's, with the one value §3's own step 5 requires and its
 * signature cannot carry: `applyRevision`. Step 5's ask-back and the `ok` branch's
 * `revisionDrift` are both *"apply-time revision − captured revision"*, and with no
 * apply-time revision in hand the function would have to report `0` — a drift
 * figure that reads as *"nothing moved"* on exactly the turn where the most moved.
 *
 *
 * **Steps 1 and 2 never read the bound locator**, which is §4's lazy-boundary
 * requirement and is asserted with a counting locator rather than asserted in a
 * comment.
 */
export const resolveAnchor = (
  anchor: TextAnchor,
  body: string,
  applyRevision: number,
): AnchorResolution => {
  const revisionDrift = applyRevision - anchor.capturedRevision;
  const ok = (range: AnchorRange, method: AnchorMethod): AnchorResolution => ({
    status: 'ok',
    range,
    method,
    revisionDrift,
  });
  const refuse = (reason: string, candidates: readonly AnchorCandidate[] = []): AnchorResolution => ({
    status: 'unresolvable',
    reason,
    candidates: rankCandidates(candidates),
    revisionDrift,
  });

  if (anchor.exact.length === 0) {
    return refuse(
      'the anchor carries no `exact` text, so there is nothing to locate. Nothing was written.',
    );
  }
  if (anchor.exact.length > MAX_EXACT_CHARS) {
    return refuse(
      `the anchor carries ${anchor.exact.length} characters of \`exact\` and edit-anchors §2 bounds that field at ${MAX_EXACT_CHARS}, so this anchor could not have been captured from a legal plan card. Re-select the range and apply again; a longer target must be split into multiple anchored steps.`,
    );
  }

  // Step 1 — exact. Bounds are checked explicitly because `slice` clamps, and a
  // clamped slice of a shrunken document would answer "yes" to a range that no
  // longer exists.
  const inBounds =
    anchor.from >= 0 && anchor.to > anchor.from && anchor.to <= body.length;
  if (inBounds && body.slice(anchor.from, anchor.to) === anchor.exact) {
    return ok({ from: anchor.from, to: anchor.to }, 'exact');
  }

  const windowStart = Math.max(0, anchor.from - NEAR_OFFSET_WINDOW);
  const windowEnd = Math.min(body.length, anchor.from + NEAR_OFFSET_WINDOW);
  const inWindow = findOccurrences(body, anchor.exact, windowStart, windowEnd);
  const global = findOccurrences(body, anchor.exact, 0, body.length);

  // Step 2 — near-offset. `"exactly one hit → context check → apply at the new range"`.
  if (inWindow.length === 1) {
    const only = inWindow[0]!;
    if (contextMatches(anchor, body, only)) return ok(only, 'near-offset');
  }

  // Step 3 — context-fuzzy. The one rung that needs the library.
  const locator = boundLocator;
  const fuzzy: FuzzyOutcome =
    locator === undefined
      ? { range: undefined, similarity: 0 }
      : fuzzyLocate(anchor, body, locator);
  if (fuzzy.range !== undefined) {
    const passing: AnchorRange[] = [fuzzy.range, ...inWindow];
    const distinct = passing.filter(
      (range, at) => passing.findIndex((other) => sameRange(other, range)) === at,
    );
    // `"unique pass"`: one candidate range and it clears §3's similarity floor.
    if (distinct.length === 1) return ok(distinct[0]!, 'context-fuzzy');
  }

  // Step 5's pool, built before step 4 because the refusal below hands it to
  // the ask-back.
  const pool: AnchorCandidate[] = [
    ...global.map((range) => candidateFor(body, range, anchor)),
    ...inWindow.map((range) => candidateFor(body, range, anchor)),
  ];
  if (fuzzy.range !== undefined) {
    pool.push({ from: fuzzy.range.from, to: fuzzy.range.to, similarity: fuzzy.similarity });
  }

  // Step 4 — unique-global. `"exactly one hit → verify ≥ 80% of prefix/suffix"`.
  //
  // **Only with the library bound.** §4's lazy boundary is a boundary only if
  // the ladder can say when it is short: the header's rule is that a ladder
  // which reaches step 3 with nothing bound refuses and names the reason
  // rather than skipping to step 4, because step 4 is the rung that gives up
  // on locality — it is the one an anchor that needed the fuzzy rung most is
  // least helped by. An `ok` from here would say `unique-global` and nothing
  // about the rung that was skipped, so the caller could not tell a full-ladder
  // answer from a one-rung-short one.
  if (locator !== undefined && global.length === 1) {
    const only = global[0]!;
    if (contextMatches(anchor, body, only)) return ok(only, 'unique-global');
  }

  // Step 5 — exhaustion. Never a fallback, never a guess: name the drift, rank up to
  // three candidates, and report how far the document moved since capture.
  let reason: string;
  if (global.length === 0) {
    reason =
      fuzzy.similarity > 0 && fuzzy.similarity < FUZZY_SIMILARITY_FLOOR
        ? `the anchored text changed since the plan was captured: the nearest context match scores ${fuzzy.similarity.toFixed(3)} against the required ${FUZZY_SIMILARITY_FLOOR}, and the anchored text itself no longer appears anywhere in the document.`
        : 'selection text changed since plan: the anchored text no longer appears anywhere in this document. Re-select the range in the editor, or re-read the document with `doc.read` and re-plan the step.';
  } else if (global.length > 1) {
    reason = `the anchored text now appears ${global.length} times in this document and no single occurrence matches the captured context with enough of it (${Math.round(
      CONTEXT_MATCH_FLOOR * 100,
    )}% required). Quoting the span to target it is not possible without choosing one of them, so nothing was written.`;
  } else if (locator === undefined && inWindow.length !== 1) {
    // **The one occurrence is there, and nothing has said whether it is the
    // right one.** It lies outside step 2's window — an in-window occurrence
    // was context-checked by step 2, and a failure there is the honest
    // "the context no longer matches" below — and the rung that would have
    // checked it globally is the rung that could not run, so the reason must
    // not claim the context failed; that question was never asked.
    reason = `the anchored text appears once in this document, but the rung that would have checked its context could not run, so nothing has confirmed that this occurrence is the one the plan meant.`;
  } else {
    reason = `the anchored text appears once, but the context around it no longer matches (${Math.round(
      CONTEXT_MATCH_FLOOR * 100,
    )}% of the captured prefix and suffix required), so this occurrence is probably not the one the plan meant.`;
  }
  if (locator === undefined) {
    reason +=
      ' The fuzzy rung and the unique-global rung could not run because the locator is not loaded, so this answer is two rungs short of the ladder; await `preloadAnchorLibraries()` before resolving to get the full ladder.';
  }
  return refuse(reason, pool);
};