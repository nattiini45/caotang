import { expect, test } from '@playwright/test';
import { openVerification } from './provider-verification-support.js';

for (const shell of ['classic', 'modern'] as const) {
  for (const locale of ['en', 'de'] as const) {
    test(`${shell}: provider verification survives reload and an unchanged save retries in ${locale}`, async ({ page }) => {
      const { settings, row, release, reopen, retry, pass } = await openVerification(page, locale, shell);
      const demo = settings.locator('[data-profile="Demo (no key)"]');
      await expect(demo).toHaveAttribute('data-state', 'demo');
      await expect(demo.locator('.badge.is-active')).toBeVisible();
      await expect(row.getByText(locale === 'de' ? 'Nicht verifiziert' : 'Not verified', { exact: true })).toBeVisible();
      await expect(row.getByRole('status')).toHaveText(locale === 'de' ? 'Dieses Profil wird geprüft…' : 'Checking this profile…');
      release();
      await expect(row).toHaveAttribute('data-state', 'failed');
      await expect(row.getByText(locale === 'de' ? 'Bearbeiten und speichern Sie dieses Profil, um es erneut zu prüfen.' : 'Edit and save this profile to check it again.')).toBeVisible();
      await reopen();
      await expect(row).toHaveAttribute('data-state', 'failed');
      await expect(demo.locator('.badge.is-active')).toBeVisible();
      pass();
      await retry();
      await expect(row).toHaveAttribute('data-state', 'verified');
      await expect(row.getByText(locale === 'de' ? 'Nicht verifiziert' : 'Not verified', { exact: true })).toHaveCount(0);
      await reopen();
      await expect(row).toHaveAttribute('data-state', 'verified');
      await expect(demo.locator('.badge.is-active')).toBeVisible();
    });
  }
}
