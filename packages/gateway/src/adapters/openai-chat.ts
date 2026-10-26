/**
 * The `openai-chat` adapter — OpenAI Chat Completions and every compatible route.
 *
 * This is the wire format the gateway has always spoken, so the body's core shape is
 * unchanged: `{model, messages, temperature, <cap field>, stream, stream_options}`.
 * On top of it the adapter adds the fields a preset or capability row asks for:
 * `tools`/`tool_choice` for native function calling, the effort fields `applyEffort`
 * maps per style, and `store`/denylist quirks.
 *
 * Streaming: `choices[0].delta` carries `content` text, `reasoning_content` (and its
 * aliases) thinking text, and `tool_calls` fragments keyed by `index`, assembled into
 * `ToolCall`s at finish. `[DONE]` ends the stream. A `reasoning`/`reasoning_content`
 * field on a streamed delta is the chat-compat thinking channel.
 *
 * Replay: an assistant message's `toolCalls` become `tool_calls` wire entries; a `tool`
 * message becomes `{role:'tool', tool_call_id, content}`; reasoning replays per the
 * model's `replayStyle` — `content-field` writes it back as `reasoning_content`,
 * `think-tags` wraps it into the content, `text` drops it (the common compat default).
 */

import type { SseEvent } from '../sse.js';
import type {
  ChatMessage,
  FinishReason,
  ModelInfo,
  ReasoningBlock,
  ToolCall,
  Usage,
} from '../types.js';
import { applyEffort } from './effort.js';
import { parseModels } from './models.js';
import type {
  AdapterContext,
  BodyInput,
  CallSecrets,
  ProviderAdapter,
  StreamParser,
  StreamPiece,
} from './types.js';

type WireMessage = Record<string, unknown>;

/** §3's mapping, extended: `tool_calls` now reports itself rather than folding into 'stop'. */
export function mapFinishReason(raw: unknown): FinishReason | undefined {
  if (typeof raw !== 'string') return undefined;
  switch (raw) {
    case 'stop':
    case 'function_call':
      return 'stop';
    case 'tool_calls':
      return 'tool_calls';
    case 'length':
      return 'length';
    default:
      return 'error';
  }
}

interface ReasoningReplay {
  reasoning_content?: string;
  contentPrefix?: string;
}

/** One assistant message's reasoning as the replay style writes it back onto the wire message. */
function replayReasoning(msg: ChatMessage, style: string | undefined): ReasoningReplay {
  const text = (msg.reasoning ?? []).map((b) => b.text).join('');
  if (text === '') return {};
  if (style === 'content-field') return { reasoning_content: text };
  if (style === 'think-tags') return { contentPrefix: `<think>${text}</think>` };
  return {};
}

/** The messages array, with §5's schema-hint system message appended when one is set. */
export function wireMessages(req: Pick<BodyInput['req'], 'messages' | 'responseFormat'>, caps: { replayStyle?: string }): WireMessage[] {
  const messages: WireMessage[] = req.messages.map((m) => {
    const wire: WireMessage = { role: m.role };
    if (m.role === 'tool') {
      wire.tool_call_id = m.toolCallId;
      wire.content = m.content;
      return wire;
    }
    const replay = m.role === 'assistant' ? replayReasoning(m, caps.replayStyle) : {};
    const prefix = replay.contentPrefix ?? '';
    wire.content = prefix + m.content;
    if (replay.reasoning_content !== undefined) wire.reasoning_content = replay.reasoning_content;
    if (m.toolCalls !== undefined && m.toolCalls.length > 0) {
      wire.tool_calls = m.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.argumentsJson },
      }));
      if (m.content === '' && prefix === '') wire.content = null;
    }
    return wire;
  });
  const format = req.responseFormat;
  if (format !== undefined && format !== 'text') {
    messages.push({ role: 'system', content: `Respond with JSON matching: ${JSON.stringify(format.jsonSchemaHint)}` });
  }
  return messages;
}

function authHeaders(ctx: AdapterContext, secrets: CallSecrets): Record<string, string> {
  const headers: Record<string, string> = {};
  if (secrets.apiKey !== undefined && secrets.apiKey !== '') {
    switch (ctx.quirks.auth ?? 'bearer') {
      case 'x-api-key':
        headers['x-api-key'] = secrets.apiKey;
        break;
      case 'api-key':
        headers['api-key'] = secrets.apiKey;
        break;
      default:
        headers.authorization = `Bearer ${secrets.apiKey}`;
        break;
    }
  }
  return headers;
}

/** Chat-Completions tools are nested under `function`. */
function wireTools(req: BodyInput['req']): unknown[] | undefined {
  if (req.tools === undefined || req.tools.length === 0) return undefined;
  return req.tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string') return message;
  }
  return JSON.stringify(error) ?? 'unknown error';
}

function usageOf(raw: unknown): Usage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const prompt = record.prompt_tokens ?? record.input_tokens;
  const completion = record.completion_tokens ?? record.output_tokens;
  // A figure that cannot be a count (negative, or not finite) is no usage.
  if (typeof prompt !== 'number' || typeof completion !== 'number') return undefined;
  if (!(Number.isFinite(prompt) && prompt >= 0 && Number.isFinite(completion) && completion >= 0)) return undefined;
  return { promptTokens: prompt, completionTokens: completion };
}

