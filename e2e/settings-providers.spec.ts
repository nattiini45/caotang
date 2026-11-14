import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type * as UiAgentModule from '../apps/desktop/test/ui-agent-fixture.js';
import { sumUsage, type DayUsageRow } from '../packages/gateway/src/index.js';

import { endpointRoute, FAKE_ENDPOINT, fakeEndpoint, planThenAnswer, useFakeEndpoint } from './endpoint.js';
import { bodyOf, createProject, idOf, savedMessage } from './support.js';

/**
 * The provider settings the preset registry drives (provider-gateway §2, §9; ui-modules §5.2): the preset picker and its
 * per-preset fields, the honest CORS label on presets a browser cannot call, the key hints a preset's `keyOptional`
 * decides, the sealed custom headers a generic endpoint keeps, the capability line under the model field, and the task
 * roles that pin a profile, model and thinking level per kind of call. Named presets answer through Playwright routes —
 * no request leaves the page.
 */

const FRIEND_PROSE = 'The ferry came in on the evening tide, low in the water and slow to answer the rope.';
const uiAgentUrl = `/@fs/${fileURLToPath(new URL('../apps/desktop/test/ui-agent-fixture.ts', import.meta.url)).replaceAll('\\', '/').replace(/^\/+/, '')}`;
type UiAgent = typeof UiAgentModule;

async function openSettings(page: Page): Promise<ReturnType<Page['getByTestId']>> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  return page.getByTestId('settings');
}

/** The profile records as the app's IndexedDB persists them (the `kv` store's 'profiles' value). */
async function storedProfiles(page: Page): Promise<Record<string, unknown>[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('caotang-app', 4);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const value = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction('kv', 'readonly');
      const req = tx.objectStore('kv').get('profiles') as IDBRequest<{ key: string; value: unknown } | undefined>;
      req.onsuccess = () => resolve(req.result?.value);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return (value ?? []) as Record<string, unknown>[];
  });
}

/**
 * Writes extra profile records into the app's IndexedDB, exactly as a restore reads them back — a profile saved
 * before request parameters (or written by the SDK) holds the temperature column and no params flag. Run before
 * the page reloads, so the app's own restore path reads them.
 */
async function seedProfiles(page: Page, records: readonly Record<string, unknown>[]): Promise<void> {
  await expect(page.getByTestId('open-settings')).toBeAttached();
  // The app writes its first-run demo profile asynchronously after the page loads; wait for that write to land
  // before seeding behind its back, or the app's own persist lands last and overwrites the seeded records.
  await expect.poll(async () => (await storedProfiles(page)).some((profile) => profile['name'] === 'Demo (no key)')).toBe(true);
  await page.evaluate(async (extra) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('caotang-app', 4);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const stored = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction('kv', 'readonly');
      const req = tx.objectStore('kv').get('profiles') as IDBRequest<{ key: string; value: unknown } | undefined>;
      req.onsuccess = () => resolve(req.result?.value);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ key: 'profiles', value: [...((stored as unknown[] | undefined) ?? []), ...extra] });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, records);
}

async function seedUsage(page: Page, rows: readonly DayUsageRow[], price?: { prompt: number; completion: number }): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  await expect.poll(async () => (await storedProfiles(page)).some((profile) => profile['kind'] === 'mock')).toBe(true);
  await page.evaluate(async ({ rows, price }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('caotang-app');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const profiles = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const request = db.transaction('kv').objectStore('kv').get('profiles') as IDBRequest<{ value: Record<string, unknown>[] }>;
      request.onsuccess = () => resolve(request.result.value);
      request.onerror = () => reject(request.error);
    });
    const profileId = profiles.find((profile) => profile['kind'] === 'mock')?.['id'];
    if (typeof profileId !== 'string') throw new Error('The demo fixture has no profile.');
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ key: 'usage', value: { version: 1, days: rows.map((row) => ({ ...row, profileId })), turns: [] } });
      if (price !== undefined) tx.objectStore('kv').put({ key: 'profiles', value: profiles.map((profile) => profile['id'] === profileId ? { ...profile, pricePer1k: price } : profile) });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { rows, price });
  await page.reload();
}

function usageDay(overrides: Partial<DayUsageRow> = {}): DayUsageRow {
  return { ...sumUsage([]), version: 1, date: '2026-11-10', profileId: 'fixture', model: '@SUM(A1)', role: 'chat', requests: 1, promptTokens: 1000, completionTokens: 200, cachedPromptTokens: 400, reasoningTokens: 50, costUsd: 0.042, ...overrides };
}

/**
 * Seals a key into the app's own key-vault database, the way provider-gateway §7 stores one: AES-GCM under the
 * wrapping key in 'wrap', the v2 envelope in 'entries' with the profile id bound as additional data. A profile
 * seeded with `hasKey` on a preset that requires one restores only when this entry exists — the same pair a
 * real save writes, never a plaintext key.
 */
