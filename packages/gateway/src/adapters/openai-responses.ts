/**
 * The `openai-responses` adapter — OpenAI Responses and compatible routes (OpenAI,
 * Meta/Muse, xAI, and gateways that expose the Responses format).
 *
 * The format differs from Chat Completions in every way the adapter owns: messages
 * are `input` items, system text rides in `instructions`, tools are flat
 * `{type:'function'}` entries, tool results are `function_call_output` items, and the
 * stream is named `response.*` events rather than `choices[].delta` chunks.
 *
 * Statefulness is a preset quirk (`quirks.stateless`), not a format assumption. The
 * shipped routes all resend full history: OpenAI and xAI send `store: false`, which
 * makes `previous_response_id` unusable, and Muse replays reasoning through
 * `include: ['reasoning.encrypted_content']`, whose encrypted blocks are stored on
 * `ReasoningBlock.raw` and resent verbatim.
 */

import type { SseEvent } from '../sse.js';
import type {
  ModelInfo,
  ReasoningBlock,
  ToolCall,
  Usage,
} from '../types.js';
import { applyEffort } from './effort.js';
import { parseModels } from './models.js';
import type {
  BodyInput,
  ProviderAdapter,
  StreamParser,
  StreamPiece,
} from './types.js';

function usageOf(raw: unknown): Usage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const prompt = record.input_tokens ?? record.prompt_tokens;
  const completion = record.output_tokens ?? record.completion_tokens;
  if (typeof prompt !== 'number' || typeof completion !== 'number') return undefined;
  return { promptTokens: prompt, completionTokens: completion };
}

/** System messages gather into `instructions`; the rest become input items. */
function wireInput(req: BodyInput['req']): { instructions?: string; input: unknown[] } {
  const instructions: string[] = [];
  const input: unknown[] = [];

  const format = req.responseFormat;
  if (format !== undefined && format !== 'text') {
    instructions.push(`Respond with JSON matching: ${JSON.stringify(format.jsonSchemaHint)}`);
  }

  for (const m of req.messages) {
    if (m.role === 'system') {
      instructions.push(m.content);
      continue;
    }
    if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      // Reasoning items replay verbatim (encrypted content included) before the message.
      for (const block of m.reasoning ?? []) {
        if (block.raw !== undefined && typeof block.raw === 'object') input.push(block.raw);
      }
      input.push({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: m.content }],
      });
      for (const call of m.toolCalls ?? []) {
        input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.argumentsJson });
      }
      continue;
    }
    input.push({ role: 'user', content: [{ type: 'input_text', text: m.content }] });
  }
  return { instructions: instructions.length > 0 ? instructions.join('\n\n') : undefined, input };
}

