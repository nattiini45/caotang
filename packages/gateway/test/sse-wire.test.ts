/**
 * The two codecs under the transport: SSE framing (§3) and the OpenAI wire format (§3,
 * §5). Each is tested without a network, against the byte-level cases a real provider
 * produces and the ones that break naive parsers.
 */

import { describe, expect, it } from 'vitest';
import { createSseParser, type SseEvent } from '../src/sse.js';
import { mapFinishReason, openaiChatAdapter, wireMessages } from '../src/adapters/openai-chat.js';
import { parseModels } from '../src/adapters/models.js';
import type { StreamPiece } from '../src/adapters/types.js';
import type { ChatRequest } from '../src/types.js';
import { bodyInput } from './helpers.js';

/** Feeds `text` through a parser in pieces and returns every event it produced. */
function parseIn(pieces: readonly string[]): SseEvent[] {
  const parser = createSseParser();
  const out: SseEvent[] = [];
  for (const piece of pieces) out.push(...parser.push(piece));
  out.push(...parser.end());
  return out;
}

/** Feeds `text` through the SSE parser, then the stream parser, and returns the pieces. */
function streamPieces(text: string): StreamPiece[] {
  const sse = createSseParser();
  const parser = openaiChatAdapter.createStreamParser({ baseUrl: '', model: 'm', quirks: {}, caps: {} });
  const events = [...sse.push(text), ...sse.end()];
  const out: StreamPiece[] = [];
  for (const ev of events) out.push(...parser.push(ev));
  return out;
}

describe('SSE parser', () => {
  it('yields one payload per event and keeps the event name, ignoring comments and other fields', () => {
    const text = ': keep-alive\n\nevent: message\nid: 7\ndata: {"a":1}\n\ndata: {"b":2}\n\n';
    expect(parseIn([text])).toEqual([{ event: 'message', data: '{"a":1}' }, { data: '{"b":2}' }]);
  });

  it('joins multi-line data with newlines, as the spec requires', () => {
    expect(parseIn(['data: line one\ndata: line two\n\n'])).toEqual([{ data: 'line one\nline two' }]);
  });

  it('accepts CRLF, lone CR, and LF endings alike', () => {
    expect(parseIn(['data: a\r\n\r\n'])).toEqual([{ data: 'a' }]);
    expect(parseIn(['data: b\r\r'])).toEqual([{ data: 'b' }]);
    expect(parseIn(['data: c\n\n'])).toEqual([{ data: 'c' }]);
  });

  it('gives the same payloads however the bytes are split across network chunks', () => {
    const text = 'data: {"x":"héllo"}\r\n\r\ndata: [DONE]\n\n';
    const whole = parseIn([text]);
    expect(whole).toEqual([{ data: '{"x":"héllo"}' }, { data: '[DONE]' }]);
    // Every split point, including the one between a \r and its \n.
    for (let cut = 0; cut <= text.length; cut += 1) {
      expect(parseIn([text.slice(0, cut), text.slice(cut)])).toEqual(whole);
    }
  });

  it('holds a trailing carriage return until the next chunk says whether a line feed follows', () => {
    const parser = createSseParser();
    expect(parser.push('data: a\r')).toEqual([]);
    expect(parser.push('\n\r\n')).toEqual([{ data: 'a' }]);
  });

  it('strips exactly one space after the colon and keeps the rest of the value', () => {
    expect(parseIn(['data:  two spaces\n\n'])).toEqual([{ data: ' two spaces' }]);
    expect(parseIn(['data:no-space\n\n'])).toEqual([{ data: 'no-space' }]);
  });

  it('skips events whose payload is empty', () => {
    expect(parseIn(['data:\n\n\n\ndata: real\n\n'])).toEqual([{ data: 'real' }]);
  });

  it('clears the event name on a blank line that dispatches nothing, as the spec does', () => {
    // The name belongs to the event it was declared in: the next event is unnamed.
    expect(parseIn(['event: response.completed\n\ndata: {"a":1}\n\n'])).toEqual([{ data: '{"a":1}' }]);
  });

  it('keeps an event that a truncated stream left open, so the caller can call it malformed', () => {
    expect(parseIn(['data: {"partial": tru'])).toEqual([{ data: '{"partial": tru' }]);
  });
});

describe('finish reason mapping (§3)', () => {
  it.each([
    ['stop', 'stop'],
    ['tool_calls', 'tool_calls'],
    ['function_call', 'stop'],
    ['length', 'length'],
    ['error', 'error'],
    ['content_filter', 'error'],
    ['something_new', 'error'],
  ])('maps %s to %s', (raw, expected) => {
    expect(mapFinishReason(raw)).toBe(expected);
  });

  it('leaves a null or absent reason unmapped, because the answer is not finished yet', () => {
    expect(mapFinishReason(null)).toBeUndefined();
    expect(mapFinishReason(undefined)).toBeUndefined();
  });
});

