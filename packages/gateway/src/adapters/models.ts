/**
 * The `/models` listing reader, shared by every route that answers with a `data`
 * (or `models`) array of `{id}` objects — the OpenAI shape Anthropic, OpenRouter,
 * vLLM and most gateways also use.
 *
 * Context windows arrive under several names, since no two providers agree: OpenRouter
 * and LM Studio use `context_length`, vLLM uses `max_model_len`. A route whose provider
 * uses other names passes them as `extra`, tried after the shared ones. Anthropic's
 * `max_tokens` is one: too ambiguous a name to read from every OpenAI-shaped listing.
 * Returns undefined when the envelope itself is wrong.
 */

import type { ModelInfo } from '../types.js';

/** Extra listing field names for a route's own provider: the context window, then the output cap. */
export interface ListingFields {
  window?: readonly string[];
  output?: readonly string[];
}

export function parseModels(json: unknown, extra: ListingFields = {}): ModelInfo[] | undefined {
  if (typeof json !== 'object' || json === null) return undefined;
  const envelope = json as Record<string, unknown>;
  const list = envelope.data ?? envelope.models;
  if (!Array.isArray(list)) return undefined;

  const models: ModelInfo[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string' || record.id === '') continue;
    const window = [
      record.context_length, record.context_window, record.max_context_length, record.max_model_len,
      ...(extra.window ?? []).map((name) => record[name]),
    ].find(positive);
    const output = [
      record.max_completion_tokens, record.max_output_tokens, topProviderCap(record.top_provider),
      ...(extra.output ?? []).map((name) => record[name]),
    ].find(positive);
    const price = priceOf(record.pricing);
    models.push({
      id: record.id,
      ...(window === undefined ? {} : { contextWindow: window }),
      ...(output === undefined ? {} : { maxOutputTokens: output }),
      ...(price === undefined ? {} : { pricePer1k: price }),
    });
  }
  return models;
}

/** A count the provider states as a positive number. Anything else is not stated, and the field is left out. */
function positive(value: unknown): value is number {
  return typeof value === 'number' && value > 0;
}

/** OpenRouter's `top_provider.max_completion_tokens`: the same output cap, under the provider's own envelope. */
function topProviderCap(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const cap = (value as Record<string, unknown>).max_completion_tokens;
  return positive(cap) ? cap : undefined;
}

/**
 * OpenRouter-style `pricing`: a price per token, as a decimal string or a number, for the prompt and the
 * completion. Returned per 1,000 tokens, the unit a profile's price is in. Both are needed, or there is no price.
 */
function priceOf(value: unknown): { prompt: number; completion: number } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const prompt = perToken(record.prompt);
  const completion = perToken(record.completion);
  if (prompt === undefined || completion === undefined) return undefined;
  return { prompt: prompt * 1_000, completion: completion * 1_000 };
}

/** One per-token price, read from a string or a number. Only a finite, non-negative one is a price. */
function perToken(value: unknown): number | undefined {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
