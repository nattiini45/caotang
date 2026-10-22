/**
 * The `coherence.json` data model — [coherence.md §3–§5](../../../docs/architecture/coherence.md).
 *
 * Field names, enum members and limits are the spec's. Where the engine needs a
 * value the spec does not name (a one-line finding message, the free-text note of
 * a dismissal, the run's report lines) the field is optional and additive, and it
 * is marked as such beside its declaration. Nothing here is a second source of
 * truth for the manuscript: a finding quotes it, a scene declaration sits beside it.
 */

/** project-format §1: a top-level file beside `caotang.json`, loaders ignore it when unknown. */
export const COHERENCE_FILE = 'coherence.json';

/** §3: `formatVersion: 1`. The file is additive, so there is no bump (project-format §2). */
export const COHERENCE_FORMAT_VERSION = 1 as const;

/** §3 `Evidence.quote`: "≤ 300 chars, verbatim slice". */
export const EVIDENCE_QUOTE_LIMIT = 300;

/** §3 `WorldRule.text`: "≤ 300 chars". */
export const WORLD_RULE_TEXT_LIMIT = 300;

/**
 * Engine assumption, not a spec value: §3 says run history is "capped (§6)" and §6
 * names no number. Fifty keeps the Run history section short and the file small.
 */
export const RUN_HISTORY_LIMIT = 50;

/** Engine assumption: a dismissed or fixed finding keeps its last ten re-detections. */
export const REDETECTION_LIMIT = 10;

/** §6.3 free-text note on a dismissal or fix. The spec sets no number; this is one. */
export const NOTE_LIMIT = 500;

/**
 * project-format §4's rolling depth, applied to `coherence.json`: the previous
 * generations are kept as `coherence.json.bak.1` … `.bak.3`, and a load restores
 * from the newest one that reads (file.ts).
 */
export const COHERENCE_SNAPSHOT_COUNT = 3;

/** §6.2: a scope over more than this many documents needs explicit approval. */
export const SCAN_DOC_GUARD = 20;

/** §7 tool 16: `maxFindings` defaults to 50 and is capped at 200. */
export const MAX_FINDINGS_DEFAULT = 50;
export const MAX_FINDINGS_CAP = 200;

export const FINDING_CLASSES = ['deterministic', 'llm'] as const;
export type FindingClass = (typeof FINDING_CLASSES)[number];

