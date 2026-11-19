import { expect, test, type Page } from '@playwright/test';

import { endpointRoute, FAKE_ENDPOINT, planThenAnswer } from './endpoint.js';
import { openProviderSetup } from './provider-setup-support.js';
import { chooseInterfaceLanguage } from './support.js';

/**
 * Adding a provider is a key and one press (provider-gateway §2, "Adding a provider"): paste a key, the provider is recognised,
 * the models the key can use are listed live, a press on one finishes. Every request is answered by a Playwright route, so no
 * key or model list is real; the keys below are made up and only have the shapes the detection reads.
 */

const ANTHROPIC_KEY = 'sk-ant-api03-' + 'A'.repeat(30);
const SHARED_SHAPE_KEY = 'sk-' + 'ab12'.repeat(8);
const CLAUDE_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'];

async function openSettings(page: Page): Promise<ReturnType<Page['getByTestId']>> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  return page.getByTestId('settings');
}

test('a pasted key names its provider, lists the models it can use, and one press makes the provider the active one', async ({ page }) => {
  await endpointRoute(page, 'https://api.anthropic.com', planThenAnswer({ reply: 'unused' }), CLAUDE_MODELS);
  const settings = await openSettings(page);

  // A fresh install opens on the key: nothing else is asked first.
  const form = await openProviderSetup(settings);
  await expect(form.getByLabel('Model')).toHaveCount(0);
  await expect(form.getByLabel('Requests at once')).toHaveCount(0);
  await expect(form.getByText('Prompt caching')).toHaveCount(0);

  await form.getByLabel('API key', { exact: true }).fill(ANTHROPIC_KEY);
  await expect(form.getByText('Looks like a key from Anthropic (Claude).')).toBeVisible();
  await expect(settings.getByRole('heading', { name: 'Choose a model' })).toBeVisible();
  await expect(settings.getByText(/Anthropic \(Claude\).* accepted the key\./)).toBeVisible();

  // The recommended model leads the list; a model that does not write text would not be there.
  const models = settings.getByRole('listbox', { name: 'Models you can use with Anthropic (Claude)' });
  await expect(models.getByRole('option')).toHaveCount(3);
  await expect(models.getByRole('option').first()).toContainText('claude-sonnet-5-5');
  await expect(models.getByRole('option').first()).toContainText('Recommended');

  await models.getByRole('option', { name: 'claude-opus-5-5' }).click();
  await expect(settings.getByRole('heading', { name: /Anthropic \(Claude\).* is ready$/ })).toBeVisible();
  await expect(settings.getByText('The agent now uses claude-opus-5-5.')).toBeVisible();
  await settings.getByRole('button', { name: 'Done', exact: true }).click();

  const row = settings.locator('[data-profile="Anthropic (Claude)"]');
  await expect(row).toContainText('Active');
  await expect(row).toContainText('claude-opus-5-5');
  await expect(row).not.toContainText('Not verified');
  await expect(settings.getByText(ANTHROPIC_KEY)).toHaveCount(0);

  // The profile, its model and its activation survive a reload; the key is not on the page.
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const again = page.getByTestId('settings').locator('[data-profile="Anthropic (Claude)"]');
  await expect(again).toContainText('Active');
  await expect(again).toContainText('claude-opus-5-5');
});

test('a key shape several providers share asks which provider, and More providers lists the rest with the desktop-only ones marked', async ({ page }) => {
  const settings = await openSettings(page);
  const form = await openProviderSetup(settings);

  // A key being typed is not checked: too short to be a key, nothing is sent and nothing is guessed.
  await form.getByLabel('API key', { exact: true }).fill('sk-ab12');
  await expect(form.getByText('Which provider is this key from?')).toHaveCount(0);

  await form.getByLabel('API key', { exact: true }).fill(SHARED_SHAPE_KEY);
  await expect(form.getByText('Which provider is this key from?')).toBeVisible();
  await expect(form.getByText('Looks like a key from')).toHaveCount(0);
  await expect(form.getByRole('radio').first()).toBeVisible();
  // Nothing is checked until the writer picks: the key is never tried against more than one provider.
  await expect(settings.getByRole('heading', { name: 'Choose a model' })).toHaveCount(0);

  await form.getByRole('button', { name: 'More providers' }).click();
  const more = settings.getByRole('listbox', { name: 'More providers' });
  await expect(more.getByRole('option', { name: 'Z.ai (GLM)' })).toBeVisible();
  await expect(more.getByRole('option', { name: 'OpenCode — Desktop app or hosted only' })).toBeVisible();
  await expect(more.getByRole('option', { name: 'OpenAI-compatible endpoint' })).toHaveCount(0);
  await expect(more.getByRole('option', { name: 'Ollama' })).toHaveCount(0);
});

