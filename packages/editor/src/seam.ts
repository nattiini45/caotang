/**
 * [editor-engine.md] §4 — `EditorApi`, the engine-agnostic seam, and the
 * **projection map** the spec calls its one subtle mechanism.
 *
 * ## What this module is, and what it is not
 *
 * It is the **interface** plus the **coordinate bridge**. §4 states the property
 * that makes the interface importable headless, and this file is that property
 * working: it imports no engine, no DOM *value* and no store. The only engine type
 * it names is `Node` from `@tiptap/pm/model`, which is the document model §3's
 * schema already uses, not a view, an editor or a plugin.
 *
 * It is **not** the Tiptap adapter. §4's `mount` is implemented there, and the
 * in-memory implementation this slice tests against
 * (`test/memory-api.ts`) is a *fixture*, not the product's second engine: it
 * exists because an interface nothing implements satisfies every test written
 * about it. What is measured to be absent from this package is named at the end
 * of this comment rather than left for the reader to infer.
 *
 * ## The projection map: three levels, and why
 *
 * §4 says: *"walk the PM doc, serialize each top-level block through the §5
 * pipeline, concatenate with `\n\n`; record each block's `[bodyStart, bodyEnd) →
 * [pmFrom, pmTo)` span. Conversions are bisections over that map."*
 *
 * Measured against the shipped `serialize`, two corrections were required and
 *:
 *
 * 1. **The spans are not measured against the concatenation.** Two sibling lists
 *    serialize with an *alternated* marker — `- a\n\n* b` — so per-block
 *    concatenation (`- a` + `- b`) is a **different body projection** from
 *    `serialize(doc)`, and it is the one that re-parses as a single loose list.
 * That is the measured §5 amendment, and §4's sentence predates it. So the
 *    body the map measures against is `serialize(doc)` — the projection the app
 *    actually stores — and each block's span comes from serializing the document
 *    **truncated to that block** (`- a\n\n* b` → `[0,4)` and `[4,9)`). Measured:
 *    every multi-block corpus entry's prefix is a prefix of the whole, 5 of 5.
 * 2. **A block span alone cannot answer `getSelection`.** A selection is an
 *    offset *inside* a block, and §4's map has one span per block. So the map
 *    also records a **run** per text leaf — `bodyStart`/`bodyEnd` exactly as long
 *    as the leaf's PM span — and the conversions bisect to a run and fall back to
 *    a block. Runs are located by *searching the block's own slice of the real
 *    body*, never by serializing the leaf: §5 escapes on the way out, so
 *    `not [a link` is written `not \[a link` and a search for the raw text alone
 *    finds nothing. Measured over the whole §13 corpus: **76 of 76 text leaves
 *    located, 0 blocks degraded** — 72 on the leaf's own serialization and 4 on
 *    the raw-text search. The third, escape-tolerant search locates **none** of
 *    them; see the note on `locate` and on `RunMatch`.
 *
 * The run spans are equal on both sides by construction (`bodyEnd - bodyStart ===
 * pmTo - pmFrom`), which is what makes the round trip an identity rather than a
 * projection. Where a body and a PM position are genuinely not in bijection — a
 * hard break is 3 characters and one position, a list marker is syntax and no
 * position at all — the offset **clamps to the nearest text position**, which is
 * §4's own words: *"offsets map to nearest position; the anchor ladder is the
 * verification layer above them"*.
 *
 * ## What is deliberately absent, named so it cannot be read as the editor finishing
 *
 * The Tiptap adapter and its `mount` are **not in this file**, and that is the
 * point: this module stays headless. They live in `src/tiptap/`, reached through
 * `@caotang/editor/tiptap`, and implement the interfaces above on a real view. §8's
 * ghost rendering and §9's dirty pipeline are there too. What this file still does
 * not own is §6's anchor **resolution** (the four-step ladder, in `edit-anchors.ts`):
 * `captureAnchor` here only reads the selection, and the adapter takes the revision
 * from the store because §9 makes the store its owner.
 *
 * **§7's two-lane undo is not on that list**: it is `./lanes.js`, the one place that reads `historyExcluded`
 * and the one that writes `addToHistory: false`. It left this list because the
 * thing that kept it out was not a scope decision — §7's mechanism is
 * `EditorState` + transactions with no view, so it was buildable headless the
 * whole time and no row had asked for it. §4's three `historyExcluded`
 * parameters are now spelled with `lanes.ts`'s `LaneOptions`, so the interface
 * and the read cannot drift apart.
 */
import type { Node as PmNode } from '@tiptap/pm/model';
import { saveSideOwnTexts } from './dialect.js';
import type { DialectNotice } from './dialect.js';
import type { LossWarning } from './handlers.js';
import type { LaneOptions } from './lanes.js';
import { serialize } from './pipeline.js';
import { caotangSchema } from './schema.js';

/** §4's two interfaces that are pure data. Offsets are body-projection char offsets
 *  (UTF-16 code units, 0-indexed, `to` exclusive) — edit-anchors.md §2. */
export interface EditorSelection {
  from: number;
  to: number;
}

/**
 * edit-anchors.md §2's `TextAnchor`, declared there and re-exported here
 * unchanged. §4's `captureAnchor` returns one, and this file is the seam that
 * has to name it.
 */
export interface TextAnchor {
  from: number;
  to: number;
  exact: string;
  prefix: string;
  suffix: string;
  capturedRevision: number;
}

/**
 * §8's `GhostController` — the *shape* §4's `EditorInstance` needs, which is the
 * two methods §8 names. The ghost region itself (a separate read-only
 * `EditorInstance`, tinted, rendered below the focus doc) is §8's slice; a
 * controller declared here and implemented nowhere would be the declaration
 * without behaviour this repo keeps paying for, so the minimum is stated and the
 * rest is left to the row that owns it.
 */
