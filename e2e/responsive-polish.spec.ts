import { expect, type Locator, type Page } from '@playwright/test';
import { FAKE_ENDPOINT, fakeEndpoint, planThenAnswer } from './endpoint.js';
import { test } from './test.js';
import { chooseInterfaceLanguage, createProject } from './support.js';

async function selectLanguage(page: Page, settings: Locator, language: string): Promise<void> {
  await settings.locator('[data-section="appearance"]').click();
  await chooseInterfaceLanguage(page, settings, language);
  await expect(page.locator('html')).toHaveAttribute('lang', language);
}

async function expectProviderControlsToFit(form: Locator): Promise<void> {
  await expect(form).toBeVisible();
  const outside = await form.evaluate((element) => {
    const formBox = element.getBoundingClientRect();
    const scrollport = element.closest('.settings-body')!.getBoundingClientRect();
    return [...element.querySelectorAll('input:not([aria-hidden="true"]), button, [role="listbox"]')]
      .filter((control) => control.getClientRects().length > 0)
      .filter((control) => {
        const box = control.getBoundingClientRect();
        return box.left < Math.max(formBox.left, scrollport.left) || box.right > Math.min(formBox.right, scrollport.right);
      })
      .map((control) => control.textContent?.trim() || control.getAttribute('data-slot') || control.tagName);
  });
  expect(outside).toEqual([]);
}

for (const language of ['en', 'de']) {
  test(`the screenplay runtime is readable on a phone in ${language}`, { tag: '@modern' }, async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('caotang.interface', 'modern'));
    await createProject(page, 'Harbour Screenplay');
    if (language === 'de') {
      await page.getByTestId('modern-more').click();
      await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
      const settings = page.getByTestId('settings');
      await selectLanguage(page, settings, language);
      await settings.getByRole('button', { name: 'Schließen', exact: true }).click();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const banner = page.getByTestId('storage-banner');
    if (await banner.isVisible()) await banner.getByRole('button').last().click();
    await page.getByTestId('new-menu').click();
    await page.getByTestId('new-screenplay').click();
    const pill = page.locator('.sp-readout-chip');
    await expect(pill).toHaveText(language === 'de' ? '0 Seiten · etwa 0 min' : '0 pages · about 0 min');
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      expect(await page.evaluate((scheme) => matchMedia(`(prefers-color-scheme: ${scheme})`).matches, colorScheme)).toBe(true);
      const bounds = await pill.evaluate((element) => {
        const card = element.closest('.sp-view')!.getBoundingClientRect();
        const box = element.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(element);
        const text = range.getBoundingClientRect();
        return { card: [card.left, card.right], pill: [box.left, box.right], text: [text.left, text.right] };
      });
      expect(bounds.pill[0]!).toBeGreaterThanOrEqual(bounds.card[0]!);
      expect(bounds.pill[1]!).toBeLessThanOrEqual(bounds.card[1]!);
      expect(bounds.text[0]!).toBeGreaterThanOrEqual(bounds.pill[0]!);
      expect(bounds.text[1]!).toBeLessThanOrEqual(bounds.pill[1]!);
    }
  });
}

for (const shell of ['classic', 'modern'] as const) {
  for (const language of ['en', 'de']) {
    test(`the ${shell} provider setup and edit fit on a phone in ${language}`, { tag: shell === 'modern' ? '@modern' : [] }, async ({ page }) => {
      const de = language === 'de';
      await page.setViewportSize({ width: 390, height: 844 });
      await page.addInitScript((value) => localStorage.setItem('caotang.interface', value), shell);
      await fakeEndpoint(page, planThenAnswer({ reply: 'unused' }));
      await page.goto('/');
      await page.getByTestId('open-settings').click();
      const settings = page.getByTestId('settings');
      if (de) await selectLanguage(page, settings, language);
      await settings.locator('[data-section="providers"]').click();
      const form = settings.locator('form.profile-form');
      await form.getByRole('button', { name: de ? 'Eigener Endpunkt' : 'Custom endpoint', exact: true }).click();
      await expectProviderControlsToFit(form);
      await page.setViewportSize({ width: 360, height: 844 });
      await expectProviderControlsToFit(form);
      await page.setViewportSize({ width: 390, height: 844 });
      await form.locator('input[type="url"]').fill(FAKE_ENDPOINT);
      await form.getByRole('button', { name: de ? 'Verbinden und Modelle auflisten' : 'Connect and list models', exact: true }).click();
      await settings.getByRole('option', { name: 'test-model' }).click();
      await settings.getByRole('button', { name: de ? 'Erledigt' : 'Done', exact: true }).click();

      const profile = 'Coastal demo';
      const row = settings.locator('.profile-row:not([data-state="demo"])');
      await row.getByRole('button', { name: de ? 'Bearbeiten' : 'Edit', exact: true }).click();
      await expect(form.getByRole('listbox')).toBeVisible();
      await form.locator('.advanced-trigger').click();
      await expectProviderControlsToFit(form);
      const name = form.getByRole('textbox', { name: 'Name', exact: true });
      await name.press('ControlOrMeta+a');
      await name.pressSequentially(profile);
      await expect(name).toBeFocused();
      await form.getByRole('button', { name: de ? 'Änderungen speichern' : 'Save changes', exact: true }).click();
      await expect(row).toContainText(profile);
      await page.reload();
      await page.getByTestId('open-settings').click();
      await settings.locator('[data-section="providers"]').click();
      await expect(row).toContainText(profile);
    });
  }
}
