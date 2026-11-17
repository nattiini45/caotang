import { expect, it, vi } from 'vitest';
import { createGateway, createKeyStore, createManualClock, createMemoryVaultPort, createProfileStore, type ChatChunk, type ChatRequest } from '@caotang/gateway';
import { createMockProvider, type MockScript } from '@caotang/gateway/mock';

import { createBudgetMeter } from '../../src/agent/budget.js';
import { GoalVerifierPersistenceError, runGoalVerifierCall, type GoalVerifierAdmission } from '../../src/agent/goal-verifier-call.js';

const request: ChatRequest = {
  messages: [{ role: 'system', content: 'Independent verifier.' }, { role: 'user', content: 'Only the changed excerpts.' }],
  maxOutputTokens: 64,
};

async function fixture(respond: MockScript['respond']) {
  const keys = createKeyStore(createMemoryVaultPort());
  const profiles = createProfileStore({ keys });
  await profiles.create({ name: 'Verifier mock', kind: 'mock', isActive: true, maxOutputTokens: 64 });
  const gateway = createGateway({ profiles, keys, clock: createManualClock(0), mock: createMockProvider({ scripts: [{ match: () => true, respond }] }) });
  const meter = createBudgetMeter({ maxModelCalls: 3, maxTokens: 1000 }, { clock: createManualClock(0) });
  return { gateway, meter };
}

it('durably reserves the shared call before dispatch and settles its reported usage', async () => {
  const saved: GoalVerifierAdmission[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let sends = 0;
  const f = await fixture(async function* (sent): AsyncGenerator<ChatChunk> {
    sends += 1;
    expect(sent.role).toBe('background');
    expect(saved[0]?.phase).toBe('reserved');
    yield { delta: '{"pass":true,"reasons":[]}' };
    yield { finishReason: 'stop', usage: { promptTokens: 12, completionTokens: 8 } };
  });
  const pending = runGoalVerifierCall({ ...f, request, fence: () => undefined, save: async admission => {
    saved.push(admission);
    if (admission.phase === 'reserved') await held;
  } });
  await Promise.resolve();
  expect(sends).toBe(0);
  release();
  expect(await pending).toEqual({ kind: 'complete', content: '{"pass":true,"reasons":[]}' });
  expect(saved.map(entry => entry.phase)).toEqual(['reserved', 'settled']);
  expect(saved[0]?.spend.modelCalls).toBe(1);
  expect(f.meter.spend()).toMatchObject({ modelCalls: 1, promptTokens: 12, completionTokens: 8, estimatedTokens: 0 });
});

it('sends nothing when the durable reservation cannot be saved', async () => {
  let sends = 0;
  const f = await fixture(async function* (): AsyncGenerator<ChatChunk> { sends += 1; yield { delta: '{}' }; });
  await expect(runGoalVerifierCall({ ...f, request, fence: () => undefined, save: async () => { throw new Error('unavailable'); } })).rejects.toThrow('reservation could not be saved');
  expect(sends).toBe(0);
  expect(f.meter.spend().modelCalls).toBe(0);
});

it('uses the existing shared budget rather than resetting a verifier allowance', async () => {
  let sends = 0;
  const f = await fixture(async function* (): AsyncGenerator<ChatChunk> { sends += 1; yield { delta: '{}' }; });
  const meter = createBudgetMeter({ maxModelCalls: 1 }, { clock: createManualClock(0) });
  const actor = meter.reserve({ promptTokens: 1, maxOutputTokens: 1 });
  if (!actor.ok) throw new Error('actor fixture reservation failed');
  meter.settle(actor.value, { promptTokens: 1, completionTokens: 1 });
  const saved: GoalVerifierAdmission[] = [];
  const result = await runGoalVerifierCall({ gateway: f.gateway, meter, request, fence: () => undefined, save: async admission => { saved.push(admission); } });
  expect(result).toEqual({ kind: 'budget', stop: { dimension: 'model-calls', limit: 1, spent: 1 } });
  expect(sends).toBe(0);
  expect(saved).toEqual([]);
});

it('rechecks the live boundary at dispatch and releases a call that was not sent', async () => {
  let sends = 0;
  const f = await fixture(async function* (): AsyncGenerator<ChatChunk> { sends += 1; yield { delta: '{}' }; });
  const saved: GoalVerifierAdmission[] = [];
  const result = await runGoalVerifierCall({ ...f, request, fence: () => { throw new Error('read policy changed'); }, save: async admission => { saved.push(admission); } });
  expect(result.kind).toBe('failed');
  expect(sends).toBe(0);
  expect(f.meter.spend().modelCalls).toBe(0);
  expect(saved.map(entry => entry.phase)).toEqual(['reserved', 'released']);
});

it('keeps an already-sent call charged when its settlement cannot be persisted', async () => {
  const f = await fixture(async function* (): AsyncGenerator<ChatChunk> { yield { delta: '{}' }; yield { finishReason: 'stop', usage: { promptTokens: 12, completionTokens: 8 } }; });
  await expect(runGoalVerifierCall({ ...f, request, fence: () => undefined, save: async admission => {
    if (admission.phase === 'settled') throw new Error('unavailable');
  } })).rejects.toThrow(GoalVerifierPersistenceError);
  expect(f.meter.spend()).toMatchObject({ modelCalls: 1, promptTokens: 12, completionTokens: 8 });
});

it('counts estimated reasoning usage without returning private reasoning as verdict text', async () => {
  const f = await fixture(async function* (): AsyncGenerator<ChatChunk> {
    yield { reasoningDelta: 'PRIVATE_VERIFIER_REASONING' };
    yield { delta: '{"pass":true,"reasons":[]}' };
    yield { finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0, source: 'estimate' } };
  });
  const result = await runGoalVerifierCall({ ...f, request, fence: () => undefined, save: async () => undefined });
  expect(result).toEqual({ kind: 'complete', content: '{"pass":true,"reasons":[]}' });
  expect(JSON.stringify(result)).not.toContain('PRIVATE_VERIFIER_REASONING');
  expect(f.meter.spend().estimatedTokens).toBeGreaterThan(0);
  expect(f.meter.spend().completionTokens).toBeGreaterThan(Math.ceil('{"pass":true,"reasons":[]}'.length / 4));
});