export interface GhostController {
  /** §8: "harness receives chunks → `ghost.append(delta)`". Never in Lane 1. */
  append(delta: string): void;
  /** §8: "**Discard** → `ghost.clear()` only". */
  clear(): void;
}

/**
 * §4's carrier. **The diagnostics half of `ParseResult`, passed through
 * untouched** — and that is the whole contract.
 *
 * This carrier's shape settles §4's
 * ambiguity — *"the carrier is named, its shape is not"* — with two requirements
 * that pull against each other in their spelling: the carrier "carries exactly
 * the per-node `LossWarning[]` that `parseWithDiagnostics` returns — same array,
 * same length, same `position` values, no merging, no reordering, no dedupe", and
 * `DialectNotice[]` "travels as a separate field beside it rather than merged
 * into it". One argument cannot be both a bare array and an object with a field
 * beside the array, so the object is the only shape satisfying both:
 * `warnings` **is** the array §3.3 produced, by reference, and `dialect` sits
 * next to it.
 *
 * So `LoadDiagnostics` is `ParseResult` without its `doc`: the seam hands the
 * parse's reporting half to the banner and keeps the document. Presentation is
 * `groupLossWarnings` below, a **separate call the carrier never makes** — the
 * carrier is the one layer a caller cannot bypass (`parse` itself refuses
 * nothing), so interpreting the list there would make §3.3's taxonomy a function
 * of who is listening.
 */
export interface LoadDiagnostics {
  warnings: LossWarning[];
  dialect: DialectNotice[];
}

export interface EditorMountOptions {
  /** Binds the instance to a document. */
  docId: string;
  /** Body projection MD ([project-format.md](project-format.md) §3). */
  initialBody: string;
  /** Read-only mounts, for previews. Carried by the seam; `editable` is the **adapter's** to enforce, so no implementation here does.
   *  Apply-then-review (§15) is not read-only: the marks sit in an editable document, and the writer resolves them. */
  readOnly?: boolean;
  /** Content changed (autosave + revision pipeline, §9). */
  onChange?: () => void;
  onSelectionChange?: (sel: EditorSelection | null) => void;
  /** §4's error-modes clause: a load that produced diagnostics says so here. */
  onLoadDiagnostics?: (diagnostics: LoadDiagnostics) => void;
}

export interface EditorInstance {
  /** Serialize current doc → body projection MD (sync; §5). */
  getContent(): string;
  /** Parse+replace (§5, §7). */
  setContent(body: string, opts?: LaneOptions): Promise<void>;
  /** `null` when collapsed. */
  getSelection(): EditorSelection | null;
  /**
   * edit-anchors.md §2 — from the selection. `null` when the selection is collapsed, and `null`
   * when it is longer than the anchor's bound of 2000 characters: §2 bounds `exact`, so a longer
   * target splits into several anchored steps, each captured from its own selection. An anchor
   * that carried more text would be refused at apply time, and never resolve.
   */
  captureAnchor(): TextAnchor | null;
  /** Scroll into view + select (agent "show me" affordances). */
  revealRange(sel: EditorSelection): void;
  /**
   * `editor.insert` primitive: inserts `text` at the caret, or at the end of a selection.
   *
   * **The text is body Markdown**. It is read the way §5 reads a body, so `*x*`
   * inserts emphasis that saves as `_x_`, and a space at either edge of the text is kept. One
   * paragraph joins the text around the insertion point; several blocks join it at their ends.
   * The text takes its own marks. A primitive never throws for content: offsets map to the
   * nearest text position (§4's error-modes clause).
   */
  insertAtSelection(text: string, opts?: LaneOptions): void;
  /**
   * `editor.replaceRange` primitive: replaces `[sel.from, sel.to)` with `text`, read as body
   * Markdown exactly as `insertAtSelection` reads it. The replaced text's marks are not kept,
   * because the replacement states its own. An empty `text` deletes the range.
   */
  replaceRange(sel: EditorSelection, text: string, opts?: LaneOptions): void;
  ghost: GhostController;
  /** §9. */
  wordCount(): { words: number; chars: number };
  focus(): void;
  destroy(): void;
}

/** §15: where an approved agent edit came from, so the editor can group its marks and the store can be re-seated. */
export interface AgentEditInfo {
  /** The tool call that made the edit. Kept in the editor's own map; it is never part of a mark. */
  toolCallId: string;
  /** The revision the store holds for the edit's body. */
  revision: number;
}

/**
 * §15: how `showAgentEdit` landed an edit. `suggestions` means the marks are on screen; `replaced` means the text was swapped in
 * as `setContent` does, with `reason` saying why (`off` when the editor was not mounted in review mode, so no notice is owed).
 */
export type AgentEditOutcome =
  | { landed: 'suggestions'; suggestions: number }
  | { landed: 'replaced'; reason: 'off' | 'unsaved' | 'diff' | 'mismatch' | 'superseded' };

/** One pending suggestion, as the review bar and the agent panel show it. */
export interface ReviewSuggestion {
  id: string;
  /** The tool call of the turn that made it, or `null` once the editor has forgotten the turn. */
  toolCallId: string | null;
  kind: 'insert' | 'delete' | 'replace';
  /** The words added and the words removed, shortened. */
  added: string;
  removed: string;
}

