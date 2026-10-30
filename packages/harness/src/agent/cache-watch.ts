/**
 * What a turn's calls got from the provider's prompt cache (agent-harness §5, "Prompt cache"; provider-gateway §3; issue #86).
 *
 * Each model call's usage adds to the turn's totals when the provider reported a cache breakdown (`Usage.cachedPromptTokens`,
 * `cacheWritePromptTokens`). On the planner's own thread, a call that follows a call which used the cache, and read nothing
 * from it, is a miss, and the watch names the likely cause by comparing the two requests the way Claude Code's cache line
 * does: the model or profile switched, the tool definitions changed, the thinking level changed, or the cached prefix itself
 * (the system text and the first user message up to its cache boundary) changed. With none of those it can only guess: nothing
 * it can see changed, so the provider probably let the entry go. Display only: nothing here changes a request.
 */

import { fnv1a64, type ChatChunk, type ChatMessage, type ChatRequest, type ThinkingLevel, type Usage } from '@caotang/gateway';

/** One call that should have read the cache and did not, and the likely reason. */
export interface CacheMiss {
  /** The call's 1-based index in its turn. */
  readonly call: number;
  readonly cause: string;
}

/** The turn's cache use, for the report. Present only when a call reported a cache breakdown. */
export interface TurnCacheUse {
  /** Every input token of the calls that reported a breakdown. */
  readonly promptTokens: number;
  /** Of those, the tokens the provider read from its cache. */
  readonly cachedPromptTokens: number;
  /** Of those, the tokens written to the cache. */
  readonly cacheWritePromptTokens: number;
  readonly misses: readonly CacheMiss[];
}

/** What of a request decides whether its prefix can match the call before it. */
interface CallShape {
  readonly profileId: string | undefined;
  readonly model: string | undefined;
  readonly thinking: ThinkingLevel | undefined;
  readonly tools: string;
  /** A hash of the cached prefix: the system messages' text and the first user message's parts up to its cache boundary. */
  readonly prefix: string;
}

export const CACHE_MISS_CAUSES = {
  model: 'the model or provider profile changed, which starts a new cache',
  tools: 'the tool definitions changed (a tool was loaded), and the tools come first in the cached prefix',
  thinking: 'the thinking level changed, which some providers render into the cached prefix',
  prefix: 'the cached start of the prompt changed (the system text or the context before the cache boundary)',
  provider: 'possibly nothing the cache watch can see changed on Caotang\'s side, or the provider\'s cached prefix expired or was evicted',
} as const;

/** The text of the parts up to and including the last cache boundary, or '' when no part is marked. */
function cachedPartsText(message: ChatMessage | undefined): string {
  const parts = message?.parts ?? [];
  let end = -1;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index]?.cacheBoundary === true) {
      end = index;
      break;
    }
  }
  return parts.slice(0, end + 1).map((part) => part.text).join('\n\n');
}

/** The hash of what a request's provider caches before the conversation: its system text and its context up to the boundary. */
function prefixOf(request: ChatRequest): string {
  const system = request.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const firstUser = request.messages.find((m) => m.role === 'user');
  return fnv1a64(`${system}\u0000${cachedPartsText(firstUser)}`);
}

function shapeOf(request: ChatRequest): CallShape {
  return {
    profileId: request.profileId,
    model: request.model,
    thinking: request.thinking,
    // Names and the full declaration: an edited description changes the prefix as surely as a new tool.
    tools: JSON.stringify(request.tools ?? []),
    prefix: prefixOf(request),
  };
}

/** The likely reason a call read nothing from a cache the call before it used. */
export function missCause(before: CallShape, now: CallShape): string {
  if (before.profileId !== now.profileId || before.model !== now.model) return CACHE_MISS_CAUSES.model;
  if (before.tools !== now.tools) return CACHE_MISS_CAUSES.tools;
  if (before.thinking !== now.thinking) return CACHE_MISS_CAUSES.thinking;
  if (before.prefix !== now.prefix) return CACHE_MISS_CAUSES.prefix;
  return CACHE_MISS_CAUSES.provider;
}

export class CacheWatch {
  private promptTokens = 0;
  private cachedPromptTokens = 0;
  private cacheWritePromptTokens = 0;
  private reported = false;
  private readonly misses: CacheMiss[] = [];
  /** The planner's previous call: its shape, and whether it used the cache (read or wrote), which makes a hit expected next. */
  private last: { shape: CallShape; warm: boolean } | undefined;

  /** Counts one finished call. `planner` calls form one thread, where a cold call after a warm one is a miss. */
  record(call: number, request: ChatRequest, usage: Usage | undefined, planner: boolean): void {
    const cached = usage?.cachedPromptTokens;
    const written = usage?.cacheWritePromptTokens;
    const reports = usage !== undefined && (cached !== undefined || written !== undefined);
    if (reports) {
      this.reported = true;
      this.promptTokens += usage.promptTokens;
      this.cachedPromptTokens += cached ?? 0;
      this.cacheWritePromptTokens += written ?? 0;
    }
    if (!planner) return;
    const shape = shapeOf(request);
    if (reports && this.last?.warm === true && (cached ?? 0) === 0) this.misses.push({ call, cause: missCause(this.last.shape, shape) });
    this.last = { shape, warm: reports && ((cached ?? 0) > 0 || (written ?? 0) > 0) };
  }

  report(): TurnCacheUse | undefined {
    if (!this.reported) return undefined;
    return {
      promptTokens: this.promptTokens,
      cachedPromptTokens: this.cachedPromptTokens,
      cacheWritePromptTokens: this.cacheWritePromptTokens,
      misses: [...this.misses],
    };
  }
}

/** Passes a call's stream through and tells the watch its usage when the stream ends, however it ends. */
export async function* watched(
  watch: CacheWatch,
  call: number,
  request: ChatRequest,
  planner: boolean,
  stream: AsyncIterable<ChatChunk>,
): AsyncGenerator<ChatChunk, void, undefined> {
  let usage: Usage | undefined;
  try {
    for await (const chunk of stream) {
      if (chunk.usage !== undefined) usage = chunk.usage;
      yield chunk;
    }
  } finally {
    watch.record(call, request, usage, planner);
  }
}

/**
 * The tool list a planner call declares, kept in a stable order across a turn (provider-gateway §3): the order of the turn's
 * first declaration, with tools a mid-turn `tool.search` loaded appended at the end, never sorted in, so the prefix before
 * them stays the same. A tool that is no longer offered drops out.
 */
export function stableToolOrder<T extends { readonly name: string }>(prior: readonly T[] | undefined, fresh: readonly T[]): T[] {
  if (prior === undefined) return [...fresh];
  const byName = new Map(fresh.map((tool) => [tool.name, tool]));
  const kept = prior.flatMap((tool) => {
    const now = byName.get(tool.name);
    return now === undefined ? [] : [now];
  });
  const known = new Set(prior.map((tool) => tool.name));
  return [...kept, ...fresh.filter((tool) => !known.has(tool.name))];
}