async function seedKey(page: Page, profileId: string, apiKey: string): Promise<void> {
  await page.evaluate(async ({ profileId, apiKey }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('caotang-provider-keys', 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('wrap')) d.createObjectStore('wrap', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('entries')) d.createObjectStore('entries', { keyPath: 'profileId' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const fresh = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const wrap = await new Promise<CryptoKey>((resolve, reject) => {
      const tx = db.transaction('wrap', 'readwrite');
      const store = tx.objectStore('wrap');
      const get = store.get('wrapping-key');
      let stored = fresh;
      get.onsuccess = () => {
        const existing = (get.result as { key?: CryptoKey } | undefined)?.key;
        if (existing !== undefined) stored = existing;
        else store.put({ id: 'wrapping-key', key: fresh });
      };
      tx.oncomplete = () => resolve(stored);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`caotang:provider-key:${profileId}`) },
      wrap,
      new TextEncoder().encode(JSON.stringify({ v: 2, apiKey })),
    );
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('entries', 'readwrite');
      tx.objectStore('entries').put({ profileId, iv, ciphertext: new Uint8Array(sealed) });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { profileId, apiKey });
}

test('the preset picker lists the registry, enables every preset the sweep found reachable, and fits the form to the pick', async ({
  page,
}) => {
  const settings = await openSettings(page);
  await settings.getByRole('button', { name: 'Add a provider' }).click();
  const form = settings.getByRole('form', { name: 'New provider' });

  const picker = form.getByRole('combobox', { name: 'Provider' });
  // The picker's own names. A preset whose chat route the sweep found a browser cannot reach is flagged 'blocked' and lists here
  // greyed with "Desktop app or hosted only" (OpenCode answers the model list's preflight but refuses chat's); the rest are enabled, Z.ai among them since its chat route answered.
  await expect(picker.getByRole('option', { name: 'OpenAI-compatible endpoint' })).toBeAttached();
  await expect(picker.getByRole('option', { name: 'Anthropic (Claude)' })).toBeEnabled();
  await expect(picker.getByRole('option', { name: 'Z.ai (GLM)' })).toBeEnabled();
  await expect(picker.getByRole('option', { name: 'OpenCode — Desktop app or hosted only' })).toHaveAttribute('disabled', '');

  // The generic pick: the endpoint is typed, the key is optional, the CORS answer is the endpoint's own, and sealed
  // custom headers are offered.
  await expect(picker).toHaveValue('generic');
  await expect(form.getByLabel('Endpoint (the base URL, ending in /v1)')).toBeVisible();
  await expect(form.getByLabel('API key (optional — this provider answers without one)')).toBeVisible();
  await expect(form.getByText('Reachability depends on the endpoint’s own CORS policy.')).toBeVisible();
  await expect(form.getByRole('group', { name: 'Extra request headers (optional)' })).toBeVisible();

  // A named preset: no endpoint to type — the address is the preset's own, shown read-only — and the key is required.
  await picker.selectOption('anthropic');
  await expect(form.getByLabel('Endpoint (the base URL, ending in /v1)')).toHaveCount(0);
  await expect(form.getByText('api.anthropic.com/v1')).toBeVisible();
  await expect(form.getByLabel('API key (required)')).toBeVisible();
  await expect(form.getByText(/adapter sends anthropic-dangerous-direct-browser-access/)).toBeVisible();
  await expect(form.getByRole('group', { name: 'Extra request headers (optional)' })).toHaveCount(0);
  // The default model's capability row is read aloud under the field: the published window, native tools, image input, and its thinking levels.
  await expect(form.getByText('1,000,000-token window · native tools · image input · thinking: low / medium / high / xhigh / max')).toBeVisible();

  // A workspace-templated preset: the fields it declares build the endpoint, shown as they are typed.
  await picker.selectOption('alibaba');
  await expect(form.getByLabel('Workspace ID')).toBeVisible();
  await expect(form.getByLabel('Region')).toHaveValue('ap-southeast-1');
  await form.getByLabel('Workspace ID').fill('myws');
  await expect(form.getByText('https://myws.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1')).toBeVisible();

  // A region-picker preset, and one with no models route whose catalogue is the table's own.
  await picker.selectOption('tencent-hunyuan');
  await expect(form.getByLabel('Site')).toBeVisible();
  await picker.selectOption('cohere');
  await expect(form.getByText('This provider documents no model list — its table below is the catalogue.')).toBeVisible();
});

test('a workspace-templated preset saves against the endpoint its fields built, and the probe asks that host', async ({
  page,
}) => {
  await endpointRoute(page, 'https://myws.ap-southeast-1.maas.aliyuncs.com', planThenAnswer({ reply: 'unused' }));
  const settings = await openSettings(page);
  await settings.getByRole('button', { name: 'Add a provider' }).click();
  const form = settings.getByRole('form', { name: 'New provider' });

  await form.getByRole('combobox', { name: 'Provider' }).selectOption('alibaba');
  await form.getByLabel('Name').fill('Qwen studio');
  await form.getByLabel('Workspace ID').fill('myws');
  await form.getByLabel('API key (required)').fill('test-key');
  await form.getByRole('button', { name: 'Save profile' }).click();

  await expect(settings.getByText(savedMessage('Qwen studio'))).toBeVisible();
  await expect(settings.getByRole('region', { name: 'Models listed by Qwen studio' })).toContainText('test-model');
  await expect(settings.locator('[data-profile="Qwen studio"]')).toContainText('Alibaba Cloud Model Studio (Qwen)');
  await expect(settings.locator('[data-profile="Qwen studio"]')).toContainText('maas.aliyuncs.com');
  // The probe went to the host the fields built: the log names it, and the key is nowhere it can be read.
  await expect(settings.getByTestId('request-log')).toContainText('myws.ap-southeast-1.maas.aliyuncs.com');
  await expect(settings.getByText('test-key')).toHaveCount(0);
});

test('a generic endpoint keeps its custom headers sealed: sent on its calls, never shown again', async ({ page }) => {
  const seen: Record<string, string>[] = [];
  await fakeEndpoint(page, planThenAnswer({ reply: 'unused' }));
  // A capture route on top of the fake, so the requests are asserted AND answered.
  await page.route('https://127.0.0.1:5999/**', async (route) => {
    if (route.request().method() !== 'OPTIONS') seen.push(route.request().headers());
    await route.fallback();
  });
  const settings = await openSettings(page);
  await settings.getByRole('button', { name: 'Add a provider' }).click();
  const form = settings.getByRole('form', { name: 'New provider' });

  await form.getByRole('combobox', { name: 'Provider' }).selectOption('generic');
  await form.getByLabel('Name').fill('Headers');
  await form.getByLabel('Endpoint (the base URL, ending in /v1)').fill(FAKE_ENDPOINT);
  await form.getByLabel('Model', { exact: true }).fill('test-model');
  await form.getByRole('button', { name: 'Add a header' }).click();
  await form.getByLabel('Header 1 name').fill('x-org');
  await form.getByLabel('Header 1 value').fill('secret-value');
  await form.getByRole('button', { name: 'Save profile' }).click();
  await expect(settings.getByText(savedMessage('Headers'))).toBeVisible();

  // The probes carried it — and no render, list or log line ever repeats it.
  expect(seen.some((headers) => headers['x-org'] === 'secret-value')).toBe(true);
  await expect(settings.getByText('secret-value')).toHaveCount(0);

  await settings.locator('[data-profile="Headers"]').getByRole('button', { name: 'Edit' }).click();
  const editing = settings.getByRole('form', { name: 'Edit provider' });
  await expect(editing.getByLabel('Header 1 value')).toHaveCount(0);
  await expect(editing.getByText(/Leave this list untouched to keep the stored set/)).toBeVisible();
  await expect(editing.getByLabel('API key (optional — leave empty to keep the stored key)')).toBeVisible();
});

test('task roles pin a profile, a model, and — only where the model documents it — a thinking level', async ({ page }) => {
  // Two profiles: the generic fake (its '*' row lists no thinking levels) and an Anthropic one (Claude's do).
  await endpointRoute(page, 'https://api.anthropic.com', planThenAnswer({ reply: 'unused' }));
  await fakeEndpoint(page, planThenAnswer({ reply: 'unused' }));
  await page.goto('/');
  const settings = page.getByTestId('settings');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();

  await settings.getByRole('button', { name: 'Add a provider' }).click();
  let form = settings.getByRole('form', { name: 'New provider' });
  await form.getByRole('combobox', { name: 'Provider' }).selectOption('generic');
  await form.getByLabel('Name').fill('Local');
  await form.getByLabel('Endpoint (the base URL, ending in /v1)').fill(FAKE_ENDPOINT);
  await form.getByLabel('Model', { exact: true }).fill('test-model');
  await form.getByRole('button', { name: 'Save profile' }).click();
  await expect(settings.getByText(savedMessage('Local'))).toBeVisible();

  await settings.getByRole('button', { name: 'Add a provider' }).click();
  form = settings.getByRole('form', { name: 'New provider' });
  await form.getByRole('combobox', { name: 'Provider' }).selectOption('anthropic');
  await form.getByLabel('Name').fill('Claude');
  await form.getByLabel('API key (required)').fill('test-key');
  await form.getByRole('button', { name: 'Save profile' }).click();
  await expect(settings.getByText(savedMessage('Claude'))).toBeVisible();

  // Chat pinned to Claude: the model field is the profile's own; once it names a model with documented levels, the
  // thinking control appears with exactly those — 'Off' is not among Claude 5.5's.
  await settings.getByLabel('Chat profile').selectOption({ label: 'Claude' });
  await settings.getByLabel('Chat model').fill('claude-sonnet-5-5');
  const thinking = settings.getByLabel('Chat thinking level');
  await expect(thinking).toBeVisible();
  await expect(thinking.locator('option')).toHaveText(['Provider default', 'Low', 'Medium', 'High', 'Extra high', 'Max']);
  // Drafting pinned to the generic profile: the model documents no levels, so no thinking control is offered at all.
  await settings.getByLabel('Drafting profile').selectOption({ label: 'Local' });
  await settings.getByLabel('Drafting model').fill('test-model');
  await expect(settings.getByLabel('Drafting thinking level')).toHaveCount(0);
  // Background unpinned follows chat.
  await expect(settings.getByLabel('Background profile')).toHaveValue('');

  await thinking.selectOption('high');
  await settings.getByRole('button', { name: 'Save task roles' }).click();
  await expect(settings.getByText('Saved the task roles.')).toBeVisible();

  // The routing is a settings record: it survives a reload, and the reopened rows hold the pins.
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const again = page.getByTestId('settings');
  await expect(again.getByLabel('Chat profile')).not.toHaveValue('');
  await expect(again.getByLabel('Chat model')).toHaveValue('claude-sonnet-5-5');
  await expect(again.getByLabel('Chat thinking level')).toHaveValue('high');
  await expect(again.getByLabel('Drafting profile')).not.toHaveValue('');
});

test('advanced request parameters save and reload, and a denied thinking field removes the level control', async ({ page }) => {
  await endpointRoute(page, 'https://api.anthropic.com', planThenAnswer({ reply: 'unused' }));
  const settings = await openSettings(page);
  await settings.getByRole('button', { name: 'Add a provider' }).click();
  const form = settings.getByRole('form', { name: 'New provider' });
  await form.getByRole('combobox', { name: 'Provider' }).selectOption('anthropic');
  await form.getByLabel('Name').fill('Claude');
  await form.getByLabel('API key (required)').fill('test-key');

  // The preset's default model is claude-sonnet-5-5; its row offers low…max, and the form says what each goes out as.
  await form.getByTestId('profile-params').locator('summary').click();
  await expect(form.getByText(/Sent as: /)).toBeVisible();
  await form.getByLabel('Temperature').selectOption('never');
  await form.getByLabel('Strict tool schemas').selectOption('off');
  await form.getByLabel('Thinking levels').selectOption('custom');
  await form.getByLabel('High', { exact: true }).fill('deep');
  // Denying the field the Messages effort pair writes takes the whole control off the wire, and the form says
  // so — it does not go on claiming levels are sent.
  await form.getByLabel('Leave out these request fields').fill('output_config');
  await expect(form.getByText('The leave-out list below turns the thinking control off, so no level is sent.')).toBeVisible();
  await form.getByRole('button', { name: 'Save profile' }).click();
  await expect(settings.getByText(savedMessage('Claude'))).toBeVisible();

  // Task roles resolves the profile's effective caps: with the effort field denied, no thinking control is offered.
  await settings.getByLabel('Chat profile').selectOption({ label: 'Claude' });
  await settings.getByLabel('Chat model').fill('claude-sonnet-5-5');
  await expect(settings.getByLabel('Chat thinking level')).toHaveCount(0);

  // Every configurable field round-trips: the reopened form holds what was saved.
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const again = page.getByTestId('settings');
  await again.locator('[data-profile="Claude"]').getByRole('button', { name: 'Edit' }).click();
  const editing = again.getByRole('form', { name: 'Edit provider' });
  await editing.getByTestId('profile-params').locator('summary').click();
  await expect(editing.getByLabel('Temperature')).toHaveValue('never');
  await expect(editing.getByLabel('Strict tool schemas')).toHaveValue('off');
  await expect(editing.getByLabel('Thinking levels')).toHaveValue('custom');
  await expect(editing.getByLabel('High', { exact: true })).toHaveValue('deep');
  await expect(editing.getByLabel('Leave out these request fields')).toHaveValue('output_config');
});

test('profile request limits default by kind, clamp with keyboard input, and persist', async ({ page }) => {
  await fakeEndpoint(page, planThenAnswer({ reply: 'unused' }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Got it', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await expect(settings).toBeVisible();

  await settings.locator('[data-profile="Demo (no key)"]').getByRole('button', { name: 'Edit' }).click();
  let form = settings.getByRole('form', { name: 'Edit provider' });
  const demoRequestsAtOnce = form.getByLabel('Requests at once');
  await expect(demoRequestsAtOnce).toHaveValue('8');
  await demoRequestsAtOnce.fill('7');
  await demoRequestsAtOnce.press('Tab');
  await form.getByRole('button', { name: 'Save profile' }).click();
  await expect(settings.getByText(savedMessage('Demo (no key)'))).toBeVisible();
  expect((await storedProfiles(page)).find((profile) => profile['kind'] === 'mock')?.['maxConcurrentRequests']).toBe(7);

  await settings.getByRole('button', { name: 'Add a provider' }).click();
  form = settings.getByRole('form', { name: 'New provider' });
  await form.getByRole('combobox', { name: 'Provider' }).selectOption('generic');
  await form.getByLabel('Name').fill('Concurrency');
  await form.getByLabel('Endpoint (the base URL, ending in /v1)').fill(FAKE_ENDPOINT);
  await form.getByLabel('Model', { exact: true }).fill('test-model');

  const requestsAtOnce = form.getByLabel('Requests at once');
  const helpText = form.getByText('Choose a whole number from 1 to 8. Foreground requests go before queued Background requests; requests already running are not interrupted.');
  const helpId = await helpText.getAttribute('id');
  expect(helpId).toBeTruthy();
  expect(await requestsAtOnce.getAttribute('aria-describedby')).toContain(helpId);
  await expect(requestsAtOnce).toHaveValue('3');

  await requestsAtOnce.fill('');
  await form.getByRole('button', { name: 'Save profile' }).click();
  const requiredError = form.getByText('Choose a whole number from 1 to 8.', { exact: true });
  await expect(requiredError).toBeVisible();
  const requiredErrorId = await requiredError.getAttribute('id');
  expect(requiredErrorId).toBeTruthy();
  expect(await requestsAtOnce.getAttribute('aria-describedby')).toContain(requiredErrorId);
  expect((await storedProfiles(page)).some((profile) => profile['name'] === 'Concurrency')).toBe(false);

  await requestsAtOnce.fill('2.5');
  await expect(requestsAtOnce).toHaveValue('2.5');
  await expect(requiredError).toBeVisible();
  await form.getByRole('button', { name: 'Save profile' }).click();
  await expect(requestsAtOnce).toHaveValue('2.5');
  expect((await storedProfiles(page)).some((profile) => profile['name'] === 'Concurrency')).toBe(false);

  await requestsAtOnce.fill('3');
  await requestsAtOnce.press('Tab');
  await expect(requestsAtOnce).toHaveValue('3');
  await expect(requiredError).toBeHidden();
  await requestsAtOnce.focus();
  await requestsAtOnce.press('ArrowUp');
  await expect(requestsAtOnce).toHaveValue('4');
  await requestsAtOnce.fill('12');
  await requestsAtOnce.press('Tab');
  await expect(requestsAtOnce).toHaveValue('8');
  await requestsAtOnce.fill('0');
  await requestsAtOnce.press('Tab');
  await expect(requestsAtOnce).toHaveValue('1');
  await requestsAtOnce.fill('5');
  await requestsAtOnce.press('Tab');
  await expect(requestsAtOnce).toHaveValue('5');

  await form.getByRole('button', { name: 'Save profile' }).click();
  await expect(settings.getByText(savedMessage('Concurrency'))).toBeVisible();
  expect((await storedProfiles(page)).find((profile) => profile['name'] === 'Concurrency')?.['maxConcurrentRequests']).toBe(5);

  await expect(settings.locator('section[aria-labelledby="settings-providers"]')).toHaveAttribute('data-panel-state', 'idle');
  await page.reload();
  const again = await openSettings(page);
  await again.locator('[data-profile="Demo (no key)"]').getByRole('button', { name: 'Edit' }).click();
  form = again.getByRole('form', { name: 'Edit provider' });
  await expect(form.getByLabel('Requests at once')).toHaveValue('7');
  await form.getByRole('button', { name: 'Cancel' }).click();
  await again.locator('[data-profile="Concurrency"]').getByRole('button', { name: 'Edit' }).click();
  await expect(again.getByRole('form', { name: 'Edit provider' }).getByLabel('Requests at once')).toHaveValue('5');
});

test('the UI SDK can set Requests at once and the native save persists it through reload', async ({ page }) => {
  await fakeEndpoint(page, planThenAnswer({ reply: 'unused' }));
  const settings = await openSettings(page);
  await settings.getByRole('button', { name: 'Add a provider' }).click();
  const form = settings.getByRole('form', { name: 'New provider' });
  await form.getByRole('combobox', { name: 'Provider' }).selectOption('generic');
  await form.getByLabel('Name').fill('UI SDK');
  await form.getByLabel('Endpoint (the base URL, ending in /v1)').fill(FAKE_ENDPOINT);
  await form.getByLabel('Model', { exact: true }).fill('test-model');

  const entries = await page.evaluate(async (url) => (await import(/* @vite-ignore */ url) as UiAgent).agent.snapshot(), uiAgentUrl);
  const requestsAtOnce = entries.find((entry) => entry.label === 'Requests at once');
  expect(requestsAtOnce).toBeDefined();
  const action = await page.evaluate(async ({ url, ref }) => {
    const { agent } = await import(/* @vite-ignore */ url) as UiAgent;
    return agent.act({ steps: [{ ref, action: 'setValue', args: ['6'] }] });
  }, { url: uiAgentUrl, ref: requestsAtOnce!.ref });
  expect(action.ok, JSON.stringify(action)).toBe(true);
  await expect(form.getByLabel('Requests at once')).toHaveValue('6');

  await form.getByRole('button', { name: 'Save profile' }).click();
  await expect(settings.getByText(savedMessage('UI SDK'))).toBeVisible();
  await expect(settings.locator('section[aria-labelledby="settings-providers"]')).toHaveAttribute('data-panel-state', 'idle');
  await page.reload();
  const again = await openSettings(page);
  await again.locator('[data-profile="UI SDK"]').getByRole('button', { name: 'Edit' }).click();
  await expect(again.getByRole('form', { name: 'Edit provider' }).getByLabel('Requests at once')).toHaveValue('6');
});

test('a flag-only temperature profile — the SDK shape — keeps its mode through an unrelated edit and a reload', async ({ page }) => {
  await fakeEndpoint(page, planThenAnswer({ reply: 'unused' }));
  await page.goto('/');
  // A profile an SDK write can produce: params.temperature: true with no stored number (provider-gateway §2).
  // Read as 'send a value' with an empty field it could never be saved — the field is required there.
  await seedProfiles(page, [
    {
      id: 'prv_0000000002',
      name: 'SDK flag',
      kind: 'endpoint',
      preset: 'generic',
      baseUrl: 'https://127.0.0.1:5999/v1',
      defaultModel: 'test-model',
      params: { temperature: true },
      hasKey: false,
      isActive: true,
    },
  ]);
  await page.reload();

  const settings = await openSettings(page);
  await settings.locator('[data-profile="SDK flag"]').getByRole('button', { name: 'Edit' }).click();
  const editing = settings.getByRole('form', { name: 'Edit provider' });
  await editing.getByTestId('profile-params').locator('summary').click();
  // The flag alone is its own mode — a request's value — not 'send a value' with an empty field.
  await expect(editing.getByLabel('Temperature')).toHaveValue('request');
  await expect(editing.getByLabel('Value, from 0 to 2')).toHaveCount(0);
  await editing.getByLabel('Name').fill('SDK flag renamed');
  await editing.getByRole('button', { name: 'Save profile' }).click();
  await expect(settings.getByText(savedMessage('SDK flag renamed'))).toBeVisible();

  // The save wrote the same shape back: the flag, never a number.
  const renamed = (await storedProfiles(page)).find((profile) => profile['name'] === 'SDK flag renamed');
  expect(renamed?.['params']).toEqual({ temperature: true });
  expect(renamed?.['temperature']).toBeUndefined();

  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const again = page.getByTestId('settings');
  await again.locator('[data-profile="SDK flag renamed"]').getByRole('button', { name: 'Edit' }).click();
  const reopened = again.getByRole('form', { name: 'Edit provider' });
  await reopened.getByTestId('profile-params').locator('summary').click();
  await expect(reopened.getByLabel('Temperature')).toHaveValue('request');
});

test('a first-party host pin drives the capability line and the model-list caption, whatever preset the profile names', async ({ page }) => {
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  };
  await page.route('https://api.openai.com/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    if (request.method() === 'GET' && new URL(request.url()).pathname.endsWith('/models')) {
      await route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ data: [{ id: 'gpt-6.1-sol' }] }) });
      return;
    }
    await route.fulfill({ status: 404, headers: cors, body: 'not found' });
  });
  await page.goto('/');
  // A generic endpoint at api.openai.com — and a profile that names cohere — both resolve to the openai
  // preset: the pin `resolveRoute` applies to the route, the model list and the limits alike (§2).
  await seedProfiles(page, [
    {
      id: 'prv_0000000003',
      name: 'Pinned generic',
      kind: 'endpoint',
      preset: 'generic',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-6.1-sol',
      hasKey: false,
      isActive: true,
    },
    {
      id: 'prv_0000000004',
      name: 'Pinned cohere',
      kind: 'endpoint',
      preset: 'cohere',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-6.1-sol',
      hasKey: true,
      isActive: false,
    },
  ]);
  await seedKey(page, 'prv_0000000004', 'test-key');
  await page.reload();

  const settings = await openSettings(page);
  // The generic profile's edit form reads the pinned preset's row, not the generic table's fallback.
  await settings.locator('[data-profile="Pinned generic"]').getByRole('button', { name: 'Edit' }).click();
  const genericForm = settings.getByRole('form', { name: 'Edit provider' });
  await expect(genericForm.getByText('native tools · JSON-object replies · thinking: low / medium / high / xhigh / max')).toBeVisible();
  await expect(genericForm.getByText(/Not a documented model/)).toHaveCount(0);
  await genericForm.getByRole('button', { name: 'Cancel' }).click();

  // The cohere-named profile at the same host: its save lists models through OpenAI's route, so the caption
  // says "listed by" — never cohere's "documents no model list" — and its form reads OpenAI's row too.
  await settings.locator('[data-profile="Pinned cohere"]').getByRole('button', { name: 'Edit' }).click();
  const cohereForm = settings.getByRole('form', { name: 'Edit provider' });
  await expect(cohereForm.getByText('native tools · JSON-object replies · thinking: low / medium / high / xhigh / max')).toBeVisible();
  await expect(cohereForm.getByText(/This provider documents no model list/)).toHaveCount(0);
  await cohereForm.getByLabel('Model', { exact: true }).fill('gpt-6-sol');
  await cohereForm.getByRole('button', { name: 'Save profile' }).click();
  await expect(settings.getByText(savedMessage('Pinned cohere'))).toBeVisible();
  await expect(settings.getByRole('region', { name: 'Models listed by Pinned cohere' })).toContainText('gpt-6.1-sol');
  await expect(settings.getByRole('region', { name: 'Models documented for Pinned cohere' })).toHaveCount(0);
});

