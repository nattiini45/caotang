/**
 * The `anthropic-messages` adapter — Anthropic Messages and compatible routes
 * (Z.ai's Anthropic endpoint, BytePlus's, MiniMax's, Moonshot's and OpenCode's
 * `claude-*` models).
 *
 * Differences from the chat shape that the adapter owns: `system` is a top-level
 * field, not a message; assistant reasoning replays as signed `thinking` content
 * blocks; tool calls are `tool_use` blocks and their results `tool_result` blocks
 * inside a *user* message; and the stream is a sequence of named events
 * (`message_start`, `content_block_*`, `message_delta`, `message_stop`, `error`),
 * where `error` can arrive after HTTP 200 and must be raised as a provider failure.
 *
 * Thinking is `thinking` + `output_config.effort` (effort style 'anthropic'), in the shape the
 * row's `thinkingShape` names: 'adaptive' (every 5.x model) sends the effort and never a token
 * budget; 'budget' (the default for a Messages row that says nothing) sends
 * `thinking.type: 'enabled'` with the budget `effectiveOutput` settled under `max_tokens`. With
 * thinking on Anthropic does not accept `temperature`, so the field is omitted.
 *
 * Prompt caching (provider-gateway §3), on a row whose `cache` is `explicit` and only then: `system` goes as an array of text
 * blocks, and `cache_control` marks the last tool, the last system block and the boundary part of the first user message that carries one
 * (`cacheBoundary`), each only when the prefix it closes reaches the row's minimum; a top-level `cache_control` lets Anthropic
 * move the fourth breakpoint along the growing thread. That is four breakpoints at most, the documented limit, and every one
 * carries the same lifetime, since a mix must run longest first. Without caching the body is what it always was.
 */

import type { SseEvent } from '../sse.js';
import type {
  ChatMessage,
  Usage,
  FinishReason,
  ModelInfo,
  ReasoningBlock,
  ToolCall,
} from '../types.js';
import { boundaryIndex, partsOf, tokensOf, type CacheSettings } from './cache.js';
import { parseModels } from './models.js';
import type {
  BodyInput,
  ProviderAdapter,
  StreamParser,
  StreamPiece,
} from './types.js';

/** A token figure that is an amount: a number, finite and not below zero. Anything else is no usage. */
const isAmount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function mapStopReason(raw: unknown): FinishReason | undefined {
  if (typeof raw !== 'string') return undefined;
  switch (raw) {
    case 'end_turn':
    case 'stop_sequence':
    case 'pause_turn':
      return 'stop';
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'length';
    default:
      return 'error';
  }
}

/** System messages are lifted out of the conversation into Anthropic's `system` field. */
function splitSystem(messages: readonly ChatMessage[]): { system?: string; rest: ChatMessage[] } {
  const parts: string[] = [];
  const rest: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') parts.push(m.content);
    else rest.push(m);
  }
  return { system: parts.length > 0 ? parts.join('\n\n') : undefined, rest };
}

/** An assistant message's content array: replayed thinking blocks, then text, then tool_use. */
function assistantContent(m: ChatMessage): unknown[] {
  const blocks: unknown[] = [];
  for (const block of m.reasoning ?? []) {
    // `raw` is the provider's own block object ({type:'thinking', thinking, signature} or
    // redacted_thinking). Replay verbatim when present; otherwise emit a plain thinking block.
    if (block.raw !== undefined && typeof block.raw === 'object') blocks.push(block.raw);
    else if (block.text !== '') blocks.push({ type: 'thinking', thinking: block.text, signature: '' });
  }
  if (m.content !== '') blocks.push({ type: 'text', text: m.content });
  for (const call of m.toolCalls ?? []) {
    let input: unknown;
    try {
      input = JSON.parse(call.argumentsJson);
    } catch {
      input = {};
    }
    blocks.push({ type: 'tool_use', id: call.id, name: call.name, input });
  }
  return blocks;
}

function messageContent(m: ChatMessage, mark?: CacheMark): unknown {
  if (m.role === 'assistant') return assistantContent(m);
  if (mark !== undefined && m.role === 'user') {
    // The cached user message goes as text blocks, one per part, so the breakpoint can sit at the end of the stable prefix.
    return partsOf(m).map((part, index) => ({ type: 'text', text: part.text, ...(index === mark.at ? { cache_control: mark.control } : {}) }));
  }
  if (m.role === 'tool') {
    // A tool result rides inside a user message on this route.
    return [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content, ...(m.isError ? { is_error: true } : {}) }];
  }
  return m.content;
}

