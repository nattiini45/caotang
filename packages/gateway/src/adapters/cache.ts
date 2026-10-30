/**
 * Prompt caching, the part every adapter shares (provider-gateway §3, "Prompt caching").
 *
 * A request says where its reusable prefix ends with `ChatMessage.parts[].cacheBoundary`; the gateway settles whether this
 * call caches at all (the profile's or request's {@link CachePolicy} against the model row's `cache`) and hands the adapter a
 * {@link CacheSettings}, or nothing. An adapter with nothing sends what it sent before caching existed, byte for byte.
 */

import { tokensForChars } from '@caotang/codex';

import type { CachePolicy, ChatMessage, ChatRequest, ContentPart, ModelCaps } from '../types.js';

/** What one call's adapter is told about caching. Absent on `BodyInput` means "send no cache field". */
export interface CacheSettings {
  /** How the row caches: breakpoints the adapter places, or the provider's own (where the adapter only keeps the prefix stable). */
  readonly style: 'explicit' | 'automatic';
  /** Anthropic's lifetime: 5 minutes by default, an hour on request (a dearer write). Ignored elsewhere. */
  readonly ttl: '5m' | '1h';
  /** The smallest prefix the row caches, in tokens: a breakpoint before a shorter prefix is left out. */
  readonly minTokens: number;
  /**
   * A stable, non-identifying routing key (OpenAI `prompt_cache_key`, for rows before GPT-5.6): a hash of the profile id and the
   * call's system text, so each kind of call keeps its own cache and no project name or text leaves in clear.
   */
  readonly key: string;
}

/** The policy a request runs under: its own, else its profile's, else on with the default lifetime. */
export function policyOf(request: CachePolicy | undefined, profile: CachePolicy | undefined): CachePolicy {
  return request ?? profile ?? { mode: 'auto' };
}

/**
 * Whether and how this call caches. `undefined` when the policy is off, or the row does not cache (`none` or absent: a generic
 * endpoint, a provider whose caching the table does not state).
 */
export function cacheSettingsFor(policy: CachePolicy, caps: ModelCaps, profileId: string, req: Pick<ChatRequest, 'messages'>): CacheSettings | undefined {
  if (policy.mode !== 'auto') return undefined;
  const style = caps.cache;
  if (style !== 'explicit' && style !== 'automatic') return undefined;
  const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  return {
    style,
    ttl: policy.ttl ?? '5m',
    minTokens: caps.cacheMinTokens ?? 0,
    key: `caotang-${fnv1a64(`${profileId}\n${system}`)}`,
  };
}

/** A message's parts: its own, or its content as one unmarked part. Empty parts are dropped (an empty block cannot be cached). */
export function partsOf(message: ChatMessage): readonly ContentPart[] {
  const parts = message.parts !== undefined && message.parts.length > 0 ? message.parts : [{ text: message.content }];
  return parts.filter((part) => part.text !== '');
}

/** The index of the last part marked as a boundary, or -1. */
export function boundaryIndex(parts: readonly ContentPart[]): number {
  for (let index = parts.length - 1; index >= 0; index -= 1) if (parts[index]?.cacheBoundary === true) return index;
  return -1;
}

/** The token estimate of some text, by the gateway's one rule (`ceil(chars/4)`). */
export function tokensOf(chars: number): number {
  return tokensForChars(chars);
}

/**
 * FNV-1a over UTF-16 code units, 64 bits, as hex. A routing key needs to be stable and short, not secret: what it hides is the
 * text it was made from, and a hash does that. Synchronous on purpose, since a body is built synchronously (WebCrypto's digest
 * is async, and WASM is refused by the app's CSP).
 */
export function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}