it('honours Stop after admission without sending or retaining a reserved call', async () => {
  const controller = new AbortController();
  let sends = 0;
  const f = await fixture(async function* (): AsyncGenerator<ChatChunk> { sends += 1; yield { delta: '{}' }; });
  const saved: GoalVerifierAdmission[] = [];
  const result = await runGoalVerifierCall({ ...f, request, signal: controller.signal, fence: () => undefined, save: async admission => {
    saved.push(admission);
    if (admission.phase === 'reserved') controller.abort();
  } });
  expect(result).toEqual({ kind: 'cancelled' });
  expect(sends).toBe(0);
  expect(f.meter.spend().modelCalls).toBe(0);
  expect(saved.map(entry => entry.phase)).toEqual(['reserved', 'released']);
});

it('conservatively settles a sent call interrupted before provider usage arrives', async () => {
  const controller = new AbortController();
  const f = await fixture(async function* (): AsyncGenerator<ChatChunk> {
    yield { delta: '{}' };
  });
  const stream = vi.spyOn(f.gateway, 'complete').mockImplementation(async function* (_asked, _signal, beforeSend): AsyncGenerator<ChatChunk> {
    beforeSend?.();
    yield { delta: '{"pass":' };
    controller.abort();
    throw new Error('stream stopped');
  });
  const result = await runGoalVerifierCall({ ...f, request, signal: controller.signal, fence: () => undefined, save: async () => undefined });
  stream.mockRestore();
  expect(result).toEqual({ kind: 'cancelled' });
  expect(f.meter.spend()).toMatchObject({ modelCalls: 1, completionTokens: 64 });
  expect(f.meter.spend().estimatedTokens).toBeGreaterThanOrEqual(64);
});