test('a profile saved before request parameters keeps its stored temperature through an unrelated edit', async ({ page }) => {
  const plan = {
    steps: [
      { tool: 'scene.draft', params: { doc: 'The Friend', instruction: 'The friend arrives by boat.', mode: 'draft' }, expect: 'The Friend holds a drafted opening scene' },
    ],
  };
  const sent: { temperature?: number }[] = [];
  await fakeEndpoint(page, planThenAnswer(plan, 'Drafted.', FRIEND_PROSE));
  // A capture route on top of the fake, so the chat bodies are asserted AND answered.
  await page.route('https://127.0.0.1:5999/**', async (route) => {
    const request = route.request();
    if (request.method() === 'POST' && request.url().endsWith('/chat/completions')) {
      sent.push(JSON.parse(request.postData() ?? '{}') as { temperature?: number });
    }
    await route.fallback();
  });
  await page.goto('/');
  // A profile from before request parameters — or written by the SDK — holds the temperature column and no params flag.
  // Seeded into the app database exactly as a restore reads it back.
  await seedProfiles(page, [
    {
      id: 'prv_0000000000',
      name: 'Legacy',
      kind: 'endpoint',
      preset: 'generic',
      baseUrl: 'https://127.0.0.1:5999/v1',
      defaultModel: 'test-model',
      temperature: 0.7,
      hasKey: false,
      isActive: true,
    },
  ]);
  await page.reload();

  const settings = await openSettings(page);
  await expect(settings.locator('[data-profile="Legacy"]')).toBeVisible();
  // The stored value reads as sent, not "follow the model" — and an unrelated edit keeps it.
  await settings.locator('[data-profile="Legacy"]').getByRole('button', { name: 'Edit' }).click();
  const editing = settings.getByRole('form', { name: 'Edit provider' });
  await editing.getByTestId('profile-params').locator('summary').click();
  await expect(editing.getByLabel('Temperature')).toHaveValue('send');
  await expect(editing.getByLabel('Value, from 0 to 2')).toHaveValue('0.7');
  await editing.getByLabel('Name').fill('Legacy renamed');
  await editing.getByRole('button', { name: 'Save profile' }).click();
  await expect(settings.getByText(savedMessage('Legacy renamed'))).toBeVisible();

  // The save wrote the stored shape back, not an override flag: the value stays send-where-allowed.
  const legacy = (await storedProfiles(page)).find((profile) => profile['name'] === 'Legacy renamed');
  expect(legacy?.['temperature']).toBe(0.7);
  expect(legacy?.['params']).toBeUndefined();

  // After a reload the reopened form still holds it — the save did not clear the stored value.
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const again = page.getByTestId('settings');
  await again.locator('[data-profile="Legacy renamed"]').getByRole('button', { name: 'Edit' }).click();
  const reopened = again.getByRole('form', { name: 'Edit provider' });
  await reopened.getByTestId('profile-params').locator('summary').click();
  await expect(reopened.getByLabel('Temperature')).toHaveValue('send');
  await expect(reopened.getByLabel('Value, from 0 to 2')).toHaveValue('0.7');
  await reopened.getByRole('button', { name: 'Cancel' }).click();
  await again.getByRole('button', { name: 'Close' }).click();

  // And it is still what the wire carries: the active profile's calls go out with the stored temperature.
  await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  const field = page.getByRole('combobox', { name: 'Intent' });
  await field.fill('Draft the opening of The Friend.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const card = page.getByTestId('plan-card');
  await card.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.locator('.agent-turn').last().locator('.agent-report')).toContainText('Applied:');
  expect(sent.length).toBeGreaterThan(0);
  expect(sent.every((body) => body.temperature === 0.7 || body.temperature === undefined)).toBe(true);
  expect(sent.some((body) => body.temperature === 0.7)).toBe(true);
});