/** The reasoning channel's field names across chat-compatible providers. */
const REASONING_FIELDS = ['reasoning_content', 'reasoning'] as const;

interface ToolCallAcc {
  id: string;
  name: string;
  args: string;
}

function chatStreamParser(): StreamParser {
  const calls = new Map<number, ToolCallAcc>();
  const reasoning: ReasoningBlock[] = [];
  let reasoningText = '';

  return {
    push(ev: SseEvent): StreamPiece[] {
      const data = ev.data;
      if (data === '[DONE]') return [{ done: true }];
      let json: unknown;
      try {
        json = JSON.parse(data);
      } catch {
        return [{ malformed: data }];
      }
      if (typeof json !== 'object' || json === null || Array.isArray(json)) return [{ malformed: data }];
      const record = json as Record<string, unknown>;
      const pieces: StreamPiece[] = [];

      if (record.error !== undefined && record.error !== null) pieces.push({ error: errorText(record.error) });
      const usage = usageOf(record.usage);
      if (usage !== undefined) pieces.push({ usage });

      const choices = Array.isArray(record.choices) ? record.choices : [];
      const first = choices[0];
      if (typeof first === 'object' && first !== null) {
        const choice = first as Record<string, unknown>;
        const delta = choice.delta;
        if (typeof delta === 'object' && delta !== null) {
          const d = delta as Record<string, unknown>;
          const content = d.content;
          if (typeof content === 'string' && content.length > 0) pieces.push({ text: content });
          for (const field of REASONING_FIELDS) {
            const value = d[field];
            if (typeof value === 'string' && value.length > 0) {
              reasoningText += value;
              pieces.push({ reasoning: value });
            }
          }
          const toolCalls = d.tool_calls;
          if (Array.isArray(toolCalls)) {
            for (const entry of toolCalls) {
              if (typeof entry !== 'object' || entry === null) continue;
              const raw = entry as Record<string, unknown>;
              const index = typeof raw.index === 'number' ? raw.index : 0;
              const acc = calls.get(index) ?? { id: '', name: '', args: '' };
              if (typeof raw.id === 'string' && raw.id !== '') acc.id = raw.id;
              const fn = raw.function;
              if (typeof fn === 'object' && fn !== null) {
                const f = fn as Record<string, unknown>;
                if (typeof f.name === 'string') acc.name += f.name;
                if (typeof f.arguments === 'string') acc.args += f.arguments;
              }
              calls.set(index, acc);
            }
          }
        }
        const finish = mapFinishReason(choice.finish_reason);
        if (finish !== undefined) pieces.push({ finish });
      }
      return pieces;
    },
    finish() {
      const toolCalls: ToolCall[] = [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, acc]) => ({ id: acc.id, name: acc.name, argumentsJson: acc.args }));
      if (reasoningText !== '') reasoning.push({ text: reasoningText });
      return {
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(reasoning.length > 0 ? { reasoning } : {}),
      };
    },
  };
}

export const openaiChatAdapter: ProviderAdapter = {
  id: 'openai-chat',

  completePath() {
    return '/chat/completions';
  },

  modelsPath() {
    return '/models';
  },

  headers(ctx, secrets) {
    // Order: the preset's headers, then auth, then the profile's custom headers — custom is the escape hatch.
    return {
      ...(ctx.quirks.versionHeaders ?? {}),
      ...(ctx.quirks.extraHeaders ?? {}),
      ...authHeaders(ctx, secrets),
      ...Object.fromEntries((secrets.headers ?? []).map((h) => [h.name, h.value])),
    };
  },

  buildBody({ req, ctx, temperature, effective, jsonObject }): Record<string, unknown> {
    const deny = new Set(ctx.caps.denylist ?? []);
    const body: Record<string, unknown> = {
      model: ctx.model,
      messages: wireMessages(req, ctx.caps),
      stream: true,
    };
    if (!deny.has('stream_options')) body.stream_options = { include_usage: true };
    if (temperature !== undefined && !deny.has('temperature')) body.temperature = temperature;
    const maxTokens = effective.maxTokens;
    if (maxTokens > 0) {
      body[ctx.quirks.maxTokensField ?? (ctx.caps.denylist?.includes('max_tokens') ? 'max_completion_tokens' : 'max_tokens')] =
        maxTokens;
    }
    if (req.stop !== undefined && req.stop.length > 0 && !deny.has('stop')) body.stop = [...req.stop];
    if (jsonObject && ctx.caps.jsonObject !== false) body.response_format = { type: 'json_object' };
    const tools = wireTools(req);
    if (tools !== undefined && !deny.has('tools')) {
      body.tools = tools;
      body.tool_choice = req.toolChoice === 'none' ? 'none' : 'auto';
    }
    applyEffort(body, ctx.caps.effortStyle, effective.level, ctx.caps, effective.budget);
    return body;
  },

  createStreamParser() {
    return chatStreamParser();
  },

  parseModels(json: unknown): ModelInfo[] | undefined {
    return parseModels(json);
  },
};
