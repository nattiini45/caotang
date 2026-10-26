import { expect, test, type Page } from '@playwright/test';

import { PRESETS, presetFor, resolveRoute } from '../packages/gateway/src/index.js';
import { adapterFor } from '../packages/gateway/src/adapters/index.js';
import { startLocalStub, type LocalStub, type StubConfig } from './local-stub.js';

/**
 * The CORS support sweep (provider-gateway §9, providers-browser-cors.md §2). For every shipped preset this asks the
 * *browser* — not a stub — whether a page fetch may reach the provider, for each request the app makes from a page:
 *
 *  - the **chat route**: the POST the agent sends (the adapter's complete path, its auth-shaped headers and a JSON body), which
 *    runs a real preflight. This is the route a `cors` flag speaks for: a preset the writer can chat with is a preset that works.
 *  - the **models route**: the GET Settings makes when a profile is saved (the listing and its verification), with the same
 *    headers. A preset with no listing route (`noModelsRoute`) is not asked.
 *
 * No keys are needed: a blocked preflight fails before auth is consulted, and a passing one answers 401/200 either way. The
 * request carries a placeholder credential, so the provider rejects it; the question is only whether the *page* may read that
 * answer. A provider can allow the preflight and still leave its 401 without `Access-Control-Allow-Origin` on one route, so the
 * two routes are judged apart and each result is recorded.
 *
 * The result per preset is attached to the test run as JSON (`cors-sweep` attachment). The registry's `cors` field is checked
 * against the chat route: a preset flagged 'ok' whose chat route the browser cannot reach is a stale row and fails; 'blocked' rows
 * are asserted to actually fail on the chat route, so the disabled badge the UI shows is the truth. A preset whose
 * chat route is readable but whose models route is not stays 'ok' and is reported honestly: as a `cors-models-route` annotation
 * on the test and in the attachment. The app says so too when it meets that case (gateway `modelListUnreadable`).
 */

type Outcome = 'ok' | 'blocked' | 'http-error' | 'error';

interface RouteResult {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly outcome: Outcome;
  readonly status?: number;
  readonly detail?: string;
}

interface SweepResult {
  readonly preset: string;
  readonly chat: RouteResult;
  /** Absent for a preset with no listing route. */
  readonly models?: RouteResult;
}

/** True when the page could read an HTTP answer, whatever its status. */
const readable = (route: RouteResult): boolean => route.outcome === 'ok' || route.outcome === 'http-error';

interface ProbeRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

/** The two requests the app makes to a preset from a page, with the headers a real call carries and a placeholder credential. */
function requestsFor(presetId: string): { chat: ProbeRequest; models?: ProbeRequest } {
  const preset = presetFor(presetId)!;
  // The route the gateway takes for the preset's default model: a preset can send some models down another adapter (OpenCode's
  // Claude ids take the Messages route), and it is that adapter's path and headers the browser has to get through.
  const route = resolveRoute({ preset: preset.id, baseUrl: preset.baseUrl }, preset.defaultModel);
  const adapter = adapterFor(route.adapter);
  const ctx = { baseUrl: preset.baseUrl, model: preset.defaultModel, quirks: route.quirks, caps: route.caps };
  const secrets = { apiKey: 'sweep-placeholder-not-a-key' };
  const base = preset.baseUrl.replace(/\/$/, '');
  const chat: ProbeRequest = {
    method: 'POST',
    url: `${base}${adapter.completePath(preset.defaultModel)}`,
    // The gateway adds accept and content-type to every call; a JSON body is what makes the POST need a preflight.
    headers: { accept: 'text/event-stream', 'content-type': 'application/json', ...adapter.headers(ctx, secrets, 'complete') },
    body: JSON.stringify({ model: preset.defaultModel, messages: [{ role: 'user', content: 'ping' }], stream: true }),
  };
  const modelsPath = preset.noModelsRoute === true ? null : adapter.modelsPath(ctx);
  if (modelsPath === null) return { chat };
  return {
    chat,
    models: { method: 'GET', url: `${base}${modelsPath}`, headers: { accept: 'application/json', ...adapter.headers(ctx, secrets, 'models') } },
  };
}

