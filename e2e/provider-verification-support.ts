import { expect, type Page } from '@playwright/test';

export async function openVerification(page: Page, locale: 'en' | 'de', shell: 'classic' | 'modern') {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let passing = false;
  await page.route('https://verification.example.test/v1/**', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({ json: { choices: [{ message: { content: '{}' } }] } });
      return;
    }
    await held;
    await route.fulfill(passing
      ? { json: { data: [{ id: 'writing-model' }] } }
      : { status: 401, json: { error: { message: 'The model list could not be read.' } } });
  });
  await page.addInitScript((chosen) => { localStorage.setItem('caotang.interface', chosen); }, shell);
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  const panel = settings.locator('[aria-labelledby="settings-providers"]');
  if (locale === 'de') {
    await settings.locator('[data-section="appearance"]').click();
    await settings.locator('input[name="interface-language"][value="de"]').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    await settings.locator('[data-section="providers"]').click();
  }
  await settings.getByRole('button', { name: locale === 'de' ? 'Anbieter hinzufügen' : 'Add a provider', exact: true }).click();
  const form = settings.locator('.profile-form');
  await form.getByLabel('Name', { exact: true }).fill('Schreibmodell');
  await form.locator('input[type="url"]').fill('https://verification.example.test/v1');
  await form.getByLabel(locale === 'de' ? 'Modell' : 'Model', { exact: true }).fill('writing-model');
  await form.locator('button[type="submit"]').click();
  const row = settings.locator('[data-profile="Schreibmodell"]');
  await expect(row).toHaveAttribute('data-state', 'checking');
  await form.getByRole('button', { name: locale === 'de' ? 'Abbrechen' : 'Cancel', exact: true }).click();
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
