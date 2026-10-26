import { expect, test } from '@playwright/test';

import { APP_KEYS, type AppDb } from '../../apps/desktop/src/app/app-db.js';
import { DEMO_PROFILE_NAME, ProviderService } from '../../apps/desktop/src/app/providers.js';
import { createManualClock } from '../../packages/gateway/src/index.js';

/**
 * The provider services (provider-gateway §2, §5–§7; ui-modules §5.2), run without a browser: an in-memory app database
 * stands in for IndexedDB, and a scripted fetch stands in for the endpoint. What is checked is the app's own logic: the
 * probes and their trial activation, the restore that keeps a profile's id, and the usage and log it keeps across a reload.
 */

/** The app database's contract, held in a Map. Values are copied, as IndexedDB's structured clone copies them. */
function memoryDb(): AppDb & { rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>();
  return {
    rows,
    async get<T>(key: string): Promise<T | undefined> {
      return rows.has(key) ? (structuredClone(rows.get(key)) as T) : undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      rows.set(key, structuredClone(value));
    },
    async list<T>(prefix: string) {
      return [...rows.entries()].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, value]) => ({ key, value: structuredClone(value) as T }));
    },
    async delete(key: string): Promise<void> {
      rows.delete(key);
    },
    close(): void {},
  };
}

const ENDPOINT = 'https://127.0.0.1:5999/v1';

/** A fetch that answers the endpoint's three calls: the model list, the format probe, and a streamed reply. */
function scriptedFetch(options: { failModels?: boolean } = {}): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.endsWith('/models')) {
      if (options.failModels === true) return new Response('upstream broke', { status: 500 });
      return Response.json({ data: [{ id: 'test-model' }, { id: 'other-model' }] });
    }
    if (method === 'POST' && url.endsWith('/chat/completions')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { stream?: boolean };
      if (body.stream === false) return Response.json({ choices: [{ message: { role: 'assistant', content: '{"ok": true}' } }] });
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('not found', { status: 404 });
  };
}

test('the first run has one profile: the demo, with no key, and it is active', async () => {
  const db = memoryDb();
  const { service, notices } = await ProviderService.open({ db, vault: null, fetch: scriptedFetch() });

  expect(notices).toEqual([]);
  const profiles = service.list();
  expect(profiles).toHaveLength(1);
  expect(profiles[0]).toMatchObject({ name: DEMO_PROFILE_NAME, kind: 'mock', isActive: true, hasKey: false });
  expect(service.active()?.id).toBe(profiles[0]?.id);
  // What is stored is the profile record, with no key on it.
  expect(JSON.stringify(db.rows.get(APP_KEYS.profiles))).not.toContain('apiKey');
});

test('saving an endpoint lists its models, and the trial leaves the active profile as it was', async () => {
  const { service } = await ProviderService.open({ db: memoryDb(), vault: null, fetch: scriptedFetch() });
  const demo = service.active();

  const saved = await service.addProfile({ name: 'Local', kind: 'endpoint', baseUrl: ENDPOINT, defaultModel: 'test-model' });

  expect(saved.probeError).toBeUndefined();
  expect(saved.models?.map((model) => model.id)).toEqual(['test-model', 'other-model']);
  expect(service.active()?.id).toBe(demo?.id);
  expect(service.get(saved.view.id)?.isActive).toBe(false);
});

test('a probe that fails keeps the profile, names the failure, and changes nothing else', async () => {
  const { service } = await ProviderService.open({ db: memoryDb(), vault: null, fetch: scriptedFetch({ failModels: true }) });
  const demo = service.active();

  const saved = await service.addProfile({ name: 'Broken', kind: 'endpoint', baseUrl: ENDPOINT, defaultModel: 'test-model' });

  expect(saved.models).toBeUndefined();
  expect(saved.probeError).toContain('the profile was saved but is not verified');
  expect(service.get(saved.view.id)).toBeDefined();
  expect(service.active()?.id).toBe(demo?.id);
});

test('a model list the browser will not let the page read is reported as that, not as a connection or base URL problem', async () => {
  // The browser rejects the model-list GET and answers nothing else (chat is a different request, which this test never makes).
  const clock = createManualClock();
  const rejecting = async (): Promise<Response> => {
    throw new TypeError('Failed to fetch');
  };
  const { service } = await ProviderService.open({ db: memoryDb(), vault: null, fetch: rejecting, clock });
  const demo = service.active();

  let outcome: Awaited<ReturnType<typeof service.addProfile>> | undefined;
  const saving = service.addProfile({ name: 'Claude', kind: 'endpoint', preset: 'anthropic', apiKey: 'sk-ant-placeholder-0000000000', defaultModel: 'claude-sonnet-5-5' }).then((result) => {
    outcome = result;
  });
  for (let turn = 0; turn < 20 && outcome === undefined; turn++) {
    await new Promise((resolve) => setImmediate(resolve));
    clock.advance(5_000);
  }
  await saving;

  // The profile is saved and unverified, and the sentence is true of what happened: the list was not read, chat is untested.
  expect(outcome?.models).toBeUndefined();
  expect(outcome?.view.preset).toBe('anthropic');
  expect(outcome?.probeError).toContain('the profile was saved but is not verified');
  expect(outcome?.probeError).toContain('did not let this page read the model list from api.anthropic.com');
  expect(outcome?.probeError).toContain('Chat may still work');
  expect(outcome?.probeError).not.toContain('Could not reach');
  expect(outcome?.probeError).not.toContain('base URL');
  expect(service.active()?.id).toBe(demo?.id);
});