test('a provider that needs one more value asks for it beside the key, and lists models from the host those values build', async ({ page }) => {
  await endpointRoute(page, 'https://myws.ap-southeast-1.maas.aliyuncs.com', planThenAnswer({ reply: 'unused' }));
  const settings = await openSettings(page);
  const form = await openProviderSetup(settings);

  await form.getByLabel('API key', { exact: true }).fill(SHARED_SHAPE_KEY);
  await form.getByRole('radio', { name: 'Alibaba Cloud Model Studio (Qwen)' }).check();
  await expect(form.getByLabel('Workspace ID')).toBeVisible();
  await expect(form.getByRole('listbox', { name: 'Region' })).toBeVisible();
  // Nothing is sent until the required value is there.
  await expect(settings.getByRole('heading', { name: 'Choose a model' })).toHaveCount(0);
  await form.getByLabel('Workspace ID').fill('myws');
  await form.getByRole('button', { name: 'Check key' }).click();

  const models = settings.getByRole('listbox', { name: 'Models you can use with Alibaba Cloud Model Studio (Qwen)' });
  await models.getByRole('option', { name: 'test-model' }).click();
  await settings.getByRole('button', { name: 'Done', exact: true }).click();
  const row = settings.locator('[data-profile="Alibaba Cloud Model Studio (Qwen)"]');
  await expect(row).toContainText('maas.aliyuncs.com');
  await expect(settings.getByTestId('request-log')).toContainText('myws.ap-southeast-1.maas.aliyuncs.com');
  await expect(settings.getByText(SHARED_SHAPE_KEY)).toHaveCount(0);
});

