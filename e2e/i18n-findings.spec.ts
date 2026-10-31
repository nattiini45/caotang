import { expect, test, type Page } from '@playwright/test';

import { binderTitle, createProject, waitForSaved } from './support.js';

/**
 * The I7 acceptance demonstration (i18n.md §3.2, §6.2, §8.3): a deterministic timeline finding is
 * written once in English and rendered in the pseudo interface language after a live switch, with
 * each scene title isolated exactly once. The pseudo catalogue is enabled through the local flag,
 * as in `i18n-switch.spec.ts`; no provider or model is involved.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('caotang.pseudo', '1');
  });
});

async function openDeclarations(page: Page): Promise<void> {
  const meta = page.getByTestId('scene-meta');
  if ((await meta.getAttribute('open')) === null) await meta.locator('summary').click();
}

/** The two declared scenes and a scan, as `findings.spec.ts` builds them: one timeline drift finding. */
async function scannedDrift(page: Page): Promise<void> {
  await createProject(page, 'Finding Language');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  for (const scene of ['Opening', 'Prologue']) {
    await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
    await page.getByRole('textbox', { name: 'Rename Untitled' }).fill(scene);
    await page.keyboard.press('Enter');
    await expect(binderTitle(page, scene)).toBeVisible();
  }

  const surface = page.getByRole('textbox', { name: 'Document text' });
  await binderTitle(page, 'Opening').click();
  await openDeclarations(page);
  await page.getByRole('spinbutton', { name: 'Day offset' }).fill('5');
  await page.getByRole('spinbutton', { name: 'Day offset' }).press('Enter');
  await surface.click();
  await page.keyboard.type('The ferry was late, as always.');
  await waitForSaved(page);

  await binderTitle(page, 'Prologue').click();
  await openDeclarations(page);
  await page.getByRole('spinbutton', { name: 'Day offset' }).fill('1');
  await page.getByRole('spinbutton', { name: 'Day offset' }).press('Enter');
  await surface.click();
  await page.keyboard.type('Long before, the island sank.');
  await waitForSaved(page);

  await page.getByRole('tab', { name: 'Findings' }).click();
  await page.getByRole('button', { name: 'Scan the manuscript' }).click();
  await expect(page.locator('.finding-message').first()).toContainText('comes before');
}

test('a pseudo-locale run shows a localised timeline finding with each title isolated once', async ({ page }) => {
  await scannedDrift(page);

  // The stored English is what the scan wrote; the reference is beside it.
  const english = ((await page.locator('.finding-message').first().textContent()) ?? '').replace(/[\u2068\u2069]/g, '');
  expect(english).toContain('"Opening" comes before "Prologue" in the binder');

  await page.getByTestId('open-settings').click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Appearance' }).click();
  await settings.locator('input[name="interface-language"][value="en-XA"]').click();
  await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('en-XA');
  // Close by structure: the button's words are pseudo text after the switch.
  await settings.locator('.settings-head button').click();

  const message = (await page.locator('.finding-message').first().textContent()) ?? '';
  // The catalogue translated the frame, so the pseudo brackets are present.
  expect(message).toContain('⟦');
  // Each writer title is isolated once, with no doubled FSI/PDI pair.
  expect(message).toContain('\u2068Opening\u2069');
  expect(message).toContain('\u2068Prologue\u2069');
  expect(message).not.toContain('\u2068\u2068');
  expect(message).not.toContain('\u2069\u2069');
  // A message with values rendered as a sentence: no ICU placeholder survived.
  expect(message).not.toMatch(/\{[a-zA-Z]+\}/);

  const panel = page.getByTestId('findings-panel');
  for (const selector of ['.findings-head .eyebrow', '.findings-count', '.findings-coverage', '.finding-type', '.status-chip']) {
    await expect(panel.locator(selector).first()).toContainText('⟦');
  }
  for (const option of await panel.locator('.findings-actions option').all()) {
    await expect(option).toContainText('⟦');
  }
  await expect(panel.locator('.findings-actions button').first()).toContainText('⟦');
  await expect(panel.getByTestId('run-history').locator('li').first()).toContainText('⟦');
  await panel.locator('[data-dismiss]').first().click();
  const picker = page.getByTestId('dismiss-picker');
  await expect(picker.locator('legend')).toContainText('⟦');
  for (const reason of await picker.locator('.dismiss-reason > span:first-of-type').all()) {
    await expect(reason).toContainText('⟦');
  }
  await expect(picker.locator('textarea')).toHaveAttribute('aria-label', /⟦/);
  await expect(page.getByTestId('scene-meta').locator('summary')).toContainText('⟦');
  await expect(page.getByTestId('scene-meta').locator('input[type="number"]').first()).toHaveAttribute('aria-label', /⟦/);
  await expect(page.locator('[contenteditable="true"][role="textbox"]')).toContainText('Long before, the island sank.');
});
