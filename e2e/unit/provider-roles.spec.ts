import { expect, test } from '@playwright/test';

import { APP_KEYS, type AppDb } from '../../apps/desktop/src/app/app-db.js';
import { ProviderService } from '../../apps/desktop/src/app/providers.js';
import { applyPatch, DEFAULT_SETTINGS, normalizeSettings } from '../../apps/desktop/src/app/settings.js';

/**
 * The task-role routing (provider-gateway §6, ui-modules §5.2), run without a browser: an in-memory app database
 * stands in for IndexedDB, and a scripted fetch stands in for the endpoints. What is checked is the app's own
 * logic: the `provider.roles` record as settings keep it, and `resolveForRole`/`roleAllows` on the service, down
 * to a routed call landing in the ledger under its role.
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
    close(): void {},
  };
}

const ENDPOINT_A = 'https://127.0.0.1:5998/v1';
const ENDPOINT_B = 'https://127.0.0.1:5999/v1';

/** A fetch that answers each endpoint's three calls: the model list, the format probe, and a streamed reply. */
function scriptedFetch(): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.endsWith('/models')) {
      return Response.json({ data: [{ id: 'test-model' }] });
    }
    if (method === 'POST' && url.endsWith('/chat/completions')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { stream?: boolean };
      if (body.stream === false) return Response.json({ choices: [{ message: { role: 'assistant', content: '{"ok": true}' } }] });
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('not found', { status: 404 });
  };
}

test.describe('settings: the provider.roles record (ui-modules §5.2)', () => {
  test('a record written before roles existed stays without one, and every role follows', () => {
    const loaded = normalizeSettings({ provider: { activeProfileId: 'p_1' } });
    expect(loaded.provider.activeProfileId).toBe('p_1');
    expect('roles' in loaded.provider).toBe(false);
    expect(normalizeSettings(undefined).provider.roles).toBeUndefined();
  });

  test('a stored routing keeps its entries and drops what it does not name or know', () => {
    const loaded = normalizeSettings({
      provider: {
        roles: {
          chat: { profileId: 'p_a', model: 'm-a', thinking: 'low' },
          drafting: 'follow',
          background: { profileId: 'p_b' },
          other: { profileId: 'p_x' },
        },
      },
    });
    expect(loaded.provider.roles).toEqual({
      chat: { profileId: 'p_a', model: 'm-a', thinking: 'low' },
      drafting: 'follow',
      background: { profileId: 'p_b' },
    });
  });

  test('a malformed entry is dropped, follow on chat is dropped, and an empty record is absent', () => {
    const loaded = normalizeSettings({
      provider: {
        roles: {
          chat: 'follow',
          drafting: { profileId: 7 },
          background: 'perhaps',
        },
      },
    });
    expect(loaded.provider.roles).toBeUndefined();
    // A bad sub-field is dropped but a good one is kept, and an unknown profile id is tolerated as-is.
    const partial = normalizeSettings({ provider: { roles: { drafting: { profileId: 'gone', thinking: 'loud' } } } });
    expect(partial.provider.roles).toEqual({ drafting: { profileId: 'gone' } });
    // Extra high is a level a stored role may carry.
    const extra = normalizeSettings({ provider: { roles: { chat: { profileId: 'p_a', thinking: 'xhigh' } } } });
    expect(extra.provider.roles).toEqual({ chat: { profileId: 'p_a', thinking: 'xhigh' } });
  });

  test('a patch writes the routing, a role set back to follow is kept, and null clears the record', () => {
    const set = applyPatch(DEFAULT_SETTINGS, {
      provider: { roles: { chat: { profileId: 'p_a' }, drafting: 'follow' } },
    });
    expect(set.provider.roles).toEqual({ chat: { profileId: 'p_a' }, drafting: 'follow' });

    const again = applyPatch(set, { provider: { roles: { drafting: { profileId: 'p_b' } } } });
    expect(again.provider.roles).toEqual({ drafting: { profileId: 'p_b' } });

    const cleared = applyPatch(again, { provider: { roles: null } });
    expect('roles' in cleared.provider).toBe(false);
  });
});