it('rejects actor messages and tool declarations before reserving or dispatching', async () => {
  let sends = 0;
  const f = await fixture(async function* (): AsyncGenerator<ChatChunk> { sends += 1; yield { delta: '{}' }; });
  for (const asked of [
    { ...request, messages: [...request.messages, { role: 'assistant' as const, content: 'actor conversation' }] },
    { ...request, tools: [] },
  ]) {
    await expect(runGoalVerifierCall({ ...f, request: asked, fence: () => undefined, save: async () => undefined })).rejects.toThrow('isolated system and user request');
  }
  expect(sends).toBe(0);
  expect(f.meter.spend().modelCalls).toBe(0);
});

it('keeps meter values finite when a provider returns invalid usage', async () => {
  const f = await fixture(async function* (): AsyncGenerator<ChatChunk> {
    yield { delta: '{"pass":true,"reasons":[]}' };
    yield { finishReason: 'stop', usage: { promptTokens: Number.NaN, completionTokens: Number.POSITIVE_INFINITY } };
  });
  expect((await runGoalVerifierCall({ ...f, request, fence: () => undefined, save: async () => undefined })).kind).toBe('complete');
  const spend = f.meter.spend();
  expect(Number.isFinite(spend.promptTokens)).toBe(true);
  expect(Number.isFinite(spend.completionTokens)).toBe(true);
  expect(spend.estimatedTokens).toBeGreaterThan(0);
});

it('ends on the shared active-time limit while durable admission is awaited', async () => {
  let sends = 0;
  const f = await fixture(async function* (): AsyncGenerator<ChatChunk> { sends += 1; yield { delta: '{}' }; });
  const clock = createManualClock(0);
  const meter = createBudgetMeter({ maxModelCalls: 3, maxActiveMs: 10 }, { clock });
  const saved: GoalVerifierAdmission[] = [];
  const result = await runGoalVerifierCall({ gateway: f.gateway, meter, request, fence: () => undefined, save: async admission => {
    saved.push(admission);
    if (admission.phase === 'reserved') clock.advance(10);
  } });
  expect(result).toMatchObject({ kind: 'budget', stop: { dimension: 'active-time', limit: 10 } });
  expect(sends).toBe(0);
  expect(meter.spend().modelCalls).toBe(0);
  expect(saved.map(entry => entry.phase)).toEqual(['reserved', 'released']);
  meter.dispose();
  expect(clock.pending).toBe(0);
});

it('rechecks the boundary inside the gateway before any provider request', async () => {
  let sends = 0;
  let fences = 0;
  const saved: GoalVerifierAdmission[] = [];
  const f = await fixture(async function* (): AsyncGenerator<ChatChunk> { sends += 1; yield { delta: '{}' }; });
  const result = await runGoalVerifierCall({ ...f, request, fence: () => {
    fences += 1;
    if (fences === 2) throw new Error('read boundary changed');
  }, save: async admission => { saved.push(admission); } });
  expect(result.kind).toBe('failed');
  expect(fences).toBe(2);
  expect(sends).toBe(0);
  expect(f.meter.spend().modelCalls).toBe(0);
  expect(saved.map(entry => entry.phase)).toEqual(['reserved', 'released']);
});

it.each(['x', '😀'])('bounds the response buffer while streaming %s and closes the paid request', async text => {
  let closed = false;
  let continued = false;
  const saved: GoalVerifierAdmission[] = [];
  const f = await fixture(async function* (): AsyncGenerator<ChatChunk> {
    try {
      yield { delta: text.repeat(10000) };
      yield { delta: text.repeat(10000) };
      yield { delta: text };
      continued = true;
      yield { finishReason: 'stop' };
    } finally {
      closed = true;
    }
  });
  const result = await runGoalVerifierCall({ ...f, request, fence: () => undefined, save: async admission => { saved.push(admission); } });
  expect(result).toEqual({ kind: 'failed', reason: 'The verifier reply exceeded its size limit, so no verdict was used.' });
  expect(closed).toBe(true);
  expect(continued).toBe(false);
  expect(f.meter.spend()).toMatchObject({ modelCalls: 1, estimatedTokens: expect.any(Number) });
  expect(f.meter.spend().estimatedTokens).toBeGreaterThan(0);
  expect(saved.map(entry => entry.phase)).toEqual(['reserved', 'settled']);
});
