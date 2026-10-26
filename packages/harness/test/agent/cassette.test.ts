/**
 * Cassettes (cassette.ts): the request key and what it leaves out, the strict loader, the scrub on write and the verify on load,
 * and the replay that answers by key and fails with a diff. The golden tasks run the same code over real turns.
 */

import { describe, expect, it } from 'vitest';

import type { ChatRequest } from '@caotang/gateway';
import type { MockResponse, MockScript } from '@caotang/gateway/mock';

import {
  CASSETTE_FORMAT,
  CASSETTE_MAX_BYTES,
  CassetteError,
  parseCassette,
  recordScripts,
  replayScript,
  requestDiff,
  requestKey,
  scriptedGateway,
  serializeCassette,
  canonicalRequest,
  type Cassette,
  type CassetteExchange,
} from '../../src/agent/cassette.js';

const request = (...messages: ChatRequest['messages']): ChatRequest => ({ messages });
const SYSTEM = { role: 'system' as const, content: 'You are drafting prose for Caotang. Write the prose.' };
const USER = { role: 'user' as const, content: 'Brief: the lamp fails.' };

function exchangeOf(req: ChatRequest, content: string, extra: Partial<MockResponse> = {}): CassetteExchange {
  const recorded = recordScripts([{ match: () => true, respond: () => ({ content, ...extra }) }]);
  recorded.scripts[0]?.respond(req, 1);
  return recorded.exchanges[0] as CassetteExchange;
}

const header = { kind: 'header', format: CASSETTE_FORMAT, task: 't', preset: 'mock', model: 'synthetic', synthetic: true, recordedAt: '2026-10-26', promptManifest: 'a'.repeat(64) } as const;
const cassetteOf = (...exchanges: CassetteExchange[]): Cassette => ({ header, exchanges });

describe('requestKey', () => {
  it('ignores the model, the temperature, the turn id, the role and the other knobs', () => {
    const base = request(SYSTEM, USER);
    const same = { ...base, model: 'other-model', temperature: 0.9, turnId: 'turn-7', role: 'drafting' as const, maxOutputTokens: 100, agentPath: 'turn-7/reader#1', thinking: 'high' as const };
    expect(requestKey(same)).toBe(requestKey(base));
  });

  it('changes with a message, the tools and the response format', () => {
    const base = request(SYSTEM, USER);
    const key = requestKey(base);
    expect(requestKey(request(SYSTEM, { ...USER, content: 'Brief: the lamp holds.' }))).not.toBe(key);
    expect(requestKey({ ...base, tools: [{ name: 'a', description: 'd', parameters: {} }] })).not.toBe(key);
    expect(requestKey({ ...base, responseFormat: 'text' })).not.toBe(key);
    expect(requestKey({ ...base, responseFormat: 'text' })).not.toBe(requestKey({ ...base, responseFormat: { jsonSchemaHint: { type: 'object' } } }));
  });

  it('numbers native tool-call ids by position, so two providers’ ids give one key', () => {
    const asked = (id: string): ChatRequest =>
      request(SYSTEM, { role: 'assistant', content: '', toolCalls: [{ id, name: 'doc.read', argumentsJson: '{}' }] }, { role: 'tool', content: '{"ok":true}', toolCallId: id });
    expect(requestKey(asked('toolu_01ABC'))).toBe(requestKey(asked('call_mock_1')));
    expect(canonicalRequest(asked('toolu_01ABC')).messages[2]?.toolCallId).toBe('call_1');
  });
});