test('a stored temperature on a model that takes none stays off the wire after an unrelated edit — until the writer changes it', async ({
  page,
}) => {
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  };
  const sent: Record<string, unknown>[] = [];
  // Every api.openai.com call is stubbed and captured: the model list, and the streamed Responses answer. Nothing
  // reaches the network — the assertion is on what the app PUTS on the wire.
  await page.route('https://api.openai.com/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname.endsWith('/models')) {
      await route.fulfill({
        status: 200,
        headers: { ...cors, 'content-type': 'application/json' },
        body: JSON.stringify({ data: [{ id: 'gpt-6.1-sol' }] }),
      });
      return;
    }
    if (request.method() === 'POST' && url.pathname.endsWith('/responses')) {
      sent.push(JSON.parse(request.postData() ?? '{}') as Record<string, unknown>);
      const answer = [
        'data: {"type":"response.output_text.delta","delta":"Done."}\n\n',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":40,"output_tokens":4}}}\n\n',
        'data: [DONE]\n\n',
      ].join('');
      await route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/event-stream' }, body: answer });
      return;
    }
    await route.fulfill({ status: 404, headers: cors, body: 'not found' });
  });
  await page.goto('/');
  // The same legacy shape as the generic test above — but the address pins the profile to OpenAI's own rows
  // (provider-gateway §2): the model row refuses a temperature, so the stored value was never sent.
  await seedProfiles(page, [
    {
      id: 'prv_0000000001',
      name: 'Legacy OpenAI',
      kind: 'endpoint',
      preset: 'generic',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-6.1-sol',
      temperature: 0.7,
      hasKey: false,
      isActive: true,
    },
  ]);
  await page.reload();

  const settings = await openSettings(page);
  await expect(settings.locator('[data-profile="Legacy OpenAI"]')).toBeVisible();
  // The stored value reads as sent — and an unrelated edit must not turn that into an override.
  await settings.locator('[data-profile="Legacy OpenAI"]').getByRole('button', { name: 'Edit' }).click();
  const editing = settings.getByRole('form', { name: 'Edit provider' });
  await editing.getByTestId('profile-params').locator('summary').click();
  await expect(editing.getByLabel('Temperature')).toHaveValue('send');
  await expect(editing.getByLabel('Value, from 0 to 2')).toHaveValue('0.7');
  await editing.getByLabel('Name').fill('Legacy OpenAI renamed');
  await editing.getByRole('button', { name: 'Save profile' }).click();
  await expect(settings.getByText(savedMessage('Legacy OpenAI renamed'))).toBeVisible();

  // The save wrote the stored shape back — the value, no override flag.
  const renamed = (await storedProfiles(page)).find((profile) => profile['name'] === 'Legacy OpenAI renamed');
  expect(renamed?.['temperature']).toBe(0.7);
  expect(renamed?.['params']).toBeUndefined();
  await settings.getByRole('button', { name: 'Close' }).click();

  // And the wire agrees: the row still refuses the field, so no call carries it.
  await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
  await page.getByRole('combobox', { name: 'Intent' }).fill('Say something.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => sent.length).toBeGreaterThan(0);
  await expect(page.locator('.agent-turn').last()).toContainText('Done.');
  expect(sent.every((body) => body['temperature'] === undefined)).toBe(true);

  // The reopened form still shows 'send', but the row takes none — the inherited send says so, the same words
  // 'follow' would use. Changing the shown value is the writer's own override — no mode re-pick needed — and the
  // note goes: the flag is stored, and the form reads it back as sent.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const again = page.getByTestId('settings');
  await again.locator('[data-profile="Legacy OpenAI renamed"]').getByRole('button', { name: 'Edit' }).click();
  const reopened = again.getByRole('form', { name: 'Edit provider' });
  await reopened.getByTestId('profile-params').locator('summary').click();
  await expect(reopened.getByText('gpt-6.1-sol takes no temperature, so none is sent.')).toBeVisible();
  await reopened.getByLabel('Value, from 0 to 2').fill('0.9');
  await expect(reopened.getByText('gpt-6.1-sol takes no temperature, so none is sent.')).toHaveCount(0);
  await reopened.getByRole('button', { name: 'Save profile' }).click();
  await expect(again.getByText(savedMessage('Legacy OpenAI renamed'))).toBeVisible();
  const forced = (await storedProfiles(page)).find((profile) => profile['name'] === 'Legacy OpenAI renamed');
  expect(forced?.['temperature']).toBe(0.9);
  expect(forced?.['params']).toMatchObject({ temperature: true });

  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const last = page.getByTestId('settings');
  await last.locator('[data-profile="Legacy OpenAI renamed"]').getByRole('button', { name: 'Edit' }).click();
  const deliberate = last.getByRole('form', { name: 'Edit provider' });
  await deliberate.getByTestId('profile-params').locator('summary').click();
  await expect(deliberate.getByLabel('Temperature')).toHaveValue('send');
  await expect(deliberate.getByLabel('Value, from 0 to 2')).toHaveValue('0.9');
});