test.describe('resolveForRole (provider-gateway §6)', () => {
  test('with no routing, every role resolves to the active profile', async () => {
    const { service } = await ProviderService.open({ db: memoryDb(), vault: null, fetch: scriptedFetch() });
    const demo = service.active()!;
    expect(service.resolveForRole('chat')).toMatchObject({ profile: { id: demo.id }, model: demo.defaultModel });
    expect(service.resolveForRole('drafting')?.profile.id).toBe(demo.id);
    expect(service.resolveForRole('background')?.profile.id).toBe(demo.id);
    expect(service.roleAllows('chat', demo.id)).toBe(true);
    expect(service.roleAllows('drafting', 'prv_0000000000')).toBe(false);
  });

  test('a role pinned to a profile resolves to it, model and thinking included; a following role goes through chat', async () => {
    const { service } = await ProviderService.open({ db: memoryDb(), vault: null, fetch: scriptedFetch() });
    const demo = service.active()!;
    const chat = (await service.addProfile({ name: 'Chat', kind: 'endpoint', baseUrl: ENDPOINT_A, defaultModel: 'chat-model' })).view;
    const drafts = (await service.addProfile({ name: 'Drafts', kind: 'endpoint', baseUrl: ENDPOINT_B, defaultModel: 'draft-model' })).view;

    service.roleSettings = {
      chat: { profileId: chat.id, model: 'chat-model-2', thinking: 'low' },
      drafting: 'follow',
      background: { profileId: drafts.id },
    };

    expect(service.resolveForRole('chat')).toMatchObject({ profile: { id: chat.id }, model: 'chat-model-2', thinking: 'low' });
    // 'follow' and absent both read as chat's answer.
    expect(service.resolveForRole('drafting')).toMatchObject({ profile: { id: chat.id }, model: 'chat-model-2' });
    expect(service.resolveForRole('background')).toMatchObject({ profile: { id: drafts.id }, model: 'draft-model' });
    expect(service.roleAllows('background', drafts.id)).toBe(true);
    expect(service.roleAllows('background', chat.id)).toBe(false);
    expect(service.roleAllows('chat', demo.id)).toBe(false);
  });

  test('switching the active profile ripples to every role that follows, and a deleted target falls back to following', async () => {
    const { service } = await ProviderService.open({ db: memoryDb(), vault: null, fetch: scriptedFetch() });
    const demo = service.active()!;
    const next = (await service.addProfile({ name: 'Local', kind: 'endpoint', baseUrl: ENDPOINT_A, defaultModel: 'test-model' })).view;

    service.roleSettings = { drafting: 'follow' };
    await service.activate(next.id);
    expect(service.resolveForRole('chat')?.profile.id).toBe(next.id);
    expect(service.resolveForRole('drafting')?.profile.id).toBe(next.id);
    expect(service.roleAllows('chat', next.id)).toBe(true);
    expect(service.roleAllows('chat', demo.id)).toBe(false);

    // A role pinned to a profile that is then removed follows again — the stale id is tolerated, not failed on.
    service.roleSettings = { drafting: { profileId: next.id } };
    await service.remove(next.id);
    expect(service.resolveForRole('drafting')?.profile.id).toBe(service.active()!.id);
  });

  test('the routing stored in the settings record is the routing the service opens with', async () => {
    const db = memoryDb();
    const first = await ProviderService.open({ db, vault: null, fetch: scriptedFetch() });
    const saved = (await first.service.addProfile({ name: 'Local', kind: 'endpoint', baseUrl: ENDPOINT_A, defaultModel: 'test-model' })).view;
    await db.put(APP_KEYS.settings, { provider: { roles: { drafting: { profileId: saved.id, model: 'd-model' } } } });

    const second = await ProviderService.open({ db, vault: null, fetch: scriptedFetch() });
    expect(second.service.roleSettings).toEqual({ drafting: { profileId: saved.id, model: 'd-model' } });
    expect(second.service.resolveForRole('drafting')?.profile.id).toBe(saved.id);
  });
});

test.describe('a call under a role (provider-gateway §6)', () => {
  test('a drafting call sends through the role’s own profile and lands in the ledger under "drafting"', async () => {
    const { service } = await ProviderService.open({ db: memoryDb(), vault: null, fetch: scriptedFetch() });
    const endpoint = (await service.addProfile({ name: 'Drafts', kind: 'endpoint', baseUrl: ENDPOINT_B, defaultModel: 'draft-model' })).view;
    // The demo stays active; drafting is pinned to the endpoint.
    service.roleSettings = { drafting: { profileId: endpoint.id, model: 'draft-model-2' } };

    await service.gateway.completeOnce({ messages: [{ role: 'user', content: 'draft it' }], role: 'drafting' });

    const row = service.ledger.dayRows().find((entry) => entry.role === 'drafting');
    expect(row).toMatchObject({ profileId: endpoint.id, model: 'draft-model-2', requests: 1 });
  });

  test('a chat call with no routing resolves to the active profile, and the row says "chat"', async () => {
    const { service } = await ProviderService.open({ db: memoryDb(), vault: null, fetch: scriptedFetch() });
    const endpoint = (await service.addProfile({ name: 'Local', kind: 'endpoint', baseUrl: ENDPOINT_A, defaultModel: 'test-model' })).view;
    await service.activate(endpoint.id);

    await service.gateway.completeOnce({ messages: [{ role: 'user', content: 'hi' }], role: 'chat' });

    // The row holds the save-time probe and the chat call together, under the resolved profile and the 'chat' role.
    const row = service.ledger.dayRows().find((entry) => entry.role === 'chat' && entry.model === 'test-model');
    expect(row).toMatchObject({ profileId: endpoint.id, requests: 2 });
  });
});
