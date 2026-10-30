/**
 * Golden tests for the `anthropic-messages` adapter — the Messages wire format:
 * top-level `system`, content-block arrays, `tool_result` inside user messages,
 * alternating-role merge, signed `thinking` replay, `thinking`/`output_config`
 * effort mapping, and the named-event SSE dialect.
 */

import { describe, expect, it } from 'vitest';
import { createSseParser } from '../src/sse.js';
import { anthropicMessagesAdapter } from '../src/adapters/anthropic-messages.js';
import { parseModels } from '../src/adapters/models.js';
import { resolveRoute } from '../src/presets/index.js';
import type { AdapterContext, QuirkFlags, StreamParser, StreamPiece } from '../src/adapters/types.js';
import type { ChatRequest, ModelCaps, ThinkingLevel } from '../src/types.js';
import { bodyInput, type BodyOver } from './helpers.js';

const CTX: AdapterContext = { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4', quirks: {}, caps: {} };

const ctx = (quirks: QuirkFlags = {}, caps: ModelCaps = {}, model = 'claude-sonnet-4'): AdapterContext => ({
  baseUrl: 'https://api.anthropic.com/v1',
  model,
  quirks,
  caps,
});

const body = (req: ChatRequest, over: BodyOver = {}): Record<string, unknown> =>
  anthropicMessagesAdapter.buildBody(bodyInput(req, over.ctx ?? CTX, { maxTokens: 8192, ...over }));

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
    anthropicMessagesAdapter.buildBody(
      bodyInput(
        { messages: [{ role: 'user', content: 'hi' }], thinking: level },
        ctx({}, { effortStyle: 'anthropic', effortLevels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'], ...caps }),
        { maxTokens: 8192 },
      ),
    );

  const adaptive: ModelCaps = { thinkingShape: 'adaptive', thinkingDisplay: 'summarized' };

  it('writes thinking {adaptive, summarized} plus output_config.effort per level, and never budget_tokens', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const built = think(level, adaptive);
      expect(built.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(built.output_config).toEqual({ effort: level });
      expect(JSON.stringify(built)).not.toContain('budget_tokens');
      expect(built.max_tokens).toBe(8192);
    }
  });

  it('asks for the omitted display only when the row says the route cannot summarise', () => {
    expect(think('low', { thinkingShape: 'adaptive', thinkingDisplay: 'omitted' }).thinking).toEqual({ type: 'adaptive', display: 'omitted' });
  });

  it('writes thinking {enabled, budget_tokens} plus output_config.effort on a budget row, with max_tokens above the budget', () => {
    const budget: ModelCaps = { thinkingShape: 'budget' };
    expect(think('low', budget)).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 1024 }, output_config: { effort: 'low' }, max_tokens: 9216 });
    expect(think('medium', budget)).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 4096 }, output_config: { effort: 'medium' }, max_tokens: 12288 });
    expect(think('high', budget)).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 16384 }, output_config: { effort: 'high' } });
    expect(think('max', budget)).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 32768 }, output_config: { effort: 'max' }, max_tokens: 40960 });
  });

  it('treats a row that names no thinkingShape as a budget row', () => {
    expect(think('low')).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 1024 } });
  });

  it('sends reasoningBudget as the budget on a budget row and ignores it beside off', () => {
    const asked = (thinking: ThinkingLevel | undefined, caps: ModelCaps): Record<string, unknown> =>
      anthropicMessagesAdapter.buildBody(
        bodyInput({ messages: [], thinking, reasoningBudget: 2_000 }, ctx({}, { effortStyle: 'anthropic', effortLevels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'], ...caps }), { maxTokens: 8192 }),
      );
    expect(asked('high', { thinkingShape: 'budget' })).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 2000 }, max_tokens: 10192 });
    expect(asked(undefined, { thinkingShape: 'budget' })).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 2000 }, output_config: { effort: 'low' } });
    expect(asked('off', { thinkingShape: 'budget' }).thinking).toEqual({ type: 'disabled' });
    expect(asked('high', adaptive)).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'high' }, max_tokens: 8192 });
  });

  it('drops temperature whenever thinking is on, adaptive and budget alike', () => {
    expect(think('high')).not.toHaveProperty('temperature');
    expect(think('high', adaptive)).not.toHaveProperty('temperature');
    expect(think('xhigh', { thinkingShape: 'budget' })).not.toHaveProperty('temperature');
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
    const noRow = anthropicMessagesAdapter.buildBody(bodyInput({ messages: [], thinking: 'high' }, ctx({}, {}), { maxTokens: 8192 }));
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

  it('treats a negative or infinite usage figure as no usage', () => {
    const negative =
      frame({ type: 'message_start', message: { usage: { input_tokens: -3, output_tokens: 1 } } }, 'message_start') +
      frame({ type: 'message_delta', delta: {}, usage: { output_tokens: -9 } }, 'message_delta');
    expect(parseStream(negative).pieces).toEqual([{ usage: { promptTokens: 0, completionTokens: 1 } }]);
    // JSON.parse turns 1e999 into Infinity.
    const infinite =
      frame('{"type":"message_start","message":{"usage":{"input_tokens":1e999,"output_tokens":2}}}', 'message_start') +
      frame('{"type":"message_delta","delta":{},"usage":{"output_tokens":1e999}}', 'message_delta');
    expect(parseStream(infinite).pieces).toEqual([{ usage: { promptTokens: 0, completionTokens: 2 } }]);
  });

  it('shows the summarised thinking of a Claude 5.x row and replays the signed block verbatim', () => {
    const route = resolveRoute({ preset: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' }, 'claude-opus-5-5');
    const five = ctx(route.quirks, route.caps, 'claude-opus-5-5');
    const text =
      frame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }, 'content_block_start') +
      frame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Weighing the two openings.' } }, 'content_block_delta') +
      frame({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-5' } }, 'content_block_delta') +
      frame({ type: 'content_block_stop', index: 0 }, 'content_block_stop');
    const { pieces, terminal } = parseStream(text, five);
    expect(pieces).toEqual([{ reasoning: 'Weighing the two openings.' }]);
    const block = { type: 'thinking', thinking: 'Weighing the two openings.', signature: 'sig-5' };
    expect(terminal.reasoning).toEqual([{ text: 'Weighing the two openings.', raw: block }]);
    const wire = anthropicMessagesAdapter.buildBody(
      bodyInput(
        {
          messages: [
            { role: 'user', content: 'go' },
            { role: 'assistant', content: '', reasoning: terminal.reasoning, toolCalls: [{ id: 't1', name: 'x', argumentsJson: '{}' }] },
            { role: 'tool', content: 'ok', toolCallId: 't1' },
          ],
          thinking: 'high',
        },
        five,
      ),
    );
    expect((wire.messages as { content: unknown }[])[1]?.content).toEqual([block, { type: 'tool_use', id: 't1', name: 'x', input: {} }]);
    expect(wire.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
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

  it('reads the window from max_input_tokens and the output cap from max_tokens', () => {
    expect(anthropicMessagesAdapter.parseModels({ data: [{ id: 'claude-sonnet-5-5', max_input_tokens: 1_000_000, max_tokens: 128_000 }] })).toEqual([
      { id: 'claude-sonnet-5-5', contextWindow: 1_000_000, maxOutputTokens: 128_000 },
    ]);
  });

  it('leaves the field out for a null or zero, which the schema allows', () => {
    expect(
      anthropicMessagesAdapter.parseModels({
        data: [
          { id: 'a', max_input_tokens: null, max_tokens: null },
          { id: 'b', max_input_tokens: 0, max_tokens: 0 },
          { id: 'c', max_input_tokens: 200_000, max_tokens: null },
        ],
      }),
    ).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c', contextWindow: 200_000 }]);
  });

  it('a window name the shared reader knows still wins, and the other adapters never read max_tokens', () => {
    expect(anthropicMessagesAdapter.parseModels({ data: [{ id: 'm', context_length: 8_000, max_input_tokens: 9_000 }] })).toEqual([
      { id: 'm', contextWindow: 8_000 },
    ]);
    expect(parseModels({ data: [{ id: 'm', max_input_tokens: 9_000, max_tokens: 4_000 }] })).toEqual([{ id: 'm' }]);
  });
});