test('the agent panel shows the model’s streamed thinking collapsed, apart from the answer and the draft it writes', async ({
  page,
}) => {
  const plan = {
    steps: [
      { tool: 'scene.draft', params: { doc: 'The Friend', instruction: 'The friend arrives by boat.', mode: 'draft' }, expect: 'The Friend holds a drafted opening scene' },
    ],
  };
  const planner = planThenAnswer(plan, 'Drafted.', FRIEND_PROSE);
  // Every call of the turn thinks aloud: the planner's reasoning and the drafting call's ride `reasoning_content`
  // deltas, which the adapter hands up as `reasoningDelta` chunks — the panel's Thinking block, never the editor's.
  await fakeEndpoint(page, (request) => {
    const reply = planner(request);
    const answer = typeof reply === 'string' ? { text: reply } : reply;
    return { ...answer, reasoning: request.system.startsWith('You are drafting prose') ? 'weighing the tide' : 'weighing the openings' };
  });
  await useFakeEndpoint(page);
  // The sample project, opened by the first-run card's read-only demo.
  await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  const friend = await idOf(page, 'The Friend');

  const field = page.getByRole('combobox', { name: 'Intent' });
  await field.fill('Draft the opening of The Friend.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const card = page.getByTestId('plan-card');
  await card.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.locator('.agent-turn').last().locator('.agent-report')).toContainText('Applied:');

  // Both calls' thinking is the turn's one block: collapsed, readable, and kept after the turn settles.
  const thinking = page.locator('.agent-turn').last().getByTestId('agent-thinking');
  await expect(thinking.locator('summary')).toHaveText('Thinking');
  await expect(thinking).toContainText('weighing the openings');
  await expect(thinking).toContainText('weighing the tide');
  expect(await thinking.evaluate((node) => (node as HTMLDetailsElement).open)).toBe(false);
  // The draft wrote prose to the scene, and no thinking rode with it.
  expect(await bodyOf(page, friend)).toContain(FRIEND_PROSE.slice(0, 20));
  expect(await bodyOf(page, friend)).not.toContain('weighing');

  // The usage it cost is per role, on the profile that ran it.
  const settings = await openSettings(page);
  const row = settings.locator('.usage-table tbody tr').filter({ hasText: 'Fake endpoint' }).first();
  await expect(row).toContainText('Chat');
  await expect(row).toContainText('test-model');
});

