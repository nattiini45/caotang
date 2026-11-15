import { describe, expect, it } from 'vitest';
import { ProviderService } from '../src/app/providers.js';
import { APP_KEYS, type AppDb } from '../src/app/app-db.js';
import { createManualClock } from '@caotang/gateway';
import { createMockProvider } from '@caotang/gateway/mock';

function memoryDb(): AppDb & { rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>();
  return {
    rows,
    async get<T>(key: string) { return structuredClone(rows.get(key)) as T | undefined; },
    async put(key, value) { rows.set(key, structuredClone(value)); },
    async delete(key) { rows.delete(key); },
    async list<T>(prefix: string) { return [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) as T })); },
    close() {},
  };
}

const endpoint = { name: 'Endpoint', kind: 'endpoint' as const, baseUrl: 'https://127.0.0.1:5999/v1', defaultModel: 'test-model' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('profile probes never select a provider', () => {
  it('keeps following turns on the chosen profile while a model listing is pending', async () => {
    const started = deferred<void>();
    const response = deferred<Response>();
    const { service } = await ProviderService.open({
      db: null, vault: null,
      mock: createMockProvider(),
      fetch: async () => { started.resolve(); return response.promise; },
    });
    const chosen = service.active()!;
    const saving = service.addProfile({
      name: 'Under test', kind: 'endpoint', baseUrl: 'https://127.0.0.1:5999/v1', defaultModel: 'test-model',
    });
    await started.promise;
    const during = service.resolveForRole('chat');
    await service.gateway.completeOnce({ messages: [{ role: 'user', content: 'Hello.' }], role: 'chat', turnId: 'during-check' });
    expect(service.ledger.turnRows().find((row) => row.turnId === 'during-check')?.profileId).toBe(chosen.id);
    response.resolve(Response.json({ data: [{ id: 'test-model' }] }));
    await saving;
    expect(during?.profile.id).toBe(chosen.id);
    expect(service.active()?.id).toBe(chosen.id);
  });

  it('does not restore another overlapping probe target or undo an explicit choice', async () => {
    const started = [deferred<void>(), deferred<void>()];
    const responses = [deferred<Response>(), deferred<Response>()];
    const { service } = await ProviderService.open({
      db: null, vault: null,
      fetch: async (url, init) => {
        if (init?.method === 'POST') return Response.json({ choices: [{ message: { content: '{}' } }] });
        const index = url.includes(':5999') ? 0 : 1;
        started[index]!.resolve();
        return responses[index]!.promise;
      },
    });
    const chosen = service.active()!;
    const first = service.addProfile({ name: 'First', kind: 'endpoint', baseUrl: 'https://127.0.0.1:5999/v1', defaultModel: 'test-model' });
    await started[0]!.promise;
    const second = service.addProfile({ name: 'Second', kind: 'endpoint', baseUrl: 'https://127.0.0.1:6000/v1', defaultModel: 'test-model' });
    await started[1]!.promise;
    await service.activate(chosen.id);
    responses[0]!.resolve(Response.json({ data: [{ id: 'test-model' }] }));
    await first;
    responses[1]!.resolve(Response.json({ data: [{ id: 'test-model' }] }));
    await second;
    expect(service.active()?.id).toBe(chosen.id);
  });
});

describe('verification metadata', () => {
  it('does not save an in-flight attempt or let an old format check overwrite an edited profile', async () => {
    const started = deferred<void>();
    const response = deferred<Response>();
    const db = memoryDb();
    let formats = 0;
    const { service } = await ProviderService.open({ db, vault: null, fetch: async (_url, init) => {
      if (init?.method !== 'POST') return Response.json({ data: [{ id: 'test-model' }] });
      formats += 1;
      if (formats === 1) { started.resolve(); return response.promise; }
      return new Response('response_format is unsupported', { status: 400 });
    } });
    const chosen = service.active()!;
    const first = service.addProfile(endpoint);
    await started.promise;
    const id = service.list().find((profile) => profile.kind === 'endpoint')!.id;
    expect(service.resolveForRole('chat')?.profile.id).toBe(chosen.id);
    await service.persist();
    const persisted = db.rows.get(APP_KEYS.profiles) as { id: string; verification?: unknown }[];
    expect(persisted.find((profile) => profile.id === id)?.verification).toEqual({ kind: 'unknown' });
    await service.editProfile(id, { defaultModel: 'second-model' });
    response.resolve(Response.json({ choices: [{ message: { content: '{}' } }] }));
    await first;
    expect(service.get(id)?.responseFormat?.supportsJsonObject).toBe(false);
    expect(service.get(id)?.verification?.kind).toBe('verified');
    expect(service.active()?.id).toBe(chosen.id);
  });

  it('rechecks a failed profile when its unchanged form is saved again', async () => {
    let failing = true;
    const { service } = await ProviderService.open({ db: null, vault: null, fetch: async (_url, init) => {
      if (init?.method === 'POST') return Response.json({ choices: [{ message: { content: '{}' } }] });
      return failing ? new Response('unauthorized', { status: 401 }) : Response.json({ data: [] });
    } });
    const saved = await service.addProfile(endpoint);
    expect(saved.view.verification?.kind).toBe('failed');
    failing = false;
    const retried = await service.editProfile(saved.view.id, { name: endpoint.name });
    expect(retried.view.verification?.kind).toBe('verified');
    expect(retried.probeError).toBeUndefined();
  });

  it('keeps a failed model check across reload, but never saves the error payload', async () => {
    const db = memoryDb();
    const clock = createManualClock();
    const { service } = await ProviderService.open({ db, vault: null, clock, fetch: async () => new Response('no access', { status: 401 }) });
    const saved = await service.addProfile(endpoint);
    expect(saved.probeError).toBeDefined();
    expect(saved.probeFailure).toEqual({ cause: 'auth', providerReply: 'no access' });
    expect(saved.view.verification).toEqual({ kind: 'failed', checkedAt: clock.now() });
    const reopened = await ProviderService.open({ db, vault: null });
    expect(reopened.service.get(saved.view.id)?.verification).toEqual(saved.view.verification);
    expect(JSON.stringify(db.rows.get(APP_KEYS.profiles))).not.toContain('no access');
  });

  it('publishes checking and success, persists a refresh and preserves the format fallback', async () => {
    const db = memoryDb();
    const clock = createManualClock();
    const { service } = await ProviderService.open({ db, vault: null, clock, fetch: async (_url, init) => init?.method === 'POST'
      ? new Response('response_format is unsupported', { status: 400 })
      : Response.json({ data: [{ id: 'test-model' }] }) });
    const transitions: string[] = [];
    const unsubscribe = service.subscribeVerification(() => { transitions.push(service.list().find((profile) => profile.kind === 'endpoint')?.verification?.kind ?? 'unknown'); });
    const saved = await service.addProfile(endpoint);
    expect(transitions).toEqual(['checking', 'verified']);
    expect(saved.probeError).toBeUndefined();
    expect(saved.view.responseFormat?.supportsJsonObject).toBe(false);
    expect(saved.view.verification?.kind).toBe('verified');
    unsubscribe();
    clock.advance(100);
    await service.listModels(saved.view.id);
    const reopened = await ProviderService.open({ db, vault: null });
    expect(reopened.service.get(saved.view.id)?.verification).toEqual({ kind: 'verified', checkedAt: clock.now() });
  });

  it('reads legacy and interrupted profiles as unknown even with a cached format answer', async () => {
    const db = memoryDb();
    await db.put(APP_KEYS.profiles, [
      { id: 'prv_0000000000', ...endpoint, isActive: true, hasKey: false, responseFormat: { supportsJsonObject: true, probedAt: 10 } },
      { id: 'prv_1111111111', ...endpoint, isActive: false, hasKey: false, verification: { kind: 'checking', attempt: 9 } },
    ]);
    const { service } = await ProviderService.open({ db, vault: null });
    expect(service.list().map((profile) => profile.verification)).toEqual([{ kind: 'unknown' }, { kind: 'unknown' }]);
  });

  it('ignores an older check after an edit starts a newer one for the same profile', async () => {
    const started = deferred<void>();
    const response = deferred<Response>();
    const db = memoryDb();
    let calls = 0;
    const { service } = await ProviderService.open({ db, vault: null, fetch: async (_url, init) => {
      if (init?.method === 'POST') return Response.json({ choices: [{ message: { content: '{}' } }] });
      calls += 1;
      if (calls === 1) { started.resolve(); return response.promise; }
      return Response.json({ data: [{ id: 'second-model' }] });
    } });
    const first = service.addProfile(endpoint);
    await started.promise;
    const id = service.list().find((profile) => profile.kind === 'endpoint')!.id;
    const second = await service.editProfile(id, { defaultModel: 'second-model' });
    expect(second.view.verification?.kind).toBe('verified');
    response.resolve(new Response('rejected old check', { status: 401 }));
    await first;
    expect(service.get(id)?.verification?.kind).toBe('verified');
    expect(service.get(id)?.defaultModel).toBe('second-model');
  });
});

describe('profile request concurrency persistence', () => {
  it('round-trips explicit limits and applies kind defaults to older records', async () => {
    const db = memoryDb();
    await db.put(APP_KEYS.profiles, [
      { id: 'prv_0000000000', name: 'Legacy endpoint', kind: 'endpoint', baseUrl: endpoint.baseUrl, defaultModel: endpoint.defaultModel, hasKey: false, isActive: true },
      { id: 'prv_1111111111', name: 'Limited endpoint', kind: 'endpoint', baseUrl: endpoint.baseUrl, defaultModel: endpoint.defaultModel, maxConcurrentRequests: 6, hasKey: false, isActive: false },
      { id: 'prv_2222222222', name: 'Legacy mock', kind: 'mock', baseUrl: '', defaultModel: 'mock', hasKey: false, isActive: false },
    ]);

    const { service } = await ProviderService.open({ db, vault: null });
    expect(service.get('prv_0000000000')?.maxConcurrentRequests).toBe(3);
    expect(service.get('prv_1111111111')?.maxConcurrentRequests).toBe(6);
    expect(service.list().find((profile) => profile.kind === 'mock')?.maxConcurrentRequests).toBe(8);

    await service.persist();
    const stored = db.rows.get(APP_KEYS.profiles) as { id: string; maxConcurrentRequests?: number }[];
    expect(stored.find((profile) => profile.id === 'prv_0000000000')?.maxConcurrentRequests).toBe(3);
    expect(stored.find((profile) => profile.id === 'prv_1111111111')?.maxConcurrentRequests).toBe(6);

    const reopened = await ProviderService.open({ db, vault: null });
    expect(reopened.service.get('prv_0000000000')?.maxConcurrentRequests).toBe(3);
    expect(reopened.service.get('prv_1111111111')?.maxConcurrentRequests).toBe(6);
    expect(reopened.service.list().find((profile) => profile.kind === 'mock')?.maxConcurrentRequests).toBe(8);
  });
});