function responsesStreamParser(): StreamParser {
  const calls = new Map<string, ToolCall>();
  const order: string[] = [];
  const reasoning: ReasoningBlock[] = [];
  let reasoningText = '';

  const recordCall = (item: Record<string, unknown>): void => {
    if (item.type !== 'function_call') return;
    // Deltas accumulate under `item_id`; the call's own id on the wire is `call_id`. Key the map by the item id
    // (the two differ on the real wire — `fc_…` vs `call_…`) and emit `call_id` as the ToolCall's id, since a
    // `function_call_output` reply refers to it.
    const key =
      typeof item.id === 'string' && item.id !== '' ? item.id : typeof item.call_id === 'string' ? item.call_id : undefined;
    if (key === undefined || key === '') return;
    const callId = typeof item.call_id === 'string' && item.call_id !== '' ? item.call_id : key;
    const existing = calls.get(key);
    calls.set(key, {
      id: callId,
      name: typeof item.name === 'string' ? item.name : existing?.name ?? '',
      argumentsJson:
        typeof item.arguments === 'string' && item.arguments !== '' ? item.arguments : (existing?.argumentsJson ?? ''),
    });
    if (!order.includes(key)) order.push(key);
  };

  const recordReasoning = (item: Record<string, unknown>): void => {
    if (item.type !== 'reasoning') return;
    const summary = Array.isArray(item.summary)
      ? item.summary
          .map((s) => (typeof s === 'object' && s !== null ? (s as Record<string, unknown>).text : undefined))
          .filter((t): t is string => typeof t === 'string')
          .join('')
      : '';
    reasoning.push({ text: summary !== '' ? summary : reasoningText, raw: item });
    reasoningText = '';
  };

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
      const type = typeof record.type === 'string' ? record.type : ev.event;
      const pieces: StreamPiece[] = [];

      switch (type) {
        case 'response.output_text.delta': {
          const delta = record.delta;
          if (typeof delta === 'string' && delta !== '') pieces.push({ text: delta });
          break;
        }
        case 'response.reasoning_text.delta':
        case 'response.reasoning_summary_text.delta': {
          const delta = record.delta;
          if (typeof delta === 'string' && delta !== '') {
            reasoningText += delta;
            pieces.push({ reasoning: delta });
          }
          break;
        }
        case 'response.function_call_arguments.delta': {
          const itemId = typeof record.item_id === 'string' ? record.item_id : '';
          const delta = typeof record.delta === 'string' ? record.delta : '';
          const acc = calls.get(itemId) ?? { id: itemId, name: '', argumentsJson: '' };
          acc.argumentsJson += delta;
          calls.set(itemId, acc);
          if (!order.includes(itemId)) order.push(itemId);
          break;
        }
        case 'response.output_item.done': {
          const item = record.item;
          if (typeof item === 'object' && item !== null) {
            recordCall(item as Record<string, unknown>);
            recordReasoning(item as Record<string, unknown>);
          }
          break;
        }
        case 'response.completed': {
          const response = record.response as Record<string, unknown> | undefined;
          const usage = usageOf(response?.usage);
          if (usage !== undefined) pieces.push({ usage });
          pieces.push({ finish: order.length > 0 ? 'tool_calls' : 'stop' }, { done: true });
          break;
        }
        case 'response.incomplete': {
          const response = record.response as Record<string, unknown> | undefined;
          const usage = usageOf(response?.usage);
          if (usage !== undefined) pieces.push({ usage });
          pieces.push({ finish: 'length' }, { done: true });
          break;
        }
        case 'response.failed': {
          const response = record.response as Record<string, unknown> | undefined;
          const err = response?.error as Record<string, unknown> | undefined;
          pieces.push({ error: typeof err?.message === 'string' ? err.message : 'the response failed' });
          break;
        }
        case 'error': {
          const err = record.error as Record<string, unknown> | undefined;
          pieces.push({ error: typeof err?.message === 'string' ? err.message : data });
          break;
        }
        default:
          break;
      }
      return pieces;
    },
    finish() {
      const toolCalls = order.map((id) => calls.get(id)).filter((c): c is ToolCall => c !== undefined && c.id !== '');
      const reasoningOut = [...reasoning];
      if (reasoningText !== '') reasoningOut.push({ text: reasoningText });
      return {
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(reasoningOut.length > 0 ? { reasoning: reasoningOut } : {}),
      };
    },
  };
}

export const openaiResponsesAdapter: ProviderAdapter = {
  id: 'openai-responses',

  completePath() {
    return '/responses';
  },

  modelsPath() {
    return '/models';
  },

  headers(ctx, secrets) {
    const headers: Record<string, string> = {
      ...(ctx.quirks.versionHeaders ?? {}),
      ...(ctx.quirks.extraHeaders ?? {}),
    };
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
    // Custom headers go last: a generic profile's own headers are the escape hatch and may override any of the above.
    return { ...headers, ...Object.fromEntries((secrets.headers ?? []).map((h) => [h.name, h.value])) };
  },

  buildBody(input: BodyInput): Record<string, unknown> {
    const { req, ctx, temperature, effective } = input;
    const maxTokens = effective.maxTokens;
    const { instructions, input: items } = wireInput(req);
    const deny = new Set(ctx.caps.denylist ?? []);
    const body: Record<string, unknown> = {
      model: ctx.model,
      input: items,
      stream: true,
    };
    if (instructions !== undefined) body.instructions = instructions;
    if (maxTokens > 0) body.max_output_tokens = maxTokens;
    if (temperature !== undefined && !deny.has('temperature')) body.temperature = temperature;
    if (req.tools !== undefined && req.tools.length > 0 && !deny.has('tools')) {
      body.tools = req.tools.map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
      body.tool_choice = req.toolChoice === 'none' ? 'none' : 'auto';
    }
    if (ctx.quirks.store === true) body.store = false;
    if (ctx.quirks.includeEncryptedReasoning === true) body.include = ['reasoning.encrypted_content'];
    applyEffort(body, ctx.caps.effortStyle, effective.level, ctx.caps, effective.budget);
    return body;
  },

  createStreamParser() {
    return responsesStreamParser();
  },

  parseModels(json: unknown): ModelInfo[] | undefined {
    return parseModels(json);
  },
};