async function probe(page: Page, request: ProbeRequest): Promise<RouteResult> {
  const outcome = await page.evaluate(async ({ method, url, headers, body }) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15_000);
    try {
      const res = await fetch(url, { method, headers, ...(body === undefined ? {} : { body }), signal: ac.signal });
      return { outcome: res.ok ? 'ok' : 'http-error', status: res.status };
    } catch (error) {
      // A CORS refusal surfaces as a TypeError; a timeout surfaces as AbortError.
      const name = error instanceof DOMException ? error.name : '';
      if (name === 'AbortError') return { outcome: 'error', detail: 'timed out' };
      return { outcome: 'blocked', detail: error instanceof TypeError ? 'TypeError (CORS or network)' : String(error) };
    } finally {
      clearTimeout(timer);
    }
  }, request);
  const detail = outcome.outcome === 'blocked' ? `${outcome.detail}; ${await preflightVerdict(page, request)}` : outcome.detail;
  return {
    method: request.method,
    url: request.url,
    outcome: outcome.outcome as Outcome,
    ...(outcome.status !== undefined ? { status: outcome.status } : {}),
    ...(detail !== undefined ? { detail } : {}),
  };
}

/**
 * Why a request the browser refused was refused, asked from outside the browser (a Node-side OPTIONS carrying the page's origin and the
 * request's headers, as the browser's preflight would). The browser reports every CORS failure the same way; this tells a refused
 * preflight, which no key can change, from an answer whose own response carries no allow-origin header, which a placeholder key's
 * 401 can do while a real key's answer still reads. It is a diagnosis for the report, never what decides a row.
 */
