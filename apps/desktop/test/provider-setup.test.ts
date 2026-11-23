import { beforeAll, describe, expect, it } from 'vitest';
import { presetFor } from '@caotang/gateway';
import { ProviderService } from '../src/app/providers.js';
import { SetupError } from '../src/app/provider-setup.js';
import { COLLAPSED_MODEL_COUNT, setupFailureText, visibleModels } from '../src/app/provider-setup-model.js';
import { APP_KEYS, type AppDb } from '../src/app/app-db.js';
import { activateEnglish } from '../src/i18n/runtime.js';

beforeAll(() => activateEnglish());

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

const KEY = ('sk-proj-' + 'madeUpKeyForTestsOnly0123456789');

function listing(ids: readonly string[]): Response {
  return Response.json({ data: ids.map((id) => ({ id })) });
}

const completion = (): Response => Response.json({ choices: [{ message: { content: '{}' } }] });

describe('adding a provider: the key, then the models it can use', () => {
  it('lists only models that write text, marks one as recommended, and keeps the profile out of the list until a model is chosen', async () => {
    const db = memoryDb();
    const { service } = await ProviderService.open({
      db, vault: null,
      fetch: async (url, init) => (init?.method === 'POST' ? completion() : url.endsWith('/models') ? listing([presetFor('openai')!.defaultModel, 'text-embedding-3-large', 'whisper-1', 'unlisted-newer-model']) : new Response('', { status: 404 })),
    });
    const before = service.list().length;

    const found = await service.beginSetup({ preset: 'openai', apiKey: KEY });

    expect(found.source).toBe('live');
    expect(found.models.map((model) => model.id)).not.toContain('text-embedding-3-large');
    expect(found.models.map((model) => model.id)).not.toContain('whisper-1');
    expect(found.models.filter((model) => model.recommended)).toHaveLength(1);
    expect(found.models[0]).toMatchObject({ id: presetFor('openai')!.defaultModel, recommended: true });
    expect(service.list()).toHaveLength(before);
    await service.persist();
    expect(JSON.stringify(db.rows.get(APP_KEYS.profiles))).not.toContain(found.draftId);
  });

  it('saves the chosen model, shows the profile and makes it the active one', async () => {
    const db = memoryDb();
    const { service } = await ProviderService.open({
      db, vault: null,
      fetch: async (url, init) => (init?.method === 'POST' ? completion() : listing(['model-a', 'model-b'])),
    });
    const found = await service.beginSetup({ preset: 'openai', apiKey: KEY });
    const chosen = found.models.find((model) => !model.recommended)!.id;

    const { view } = await service.finishSetup(found.draftId, [chosen]);

    expect(view.defaultModel).toBe(chosen);
    // One model stores no list: the connection reads as that model alone (provider-gateway §2).
    expect(view.pickedModels).toBeUndefined();
    expect(view.isActive).toBe(true);
    expect(service.active()?.id).toBe(view.id);
    expect(service.list().map((profile) => profile.id)).toContain(view.id);
    expect(view.verification?.kind).toBe('verified');
    const stored = db.rows.get(APP_KEYS.profiles) as { id: string; defaultModel: string }[];
    expect(stored.find((profile) => profile.id === view.id)?.defaultModel).toBe(chosen);
    await expect(service.finishSetup(found.draftId, [chosen])).rejects.toThrow();
  });

  it('saves every model picked under one key, its first the default, so one key serves chat, drafting and background', async () => {
    const db = memoryDb();
    const { service } = await ProviderService.open({
      db, vault: null,
      fetch: async (url, init) => (init?.method === 'POST' ? completion() : listing(['model-a', 'model-b', 'model-c'])),
    });
    const found = await service.beginSetup({ preset: 'openai', apiKey: KEY });
    const [first, second, third] = found.models.map((model) => model.id);

    const { view } = await service.finishSetup(found.draftId, [second!, third!, first!]);

    expect(view.defaultModel).toBe(second);
    expect(view.pickedModels).toEqual([second, third, first]);
    const stored = db.rows.get(APP_KEYS.profiles) as { id: string; pickedModels?: readonly string[] }[];
    expect(stored.find((profile) => profile.id === view.id)?.pickedModels).toEqual([second, third, first]);
    // The key is stored once, for the connection, and the list carries no secret.
    expect(JSON.stringify(stored)).not.toContain(KEY);
  });

  it('refuses a finish with no model, and says so without saving', async () => {
    const { service } = await ProviderService.open({ db: null, vault: null, fetch: async (url, init) => (init?.method === 'POST' ? completion() : listing(['model-a'])) });
    const found = await service.beginSetup({ preset: 'openai', apiKey: KEY });
    await expect(service.finishSetup(found.draftId, [])).rejects.toThrow();
    expect(service.list().map((profile) => profile.id)).not.toContain(found.draftId);
  });

  it('leaves nothing behind when the key is refused, and says it is the key', async () => {
    const { service } = await ProviderService.open({ db: null, vault: null, fetch: async () => new Response('bad key', { status: 401 }) });
    const before = service.list().map((profile) => profile.id);

    const failure = await service.beginSetup({ preset: 'openai', apiKey: KEY }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SetupError);
    expect((failure as SetupError).failure).toMatchObject({ kind: 'probe', failure: { cause: 'auth' } });
    expect(service.list().map((profile) => profile.id)).toEqual(before);
    const text = setupFailureText('OpenAI', (failure as SetupError).failure);
    expect(text.aboutKey).toBe(true);
    expect(text.text).toContain('did not accept this key');
  });

  it('never shows the draft to a listener while it is checked or removed', async () => {
    const { service } = await ProviderService.open({ db: null, vault: null, fetch: async () => new Response('bad key', { status: 401 }) });
    const before = service.list().length;
    const seen: number[] = [];
    service.subscribeVerification(() => seen.push(service.list().length));

    await service.beginSetup({ preset: 'openai', apiKey: KEY }).catch(() => undefined);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((count) => count === before)).toBe(true);
    expect(service.list()).toHaveLength(before);
  });

  it('names a network failure as the network, not the key, and leaves nothing behind', async () => {
    const { service } = await ProviderService.open({ db: null, vault: null, fetch: async () => { throw new TypeError('Failed to fetch'); } });
    const before = service.list().length;

    const failure = await service.beginSetup({ preset: 'openai', apiKey: KEY }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SetupError);
    const text = setupFailureText('OpenAI', (failure as SetupError).failure);
    expect(text.aboutKey).toBe(false);
    expect(text.text).toContain('Could not reach');
    expect(service.list()).toHaveLength(before);
  }, 30_000);

  it('is an error, never an empty list, when the key lists no model that writes text', async () => {
    const { service } = await ProviderService.open({ db: null, vault: null, fetch: async (_url, init) => (init?.method === 'POST' ? completion() : listing(['text-embedding-3-large'])) });
    const before = service.list().length;

    const failure = await service.beginSetup({ preset: 'openai', apiKey: KEY }).catch((error: unknown) => error);

    expect((failure as SetupError).failure).toEqual({ kind: 'empty' });
    expect(service.list()).toHaveLength(before);
  });

  it('checks a provider that documents no model list with one real request, then offers its table', async () => {
    const calls: string[] = [];
    const { service } = await ProviderService.open({
      db: null, vault: null,
      fetch: async (url, init) => {
        calls.push(url);
        return init?.method === 'POST' ? completion() : new Response('', { status: 404 });
      },
    });

    const found = await service.beginSetup({ preset: 'cohere', apiKey: KEY });

    expect(found.source).toBe('table');
    expect(found.models.length).toBeGreaterThan(0);
    expect(found.models.some((model) => model.recommended)).toBe(true);
    expect(calls.some((url) => url.endsWith('/chat/completions'))).toBe(true);
  });

  it('refuses a key such a provider rejects on the one real request', async () => {
    const { service } = await ProviderService.open({
      db: null, vault: null,
      fetch: async (_url, init) => (init?.method === 'POST' ? new Response('no', { status: 401 }) : new Response('', { status: 404 })),
    });
    const before = service.list().length;

    const failure = await service.beginSetup({ preset: 'cohere', apiKey: KEY }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SetupError);
    expect(service.list()).toHaveLength(before);
  });

  it('discards a setup that is cancelled, and gives a second profile of one provider a number', async () => {
    const { service } = await ProviderService.open({ db: null, vault: null, fetch: async (_url, init) => (init?.method === 'POST' ? completion() : listing(['model-a'])) });
    const first = await service.beginSetup({ preset: 'openai', apiKey: KEY });
    await service.cancelSetup(first.draftId);
    await expect(service.finishSetup(first.draftId, 'model-a')).rejects.toThrow();
    expect(service.list().some((profile) => profile.id === first.draftId)).toBe(false);

    const one = await service.beginSetup({ preset: 'openai', apiKey: KEY });
    await service.finishSetup(one.draftId, 'model-a');
    expect(service.freeName('OpenAI')).toBe('OpenAI 2');
    const two = await service.beginSetup({ preset: 'openai', apiKey: KEY });
    expect(two.name).toBe('OpenAI 2');
    await service.cancelSetup(two.draftId);
  });

  it('lists a custom endpoint the same way, with the typed address and its headers', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const { service } = await ProviderService.open({
      db: null, vault: null,
      fetch: async (url, init) => {
        seen.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
        return init?.method === 'POST' ? completion() : listing(['local-model']);
      },
    });

    const found = await service.beginSetup({ preset: 'generic', apiKey: '', baseUrl: 'https://127.0.0.1:5999/v1', customHeaders: { 'x-team': 'made-up' } });

    expect(found.models.map((model) => model.id)).toEqual(['local-model']);
    expect(seen.some((call) => call.url === 'https://127.0.0.1:5999/v1/models' && call.headers['x-team'] === 'made-up')).toBe(true);
  });
});

