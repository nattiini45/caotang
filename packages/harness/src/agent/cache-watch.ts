/**
 * What a turn's calls got from the provider's prompt cache (agent-harness §5, "Prompt cache"; provider-gateway §3; issue #86).
 *
 * Each model call's usage adds to the turn's totals when the provider reported a cache breakdown (`Usage.cachedPromptTokens`,
 * `cacheWritePromptTokens`). On the planner's own thread, a call that follows a call which used the cache, and read nothing
 * from it, is a miss, and the watch names the likely cause by comparing the two requests the way Claude Code's cache line
 * does: the model or profile switched, the tool definitions changed, or the thinking level changed. With none of those, the
 * provider let the entry go (it expired or was evicted). Display only: nothing here changes a request.
 */

import type { ChatChunk, ChatRequest, ThinkingLevel, Usage } from '@caotang/gateway';

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
}

export const CACHE_MISS_CAUSES = {
  model: 'the model or provider profile changed, which starts a new cache',
  tools: 'the tool definitions changed (a tool was loaded), and the tools come first in the cached prefix',
  thinking: 'the thinking level changed, which some providers render into the cached prefix',
  provider: 'nothing changed on Caotang\'s side: the provider no longer had the cached prefix (it expired or was evicted)',
} as const;

function shapeOf(request: ChatRequest): CallShape {
  return {
    profileId: request.profileId,
    model: request.model,
    thinking: request.thinking,
    // Names and the full declaration: an edited description changes the prefix as surely as a new tool.
    tools: JSON.stringify(request.tools ?? []),
  };
}

/** The likely reason a call read nothing from a cache the call before it used. */
export function missCause(before: CallShape, now: CallShape): string {
  if (before.profileId !== now.profileId || before.model !== now.model) return CACHE_MISS_CAUSES.model;
  if (before.tools !== now.tools) return CACHE_MISS_CAUSES.tools;
  if (before.thinking !== now.thinking) return CACHE_MISS_CAUSES.thinking;
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