/** What the review bar reads. A new object whenever anything in it changed. */
export interface ReviewState {
  /** Pending suggestions in the document. */
  pending: number;
  /** The pending suggestions of each tool call, oldest first. */
  byToolCall: ReadonlyArray<{ toolCallId: string; pending: number }>;
  /** The suggestion at the caret or selection, or `null`. */
  current: ReviewSuggestion | null;
  /** 1-based place of `current` among the pending, or 0. */
  position: number;
}

/**
 * §15's resolution calls. Each is Lane 1 (undoable with Ctrl+Z) and returns how many suggestions it resolved. Accepting writes
 * nothing, because the store already holds the accepted text; rejecting changes the body, so autosave stores it as the writer's edit.
 */
export interface ReviewApi {
  state(): ReviewState;
  subscribe(listener: () => void): () => void;
  /** The suggestion at the caret or selection. */
  accept(): number;
  reject(): number;
  acceptToolCall(toolCallId: string): number;
  rejectToolCall(toolCallId: string): number;
  acceptAll(): number;
  rejectAll(): number;
  /** Moves the selection to the next or previous pending suggestion, wrapping round. */
  next(): boolean;
  previous(): boolean;
}

/** §15's widening of the instance: an agent edit shown as marks, and the calls that resolve them. */
export interface ReviewableEditorInstance extends EditorInstance {
  /**
   * Shows `nextBody`, which the store already holds, as suggestion marks over the text on screen, grouped as one turn. Falls back to
   * `setContent` (and says so in the outcome) when the editor is not in review mode, holds unsaved edits, or the marks would not
   * project back to `nextBody` exactly.
   */
  showAgentEdit(nextBody: string, info: AgentEditInfo): Promise<AgentEditOutcome>;
  readonly review: ReviewApi;
}

export interface EditorApi {
  mount(host: HTMLElement, opts: EditorMountOptions): Promise<EditorInstance>;
}

// ---------------------------------------------------------------------------
// The projection map
// ---------------------------------------------------------------------------

/** §4's span: one top-level block, on both sides. */
export interface ProjectionBlock {
  /** `[bodyStart, bodyEnd)` in the body projection. */
  bodyStart: number;
  bodyEnd: number;
  /** `[pmFrom, pmTo)` in PM doc coordinates. */
  pmFrom: number;
  pmTo: number;
}

/**
 * One located stretch of a text leaf. **`bodyEnd - bodyStart === pmTo - pmFrom`
 * always** — that equality is what makes the two conversions inverses instead of
 * projections, so it is asserted over the whole corpus rather than assumed here.
 *
 * **A leaf is one run, or one run per escape it carries.** §4 says the map "records a run per text leaf, equally
 * long on both sides", and both halves of that sentence are load-bearing: the
 * lengths make the pair a retraction, and the run is what lets the identity hold
 * *"at every offset inside a located run, which is every offset a caret can
 * occupy"*. A single run could not deliver the second half on a body that spells a
 * leaf with escapes — the run is equally long, so it cannot cover the leaf's
 * spelling, so the spelling's tail fell outside every run and every offset after
 * the first escape resolved to the wrong PM position while all of §4's *stated*
 * properties still held. So the leaf is cut **at its escapes** and each piece is a
 * run; the escape's own two characters are the gap between two runs, which is where
 * §4's stated clamp applies.
 */
export interface ProjectionRun extends ProjectionBlock {
  /**
   * Which of the three locators resolved this run, so the map says **how** it was
   * located and not only that it was. Recorded: without it the
   * corpus test could only count totals, and a total is exactly the shape a silent
   * rescue preserves — a leaf neither of the first two searches finds is picked up
   * by the fallback and `runs.length` still reads the same.
   */
  matched: RunMatch;
}

export interface ProjectionMap {
  /** The body projection these offsets are measured against — `serialize(doc)`. */
  body: string;
  /** The doc's `nodeSize`, so a PM position can be clamped rather than trusted. */
  docSize: number;
  blocks: ProjectionBlock[];
  runs: ProjectionRun[];
  /**
   * Indices into `blocks` whose text leaves could **not** all be located, so
   * those blocks convert at block granularity. Measured: `[]` for all 64 blocks
   * of the §13 corpus. It exists because the alternative is a map that is wrong
   * and says nothing.
   */
  unlocated: number[];
}

/** How a run was located. `standalone` is the common case; the other two are
 *  measured, not hypothetical.
 *
 * **Produced and asserted per leaf.** Instrumenting `locate` over the whole
 *  §13 corpus gives the split: **72 of 76 runs resolve on
 *  the first search, 4 on the second** (`nested-emphasis`'s three, and the fence
 *  whose content is backticks), and **the third search fires zero times**. The map
 *  now records the split per run, `seam.test.ts` asserts it **per leaf** rather
 *  than by total, and the third locator is exercised by a hand-built fixture
 *  instead of resting on the corpus not covering it. */
export type RunMatch = 'standalone' | 'raw' | 'escaped';

/** §5's escape character set, for the escape-tolerant locator. */
const ESCAPABLE_SET = new Set('\\`*_{}[]()#+-.!>~|');

/** Regex source for `ch` as a literal. Every character goes through this, so a
 *  locator's pattern can never contain a live metacharacter. */
const literalOf = (ch: string): string => (/[\\^$.|?*+()[\]{}]/.test(ch) ? `\\${ch}` : ch);

/** `doc` as a `doc`-shaped node around `children`, for serializing a subset. */
const docOf = (children: readonly PmNode[]): PmNode =>
  caotangSchema.topNodeType.create(null, children.slice()) as PmNode;

