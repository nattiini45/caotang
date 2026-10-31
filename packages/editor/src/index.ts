/**
 * `@caotang/editor` — the editor's headless engine surface.
 *
 * This is the whole of the editor package's public contract: the §3 schema, the
 * §3.3 handler table (exact class **and** the degrade rows §3.3 assigns a code
 * to), `LossWarning`, §5's `DialectNotice`, §5's load/save pair, **§7's two-lane
 * undo policy** (`laneOf`/`markLane`, the one place that reads §4's
 * `historyExcluded`), and **§4's `EditorApi` seam with its projection map**. Two
 * things are deliberately not exported, and each omission is a decision recorded
 * where it was made rather than a gap:
 *
 * - **The Tiptap adapter.** §4's `mount` is implemented in `src/tiptap/`, and it is
 *   exported from its own entry point, `@caotang/editor/tiptap`, because it needs a
 *   DOM, `@tiptap/core` and the store. What ships here is the *interface* plus the
 *   coordinate bridge, which is what §4 requires to be importable headless. The
 *   in-memory implementation `test/memory-api.ts` uses is a **fixture**, not a
 *   second engine: it exists because an interface nothing implements satisfies
 *   every test written about it.
 * - **A schema *factory*** — `caotangSchema` is a single module-level `Schema`
 *   instance, the same way `f64`'s was in the store's validator. Constructing
 *   it per call would make two schemas in one process, and nothing in the
 *   product needs that.
 *
 * Importing this package must not require an engine, a DOM, or a store, so
 * nothing here may grow a dependency on any of the three.
 *
 * `@caotang/editor-audit`'s degrade table is **not** re-exported. The audit keeps
 * its own exact-class table and its own `DEGRADE_CLASS` expectations
 *; re-exporting them here would make the
 * audit's *measurements* reachable as if they were the product's behaviour, and
 * `test/degrade.test.ts` asserts the two tables stay apart in both directions.
 */
export { caotangSchema } from './schema.js';
export {
  CANONICAL_STRINGIFY_OPTIONS,
  DEGRADE_MDAST_TYPES,
  EXACT_CLASS_MDAST_TYPES,
  SAVE_STRINGIFY_OPTIONS,
  SPEC_STRINGIFY_OPTIONS,
  TWO_SPACE_HARD_BREAK,
  createParseHandlers,
  createSerializeHandlers,
  warnMergedInlineRuns,
} from './handlers.js';
export type {
  LossWarning,
  MdastParent,
  ParseHandlers,
  PmState,
  SerializeHandlers,
} from './handlers.js';
export type { DialectCause, DialectNotice } from './dialect.js';
export { sniffDialect } from './dialect.js';
export { insertionOf, parse, parseFragment, parseWithDiagnostics, serialize } from './pipeline.js';
export {
  canonicalizeFootnoteTree,
  footnoteKey,
  isNumericLabel,
  planFootnotes,
  planPmFootnotes,
} from './footnotes.js';
export type { FootnotePlan, PlannedDefinition, PlannedNote, TreeFootnoteResult } from './footnotes.js';
export type { ParseResult } from './pipeline.js';
export { laneOf, markLane } from './lanes.js';
export type { Lane, LaneOptions } from './lanes.js';
export {
  bodyOffsetFromPmPos,
  buildProjectionMap,
  groupLossWarnings,
  pmFromBodyOffset,
  textPositionFor,
} from './seam.js';
export type {
  AgentEditInfo,
  AgentEditOutcome,
  EditorApi,
  EditorInstance,
  EditorMountOptions,
  EditorSelection,
  GhostController,
  LoadDiagnostics,
  LossWarningGroup,
  PmAssoc,
  ProjectionBlock,
  ProjectionMap,
  ProjectionRun,
  // Produced and asserted per leaf (2026-10-06): the union existed and
  // nothing returned it, so no consumer could say which locator located a run.
  RunMatch,
  ReviewApi,
  ReviewState,
  ReviewSuggestion,
  ReviewableEditorInstance,
  TextAnchor,
} from './seam.js';

// edit-anchors §3's ladder and §4's apply path. The
// ladder runs on the body projection and imports nothing from the bus or the
// store; §5's "engine-agnostic by construction" is the property that keeps the
// Lexical swap (§11) a real option rather than a claim.
export {
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
} from './edit-anchors.js';
export type {
  AnchorCandidate,
  AnchorMethod,
  AnchorRange,
  AnchorResolution,
  BitapLocator,
} from './edit-anchors.js';
export { ASK_BACK_OPTIONS, applyAnchoredEdit } from './anchored-apply.js';
export type {
  AnchoredEditCommand,
  AnchoredEditDispatch,
  AnchoredEditOutcome,
  AnchoredEditRequest,
  AnchoredEditResult,
} from './anchored-apply.js';

