/**
 * Golden tests for the `openai-responses` adapter — the Responses wire format: `input`
 * items with `instructions`, flat tool declarations, `function_call_output` replay,
 * verbatim reasoning items, and the named `response.*` SSE dialect.
 */

import { describe, expect, it } from 'vitest';
import { createSseParser } from '../src/sse.js';
import { openaiResponsesAdapter } from '../src/adapters/openai-responses.js';
import type { AdapterContext, QuirkFlags, StreamParser, StreamPiece } from '../src/adapters/types.js';
import type { ChatRequest, ModelCaps } from '../src/types.js';
import { bodyInput, type BodyOver } from './helpers.js';

const CTX: AdapterContext = { baseUrl: 'https://api.example/v1', model: 'gpt-5.1', quirks: {}, caps: {} };

const ctx = (quirks: QuirkFlags = {}, caps: ModelCaps = {}, model = 'gpt-5.1'): AdapterContext => ({
  baseUrl: 'https://api.example/v1',
  model,
  quirks,
  caps,
});

const body = (req: ChatRequest, over: BodyOver = {}): Record<string, unknown> =>
  openaiResponsesAdapter.buildBody(bodyInput(req, over.ctx ?? CTX, over));

const frame = (payload: unknown, event?: string): string =>
  `${event === undefined ? '' : `event: ${event}\n`}data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;

function parseStream(text: string, c: AdapterContext = CTX): { pieces: StreamPiece[]; terminal: ReturnType<StreamParser['finish']> } {
  const sse = createSseParser();
  const parser = openaiResponsesAdapter.createStreamParser(c);
  const pieces: StreamPiece[] = [];
  for (const ev of [...sse.push(text), ...sse.end()]) pieces.push(...parser.push(ev));
  return { pieces, terminal: parser.finish() };
}

describe('openai-responses buildBody', () => {
  it('writes the documented Responses body: instructions, input items, stream', () => {
    expect(
      body({
        messages: [
          { role: 'system', content: 'Be terse.' },
          { role: 'user', content: 'Hello.' },
          { role: 'assistant', content: 'Hi there.' },
          { role: 'user', content: 'Again.' },
        ],
      }),
    ).toEqual({
      model: 'gpt-5.1',
      instructions: 'Be terse.',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'Hello.' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi there.' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'Again.' }] },
      ],
      stream: true,
      max_output_tokens: 4096,
      temperature: 0.7,
    });
  });

  it('joins several system messages into one instructions string, schema hint first', () => {
    const built = body({
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'system', content: 'UK spelling.' },
        { role: 'user', content: 'hi' },
      ],
      responseFormat: { jsonSchemaHint: { type: 'object' } },
    });
    expect(built.instructions).toBe(`Respond with JSON matching: {"type":"object"}\n\nBe terse.\n\nUK spelling.`);
  });

  it('writes tools flat with a function type, and tool_choice from the request', () => {
    const tools = [{ name: 'binder.create', description: 'Make a document', parameters: { type: 'object' } }];
    const built = body({ messages: [], tools });
    expect(built.tools).toEqual([{ type: 'function', name: 'binder.create', description: 'Make a document', parameters: { type: 'object' } }]);
    expect(built.tool_choice).toBe('auto');
    expect(body({ messages: [], tools, toolChoice: 'none' }).tool_choice).toBe('none');
  });

  it('replays function_call_output items for tool messages', () => {
    const built = body({
      messages: [
        { role: 'user', content: 'Make it.' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'binder.create', argumentsJson: '{"a":1}' }] },
        { role: 'tool', toolCallId: 'call_1', content: '{"ok":true}' },
        { role: 'user', content: 'done?' },
      ],
    });
    expect(built.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Make it.' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '' }] },
      { type: 'function_call', call_id: 'call_1', name: 'binder.create', arguments: '{"a":1}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' },
      { role: 'user', content: [{ type: 'input_text', text: 'done?' }] },
    ]);
  });

  it('replays reasoning items verbatim ahead of the assistant message', () => {
    const rawItem = { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'planned' }], encrypted_content: 'enc-1' };
    const built = body({
      messages: [
        {
          role: 'assistant',
          content: 'done',
          reasoning: [{ text: 'planned', raw: rawItem }],
          toolCalls: [{ id: 'call_1', name: 'f', argumentsJson: '{}' }],
        },
      ],
    });
    expect(built.input).toEqual([
      rawItem,
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
      { type: 'function_call', call_id: 'call_1', name: 'f', arguments: '{}' },
    ]);
    expect((built.input as unknown[])[0]).toBe(rawItem);
  });

  it('drops a reasoning block that carries no provider raw item', () => {
    const built = body({ messages: [{ role: 'assistant', content: 'done', reasoning: [{ text: 'text only' }] }] });
    expect(built.input).toEqual([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }]);
  });

  it('never sends previous_response_id — full history is resent every call', () => {
    expect(body({ messages: [{ role: 'user', content: 'x' }] }, { ctx: ctx({ stateless: true }) })).not.toHaveProperty('previous_response_id');
    expect(body({ messages: [{ role: 'user', content: 'x' }] })).not.toHaveProperty('previous_response_id');
  });

  it('sends store:false when the quirk marks the route non-storing', () => {
    expect(body({ messages: [] }, { ctx: ctx({ store: true }) }).store).toBe(false);
    expect(body({ messages: [] })).not.toHaveProperty('store');
  });

  it('requests encrypted reasoning content when the quirk asks for it', () => {
    expect(body({ messages: [] }, { ctx: ctx({ includeEncryptedReasoning: true }) }).include).toEqual(['reasoning.encrypted_content']);
    expect(body({ messages: [] })).not.toHaveProperty('include');
  });

  it('omits max_output_tokens when the cap resolved to zero', () => {
    expect(body({ messages: [] }, { maxTokens: 0 })).not.toHaveProperty('max_output_tokens');
  });
});

describe('openai-responses headers', () => {
  const secrets = { apiKey: 'sk-live-abc' };

  it('defaults to an authorization bearer header', () => {
    expect(openaiResponsesAdapter.headers(CTX, secrets, 'complete')).toEqual({ authorization: 'Bearer sk-live-abc' });
  });

  it('sends the key under x-api-key or api-key when the quirk says so', () => {
    expect(openaiResponsesAdapter.headers(ctx({ auth: 'x-api-key' }), secrets, 'complete')).toEqual({ 'x-api-key': 'sk-live-abc' });
    expect(openaiResponsesAdapter.headers(ctx({ auth: 'api-key' }), secrets, 'complete')).toEqual({ 'api-key': 'sk-live-abc' });
  });

  it('sends no auth header without a key, but still sends preset and custom headers', () => {
    expect(openaiResponsesAdapter.headers(CTX, {}, 'complete')).toEqual({});
    expect(
      openaiResponsesAdapter.headers(
        ctx({ versionHeaders: { 'x-version': '2' }, extraHeaders: { 'user-agent': 'caotang/1' } }),
        { headers: [{ name: 'x-custom', value: 'v1' }] },
        'models',
      ),
    ).toEqual({ 'x-version': '2', 'user-agent': 'caotang/1', 'x-custom': 'v1' });
  });
});

describe('openai-responses effort and denylist', () => {
  it('maps thinking through reasoning.effort, the Responses style', () => {
    const built = openaiResponsesAdapter.buildBody(
      bodyInput({ messages: [], thinking: 'high' }, ctx({}, { effortStyle: 'reasoning.effort', effortLevels: ['off', 'low', 'medium', 'high', 'max'] })),
    );
    expect(built.reasoning).toEqual({ effort: 'high' });
  });

  it('sends no effort fields for a level the row does not list', () => {
    const built = openaiResponsesAdapter.buildBody(
      bodyInput({ messages: [], thinking: 'high' }, ctx({}, { effortStyle: 'reasoning.effort', effortLevels: ['low'] })),
    );
    expect(built).not.toHaveProperty('reasoning');
  });

  it('drops denylisted fields', () => {
    const built = body(
      { messages: [], tools: [{ name: 't', description: 'd', parameters: {} }] },
      { ctx: ctx({}, { denylist: ['temperature', 'tools'] }) },
    );
    expect(built).not.toHaveProperty('temperature');
    expect(built).not.toHaveProperty('tools');
    expect(built).not.toHaveProperty('tool_choice');
  });
});

describe('openai-responses stream parsing', () => {
  it('reads output_text deltas through response.completed, with usage and finish', () => {
    const text =
      frame({ type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } }, 'response.created') +
      frame({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Hel' }, 'response.output_text.delta') +
      frame({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'lo.' }, 'response.output_text.delta') +
      frame(
        {
          type: 'response.completed',
          response: { id: 'resp_1', status: 'completed', usage: { input_tokens: 25, output_tokens: 4, total_tokens: 29 } },
        },
        'response.completed',
      );
    const { pieces, terminal } = parseStream(text);
    expect(pieces).toEqual([
      { text: 'Hel' },
      { text: 'lo.' },
      { usage: { promptTokens: 25, completionTokens: 4 } },
      { finish: 'stop' },
      { done: true },
    ]);
    expect(terminal).toEqual({});
  });

  it('finishes tool_calls when response.completed follows recorded calls', () => {
    const text =
      frame(
        { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'binder.create', arguments: '{"a":' } },
        'response.output_item.done',
      ) +
      frame({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '1}' }, 'response.function_call_arguments.delta') +
      frame({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 8 } } }, 'response.completed');
    const { pieces, terminal } = parseStream(text);
    expect(pieces).toEqual([{ usage: { promptTokens: 10, completionTokens: 8 } }, { finish: 'tool_calls' }, { done: true }]);
    expect(terminal.toolCalls).toEqual([{ id: 'call_1', name: 'binder.create', argumentsJson: '{"a":1}' }]);
  });

  it('captures a reasoning item verbatim for replay, summary text as its display', () => {
    const item = {
      type: 'reasoning',
      id: 'rs_1',
      summary: [{ type: 'summary_text', text: 'thought it through' }],
      encrypted_content: 'enc-9',
    };
    const text =
      frame({ type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'thinking ' }, 'response.reasoning_summary_text.delta') +
      frame({ type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'hard' }, 'response.reasoning_summary_text.delta') +
      frame({ type: 'response.output_item.done', output_index: 0, item }, 'response.output_item.done') +
      frame({ type: 'response.completed', response: { status: 'completed' } }, 'response.completed');
    const { pieces, terminal } = parseStream(text);
    expect(pieces.filter((p) => p.reasoning !== undefined)).toEqual([{ reasoning: 'thinking ' }, { reasoning: 'hard' }]);
    expect(terminal.reasoning).toEqual([{ text: 'thought it through', raw: item }]);
  });

  it('falls back to the streamed reasoning text when the item has no summary', () => {
    const text =
      frame({ type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'streamed text' }, 'response.reasoning_summary_text.delta') +
      frame({ type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [] } }, 'response.output_item.done');
    const { terminal } = parseStream(text);
    expect(terminal.reasoning).toEqual([{ text: 'streamed text', raw: { type: 'reasoning', id: 'rs_1', summary: [] } }]);
  });

  it('keeps dangling reasoning deltas as a block when no item.done arrives', () => {
    const text = frame({ type: 'response.reasoning_text.delta', delta: 'unclosed' }, 'response.reasoning_text.delta');
    const { terminal } = parseStream(text);
    expect(terminal.reasoning).toEqual([{ text: 'unclosed' }]);
  });

  it('maps response.incomplete to a length finish, with usage', () => {
    const text = frame(
      {
        type: 'response.incomplete',
        response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 10, output_tokens: 50 } },
      },
      'response.incomplete',
    );
    expect(parseStream(text).pieces).toEqual([{ usage: { promptTokens: 10, completionTokens: 50 } }, { finish: 'length' }, { done: true }]);
  });

  it('surfaces response.failed as an error piece, with a default when the body has none', () => {
    expect(
      parseStream(
        frame({ type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: 'something broke' } } }, 'response.failed'),
      ).pieces,
    ).toEqual([{ error: 'something broke' }]);
    expect(parseStream(frame({ type: 'response.failed', response: { status: 'failed' } }, 'response.failed')).pieces).toEqual([
      { error: 'the response failed' },
    ]);
  });

  it('surfaces a mid-stream error event as an error piece', () => {
    expect(parseStream(frame({ type: 'error', error: { message: 'bad stream' } }, 'error')).pieces).toEqual([{ error: 'bad stream' }]);
  });

  it('reads the event name when the payload carries no type of its own', () => {
    const text = frame({ delta: 'via event name' }, 'response.output_text.delta');
    expect(parseStream(text).pieces).toEqual([{ text: 'via event name' }]);
  });

  it('ends on [DONE] and reports malformed frames', () => {
    expect(parseStream('data: [DONE]\n\n').pieces).toEqual([{ done: true }]);
    expect(parseStream('data: {not json\n\n').pieces).toEqual([{ malformed: '{not json' }]);
  });
});

describe('openai-responses paths and model listing', () => {
  it('joins the responses and models paths to the base', () => {
    expect(openaiResponsesAdapter.completePath('gpt-5.1')).toBe('/responses');
    expect(openaiResponsesAdapter.modelsPath(CTX)).toBe('/models');
  });

  it('reads the OpenAI models envelope', () => {
    expect(openaiResponsesAdapter.parseModels({ data: [{ id: 'a' }] })).toEqual([{ id: 'a' }]);
    expect(openaiResponsesAdapter.parseModels('nope')).toBeUndefined();
  });
});