describe('parseCassette and serializeCassette', () => {
  const good = cassetteOf(exchangeOf(request(SYSTEM, USER), 'The lamp went out.'));

  it('round-trips a cassette, one JSON record per line', () => {
    const text = serializeCassette(good);
    expect(text.trimEnd().split('\n')).toHaveLength(2);
    expect(parseCassette(text)).toEqual(good);
  });

  it('keeps a scripted failure and a native reply with its calls', () => {
    const failed = exchangeOf(request(SYSTEM, USER), '', { error: { kind: 'rate_limit', status: 429 } });
    const called = exchangeOf(request(SYSTEM), '', { toolCalls: [{ id: 'x1', name: 'doc.read', argumentsJson: '{}' }], finishReason: 'tool_calls' });
    const back = parseCassette(serializeCassette(cassetteOf(failed, called)));
    expect(back.exchanges[0]?.response.error).toEqual({ kind: 'rate_limit', status: 429 });
    expect(back.exchanges[1]?.response.toolCalls).toEqual([{ id: 'call_1', name: 'doc.read', argumentsJson: '{}' }]);
  });

  const lines = (cassette: Cassette): string[] => serializeCassette(cassette).trimEnd().split('\n');
  const refused = (text: string, message: string): void => {
    expect(() => parseCassette(text)).toThrow(CassetteError);
    expect(() => parseCassette(text)).toThrow(message);
  };

  it('refuses a file over the size cap, a line that is not JSON and a file without a header', () => {
    refused(' '.repeat(CASSETTE_MAX_BYTES + 1), 'over');
    refused(`${lines(good)[0]}\nnot json`, 'line 2: not JSON');
    refused(lines(good)[1] as string, 'before the header');
    refused('', 'no header');
  });

  it('refuses an unknown record kind, a second header and a header that is not first', () => {
    refused(`${lines(good)[0]}\n{"kind":"script","code":"process.exit()"}`, 'unknown record kind "script"');
    refused(`${lines(good)[0]}\n${lines(good)[0]}`, 'only one');
    refused(`${lines(good)[0]}\n${lines(good)[1]}\n${lines(good)[0]}`, 'only one');
  });

  it('refuses a field outside the schema, on every record', () => {
    const [head, ex] = lines(good) as [string, string];
    refused(`${head.replace('}', ',"run":"x"}')}\n${ex}`, 'unknown field "run"');
    refused(`${head}\n${ex.replace('"kind":"exchange"', '"kind":"exchange","extra":1')}`, 'unknown field "extra"');
    refused(`${head}\n${ex.replace('"response":{', '"response":{"hook":"x",')}`, 'unknown field "hook"');
  });

  it('refuses a synthetic model without the flag, and a key that is not the request’s key', () => {
    const [head, ex] = lines(good) as [string, string];
    refused(`${head.replace('"synthetic":true,', '')}\n${ex}`, 'must say synthetic: true');
    refused(`${head}\n${ex.replace('Brief: the lamp fails.', 'Brief: the lamp holds.')}`, 'not the key of the request beside it');
    refused(`${head}\n${ex.replace(/"key":"[0-9a-f]{64}"/, '"key":"short"')}`, '64 lowercase hex');
  });

  it('refuses a cassette that holds the shape of a credential', () => {
    const [head, ex] = lines(good) as [string, string];
    refused(`${head}\n${ex.replace('The lamp went out.', 'sk-ant-api03-abcdefghijklmnop')}`, 'credential');
    refused(`${head}\n${ex.replace('The lamp went out.', 'Authorization: Bearer abcdefghijklmnopqrstuv')}`, 'credential');
  });

  it('scrubs a key seeded into an error body on write, and a load refuses the file that still holds one', () => {
    const KEY = 'live-key-1234567890abcdef';
    const failing = exchangeOf(request(SYSTEM, USER), '', {
      error: { kind: 'auth', status: 401, detail: `invalid api key ${KEY}`, message: `The provider rejected the key ${KEY} (sk-proj-AAAABBBBCCCCDDDD)` },
    });
    const text = serializeCassette(cassetteOf(failing), [KEY]);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('sk-proj-AAAABBBBCCCCDDDD');
    expect(text).toContain('[redacted]');
    expect(() => parseCassette(text)).not.toThrow();
    // A key the writer did not know to scrub still has the shape of one, and the load refuses it.
    const unscrubbed = JSON.stringify({ ...failing, response: { content: 'x', error: { kind: 'auth', detail: 'bad sk-proj-AAAABBBBCCCCDDDD' } } });
    expect(() => parseCassette(`${JSON.stringify(header)}\n${unscrubbed}`)).toThrow('credential');
  });

  it('refuses to write a request that carries a credential, whose key the scrub would change', () => {
    const leaking = exchangeOf(request(SYSTEM, { role: 'user', content: 'use key sk-live-AAAABBBBCCCC please' }), 'ok');
    expect(() => serializeCassette(cassetteOf(leaking))).toThrow(CassetteError);
  });
});