test('activating an endpoint runs the response-format probe, and the answer is kept on the profile', async () => {
  const { service } = await ProviderService.open({ db: memoryDb(), vault: null, fetch: scriptedFetch() });
  const saved = await service.addProfile({ name: 'Local', kind: 'endpoint', baseUrl: ENDPOINT, defaultModel: 'test-model' });

  const outcome = await service.activate(saved.view.id);

  expect(outcome.note).toBe('This endpoint accepts structured output.');
  expect(service.get(saved.view.id)?.responseFormat?.supportsJsonObject).toBe(true);
  expect(service.active()?.id).toBe(saved.view.id);
  // The probe is in the request log, and its usage is in the day totals.
  expect(service.requests.entries().some((entry) => entry.url.endsWith('/chat/completions') && entry.outcome === 'ok')).toBe(true);
  expect(service.ledger.dayRows().some((row) => row.profileId === saved.view.id)).toBe(true);
});

test('saving an endpoint probes its response format too, so the first request after a save knows the answer (provider-gateway §5)', async () => {
  const { service } = await ProviderService.open({ db: memoryDb(), vault: null, fetch: scriptedFetch() });
  const before = service.active()?.id;
  const saved = await service.addProfile({ name: 'Local', kind: 'endpoint', baseUrl: ENDPOINT, defaultModel: 'test-model' });

  // No activation: the save alone has recorded the answer on the profile, and left the active profile as it was.
  expect(service.get(saved.view.id)?.responseFormat?.supportsJsonObject).toBe(true);
  expect(service.active()?.id).toBe(before);
  expect(service.requests.entries().some((entry) => entry.url.endsWith('/chat/completions') && entry.outcome === 'ok')).toBe(true);
});

test('a reload restores the profiles under the same ids, the active one, its probe, the usage and the request log', async () => {
  const db = memoryDb();
  const first = await ProviderService.open({ db, vault: null, fetch: scriptedFetch() });
  const saved = await first.service.addProfile({ name: 'Local', kind: 'endpoint', baseUrl: ENDPOINT, defaultModel: 'test-model' });
  await first.service.activate(saved.view.id);
  await first.service.persist();
  const ids = first.service.list().map((profile) => profile.id);
  const usage = first.service.ledger.dayRows();
  const requests = first.service.requests.entries();

  const second = await ProviderService.open({ db, vault: null, fetch: scriptedFetch() });

  expect(second.notices).toEqual([]);
  expect(second.service.list().map((profile) => profile.id)).toEqual(ids);
  expect(second.service.active()?.id).toBe(saved.view.id);
  expect(second.service.get(saved.view.id)?.responseFormat?.supportsJsonObject).toBe(true);
  expect(second.service.ledger.dayRows()).toEqual(usage);
  expect(second.service.requests.entries()).toEqual(requests);
});

test('a key that is no longer in the vault is named, and its profile is not restored with a broken key', async () => {
  const db = memoryDb();
  const remote = 'https://api.example.test/v1';
  const first = await ProviderService.open({ db, vault: null, fetch: scriptedFetch() });
  await first.service.addProfile({ name: 'Remote', kind: 'endpoint', baseUrl: remote, apiKey: 'test-key-1', defaultModel: 'test-model' });
  await first.service.persist();

  // A fresh vault has none of the keys the first one sealed, which is what a cleared site-data store looks like.
  const second = await ProviderService.open({ db, vault: null, fetch: scriptedFetch() });

  expect(second.notices.some((notice) => notice.includes('“Remote” is no longer in this browser'))).toBe(true);
  expect(second.service.list().map((profile) => profile.name)).not.toContain('Remote');
  expect(second.service.active()?.name).toBe(DEMO_PROFILE_NAME);
});

test('removing the active endpoint makes the demo active again, and removing the last profile makes the demo', async () => {
  const { service } = await ProviderService.open({ db: memoryDb(), vault: null, fetch: scriptedFetch() });
  const saved = await service.addProfile({ name: 'Local', kind: 'endpoint', baseUrl: ENDPOINT, defaultModel: 'test-model' });
  await service.activate(saved.view.id);

  await service.remove(saved.view.id);
  expect(service.active()?.name).toBe(DEMO_PROFILE_NAME);

  const demo = service.active();
  await service.remove(demo!.id);
  expect(service.list()).toHaveLength(1);
  expect(service.active()?.name).toBe(DEMO_PROFILE_NAME);
});

test('the demo profile is found by its kind, made again when the writer has removed it, and never made active by a demo run', async () => {
  const { service } = await ProviderService.open({ db: memoryDb(), vault: null, fetch: scriptedFetch() });
  const demo = await service.demoProfile();
  expect(demo).toMatchObject({ name: DEMO_PROFILE_NAME, kind: 'mock' });
  expect(service.list()).toHaveLength(1);

  // An endpoint is the active one, and the demo is removed: a demo run makes the demo again, and leaves the endpoint active.
  const saved = await service.addProfile({ name: 'Local', kind: 'endpoint', baseUrl: ENDPOINT, defaultModel: 'test-model' });
  await service.activate(saved.view.id);
  await service.remove(demo.id);
  expect(service.list().map((profile) => profile.kind)).toEqual(['endpoint']);

  const again = await service.demoProfile();
  expect(again).toMatchObject({ name: DEMO_PROFILE_NAME, kind: 'mock' });
  expect(service.active()?.id).toBe(saved.view.id);
  expect(await service.demoProfile()).toMatchObject({ id: again.id });
});