/** Merges consecutive same-role messages: the route requires alternating roles. */
function mergeConsecutive(messages: { role: string; content: unknown }[]): { role: string; content: unknown }[] {
  const out: { role: string; content: unknown }[] = [];
  for (const m of messages) {
    const prev = out.at(-1);
    if (prev !== undefined && prev.role === m.role) {
      const merged = [
        ...(Array.isArray(prev.content) ? prev.content : [{ type: 'text', text: prev.content }]),
        ...(Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }]),
      ];
      prev.content = merged;
    } else {
      out.push({ ...m });
    }
  }
  return out;
}

/** Where the breakpoint goes inside the first user message: the part's index, and the `cache_control` it carries. */
interface CacheMark {
  readonly at: number;
  readonly control: Record<string, unknown>;
}

/** The `cache_control` object for a lifetime. Five minutes is the default and is not written, so it matches the top-level one. */
function controlOf(cache: CacheSettings): Record<string, unknown> {
  return cache.ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
}

/**
 * The breakpoint of the first user message that marks a boundary, when the prefix up to it (`before` characters of tools and
 * system, the schema hint, and the parts through the boundary) reaches the row's minimum. The later user messages are the turn's
 * own thread, which the top-level breakpoint covers.
 */
function userMark(rest: readonly ChatMessage[], cache: CacheSettings | undefined, before: number): { index: number; mark: CacheMark } | undefined {
  if (cache === undefined) return undefined;
  let chars = before;
  for (let index = 0; index < rest.length; index += 1) {
    const message = rest[index] as ChatMessage;
    const parts = partsOf(message);
    const at = message.role === 'user' ? boundaryIndex(parts) : -1;
    if (at >= 0) {
      chars += parts.slice(0, at + 1).reduce((sum, part) => sum + part.text.length, 0);
      return tokensOf(chars) >= cache.minTokens ? { index, mark: { at, control: controlOf(cache) } } : undefined;
    }
    chars += message.content.length;
  }
  return undefined;
}

function wireMessages(req: BodyInput['req'], cache?: CacheSettings, before = 0): { system?: string; systemChars: number; messages: unknown[] } {
  const { system, rest } = splitSystem(req.messages);
  const messages: { role: string; content: unknown }[] = [];
  const format = req.responseFormat;
  const hint = format !== undefined && format !== 'text' ? `Respond with JSON matching: ${JSON.stringify(format.jsonSchemaHint)}` : undefined;
  if (hint !== undefined) messages.push({ role: 'user', content: hint });
  const marked = userMark(rest, cache, before + (system?.length ?? 0) + (hint?.length ?? 0));
  for (const [index, m] of rest.entries()) {
    const content = messageContent(m, marked?.index === index ? marked.mark : undefined);
    // A completely empty assistant turn has no wire form; drop it rather than send `content: []`.
    if (m.role === 'assistant' && Array.isArray(content) && content.length === 0) continue;
    messages.push({
      role: m.role === 'tool' ? 'user' : m.role,
      content,
    });
  }
  return { ...(system === undefined ? {} : { system }), systemChars: system?.length ?? 0, messages: mergeConsecutive(messages) };
}

function anthropicEffort(body: Record<string, unknown>, input: BodyInput): void {
  const { level, budget } = input.effective;
  if (level === undefined) return;
  // Another style on the row means the model doesn't take the Messages thinking fields.
  if (input.ctx.caps.effortStyle !== undefined && input.ctx.caps.effortStyle !== 'anthropic') return;
  const levels = input.ctx.caps.effortLevels;
  if (levels === undefined || levels.length === 0 || !levels.includes(level)) return;
  if (level === 'off') {
    body.thinking = { type: 'disabled' };
    return;
  }
  if (input.ctx.caps.thinkingShape === 'adaptive') {
    body.thinking = { type: 'adaptive', display: input.ctx.caps.thinkingDisplay ?? 'summarized' };
  } else {
    if (budget === undefined) return;
    body.thinking = { type: 'enabled', budget_tokens: budget };
  }
  body.output_config = { effort: level };
}

interface BlockAcc {
  type: string;
  text: string;
  id: string;
  name: string;
  args: string;
  signature: string;
  raw: unknown;
}