describe('what the model list shows', () => {
  const models = Array.from({ length: COLLAPSED_MODEL_COUNT + 4 }, (_, index) => ({ id: 'model-' + String(index), recommended: index === 0 }));

  it('collapses a long list to the first few, shows all on request, and filters by what is typed', () => {
    expect(visibleModels(models, '', false)).toEqual({ shown: models.slice(0, COLLAPSED_MODEL_COUNT), hidden: 4 });
    expect(visibleModels(models, '', true).shown).toHaveLength(models.length);
    expect(visibleModels(models, 'MODEL-1', false).shown.map((model) => model.id)).toEqual(['model-1', 'model-10', 'model-11']);
    expect(visibleModels(models.slice(0, 3), '', false).hidden).toBe(0);
  });

  it('words every failure cause, and only the key causes point at the key', () => {
    const causes = ['auth', 'unreadable', 'network', 'timeout', 'rate-limit', 'models', 'provider', 'unknown'] as const;
    const aboutKey = causes.filter((cause) => setupFailureText('Acme', { kind: 'probe', failure: { cause } }).aboutKey);
    expect(aboutKey).toEqual(['auth', 'unreadable']);
    for (const cause of causes) expect(setupFailureText('Acme', { kind: 'probe', failure: { cause } }).text).not.toBe('');
    expect(setupFailureText('Acme', { kind: 'probe', failure: { cause: 'auth', providerReply: 'invalid x-api-key' } }).detail).toEqual({ label: 'Provider reply:', text: 'invalid x-api-key' });
    expect(setupFailureText('Acme', { kind: 'empty' }).canTypeModel).toBe(true);
  });
});

describe('the visible list never runs empty while a setup is open', () => {
  it('removing the last visible profile during a setup makes the demo again, and cancelling the setup keeps it', async () => {
    const db = memoryDb();
    const { service } = await ProviderService.open({
      db, vault: null,
      fetch: async (url, init) => (init?.method === 'POST' ? completion() : listing(['model-a'])),
    });
    const demo = service.list()[0]!;
    const found = await service.beginSetup({ preset: 'openai', apiKey: KEY });
    expect(service.list().map((profile) => profile.id)).toEqual([demo.id]);

    await service.remove(demo.id);

    const fallback = service.list();
    expect(fallback).toHaveLength(1);
    expect(fallback[0]!.kind).toBe('mock');
    expect(fallback[0]!.isActive).toBe(true);
    expect(service.active()?.kind).toBe('mock');

    await service.cancelSetup(found.draftId);

    expect(service.list().map((profile) => profile.id)).toEqual([fallback[0]!.id]);
    expect(service.active()?.id).toBe(fallback[0]!.id);
  });
});
