import { chooseInterfaceLanguage } from './support.js';
import { expect, type Page } from '@playwright/test';

import { addCustomEndpoint } from './provider-setup-support.js';

/**
 * A saved profile whose model list is held, then rejected: the provider-verification states (checking, failed, verified) a
 * writer meets after the profile exists. The profile is added through the ordinary key-first setup while the host still answers;
 * the demo profile is made the active one again, so the checks that follow can show they never select a provider.
 */
export async function openVerification(page: Page, locale: 'en' | 'de', shell: 'classic' | 'modern') {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let gated = false;
  let passing = true;
  await page.route('https://verification.example.test/v1/**', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({ json: { choices: [{ message: { content: '{}' } }] } });
      return;
    }
    if (gated) await held;
    await route.fulfill(passing
      ? { json: { data: [{ id: 'writing-model' }] } }
      : { status: 401, json: { error: { message: 'The API key was rejected.' } } });
  });
  await page.addInitScript((chosen) => { localStorage.setItem('caotang.interface', chosen); }, shell);
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  const panel = settings.locator('[aria-labelledby="settings-providers"]');
  await addCustomEndpoint(settings, { url: 'https://verification.example.test/v1', model: 'writing-model', name: 'Schreibmodell' });
  await settings.locator('[data-profile="Demo (no key)"]').getByRole('button', { name: 'Use this profile' }).click();
  await expect(settings.locator('[data-profile="Demo (no key)"] .badge.is-active')).toBeVisible();
  await expect(settings.locator('[data-profile="Schreibmodell"]')).toHaveAttribute('data-state', 'verified');
  if (locale === 'de') {
    await settings.locator('[data-section="appearance"]').click();
    await chooseInterfaceLanguage(page, settings, 'de');
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    await settings.locator('[data-section="providers"]').click();
  }
  gated = true;
  passing = false;
  const row = settings.locator('[data-profile="Schreibmodell"]');
  await row.getByRole('button', { name: locale === 'de' ? 'Bearbeiten' : 'Edit', exact: true }).click();
  await expect(row).toHaveAttribute('data-state', 'checking');
  await settings.getByRole('form', { name: locale === 'de' ? 'Anbieter bearbeiten' : 'Edit provider' }).getByRole('button', { name: locale === 'de' ? 'Abbrechen' : 'Cancel', exact: true }).click();
  await row.scrollIntoViewIfNeeded();
  return {
    settings, panel, row, release,
    pass: () => { passing = true; },
    async reopen() {
      await expect(panel).toHaveAttribute('data-panel-state', 'idle');
      await page.reload();
      await page.getByRole('button', { name: locale === 'de' ? 'Einstellungen' : 'Settings', exact: true }).click();
      await expect(settings).toBeVisible();
    },
    async retry() {
      await row.getByRole('button', { name: locale === 'de' ? 'Bearbeiten' : 'Edit', exact: true }).click();
      await settings.locator('.profile-form button[type="submit"]').click();
    },
  };
}
