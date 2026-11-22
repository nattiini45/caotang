/**
 * `caotang replay` in process: a trace file replayed against the demo provider, with the estimate printed and the run waiting for
 * an answer, and nothing written to the project. The provider is the mock, so no test needs a key or the network.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { endpoint } from '../../sdk/test/endpoint.js';
import { answerFrom, runReplayCommand } from '../src/run-replay.js';
import { capture, folderBytes, removeDir, seedProject, tempDir } from './support.js';

const KEY = 'sk-replay-test-0123456789';
const STORM = 'n_TEMPEST001';
const PROVIDER = ['--provider', 'generic', '--base-url', 'https://llm.example.test/v1', '--model', 'cheap-model', '--key-env', 'MY_KEY'] as const;

let root = '';
beforeEach(async () => {
  root = tempDir('replay');
  await seedProject(root);
});
afterEach(() => {
  removeDir(root);
});

/** A recording of one model call: a header, a turn, the messages it sent, the request and the reply. */
function traceFile(turnId = 'record.turn-1'): string {
  const records = [
    { v: 1, seq: 1, at: 1000, sessionId: 'tab-0000', kind: 'header', format: 'caotang.trace/1', app: '0.1.0', project: { name: 'The Lighthouse Keeper' } },
    { v: 1, seq: 2, at: 1001, sessionId: 'tab-0000', kind: 'turn.start', turnId, intent: 'Label The Landing as revised.' },
    {
      v: 1,
      seq: 3,
      at: 1002,
      sessionId: 'tab-0000',
      kind: 'message',
      id: 'm0',
      message: { role: 'system', content: 'You are Caotang’s planner.' },
    },
    { v: 1, seq: 4, at: 1003, sessionId: 'tab-0000', kind: 'message', id: 'm1', message: { role: 'user', content: 'Request: Label The Landing as revised.' } },
    {
      v: 1,
      seq: 5,
      at: 1004,
      sessionId: 'tab-0000',
      kind: 'model.request',
      callId: 1,
      turnId,
      callIndex: 1,
      profileId: 'prv_0000000001',
      'gen_ai.request.model': 'recorded-model',
      messages: ['m0', 'm1'],
      responseFormat: 'json',
      responseFormatHint: { type: 'object', properties: { steps: { type: 'array' } }, required: ['steps'] },
    },
    {
      v: 1,
      seq: 6,
      at: 1005,
      sessionId: 'tab-0000',
      kind: 'model.response',
      callId: 1,
      turnId,
      callIndex: 1,
      finishedAt: 1400,
      attempts: 1,
      tries: [{ attempt: 1, outcome: 'ok', at: 1400 }],
      'gen_ai.response.finish_reasons': ['stop'],
      content: JSON.stringify({ steps: [{ tool: 'meta.set', params: { targets: ['The Landing'], status: 'revised' }, expect: 'The Landing is revised' }] }),
      'gen_ai.usage.input_tokens': 1200,
      'gen_ai.usage.output_tokens': 90,
      usageSource: 'provider',
    },
  ];
  const file = join(root, 'turn.jsonl');
  writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  return file;
}

