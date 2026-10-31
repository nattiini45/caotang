/**
 * The agent trace (agent-harness §5.2): the store's rules (one copy of a message, whole turns dropped oldest first, a
 * secret never kept, nothing left in an export that leaves the text out), the reader, and the records a real turn writes.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { createGateway, createKeyStore, createManualClock, createMemoryVaultPort, createProfileStore, type ChatMessage } from '@caotang/gateway';
import { createMockProvider } from '@caotang/gateway/mock';

import {
  REQUIRED_FIELDS,
  TRACE_MAX_BYTES,
  TRACE_MAX_TURNS,
  TRACE_RECORD_CAP,
  TRACE_REVIEWS,
  createAgentSession,
  createAgentPorts,
  createHarness,
  createTraceStore,
  omitRecord,
  parseTrace,
  traceGateway,
  type TraceInput,
  type TraceKind,
  type TraceRecord,
  type TraceStore,
  type TurnReport,
} from '../../src/index.js';
import { makeState } from '../fixtures.js';
import { prose, steps, transcript } from './scripts.js';

const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

const KEY ='sk-test-CAOTANG-SECRET-0123456789abcdef';

const system: ChatMessage = { role: 'system', content: 'You are the agent.' };

const user = (content: string): ChatMessage => ({ role: 'user', content });

const store = (options: Partial<Parameters<typeof createTraceStore>[0]> = {}): TraceStore => createTraceStore({ sessionId: 'test', ...options });

const request = (turnId: string | undefined, callId: number, messages: readonly ChatMessage[], at = callId): TraceInput => ({
  kind: 'model.request',
  at,
  callId,
  ...(turnId === undefined ? {} : { turnId, callIndex: callId }),
  profileId: 'prv_1',
  'gen_ai.request.model': 'model-x',
  messages,
});

const response = (turnId: string | undefined, callId: number, content: string, at = callId + 1): TraceInput => ({
  kind: 'model.response',
  at,
  callId,
  ...(turnId === undefined ? {} : { turnId, callIndex: callId }),
  finishedAt: at,
  attempts: 1,
  tries: [{ attempt: 0, outcome: 'ok', status: 200, at }],
  'gen_ai.response.finish_reasons': ['stop'],
  content,
  'gen_ai.usage.input_tokens': 10,
  'gen_ai.usage.output_tokens': 4,
  usageSource: 'provider',
});

const start = (turnId: string, intent = 'Write something.'): TraceInput => ({ kind: 'turn.start', at: 0, turnId, intent });

/** The parts of a report an export reads, around the ones a test sets. */
const bareReport = (over: Record<string, unknown> = {}): TurnReport =>
  ({ turnId: 't.turn-1', status: 'replied', summary: '', steps: [], cards: [], trace: [], tokens: { promptTokens: 0, completionTokens: 0, requests: 0 }, dropped: [], modelCalls: 0, mode: 'ask', budgetUse: {}, ...over }) as unknown as TurnReport;

const kinds = (records: readonly TraceRecord[]): TraceKind[] => records.map((record) => record.kind);