/**
 * `text` as it may appear in a body: every punctuation character may carry §5's
 * `\` escape. This is not a second implementation of remark-stringify's escaping —
 * it is the *inverse* of one character class, and it is only ever used after the
 * exact and raw searches have both failed.
 *
 * **The construction was wrong until 2026-10-06, and nothing could see it because
 * this branch never fired**. It read `text.replace(ESCAPABLE, '\\?$&')`, and
 * `'\\?$&'` is regex source `\?` — a **literal question mark** — so it searched for
 * `?<punct>` where §5 writes `\<punct>`. For text carrying a backslash before an
 * escapable character it emitted `\\?*`: two quantifiers on one atom, so
 * `new RegExp` **threw `SyntaxError: Nothing to repeat` out of
 * `buildProjectionMap`**. Reachable from ordinary Markdown — `**a\*b** and 2. c\*d`
 * is one paragraph with one text leaf, and locating it threw.
 *
 * The pattern is now built **character by character**: every character is emitted
 * as a literal, and an escapable one is preceded by `\\?` — an *optional* literal
 * backslash, which is what "escape-tolerant" means and what the old chain was
 * reaching for. Two properties this shape has and the string-replace chain did not:
 * **no input can produce an invalid pattern** (no quantifier is ever emitted), and
 * a `?` in the text is matched literally.
 */
const escapeTolerant = (text: string): RegExp =>
  new RegExp(
    Array.from(text)
      .map((ch) => (ESCAPABLE_SET.has(ch) ? `\\\\?${literalOf(ch)}` : literalOf(ch)))
      .join(''),
  );

/**
 * Where `text` begins inside `standalone`, and the slice of `standalone` it
 * occupies — **the leaf's body spelling**.
 *
 * This exists because the search `locate` used is `-1` on precisely the leaves
 * that carry an escape. §5 writes a leaf as `wrapper + escape(text) + wrapper`,
 * so `standalone.indexOf(text)` finds nothing for `a*b` spelled `a\*b`, and the
 * `+ 0` that stood in for it placed the run on the **wrapper's** first character:
 * measured, `**a\*b**` located its leaf's run at body 0 where the leaf starts at 2,
 * and `**ab**` — no escape, the same code path — located it correctly at 2. The
 * defect was invisible for every leaf without an escape, which is why §4's stated
 * properties all held.
 *
 * So the alignment is **walked, not searched**: from a candidate `inner`, a
 * character matches a character, and a `\` matches the character it escapes — two
 * body characters consuming one text character, which is exactly what §5's escape
 * is. The smallest `inner` that consumes the whole text wins, and the spelling is
 * what the walk consumed. `null` when no `inner` does, which is a leaf this arm
 * cannot place rather than one to place badly.
 */
const escapeAwareSpelling = (
  standalone: string,
  text: string,
): { inner: number; spelling: string } | null => {
  // The walk below is repeated per candidate `inner`, so an alignment that does
  // **not** exist costs O(standalone.length²) — and that case is the one the §13
  // corpus already contains, in the shape where remark spells a space as `&#x20;`
  // and the text is therefore not in the serialization at all. **Measured**: a
  // 3 000-character leaf of exactly that shape went from 1.2 ms to 6.9 ms on this
  // change, growing with the square of the leaf, and §4 calls the map "cheap at
  // per-scene scale". So the total steps are budgeted against the strings' own
  // lengths. A delimiter is a few characters, so an alignment that **does** exist is
  // reached in a small multiple of L; a search that would exceed the budget is not
  // about to succeed, so it returns `null` and the leaf falls through to arms 2 and
  // 3 — which is where those entity leaves already resolved, so the budget changes
  // no measured outcome and only caps a search that was already going to fail.
  const budget = standalone.length * 8 + text.length;
  let spent = 0;
  for (let inner = 0; inner <= standalone.length; inner += 1) {
    let i = inner;
    let j = 0;
    while (i < standalone.length && j < text.length) {
      if (spent >= budget) return null;
      spent += 1;
      if (standalone[i] === '\\' && standalone[i + 1] === text[j]) {
        i += 2;
        j += 1;
        continue;
      }
      if (standalone[i] !== text[j]) break;
      i += 1;
      j += 1;
    }
    if (j === text.length) return { inner, spelling: standalone.slice(inner, i) };
  }
  return null;
};

/** One maximal stretch of a body spelling that maps 1:1 onto the leaf's text. */
interface SpellingSegment {
  /** Offset within the spelling — which is an offset within the body. */
  bodyFrom: number;
  /** Offset within the leaf's text — which is an offset within the PM span. */
  pmFrom: number;
  /** The same count of body characters and of text characters, by construction. */
  length: number;
}

/**
 * A body spelling cut at its escapes into the pieces that map 1:1 onto the leaf's
 * text, so that **every run the map records is equally long on both sides** — §4's
 * invariant, kept rather than amended.
 *
 * This choice looks unavailable at first and turns out to be the only one that
 * is: a span that covers the leaf's matched text cannot also be
 * equally long while the PM text differs, so the run cannot be widened — but the
 * leaf does not need one run. A leaf whose spelling is ` and 2. c\*d` for the text
 * ` and 2. c*d` is two runs (` and 2. c`, `d`) and one gap of one character, and that
 * gap is the **backslash** — §5's syntax. §4's own words for a body position with no
 * PM counterpart are *"offsets clamp to the nearest text position"*, so the
 * backslash clamps and every character a caret can occupy lands inside a run.
 * Measured on the fix, `d` at body 19 resolves to PM 14 — the `d` — where the old
 * single run gave 15.
 *
 * **Measured over the §13 corpus**, five leaves carry an escape and all five were
 * mis-placed before this: `escape-bracket`, `footnote-reference`, `html-raw-block`,
 * `html-raw-inline` and `obsidian-heading-spacing`. `escape-bracket`'s run read
 * `not \[a link` against the PM text `not [a link]` — the backslash inside a run that
 * cut the closing bracket off. Every one of them now reads the same string on both
 * sides, which is what the seam tests assert.
 *
 * A spelling with no escape yields exactly one segment covering all of it, so the
 * overwhelmingly common case is unchanged: the §13 corpus's 76 runs and its
 * 72/4/0 split are the same after this as before.
 */