async function preflightVerdict(page: Page, request: ProbeRequest): Promise<string> {
  const asked = Object.keys(request.headers)
    .map((name) => name.toLowerCase())
    .filter((name) => name !== 'accept')
    .sort();
  try {
    const answer = await page.request.fetch(request.url, {
      method: 'OPTIONS',
      headers: {
        origin: new URL(page.url()).origin,
        'access-control-request-method': request.method,
        ...(asked.length === 0 ? {} : { 'access-control-request-headers': asked.join(',') }),
      },
      failOnStatusCode: false,
      maxRedirects: 0,
      timeout: 15_000,
    });
    const origin = answer.headers()['access-control-allow-origin'];
    const methods = answer.headers()['access-control-allow-methods'] ?? '';
    if (origin === undefined) return `preflight refused: OPTIONS answered ${answer.status()} with no access-control-allow-origin`;
    if (!methods.split(',').some((method) => method.trim().toUpperCase() === request.method)) {
      return `preflight refused: OPTIONS allows ${methods === '' ? 'no methods' : methods}, not ${request.method}`;
    }
    return 'preflight allowed this origin, method and headers, so the answer itself carried no allow-origin header (a placeholder key’s rejection can do that)';
  } catch (error) {
    return `preflight not checked: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const describeRoute = (route: RouteResult): string => `${route.method} ${route.url} ${route.outcome}: ${route.detail ?? route.status}`;

test.describe.configure({ mode: 'serial' });

test('every preset answers or honestly fails a browser CORS request', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.goto('/');

  const results: SweepResult[] = [];
  for (const preset of PRESETS) {
    // The mock is no network call, and a local server is not on the internet: the stub tests below stand in for it.
    if (preset.id === 'mock' || preset.local !== undefined) continue;
    const requests = requestsFor(preset.id);
    const chat = await probe(page, requests.chat);
    const models = requests.models === undefined ? undefined : await probe(page, requests.models);
    results.push({ preset: preset.id, chat, ...(models === undefined ? {} : { models }) });
  }

  await testInfo.attach('cors-sweep', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });

  for (const result of results) {
    const preset = presetFor(result.preset)!;
    if (preset.cors === 'ok') {
      expect(
        readable(result.chat),
        `${result.preset} is flagged cors:'ok' but the browser could not read its chat route (${describeRoute(result.chat)})`,
      ).toBe(true);
      // The chat route works, so the flag stands; but the model list is a request the app also makes, and a writer deserves the
      // fact that it cannot be read from a page (the app words this as "the browser did not let this page read the model list").
      if (result.models !== undefined && !readable(result.models)) {
        testInfo.annotations.push({
          type: 'cors-models-route',
          description: `${result.preset}: chat is readable (${describeRoute(result.chat)}), but the model list is not (${describeRoute(result.models)})`,
        });
      }
    }
    if (preset.cors === 'blocked') {
      // Blocked means the writer cannot chat with the preset from a page, so the chat route must really fail. (Its model list may
      // still be readable: that is a fact about the list, not a reason to call the preset usable.)
      expect(result.chat.outcome, `${result.preset} is flagged cors:'blocked' but its chat route answered ${result.chat.status}`).toBe('blocked');
    }
    // 'unknown' rows are only recorded.
  }
});

/*
 * The local model servers, against a stub that imitates each product's CORS default (provider-gateway §9). The browser runs a
 * real CORS check against a real loopback server, so the fix the app names is the one that makes the same save succeed. What this
 * proves is the wiring and the messages; whether Ollama, LM Studio and llama-server behave as the stub does is a manual check.
 */

interface LocalProduct {
  readonly preset: 'ollama' | 'lmstudio' | 'llamacpp';
  readonly name: string;
  /** The server as it starts out of the box for a web page on another origin. */
  readonly refusing: StubConfig;
  /** The same server after the setting the message names. */
  readonly configured: (pageOrigin: string) => StubConfig;
}

const LOCAL_PRODUCTS: readonly LocalProduct[] = [
  { preset: 'ollama', name: 'Ollama', refusing: { product: 'ollama' }, configured: (origin) => ({ product: 'ollama', origins: [origin] }) },
  { preset: 'lmstudio', name: 'LM Studio', refusing: { product: 'lmstudio' }, configured: () => ({ product: 'lmstudio', cors: true }) },
  // llama-server reflects any origin by default; the case that fails is one started with --cors-origins for another site.
  { preset: 'llamacpp', name: 'llama.cpp (llama-server)', refusing: { product: 'llamacpp', origins: ['https://caotang.app'] }, configured: () => ({ product: 'llamacpp' }) },
];

async function saveLocal(page: Page, product: LocalProduct, address: string): Promise<ReturnType<Page['getByTestId']>> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Add a provider' }).click();
  const form = settings.getByRole('form', { name: 'New provider' });
  await form.getByRole('combobox', { name: 'Provider' }).selectOption(product.preset);
  await form.getByLabel('Name').fill('Stub');
  await form.getByLabel('Server address (on this computer, ending in /v1)').fill(address);
  await form.getByRole('button', { name: 'Save profile' }).click();
  return settings;
}

for (const product of LOCAL_PRODUCTS) {
  test(`${product.name}: a stub that refuses the page makes the save name the preset's own fix, and the configured stub saves`, async ({ page }) => {
    const fix = presetFor(product.preset)!.local!.corsFix;
    let stub: LocalStub = await startLocalStub(product.refusing);
    try {
      const settings = await saveLocal(page, product, stub.baseUrl);
      // The profile is saved, the probe is not verified, and the message is the product's setting and nobody else's.
      await expect(settings.getByText(/Saved “Stub”, but/)).toBeVisible();
      await expect(settings.locator('.form-message')).toContainText(fix);
      await expect(settings.locator('.form-message')).toContainText(product.name === 'llama.cpp (llama-server)' ? 'llama-server' : product.name);
      // The model list reached the server (a simple GET needs no preflight) and the browser withheld the answer; no key header was
      // ever on a request, since none was set.
      expect(stub.requests.some((request) => request.method === 'GET' && request.path === '/v1/models')).toBe(true);
      expect(stub.requests.every((request) => request.headers['authorization'] === undefined)).toBe(true);
      await stub.close();

      stub = await startLocalStub(product.configured(new URL(page.url()).origin));
      const configured = await saveLocal(page, product, stub.baseUrl);
      await expect(configured.getByText('Saved “Stub”.')).toBeVisible();
      await expect(configured.getByRole('region', { name: 'Models listed by Stub' })).toContainText('stub-model');
      // The format probe's POST crossed the preflight too (a JSON body is not a simple request), and still carried no key.
      expect(stub.requests.some((request) => request.method === 'OPTIONS')).toBe(true);
      expect(stub.requests.some((request) => request.method === 'POST' && request.path === '/v1/chat/completions')).toBe(true);
      expect(stub.requests.every((request) => request.headers['authorization'] === undefined)).toBe(true);
    } finally {
      await stub.close();
    }
  });
}

test('a local server that is not running is named as not running, with its address', async ({ page }) => {
  const stub = await startLocalStub({ product: 'ollama' });
  const address = stub.baseUrl;
  await stub.close();
  const settings = await saveLocal(page, LOCAL_PRODUCTS[0]!, address);
  await expect(settings.getByText(/Saved “Stub”, but/)).toBeVisible();
  await expect(settings.locator('.form-message')).toContainText(`Nothing is listening on ${new URL(address).host}`);
  await expect(settings.locator('.form-message')).toContainText('Is Ollama running?');
});
