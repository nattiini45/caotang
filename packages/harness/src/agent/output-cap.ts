/**
 * The output cap a request is actually sent with, read off the limits `modelLimits` settled for it
 * (provider-gateway §3, "Effective output"): the request's own cap or the profile's, plus the thinking
 * excess that settlement added — the lift implicit thinking earns included. What a run limit reserves
 * before the call is sent and what a cut reply is compared against, so both judge the cap on the wire.
 */
import type { ModelLimits } from '@caotang/gateway';

/**
 * `limits` must be the ones `modelLimits` returned for this same request input: `requestCap` is the cap
 * the request asked for (`ChatRequest.maxOutputTokens`), absent when it asks for none. The returned figure
 * is the transmitted `max_tokens`, never the base cap alone.
 */
export function transmittedOutputCap(limits: ModelLimits, requestCap?: number): number {
  return (requestCap ?? limits.maxOutputTokens) + (limits.thinkingTokens ?? 0);
}

/**
 * The request cap whose transmitted cap is `target`, or the largest one that stays under it: the inverse of the settlement
 * `transmittedAt` reads (`modelLimits` for that request cap, then {@link transmittedOutputCap}). A budget route adds its thinking
 * budget to the request cap and holds the sum to the model's maximum, and an effort route sends a set cap as it is, so the
 * same transmitted target needs a different request cap on each; reading the settlement itself keeps the two from drifting.
 * The transmitted cap never falls as the request cap rises, so a search over `1…target` finds it.
 */
export function requestCapFor(target: number, transmittedAt: (requestCap: number) => number): number {
  let low = 1;
  let high = target;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (transmittedAt(mid) <= target) low = mid;
    else high = mid - 1;
  }
  return low;
}