const segmentsOf = (spelling: string, text: string): SpellingSegment[] => {
  const out: SpellingSegment[] = [];
  // **A spelling that IS the text consumed no escapes.** §5's backslash is a
  // Markdown *inline* escape, and remark writes fenced content literally: a regex
  // or a Windows path inside a fence keeps its backslashes in both the body and
  // the text, so the two strings are equal. Splitting there would consume a body
  // character with no text character, so every run after the backslash would map
  // one character to the left — a self-consistent wrong range the anchor ladder's
  // own verification cannot catch, because it verifies the anchor against the same
  // shifted map. The identity is exact and needs no `fenced` flag: an escape the
  // walk did consume lengthens the spelling, so equality holds only when none did.
  if (spelling === text) {
    return spelling.length === 0 ? out : [{ bodyFrom: 0, pmFrom: 0, length: spelling.length }];
  }
  let i = 0;
  let pm = 0;
  let start = 0;
  let pmStart = 0;
  while (i < spelling.length) {
    if (spelling[i] === '\\' && i + 1 < spelling.length) {
      if (i > start) out.push({ bodyFrom: start, pmFrom: pmStart, length: i - start });
      // One body character consumed and **no** text character: the backslash is
      // §5's syntax. The character it escapes is text, so the next iteration pairs
      // it with a PM character like any other — cutting the whole `\*` pair would
      // leave the escaped character itself with no run, and measured
      // `obsidian-heading-spacing`'s `#Title` — serialized `\#Title` — then had its
      // `#` clamped to block granularity where the old single run had located it.
      i += 1;
      start = i;
      pmStart = pm;
      continue;
    }
    i += 1;
    pm += 1;
  }
  if (i > start) out.push({ bodyFrom: start, pmFrom: pmStart, length: i - start });
  return out;
};

/** Clamp rather than throw: §4 says offsets map to the nearest position. */
const clamp = (value: number, lo: number, hi: number): number =>
  value < lo ? lo : value > hi ? hi : value;

/** Index of the last entry with `start <= value`, or -1. Bisection. */
const lastAtOrBefore = <T>(entries: readonly T[], value: number, start: (e: T) => number): number => {
  let lo = 0;
  let hi = entries.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (start(entries[mid]!) <= value) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
};

const runAtBody = (map: ProjectionMap, offset: number): number => {
  if (map.runs.length === 0) return -1;
  const at = lastAtOrBefore(map.runs, offset, (r) => r.bodyStart);
  return at < 0 ? 0 : at;
};

const runAtPm = (map: ProjectionMap, pmPos: number): number => {
  if (map.runs.length === 0) return -1;
  const at = lastAtOrBefore(map.runs, pmPos, (r) => r.pmFrom);
  return at < 0 ? 0 : at;
};

const blockAtBody = (map: ProjectionMap, offset: number): ProjectionBlock | null => {
  if (map.blocks.length === 0) return null;
  const at = lastAtOrBefore(map.blocks, offset, (b) => b.bodyStart);
  return map.blocks[at < 0 ? 0 : at]!;
};

const blockAtPm = (map: ProjectionMap, pmPos: number): ProjectionBlock | null => {
  if (map.blocks.length === 0) return null;
  const at = lastAtOrBefore(map.blocks, pmPos, (b) => b.pmFrom);
  return map.blocks[at < 0 ? 0 : at]!;
};

/**
 * **Body offset → PM position.** A bisection over `runs`, falling back to
 * `blocks`, clamping to the nearest text position.
 *
 * The composition with {@link bodyOffsetFromPmPos} is the identity on every
 * offset inside a run, because a run is equally long on both sides. Offsets in
 * the gaps between runs (block separators, a hard break's `  \n`, a list marker)
 * have no PM counterpart and clamp — so the pair is a **retraction** there, and
 * applying it twice equals applying it once.
 */
export const pmFromBodyOffset = (map: ProjectionMap, offset: number): number => {
  const at = clamp(offset, 0, map.body.length);
  const index = runAtBody(map, at);
  if (index >= 0) {
    const run = map.runs[index]!;
    return run.pmFrom + clamp(at - run.bodyStart, 0, run.pmTo - run.pmFrom);
  }
  return blockAtBody(map, at)?.pmFrom ?? 0;
};

/**
 * Which run a PM position that sits on a run boundary belongs to.
 *
 * A boundary between two text runs is one PM position and two body offsets: the end
 * of the earlier run (before its closing markup) and the start of the later one
 * (after it). `start` takes the later run, which is right for a selection's start.
 * `end` takes the earlier one, which is right for a selection's end: the selection
 * `strong` in `**strong** text` ends at the `g`, not after the `**` that follows it.
 * Measured on the live adapter (2026-10-08): with `start` only, a selection of a
 * bold, emphasised, code or linked run captured its closing markup into `exact`.
 */
export type PmAssoc = 'start' | 'end';

/**
 * **PM position → body offset.** The mirror of
 * {@link pmFromBodyOffset}, and the reason the two are one function's worth of
 * decision rather than two: the same bisection, the same clamp, the same
 * fallback. §4's fixture sentence names this direction first, and it is the
 * direction an agent's anchor arrives in.
 *
 * `assoc` decides only the run boundaries described on {@link PmAssoc}. Its default
 * is the value every existing caller and fixture was written against, so passing
 * nothing changes nothing.
 */
