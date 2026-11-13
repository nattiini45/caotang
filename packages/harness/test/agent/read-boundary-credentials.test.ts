import { describe, expect, it } from 'vitest';
import { createGateway, createKeyStore, createManualClock, createMemoryVaultPort, createProfileStore } from '@caotang/gateway';

import { createAgentPorts, createAgentSession, createBudgetMeter, createContextPort, type RuleSet } from '../../src/index.js';
import { FRIEND, LANDING, makeHarness } from '../fixtures.js';

describe('the read boundary after credential resolution', () => {
  it.each(['planner', 'auto', 'manual'] as const)('sends no %s request and releases its reservation when a read-deny is added while credentials are pending', async (kind) => {
    let rules: RuleSet = { rules: [] };
    const keys = createKeyStore(createMemoryVaultPort());
    const profiles = createProfileStore({ keys });
    await profiles.create({ name: 'Held credentials', kind: 'endpoint', preset: 'generic', baseUrl: 'https://example.invalid/v1', defaultModel: 'test-model', isActive: true });
    let release = (): void => {};
    let reading = (): void => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { reading = resolve; });
    const bodies: string[] = [];
    const gateway = createGateway({
      profiles, clock: createManualClock(0),
      keys: { ...keys, revealPayload: async (id) => { reading(); await held; return keys.revealPayload(id); } },
      fetch: async (_url, init) => {
        bodies.push(String(init.body));
        return new Response('data: {"choices":[{"delta":{"content":"Done."},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const meter = createBudgetMeter({ maxModelCalls: 5, maxTokens: 100_000 });
    const session = createAgentSession({ harness: makeHarness({ rules: () => rules }), gateway, meter, role: 'chat', compaction: { auto: kind === 'auto' }, history: Array.from({ length: 7 }, (_, index) => ({ turnId: `earlier-${index}`, intent: 'Read the friend.', outcome: 'Restricted earlier friend passage.' })), decide: async () => ({ action: 'cancel' }) });
    try {
      const pending = kind === 'manual' ? session.compact().then(({ report }) => report, () => session.reports().at(-1)!) : session.submit('Continue under the current read rules.');
      await ready;
      rules = { rules: [{ source: 'app', tool: 'doc.read', effect: 'deny', access: 'read', scope: { subtree: FRIEND } }] };
      release();
      const report = await pending;

      expect(bodies).toHaveLength(0);
      expect(report).toMatchObject({ status: 'failed', modelCalls: 0, tokens: { requests: 0 }, askBack: { code: 'needs_input' } });
      expect(report.askBack?.reason).toContain('read boundary');
      expect(report.compactions).toBeUndefined();
      expect(session.summary()).toBeUndefined();
      expect(gateway.ledger.turnRows()).toEqual([]);
      expect(meter.spend()).toMatchObject({ modelCalls: 0, promptTokens: 0, completionTokens: 0 });
      expect(meter.spend().estimatedTokens).toBe(0);
      expect(meter.spend().costUsd).toBeUndefined();
    } finally {
      release();
      meter.dispose();
    }
  });

  it('refuses a delegated request whose credentials resolve after the boundary changes', async () => {
    let rules: RuleSet = { rules: [] };
    const keys = createKeyStore(createMemoryVaultPort());
    const profiles = createProfileStore({ keys });
    await profiles.create({ name: 'Delegated credentials', kind: 'endpoint', preset: 'generic', baseUrl: 'https://example.invalid/v1', defaultModel: 'test-model', isActive: true });
    let release = (): void => {};
    let reading = (): void => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { reading = resolve; });
    let reveals = 0;
    let requests = 0;
    const gateway = {
      ...createGateway({
        profiles, clock: createManualClock(0),
        keys: { ...keys, revealPayload: async (id) => { if (++reveals === 2) { reading(); await held; } return keys.revealPayload(id); } },
        fetch: async () => {
          requests += 1;
          const content = JSON.stringify({ steps: [{ tool: 'agent.delegate', params: { agent: 'reader', brief: 'Read the opening.', scope: [LANDING] }, expect: 'The opening is read.' }] });
          return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
        },
      }),
      modelCaps: () => ({ tools: false }),
    };
    const meter = createBudgetMeter({ maxModelCalls: 6, maxTokens: 100_000 });
    const harness = makeHarness({ ports: createAgentPorts(), rules: () => rules });
    const session = createAgentSession({ harness, context: createContextPort({ state: harness.state }), gateway, meter, role: 'chat', decide: async () => ({ action: 'cancel' }) });
    try {
      const pending = session.submit('Read the opening with the reader.', { preload: ['agent.delegate'] });
      await ready;
      rules = { rules: [{ source: 'app', tool: 'doc.read', effect: 'deny', access: 'read', scope: { subtree: FRIEND } }] };
      release();
      const report = await pending;
      expect(report).toMatchObject({ status: 'failed', modelCalls: 1, tokens: { requests: 1 }, askBack: { code: 'needs_input' } });
      expect(report.askBack?.reason).toContain('read boundary');
      expect(requests).toBe(1);
      expect(gateway.ledger.turnRows().some((row) => row.agentPath !== undefined)).toBe(false);
      expect(meter.spend().modelCalls).toBe(1);
    } finally {
      release();
      meter.dispose();
    }
  });

  it('keeps a sent attempt accounted when a retry is refused after backoff', async () => {
    let rules: RuleSet = { rules: [] };
    const keys = createKeyStore(createMemoryVaultPort());
    const profiles = createProfileStore({ keys });
    await profiles.create({ name: 'Retry boundary', kind: 'endpoint', preset: 'generic', baseUrl: 'https://example.invalid/v1', defaultModel: 'test-model', isActive: true, pricePer1k: { prompt: 1, completion: 2 } });
    const clock = createManualClock(0);
    let requests = 0;
    const gateway = createGateway({ profiles, keys, clock, random: () => 0.5, fetch: async () => { requests += 1; return new Response('Try later.', { status: 503 }); } });
    const meter = createBudgetMeter({ maxModelCalls: 5, maxTokens: 100_000 });
    const session = createAgentSession({ harness: makeHarness({ rules: () => rules }), gateway, meter, role: 'chat', decide: async () => ({ action: 'cancel' }) });
    try {
      const pending = session.submit('Read the opening.');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(requests).toBe(1);
      rules = { rules: [{ source: 'app', tool: 'doc.read', effect: 'deny', access: 'read', scope: { subtree: FRIEND } }] };
      clock.advance(1_000);
      const report = await pending;
      expect(report).toMatchObject({ status: 'failed', modelCalls: 1, tokens: { requests: 1 }, askBack: { code: 'needs_input' } });
      expect(report.askBack?.reason).toContain('read boundary');
      expect(requests).toBe(1);
      expect(meter.spend().modelCalls).toBe(1);
      expect(meter.spend().promptTokens).toBeGreaterThan(0);
      expect(meter.spend().costUsd).toBeGreaterThan(0);
    } finally {
      meter.dispose();
    }
  });
});