test('a refused key says it is the key, keeps what was typed and saves nothing', async ({ page }) => {
  await page.route('https://api.anthropic.com/**', async (route) => {
    await route.fulfill({ status: 401, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' }, json: { error: { message: 'invalid x-api-key' } } });
  });
  const settings = await openSettings(page);
  const form = await openProviderSetup(settings);
  await form.getByLabel('API key', { exact: true }).fill(ANTHROPIC_KEY);

  await expect(form.getByText(/did not accept this key\. Check that you copied all of it, then paste it again\./)).toBeVisible();
  await expect(form.getByLabel('API key', { exact: true })).toHaveValue(ANTHROPIC_KEY);
  await expect(form.getByLabel('API key', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(settings.locator('[data-profile]')).toHaveCount(1);
  await expect(settings.getByRole('heading', { name: 'Choose a model' })).toHaveCount(0);

  // A corrected key is checked again, without a reload.
  await page.unroute('https://api.anthropic.com/**');
  await endpointRoute(page, 'https://api.anthropic.com', planThenAnswer({ reply: 'unused' }), CLAUDE_MODELS);
  await form.getByLabel('API key', { exact: true }).fill(ANTHROPIC_KEY + 'B');
  await expect(settings.getByRole('heading', { name: 'Choose a model' })).toBeVisible();
});

test('a network failure is named as the network and not as the key', async ({ page }) => {
  await page.route('https://api.mistral.ai/**', (route) => route.abort('connectionrefused'));
  const settings = await openSettings(page);
  const form = await openProviderSetup(settings);
  await form.getByLabel('API key', { exact: true }).fill('A'.repeat(32));
  await form.getByRole('radio', { name: 'Mistral AI' }).check();

  await expect(form.getByText(/Could not reach .*Mistral AI.*\. Check your connection, then try again\./)).toBeVisible({ timeout: 20_000 });
  await expect(form.getByLabel('API key', { exact: true })).not.toHaveAttribute('aria-invalid', 'true');
  await expect(settings.locator('[data-profile]')).toHaveCount(1);
});

test('a provider that documents no model list is checked with one real request and offers the models Caotang knows', async ({ page }) => {
  const posts: string[] = [];
  await endpointRoute(page, 'https://api.cohere.ai', planThenAnswer({ reply: 'unused' }));
  await page.route('https://api.cohere.ai/**', async (route) => {
    if (route.request().method() === 'POST') posts.push(route.request().url());
    await route.fallback();
  });
  const settings = await openSettings(page);
  const form = await openProviderSetup(settings);
  await form.getByLabel('API key', { exact: true }).fill('A'.repeat(40));
  await form.getByRole('radio', { name: 'Cohere' }).check();

  await expect(settings.getByText('This provider documents no model list, so these are the models Caotang knows for it.')).toBeVisible();
  await expect(settings.getByRole('listbox').getByRole('option').first()).toContainText('Recommended');
  expect(posts.some((url) => url.endsWith('/chat/completions'))).toBe(true);
});

test('a custom endpoint lists its models too, and types the model name only when the endpoint cannot list them', async ({ page }) => {
  await page.route(FAKE_ENDPOINT + '/**', async (route) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (route.request().method() === 'GET') return route.fulfill({ status: 404, headers: cors, body: 'no such route' });
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, json: { choices: [{ message: { content: '{}' } }] } });
  });
  const settings = await openSettings(page);
  const form = await openProviderSetup(settings);
  await form.getByRole('button', { name: 'Custom endpoint' }).click();
  const custom = settings.getByRole('form', { name: 'Custom endpoint' });
  await expect(custom.getByLabel('API key (optional — only if the endpoint needs one)')).toBeVisible();
  await custom.getByLabel('Endpoint (the base URL, ending in /v1)').fill(FAKE_ENDPOINT);
  await custom.getByRole('button', { name: 'Connect and list models' }).click();

  await expect(custom.getByText('did not list its models')).toBeVisible();
  await custom.getByLabel('Model name the endpoint expects').fill('my-model');
  await custom.getByRole('button', { name: 'Use this model' }).click();
  await expect(settings.getByRole('heading', { name: /is ready$/ })).toBeVisible();
  await settings.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(settings.locator('[data-profile="OpenAI-compatible endpoint"]')).toContainText('my-model');
});

test('the model list moves with the arrow keys without choosing, chooses on Enter, and Add another provider starts again from an empty key', async ({ page }) => {
  await endpointRoute(page, 'https://api.anthropic.com', planThenAnswer({ reply: 'unused' }), CLAUDE_MODELS);
  const settings = await openSettings(page);
  const form = await openProviderSetup(settings);
  await form.getByLabel('API key', { exact: true }).fill(ANTHROPIC_KEY);

  const models = settings.getByRole('listbox', { name: 'Models you can use with Anthropic (Claude)' });
  await expect(models).toBeVisible();
  await expect(settings.getByRole('heading', { name: 'Choose a model' })).toBeFocused();
  await models.getByRole('option').first().focus();
  await page.keyboard.press('ArrowDown');
  // Moving through the list sets nothing up.
  await expect(settings.getByRole('heading', { name: /is ready$/ })).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(settings.getByRole('heading', { name: /Anthropic \(Claude\).* is ready$/ })).toBeVisible();
  await expect(settings.getByRole('heading', { name: /Anthropic \(Claude\).* is ready$/ })).toBeFocused();
  await settings.getByRole('button', { name: 'Add another provider' }).click();
  await expect(settings.getByLabel('API key', { exact: true })).toHaveValue('');
});

test('on a phone the setup fits the screen with no sideways scrolling at every step', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await endpointRoute(page, 'https://api.anthropic.com', planThenAnswer({ reply: 'unused' }), CLAUDE_MODELS);
  const settings = await openSettings(page);
  const form = await openProviderSetup(settings);
  const noSideScroll = async (): Promise<void> => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  };
  await noSideScroll();
  await form.getByLabel('API key', { exact: true }).fill(SHARED_SHAPE_KEY);
  await expect(form.getByText('Which provider is this key from?')).toBeVisible();
  await noSideScroll();
  await form.getByLabel('API key', { exact: true }).fill(ANTHROPIC_KEY);
  await expect(settings.getByRole('heading', { name: 'Choose a model' })).toBeVisible();
  await noSideScroll();
});