export const bodyOffsetFromPmPos = (map: ProjectionMap, pmPos: number, assoc: PmAssoc = 'start'): number => {
  const at = clamp(pmPos, 0, map.docSize);
  let index = runAtPm(map, at);
  if (index > 0 && assoc === 'end' && map.runs[index]!.pmFrom === at && map.runs[index - 1]!.pmTo === at) {
    index -= 1;
  }
  if (index >= 0) {
    const run = map.runs[index]!;
    return run.bodyStart + clamp(at - run.pmFrom, 0, run.bodyEnd - run.bodyStart);
  }
  return blockAtPm(map, at)?.bodyStart ?? 0;
};

/**
 * A PM position that text can be inserted at, or `null` if the document holds no
 * position that can take it.
 *
 * §4: primitives "never throw for content reasons (offsets map to nearest
 * position)". A body offset inside a hard break or a list marker is exactly such
 * a case, and `tr.insertText` at a `between` position is not an error this seam is
 * allowed to raise at the caller — so the offset is walked to the nearest
 * position ProseMirror can accept. The empty document is the case that makes this
 * a function: one empty paragraph has **no text leaf at all**, so the map has no
 * runs and the only writable position is the paragraph's own content start.
 */
export const textPositionFor = (map: ProjectionMap, offset: number): number | null => {
  const at = clamp(offset, 0, map.body.length);
  const index = runAtBody(map, at);
  if (index >= 0) {
    const run = map.runs[index]!;
    // Before the first run, the offset is in the leading syntax of the first text-bearing
    // block: a heading's `# `, a list marker, a blockquote's `> `, a scene separator's
    // `***`. The nearest text position is the start of that run. Without this line the
    // arithmetic below gives `pmFrom + (a negative within)`: `-1` for `# Title`, and a
    // container position (not a text position) for `- one`, which an insert then fits
    // into the list item's neighbour.
    if (at < run.bodyStart) return run.pmFrom;
    const within = at - run.bodyStart;
    // Inside this run's text, or at its very end: both are positions text can
    // take. Past it (a hard break, a list marker, the block's own syntax) the
    // offset belongs to whatever comes next.
    if (within <= run.pmTo - run.pmFrom) return run.pmFrom + within;
    return map.runs[index + 1]?.pmFrom ?? run.pmTo;
  }
  const block = blockAtBody(map, at);
  if (!block) return null;
  // A block's own content starts one position after the block does, and that is
  // the only writable position in a document with no text at all.
  return block.pmFrom + 1;
};

/** Walk a doc's top-level blocks, yielding each with its absolute PM position. */
function topBlocks(doc: PmNode): Array<{ node: PmNode; from: number }> {
  const out: Array<{ node: PmNode; from: number }> = [];
  // **Zero**, not one: a document's content starts at position 0 and its first
  // child starts there too. Measured, and the measurement is the kind that
  // survives review because every value in the map stayed self-consistent —
  // `bodyOffsetFromPmPos(pmFromBodyOffset(o)) === o` holds just as beautifully
  // with every position one too high, and the symptom was a replacement that
  // landed one character to the right (`hello` → `hgoodbyeeworld`). A guard that
  // only checks internal consistency cannot see a constant offset; only a
  // transaction against a real document does.
  let pos = 0;
  doc.forEach((node) => {
    out.push({ node, from: pos });
    pos += node.nodeSize;
  });
  return out;
}

/**
 * The prefix algorithm, named so it can be a fallback and an oracle. Each block's end is
 * the length of `serialize` of the document truncated to that block, which is exact by
 * construction (it is what a save of that prefix writes) and **quadratic**: every block
 * re-renders everything before it. A 400-paragraph document took 6.4 s this way, so it is no longer the mechanism, only the answer `blockSpans` is checked against.
 */
export const prefixBlockSpans = (doc: PmNode, body: string): ProjectionBlock[] => {
  const nodes = topBlocks(doc);
  const blocks: ProjectionBlock[] = [];
  for (const [i, { node, from }] of nodes.entries()) {
    const bodyEnd =
      i === nodes.length - 1
        ? body.length
        : serialize(docOf(nodes.slice(0, i + 1).map((b) => b.node))).length;
    blocks.push({
      bodyStart: i === 0 ? 0 : blocks[i - 1]!.bodyEnd,
      bodyEnd,
      pmFrom: from,
      pmTo: from + node.nodeSize,
    });
  }
  return blocks;
};

/**
 * Where each block's span ends in `body`, from the blocks' own texts in document order.
 *
 * Each block's own text is found in the body at or after the previous block's text, so
 * the search is one pass over the body. The end of block `i` is one character past its
 * own text: the first newline of the separator after it. That is the length the prefix
 * serialization has, because a serialization ends in exactly one newline. The last block
 * ends at the body's end, and an empty block has no text to find, so its span is empty
 * and the separator before it belongs to the block after it.
 *
 * `null` when a text is not found in order. That means the body is not the concatenation
 * the recorder saw, and the caller falls back to the prefix algorithm rather than guess.
 */
const spanEnds = (body: string, texts: readonly string[]): number[] | null => {
  const ends: number[] = [];
  let cursor = 0;
  for (const [i, text] of texts.entries()) {
    let at = cursor;
    if (text.length > 0) {
      at = body.indexOf(text, cursor);
      if (at < 0) return null;
    }
    cursor = at + text.length;
    ends.push(i === texts.length - 1 ? body.length : cursor + 1);
  }
  return ends;
};

