/**
 * Thinking/effort mapping — one place that turns a normalised `ThinkingLevel` into the
 * wire fields a route documents, per `EffortStyle`.
 *
 * The rule the whole file defends: **a level the model's capability row does not list
 * is never sent**. When `level` is absent or not in `caps.effortLevels` the body gets
 * nothing — the provider default stands. The UI only offers listed levels, so this
 * guard is the second line, not the first.
 *
 * `thinking: 'off'` means "turn thinking off", which some models cannot do. Where the
 * row lists 'off' the style's off-value is sent; where it does not, nothing is sent.
 */

import type { ModelCaps, ThinkingLevel } from '../types.js';
import type { EffortStyle } from './types.js';

/** The thinking tokens each level stands for: the budget a budget-style route is sent, and the nominal share an estimate adds. */
const BUDGETS: Record<Exclude<ThinkingLevel, 'off'>, number> = {
  low: 1_024,
  medium: 4_096,
  high: 16_384,
  xhigh: 24_576,
  max: 32_768,
};

/** Anthropic's smallest thinking budget; the other budget routes are held to it too. */
const MIN_BUDGET = 1_024;

/** What a call is actually sent: the output cap, and the thinking level and budget that fit under it. */
export interface EffectiveOutput {
  /** The max_tokens actually sent. */
  readonly maxTokens: number;
  /** The thinking level actually sent: listed on the row, and mapped from `reasoningBudget` when no level was asked for. */
  readonly level?: ThinkingLevel;
  /** The thinking budget actually sent, when the style takes one. Always below `maxTokens`. */
  readonly budget?: number;
}

/** The nominal thinking tokens of an on-level; the plan card's estimate reads it for routes that take no budget. */
export function nominalThinkingTokens(level: ThinkingLevel): number {
  return level === 'off' ? 0 : BUDGETS[level];
}

/**
 * The listed on-level whose nominal budget is nearest `budget`; the lower level on a tie. A fixed table, so a budget
 * maps to the same level on every route that lists it. Undefined when the row lists no on-level.
 */
export function levelForBudget(budget: number, levels: readonly ThinkingLevel[]): ThinkingLevel | undefined {
  let best: Exclude<ThinkingLevel, 'off'> | undefined;
  for (const level of levels) {
    if (level === 'off') continue;
    if (best === undefined) best = level;
    else {
      const here = Math.abs(BUDGETS[level] - budget);
      const there = Math.abs(BUDGETS[best] - budget);
      if (here < there || (here === there && BUDGETS[level] < BUDGETS[best])) best = level;
    }
  }
  return best;
}

/** Whether the route takes the thinking level as a token budget that counts against the output cap. */
function takesBudget(style: string | undefined, caps: ModelCaps): boolean {
  return style === 'enable_thinking+budget' || (style === 'anthropic' && caps.thinkingShape !== 'adaptive');
}

/**
 * Settles one call's output cap and thinking before any adapter builds a body. A level the row does not list is dropped,
 * and a `reasoningBudget` stands in for a missing level. On a budget route the cap is raised to the budget plus the
 * caller's own cap (the room left for the answer), held to the model's documented maximum; when that clamp would leave the
 * budget at or above the cap, or the answer short of room, the budget is lowered (never below the minimum) rather than sent
 * into a 400. If even the minimum does not fit, thinking is left off. `off` and routes without a budget keep the cap as it is.
 */
export function effectiveOutput(input: {
  readonly cap: number;
  readonly level?: ThinkingLevel;
  readonly budget?: number;
  readonly caps: ModelCaps;
  readonly modelMaxOutput?: number;
  /** The effort style when the route supplies one the row does not state (a Messages route is 'anthropic'). */
  readonly style?: string;
}): EffectiveOutput {
  const { cap, caps } = input;
  const levels = caps.effortLevels ?? [];
  if (input.level === 'off') return levels.includes('off') ? { maxTokens: cap, level: 'off' } : { maxTokens: cap };
  const asked = input.budget !== undefined && Number.isFinite(input.budget) && input.budget > 0 ? Math.floor(input.budget) : undefined;
  const level = input.level !== undefined && levels.includes(input.level) ? input.level : asked === undefined ? undefined : levelForBudget(asked, levels);
  if (level === undefined || level === 'off') return { maxTokens: cap };
  if (!takesBudget(input.style ?? caps.effortStyle, caps)) return { maxTokens: cap, level };

  let budget = Math.max(MIN_BUDGET, asked ?? BUDGETS[level]);
  // A cap of 0 is "send none": there is no limit for the budget to exceed.
  if (cap <= 0) return { maxTokens: cap, level, budget };
  let maxTokens = cap + budget;
  if (input.modelMaxOutput !== undefined) maxTokens = Math.max(cap, Math.min(maxTokens, input.modelMaxOutput));
  // The clamp ate into the answer's room: keep at least the smaller of the caller's cap and half the ceiling for the answer.
  if (maxTokens < cap + budget) budget = Math.max(MIN_BUDGET, Math.min(budget, maxTokens - Math.min(cap, Math.floor(maxTokens / 2))));
  if (budget >= maxTokens) return { maxTokens: cap };
  return { maxTokens, level, budget };
}

/** The wire value of a level on the `reasoning_effort` family, which tops out at 'high' and calls off 'none'. */
function highest(level: ThinkingLevel): string {
  return level === 'max' || level === 'xhigh' ? 'high' : level === 'off' ? 'none' : level;
}

/**
 * Writes the effort fields for `level` onto `body`, in the shape `style` documents.
 * Mutates `body`; a no-op when the level is not offered or the style is 'anthropic'
 * (the Messages adapter maps its own `thinking`/`output_config` pair). `budget` is the
 * settled token budget from {@link effectiveOutput}, used by the styles that take one.
 */
export function applyEffort(
  body: Record<string, unknown>,
  style: EffortStyle | string | undefined,
  level: ThinkingLevel | undefined,
  caps: ModelCaps,
  budget?: number,
): void {
  if (level === undefined || style === undefined || style === 'anthropic') return;
  const levels = caps.effortLevels;
  if (levels === undefined || levels.length === 0 || !levels.includes(level)) return;
  const on = level !== 'off';

  switch (style) {
    case 'reasoning_effort':
      body.reasoning_effort = highest(level);
      break;
    case 'reasoning.effort':
      body.reasoning = { effort: highest(level) };
      break;
    case 'max_effort':
      // Qwen3.8-max's level scale already spans low..max; 'off' is omitted (not a value it takes).
      if (on) body.max_effort = level;
      break;
    case 'thinking.type':
      body.thinking = { type: on ? (levels.length <= 2 ? 'adaptive' : 'enabled') : 'disabled' };
      break;
    case 'thinking.type+effort':
      body.thinking = { type: on ? 'enabled' : 'disabled' };
      if (on) body.reasoning_effort = highest(level);
      break;
    case 'enable_thinking+budget':
      body.enable_thinking = on;
      if (on) body.thinking_budget = budget ?? BUDGETS[level];
      break;
    case 'reasoning.enabled':
      body.reasoning = { enabled: on };
      break;
    default:
      break;
  }
}