function parsed(jsonl: string): readonly TraceRecord[] {
  const result = parseTrace(jsonl);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

describe('the record format', () => {
  it('round-trips every kind of record through toJsonl and parseTrace', () => {
    const s = store({ project: () => 'The Lighthouse Keeper' });
    s.write(start('t.turn-1'));
    s.write({ kind: 'context', at: 1, turnId: 't.turn-1', callIndex: 1, layers: [{ id: 'L0', tokens: 40 }], dropped: ['Codex: left out'] });
    s.write(request('t.turn-1', 1, [system, user('hello')]));
    s.write(response('t.turn-1', 1, 'hi'));
    s.write({ kind: 'tool.call', at: 3, turnId: 't.turn-1', callId: 'c1', tool: 'doc.read', risk: 'read', params: { doc: 'Landing' } });
    s.write({ kind: 'tool.progress', at: 3.5, turnId: 't.turn-1', callId: 'c1', progress: 1, total: 4, message: 'Reading the shelf' });
    s.write({ kind: 'tool.result', at: 4, turnId: 't.turn-1', callId: 'c1', outcome: 'ok', startedAt: 3, finishedAt: 4, body: { text: 'The ferry' } });
    s.write({ kind: 'card', at: 5, turnId: 't.turn-1', card: { kind: 'plan', tools: ['scene.draft'], decision: 'approved', edits: 0, retries: 0 } });
    s.write({ kind: 'ladder', at: 6, turnId: 't.turn-1', callId: 'c2', attempt: 1, reason: 'the title matched two documents' });
    s.write({ kind: 'hook', at: 6, turnId: 't.turn-1', hookId: 'h_7K2QX9M4A1', name: 'No suddenly', event: 'tool.before', tool: 'scene.draft', callId: 'c2', action: 'block', text: '“suddenly” appears: show the change.', ms: 0 });
    s.write({ kind: 'turn.end', at: 7, turnId: 't.turn-1', report: bareReport() });

    const records = parsed(s.toJsonl());

    expect(new Set(kinds(records))).toEqual(new Set(Object.keys(REQUIRED_FIELDS)));
    expect(records[0]).toMatchObject({ kind: 'header', format: 'caotang.trace/1', app: 'caotang', project: { name: 'The Lighthouse Keeper' } });
    const seqs = records.map((record) => record.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('names its fields as the schema file lists them as required', () => {
    const schema = JSON.parse(readFileSync(new URL('../../src/agent/trace.schema.json', import.meta.url), 'utf8')) as {
      $defs: Record<string, { required?: string[] }>;
      properties: { kind: { enum: string[] } };
    };
    expect([...schema.properties.kind.enum].sort()).toEqual(Object.keys(REQUIRED_FIELDS).sort());
    for (const [kind, fields] of Object.entries(REQUIRED_FIELDS)) {
      expect([...(schema.$defs[kind]?.required ?? [])].sort(), kind).toEqual(Object.keys(fields).sort());
    }
  });
});

describe('parseTrace', () => {
  const header = { v: 1, seq: 0, at: 0, sessionId: 's', kind: 'header', format: 'caotang.trace/1', app: 'caotang', project: { name: '' } };
  const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

  it('skips a kind it does not know, so a newer minor version still opens', () => {
    const jsonl = line(header) + line({ v: 1, seq: 1, at: 0, sessionId: 's', kind: 'gpu.sample', usage: 0.4 }) + line({ v: 1, seq: 2, at: 0, sessionId: 's', kind: 'turn.start', turnId: 't', intent: 'x' });
    expect(kinds(parsed(jsonl))).toEqual(['header', 'turn.start']);
  });

  it('refuses a version it does not read, and says which', () => {
    const result = parseTrace(line({ ...header, v: 2, format: 'caotang.trace/2' }));
    expect(result).toEqual({ ok: false, error: expect.stringContaining('caotang.trace/2') });
  });

  it('refuses a body line of another record version, and a second header', () => {
    const body = { v: 2, seq: 1, at: 0, sessionId: 's', kind: 'turn.start', turnId: 't', intent: 'x' };
    expect(parseTrace(line(header) + line(body))).toEqual({ ok: false, error: expect.stringContaining('line 2') });
    expect(parseTrace(line(header) + line({ ...header, seq: 1 }))).toEqual({ ok: false, error: 'line 2 is a second trace header' });
  });

  it('refuses a file that does not start with a header, a line that is not JSON, and a record that lacks a field', () => {
    expect(parseTrace(line({ v: 1, seq: 1, at: 0, sessionId: 's', kind: 'turn.start', turnId: 't', intent: 'x' })).ok).toBe(false);
    expect(parseTrace(`${line(header)}not json\n`)).toEqual({ ok: false, error: 'line 2 is not JSON' });
    const lacking = parseTrace(line(header) + line({ v: 1, seq: 1, at: 0, sessionId: 's', kind: 'turn.start', turnId: 't' }));
    expect(lacking).toEqual({ ok: false, error: expect.stringContaining('intent') });
    expect(parseTrace('')).toEqual({ ok: false, error: 'the trace is empty' });
  });
});

describe('a message is kept once', () => {
  it('stores an identical system prompt once across a 4-call turn, and lists its id in each request', () => {
    const s = store();
    s.write(start('t.turn-1'));
    for (let call = 1; call <= 4; call += 1) {
      s.write(request('t.turn-1', call, [system, user('hello'), ...Array.from({ length: call - 1 }, (_, i) => user(`note ${i}`))]));
      s.write(response('t.turn-1', call, 'ok'));
    }

    const records = parsed(s.toJsonl());
    const messages = records.filter((record) => record.kind === 'message');
    const asked = records.filter((record) => record.kind === 'model.request');

    expect(messages.filter((record) => record.kind === 'message' && record.message.content === system.content)).toHaveLength(1);
    expect(messages).toHaveLength(2 + 3);
    const systemId = messages.find((record) => record.kind === 'message' && record.message.content === system.content);
    for (const record of asked) expect(record.kind === 'model.request' && record.messages[0]).toBe(systemId?.kind === 'message' && systemId.id);
  });

  it('writes a message ahead of the request that lists it, so the file reads in order', () => {
    const s = store();
    s.write(start('t.turn-1'));
    s.write(request('t.turn-1', 1, [system]));
    const lines = parsed(s.toJsonl());
    expect(kinds(lines)).toEqual(['header', 'turn.start', 'message', 'model.request']);
  });

  it('makes a one-turn export complete when the message was first seen in an earlier turn', () => {
    const s = store();
    s.write(start('t.turn-1'));
    s.write(request('t.turn-1', 1, [system]));
    s.write(start('t.turn-2'));
    s.write(request('t.turn-2', 2, [system, user('again')]));
    const second = parsed(s.toJsonl({ turnId: 't.turn-2' }));
    expect(second.filter((record) => record.kind === 'message')).toHaveLength(2);
    expect(second.every((record) => record.kind === 'header' || record.kind === 'message' || (record as { turnId?: string }).turnId === 't.turn-2')).toBe(true);
  });

  it('records a reasoning block as its byte length and never its payload', () => {
    const s = store();
    const raw = { type: 'thinking', signature: 'SIGNED-PAYLOAD-xyz', thinking: 'plan' };
    s.write(request('t.turn-1', 1, [{ role: 'assistant', content: '', reasoning: [{ text: 'a summary', raw }] }]));
    const text = s.toJsonl();
    expect(text).not.toContain('SIGNED-PAYLOAD');
    expect(text).toContain('"bytes":');
    expect(text).toContain('a summary');
  });
});

describe('the caps', () => {
  it('drops whole turns, oldest first, at the turn cap', () => {
    const s = store({ maxTurns: 3 });
    for (let n = 1; n <= 5; n += 1) {
      s.write(start(`t.turn-${n}`, `intent ${n}`));
      s.write(request(`t.turn-${n}`, n, [system, user(`turn ${n}`)]));
    }
    expect(s.turns().map((turn) => turn.turnId)).toEqual(['t.turn-3', 't.turn-4', 't.turn-5']);
    expect(s.records('t.turn-1')).toEqual([]);
    const text = s.toJsonl();
    expect(text).not.toContain('turn 1');
    expect(text).toContain('turn 5');
  });

  it('drops whole turns at the byte cap, and never the turn being written', () => {
    const s = store({ maxBytes: 4_000, recordCap: 1_500 });
    for (let n = 1; n <= 6; n += 1) {
      s.write(start(`t.turn-${n}`));
      s.write(request(`t.turn-${n}`, n, [user(`${'x'.repeat(1_000)} turn ${n}`)]));
    }
    const held = s.turns().map((turn) => turn.turnId);
    expect(held.at(-1)).toBe('t.turn-6');
    expect(held.length).toBeLessThan(6);
    expect(s.bytes).toBeLessThanOrEqual(4_000 + 1_500);
    // a turn that alone is over the cap stays, so the latest turn can always be read
    const tiny = store({ maxBytes: 100, recordCap: 100_000 });
    tiny.write(start('t.turn-1'));
    tiny.write(request('t.turn-1', 1, [user('y'.repeat(5_000))]));
    expect(tiny.turns().map((turn) => turn.turnId)).toEqual(['t.turn-1']);
  });

  it('lets go of a message when the last turn that listed it is dropped', () => {
    const s = store({ maxTurns: 1 });
    s.write(start('t.turn-1'));
    s.write(request('t.turn-1', 1, [user('only in the first')]));
    s.write(start('t.turn-2'));
    s.write(request('t.turn-2', 2, [user('only in the second')]));
    expect(s.message('m1')).toBeUndefined();
    expect(s.message('m2')).toMatchObject({ content: 'only in the second' });
  });

  it('keeps the calls made outside a turn in one group that counts as a turn and is dropped like one', () => {
    const s = store({ maxTurns: 2 });
    s.write(request(undefined, 1, [user('review the manuscript')]));
    s.write(response(undefined, 1, 'findings'));
    expect(s.turns().map((turn) => turn.turnId)).toEqual([TRACE_REVIEWS]);
    expect(s.records(TRACE_REVIEWS).every((record) => (record as { turnId?: string }).turnId === undefined)).toBe(true);

    s.write(start('t.turn-1'));
    s.write(start('t.turn-2'));
    expect(s.turns().map((turn) => turn.turnId)).toEqual(['t.turn-1', 't.turn-2']);
  });

  it('keeps the documented caps when nothing overrides them', () => {
    expect(TRACE_MAX_TURNS).toBe(25);
    expect(TRACE_MAX_BYTES).toBe(16 * 1024 * 1024);
    expect(TRACE_RECORD_CAP).toBe(64 * 1024);
    const s = store();
    for (let n = 1; n <= 26; n += 1) s.write(start(`t.turn-${n}`));
    expect(s.turns()).toHaveLength(25);
    expect(s.records('t.turn-1')).toEqual([]);
    expect(s.records('t.turn-2')).toHaveLength(1);
  });

  it.each([
    ['ASCII', 'z'],
    ['CJK', '漢'],
    ['emoji', '😀'],
  ])('cuts a record to the per-record cap in bytes, keeps most of the budget, and says by how much (%s)', (_name, unit) => {
    const s = store({ recordCap: 2_000 });
    const text = unit.repeat(50_000);
    s.write({ kind: 'tool.result', at: 1, turnId: 't.turn-1', callId: 'c1', outcome: 'ok', finishedAt: 1, body: { text } });
    const [record] = s.records('t.turn-1');
    expect(bytesOf(JSON.stringify(record))).toBeLessThanOrEqual(2_000);
    const kept = (record as unknown as { body: { text: string } }).body.text;
    expect(bytesOf(JSON.stringify(kept))).toBeGreaterThan(1_600);
    expect(kept.length + (record as { truncated: { chars: number } }).truncated.chars).toBe(text.length);
    expect(kept).toBe(unit.repeat(kept.length / unit.length));
  });

  it('never leaves half a surrogate pair where it cuts', () => {
    for (let pad = 0; pad < 4; pad += 1) {
      const s = store({ recordCap: 1_000 });
      s.write({ kind: 'tool.result', at: 1, turnId: 't.turn-1', callId: 'c1', outcome: 'ok', finishedAt: 1, body: { text: `${'a'.repeat(pad)}${'😀'.repeat(5_000)}` } });
      const [record] = s.records('t.turn-1');
      const kept = (record as unknown as { body: { text: string } }).body.text;
      expect(kept).toBe(`${'a'.repeat(pad)}${'😀'.repeat((kept.length - pad) / 2)}`);
      expect(bytesOf(JSON.stringify(record))).toBeLessThanOrEqual(1_000);
    }
  });

  it('cuts a stored message to the cap in bytes too', () => {
    const s = store({ recordCap: 2_000 });
    s.write(start('t.turn-1'));
    s.write(request('t.turn-1', 1, [user('漢'.repeat(50_000))]));
    const lines = s.toJsonl().split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as { kind: string; message?: { content: string } });
    const record = lines.find((line) => line.kind === 'message');
    expect(bytesOf(JSON.stringify(record))).toBeLessThanOrEqual(2_000);
    expect(record?.message?.content.length).toBeGreaterThan(400);
  });

  it('counts what was cut from the content apart from what was cut from the tool-call arguments', () => {
    const s = store({ recordCap: 2_000 });
    s.write(start('t.turn-1'));
    s.write(request('t.turn-1', 1, [{ role: 'assistant', content: 'hello', toolCalls: [{ id: 't1', name: 'doc.write', argumentsJson: 'x'.repeat(50_000) }] }, user('y'.repeat(50_000))]));
    expect(s.messageCut('m1')).toBeGreaterThan(0);
    expect(s.messageContentCut('m1')).toBe(0);
    expect(s.messageContentCut('m2')).toBe(s.messageCut('m2'));
    expect(s.messageContentCut('m2')).toBeGreaterThan(0);
    expect(s.messageContentCut('m9')).toBe(0);
  });

  it('empties on clear, and tells its listeners', () => {
    const s = store();
    let told = 0;
    const off = s.subscribe(() => (told += 1));
    s.write(start('t.turn-1'));
    s.clear();
    off();
    s.write(start('t.turn-2'));
    expect(told).toBe(2);
    expect(s.turns().map((turn) => turn.turnId)).toEqual(['t.turn-2']);
    s.clear();
    expect(s.bytes).toBe(0);
  });
});

describe('a secret in what is recorded', () => {
  it('never reaches the file, from a provider error body, a tool result, a message or a reply', () => {
    const s = store();
    s.write(start('t.turn-1', `my key is ${KEY}`));
    s.write(request('t.turn-1', 1, [user(`use ${KEY} and Bearer abc.def.ghi-123456`)]));
    s.write({ ...(response('t.turn-1', 1, `reply with ${KEY}`) as object), error: { kind: 'auth', message: `401: Incorrect API key provided: ${KEY}` } } as unknown as TraceInput);
    s.write({ kind: 'tool.result', at: 2, turnId: 't.turn-1', callId: 'c1', outcome: 'ok', finishedAt: 2, body: { echoed: `Authorization: Bearer sk-someone-elses-token-99999 and ${KEY}` } });
    s.write({ kind: 'turn.end', at: 3, turnId: 't.turn-1', report: bareReport({ summary: `done ${KEY}` }) });

    for (const omitText of [false, true]) {
      const text = s.toJsonl({ omitText });
      expect(text).not.toContain(KEY);
      expect(text).not.toContain('CAOTANG-SECRET');
      expect(text).not.toContain('someone-elses-token');
      expect(text).not.toContain('abc.def.ghi');
    }
    expect(s.toJsonl()).toContain('[redacted]');
  });

  it('is scrubbed from what the gateway observer writes, whatever the profile', async () => {
    const s = store();
    const observe = traceGateway(s);
    observe({ type: 'request', id: 1, req: { messages: [user(`key ${KEY}`)], turnId: 't.turn-1', callIndex: 1 }, profileId: 'prv', model: 'm', at: 1 });
    observe({ type: 'response', id: 1, finishReason: 'stop', content: `Bearer sk-aaaaaaaaaaaa`, reasoningText: '', usage: { promptTokens: 1, completionTokens: 1 }, usageSource: 'estimate', attempts: 1, at: 2 });
    expect(s.toJsonl()).not.toMatch(/sk-a{12}|CAOTANG-SECRET/);
  });
});

describe('an export that leaves out the manuscript text', () => {
  const MARK = 'ZEBRAMARK';

  function filled(): TraceStore {
    const s = store({ project: () => `${MARK} project` });
    s.write(start('t.turn-1', `${MARK} intent`));
    s.write({ kind: 'context', at: 1, turnId: 't.turn-1', callIndex: 1, layers: [{ id: 'L3', tokens: 12 }], dropped: [`Codex: “${MARK}” is left out`] });
    s.write(request('t.turn-1', 1, [{ role: 'system', content: `${MARK} system` }, { role: 'user', content: `${MARK} manuscript` }, { role: 'assistant', content: `${MARK} earlier`, toolCalls: [{ id: 'c', name: 'doc.read', argumentsJson: `{"doc":"${MARK}"}` }], reasoning: [{ text: `${MARK} thought`, raw: { sig: MARK } }] }]));
    s.write({ ...(response('t.turn-1', 1, `${MARK} reply`) as object), reasoningText: `${MARK} reasoning`, toolCalls: [{ id: 'c', name: 'doc.read', argumentsJson: `{"doc":"${MARK}"}` }] } as unknown as TraceInput);
    s.write({ kind: 'tool.call', at: 3, turnId: 't.turn-1', callId: 'c1', tool: 'doc.read', risk: 'read', params: { doc: MARK, nested: { a: MARK } } });
    s.write({ kind: 'tool.progress', at: 3.5, turnId: 't.turn-1', callId: 'c1', progress: 1, total: 4, message: `${MARK} progress` });
    s.write({ kind: 'tool.result', at: 4, turnId: 't.turn-1', callId: 'c1', outcome: 'ok', finishedAt: 4, body: { text: `${MARK} body` } });
    s.write({ kind: 'ladder', at: 5, turnId: 't.turn-1', callId: 'c1', attempt: 1, reason: `${MARK} reason` });
    s.write({ kind: 'hook', at: 5, turnId: 't.turn-1', hookId: 'h_7K2QX9M4A1', name: `${MARK} hook`, event: 'tool.after', tool: 'doc.read', action: 'context', text: `${MARK} finding`, ms: 3, failed: `${MARK} failure` });
    s.write({
      kind: 'turn.end',
      at: 6,
      turnId: 't.turn-1',
      report: bareReport({
        text: `${MARK} text`,
        summary: `${MARK} summary`,
        steps: [{ index: 0, tool: 'doc.read', expect: MARK, status: 'done', summary: MARK, data: { x: MARK } }],
        cards: [{ kind: 'plan', tools: ['doc.read'], decision: 'approved', edits: 1, retries: 0 }],
        trace: [{ tool: 'doc.read', callId: 'c1', outcome: 'ok', params: { doc: MARK } }],
        hooks: [{ hookId: 'h_7K2QX9M4A1', name: `${MARK} hook`, event: 'tool.after', tool: 'doc.read', decision: { action: 'context', text: `${MARK} finding` }, ms: 3 }],
        tokens: { promptTokens: 10, completionTokens: 4, requests: 1 },
        dropped: [MARK],
        modelCalls: 1,
        mode: 'ask',
        budgetUse: { modelCalls: 1, tokens: 14, wordsChanged: 0, documents: 0, steps: 0 },
      }),
    });
    return s;
  }

  it('contains none of the text, only how long it was', () => {
    const text = filled().toJsonl({ omitText: true });
    expect(text).not.toContain(MARK);
    expect(text).toContain('"omitted":{"chars":');
    expect(parsed(text).length).toBeGreaterThan(8);
  });

  it('keeps structure, timing, tool names, risk, outcomes, token counts and finish reasons', () => {
    const records = parsed(filled().toJsonl({ omitText: true }));
    const byKind = (kind: TraceKind) => records.find((record) => record.kind === kind) as unknown as Record<string, unknown>;
    expect(byKind('model.response')).toMatchObject({ 'gen_ai.response.finish_reasons': ['stop'], 'gen_ai.usage.input_tokens': 10, 'gen_ai.usage.output_tokens': 4, finishedAt: 2 });
    expect(byKind('tool.call')).toMatchObject({ tool: 'doc.read', risk: 'read', params: { doc: { omitted: { chars: MARK.length } } } });
    expect(byKind('tool.result')).toMatchObject({ outcome: 'ok', body: { omitted: { chars: expect.any(Number) } } });
    expect(byKind('tool.progress')).toMatchObject({ progress: 1, total: 4, message: { omitted: { chars: `${MARK} progress`.length } } });
    expect(byKind('turn.end')).toMatchObject({ report: { status: 'replied', tokens: { promptTokens: 10 }, cards: [{ decision: 'approved', edits: 1 }], trace: [{ tool: 'doc.read', outcome: 'ok' }] } });
    // A hook keeps its id, event, tool, what it did and how long it took; its name and the text it reported are stubs.
    expect(byKind('hook')).toMatchObject({ hookId: 'h_7K2QX9M4A1', event: 'tool.after', tool: 'doc.read', action: 'context', ms: 3, name: { omitted: { chars: expect.any(Number) } }, text: { omitted: { chars: expect.any(Number) } } });
    expect(byKind('turn.end')).toMatchObject({ report: { hooks: [{ hookId: 'h_7K2QX9M4A1', action: 'context', ms: 3 }] } });
  });

  it('stubs the message of a provider error, which quotes the start of the body the provider sent', () => {
    const s = store();
    const message = `a.example sent a response Caotang could not read: ${MARK} {"choices":[{"message":{"content":"${MARK} reply"}}]}`;
    s.write({ ...(response('t.turn-1', 1, '') as object), error: { kind: 'protocol', message } } as unknown as TraceInput);
    const text = s.toJsonl({ omitText: true });
    expect(text).not.toContain(MARK);
    expect(parsed(text).find((record) => record.kind === 'model.response')).toMatchObject({ error: { kind: 'protocol', message: { omitted: { chars: message.length } } } });
    expect(s.toJsonl()).toContain(MARK);
  });

  it('leaves the store itself whole', () => {
    const s = filled();
    s.toJsonl({ omitText: true });
    expect(s.toJsonl()).toContain(MARK);
  });

  it('stubs a record on its own', () => {
    const [header] = parsed(filled().toJsonl());
    expect(omitRecord(header as TraceRecord)).toMatchObject({ project: { name: { omitted: { chars: `${MARK} project`.length } } } });
  });
});

/* ------------------------------------------------------------------ *
 * A real turn
 * ------------------------------------------------------------------ */

async function tracedTurn(intent: string, scripts: Parameters<typeof createMockProvider>[0], sink: TraceStore | { write: (record: TraceInput) => void }) {
  const clock = createManualClock(0);
  const keys = createKeyStore(createMemoryVaultPort());
  const profiles = createProfileStore({ keys });
  await profiles.create({ name: 'Mock', kind: 'mock', isActive: true });
  const gateway = createGateway({ profiles, keys, clock, mock: createMockProvider(scripts), observe: traceGateway(sink) });
  const harness = createHarness({ state: makeState(), ports: createAgentPorts() });
  const session = createAgentSession({ harness, gateway, decide: async () => ({ action: 'approve' }), sessionId: 'test', trace: sink, clock: () => clock.now() });
  const report = await session.submit(intent);
  return { report, session };
}

describe('the records a turn writes', () => {
  it('holds the turn in order, with the model calls joined by turn and call index, and ends with the returned report', async () => {
    const s = store();
    const { report } = await tracedTurn(
      'Draft the opening of The Friend.',
      { scripts: [transcript('Draft the opening of The Friend.', [steps({ tool: 'scene.draft', params: { doc: 'The Friend', instruction: 'Open.', mode: 'draft' }, expect: 'drafted' })]), prose('Brief: Open.', 'The ferry came in.')] },
      s,
    );
    expect(report.status).toBe('applied');

    const records = s.records(report.turnId);
    expect(records[0]).toMatchObject({ kind: 'turn.start', intent: 'Draft the opening of The Friend.' });
    expect(records.at(-1)).toMatchObject({ kind: 'turn.end' });
    expect((records.at(-1) as { report: unknown }).report).toEqual(report);

    const requests = records.filter((record) => record.kind === 'model.request');
    const responses = records.filter((record) => record.kind === 'model.response');
    expect(requests.length).toBe(report.modelCalls);
    expect(requests.map((r) => (r as { callIndex?: number }).callIndex)).toEqual(requests.map((_, index) => index + 1));
    for (const [index, asked] of requests.entries()) {
      const answered = responses[index] as { callId: number; callIndex: number };
      expect(answered.callId).toBe((asked as { callId: number }).callId);
      expect(answered.callIndex).toBe(index + 1);
      expect(records.indexOf(asked)).toBeLessThan(records.indexOf(answered as unknown as TraceRecord));
    }

    expect(records.filter((record) => record.kind === 'card')).toMatchObject([{ card: { kind: 'confirm', decision: 'approved', tools: ['scene.draft'] } }]);
    const call = records.find((record) => record.kind === 'tool.call');
    const result = records.find((record) => record.kind === 'tool.result');
    expect(call).toMatchObject({ tool: 'scene.draft', risk: 'write-confirm' });
    expect(result).toMatchObject({ outcome: 'ok', callId: (call as { callId: string }).callId });
    expect((result as { body: unknown }).body).toEqual(report.steps[0]?.data);

    expect(records.findIndex((record) => record.kind === 'context')).toBeLessThan(records.findIndex((record) => record.kind === 'model.request'));
    expect(records.some((record) => record.kind === 'context' && record.layers.length > 0)).toBe(true);
  });

  it('records the result of a refused step as the refusal the model reads', async () => {
    const s = store();
    const { report } = await tracedTurn(
      'Read the Missing document.',
      { scripts: [transcript('Read the Missing document.', [steps({ tool: 'doc.read', params: { doc: 'Nowhere At All' }, expect: 'read' }), JSON.stringify({ reply: 'No such document.' })])] },
      s,
    );
    const result = s.records(report.turnId).find((record) => record.kind === 'tool.result') as { outcome: string; body: unknown } | undefined;
    expect(result?.outcome).toBe('refused');
    expect(typeof result?.body).toBe('string');
  });

  it('is not disturbed by a sink that throws', async () => {
    const sink = {
      write: () => {
        throw new Error('trace broke');
      },
    };
    const { report } = await tracedTurn('Say hello.', { scripts: [transcript('Say hello.', [JSON.stringify({ reply: 'Hello.' })])] }, sink);
    expect(report.status).toBe('replied');
    expect(report.text).toBe('Hello.');
  });

  it('writes nothing, and changes no request, when no sink is given', async () => {
    const clock = createManualClock(0);
    const keys = createKeyStore(createMemoryVaultPort());
    const profiles = createProfileStore({ keys });
    await profiles.create({ name: 'Mock', kind: 'mock', isActive: true });
    const seen: number[] = [];
    const gateway = createGateway({ profiles, keys, clock, mock: createMockProvider({ scripts: [transcript('Say hi.', [JSON.stringify({ reply: 'Hi.' })])] }), observe: (event) => event.type === 'request' && seen.push(event.req.callIndex ?? -1) });
    const session = createAgentSession({ harness: createHarness({ state: makeState(), ports: createAgentPorts() }), gateway, decide: async () => ({ action: 'approve' }), sessionId: 'test' });
    await session.submit('Say hi.');
    expect(seen).toEqual([-1]);
  });
});