/**
 * Every block's span, from **one** save-path render (dialect.ts's recorder, built
 * for the banner) and a single pass over the body. O(n) where the prefix algorithm was
 * O(n²). The two agree on every block of a document with no empty block, which the
 * projection tests assert over the §13 corpus; an empty block's span is empty under this
 * rule and is covered by the partition test instead.
 */
const blockSpans = (doc: PmNode, nodes: readonly { node: PmNode; from: number }[], body: string): ProjectionBlock[] => {
  const boundaries = nodes.map(({ node, from }) => from + node.nodeSize);
  const { own } = saveSideOwnTexts(doc, boundaries, nodes.length);
  const ends = spanEnds(body, own);
  if (ends === null) return prefixBlockSpans(doc, body);
  return nodes.map(({ node, from }, i) => ({
    bodyStart: i === 0 ? 0 : ends[i - 1]!,
    bodyEnd: ends[i]!,
    pmFrom: from,
    pmTo: from + node.nodeSize,
  }));
};

/**
 * §4's map, built. **Linear walk of top-level blocks** (linear in
 * `serialize`, which is what the walk is: one serialization per block boundary
 * plus one per text leaf, and "cheap at per-scene scale" is §4's own claim about
 * this).
 *
 * The three locators, in order, because the first two are exact and the third is
 * a measured fallback rather than a guess — over the §13 corpus: 77 runs
 * located by their own serialization, 4 by raw text, 0 by the escape-tolerant
 * search, 0 blocks degraded.
 */
export const buildProjectionMap = (doc: PmNode): ProjectionMap => {
  const body = serialize(doc);
  const nodes = topBlocks(doc);
  const blocks = blockSpans(doc, nodes, body);

  const runs: ProjectionRun[] = [];
  const unlocated: number[] = [];
  for (const [i, { node, from }] of nodes.entries()) {
    const slice = body.slice(blocks[i]!.bodyStart, blocks[i]!.bodyEnd);
    let cursor = 0;
    let complete = true;
    // The initial `fenced` stays `false`: `walkTextLeaves` only *or*s the flag in
    // as it descends, so a fence nested in another block is marked, while the
    // arm-1 wrapper for a top-level fence stays the paragraph — the wrapper that
    // the corpus's measured 77/4/0 split was pinned against.
    walkTextLeaves(node, from, false, (leaf, pos, fenced) => {
      const text = leaf.text ?? '';
      if (text.length === 0) return;
      const hit = locate(slice, cursor, leaf, fenced);
      if (!hit) {
        complete = false;
        return;
      }
      // **One run per escape-free segment of the leaf's body spelling**, and the
      // spelling is what advances the cursor. Both halves belong together: advancing
      // by `text.length` against a body that holds `text` plus its escapes would
      // start every leaf after the first escaped one inside the previous leaf's tail.
      const base = blocks[i]!.bodyStart + hit.at;
      for (const segment of segmentsOf(hit.spelling, text)) {
        runs.push({
          bodyStart: base + segment.bodyFrom,
          bodyEnd: base + segment.bodyFrom + segment.length,
          pmFrom: pos + segment.pmFrom,
          pmTo: pos + segment.pmFrom + segment.length,
          matched: hit.matched,
        });
      }
      cursor = hit.at + hit.spelling.length;
    });
    if (!complete) unlocated.push(i);
  }

  return { body, docSize: doc.nodeSize, blocks, runs, unlocated };
};

/**
 * Every text leaf of a block, with its **absolute** PM position and whether it is
 * inside a fence.
 *
 * `descendants` is not used for the position, and the reason is worth recording
 * because it is off by one in a way that survives a casual look: it reports
 * positions relative to the node's **content start**, so a document's first
 * paragraph comes back as `0` and the text inside it as `1`, while their absolute
 * positions are `0` and `1 + 1`. The absolute position of a child is
 * `absolute(parent) + 1 + offset`, which is what this walk computes — and
 * threading `fenced` through the same walk is why it is a walk at all.
 */
const walkTextLeaves = (
  node: PmNode,
  base: number,
  fenced: boolean,
  onText: (leaf: PmNode, pos: number, fenced: boolean) => void,
): void => {
  node.forEach((child, offset) => {
    const pos = base + 1 + offset;
    if (child.isText) {
      onText(child, pos, fenced);
      return;
    }
    if (child.isLeaf) return;
    walkTextLeaves(child, pos, fenced || child.type.name === 'code_block', onText);
  });
};

/**
 * Where `text` starts inside `slice`, at or after `cursor`, and **which of the
 * three locators found it**. Returns `null` when none applies, which degrades that
 * block rather than inventing an offset.
 *
 * The `matched` half is not decoration: it is what turns "the split is 72/4/0"
 * from a note into a value every consumer can check.
 */