test('the local model servers sit under "On this computer", save with no key, and say where the text stays', async ({ page }) => {
  const seen: Record<string, string>[] = [];
  await endpointRoute(page, 'http://127.0.0.1:11434', planThenAnswer({ reply: 'unused' }), ['llama3.2', 'qwen3']);
  await page.route('http://127.0.0.1:11434/**', async (route) => {
    if (route.request().method() !== 'OPTIONS') seen.push(route.request().headers());
    await route.fallback();
  });
  const settings = await openSettings(page);
  await settings.getByRole('button', { name: 'Add a provider' }).click();
  const form = settings.getByRole('form', { name: 'New provider' });

  // The group holds exactly the three local servers; the hosted presets stay outside it.
  const picker = form.getByRole('combobox', { name: 'Provider' });
  const group = picker.locator('optgroup[label="On this computer"] option');
  await expect(group).toHaveText(['Ollama', 'LM Studio', 'llama.cpp (llama-server)']);
  await expect(picker.locator('optgroup[label="On this computer"] option', { hasText: 'Anthropic' })).toHaveCount(0);

  // A local pick: the address is the preset's loopback default and editable, the key is optional, the setup is said in words, and so is
  // the permission prompt Chrome shows, before any request is made. The privacy line follows the address.
  await picker.selectOption('ollama');
  const address = form.getByLabel('Server address (on this computer, ending in /v1)');
  await expect(address).toHaveValue('http://127.0.0.1:11434/v1');
  await expect(form.getByLabel('API key (optional — only if you set one on the server)')).toBeVisible();
  await expect(form.getByText(/OLLAMA_CONTEXT_LENGTH/)).toBeVisible();
  await expect(form.getByText(/Chrome and Edge ask whether this site may connect to apps on your device/)).toBeVisible();
  await expect(form.getByText(/Safari is unverified/)).toBeVisible();
  await expect(form.getByRole('link', { name: 'Ollama documentation' })).toHaveAttribute('href', 'https://docs.ollama.com/faq');
  await expect(form.getByText('Until the server says more: 4,096-token window, no native tools, no image input.')).toBeVisible();
  await expect(form.getByText('Your text stays on this computer.')).toBeVisible();
  await expect(form.getByRole('group', { name: 'Extra request headers (optional)' })).toHaveCount(0);

  // An address that is not this computer is refused by the gateway with the reason, and nothing is saved.
  await form.getByLabel('Name').fill('Ollama here');
  await address.fill('http://192.168.1.20:11434/v1');
  await expect(form.getByText('Your text stays on this computer.')).toHaveCount(0);
  await form.getByRole('button', { name: 'Save profile' }).click();
  await expect(settings.getByRole('alert')).toContainText('plain http is allowed only to this computer');
  await expect(settings.locator('[data-profile="Ollama here"]')).toHaveCount(0);

  // Back on loopback it saves with no key, lists the server's models, and the profile row carries the privacy line.
  await address.fill('http://127.0.0.1:11434/v1');
  await form.getByRole('button', { name: 'Save profile' }).click();
  await expect(settings.getByText(savedMessage('Ollama here'))).toBeVisible();
  await expect(settings.getByRole('region', { name: 'Models listed by Ollama here' })).toContainText('qwen3');
  const row = settings.locator('[data-profile="Ollama here"]');
  await expect(row).toContainText('Ollama · http://127.0.0.1:11434/v1 · llama3.2');
  await expect(row).toContainText('Your text stays on this computer');
  // No key header went to the server, and the hosted demo row does not claim the privacy line.
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((headers) => headers['authorization'] === undefined)).toBe(true);
  await expect(settings.locator('[data-profile="Demo (no key)"]')).not.toContainText('stays on this computer');
});

