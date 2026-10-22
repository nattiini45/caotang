import { expect, test, type Page } from '@playwright/test';

import { endpointRoute, FAKE_ENDPOINT, fakeEndpoint, planThenAnswer, useFakeEndpoint } from './endpoint.js';
import { bodyOf, idOf } from './support.js';

/**
 * The provider settings the preset registry drives (provider-gateway §2, §9; ui-modules §5.2): the preset picker and its
 * per-preset fields, the honest CORS label on presets a browser cannot call, the key hints a preset's `keyOptional`
 * decides, the sealed custom headers a generic endpoint keeps, the capability line under the model field, and the task
 * roles that pin a profile, model and thinking level per kind of call. Named presets answer through Playwright routes —
 * no request leaves the page.
 */

const FRIEND_PROSE = 'The ferry came in on the evening tide, low in the water and slow to answer the rope.';

async function openSettings(page: Page): Promise<ReturnType<Page['getByTestId']>> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  return page.getByTestId('settings');
}

test('the preset picker lists the registry, enables every preset the sweep found reachable, and fits the form to the pick', async ({
  page,
}) => {
  const settings = await openSettings(page);
  await settings.getByRole('button', { name: 'Add a provider' }).click();
  const form = settings.getByRole('form', { name: 'New provider' });

  const picker = form.getByRole('combobox', { name: 'Provider' });
  // The picker's own names. Every registered preset currently answers the browser's preflight (the sweep), so
  // nothing is disabled — a preset flagged 'blocked' would list here greyed with "Desktop app or hosted only".
  await expect(picker.getByRole('option', { name: 'OpenAI-compatible endpoint' })).toBeAttached();
  await expect(picker.getByRole('option', { name: 'Anthropic (Claude)' })).toBeAttached();
  await expect(picker.getByRole('option', { name: 'Z.ai (GLM)' })).toBeEnabled();
  await expect(picker.getByRole('option', { name: 'OpenCode' })).toBeEnabled();

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

  await expect(settings.getByText('Saved “Qwen studio”.')).toBeVisible();
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
  await expect(settings.getByText('Saved “Headers”.')).toBeVisible();

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
  await expect(settings.getByText('Saved “Local”.')).toBeVisible();

  await settings.getByRole('button', { name: 'Add a provider' }).click();
  form = settings.getByRole('form', { name: 'New provider' });
  await form.getByRole('combobox', { name: 'Provider' }).selectOption('anthropic');
  await form.getByLabel('Name').fill('Claude');
  await form.getByLabel('API key (required)').fill('test-key');
  await form.getByRole('button', { name: 'Save profile' }).click();
  await expect(settings.getByText('Saved “Claude”.')).toBeVisible();

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

  const field = page.getByRole('textbox', { name: 'Intent' });
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
  await expect(form.getByRole('link', { name: 'Ollama documentation' })).toHaveAttribute('href', /docs\.ollama\.com/);
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
  await expect(settings.getByText('Saved “Ollama here”.')).toBeVisible();
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
