/**
 * Which layers each tool assembles, and their budgets — [context-assembly.md](../../../docs/architecture/context-assembly.md)
 * §2 (the layer caps), §3 (the total and the per-tool defaults) and §7 (compact).
 *
 * The numbers are config-exposed in the spec (D3), so they live here as named constants
 * and a `ContextConfig` may override any capped layer. Nothing else in the package sets a
 * layer budget. The line-length limits a layer applies to its own text (the turn memory's
 * clip, for one) stay with that layer.
 */

import { LAYER_IDS, type AssemblyTool, type ContextConfig, type LayerId } from './types.js';

/** §2 LI: the cap on the writer's instructions and the memory index together, in tokens. */
export const DEFAULT_INSTRUCTIONS_BUDGET = 1_500;
/** §3: the total default prompt budget. */
export const DEFAULT_CONTEXT_BUDGET = 12_000;
/** §2 L5 and D3: the focus tail, in characters (about 750 tokens). */
export const DEFAULT_CONTINUATION_CHARS = 3_000;
/** provider-gateway §2: the default `maxOutputTokens`, used for the completion estimate. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
/** §2 L5, rewrite_selection: the immediate antecedent of a selection, in characters. */
export const ANTECEDENT_CHARS = 1_500;
/** §5: the focus text the preview shows before the "…" summary. */
export const PREVIEW_CHARS = 120;
/** §2 L6: the number of agent turns kept as conversation memory. */
export const TURN_LIMIT = 2;
/** agent-harness.md §3 row 10: a continuity scope longer than this is refused by the tool. */
export const SCOPE_DOCUMENT_LIMIT = 20;
/** §3: each scope document's tail under continuity.scan, one thousand tokens. */
export const SCOPE_TAIL_CHARS = 4_000;
/**
 * The headings and markers around the scope tails, across the whole scope. Each tail is
 * one thousand tokens, and a heading and a marker add to it, so the layer's cap carries
 * this allowance on top of twenty thousand. Without it the last documents would be cut
 * by the budget they were sized for.
 */
export const SCOPE_OVERHEAD_TOKENS = 1_000;
/** §3: the allowance for L0 and L7 added to a per-tool total. They are not capped (§2). */
export const RESERVED_TOKENS = 2_000;

/** Every layer, in §2's order. */
export const ALL_LAYERS: readonly LayerId[] = LAYER_IDS;

export interface ToolProfile {
  /** The layers the tool assembles. */
  readonly layers: readonly LayerId[];
  /** The base budget of each capped layer the tool includes, in tokens. */
  readonly budgets: Readonly<Partial<Record<LayerId, number>>>;
  /**
   * The total prompt budget when the config sets none. scene.draft and the meta tools use
   * the 12k default. The two wide tools have no single total in the spec, so their total is
   * their own caps plus the reserved allowance, which makes the total a consequence of the
   * per-tool numbers and not a second opinion about them.
   */
  readonly totalBudget: typeof DEFAULT_CONTEXT_BUDGET | 'sum-of-caps';
}

const PROFILES: Readonly<Record<AssemblyTool, ToolProfile>> = {
  'scene.draft': {
    layers: ALL_LAYERS,
    budgets: { LI: DEFAULT_INSTRUCTIONS_BUDGET, L1: 1_500, L2: 1_000, L3: 1_200, L4: 2_000, L5: 2_000, L6: 1_500 },
    totalBudget: DEFAULT_CONTEXT_BUDGET,
  },
  'dialogue.draft': {
    // The standard stack (dialogue-narrative §7): the container's Ink is the focus, its prior beats are L4 and the codex of its
    // speakers is L2. The budgets are the scene draft's, since the container is what a scene would be.
    layers: ALL_LAYERS,
    budgets: { LI: DEFAULT_INSTRUCTIONS_BUDGET, L1: 1_500, L2: 1_000, L3: 1_200, L4: 2_000, L5: 2_000, L6: 1_500 },
    totalBudget: DEFAULT_CONTEXT_BUDGET,
  },
  'continuity.scan': {
    // L2 expanded, L4 expanded to the synopses the tails leave out (scopeStoryBlock), and the
    // scope tails (1k tokens each, at most 20 documents).
    layers: ['L0', 'LI', 'L1', 'L2', 'L4', 'L5', 'L7'],
    budgets: { LI: DEFAULT_INSTRUCTIONS_BUDGET, L1: 1_500, L2: 2_500, L4: 6_000, L5: SCOPE_DOCUMENT_LIMIT * 1_000 + SCOPE_OVERHEAD_TOKENS },
    totalBudget: 'sum-of-caps',
  },
  delegate: {
    // A delegated agent starts from a fresh context (agent-harness §2, "Delegate"): the project summary, the codex per its
    // policies, and the structure, story and scope tails of the documents it was given. No L6: nothing of the parent's
    // conversation reaches it, and the brief is its L7.
    layers: ['L0', 'LI', 'L1', 'L2', 'L3', 'L4', 'L5', 'L7'],
    budgets: { LI: DEFAULT_INSTRUCTIONS_BUDGET, L1: 1_500, L2: 1_000, L3: 1_200, L4: 2_000, L5: SCOPE_DOCUMENT_LIMIT * 1_000 + SCOPE_OVERHEAD_TOKENS },
    totalBudget: 'sum-of-caps',
  },
  'synopsis.fill': {
    // The full document (cap 25k) and the structure; no codex, no story so far, no turns.
    layers: ['L0', 'LI', 'L1', 'L3', 'L5', 'L7'],
    budgets: { LI: DEFAULT_INSTRUCTIONS_BUDGET, L1: 1_500, L3: 1_200, L5: 25_000 },
    totalBudget: 'sum-of-caps',
  },
  meta: {
    // The metadata tools: system, project summary and task only.
    layers: ['L0', 'LI', 'L1', 'L7'],
    budgets: { LI: DEFAULT_INSTRUCTIONS_BUDGET, L1: 1_500 },
    totalBudget: DEFAULT_CONTEXT_BUDGET,
  },
};

export function profileFor(tool: AssemblyTool): ToolProfile {
  return PROFILES[tool];
}

/**
 * The capped budgets a call runs with: the profile's, then any config override, then
 * compact, which halves L2 and L4 (§7). A layer the tool does not include has no entry.
 */
export function effectiveBudgets(
  profile: ToolProfile,
  config: ContextConfig,
  compact: boolean,
): Partial<Record<LayerId, number>> {
  const out: Partial<Record<LayerId, number>> = {};
  for (const id of LAYER_IDS) {
    const fromProfile = profile.budgets[id];
    if (fromProfile === undefined) continue;
    const override = config.layerBudgets?.[id];
    let value = override !== undefined && Number.isFinite(override) ? Math.max(0, Math.floor(override)) : fromProfile;
    if (compact && (id === 'L2' || id === 'L4')) value = Math.floor(value / 2);
    out[id] = value;
  }
  return out;
}

/** The total prompt budget a call is held to, in tokens. */
export function totalBudgetFor(
  profile: ToolProfile,
  budgets: Partial<Record<LayerId, number>>,
  config: ContextConfig,
): number {
  if (config.contextBudget !== undefined && Number.isFinite(config.contextBudget)) {
    return Math.max(0, Math.floor(config.contextBudget));
  }
  if (profile.totalBudget !== 'sum-of-caps') return profile.totalBudget;
  let sum = RESERVED_TOKENS;
  for (const id of LAYER_IDS) sum += budgets[id] ?? 0;
  return sum;
}