test('a generic endpoint still refuses plain http to loopback: the exemption is for the three local presets only', async ({ page }) => {
  const settings = await openSettings(page);
  await settings.getByRole('button', { name: 'Add a provider' }).click();
  const form = settings.getByRole('form', { name: 'New provider' });
  await form.getByLabel('Name').fill('Sneaky');
  await form.getByLabel('Endpoint (the base URL, ending in /v1)').fill('http://127.0.0.1:11434/v1');
  await form.getByLabel('Model', { exact: true }).fill('m');
  await form.getByRole('button', { name: 'Save profile' }).click();
  await expect(settings.getByRole('alert')).toContainText('must start with https://');
  await expect(settings.locator('[data-profile="Sneaky"]')).toHaveCount(0);
});

test('prompt caching is a per-profile switch, on by default, with a lifetime choice for Anthropic only, and it survives a reload', async ({
  page,
}) => {
  await fakeEndpoint(page, planThenAnswer({ reply: 'unused' }));
  const settings = await openSettings(page);
  await settings.getByRole('button', { name: 'Add a provider' }).click();
  const form = settings.getByRole('form', { name: 'New provider' });
  const caching = form.getByRole('group', { name: 'Prompt caching' });

  // Anthropic offers the lifetime: five minutes by default, an hour at a dearer write.
  await form.getByRole('combobox', { name: 'Provider' }).selectOption('anthropic');
  await expect(caching.getByRole('checkbox')).toBeChecked();
  await expect(caching.getByLabel('Keep a cached prompt for')).toHaveValue('5m');
  await expect(caching.getByRole('option', { name: '1 hour (costs more to write)' })).toBeAttached();

  // Any other provider has the switch alone.
  await form.getByRole('combobox', { name: 'Provider' }).selectOption('generic');
  await expect(caching.getByLabel('Keep a cached prompt for')).toHaveCount(0);
  await form.getByLabel('Name').fill('No cache');
  await form.getByLabel('Endpoint (the base URL, ending in /v1)').fill(FAKE_ENDPOINT);
  await form.getByLabel('Model', { exact: true }).fill('test-model');
  await caching.getByRole('checkbox').uncheck();
  await form.getByRole('button', { name: 'Save profile' }).click();
  await expect(settings.getByText(savedMessage('No cache'))).toBeVisible();

  await settings.locator('[data-profile="No cache"]').getByRole('button', { name: 'Edit' }).click();
  await expect(settings.getByRole('form', { name: 'Edit provider' }).getByRole('group', { name: 'Prompt caching' }).getByRole('checkbox')).not.toBeChecked();

  // Saved with the profile record: a reload brings the choice back.
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByTestId('settings').locator('[data-profile="No cache"]').getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByRole('form', { name: 'Edit provider' }).getByRole('group', { name: 'Prompt caching' }).getByRole('checkbox')).not.toBeChecked();
});

test('usage shows recorded costs and uncertainty, reveals token subsets and exports guarded daily CSV', async ({ page }) => {
  await seedUsage(page, [usageDay({ estimatedRequests: 1 }), usageDay({ model: 'unpriced', role: 'background', costUsd: undefined, unpricedRequests: 1 })]);
  await openSettings(page);
  const usage = page.locator('.usage');
  await expect(usage).toContainText('About $0.0420 in recorded costs.');
  await expect(usage).toContainText('Partial cost total: 1 request has no recorded cost.');
  const priced = usage.getByRole('row').filter({ hasText: '@SUM(A1)' });
  await expect(priced.getByTestId('usage-estimated')).toHaveText('1 request used estimated token counts.');
  await expect(usage.getByRole('row').filter({ hasText: 'unpriced' })).toContainText('No recorded cost.');
  await expect(usage.locator('.usage-token-detail')).toHaveCount(0);
  await usage.getByRole('checkbox', { name: 'Show token detail' }).check();
  const detail = usage.locator('tbody').filter({ hasText: '@SUM(A1)' }).locator('.usage-token-detail');
  await expect(detail).toBeVisible();
  await expect(detail.locator('div').filter({ hasText: 'Cache reads' }).getByRole('definition')).toHaveText('400');
  await expect(detail.locator('div').filter({ hasText: 'Reasoning' }).getByRole('definition')).toHaveText('50');
  const downloadPromise = page.waitForEvent('download');
  await usage.getByRole('button', { name: 'Export usage (CSV)' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('caotang-usage.csv');
  const csv = readFileSync((await download.path())!, 'utf8');
  expect(csv.split('\r\n')[0]).toBe('day,profile_id,profile,model,role,requests,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,estimated_requests,unpriced_requests,provider_cost_requests,cost_usd');
  expect(csv).toContain(",'@SUM(A1),");
  expect(csv).toContain('0.042');
  expect(csv).not.toContain('$');
});

test('a refused usage download says how to retry and keeps the export usable', async ({ page }) => {
  await seedUsage(page, [usageDay()]);
  await openSettings(page);
  await page.evaluate(() => {
    const original = URL.createObjectURL;
    URL.createObjectURL = () => { URL.createObjectURL = original; throw new Error('Download fixture refusal'); };
  });
  const usage = page.locator('.usage');
  const button = usage.getByRole('button', { name: 'Export usage (CSV)' });
  await button.click();
  await expect(usage.getByRole('alert')).toHaveText('The usage file could not be downloaded. Try exporting it again.');
  await expect(button).toBeEnabled();
  const downloadPromise = page.waitForEvent('download');
  await button.click();
  await downloadPromise;
  await expect(usage.getByRole('alert')).toHaveCount(0);
});

test('the session total retains two real demo turns across reload and only New session starts another total without losing device history', async ({ page }) => {
  await seedUsage(page, [], { prompt: 0.001, completion: 0.002 });
  await createProject(page, 'Usage session');
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  const session = page.getByTestId('agent-session-usage');
  const send = page.getByRole('button', { name: 'Send', exact: true });
  for (let turn = 1; turn <= 2; turn += 1) {
    await page.getByRole('combobox', { name: 'Intent' }).fill(`Explain this usage test ${turn}.`);
    await send.click();
    await expect(page.locator('.agent-report')).toHaveCount(turn);
    await expect(page.getByTestId('agent-panel')).toHaveAttribute('data-state', 'idle');
    await expect(session).toHaveAttribute('data-requests', String(turn));
  }
  const amounts = await page.locator('.agent-report').evaluateAll((reports) => reports.map((report) => ({
    input: Number(report.getAttribute('data-input-tokens')),
    output: Number(report.getAttribute('data-output-tokens')),
    cost: Number(report.getAttribute('data-cost-usd')),
  })));
  expect(amounts.every((turn) => turn.cost > 0)).toBe(true);
  await expect(session).toHaveAttribute('data-cost-usd', /\d/);
  await expect(session).toHaveAttribute('data-input-tokens', String(amounts.reduce((total, turn) => total + turn.input, 0)));
  await expect(session).toHaveAttribute('data-output-tokens', String(amounts.reduce((total, turn) => total + turn.output, 0)));
  expect(Number(await session.getAttribute('data-cost-usd'))).toBeCloseTo(amounts.reduce((total, turn) => total + turn.cost, 0), 10);
  await session.locator('summary').click();
  await expect(session).toContainText('Demo (no key)');
  await expect(session).toContainText('Chat');
  await expect(page.getByTestId('agent-turn-cost')).toHaveCount(2);
  await page.reload();
  await page.getByRole('listitem').filter({ hasText: 'Usage session' }).getByRole('button', { name: 'Open', exact: true }).click();
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await expect(page.locator('.agent-report')).toHaveCount(2);
  await expect(session).toHaveAttribute('data-requests', '2');
  await expect(session).toHaveAttribute('data-input-tokens', String(amounts.reduce((total, turn) => total + turn.input, 0)));
  await expect(session).toHaveAttribute('data-output-tokens', String(amounts.reduce((total, turn) => total + turn.output, 0)));
  expect(Number(await session.getAttribute('data-cost-usd'))).toBeCloseTo(amounts.reduce((total, turn) => total + turn.cost, 0), 10);
  await page.getByRole('combobox', { name: 'Intent' }).fill('Explain another visit.');
  await send.click();
  await expect(page.locator('.agent-report')).toHaveCount(3);
  await expect(page.getByTestId('agent-panel')).toHaveAttribute('data-state', 'idle');
  await expect(session).toHaveAttribute('data-requests', '3');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('.usage')).toContainText('3 requests');
  await page.getByTestId('settings').locator('.settings-head button').click();
  await page.getByTestId('agent-sessions').locator('.agent-session-trigger').click();
  await page.getByTestId('agent-sessions').getByRole('button', { name: 'New session', exact: true }).click();
  await expect(page.getByTestId('agent-sessions')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('.agent-report')).toHaveCount(0);
  await expect(session).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('.usage')).toContainText('3 requests');
});