describe('the chat stream parser', () => {
  const frame = (payload: unknown): string => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;

  it('reads a content delta, ignoring an empty one', () => {
    expect(streamPieces(frame({ choices: [{ delta: { content: 'hi' }, finish_reason: null }] }))).toEqual([{ text: 'hi' }]);
    expect(streamPieces(frame({ choices: [{ delta: { content: '' }, finish_reason: null }] }))).toEqual([]);
    expect(streamPieces(frame({ choices: [{ delta: { role: 'assistant' } }] }))).toEqual([]);
  });

  it('reads usage from a chunk, and a finish reason from its choice', () => {
    const pieces = streamPieces(
      frame({ choices: [{ delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 } }),
    );
    expect(pieces).toEqual([{ usage: { promptTokens: 11, completionTokens: 4 } }, { finish: 'length' }]);
  });

  it('reads the usage-only chunk that arrives after the finish reason, with no choices', () => {
    expect(streamPieces(frame({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } }))).toEqual([
      { usage: { promptTokens: 3, completionTokens: 1 } },
    ]);
  });

  it('surfaces an in-stream error object, which some providers send with a 200', () => {
    expect(streamPieces(frame({ error: { message: 'upstream timed out', code: 504 } }))).toEqual([
      { error: 'upstream timed out' },
    ]);
  });

  it('ends the stream on [DONE]', () => {
    expect(streamPieces('data: [DONE]\n\n')).toEqual([{ done: true }]);
  });

  it('reports a malformed frame rather than guessing', () => {
    expect(streamPieces('data: {not json\n\n')).toEqual([{ malformed: '{not json' }]);
  });

  it('reads reasoning text and assembles tool calls across fragments', () => {
    const text =
      frame({ choices: [{ delta: { reasoning_content: 'hmm ' } }] }) +
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'binder.', arguments: '{"a":' } }] } }] }) +
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'create', arguments: '1}' } }] } }] }) +
      frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) +
      'data: [DONE]\n\n';
    const sse = createSseParser();
    const parser = openaiChatAdapter.createStreamParser({ baseUrl: '', model: 'm', quirks: {}, caps: {} });
    const pieces: StreamPiece[] = [];
    for (const ev of [...sse.push(text), ...sse.end()]) pieces.push(...parser.push(ev));
    expect(pieces.filter((p) => p.reasoning !== undefined)).toEqual([{ reasoning: 'hmm ' }]);
    expect(pieces.map((p) => p.finish).find(Boolean)).toBe('tool_calls');
    const terminal = parser.finish();
    expect(terminal.toolCalls).toEqual([{ id: 'call_1', name: 'binder.create', argumentsJson: '{"a":1}' }]);
    expect(terminal.reasoning).toEqual([{ text: 'hmm ' }]);
  });
});

describe('request body and structured output (§5)', () => {
  const ctx = { baseUrl: '', model: 'm', quirks: {}, caps: {} };

  it('appends the schema as the last system message, and only then', () => {
    const schema = { type: 'object', properties: { title: { type: 'string' } } };
    const wire = wireMessages({ messages: [{ role: 'user', content: 'draft' }], responseFormat: { jsonSchemaHint: schema } }, {});
    expect(wire.at(-1)).toEqual({ role: 'system', content: `Respond with JSON matching: ${JSON.stringify(schema)}` });
    expect(wire).toHaveLength(2);

    expect(wireMessages({ messages: [{ role: 'user', content: 'x' }], responseFormat: 'text' }, {})).toHaveLength(1);
    expect(wireMessages({ messages: [{ role: 'user', content: 'x' }] }, {})).toHaveLength(1);
  });

  it('streams with usage requested, and omits response_format unless the probe allowed it', () => {
    const base = bodyInput({ messages: [] }, ctx);
    const body = openaiChatAdapter.buildBody(base);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.max_tokens).toBe(4096);
    expect(body).not.toHaveProperty('response_format');
    expect(openaiChatAdapter.buildBody({ ...base, jsonObject: true }).response_format).toEqual({ type: 'json_object' });
  });

  it('sends stop sequences only when there are some', () => {
    const of = (req: ChatRequest) => bodyInput(req, ctx, { temperature: 0, maxTokens: 1 });
    expect(openaiChatAdapter.buildBody(of({ messages: [] }))).not.toHaveProperty('stop');
    expect(openaiChatAdapter.buildBody(of({ messages: [], stop: [] }))).not.toHaveProperty('stop');
    expect(openaiChatAdapter.buildBody(of({ messages: [], stop: ['END'] })).stop).toEqual(['END']);
  });

  it('writes tools in the nested function shape with tool_choice auto', () => {
    const body = openaiChatAdapter.buildBody(
      bodyInput(
        {
          messages: [],
          tools: [{ name: 'binder.create', description: 'make', parameters: { type: 'object' } }],
        },
        ctx,
      ),
    );
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'binder.create', description: 'make', parameters: { type: 'object' } } },
    ]);
    expect(body.tool_choice).toBe('auto');
  });
});

describe('parseModels', () => {
  it('reads the id and whichever context-window field the provider uses', () => {
    expect(
      parseModels({
        data: [
          { id: 'a', context_length: 8192 },
          { id: 'b', max_model_len: 32000 },
          { id: 'c' },
          { id: '' },
          'not-an-object',
        ],
      }),
    ).toEqual([{ id: 'a', contextWindow: 8192 }, { id: 'b', contextWindow: 32000 }, { id: 'c' }]);
  });

  it('accepts a models envelope and rejects a body with no list', () => {
    expect(parseModels({ models: [{ id: 'x' }] })).toEqual([{ id: 'x' }]);
    expect(parseModels({ error: 'nope' })).toBeUndefined();
    expect(parseModels('text')).toBeUndefined();
  });
});
