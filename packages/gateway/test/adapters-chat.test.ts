/**
 * Golden tests for the `openai-chat` adapter — Chat Completions and every compatible
 * route. Covers the request body byte-for-byte, the auth header variants, the effort
 * styles `applyEffort` maps, the denylist and max-tokens-field quirks, assistant-message
 * replay, the recorded-SSE stream dialect, and `routeFor`'s model→adapter map.
 */

import { describe, expect, it } from 'vitest';
import { createSseParser } from '../src/sse.js';
import { openaiChatAdapter, wireMessages } from '../src/adapters/openai-chat.js';
import { applyEffort } from '../src/adapters/effort.js';
import { routeFor, type AdapterContext, type QuirkFlags, type StreamParser, type StreamPiece } from '../src/adapters/types.js';
import type { ChatRequest, ModelCaps, ThinkingLevel } from '../src/types.js';
import { bodyInput, type BodyOver } from './helpers.js';

const CTX: AdapterContext = { baseUrl: 'https://api.example/v1', model: 'model-x', quirks: {}, caps: {} };

const ctx = (quirks: QuirkFlags = {}, caps: ModelCaps = {}, model = 'model-x'): AdapterContext => ({
  baseUrl: 'https://api.example/v1',
  model,
  quirks,
  caps,
});

const body = (req: ChatRequest, over: BodyOver = {}): Record<string, unknown> =>
  openaiChatAdapter.buildBody(bodyInput(req, over.ctx ?? CTX, over));

const user = (content: string): ChatRequest => ({ messages: [{ role: 'user', content }] });