const locate = (
  slice: string,
  cursor: number,
  leaf: PmNode,
  fenced: boolean,
): { at: number; spelling: string; matched: RunMatch } | null => {
  const text = leaf.text ?? '';
  // 1. The leaf's own serialization, in the wrapper its parent gives it.
  const wrapped = docOf([
    fenced
      ? (caotangSchema.nodes.code_block!.create(null, [leaf]) as PmNode)
      : (caotangSchema.nodes.paragraph!.create(null, [leaf]) as PmNode),
  ]);
  const standalone = serialize(wrapped).replace(/\n$/, '');
  if (standalone.length > 0) {
    const at = slice.indexOf(standalone, cursor);
    // The text sits **inside** the wrapper, and a marked leaf's delimiters are
    // not symmetric -- a link's is `[text](url)`, so splitting the difference
    // would place the run inside the URL -- so where the text falls inside the
    // serialization is walked (`escapeAwareSpelling`) rather than assumed to be
    // the start: `standalone.indexOf(text)` is -1 for every leaf whose
    // spelling carries an escape, and a `+ 0` standing in for it placed the
    // run on the **wrapper's** first character -- measured, `**a\*b**` located
    // its leaf at body 0 where the leaf starts at 2, and the identical code
    // path located `**ab**` correctly at 2.
    if (at >= 0) {
      const aligned = escapeAwareSpelling(standalone, text);
      if (aligned) {
        return { at: at + aligned.inner, spelling: aligned.spelling, matched: 'standalone' };
      }
      // Not alignable: a leaf this arm cannot place. Arms 2 and 3 both still
      // apply to it, so fall through rather than place it badly.
    }
  }
  // 2. The raw text. Measured: the four leaves this catches are
  //    `nested-emphasis`'s three — remark escapes a space at a delimiter
  //    boundary, so a leaf ending in a space serializes as `_outer&#x20;_` — and
  //    the fence whose content is backticks.
  const raw = slice.indexOf(text, cursor);
  if (raw >= 0) return { at: raw, spelling: text, matched: 'raw' };
  // 3. Escape-tolerant, because §5 escapes on the way out and both searches
  //    above look for unescaped text.
  //    Measured: over the whole §13 corpus this search returns null for every
  //    one of the 76 runs, so the corpus locates **nothing** here. That includes
  //    `escape-bracket`, `html-raw-block`, `html-raw-inline` and
  //    `footnote-reference`, which all resolve on search 1, because §5 leaves
  //    those sequences unescaped. Kept: the asymmetry is real for a case the
  //    corpus does not cover. It is exercised all the same: the map records
  //    the locator per run, and `seam.test.ts` drives this branch with a
  //    hand-built shape and asserts `matched: 'escaped'` on it, so a regexp here
  //    that can never match fails that test.
  //    What the match returns is the **spelling**, escapes and all, so the
  //    run it produces can be cut at them. The optional `\` in the pattern is
  //    what makes the match tolerant; the spelling it captured is what makes
  //    the placement exact.
  const found = escapeTolerant(text).exec(slice.slice(cursor));
  return found ? { at: cursor + found.index, spelling: found[0], matched: 'escaped' } : null;
};

/** `doc` as a `doc`-shaped node around `children`, for serializing a subset. */
// ---------------------------------------------------------------------------
// The banner's presentation
// ---------------------------------------------------------------------------

/**
 * One banner entry: the members merged, and **how many**. A group that
 * reports '1' where two nodes warned is a lie about the input, so `nodes` is
 * not optional and the corpus test sums it against the input length.
 */
export interface LossWarningGroup {
  code: LossWarning['code'];
  mdastType: string;
  /** The line, or `null` when the members carried no position (mdast's own
   *  `position` is optional, and inventing a line would be a claim about a
   *  location rather than about a loss). */
  line: number | null;
  nodes: number;
  warnings: LossWarning[];
}

/**
 * §4's banner, grouped for display. **Not called by the carrier** — see
 * {@link LoadDiagnostics}.
 *
 * The key is `(code, mdastType, line)`, and it is sound rather than convenient
 * because §3.3's table assigns **one code per mdast type**: within a group, every
 * member really is the same event reported per node. The rejected
 * `mdastType`-only key would merge two different codes on one line; dropping
 * `code` from the key is that failure one layer out.
 *
 * Order is the input's order of first appearance, verbatim — **which is not
 * document order, and used to be read as if it were.**
 *
 * It does **not** read top to bottom in the order the constructs were met:
 * §3.3's merged-inline-run warnings are appended
 * **after** the compile (`pipeline.ts`, deliberately: one ordering rule for one
 * list). The array is therefore handlers-then-structural, and a document whose
 * merged-run loss sits *above* a degrade construct hands the banner the higher
 * line last. Measured on `_gone and _struck_ together_` + a `<div>` three lines
 * below: the array is `[unsupported-node:html@5, lossy-structure:emphasis@1]` and
 * the groups read **5, 1**. A sort is not missing by
 * accident and not a bug here — **grouping must not reorder**, because the warning
 * carrier contract is "no merging, no reordering, no dedupe" — so whether the
 * *product* wants a top-to-bottom banner is a separate decision, not this function's.
 *
 * What is pinned here instead is the true rule, so the next reader inherits a
 * fact rather than a wish: the order is preserved exactly as given
 * (`test/merged-runs.test.ts`, "the array is handlers-then-structural, and the
 * banner shows it").
 */
export const groupLossWarnings = (warnings: readonly LossWarning[]): LossWarningGroup[] => {
  const groups: LossWarningGroup[] = [];
  const byKey = new Map<string, LossWarningGroup>();
  for (const warning of warnings) {
    const line = warning.position?.line ?? null;
    // A JSON tuple rather than a delimited string. A delimiter is either a
    // character that can legitimately appear in an `mdastType` — nothing stops a
    // caller-supplied type from holding a space — or a control character, and
    // `test/searchable-sources.test.ts` (the guard) rejects a source file that
    // carries one. This was first written with literal NUL separators, and that
    // guard rejected the file on the slice that wrote it.
    const key = JSON.stringify([warning.code, warning.mdastType, line]);
    const existing = byKey.get(key);
    if (existing) {
      existing.warnings.push(warning);
      existing.nodes += 1;
      continue;
    }
    const group: LossWarningGroup = { code: warning.code, mdastType: warning.mdastType, line, nodes: 1, warnings: [warning] };
    byKey.set(key, group);
    groups.push(group);
  }
  return groups;
};