function anthropicStreamParser(): StreamParser {
  const blocks = new Map<number, BlockAcc>();
  // `input_tokens` counts only what follows the last breakpoint; the cache reads and writes are reported beside it, and all
  // three together are what the call billed as input (issue #78, step 2).
  let inputTokens = 0;
  let cacheRead: number | undefined;
  let cacheWrite: number | undefined;
  let completionTokens = 0;
  const readInput = (usage: Record<string, unknown> | undefined): void => {
    if (isAmount(usage?.input_tokens)) inputTokens = usage.input_tokens;
    if (isAmount(usage?.cache_read_input_tokens)) cacheRead = usage.cache_read_input_tokens;
    if (isAmount(usage?.cache_creation_input_tokens)) cacheWrite = usage.cache_creation_input_tokens;
  };
  const usageNow = (): Usage => ({
    promptTokens: inputTokens + (cacheRead ?? 0) + (cacheWrite ?? 0),
    completionTokens,
    ...(cacheRead === undefined ? {} : { cachedPromptTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWritePromptTokens: cacheWrite }),
  });

  const blockAt = (index: number): BlockAcc => {
    const acc = blocks.get(index) ?? { type: '', text: '', id: '', name: '', args: '', signature: '', raw: undefined };
    blocks.set(index, acc);
    return acc;
  };

  const usagePiece = (): StreamPiece[] => {
    const usage = usageNow();
    return usage.promptTokens > 0 || completionTokens > 0 ? [{ usage }] : [];
  };

  return {
    push(ev: SseEvent): StreamPiece[] {
      const data = ev.data;
      let json: unknown;
      try {
        json = JSON.parse(data);
      } catch {
        return [{ malformed: data }];
      }
      if (typeof json !== 'object' || json === null || Array.isArray(json)) return [{ malformed: data }];
      const record = json as Record<string, unknown>;
      const type = typeof record.type === 'string' ? record.type : ev.event;

      switch (type) {
        case 'message_start': {
          const message = record.message as Record<string, unknown> | undefined;
          const usage = message?.usage as Record<string, unknown> | undefined;
          readInput(usage);
          if (isAmount(usage?.output_tokens)) completionTokens = usage.output_tokens;
          return [];
        }
        case 'content_block_start': {
          const index = typeof record.index === 'number' ? record.index : 0;
          const block = record.content_block as Record<string, unknown> | undefined;
          if (block === undefined) return [];
          const acc = blockAt(index);
          acc.type = typeof block.type === 'string' ? block.type : '';
          if (acc.type === 'tool_use') {
            if (typeof block.id === 'string') acc.id = block.id;
            if (typeof block.name === 'string') acc.name = block.name;
          } else if (acc.type === 'redacted_thinking') {
            acc.raw = block;
          }
          return [];
        }
        case 'content_block_delta': {
          const index = typeof record.index === 'number' ? record.index : 0;
          const acc = blockAt(index);
          const delta = record.delta as Record<string, unknown> | undefined;
          if (delta === undefined) return [];
          switch (delta.type) {
            case 'text_delta':
              if (typeof delta.text === 'string') {
                acc.text += delta.text;
                return [{ text: delta.text }];
              }
              return [];
            case 'thinking_delta':
              if (typeof delta.thinking === 'string') {
                acc.text += delta.thinking;
                return [{ reasoning: delta.thinking }];
              }
              return [];
            case 'signature_delta':
              if (typeof delta.signature === 'string') acc.signature += delta.signature;
              return [];
            case 'input_json_delta':
              if (typeof delta.partial_json === 'string') acc.args += delta.partial_json;
              return [];
            default:
              return [];
          }
        }
        case 'content_block_stop':
        case 'message_start_ignored':
          return [];
        case 'message_delta': {
          const delta = record.delta as Record<string, unknown> | undefined;
          const usage = record.usage as Record<string, unknown> | undefined;
          // The final delta's usage is cumulative, and may restate the input counts; a restated count replaces the first.
          readInput(usage);
          if (isAmount(usage?.output_tokens)) completionTokens = usage.output_tokens;
          const finish = mapStopReason(delta?.stop_reason);
          return [...(finish !== undefined ? [{ finish }] : []), ...usagePiece()];
        }
        case 'message_stop':
          return [{ done: true }, ...usagePiece()];
        case 'error': {
          const err = record.error as Record<string, unknown> | undefined;
          const message = typeof err?.message === 'string' ? err.message : data;
          return [{ error: message }];
        }
        case 'ping':
          return [];
        default:
          return [];
      }
    },
    finish() {
      const toolCalls: ToolCall[] = [];
      const reasoning: ReasoningBlock[] = [];
      for (const [index, acc] of [...blocks.entries()].sort(([a], [b]) => a - b)) {
        void index;
        if (acc.type === 'tool_use') {
          toolCalls.push({ id: acc.id, name: acc.name, argumentsJson: acc.args });
        } else if (acc.type === 'thinking' || acc.type === 'redacted_thinking') {
          const raw =
            acc.type === 'redacted_thinking'
              ? acc.raw
              : { type: 'thinking', thinking: acc.text, signature: acc.signature };
          reasoning.push({ text: acc.text, raw });
        }
      }
      return {
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(reasoning.length > 0 ? { reasoning } : {}),
      };
    },
  };
}

