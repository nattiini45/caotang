/**
 * Usage accounting (§6) and the local request log (§4). A request lands in exactly one
 * day row and, when it has a turn, one turn row, and retries count as requests because
 * the provider billed them.
 */

import { describe, expect, it } from 'vitest';
import { estimateTokens, localDayKey, MAX_TURN_ROWS, RequestLog, REQUEST_LOG_CAP } from '../src/index.js';
import { addEndpoint, collect, delta, finish, flush, harness, openSse, ScriptedFetch, sseResponse, START, userMessage } from './helpers.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('usage ledger — day rows (§6)', () => {
  it('records a mock request in the day row for its local date, with its tokens and one request', async () => {
    const h = harness();
    const mock = await h.profiles.create({ name: 'Offline', kind: 'mock' });

    await collect(h.gateway.complete(userMessage('hello')));

    expect(h.gateway.ledger.dayRows()).toEqual([
      {
        date: localDayKey(START),
        profileId: mock.id,
        model: 'mock/echo-1',
        role: 'chat',
        promptTokens: estimateTokens('hello'),
        completionTokens: estimateTokens('hello'),
        requests: 1,
      },
    ]);
  });

  it('adds up requests within a day and splits rows across the day boundary', async () => {
    const h = harness();
    await h.profiles.create({ name: 'Offline', kind: 'mock' });

    await collect(h.gateway.complete(userMessage('a')));
    await collect(h.gateway.complete(userMessage('b')));
    expect(h.gateway.ledger.dayRows()).toHaveLength(1);
    expect(h.gateway.ledger.dayRows()[0]?.requests).toBe(2);

    h.clock.advance(13 * 60 * 60 * 1000);
    await collect(h.gateway.complete(userMessage('c')));
    const rows = h.gateway.ledger.dayRows();
    expect(rows.map((r) => r.date)).toEqual([localDayKey(START), localDayKey(START + 13 * 60 * 60 * 1000)]);
    expect(rows.map((r) => r.requests)).toEqual([2, 1]);
  });

  it('counts every retry as a request, and only the successful attempt’s usage as tokens', async () => {
    const net = new ScriptedFetch().push(
      () => jsonResponse(500, 'boom'),
      () => sseResponse([delta('ok'), finish('stop', { prompt_tokens: 9, completion_tokens: 3 }), '[DONE]']),
    );
    const h = harness({ net });
    await addEndpoint(h);

    const run = collect(h.gateway.complete(userMessage('x')));
    await flush();
    h.clock.advance(1_000);
    await run;

    const [row] = h.gateway.ledger.dayRows();
    expect(row).toMatchObject({ promptTokens: 9, completionTokens: 3, requests: 2 });
  });

  it('counts a request that failed with no usage as a request with zero tokens', async () => {
    const h = harness({ net: new ScriptedFetch().push(() => jsonResponse(401, 'no')) });
    await addEndpoint(h);

    await collect(h.gateway.complete(userMessage('x')));
    expect(h.gateway.ledger.dayRows()[0]).toMatchObject({ promptTokens: 0, completionTokens: 0, requests: 1 });
  });

  it('counts the delivered part of a stream the consumer abandons, as an estimate', async () => {
    const body = openSse();
    const h = harness({ net: new ScriptedFetch().push(() => body.response) });
    await addEndpoint(h);

    const iterator = h.gateway.complete(userMessage('x'))[Symbol.asyncIterator]();
    const started = iterator.next();
    await flush();
    body.event(delta('abcdefgh'));
    await started;
    await iterator.return?.(undefined);

    expect(h.gateway.ledger.dayRows()[0]).toMatchObject({ completionTokens: estimateTokens('abcdefgh'), requests: 1 });
  });

  it('lets the harness account usage it observes outside complete(), as one request', () => {
    const h = harness();
    h.gateway.accountTokens({ promptTokens: 10, completionTokens: 5 }, { profileId: 'p', model: 'm' });
    expect(h.gateway.ledger.dayRows()).toEqual([
      { date: localDayKey(START), profileId: 'p', model: 'm', role: 'chat', promptTokens: 10, completionTokens: 5, requests: 1 },
    ]);
  });
});