export const FINDING_SEVERITIES = ['error', 'warning', 'info'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const FINDING_STATUSES = ['open', 'dismissed', 'fixed'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export const RUN_KINDS = ['deterministic', 'llm'] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export const RUN_STATUSES = ['complete', 'partial', 'discarded'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const WORLD_RULE_ORIGINS = ['manual', 'found'] as const;
export type WorldRuleOrigin = (typeof WORLD_RULE_ORIGINS)[number];

/**
 * The deterministic registry, closed (§5.4: adding a check is a spec change with fixtures). The first eight are §5.1's.
 * Six more come from the media-track specs, which each say they ride this rule: screenplay.md §4 adds two
 * (`script.cue-*`), storyboard.md §5 adds one (`script.shot-coverage`), and dialogue-narrative.md §5 adds three
 * (`branch.*` and `dialogue.speaker-unknown`). `timeline.gap` (§5.1) and `plot.unresolved-thread` (§5.5) are the last two. The count is 8 + 2 + 1 + 3 + 1 + 1 = 16.
 * New ids are appended, so the order of the first eight, which the run report and the check order depend on, does not move.
 */
export const DETERMINISTIC_CHECK_IDS = [
  'codex.alias-collisions',
  'codex.never-mentioned',
  'timeline.order-drift',
  'timeline.relation',
  'timeline.window',
  'timeline.overlap',
  'pov.coverage',
  'presence.expected',
  'script.cue-collision',
  'script.cue-consistency',
  'script.shot-coverage',
  'branch.loose-end',
  'branch.dead-end',
  'dialogue.speaker-unknown',
  'timeline.gap',
  'plot.unresolved-thread',
] as const;
export type DeterministicCheckId = (typeof DETERMINISTIC_CHECK_IDS)[number];

/** The three checks whose findings the dialogue module computes and the app passes in (dialogue-narrative.md §5). */
export const BRANCH_CHECK_IDS = ['branch.loose-end', 'branch.dead-end', 'dialogue.speaker-unknown'] as const;
export type BranchCheckName = (typeof BRANCH_CHECK_IDS)[number];

/**
 * The plain-words name of each check, for the Settings section and the scope line. The spec names the checks by id;
 * a writer reads these. Kept beside the ids so a check added to the registry cannot ship without a label.
 */
export const DETERMINISTIC_CHECK_LABELS: Readonly<Record<DeterministicCheckId, string>> = {
  'codex.alias-collisions': 'Two codex entries share a name or alias',
  'codex.never-mentioned': 'A codex entry is never named in the manuscript',
  'timeline.order-drift': 'Scenes run out of chronological order',
  'timeline.relation': 'A scene is placed before a scene it must follow',
  'timeline.window': 'A scene falls outside its folder’s declared days',
  'timeline.overlap': 'Sibling scenes overlap in time',
  'pov.coverage': 'A declared point of view is never named in its scene',
  'presence.expected': 'A character expected in a scene is never named there',
  'script.cue-collision': 'A screenplay character cue matches no codex entry',
  'script.cue-consistency': 'One screenplay character is cued with two spellings',
  'script.shot-coverage': 'Storyboard shots miss dialogue, a duration or an anchor',
  'branch.loose-end': 'A dialogue branch runs out without an ending',
  'branch.dead-end': 'A dialogue knot can never be reached',
  'dialogue.speaker-unknown': 'A dialogue speaker matches no codex entry',
  'timeline.gap': 'A scene is days after the scene before it',
  'plot.unresolved-thread': 'A thread’s declared payoff is not in the manuscript',
};

/** §5.3's five ConStory categories. The enum is closed; subtypes are model-proposed strings. */
export const LLM_CATEGORIES = ['timeline-plot', 'characterization', 'world-building', 'factual', 'narrative-style'] as const;
export type LlmCategory = (typeof LLM_CATEGORIES)[number];

/** §5.2.1: `timelineMode`. Absent means `linear`. `time-skip` exempts `timeline.gap` and no other check (§11 D12). */
export const TIMELINE_MODES = [
  'linear',
  'flashback',
  'flash-forward',
  'parallel',
  'frame',
  'dream',
  'mythic',
  'backstory',
  'simultaneous',
  'circular',
  'time-skip',
] as const;
export type TimelineMode = (typeof TIMELINE_MODES)[number];

/** A quoted span. Offsets are into the body projection (project-format §3), never into the editor. */
export interface Evidence {
  docId: string;
  quote: string;
  from: number;
  to: number;
  /** Cross-run reporting key only (edit-anchors §4) — never an apply-time anchor. Unset until a hash is specified. */
  paraHash?: string;
}

/** A later run that found a dismissed or fixed finding again (§6.1 cases 2 and 3). */
export interface Redetection {
  runId: string;
  at: string;
  evidence: Evidence[];
}

export interface ModelMeta {
  model: string;
  promptTokens: number;
  completionTokens: number;
}

export interface Finding {
  /** "f_" + 10 Crockford base32 (§3). */
  id: string;
  /** The run that produced or last updated it. */
  runId: string;
  class: FindingClass;
  /** A §5.1 check id, or `llm:<category>` for the model-judged class (§4.1). */
  checkId: string;
  /** Stable subtype key. */
  type: string;
  severity: FindingSeverity;
  status: FindingStatus;
  /** `lower(entity + '|' + attribute)` (§4.2). Findings sharing it render as one group card. */
  factGroup: string;
  /**
   * 1–2 passages (§3). Codex-level findings (alias collisions, never-mentioned)
   * quote no manuscript passage, so their list is empty; the spec is silent there.
   */
  evidence: Evidence[];
  /** Evidence chain, llm class only (§3). */
  reasoning?: string;
  modelMeta?: ModelMeta;
  createdAt: string;
  updatedAt: string;
  /** §6.3: required when `status` is `dismissed`; a value from the picker. */
  dismissedReason?: string;
  /** §3: finding id that replaced this one. Reserved; nothing supersedes yet. */
  supersededBy?: string;
  /** Additive (not in §3): the one-line statement the inbox card shows. */
  message: string;
  /** Additive (not in §3): the declaration side, rendered as the "expected" line (§5.1). */
  expected?: string;
  /** Additive (not in §3): the free-text note from the last dismissal or fix. */
  note?: string;
  /** Additive (not in §3): later runs that found this again while it was dismissed or fixed (§6.1). */
  redetections?: Redetection[];
  /**
   * Additive (not in §3): the run that created the finding. `runId` moves with every
   * update, so it cannot say who made the finding. Discard run (§7.1) needs that.
   */
  createdByRunId?: string;
  /**
   * Additive (not in §3): when the writer last touched the finding (dismiss, re-open,
   * mark fixed), or the agent's successful fix. A touched finding survives a discarded
   * run with its history (§7.1), whatever its status is now.
   */
  touchedAt?: string;
}

export interface CoherenceRun {
  /** "r_" + 10 base32. */
  id: string;
  at: string;
  kind: RunKind;
  checkIds: string[];
  /**
   * The documents the run read. `mode` is what the writer asked for (coherence.md §6.2), so "Run again" can scan the same scope;
   * a run recorded before it was kept has no mode (additive, so the format version does not change).
   */
  scope: { docIds: string[]; mode?: 'doc' | 'changed' | 'full' };
  findingsUpserted: string[];
  tokens?: { promptTokens: number; completionTokens: number };
  model?: string;
  status: RunStatus;
  /** Additive (not in §4.1): the run report, one plain line per fact (§7 "turn report"). */
  notes?: string[];
}

/** §5.5: a thread the writer declares on the scene that sets it up. `id` is the writer's handle, `payoff` the document that pays it off. */
export interface SceneThread {
  id: string;
  payoff: string;
  /** One line on what the payoff is for. No check reads it. */
  note?: string;
}

/** §5.2 plus §5.2.1 and §5.5. Keys of `sceneMeta` are binder node ids: documents, and folders for window spans. */
export interface SceneMeta {
  /** A codex entry id (§5.2). Free text is accepted and reported as an unanchored finding. */
  pov?: string;
  /** Integer days from project epoch 0. Offsets, never real dates (§5.2). */
  dayOffset?: number;
  /** Integer days, default 0 — a scene occupies one day unless declared (§5.2, §5.1 overlap note). */
  durationDays?: number;
  /** Finish-to-start dependencies on document ids (§5.2). */
  after?: string[];
  /** Codex entry ids that must be named in this scene (§5.2). */
  expectedPresent?: string[];
  /** §5.2.1. Absent is `linear`. */
  timelineMode?: TimelineMode;
  /** §5.5. Additive: absent and an empty list both mean the scene declares no thread. */
  threads?: SceneThread[];
}

export interface WorldRule {
  /** "w_" + 10 base32. */
  id: string;
  /** One sentence, at most {@link WORLD_RULE_TEXT_LIMIT} characters. */
  text: string;
  /** `manual` is writer canon; `found` is extracted and stays in review until anchored (§4.3). */
  origin: WorldRuleOrigin;
  source?: Evidence;
  verified?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewStateEntry {
  lastReviewedRevision: number;
  lastReviewedAt: string;
}

/** §3's `CoherenceFile`, one per project. */
export interface CoherenceFile {
  formatVersion: typeof COHERENCE_FORMAT_VERSION;
  findings: Finding[];
  runs: CoherenceRun[];
  sceneMeta: Record<string, SceneMeta>;
  worldRules: WorldRule[];
  reviewState: Record<string, ReviewStateEntry>;
}

export function emptyCoherenceFile(): CoherenceFile {
  return {
    formatVersion: COHERENCE_FORMAT_VERSION,
    findings: [],
    runs: [],
    sceneMeta: {},
    worldRules: [],
    reviewState: {},
  };
}

/**
 * §4.3: a rule is canon when the writer wrote it, or when an extraction was
 * anchored to a verified source span. An unanchored extraction is never canon.
 */
export function isCanonRule(rule: WorldRule): boolean {
  if (rule.origin === 'manual') return true;
  return rule.verified === true && rule.source !== undefined;
}
