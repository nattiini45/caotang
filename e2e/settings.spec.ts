import { expect, test, type Page } from '@playwright/test';

import { fakeEndpoint, FAKE_ENDPOINT, planThenAnswer } from './endpoint.js';
import { createProject } from './support.js';

/**
 * Settings (ui-modules §5): saving a profile, the list-models probe at save time, activation with its response-format probe,
 * the request log that shows both, and what survives a reload. The endpoint is the fake one, so every probe is a request the
 * app really sent, and the log is the app's own record of it.
 */

async function openSettings(page: Page): Promise<ReturnType<Page['getByTestId']>> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  return page.getByTestId('settings');
}

test('the demo profile can be renamed and saved, with no key', async ({ page }) => {
  await page.goto('/');
  const settings = await openSettings(page);
  const demo = settings.locator('[data-profile="Demo (no key)"]');
  await expect(demo).toContainText('Demo, no key');
  await expect(demo).toContainText('Active');

  await demo.getByRole('button', { name: 'Edit' }).click();
  const form = settings.getByRole('form', { name: 'Edit provider' });
  await form.getByLabel('Name').fill('Demo, renamed');
  await form.getByRole('button', { name: 'Save profile' }).click();

  await expect(settings.getByText('Saved “Demo, renamed”.')).toBeVisible();
  await expect(settings.locator('[data-profile="Demo, renamed"]')).toContainText('Active');
  await expect(settings.locator('[data-profile="Demo (no key)"]')).toHaveCount(0);
});

test('saving an endpoint lists its models and probes its response format at save time, and activating it reuses that answer; the requests show in the log', async ({
  page,
}) => {
  await fakeEndpoint(page, planThenAnswer({ reply: 'unused' }));
  await page.goto('/');
  const settings = await openSettings(page);

  await settings.getByRole('button', { name: 'Add a provider' }).click();
  // The fake endpoint speaks the OpenAI-Chat dialect, so its profile is a generic one. Labels are scoped to the
  // provider form: the role picker's fields below it carry names too.
  const form = settings.getByRole('form', { name: 'New provider' });
  await form.getByRole('combobox', { name: 'Provider' }).selectOption('generic');
  await form.getByLabel('Name').fill('Local test');
  await form.getByLabel('Endpoint (the base URL, ending in /v1)').fill(FAKE_ENDPOINT);
  await form.getByLabel('Model', { exact: true }).fill('test-model');
  await form.getByRole('button', { name: 'Save profile' }).click();

  // The save-time probe: the models the endpoint lists are shown beside the profile.
  await expect(settings.getByText('Saved “Local test”.')).toBeVisible();
  await expect(settings.getByRole('region', { name: 'Models listed by Local test' })).toContainText('test-model');
  // The probe did not make the profile active: the demo profile still is.
  await expect(settings.locator('[data-profile="Demo (no key)"]')).toContainText('Active');

  await settings.locator('[data-profile="Local test"]').getByRole('button', { name: 'Use this profile' }).click();
  await expect(settings.getByText('is now the active profile')).toBeVisible();
  await expect(settings.getByText('This endpoint accepts structured output.')).toBeVisible();
  await expect(settings.locator('[data-profile="Local test"]')).toContainText('Structured output accepted');

  // The request log holds the models list and one format probe: the save sent the probe (provider-gateway §5, one-shot at save
  // time), and the activation read its cached answer, so it sent nothing.
  const log = settings.getByTestId('request-log');
  await expect(log).toContainText('/v1/models');
  await expect(log.locator('tr[data-outcome="ok"]').filter({ hasText: '/v1/chat/completions' })).toHaveCount(1);
  // The line shows the output cap the probe was sent with (provider-gateway §3), so a writer can see why a call cost more output.
  await expect(log.getByRole('columnheader', { name: 'Max tokens' })).toBeVisible();
  await expect(log.locator('tr[data-outcome="ok"]').filter({ hasText: '/v1/chat/completions' }).locator('td').nth(5)).toHaveText('16');
});

test('the endpoint profile and its activation survive a reload, and the restored profile keeps its id', async ({ page }) => {
  await fakeEndpoint(page, planThenAnswer({ reply: 'unused' }));
  await page.goto('/');
  let settings = await openSettings(page);
  await settings.getByRole('button', { name: 'Add a provider' }).click();
  const form = settings.getByRole('form', { name: 'New provider' });
  await form.getByRole('combobox', { name: 'Provider' }).selectOption('generic');
  await form.getByLabel('Name').fill('Survivor');
  await form.getByLabel('Endpoint (the base URL, ending in /v1)').fill(FAKE_ENDPOINT);
  await form.getByLabel('Model', { exact: true }).fill('test-model');
  await form.getByRole('button', { name: 'Save profile' }).click();
  await expect(settings.getByText('Saved “Survivor”.')).toBeVisible();
  await settings.locator('[data-profile="Survivor"]').getByRole('button', { name: 'Use this profile' }).click();
  await expect(settings.getByText('is now the active profile')).toBeVisible();
  await settings.getByRole('button', { name: 'Close' }).click();

  await page.reload();
  settings = await openSettings(page);
  await expect(settings.locator('[data-profile="Survivor"]')).toContainText('Active');
  await expect(settings.locator('[data-profile="Survivor"]')).toContainText(FAKE_ENDPOINT);
  await expect(settings.locator('[data-profile="Demo (no key)"]')).not.toContainText('Active');
});

test('the request log says what it holds before any request, without repeating a word', async ({ page }) => {
  await page.goto('/');
  const settings = await openSettings(page);
  await expect(settings.getByText('No request has been sent yet.')).toBeVisible();
  await expect(settings.getByText('Requests, retries included.')).toBeVisible();
  await expect(settings.getByText(/The last requests/)).toHaveCount(0);
});

