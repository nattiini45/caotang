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