export const anthropicMessagesAdapter: ProviderAdapter = {
  id: 'anthropic-messages',

  completePath() {
    return '/messages';
  },

  modelsPath() {
    return '/models';
  },

  headers(ctx, secrets) {
    const headers: Record<string, string> = {
      'anthropic-version': '2023-06-01',
      ...(ctx.quirks.versionHeaders ?? {}),
      ...(ctx.quirks.extraHeaders ?? {}),
    };
    if (ctx.quirks.browserAccess === true) {
      // Browser fetches to api.anthropic.com are allowed only when this is sent. It is
      // Anthropic's own header, so only the routes that reach Anthropic ask for it.
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
    }
    if (secrets.apiKey !== undefined && secrets.apiKey !== '') {
      switch (ctx.quirks.auth ?? 'x-api-key') {
        case 'bearer':
          headers.authorization = `Bearer ${secrets.apiKey}`;
          break;
        case 'api-key':
          headers['api-key'] = secrets.apiKey;
          break;
        default:
          headers['x-api-key'] = secrets.apiKey;
          break;
      }
    }
    // Custom headers go last: a generic profile's own headers are the escape hatch and may override any of the above.
    return { ...headers, ...Object.fromEntries((secrets.headers ?? []).map((h) => [h.name, h.value])) };
  },

  buildBody(input: BodyInput): Record<string, unknown> {
    const { req, ctx, temperature, effective, jsonObject } = input;
    // Breakpoints are this route's own mechanism: a row that caches by itself gets no field from here.
    const cache = input.cache?.style === 'explicit' ? input.cache : undefined;
    const deny = new Set(ctx.caps.denylist ?? []);
    const tools =
      req.tools !== undefined && req.tools.length > 0 && !deny.has('tools')
        ? req.tools.map((tool): Record<string, unknown> => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }))
        : undefined;
    const toolChars = tools === undefined ? 0 : JSON.stringify(tools).length;
    const { system, systemChars, messages } = wireMessages(req, cache, toolChars);
    const body: Record<string, unknown> = {
      model: ctx.model,
      messages,
      max_tokens: effective.maxTokens,
      stream: true,
    };
    if (system !== undefined) {
      // Cached, the system prompt is one text block carrying the second breakpoint; otherwise the plain string it always was.
      body.system =
        cache === undefined || system === ''
          ? system
          : [{ type: 'text', text: system, ...(tokensOf(toolChars + systemChars) >= cache.minTokens ? { cache_control: controlOf(cache) } : {}) }];
    }
    if (temperature !== undefined && !deny.has('temperature')) body.temperature = temperature;
    if (req.stop !== undefined && req.stop.length > 0 && !deny.has('stop')) body.stop_sequences = [...req.stop];
    if (tools !== undefined) {
      const last = tools.at(-1);
      // Tools come first in Anthropic's prefix (tools, system, messages), so the first breakpoint closes them.
      if (cache !== undefined && last !== undefined && tokensOf(toolChars) >= cache.minTokens) last.cache_control = controlOf(cache);
      body.tools = tools;
      body.tool_choice = { type: req.toolChoice === 'none' ? 'none' : 'auto' };
    }
    // The top-level breakpoint: Anthropic places it on the last cacheable block and moves it as the thread grows.
    if (cache !== undefined) body.cache_control = controlOf(cache);
    anthropicEffort(body, input);
    if (body.thinking !== undefined && (body.thinking as { type?: string }).type !== 'disabled') {
      // Anthropic rejects temperature with extended thinking enabled.
      delete body.temperature;
    }
    void jsonObject; // Messages has no response_format; the schema hint rides as a user message.
    return body;
  },

  createStreamParser() {
    return anthropicStreamParser();
  },

  parseModels(json: unknown): ModelInfo[] | undefined {
    // GET /v1/models reports `max_input_tokens` (the window) and `max_tokens` (the output cap), each nullable.
    return parseModels(json, { window: ['max_input_tokens'], output: ['max_tokens'] });
  },
};
