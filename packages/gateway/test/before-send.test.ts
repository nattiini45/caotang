import { describe, expect, it } from 'vitest';
import type { GatewayTraceEvent } from '../src/index.js';
import { addEndpoint, collect, finish, flush, harness, ScriptedFetch, sseResponse, userMessage } from './helpers.js';

describe('caller admission at actual dispatch', () => {
  it('refuses an initial endpoint attempt without fetch or ledger spend', async () => {
    const h = harness();
    await addEndpoint(h);
    const refusal = new Error('The caller read boundary changed.');
    const { error } = await collect(h.gateway.complete(userMessage('Read the opening.'), undefined, () => { throw refusal; }));
    expect(error).toBe(refusal);
    expect(h.net.calls).toEqual([]);
    expect(h.gateway.ledger.turnRows()).toEqual([]);
  });

  it('refuses a mock request before counting it', async () => {
    const h = harness();
    await h.profiles.create({ name: 'Admission mock', kind: 'mock' });
    const refusal = new Error('The caller read boundary changed.');
    const { error } = await collect(h.gateway.complete(userMessage('Read the opening.'), undefined, () => { throw refusal; }));
    expect(error).toBe(refusal);
    expect(h.gateway.ledger.turnRows()).toEqual([]);
  });

  it('rechecks after retry backoff and retains only the attempt already sent', async () => {
    const h = harness({ net: new ScriptedFetch().push(() => new Response('Try later.', { status: 503 })) });
    await addEndpoint(h);
    const refusal = new Error('The caller read boundary changed.');
    let admitted = true;
    let checks = 0;
    const run = collect(h.gateway.complete({ ...userMessage('Read the opening.'), turnId: 'retry-turn' }, undefined, () => {
      checks += 1;
      if (!admitted) throw refusal;
    }));
    await flush();
    expect(h.net.calls).toHaveLength(1);
    admitted = false;
    h.clock.advance(1_000);
    expect((await run).error).toBe(refusal);
    expect(checks).toBe(2);
    expect(h.net.calls).toHaveLength(1);
    expect(h.gateway.ledger.turnTotals('retry-turn').requests).toBe(1);
  });

  it('keeps the local callback out of the provider request and trace payload', async () => {
    const events: GatewayTraceEvent[] = [];
    const h = harness({ net: new ScriptedFetch().push(() => sseResponse([finish('stop'), '[DONE]'])), observe: (event) => events.push(event) });
    await addEndpoint(h);
    let checks = 0;
    const { error } = await collect(h.gateway.complete(userMessage('Read the opening.'), undefined, () => { checks += 1; }));
    expect(error).toBeUndefined();
    expect(checks).toBe(1);
    expect(h.net.bodyOf(0)).not.toHaveProperty('beforeSend');
    const request = events.find((event) => event.type === 'request');
    expect(request?.type).toBe('request');
    if (request?.type === 'request') expect(request.req).not.toHaveProperty('beforeSend');
  });
});