/** A read-deny in the project file, the way Settings › Agent writes one. */
function denyStorm(): void {
  const path = join(root, 'caotang.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  manifest['agent'] = { rules: [{ effect: 'deny', tool: '*', scope: { subtree: STORM }, access: 'read', note: 'Not for a model' }] };
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

describe('the confirmation’s reader', () => {
  /** A line reader a person drives: the handler the command attached, and whether it was closed. */
  function reader(): { handlers: Map<string, (text?: string) => void>; closed: number; source: Parameters<typeof answerFrom>[0] } {
    const handlers = new Map<string, (text?: string) => void>();
    const state = { closed: 0 };
    return {
      handlers,
      get closed() {
        return state.closed;
      },
      source: {
        once: (event, handler) => {
          handlers.set(event, handler);
        },
        close: () => {
          state.closed += 1;
        },
      },
    };
  }

  it('answers with the line Enter sent, and closes the reader once', async () => {
    const r = reader();
    const answer = answerFrom(r.source);
    r.handlers.get('line')?.('y');
    expect(await answer).toBe('y');
    expect(r.closed).toBe(1);
  });

  it('answers nothing when the reader closes (Ctrl-D) or the writer interrupts (Ctrl-C)', async () => {
    for (const event of ['close', 'SIGINT'] as const) {
      const r = reader();
      const answer = answerFrom(r.source);
      r.handlers.get(event)?.();
      expect(await answer).toBe('');
      expect(r.closed).toBe(1);
    }
  });
});

describe('caotang replay', () => {
  it('takes its answer from the line reader when it has one, so Enter ends the question', async () => {
    const file = traceFile();
    const io = { ...capture({ cwd: root }), readLine: () => Promise.resolve('') };

    expect(await runReplayCommand([file, '--mock'], io)).toBe(0);
    expect(io.err.join('')).toContain('run it?');
    expect(io.err.join('')).toContain('nothing was sent');
    expect(io.out.join('')).toBe('');
  });

  it('prints the estimate first, and sends nothing when the answer is not y', async () => {
    const file = traceFile();
    const before = folderBytes(root);
    const io = capture({ cwd: root, stdin: 'n\n' });

    expect(await runReplayCommand([file, '--mock'], io)).toBe(0);

    expect(io.err.join('')).toContain('1 model call: 1,200 prompt tokens');
    expect(io.err.join('')).toContain('nothing was sent');
    expect(io.out.join('')).toBe('');
    expect(folderBytes(root)).toEqual(before);
  });

  it('replays one recorded call against the provider named, with --yes, and leaves the folder byte-identical', async () => {
    const file = traceFile();
    const scripted = endpoint(() => ({ kind: 'text', text: 'A cheaper answer.' }));
    const before = folderBytes(root);
    const io = capture({ cwd: root, stdin: 'n\n', env: { MY_KEY: KEY }, fetch: scripted.fetch });

    const code = await runReplayCommand([file, ...PROVIDER, '--yes'], io);
    expect(code, io.err.join('')).toBe(0);

    expect(io.err.join('')).not.toContain('run it?');
    expect(io.out.join('')).toContain('A cheaper answer.');
    expect(io.out.join('')).toContain('tokens: recording 1,200 prompt + 90 back over 1; replay');
    expect(io.out.join('')).toContain('the project was not changed');
    // One call went out, to the endpoint the flags named, carrying only the recorded messages.
    expect(scripted.requests).toHaveLength(1);
    expect(scripted.requests[0]?.url.startsWith('https://llm.example.test/v1')).toBe(true);
    expect(scripted.requests[0]?.system).toBe('You are Caotang’s planner.');
    expect(JSON.stringify([io.out, io.err])).not.toContain(KEY);
    expect(folderBytes(root)).toEqual(before);
  });

  it('writes JSON when the output format asks for it', async () => {
    const file = traceFile();
    const scripted = endpoint(() => ({ kind: 'text', text: 'A cheaper answer.' }));
    const io = capture({ cwd: root, stdin: '', env: { MY_KEY: KEY }, fetch: scripted.fetch });

    expect(await runReplayCommand([file, ...PROVIDER, '--yes', '--output-format', 'json'], io)).toBe(0);

    const parsed = JSON.parse(io.out.join('')) as { type: string; mode: string; usage: { original: { promptTokens: number } } };
    expect(parsed.type).toBe('replay');
    expect(parsed.mode).toBe('call');
    expect(parsed.usage.original.promptTokens).toBe(1200);
  });

  it('holds the project’s read-deny: a replayed turn never sends what the writer withheld', async () => {
    const file = traceFile();
    denyStorm();
    const scripted = endpoint(() => ({ kind: 'text', text: 'A cheaper answer.' }));
    const io = capture({ cwd: root, stdin: '', env: { MY_KEY: KEY }, fetch: scripted.fetch });

    // A turn replay assembles the project; the denied scene must be nowhere in what it sends.
    await runReplayCommand([file, ...PROVIDER, '--yes', '--mode', 'turn'], io);

    expect(scripted.requests.length).toBeGreaterThan(0);
    const sent = scripted.requests.map((request) => `${request.system}\n${request.user}`).join('\n');
    expect(sent).not.toContain('The lamp failed');
  });

  it('exits 4 when a turn replay’s own turn failed, as caotang agent does', async () => {
    const file = traceFile();
    // A 400 is terminal, so the turn fails at once instead of retrying: the point is the exit code, not the retry table.
    const scripted = endpoint(() => ({ kind: 'error', status: 400, body: JSON.stringify({ error: { message: 'that model is not available' } }) }));
    const io = capture({ cwd: root, stdin: '', env: { MY_KEY: KEY }, fetch: scripted.fetch });

    expect(await runReplayCommand([file, ...PROVIDER, '--yes', '--mode', 'turn'], io)).toBe(4);
    expect(io.out.join('')).toContain('failed');
  });

  it('refuses a trace whose turn is not in it, naming the turns it holds', async () => {
    const file = traceFile();
    const io = capture({ cwd: root, stdin: 'y\n' });

    expect(await runReplayCommand([file, '--mock', '--yes', '--turn', 'missing.turn-9'], io)).not.toBe(0);
    expect(io.err.join('')).toContain('this trace holds no turn missing.turn-9');
  });

  it('refuses a mode it does not have, and a file that is not there', async () => {
    const missing = capture({ cwd: root });
    expect(await runReplayCommand(['nope.jsonl', '--mock', '--mode', 'sideways'], missing)).toBe(2);
    expect(missing.err.join('')).toContain('--mode must be call, turn or cassette');
    expect(await runReplayCommand(['nope.jsonl', '--mock'], capture({ cwd: root }))).toBe(2);
  });
});
