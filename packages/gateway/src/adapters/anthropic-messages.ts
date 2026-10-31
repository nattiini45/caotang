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
 */

import type { SseEvent } from '../sse.js';
import { assertValidMessage, base64Of, textOf } from '../parts.js';
import type {
  ChatMessage,
  FinishReason,
  ModelInfo,
  ReasoningBlock,
  ToolCall,
} from '../types.js';
import { parseModels } from './models.js';
import type {
  BodyInput,
  ProviderAdapter,
  StreamParser,
  StreamPiece,
} from './types.js';

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
    if (m.role === 'system') parts.push(textOf(m.content));
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
  const text = textOf(m.content);
  if (text !== '') blocks.push({ type: 'text', text });
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

function messageContent(m: ChatMessage): unknown {
  if (m.role === 'assistant') return assistantContent(m);
  if (m.role === 'tool') {
    // A tool result rides inside a user message on this route.
    return [{ type: 'tool_result', tool_use_id: m.toolCallId, content: textOf(m.content), ...(m.isError ? { is_error: true } : {}) }];
  }
  if (typeof m.content === 'string') return m.content;
  // A user message's part array becomes the route's content blocks: text, then base64 image sources.
  return m.content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image', source: { type: 'base64', media_type: part.mime, data: base64Of(part.bytes) } },
  );
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

function wireMessages(req: BodyInput['req']): { system?: string; messages: unknown[] } {
  const { system, rest } = splitSystem(req.messages);
  const messages: { role: string; content: unknown }[] = [];
  const format = req.responseFormat;
  const hint = format !== undefined && format !== 'text' ? `Respond with JSON matching: ${JSON.stringify(format.jsonSchemaHint)}` : undefined;
  if (hint !== undefined) messages.push({ role: 'user', content: hint });
  for (const m of rest) {
    assertValidMessage(m, 'anthropic-messages');
    const content = messageContent(m);
    // A completely empty assistant turn has no wire form; drop it rather than send `content: []`.
    if (m.role === 'assistant' && Array.isArray(content) && content.length === 0) continue;
    messages.push({
      role: m.role === 'tool' ? 'user' : m.role,
      content,
    });
  }
  return { system, messages: mergeConsecutive(messages) };
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
  let promptTokens = 0;
  let completionTokens = 0;

  const blockAt = (index: number): BlockAcc => {
    const acc = blocks.get(index) ?? { type: '', text: '', id: '', name: '', args: '', signature: '', raw: undefined };
    blocks.set(index, acc);
    return acc;
  };

  const usagePiece = (): StreamPiece[] =>
    promptTokens > 0 || completionTokens > 0 ? [{ usage: { promptTokens, completionTokens } }] : [];

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
          if (typeof usage?.input_tokens === 'number') promptTokens = usage.input_tokens;
          if (typeof usage?.output_tokens === 'number') completionTokens = usage.output_tokens;
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
          if (typeof usage?.output_tokens === 'number') completionTokens = usage.output_tokens;
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
    const { system, messages } = wireMessages(req);
    const deny = new Set(ctx.caps.denylist ?? []);
    const body: Record<string, unknown> = {
      model: ctx.model,
      messages,
      max_tokens: effective.maxTokens,
      stream: true,
    };
    if (system !== undefined) body.system = system;
    if (temperature !== undefined && !deny.has('temperature')) body.temperature = temperature;
    if (req.stop !== undefined && req.stop.length > 0 && !deny.has('stop')) body.stop_sequences = [...req.stop];
    if (req.tools !== undefined && req.tools.length > 0 && !deny.has('tools')) {
      body.tools = req.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
      body.tool_choice = { type: req.toolChoice === 'none' ? 'none' : 'auto' };
    }
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