describe('usage ledger — turn rows (§6)', () => {
  it('attributes each request to its turn and totals the turn across requests', async () => {
    const h = harness();
    const mock = await h.profiles.create({ name: 'Offline', kind: 'mock' });

    await collect(h.gateway.complete({ ...userMessage('one'), turnId: 'turn-7' }));
    await collect(h.gateway.complete({ ...userMessage('two'), turnId: 'turn-7' }));
    await collect(h.gateway.complete(userMessage('untagged')));

    expect(h.gateway.ledger.turnRows()).toEqual([
      {
        turnId: 'turn-7',
        profileId: mock.id,
        model: 'mock/echo-1',
        role: 'chat',
        promptTokens: estimateTokens('one') + estimateTokens('two'),
        completionTokens: estimateTokens('one') + estimateTokens('two'),
        requests: 2,
      },
    ]);
    expect(h.gateway.ledger.turnTotals('turn-7')).toMatchObject({ requests: 2 });
    expect(h.gateway.ledger.turnTotals('no-such-turn')).toMatchObject({ requests: 0 });
  });

  it('splits a turn by the delegated agent that made each request, and still totals the whole turn', async () => {
    const h = harness();
    const mock = await h.profiles.create({ name: 'Offline', kind: 'mock' });

    await collect(h.gateway.complete({ ...userMessage('own'), turnId: 'turn-9' }));
    await collect(h.gateway.complete({ ...userMessage('child'), turnId: 'turn-9', agentPath: 'turn-9/reader#1' }));
    await collect(h.gateway.complete({ ...userMessage('child'), turnId: 'turn-9', agentPath: 'turn-9/reader#1' }));

    const rows = h.gateway.ledger.turnRows();
    expect(rows.map((row) => [row.agentPath, row.requests])).toEqual([
      [undefined, 1],
      ['turn-9/reader#1', 2],
    ]);
    expect(rows.every((row) => row.profileId === mock.id)).toBe(true);
    expect(h.gateway.ledger.turnTotals('turn-9')).toMatchObject({ requests: 3 });
    // The day row has no agent path: it counts the day, and the split is the turn's.
    expect(h.gateway.ledger.dayRows()).toHaveLength(1);
  });

  it('keeps only the most recent turns, so a long session cannot grow the ledger without bound', () => {
    const h = harness();
    for (let i = 0; i < MAX_TURN_ROWS + 5; i += 1) {
      h.gateway.accountTokens({ promptTokens: 1, completionTokens: 1 }, { profileId: 'p', model: 'm', turnId: `t${i}` });
    }
    const turns = h.gateway.ledger.turnRows();
    expect(turns).toHaveLength(MAX_TURN_ROWS);
    expect(turns[0]?.turnId).toBe('t5');
    expect(turns.at(-1)?.turnId).toBe(`t${MAX_TURN_ROWS + 4}`);
  });
});

describe('usage ledger — the snapshot', () => {
  it('serialises to plain JSON that round-trips unchanged', async () => {
    const h = harness();
    await h.profiles.create({ name: 'Offline', kind: 'mock' });
    await collect(h.gateway.complete({ ...userMessage('x'), turnId: 't' }));

    const snapshot = h.gateway.ledger.snapshot();
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it('returns copies, so a caller cannot edit the ledger through a row', () => {
    const h = harness();
    h.gateway.accountTokens({ promptTokens: 1, completionTokens: 1 }, { profileId: 'p', model: 'm' });
    const [row] = h.gateway.ledger.dayRows();
    row!.requests = 999;
    expect(h.gateway.ledger.dayRows()[0]?.requests).toBe(1);
  });
});

describe('request log (§4)', () => {
  it('records a failed attempt and its retry, then the success, in order with their attempt numbers', async () => {
    const net = new ScriptedFetch().push(() => jsonResponse(500, 'boom'), () => sseResponse([finish('stop'), '[DONE]']));
    const h = harness({ net });
    await addEndpoint(h);

    const run = collect(h.gateway.complete(userMessage('x')));
    await flush();
    h.clock.advance(1_000);
    await run;

    const entries = h.gateway.requestLog.entries();
    expect(entries.map((e) => [e.attempt, e.outcome])).toEqual([
      [0, 'retrying'],
      [1, 'ok'],
    ]);
    expect(entries[0]).toMatchObject({ status: 500, errorKind: 'provider' });
    expect(entries[1]).toMatchObject({ status: 200 });
    expect(entries[0]?.url).toBe('https://a.example/v1/chat/completions');
  });

  it('keeps the newest fifty entries, dropping the oldest', () => {
    const log = new RequestLog();
    for (let i = 0; i < REQUEST_LOG_CAP + 10; i += 1) {
      log.append({ at: i, profileId: 'p', model: 'm', attempt: i, url: 'https://a.example/v1/chat/completions', outcome: 'ok' });
    }
    const entries = log.entries();
    expect(entries).toHaveLength(REQUEST_LOG_CAP);
    expect(entries[0]?.attempt).toBe(10);
    expect(entries.at(-1)?.attempt).toBe(REQUEST_LOG_CAP + 9);
  });

  it('returns copies, and entries cannot be edited once written', () => {
    const log = new RequestLog();
    log.append({ at: 1, profileId: 'p', model: 'm', attempt: 0, url: 'https://a.example/v1/chat/completions', outcome: 'ok' });
    const [entry] = log.entries();
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as { outcome: string }).outcome = 'failed';
    }).toThrow();
  });
});