test('correcting the key while the check runs lists the new key\'s models, not the old key\'s', async ({ page }) => {
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstSeen!: () => void;
  const seen = new Promise<void>((resolve) => { firstSeen = resolve; });
  const keys: string[] = [];
  await page.route('https://api.anthropic.com/**', async (route) => {
    const request = route.request();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const key = request.headers()['x-api-key'] ?? '';
    if (request.method() === 'GET') {
      keys.push(key);
      if (keys.length === 1) { firstSeen(); await firstHeld; }
      return route.fulfill({ headers: cors, json: { data: [{ id: key.endsWith('B') ? 'new-model' : 'old-model' }] } });
    }
    return route.fulfill({ headers: cors, json: { choices: [{ message: { content: '{}' } }] } });
  });
  const settings = await openSettings(page);
  const form = await openProviderSetup(settings);
  await form.getByLabel('API key', { exact: true }).fill(ANTHROPIC_KEY);
  await seen;
  await form.getByLabel('API key', { exact: true }).fill(ANTHROPIC_KEY + 'B');
  releaseFirst();

  const models = settings.getByRole('listbox', { name: 'Models you can use with Anthropic (Claude)' });
  await expect(models.getByRole('option', { name: 'new-model' })).toBeVisible();
  await expect(models.getByRole('option', { name: 'old-model' })).toHaveCount(0);
  await models.getByRole('option', { name: 'new-model' }).click();
  await expect(settings.getByRole('heading', { name: /is ready$/ })).toBeVisible();
  await settings.getByRole('button', { name: 'Done', exact: true }).click();

  expect(keys).toContain(ANTHROPIC_KEY + 'B');
  await expect(settings.locator('[data-profile="Anthropic (Claude)"]')).toContainText('new-model');
  await expect(settings.locator('[data-profile]')).toHaveCount(2);
});

/**
 * The setup form's recovery wording in German (#596): the package-side ProfileError refs render through the
 * interface catalogue, and a provider's own words stay isolated in the bdi, never translated in place.
 */
test('de: a bad base URL and a rejected key answer with German recovery wording', { tag: '@i18n' }, async ({ page }) => {
  await page.route('https://rejected.example.test/v1/**', (route) =>
    route.fulfill({ status: 401, json: { error: { message: 'The API key was rejected.' } } }));
  await page.goto('/');
  await page.getByTestId('open-settings').click();
  const settings = page.getByTestId('settings');
  await settings.locator('[data-section="appearance"]').click();
  await chooseInterfaceLanguage(page, settings, 'de');
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await settings.locator('[data-section="providers"]').click();

  const form = settings.getByRole('form', { name: 'Anbieter hinzufügen' });
  const add = settings.getByRole('button', { name: 'Anbieter hinzufügen', exact: true });
  await expect(form.or(add)).toBeVisible();
  if (await add.isVisible()) await add.click();
  await expect(form).toBeVisible();
  await form.getByRole('button', { name: 'Eigener Endpunkt' }).click();
  const custom = settings.getByRole('form', { name: 'Eigener Endpunkt' });
  const endpoint = custom.getByLabel('Endpunkt (die Basis-URL, endend auf /v1)');
  const connect = custom.getByRole('button', { name: 'Verbinden und Modelle auflisten' });

  // A base URL the package validator refuses renders the fixed message in the interface language.
  await endpoint.fill('not-a-url');
  await connect.click();
  await expect(settings.getByRole('alert')).toContainText('Die Basis-URL ist keine URL.');

  // A host that rejects the key: the cause is translated, the provider's own words stay untouched in the bdi.
  await endpoint.fill('https://rejected.example.test/v1');
  await custom.getByLabel('API-Schlüssel (optional – nur wenn der Endpunkt einen braucht)').fill('test-key');
  await connect.click();
  const alert = settings.getByRole('alert');
  await expect(alert).toContainText('hat diesen Schlüssel nicht akzeptiert');
  await expect(alert).toContainText('Antwort des Anbieters:');
  await expect(alert.locator('bdi')).toContainText('rejected');
});