for (const locale of ['de', 'en-XA', 'ar-XB']) {
  test(`usage exposes every labelled value in Modern at 390 px with ${locale} and no horizontal scrolling`, async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('caotang.interface', 'modern');
      localStorage.setItem('caotang.pseudo', '1');
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await seedUsage(page, [usageDay({ estimatedRequests: 1, model: 'a-very-long-model-identifier-for-wrapping-without-page-overflow' }), usageDay({ role: 'drafting', model: 'demo' })]);
    const settings = await openSettings(page);
    await settings.locator('[data-section="appearance"]').click();
    await settings.locator(`input[name="interface-language"][value="${locale}"]`).click();
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await settings.locator('[data-section="providers"]').click();
    const usage = page.locator('.usage');
    const checkbox = usage.getByRole('checkbox');
    if (locale === 'de') {
      await expect(checkbox).toHaveAccessibleName('Token-Details anzeigen');
      await expect(usage.getByRole('button')).toHaveText('Nutzung exportieren (CSV)');
      await expect(usage).toContainText('Bei 1 Anfrage wurden die Tokenzahlen geschätzt.');
      await expect(usage.getByRole('heading', { name: 'demo · Entwürfe', exact: true })).toBeVisible();
      await expect(usage).toContainText(/0,0840\s*\$/);
    } else await expect(usage.getByRole('button')).toContainText('⟦');
    await checkbox.focus();
    await expect(checkbox).toBeFocused();
    await page.keyboard.press('Space');
    await expect(checkbox).toBeChecked();
    await expect(usage.getByRole('table')).toHaveCount(0);
    await expect(usage.locator('.usage-records li')).toHaveCount(2);
    const expectedCounts = await page.evaluate((tag) => {
      const format = new Intl.NumberFormat(tag);
      return { requests: format.format(1), input: format.format(1000), output: format.format(200) };
    }, locale);
    for (const record of await usage.locator('.usage-records li').all()) {
      await expect(record.locator('.usage-record-values dt')).toHaveCount(6);
      await expect(record.locator('.usage-record-values dd').nth(2)).toHaveText(expectedCounts.requests);
      await expect(record.locator('.usage-record-values dd').nth(3)).toHaveText(expectedCounts.input);
      await expect(record.locator('.usage-record-values dd').nth(4)).toHaveText(expectedCounts.output);
      const geometry = await record.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return [...element.querySelectorAll('h5, dt, dd')].map((cell) => {
          const range = document.createRange();
          range.selectNodeContents(cell);
          return { fits: cell.scrollWidth <= cell.clientWidth, textFits: [...range.getClientRects()].every((rect) => rect.left >= bounds.left && rect.right <= bounds.right) };
        });
      });
      expect(geometry.every((cell) => cell.fits && cell.textFits), JSON.stringify(geometry)).toBe(true);
    }
    if (locale === 'de') {
      const downloadPromise = page.waitForEvent('download');
      await usage.getByRole('button').click();
      const download = await downloadPromise;
      const csv = readFileSync((await download.path())!, 'utf8');
      expect(csv.split('\r\n')[1]).toMatch(/,0\.042$/);
      expect(csv).not.toContain('0,0420');
    }
    expect(await usage.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const button of await usage.getByRole('button').all()) {
      expect(await button.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      const box = await button.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
  });
}

for (const locale of ['en', 'de', 'en-XA', 'ar-XB']) {
  test(`desktop usage fits every cost and coverage note at 1280 px in ${locale}`, async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('caotang.interface', 'modern');
      localStorage.setItem('caotang.pseudo', '1');
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await seedUsage(page, [usageDay({ estimatedRequests: 1, unpricedRequests: 1, requests: 2, model: 'a-very-long-model-identifier-for-wrapping-without-page-overflow' })]);
    const settings = await openSettings(page);
    if (locale !== 'en') {
      await settings.locator('[data-section="appearance"]').click();
      await settings.locator(`input[name="interface-language"][value="${locale}"]`).click();
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await settings.locator('[data-section="providers"]').click();
    }
    const usage = page.locator('.usage');
    await usage.getByRole('checkbox').check();
    const table = usage.getByRole('table');
    await table.scrollIntoViewIfNeeded();
    const geometry = await table.evaluate((element) => {
      const table = element.getBoundingClientRect();
      const cost = element.querySelector('tbody tr:first-child td:nth-child(8)')!;
      const bounds = cost.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(cost);
      return { tableFits: element.scrollWidth <= element.clientWidth, costFits: cost.scrollWidth <= cost.clientWidth, costInside: bounds.left >= table.left && bounds.right <= table.right, textInside: [...range.getClientRects()].every((rect) => rect.left >= bounds.left && rect.right <= bounds.right) };
    });
    expect(geometry).toEqual({ tableFits: true, costFits: true, costInside: true, textInside: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