describe('replayScript', () => {
  const first = exchangeOf(request(SYSTEM, USER), 'The lamp went out.');
  const second = exchangeOf(request(SYSTEM, { ...USER, content: 'Brief: the keeper rows.' }), 'He rowed.');

  async function ask(script: MockScript, req: ChatRequest): Promise<string> {
    const gateway = await scriptedGateway([script]);
    return (await gateway.completeOnce(req)).content;
  }

  it('answers a request with the response recorded under its key, whatever the model or temperature', async () => {
    const replay = replayScript(cassetteOf(first, second), { rerecord: 'RECORD' });
    expect(await ask(replay.script, { ...request(SYSTEM, { ...USER, content: 'Brief: the keeper rows.' }), model: 'x', temperature: 1 })).toBe('He rowed.');
    expect(await ask(replay.script, request(SYSTEM, USER))).toBe('The lamp went out.');
    expect(replay.misses).toEqual([]);
    expect(replay.unused()).toEqual([]);
  });

  it('answers a repeated request with its recordings in order', async () => {
    const again = exchangeOf(request(SYSTEM, USER), 'The lamp went out, twice.');
    const replay = replayScript(cassetteOf(first, again), { rerecord: 'RECORD' });
    expect(await ask(replay.script, request(SYSTEM, USER))).toBe('The lamp went out.');
    expect(await ask(replay.script, request(SYSTEM, USER))).toBe('The lamp went out, twice.');
  });

  it('reports the exchanges the run never asked for', async () => {
    const replay = replayScript(cassetteOf(first, second), { rerecord: 'RECORD' });
    await ask(replay.script, request(SYSTEM, USER));
    expect(replay.unused().map((exchange) => exchange.key)).toEqual([second.key]);
  });

  it('fails a request that matches none, naming the message, the character and the command that records again', async () => {
    const replay = replayScript(cassetteOf(first), { rerecord: 'pnpm record --task t', name: 'task t' });
    const changed = request({ ...SYSTEM, content: SYSTEM.content.replace('Write', 'Compose') }, USER);
    await expect(ask(replay.script, changed)).rejects.toThrow('message 1 (system) changed at character 36');
    expect(replay.misses).toHaveLength(1);
    expect(replay.misses[0]).toContain('task t: request 1 differs from the recorded one');
    expect(replay.misses[0]).toContain('recorded "');
    expect(replay.misses[0]).toContain('Write the prose');
    expect(replay.misses[0]).toContain('Compose the prose');
    expect(replay.misses[0]).toContain('pnpm record --task t');
  });

  it('fails a request beyond the recording, and says how many were recorded', async () => {
    const replay = replayScript(cassetteOf(first), { rerecord: 'RECORD' });
    await ask(replay.script, request(SYSTEM, USER));
    await expect(ask(replay.script, request(SYSTEM, { ...USER, content: 'more' }))).rejects.toThrow('holds only 1');
  });
});

describe('requestDiff', () => {
  const base = canonicalRequest(request(SYSTEM, USER));

  it('names a message that was added, removed or changed in role', () => {
    expect(requestDiff(base, canonicalRequest(request(SYSTEM, USER, { role: 'assistant', content: 'x' })))).toContain('message 3 (assistant) is new');
    expect(requestDiff(base, canonicalRequest(request(SYSTEM)))).toContain('message 2 (user) is gone');
    expect(requestDiff(base, canonicalRequest(request(SYSTEM, { role: 'assistant', content: USER.content })))).toContain('was a user message and is now a assistant message');
  });

  it('names a tool that was added, a tool whose text changed, and a changed response format', () => {
    const tool = { name: 'doc.read', description: 'Reads.', parameters: {} };
    const withTool = canonicalRequest({ ...request(SYSTEM, USER), tools: [tool] });
    expect(requestDiff(base, withTool)).toContain('the declared tools changed: doc.read');
    expect(requestDiff(withTool, canonicalRequest({ ...request(SYSTEM, USER), tools: [{ ...tool, description: 'Reads more.' }] }))).toContain('description or parameters changed');
    expect(requestDiff(base, canonicalRequest({ ...request(SYSTEM, USER), responseFormat: 'text' }))).toBe('the response format changed');
  });
});

describe('recordScripts', () => {
  it('keeps each answer under the key of the request that asked, and refuses a streamed script', () => {
    const recorded = recordScripts([{ match: () => true, respond: () => ({ content: 'ok' }) }]);
    recorded.scripts[0]?.respond(request(SYSTEM, USER), 1);
    expect(recorded.exchanges).toHaveLength(1);
    expect(recorded.exchanges[0]?.key).toBe(requestKey(request(SYSTEM, USER)));
    const streamed = recordScripts([{ match: () => true, respond: async function* () { yield { delta: 'x' }; } }]);
    expect(() => streamed.scripts[0]?.respond(request(SYSTEM, USER), 1)).toThrow('streams');
  });
});
