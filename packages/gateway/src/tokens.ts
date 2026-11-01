/**
 * Token estimation — the `ceil(chars/4)` rule that §8 fixes for the mock, and that the
 * gateway also uses as the fallback when a provider omits `usage` from its stream.
 * One rule for both means a ledger row is comparable whichever path produced it.
 *
 * The estimator is not defined here. It is `@caotang/codex`'s, which the `codex.read` cap, the
 * context budgets and the harness's response caps already use, so every budget in the app
 * counts with the same number. This module keeps the one gateway-specific piece: the usage a
 * request's messages and its completion are charged at.
 */

import { estimateTokens, tokensForChars } from '@caotang/codex';

import { imageTokens, partsOf, type ContentRoute } from './parts.js';
import type { ChatMessage, Usage } from './types.js';

export { estimateTokens };
export { contentTokens, type ContentRoute } from './parts.js';

/**
 * Usage for a request whose prompt is `messages` and whose completion is `completion`.
 * Text-only contents count exactly as before — all text characters gathered, then one
 * `ceil(chars/4)` — and image parts add their per-route formula (`route` is the adapter the
 * request goes out on, undefined for a route-agnostic estimate, i.e. the conservative
 * fallback); the base64 form is never counted as text tokens.
 */
export function usageFor(messages: readonly ChatMessage[], completion: string, route?: ContentRoute): Usage {
  let chars = 0;
  let imageTokensTotal = 0;
  for (const message of messages) {
    for (const part of partsOf(message.content)) {
      if (part.type === 'text') chars += part.text.length;
      else imageTokensTotal += imageTokens(part, route);
    }
  }
  return {
    promptTokens: tokensForChars(chars) + imageTokensTotal,
    completionTokens: estimateTokens(completion),
  };
}

/** The prompt-token estimate of a message list alone, on the same rules as {@link usageFor}. */
export function promptTokensOf(messages: readonly ChatMessage[], route?: ContentRoute): number {
  return usageFor(messages, '', route).promptTokens;
}