/** One SSE frame: `data: <json>` (or a raw string like `[DONE]`), with an optional event name. */
const frame = (payload: unknown, event?: string): string =>
  `${event === undefined ? '' : `event: ${event}\n`}data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;

/** Feeds recorded SSE text through the SSE parser and the adapter's stream parser. */
function parseStream(text: string, c: AdapterContext = CTX): { pieces: StreamPiece[]; terminal: ReturnType<StreamParser['finish']> } {
  const sse = createSseParser();
  const parser = openaiChatAdapter.createStreamParser(c);
  const pieces: StreamPiece[] = [];
  for (const ev of [...sse.push(text), ...sse.end()]) pieces.push(...parser.push(ev));
  return { pieces, terminal: parser.finish() };
}

const EFFORT_FIELDS = ['reasoning_effort', 'reasoning', 'thinking', 'enable_thinking', 'thinking_budget', 'max_effort'] as const;

/** Builds a body for one (style, level) pair and returns the effort fields it wrote. */
function effortFields(style: string, level: ThinkingLevel | undefined, caps: ModelCaps = {}): Record<string, unknown> {
  const built = openaiChatAdapter.buildBody(
    bodyInput(
      { messages: [{ role: 'user', content: 'hi' }], thinking: level },
      ctx({}, { effortStyle: style, effortLevels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'], ...caps }),
      { temperature: 0.5, maxTokens: 1024 },
    ),
  );
  return Object.fromEntries(EFFORT_FIELDS.filter((k) => k in built).map((k) => [k, built[k]]));
}

describe('openai-chat buildBody', () => {
  it('writes the documented chat-completions body exactly', () => {
    expect(
      body({
        messages: [
          { role: 'system', content: 'Be terse.' },
          { role: 'user', content: 'Hello.' },
        ],
        stop: ['THE END'],
      }),
    ).toEqual({
      model: 'model-x',
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'Hello.' },
      ],
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.7,
      max_tokens: 4096,
      stop: ['THE END'],
    });
  });

  it('writes tools nested under function, with tool_choice from the request', () => {
    const tools = [{ name: 'binder.create', description: 'Make a document', parameters: { type: 'object', properties: { title: { type: 'string' } } } }];
    const auto = body({ messages: [], tools });
    expect(auto.tools).toEqual([
      { type: 'function', function: { name: 'binder.create', description: 'Make a document', parameters: { type: 'object', properties: { title: { type: 'string' } } } } },
    ]);
    expect(auto.tool_choice).toBe('auto');
    expect(body({ messages: [], tools, toolChoice: 'none' }).tool_choice).toBe('none');
    expect(body(user('x'))).not.toHaveProperty('tools');
  });

  it('sends response_format json_object only when the probe allowed it', () => {
    expect(body(user('x'), { jsonObject: true }).response_format).toEqual({ type: 'json_object' });
    expect(body(user('x'), { jsonObject: true, ctx: ctx({}, { jsonObject: false }) })).not.toHaveProperty('response_format');
  });

  it('omits max_tokens when the cap resolved to zero', () => {
    expect(body(user('x'), { maxTokens: 0 })).not.toHaveProperty('max_tokens');
  });

  it('appends the schema-hint system message after the conversation', () => {
    const schema = { type: 'object' };
    expect(body({ messages: [{ role: 'user', content: 'draft' }], responseFormat: { jsonSchemaHint: schema } }).messages).toEqual([
      { role: 'user', content: 'draft' },
      { role: 'system', content: `Respond with JSON matching: ${JSON.stringify(schema)}` },
    ]);
  });
});

describe('openai-chat headers', () => {
  const secrets = { apiKey: 'sk-live-abc' };

  it('defaults to an authorization bearer header', () => {
    expect(openaiChatAdapter.headers(CTX, secrets, 'complete')).toEqual({ authorization: 'Bearer sk-live-abc' });
  });

  it('sends the key under x-api-key or api-key when the quirk says so', () => {
    expect(openaiChatAdapter.headers(ctx({ auth: 'x-api-key' }), secrets, 'complete')).toEqual({ 'x-api-key': 'sk-live-abc' });
    expect(openaiChatAdapter.headers(ctx({ auth: 'api-key' }), secrets, 'complete')).toEqual({ 'api-key': 'sk-live-abc' });
  });

  it('sends no auth header when there is no key, and none for an empty key', () => {
    expect(openaiChatAdapter.headers(CTX, {}, 'complete')).toEqual({});
    expect(openaiChatAdapter.headers(CTX, { apiKey: '' }, 'complete')).toEqual({});
  });

  it('passes through version headers, preset extra headers, and sealed custom headers', () => {
    expect(
      openaiChatAdapter.headers(
        ctx({ versionHeaders: { 'x-version': '2' }, extraHeaders: { 'user-agent': 'caotang/1' } }),
        { apiKey: 'k', headers: [{ name: 'x-custom', value: 'v1' }] },
        'complete',
      ),
    ).toEqual({ authorization: 'Bearer k', 'x-version': '2', 'user-agent': 'caotang/1', 'x-custom': 'v1' });
  });
});

describe('openai-chat effort mapping', () => {
  it('reasoning_effort: writes the level, max→high, off→none', () => {
    expect(effortFields('reasoning_effort', 'low')).toEqual({ reasoning_effort: 'low' });
    expect(effortFields('reasoning_effort', 'high')).toEqual({ reasoning_effort: 'high' });
    expect(effortFields('reasoning_effort', 'max')).toEqual({ reasoning_effort: 'high' });
    expect(effortFields('reasoning_effort', 'off')).toEqual({ reasoning_effort: 'none' });
  });

  it('reasoning.effort: writes {reasoning: {effort}} with the same level mapping', () => {
    expect(effortFields('reasoning.effort', 'medium')).toEqual({ reasoning: { effort: 'medium' } });
    expect(effortFields('reasoning.effort', 'max')).toEqual({ reasoning: { effort: 'high' } });
    expect(effortFields('reasoning.effort', 'off')).toEqual({ reasoning: { effort: 'none' } });
  });

  it('thinking.type: enabled when the row lists more than two levels, adaptive when it lists two', () => {
    expect(effortFields('thinking.type', 'high')).toEqual({ thinking: { type: 'enabled' } });
    expect(effortFields('thinking.type', 'off')).toEqual({ thinking: { type: 'disabled' } });
    expect(effortFields('thinking.type', 'low', { effortLevels: ['off', 'low'] })).toEqual({ thinking: { type: 'adaptive' } });
  });

  it('thinking.type+effort: writes both fields; off disables without an effort', () => {
    expect(effortFields('thinking.type+effort', 'high')).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'high' });
    expect(effortFields('thinking.type+effort', 'max')).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'high' });
    expect(effortFields('thinking.type+effort', 'off')).toEqual({ thinking: { type: 'disabled' } });
  });

  it('enable_thinking+budget: writes the boolean plus the per-level budget', () => {
    expect(effortFields('enable_thinking+budget', 'low')).toEqual({ enable_thinking: true, thinking_budget: 1024 });
    expect(effortFields('enable_thinking+budget', 'medium')).toEqual({ enable_thinking: true, thinking_budget: 4096 });
    expect(effortFields('enable_thinking+budget', 'high')).toEqual({ enable_thinking: true, thinking_budget: 16384 });
    expect(effortFields('enable_thinking+budget', 'max')).toEqual({ enable_thinking: true, thinking_budget: 32768 });
    expect(effortFields('enable_thinking+budget', 'off')).toEqual({ enable_thinking: false });
  });

  it('reasoning.enabled: writes the boolean switch', () => {
    expect(effortFields('reasoning.enabled', 'low')).toEqual({ reasoning: { enabled: true } });
    expect(effortFields('reasoning.enabled', 'off')).toEqual({ reasoning: { enabled: false } });
  });

  it('max_effort: writes the level verbatim, and omits off entirely', () => {
    expect(effortFields('max_effort', 'max')).toEqual({ max_effort: 'max' });
    expect(effortFields('max_effort', 'low')).toEqual({ max_effort: 'low' });
    expect(effortFields('max_effort', 'off')).toEqual({});
  });

  it('anthropic: maps nothing on the chat route — the Messages adapter owns that pair', () => {
    expect(effortFields('anthropic', 'high')).toEqual({});
  });

  it('sends nothing for a level the capability row does not list', () => {
    expect(effortFields('reasoning_effort', 'high', { effortLevels: ['low', 'medium'] })).toEqual({});
    expect(effortFields('reasoning_effort', 'off', { effortLevels: ['low', 'medium'] })).toEqual({});
  });

  it('sends nothing without a level or without an effortLevels row', () => {
    expect(effortFields('reasoning_effort', undefined)).toEqual({});
    expect(effortFields('reasoning_effort', 'high', { effortLevels: [] })).toEqual({});
    const noLevels = openaiChatAdapter.buildBody(
      bodyInput({ messages: [{ role: 'user', content: 'hi' }], thinking: 'high' }, ctx({}, { effortStyle: 'reasoning_effort' }), {
        temperature: 0.5,
        maxTokens: 1024,
      }),
    );
    for (const k of EFFORT_FIELDS) expect(noLevels).not.toHaveProperty(k);
  });

  it('applyEffort itself is a no-op for undefined style and unknown styles', () => {
    const target: Record<string, unknown> = {};
    applyEffort(target, undefined, 'high', { effortLevels: ['high'] });
    applyEffort(target, 'not-a-style', 'high', { effortLevels: ['high'] });
    expect(target).toEqual({});
  });
});

describe('openai-chat denylist and field-name quirks', () => {
  it('drops temperature, tools, stream_options, and stop per caps.denylist', () => {
    const built = body(
      { messages: [{ role: 'user', content: 'hi' }], stop: ['END'], tools: [{ name: 't', description: 'd', parameters: {} }] },
      { ctx: ctx({}, { denylist: ['temperature', 'tools', 'stream_options', 'stop'] }) },
    );
    expect(built).not.toHaveProperty('temperature');
    expect(built).not.toHaveProperty('tools');
    expect(built).not.toHaveProperty('tool_choice');
    expect(built).not.toHaveProperty('stream_options');
    expect(built).not.toHaveProperty('stop');
  });

  it('falls back to max_completion_tokens when max_tokens is denylisted', () => {
    const built = body(user('x'), { ctx: ctx({}, { denylist: ['max_tokens'] }) });
    expect(built.max_completion_tokens).toBe(4096);
    expect(built).not.toHaveProperty('max_tokens');
  });

  it('honours quirks.maxTokensField over the default and the denylist fallback', () => {
    expect(body(user('x'), { ctx: ctx({ maxTokensField: 'max_completion_tokens' }) }).max_completion_tokens).toBe(4096);
    expect(body(user('x'), { ctx: ctx({ maxTokensField: 'max_output_tokens' }) }).max_output_tokens).toBe(4096);
    const both = body(user('x'), { ctx: ctx({ maxTokensField: 'max_output_tokens' }, { denylist: ['max_tokens'] }) });
    expect(both.max_output_tokens).toBe(4096);
  });
});

describe('openai-chat replay', () => {
  const call = { id: 'call_1', name: 'binder.create', argumentsJson: '{"title":"X"}' };

  it('replays tool_calls wire entries and a null content on a tools-only reply', () => {
    const wire = wireMessages({ messages: [{ role: 'assistant', content: '', toolCalls: [call] }] }, {});
    expect(wire).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'binder.create', arguments: '{"title":"X"}' } }],
      },
    ]);
  });

  it('keeps the content string when a reply carries both text and calls', () => {
    const wire = wireMessages({ messages: [{ role: 'assistant', content: 'checking', toolCalls: [call] }] }, {});
    expect(wire[0]).toMatchObject({ content: 'checking' });
  });

  it('replays a tool message as {role: tool, tool_call_id, content}', () => {
    const wire = wireMessages({ messages: [{ role: 'tool', toolCallId: 'call_1', content: '{"ok":true}' }] }, {});
    expect(wire).toEqual([{ role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' }]);
  });

  it('replays reasoning as reasoning_content under the content-field style', () => {
    const wire = wireMessages(
      { messages: [{ role: 'assistant', content: 'done', toolCalls: [call], reasoning: [{ text: 'hmm ' }, { text: 'yes' }] }] },
      { replayStyle: 'content-field' },
    );
    expect(wire[0]).toMatchObject({ content: 'done', reasoning_content: 'hmm yes' });
  });

  it('replays reasoning as <think> tags inside content under the think-tags style', () => {
    const wire = wireMessages(
      { messages: [{ role: 'assistant', content: 'done', reasoning: [{ text: 'hmm' }] }] },
      { replayStyle: 'think-tags' },
    );
    expect(wire[0]).toMatchObject({ content: '<think>hmm</think>done' });
  });

  it('drops reasoning under the default text style, even alongside tool calls', () => {
    const wire = wireMessages(
      { messages: [{ role: 'assistant', content: '', toolCalls: [call], reasoning: [{ text: 'hmm' }] }] },
      {},
    );
    expect(wire[0]).not.toHaveProperty('reasoning_content');
    expect(wire[0]).toMatchObject({ content: null });
  });
});

describe('openai-chat stream parsing', () => {
  it('reads text deltas through to [DONE]', () => {
    const text =
      frame({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }) +
      frame({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { content: 'Hel' }, finish_reason: null }] }) +
      frame({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { content: 'lo.' }, finish_reason: null }] }) +
      frame({ id: 'chatcmpl-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 2 } }) +
      'data: [DONE]\n\n';
    const { pieces, terminal } = parseStream(text);
    expect(pieces).toEqual([
      { text: 'Hel' },
      { text: 'lo.' },
      { usage: { promptTokens: 11, completionTokens: 2 } },
      { finish: 'stop' },
      { done: true },
    ]);
    expect(terminal).toEqual({});
  });

  it('assembles tool_calls fragments across chunks and indexes, ordered at finish', () => {
    const text =
      frame({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'two' } }] } }] }) +
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'binder.', arguments: '{"a":' } }] } }] }) +
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'create', arguments: '1}' } }, { index: 1, function: { arguments: '{}' } }] } }] }) +
      frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) +
      'data: [DONE]\n\n';
    const { pieces, terminal } = parseStream(text);
    expect(pieces.map((p) => p.finish).find(Boolean)).toBe('tool_calls');
    expect(terminal.toolCalls).toEqual([
      { id: 'call_a', name: 'binder.create', argumentsJson: '{"a":1}' },
      { id: 'call_b', name: 'two', argumentsJson: '{}' },
    ]);
  });

  it('reads reasoning_content deltas, and the plain "reasoning" alias, into one block', () => {
    const text =
      frame({ choices: [{ delta: { reasoning_content: 'hmm ' } }] }) +
      frame({ choices: [{ delta: { reasoning: 'still thinking' } }] }) +
      frame({ choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] }) +
      'data: [DONE]\n\n';
    const { pieces, terminal } = parseStream(text);
    expect(pieces.filter((p) => p.reasoning !== undefined)).toEqual([{ reasoning: 'hmm ' }, { reasoning: 'still thinking' }]);
    expect(terminal.reasoning).toEqual([{ text: 'hmm still thinking' }]);
  });

  it('surfaces a post-200 error object as an error piece', () => {
    const { pieces } = parseStream(frame({ error: { message: 'upstream timed out', code: 504 } }));
    expect(pieces).toEqual([{ error: 'upstream timed out' }]);
  });

  it('accepts a string error field as well', () => {
    const { pieces } = parseStream(frame({ error: 'overloaded' }));
    expect(pieces).toEqual([{ error: 'overloaded' }]);
  });

  it('reports a malformed frame rather than guessing', () => {
    const { pieces } = parseStream('data: {not json\n\n');
    expect(pieces).toEqual([{ malformed: '{not json' }]);
  });

  it('reports a non-object frame (array, scalar) as malformed', () => {
    expect(parseStream('data: [1,2]\n\n').pieces).toEqual([{ malformed: '[1,2]' }]);
    expect(parseStream('data: 4\n\n').pieces).toEqual([{ malformed: '4' }]);
  });

  it('reads input_tokens/output_tokens usage aliases on compatible routes', () => {
    const { pieces } = parseStream(frame({ choices: [], usage: { input_tokens: 7, output_tokens: 3 } }));
    expect(pieces).toEqual([{ usage: { promptTokens: 7, completionTokens: 3 } }]);
  });

  it('maps function_call to stop and unknown reasons to error', () => {
    expect(parseStream(frame({ choices: [{ delta: {}, finish_reason: 'function_call' }] })).pieces).toEqual([{ finish: 'stop' }]);
    expect(parseStream(frame({ choices: [{ delta: {}, finish_reason: 'content_filter' }] })).pieces).toEqual([{ finish: 'error' }]);
  });
});

describe('openai-chat paths and model listing', () => {
  it('joins the completions and models paths to the base', () => {
    expect(openaiChatAdapter.completePath('model-x')).toBe('/chat/completions');
    expect(openaiChatAdapter.modelsPath(CTX)).toBe('/models');
  });

  it('reads the OpenAI models envelope', () => {
    expect(openaiChatAdapter.parseModels({ data: [{ id: 'a', context_length: 8192 }] })).toEqual([{ id: 'a', contextWindow: 8192 }]);
    expect(openaiChatAdapter.parseModels({ unexpected: true })).toBeUndefined();
  });
});

describe('routeFor — per-model adapter routing', () => {
  // The OpenCode table: claude-* and two exact qwen models take the Anthropic route;
  // everything else — qwen3.8-max included — stays on the chat fallback.
  const opencode = {
    'claude-*': 'anthropic-messages',
    'qwen3.8-flash': 'anthropic-messages',
    'qwen3.7-plus': 'anthropic-messages',
  } as const;

  it('matches glob prefixes and exact names, and falls back otherwise', () => {
    expect(routeFor({ modelRoutes: opencode }, 'claude-sonnet-4', 'openai-chat')).toBe('anthropic-messages');
    expect(routeFor({ modelRoutes: opencode }, 'claude-opus-4.1-20250805', 'openai-chat')).toBe('anthropic-messages');
    expect(routeFor({ modelRoutes: opencode }, 'qwen3.8-flash', 'openai-chat')).toBe('anthropic-messages');
    expect(routeFor({ modelRoutes: opencode }, 'qwen3.7-plus', 'openai-chat')).toBe('anthropic-messages');
    expect(routeFor({ modelRoutes: opencode }, 'qwen3.8-max', 'openai-chat')).toBe('openai-chat');
    expect(routeFor({ modelRoutes: opencode }, 'gpt-5.1', 'openai-chat')).toBe('openai-chat');
  });

  it('does not let a glob match shorter strings or an exact rule match longer ones', () => {
    expect(routeFor({ modelRoutes: opencode }, 'claude', 'openai-chat')).toBe('openai-chat');
    expect(routeFor({ modelRoutes: opencode }, 'qwen3.8-flash-2', 'openai-chat')).toBe('openai-chat');
  });

  it('returns the fallback untouched when there is no route map', () => {
    expect(routeFor({}, 'claude-sonnet-4', 'openai-chat')).toBe('openai-chat');
    expect(routeFor({ modelRoutes: {} }, 'claude-sonnet-4', 'openai-responses')).toBe('openai-responses');
  });
});