test('the writing settings save, and survive a reload', async ({ page }) => {
  await page.goto('/');
  const settings = await openSettings(page);
  await settings.getByRole('button', { name: 'Writing' }).click();
  // 1,234 is not a multiple of 50: the field takes any whole number, and the form's own check decides (the native step would not).
  await settings.getByLabel('Daily target, in words (0 for none)').fill('1234');
  await settings.getByLabel(/Save after typing stops/).fill('1200');
  await settings.getByRole('button', { name: 'Save writing settings' }).click();
  await expect(settings.getByText(/Saved\. The save delay applies/)).toBeVisible();

  await page.reload();
  await openSettings(page).then((again) => again.getByRole('button', { name: 'Writing' }).click());
  await expect(page.getByTestId('settings').getByLabel('Daily target, in words (0 for none)')).toHaveValue('1234');
  await expect(page.getByTestId('settings').getByLabel(/Save after typing stops/)).toHaveValue('1200');
});

const FOCUS_TOGGLE = 'In focus mode, hide the binder and the inspector';

/** Sets the focus-mode toggle in Settings › Writing, saves it, and closes Settings. */
async function setFocusRails(page: Page, hide: boolean): Promise<void> {
  const settings = await openSettings(page);
  await settings.getByRole('button', { name: 'Writing' }).click();
  const toggle = settings.getByRole('checkbox', { name: FOCUS_TOGGLE });
  if (hide) await toggle.check();
  else await toggle.uncheck();
  await settings.getByRole('button', { name: 'Save writing settings' }).click();
  await expect(settings.getByText(/Saved\. The save delay applies/)).toBeVisible();
  await settings.getByRole('button', { name: 'Close' }).click();
}

test('focus mode hides the binder and the inspector while the Writing setting is on, which it is by default', async ({ page }) => {
  await createProject(page, 'Focus Default');
  const settings = await openSettings(page);
  await settings.getByRole('button', { name: 'Writing' }).click();
  await expect(settings.getByRole('checkbox', { name: FOCUS_TOGGLE })).toBeChecked();
  await settings.getByRole('button', { name: 'Close' }).click();

  await page.getByRole('button', { name: 'Focus', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Project panels' })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toHaveCount(0);
});

test('with the Writing setting off, focus mode keeps the binder and the inspector shown', async ({ page }) => {
  await createProject(page, 'Focus Shown');
  await setFocusRails(page, false);

  await page.getByRole('button', { name: 'Focus', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Focus', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('navigation', { name: 'Project panels' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
  // The status line says why the panels stayed: the pressed button alone does not.
  // The wording, with "Settings › Writing" a button whose visible words are its name.
  const status = page.getByRole('status').filter({ hasText: 'Focus mode is on.' });
  await expect(status).toContainText('Focus mode is on. The binder and inspector stay open, as set in Settings › Writing.');

  // A second click leaves focus mode, and the cue does not come back on leaving.
  await page.getByRole('button', { name: 'Focus', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Focus', exact: true })).toHaveAttribute('aria-pressed', 'false');
});

test('the focus mode line opens Settings at the Writing section, where the setting is', async ({ page }) => {
  await createProject(page, 'Focus Link');
  await setFocusRails(page, false);
  await page.getByRole('button', { name: 'Focus', exact: true }).click();
  await page.getByRole('status').getByRole('button', { name: 'Settings › Writing', exact: true }).click();
  const settings = page.getByTestId('settings');
  await expect(settings).toBeVisible();
  await expect(settings.getByRole('checkbox', { name: FOCUS_TOGGLE })).toBeVisible();
});

test('the focus mode choice survives a reload', async ({ page }) => {
  await page.goto('/');
  await setFocusRails(page, false);

  await page.reload();
  const again = await openSettings(page);
  await again.getByRole('button', { name: 'Writing' }).click();
  await expect(again.getByRole('checkbox', { name: FOCUS_TOGGLE })).not.toBeChecked();
});

test('the data section says where the projects are kept, and that the browser app cannot move them', async ({ page }) => {
  await page.goto('/');
  const settings = await openSettings(page);
  await settings.getByRole('button', { name: 'Data' }).click();
  await expect(settings.getByTestId('storage-location')).toContainText('Storage location: this browser');
  await expect(settings.getByTestId('storage-location')).toContainText('read-only in the browser app');
});

test.describe('the request log clock follows the formatter locale', () => {
  // An English browser set to Britain: the formatter locale is en-GB, whose clock is 24-hour with no AM or PM. The
  // activity log's clock (activity-model.spec.ts) is tested the same way; this is the panel that reads it.
  test.use({ locale: 'en-GB' });

  test('shows a 24-hour time rather than the English default’s AM or PM', async ({ page }) => {
    await fakeEndpoint(page, planThenAnswer({ reply: 'unused' }));
    await page.goto('/');
    const settings = await openSettings(page);
    await settings.getByRole('button', { name: 'Add a provider' }).click();
    const form = settings.getByRole('form', { name: 'New provider' });
    await form.getByRole('combobox', { name: 'Provider' }).selectOption('generic');
    await form.getByLabel('Name').fill('Clock test');
    await form.getByLabel('Endpoint (the base URL, ending in /v1)').fill(FAKE_ENDPOINT);
    await form.getByLabel('Model', { exact: true }).fill('test-model');
    await form.getByRole('button', { name: 'Save profile' }).click();

    const log = settings.getByTestId('request-log');
    await expect(log.locator('tbody tr').first().locator('td').first()).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
  });
});
