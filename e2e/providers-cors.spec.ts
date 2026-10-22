import { expect, test, type Page } from '@playwright/test';

import { PRESETS, presetFor } from '../packages/gateway/src/index.js';
import { adapterFor } from '../packages/gateway/src/adapters/index.js';
import { startLocalStub, type LocalStub, type StubConfig } from './local-stub.js';

/**
 * The CORS support sweep (provider-gateway §9, providers-browser-cors.md §2). For every shipped preset this asks the
 * *browser* — not a stub — whether a page fetch may reach the provider: a GET on the models path carrying the preset's
 * auth-shaped headers, so a real preflight runs where the headers demand one. No keys are needed: a blocked preflight
 * fails before auth is consulted, and a passing one answers 401/200 either way.
 *
 * The result per preset is attached to the test run as JSON (`cors-sweep` attachment). The registry's `cors` field is
 * checked against it: a preset flagged 'ok' that the browser cannot reach is a stale row and fails; 'blocked' rows are
 * asserted to actually fail, so the disabled badge the UI shows is the truth.
 */

interface SweepResult {
  readonly preset: string;
  readonly url: string;
  readonly outcome: 'ok' | 'blocked' | 'http-error' | 'error';
  readonly status?: number;
  readonly detail?: string;
}

/** The headers a real request carries, with a placeholder credential — enough to trigger the same preflight. */
function requestFor(presetId: string): { url: string; headers: Record<string, string> } {
  const preset = presetFor(presetId);
  if (preset === undefined) return { url: '', headers: {} };
  const adapter = adapterFor(preset.adapter);
  const ctx = { baseUrl: preset.baseUrl, model: preset.defaultModel, quirks: preset.quirks, caps: {} };
  const path = adapter.modelsPath(ctx) ?? '/models';
  return {
    url: `${preset.baseUrl.replace(/\/$/, '')}${path}`,
    headers: adapter.headers(ctx, { apiKey: 'sweep-placeholder-not-a-key' }, 'models'),
  };
}

test.describe.configure({ mode: 'serial' });

test('every preset answers or honestly fails a browser CORS request', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.goto('/');

  const results: SweepResult[] = [];
  for (const preset of PRESETS) {
    // The mock is no network call, and a local server is not on the internet: the stub tests below stand in for it.
    if (preset.id === 'mock' || preset.local !== undefined) continue;
    const request = requestFor(preset.id);
    const outcome = await page.evaluate(
      async ({ url, headers }) => {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 15_000);
        try {
          const res = await fetch(url, { method: 'GET', headers, signal: ac.signal });
          return { outcome: res.ok ? 'ok' : 'http-error', status: res.status };
        } catch (error) {
          // A CORS refusal surfaces as a TypeError; a timeout surfaces as AbortError.
          const name = error instanceof DOMException ? error.name : '';
          if (name === 'AbortError') return { outcome: 'error', detail: 'timed out' };
          return { outcome: 'blocked', detail: error instanceof TypeError ? 'TypeError (CORS or network)' : String(error) };
        } finally {
          clearTimeout(timer);
        }
      },
      { url: request.url, headers: request.headers },
    );
    results.push({
      preset: preset.id,
      url: request.url,
      outcome: outcome.outcome as SweepResult['outcome'],
      ...(outcome.status !== undefined ? { status: outcome.status } : {}),
      ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
    });
  }

  await testInfo.attach('cors-sweep', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });

  for (const result of results) {
    const preset = presetFor(result.preset)!;
    if (preset.cors === 'ok') {
      expect(
        result.outcome === 'ok' || result.outcome === 'http-error',
        `${result.preset} is flagged cors:'ok' but the browser could not read the response (${result.outcome}: ${result.detail ?? result.status})`,
      ).toBe(true);
    }
    if (preset.cors === 'blocked') {
      expect(result.outcome, `${result.preset} is flagged cors:'blocked' but answered ${result.status}`).toBe('blocked');
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
