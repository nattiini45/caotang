/**
 * Usage accounting (§6) and the local request log (§4). A request lands in exactly one
 * day row and, when it has a turn, one turn row, and retries count as requests because
 * the provider billed them.
 */

import { describe, expect, it } from 'vitest';
import { costOf, estimateTokens, localDayKey, UsageLedger, RequestLog, REQUEST_LOG_CAP } from '../src/index.js';
import { addEndpoint, collect, delta, finish, flush, harness, openSse, ScriptedFetch, sseResponse, START, userMessage } from './helpers.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const DETAIL = { cachedPromptTokens: 0, cacheWritePromptTokens: 0, reasoningTokens: 0, estimatedRequests: 0, unpricedRequests: 1, providerCostRequests: 0 };

describe('usage ledger — day rows (§6)', () => {
  it('records a mock request in the day row for its local date, with its tokens and one request', async () => {
    const h = harness();
    const mock = await h.profiles.create({ name: 'Offline', kind: 'mock' });

    await collect(h.gateway.complete(userMessage('hello')));

    expect(h.gateway.ledger.dayRows()).toEqual([
      {
        version: 1, ...DETAIL,
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

  it('counts a request that failed with no usage using a labelled prompt estimate', async () => {
    const h = harness({ net: new ScriptedFetch().push(() => jsonResponse(401, 'no')) });
    await addEndpoint(h);

    await collect(h.gateway.complete(userMessage('x')));
    expect(h.gateway.ledger.dayRows()[0]).toMatchObject({ promptTokens: 1, completionTokens: 0, requests: 1, estimatedRequests: 1 });
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
      { version: 1, ...DETAIL, date: localDayKey(START), profileId: 'p', model: 'm', role: 'chat', promptTokens: 10, completionTokens: 5, requests: 1 },
    ]);
  });
});

describe('usage ledger — turn rows (§6)', () => {
  it('uses a standalone accounting id without turning the request into an agent turn, and a real turn takes precedence', async () => {
    const h = harness();
    await h.profiles.create({ name: 'Offline', kind: 'mock' });
    await collect(h.gateway.complete({ ...userMessage('review'), usageTurnId: 'review-1' }));
    await collect(h.gateway.complete({ ...userMessage('agent review'), turnId: 'parent', usageTurnId: 'ignored' }));
    expect(h.gateway.ledger.turnRows().map((row) => row.turnId)).toEqual(['review-1', 'parent']);
    expect(h.gateway.ledger.turnTotals('review-1').requests).toBe(1);
  });

  it('attributes each request to its turn and totals the turn across requests', async () => {
    const h = harness();
    const mock = await h.profiles.create({ name: 'Offline', kind: 'mock' });

    await collect(h.gateway.complete({ ...userMessage('one'), turnId: 'turn-7' }));
    await collect(h.gateway.complete({ ...userMessage('two'), turnId: 'turn-7' }));
    await collect(h.gateway.complete(userMessage('untagged')));

    expect(h.gateway.ledger.turnRows()).toEqual([
      {
        version: 1, ...DETAIL, unpricedRequests: 2,
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

  it('keeps every turn beyond the old 200-row cap, including after a snapshot reload', () => {
    const h = harness();
    for (let i = 0; i < 205; i += 1) {
      h.gateway.accountTokens({ promptTokens: 1, completionTokens: 1 }, { profileId: 'p', model: 'm', turnId: `t${i}` });
    }
    const turns = h.gateway.ledger.turnRows();
    expect(turns).toHaveLength(205);
    expect(turns[0]?.turnId).toBe('t0');
    expect(turns.at(-1)?.turnId).toBe('t204');
    const restored = new UsageLedger();
    restored.restore(JSON.parse(JSON.stringify(h.gateway.ledger.snapshot())));
    expect(restored.turnRows()).toEqual(turns);
  });
});

describe('usage ledger — the snapshot', () => {
  it('migrates a bare day array without repricing, changing its day or losing its role', () => {
    const ledger = new UsageLedger();
    ledger.restore([{ date: '2020-01-01', profileId: 'p', model: 'm', role: 'background', promptTokens: 20, completionTokens: 3, requests: 2 }]);
    expect(ledger.dayRows()).toEqual([{ version: 1, ...DETAIL, unpricedRequests: 2, date: '2020-01-01', profileId: 'p', model: 'm', role: 'background', promptTokens: 20, completionTokens: 3, requests: 2 }]);
    expect(ledger.snapshot().version).toBe(1);
  });

  it('validates atomically and refuses unknown versions without changing existing rows', () => {
    const ledger = new UsageLedger();
    ledger.record({ profileId: 'p', model: 'm' }, { promptTokens: 1, completionTokens: 2 });
    const before = ledger.snapshot();
    expect(() => ledger.restore({ version: 2, days: [], turns: [] })).toThrow('version');
    expect(() => ledger.restore({ version: 1, days: before.days, turns: [null] })).toThrow();
    expect(ledger.snapshot()).toEqual(before);
  });

  it('sums recorded prices and breakdowns across profiles, models, roles and sessions', () => {
    const ledger = new UsageLedger();
    ledger.record({ profileId: 'p', model: 'a', turnId: 't', sessionId: 's', pricePer1k: { prompt: 1, completion: 2 } }, { promptTokens: 1000, completionTokens: 100, reasoningTokens: 50 });
    ledger.record({ profileId: 'q', model: 'b', role: 'drafting', turnId: 't', sessionId: 's', pricePer1k: { prompt: 2, completion: 4, cachedPrompt: 0.2, cacheWritePrompt: 2.5 } }, { promptTokens: 1000, completionTokens: 100, cachedPromptTokens: 500, cacheWritePromptTokens: 100, source: 'estimate' });
    ledger.record({ profileId: 'q', model: 'b', turnId: 'u', sessionId: 'other' }, { promptTokens: 10, completionTokens: 5 });
    expect(ledger.turnTotals('t')).toEqual({ promptTokens: 2000, completionTokens: 200, requests: 2, cachedPromptTokens: 500, cacheWritePromptTokens: 100, reasoningTokens: 50, estimatedRequests: 1, unpricedRequests: 0, providerCostRequests: 0, costUsd: 2.75 });
    expect(ledger.sessionTotals('s')).toEqual(ledger.turnTotals('t'));
    expect(ledger.sessionTotals('other').unpricedRequests).toBe(1);
    expect(ledger.turnRowsOf('t')).toHaveLength(2);
  });

  it('prefers an explicit provider cost, including zero, and does not call an unknown price free', () => {
    expect(costOf({ promptTokens: 100, completionTokens: 50, providerCostUsd: 0 }, { prompt: 1, completion: 1 })).toBe(0);
    expect(costOf({ promptTokens: 100, completionTokens: 50 }, undefined)).toBeUndefined();
  });

  it('captures prices before a request starts and does not reprice old calls', async () => {
    const h = harness();
    const p = await h.profiles.create({ name: 'Priced', kind: 'mock', pricePer1k: { prompt: 1, completion: 2 } });
    await collect(h.gateway.complete({ ...userMessage('abcd'), turnId: 't' }));
    const before = h.gateway.ledger.turnTotals('t');
    await h.profiles.update(p.id, { pricePer1k: { prompt: 9, completion: 9 } });
    expect(h.gateway.ledger.turnTotals('t')).toEqual(before);
    expect(before.costUsd).toBe(0.003);
    expect(before.estimatedRequests).toBe(0);
  });

  it('keeps the price from the start of a call when a profile changes before the response', async () => {
    const body = openSse();
    const h = harness({ net: new ScriptedFetch().push(() => body.response) });
    const p = await addEndpoint(h, { pricePer1k: { prompt: 1, completion: 2 } });
    const run = collect(h.gateway.complete({ ...userMessage('abcd'), turnId: 't' }));
    await flush();
    await h.profiles.update(p.id, { pricePer1k: { prompt: 9, completion: 9 } });
    body.event(finish('stop', { prompt_tokens: 1000, completion_tokens: 100 }));
    body.event('[DONE]');
    body.close();
    await run;
    expect(h.gateway.ledger.turnTotals('t').costUsd).toBe(1.2);
  });

  it('uses the same provider-listing price as modelLimits when the profile has no price', async () => {
    const net = new ScriptedFetch().push(
      () => jsonResponse(200, { data: [{ id: 'model-x', pricing: { prompt: '0.000001', completion: '0.000002' } }] }),
      () => sseResponse([finish('stop', { prompt_tokens: 1000, completion_tokens: 100 }), '[DONE]']),
    );
    const h = harness({ net });
    const p = await addEndpoint(h);
    await h.gateway.listModels(p.id);
    const price = h.gateway.modelLimits(p.id).pricePer1k;
    await collect(h.gateway.complete({ ...userMessage('x'), turnId: 't' }));
    expect(price).toEqual({ prompt: 0.001, completion: 0.002 });
    expect(h.gateway.ledger.turnTotals('t').costUsd).toBe(costOf({ promptTokens: 1000, completionTokens: 100 }, price));
  });

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
