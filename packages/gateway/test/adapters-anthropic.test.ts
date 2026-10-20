/**
 * Golden tests for the `anthropic-messages` adapter — the Messages wire format:
 * top-level `system`, content-block arrays, `tool_result` inside user messages,
 * alternating-role merge, signed `thinking` replay, `thinking`/`output_config`
 * effort mapping, and the named-event SSE dialect.
 */

import { describe, expect, it } from 'vitest';
import { createSseParser } from '../src/sse.js';
import { anthropicMessagesAdapter } from '../src/adapters/anthropic-messages.js';
import type { AdapterContext, BodyInput, QuirkFlags, StreamParser, StreamPiece } from '../src/adapters/types.js';
import type { ChatRequest, ModelCaps, ThinkingLevel } from '../src/types.js';

const CTX: AdapterContext = { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4', quirks: {}, caps: {} };

const ctx = (quirks: QuirkFlags = {}, caps: ModelCaps = {}, model = 'claude-sonnet-4'): AdapterContext => ({
  baseUrl: 'https://api.anthropic.com/v1',
  model,
  quirks,
  caps,
});

const body = (req: ChatRequest, overrides: Partial<BodyInput> = {}): Record<string, unknown> =>
  anthropicMessagesAdapter.buildBody({ req, ctx: CTX, temperature: 0.7, maxTokens: 8192, jsonObject: false, ...overrides });

const frame = (payload: unknown, event?: string): string =>
  `${event === undefined ? '' : `event: ${event}\n`}data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;

function parseStream(text: string, c: AdapterContext = CTX): { pieces: StreamPiece[]; terminal: ReturnType<StreamParser['finish']> } {
  const sse = createSseParser();
  const parser = anthropicMessagesAdapter.createStreamParser(c);
  const pieces: StreamPiece[] = [];
  for (const ev of [...sse.push(text), ...sse.end()]) pieces.push(...parser.push(ev));
  return { pieces, terminal: parser.finish() };
}

describe('anthropic-messages buildBody', () => {
  it('lifts system messages into a top-level field and keeps alternating roles', () => {
    expect(
      body({
        messages: [
          { role: 'system', content: 'Be terse.' },
          { role: 'system', content: 'UK spelling.' },
          { role: 'user', content: 'Hello.' },
          { role: 'assistant', content: 'Hi.' },
          { role: 'user', content: 'Again.' },
        ],
        stop: ['END'],
      }),
    ).toEqual({
      model: 'claude-sonnet-4',
      system: 'Be terse.\n\nUK spelling.',
      messages: [
        { role: 'user', content: 'Hello.' },
        { role: 'assistant', content: [{ type: 'text', text: 'Hi.' }] },
        { role: 'user', content: 'Again.' },
      ],
      max_tokens: 8192,
      stream: true,
      temperature: 0.7,
      stop_sequences: ['END'],
    });
  });

  it('merges consecutive same-role messages — tool_result blocks ride inside a user message', () => {
    const built = body({
      messages: [
        { role: 'user', content: 'Make it.' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'toolu_1', name: 'binder.create', argumentsJson: '{"a":1}' }] },
        { role: 'tool', toolCallId: 'toolu_1', content: '{"ok":true}' },
        { role: 'tool', toolCallId: 'toolu_2', content: 'denied', isError: true },
        { role: 'user', content: 'done?' },
      ],
    });
    expect(built.messages).toEqual([
      { role: 'user', content: 'Make it.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'binder.create', input: { a: 1 } }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"ok":true}' },
          { type: 'tool_result', tool_use_id: 'toolu_2', content: 'denied', is_error: true },
          { type: 'text', text: 'done?' },
        ],
      },
    ]);
  });

  it('merges consecutive plain user messages into one content array', () => {
    const built = body({
      messages: [
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
        { role: 'assistant', content: 'c' },
        { role: 'assistant', content: 'd' },
      ],
    });
    expect(built.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'c' }, { type: 'text', text: 'd' }] },
    ]);
  });

  it('replays thinking blocks and tool_use verbatim inside the assistant content array', () => {
    const thinking = { type: 'thinking', thinking: 'let me check', signature: 'sig-abc' };
    const built = body({
      messages: [
        {
          role: 'assistant',
          content: 'Done.',
          reasoning: [{ text: 'let me check', raw: thinking }, { text: 'unsigned thought' }],
          toolCalls: [{ id: 'toolu_1', name: 'binder.create', argumentsJson: '{"a":1}' }],
        },
      ],
    });
    const content = (built.messages as { content: unknown[] }[])[0]?.content;
    expect(content).toEqual([
      thinking,
      { type: 'thinking', thinking: 'unsigned thought', signature: '' },
      { type: 'text', text: 'Done.' },
      { type: 'tool_use', id: 'toolu_1', name: 'binder.create', input: { a: 1 } },
    ]);
    expect(content?.[0]).toBe(thinking);
  });

  it('writes tool_use input as the parsed arguments object, empty when unparseable', () => {
    const built = body({
      messages: [
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 't1', name: 'ok', argumentsJson: '{"a":1}' },
            { id: 't2', name: 'bad', argumentsJson: '{not json' },
          ],
        },
      ],
    });
    expect((built.messages as { content: unknown[] }[])[0]?.content).toEqual([
      { type: 'tool_use', id: 't1', name: 'ok', input: { a: 1 } },
      { type: 'tool_use', id: 't2', name: 'bad', input: {} },
    ]);
  });

  it('writes the schema hint as a leading user message, merged when a user message follows', () => {
    const schema = { type: 'object' };
    const hint = `Respond with JSON matching: ${JSON.stringify(schema)}`;
    const merged = body({ messages: [{ role: 'user', content: 'draft' }], responseFormat: { jsonSchemaHint: schema } });
    expect(merged.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: hint }, { type: 'text', text: 'draft' }] }]);
    const leading = body({ messages: [{ role: 'assistant', content: 'earlier' }, { role: 'user', content: 'draft' }], responseFormat: { jsonSchemaHint: schema } });
    expect(leading.messages).toEqual([
      { role: 'user', content: hint },
      { role: 'assistant', content: [{ type: 'text', text: 'earlier' }] },
      { role: 'user', content: 'draft' },
    ]);
  });

  it('writes tools with input_schema and a typed tool_choice', () => {
    const tools = [{ name: 'binder.create', description: 'Make a document', parameters: { type: 'object' } }];
    const built = body({ messages: [{ role: 'user', content: 'x' }], tools });
    expect(built.tools).toEqual([{ name: 'binder.create', description: 'Make a document', input_schema: { type: 'object' } }]);
    expect(built.tool_choice).toEqual({ type: 'auto' });
    expect(body({ messages: [{ role: 'user', content: 'x' }], tools, toolChoice: 'none' }).tool_choice).toEqual({ type: 'none' });
  });

  it('always sends max_tokens verbatim, even a zero cap', () => {
    expect(body({ messages: [] }, { maxTokens: 0 }).max_tokens).toBe(0);
  });

  it('drops denylisted fields', () => {
    const built = body(
      { messages: [{ role: 'user', content: 'x' }], stop: ['END'], tools: [{ name: 't', description: 'd', parameters: {} }] },
      { ctx: ctx({}, { denylist: ['temperature', 'tools', 'stop'] }) },
    );
    expect(built).not.toHaveProperty('temperature');
    expect(built).not.toHaveProperty('tools');
    expect(built).not.toHaveProperty('stop_sequences');
  });
});

describe('anthropic-messages headers', () => {
  const secrets = { apiKey: 'sk-ant-abc' };

  it('sends anthropic-version and x-api-key, and no browser-access flag unless the route asks for it', () => {
    expect(anthropicMessagesAdapter.headers(CTX, secrets, 'complete')).toEqual({
      'anthropic-version': '2023-06-01',
      'x-api-key': 'sk-ant-abc',
    });
  });

  it('sends the browser-access flag when the route asks for it', () => {
    expect(anthropicMessagesAdapter.headers(ctx({ browserAccess: true }), secrets, 'complete')).toEqual({
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'x-api-key': 'sk-ant-abc',
    });
  });

  it('honours bearer and api-key auth quirks', () => {
    expect(anthropicMessagesAdapter.headers(ctx({ auth: 'bearer' }), secrets, 'complete')).toMatchObject({ authorization: 'Bearer sk-ant-abc' });
    expect(anthropicMessagesAdapter.headers(ctx({ auth: 'api-key' }), secrets, 'complete')).toMatchObject({ 'api-key': 'sk-ant-abc' });
  });

  it('omits the browser-access flag when the quirk turns it off', () => {
    const headers = anthropicMessagesAdapter.headers(ctx({ browserAccess: false }), secrets, 'complete');
    expect(headers).toEqual({ 'anthropic-version': '2023-06-01', 'x-api-key': 'sk-ant-abc' });
  });

  it('lets versionHeaders and custom sealed headers through, and works keyless', () => {
    expect(
      anthropicMessagesAdapter.headers(
        ctx({ versionHeaders: { 'anthropic-version': '2024-06-01', 'anthropic-beta': 'tools-2024-04-04' } }),
        { headers: [{ name: 'x-custom', value: 'v1' }] },
        'complete',
      ),
    ).toEqual({
      'anthropic-version': '2024-06-01',
      'anthropic-beta': 'tools-2024-04-04',
      'x-custom': 'v1',
    });
  });
});

describe('anthropic-messages thinking mapping', () => {
  const think = (level: ThinkingLevel | undefined, caps: ModelCaps = {}): Record<string, unknown> =>
    anthropicMessagesAdapter.buildBody({
      req: { messages: [{ role: 'user', content: 'hi' }], thinking: level },
      ctx: ctx({}, { effortStyle: 'anthropic', effortLevels: ['off', 'low', 'medium', 'high', 'max'], ...caps }),
      temperature: 0.7,
      maxTokens: 8192,
      jsonObject: false,
    });

  it('writes thinking {enabled, budget_tokens} plus output_config.effort per level', () => {
    expect(think('low')).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 1024 }, output_config: { effort: 'low' } });
    expect(think('medium')).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 4096 }, output_config: { effort: 'medium' } });
    expect(think('high')).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 16384 }, output_config: { effort: 'high' } });
    expect(think('max')).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 32768 }, output_config: { effort: 'max' } });
  });

  it('drops temperature when thinking is enabled — the route rejects the pair', () => {
    expect(think('high')).not.toHaveProperty('temperature');
  });

  it('off disables thinking, keeps temperature, and sends no output_config', () => {
    const built = think('off');
    expect(built.thinking).toEqual({ type: 'disabled' });
    expect(built).not.toHaveProperty('output_config');
    expect(built.temperature).toBe(0.7);
  });

  it('sends nothing for a level the capability row does not list, and keeps temperature', () => {
    const built = think('high', { effortLevels: ['low', 'medium'] });
    expect(built).not.toHaveProperty('thinking');
    expect(built).not.toHaveProperty('output_config');
    expect(built.temperature).toBe(0.7);
  });

  it('sends nothing without a requested level or without a levels row', () => {
    expect(think(undefined)).not.toHaveProperty('thinking');
    expect(think('high', { effortLevels: [] })).not.toHaveProperty('thinking');
    const noRow = anthropicMessagesAdapter.buildBody({
      req: { messages: [], thinking: 'high' },
      ctx: ctx({}, {}),
      temperature: 0.7,
      maxTokens: 8192,
      jsonObject: false,
    });
    expect(noRow).not.toHaveProperty('thinking');
  });
});

describe('anthropic-messages stream parsing', () => {
  it('reads a thinking + text + tool_use stream end to end', () => {
    const text =
      frame({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4', usage: { input_tokens: 25, output_tokens: 1 } } }, 'message_start') +
      frame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }, 'content_block_start') +
      frame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me ' } }, 'content_block_delta') +
      frame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'check.' } }, 'content_block_delta') +
      frame({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } }, 'content_block_delta') +
      frame({ type: 'content_block_stop', index: 0 }, 'content_block_stop') +
      frame({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }, 'content_block_start') +
      frame({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Done.' } }, 'content_block_delta') +
      frame({ type: 'content_block_stop', index: 1 }, 'content_block_stop') +
      frame({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'binder.create' } }, 'content_block_start') +
      frame({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"a":' } }, 'content_block_delta') +
      frame({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '1}' } }, 'content_block_delta') +
      frame({ type: 'content_block_stop', index: 2 }, 'content_block_stop') +
      frame({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 40 } }, 'message_delta') +
      frame({ type: 'message_stop' }, 'message_stop');

    const { pieces, terminal } = parseStream(text);
    expect(pieces.filter((p) => p.reasoning !== undefined)).toEqual([{ reasoning: 'Let me ' }, { reasoning: 'check.' }]);
    expect(pieces.filter((p) => p.text !== undefined)).toEqual([{ text: 'Done.' }]);
    expect(pieces).toContainEqual({ finish: 'tool_calls' });
    expect(pieces.at(-1)).toEqual({ usage: { promptTokens: 25, completionTokens: 40 } });
    expect(pieces.at(-2)).toEqual({ done: true });
    expect(terminal.toolCalls).toEqual([{ id: 'toolu_1', name: 'binder.create', argumentsJson: '{"a":1}' }]);
    expect(terminal.reasoning).toEqual([
      { text: 'Let me check.', raw: { type: 'thinking', thinking: 'Let me check.', signature: 'sig-1' } },
    ]);
  });

  it.each([
    ['end_turn', 'stop'],
    ['stop_sequence', 'stop'],
    ['pause_turn', 'stop'],
    ['tool_use', 'tool_calls'],
    ['max_tokens', 'length'],
    ['refusal', 'error'],
  ])('maps stop_reason %s to %s', (raw, expected) => {
    const text = frame({ type: 'message_delta', delta: { stop_reason: raw } }, 'message_delta');
    expect(parseStream(text).pieces).toEqual([{ finish: expected }]);
  });

  it('emits usage on message_delta even without a stop reason', () => {
    const text =
      frame({ type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 1 } } }, 'message_start') +
      frame({ type: 'message_delta', delta: {}, usage: { output_tokens: 9 } }, 'message_delta');
    expect(parseStream(text).pieces).toEqual([{ usage: { promptTokens: 12, completionTokens: 9 } }]);
  });

  it('captures a redacted_thinking block for verbatim replay', () => {
    const text = frame(
      { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'encrypted-blob' } },
      'content_block_start',
    );
    const { terminal } = parseStream(text);
    expect(terminal.reasoning).toEqual([{ text: '', raw: { type: 'redacted_thinking', data: 'encrypted-blob' } }]);
  });

  it('surfaces an in-band error event as a provider error piece', () => {
    const text = frame({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'error');
    expect(parseStream(text).pieces).toEqual([{ error: 'Overloaded' }]);
  });

  it('ignores pings and unknown events, reads the event name when the payload lacks a type', () => {
    const text =
      frame({ type: 'ping' }, 'ping') +
      frame({ delta: { type: 'text_delta', text: 'unnamed' }, index: 0, content_block: undefined }, 'content_block_delta');
    expect(parseStream(text).pieces).toEqual([{ text: 'unnamed' }]);
  });

  it('reports malformed frames rather than guessing', () => {
    expect(parseStream('data: {not json\n\n').pieces).toEqual([{ malformed: '{not json' }]);
    expect(parseStream(frame({ content_block: undefined }, 'content_block_start')).pieces).toEqual([]);
  });
});

describe('anthropic-messages paths and model listing', () => {
  it('joins the messages and models paths to the base', () => {
    expect(anthropicMessagesAdapter.completePath('claude-sonnet-4')).toBe('/messages');
    expect(anthropicMessagesAdapter.modelsPath(CTX)).toBe('/models');
  });

  it('reads the data/models envelope', () => {
    expect(anthropicMessagesAdapter.parseModels({ data: [{ id: 'claude-sonnet-4' }] })).toEqual([{ id: 'claude-sonnet-4' }]);
    expect(anthropicMessagesAdapter.parseModels(42)).toBeUndefined();
  });
});
