import { DEFAULT_MAX_OUTPUT_TOKENS, RESERVED_TOKENS } from './profiles.js';
import type { AssembledPrompt, ContextMeter } from './types.js';

export function meterOf(prompt: AssembledPrompt, extra: { conversationTokens?: number } = {}): ContextMeter {
  const conversationTokens = Math.max(0, extra.conversationTokens ?? 0);
  const promptTokens = prompt.estimate.promptTokens + conversationTokens;
  const reserveTokens = (prompt.model.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS) + (prompt.model.thinkingTokens ?? 0) + RESERVED_TOKENS;
  const windowTokens = prompt.model.contextWindow;
  const capacity = Math.max(0, Math.min(prompt.totalBudget, windowTokens === undefined ? Infinity : windowTokens - reserveTokens));
  return {
    promptTokens,
    budgetTokens: prompt.totalBudget,
    ...(windowTokens === undefined ? {} : { windowTokens }),
    reserveTokens,
    byLayer: { ...prompt.estimate.byLayer },
    conversationTokens,
    level: promptTokens > capacity ? 'over' : promptTokens >= capacity * 0.8 ? 'near' : 'ok',
  };
}
