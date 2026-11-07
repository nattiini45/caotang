/**
 * Wire-safe tool names (issue #486): every native-tools route refuses a dotted function name, so the gateway renames
 * tool names on the way out and back on the way in. These tests pin the codec and the three routes end to end.
 */

import { describe, expect, it } from 'vitest';

import {
  WIRE_TOOL_NAME,
  decodingParser,
  encodeToolNames,
  toolNameCodec,
  toolNamesOf,
  wireToolName,
  type ChatRequest,
  type NewProfile,
  type StreamParser,
} from '../src/index.js';
import { addEndpoint, collect, harness, ScriptedFetch } from './helpers.js';

const DOTTED = ['doc.write', 'doc.read', 'codex.upsert', 'binder.create', 'tool.search'];

const frame = (payload: unknown, event?: string): string =>
  `${event === undefined ? '' : `event: ${event}\n`}data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
const sse = (text: string): Response => new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });

/** A request with dotted tools declared and a dotted call replayed in its history. */
const request = (): ChatRequest => ({
  messages: [
    { role: 'user', content: 'Write the scene.' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call_0', name: 'doc.read', argumentsJson: '{"id":"d1"}' }] },
    { role: 'tool', toolCallId: 'call_0', content: '{"text":"…"}' },
  ],
  tools: [
    { name: 'doc.write', description: 'Writes a doc.', parameters: { type: 'object', properties: {} } },
    { name: 'doc.read', description: 'Reads a doc.', parameters: { type: 'object', properties: {} } },
    { name: 'mcp__notes__search', description: 'An external tool.', parameters: { type: 'object', properties: {} } },
  ],
});

/** Every `name` field anywhere in a body. */
function namesIn(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) namesIn(item, out);
  else if (value !== null && typeof value === 'object') {
    for (const [key, field] of Object.entries(value)) {
      if (key === 'name' && typeof field === 'string') out.push(field);
      else namesIn(field, out);
    }
  }
  return out;
}

describe('the tool name codec', () => {
  it('leaves an already-safe name alone and turns dots into double underscores', () => {
    expect(wireToolName('mcp__notes__search')).toBe('mcp__notes__search');
    expect(wireToolName('doc.write')).toBe('doc__write');
    expect(wireToolName('a b/c')).toBe('a_b_c');
  });

  it('keeps every wire name within the strictest route rule, long names included', () => {
    const long = `${'very.long.namespace.'.repeat(6)}tool`;
    for (const name of [...DOTTED, long, 'é', '']) expect(wireToolName(name)).toMatch(WIRE_TOOL_NAME);
    expect(wireToolName(long)).toHaveLength(64);
  });

  it('round-trips every name and breaks collisions so the map stays one-to-one', () => {
    const names = ['doc.write', 'doc__write', 'doc_write', 'doc write', 'doc/write', ...DOTTED];
    const codec = toolNameCodec(names);
    const wires = names.map((name) => codec.toWire(name));
    for (const wire of wires) expect(wire).toMatch(WIRE_TOOL_NAME);
    expect(new Set(wires).size).toBe(new Set(names).size);
    for (const name of names) expect(codec.fromWire(codec.toWire(name))).toBe(name);
    // The already-safe name keeps its own form; the dotted one that would collide with it is suffixed.
    expect(codec.toWire('doc__write')).toBe('doc__write');
    expect(codec.toWire('doc.write')).toBe('doc__write_2');
  });

  it('passes a wire name it never issued through unchanged', () => {
    expect(toolNameCodec(DOTTED).fromWire('invented_tool')).toBe('invented_tool');
  });

  it('renames declarations and replayed calls, and leaves safe names as they are', () => {
    const req = request();
    const codec = toolNameCodec(toolNamesOf(req));
    const wire = encodeToolNames(req, codec);
    expect(wire.tools?.map((t) => t.name)).toEqual(['doc__write', 'doc__read', 'mcp__notes__search']);
    expect(wire.messages[1]?.toolCalls?.[0]?.name).toBe('doc__read');
    expect(req.tools?.[0]?.name).toBe('doc.write');
    const safe: ChatRequest = { messages: [], tools: [{ name: 'ok_tool', description: '', parameters: {} }] };
    expect(encodeToolNames(safe, toolNameCodec(toolNamesOf(safe)))).toEqual(safe);
  });

  it('restores registry names on the calls a parser assembles', () => {
    const inner: StreamParser = { push: () => [], finish: () => ({ toolCalls: [{ id: 't', name: 'doc__write', argumentsJson: '{}' }] }) };
    expect(decodingParser(inner, toolNameCodec(DOTTED)).finish().toolCalls).toEqual([{ id: 't', name: 'doc.write', argumentsJson: '{}' }]);
  });
});

const ROUTES: { route: string; profile: Partial<NewProfile>; reply: string }[] = [
  {
    route: 'anthropic-messages',
    profile: { preset: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', defaultModel: 'claude-sonnet-5-5' },
    reply:
      frame({ type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 10, output_tokens: 1 } } }, 'message_start') +
      frame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'doc__write' } }, 'content_block_start') +
      frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":1}' } }, 'content_block_delta') +
      frame({ type: 'content_block_stop', index: 0 }, 'content_block_stop') +
      frame({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }, 'message_delta') +
      frame({ type: 'message_stop' }, 'message_stop'),
  },
  {
    route: 'openai-chat',
    profile: {},
    reply:
      frame({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'toolu_1', type: 'function', function: { name: 'doc__write', arguments: '{"a":1}' } }] }, finish_reason: null }] }) +
      frame({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) +
      frame('[DONE]'),
  },
  {
    route: 'openai-responses',
    profile: { preset: 'openai', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-6-sol' },
    reply:
      frame({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'toolu_1', name: 'doc__write', arguments: '{"a":1}' } }, 'response.output_item.done') +
      frame({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 5 } } }, 'response.completed'),
  },
];

describe.each(ROUTES)('tool names on the $route route', ({ profile, reply }) => {
  it('sends no dotted name and hands back the registry name of the call', async () => {
    const net = new ScriptedFetch().push(() => sse(reply));
    const h = harness({ net });
    await addEndpoint(h, profile);
    const { chunks, error } = await collect(h.gateway.complete(request()));
    expect(error).toBeUndefined();

    const names = namesIn(net.bodyOf(0));
    expect(names).toEqual(expect.arrayContaining(['doc__write', 'doc__read', 'mcp__notes__search']));
    for (const name of names) expect(name).toMatch(WIRE_TOOL_NAME);

    const terminal = chunks.find((c) => c.finishReason !== undefined);
    expect(terminal?.toolCalls).toEqual([{ id: 'toolu_1', name: 'doc.write', argumentsJson: '{"a":1}' }]);
  });
});
