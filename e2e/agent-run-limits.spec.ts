import { expect, test, type Page } from '@playwright/test';

import { DEMO_INTENTS } from '../packages/gateway/src/mock/index.js';

/**
 * Run limits (agent-harness §7.1) in Settings › Agent and the agent panel, on the demo provider so no key is needed: the limits
 * round-trip through the app's own database, and a turn that reaches the model-call limit stops on a card that says so, with
 * nothing written. The sample project is opened by the first-run card's read-only demo, which writes nothing.
 */

async function openSample(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  await expect(page.locator('.agent-report-text').first()).toBeVisible();
}

async function openAgentSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Agent', exact: true }).click();
  return settings;
}

test('the run limits are saved in the app database and are there after a reload', async ({ page }) => {
  await page.goto('/');
  let settings = await openAgentSettings(page);
  await settings.getByLabel('Model calls per turn').fill('3');
  await settings.getByLabel('Minutes of work per turn').fill('20');
  await settings.getByLabel('Tokens per turn').fill('40000');
  await settings.getByLabel('Cost per turn, in dollars').fill('0.25');
  await settings.getByRole('button', { name: 'Save limits' }).click();
  await expect(settings.getByText('Saved. It applies from the next card.')).toBeVisible();

  await page.reload();
  settings = await openAgentSettings(page);
  await expect(settings.getByLabel('Model calls per turn')).toHaveValue('3');
  await expect(settings.getByLabel('Minutes of work per turn')).toHaveValue('20');
  await expect(settings.getByLabel('Tokens per turn')).toHaveValue('40000');
  await expect(settings.getByLabel('Cost per turn, in dollars')).toHaveValue('0.25');
});

test('a value outside its range is refused in words, and nothing is saved', async ({ page }) => {
  await page.goto('/');
  const settings = await openAgentSettings(page);
  await settings.getByLabel('Model calls per turn').fill('0');
  await settings.getByRole('button', { name: 'Save limits' }).click();
  await expect(settings.getByRole('alert')).toContainText('Model calls per turn is a whole number from 1 to 100');
});

test('a turn that reaches the model-call limit stops on a card that says so, and writes nothing', async ({ page }) => {
  await page.goto('/');
  const settings = await openAgentSettings(page);
  await settings.getByLabel('Model calls per turn').fill('1');
  await settings.getByRole('button', { name: 'Save limits' }).click();
  await expect(settings.getByText('Saved. It applies from the next card.')).toBeVisible();
  await settings.getByRole('button', { name: 'Close' }).click();

  await openSample(page);
  const field = page.getByRole('combobox', { name: 'Intent' });
  await expect(field).toBeEnabled();
  await field.fill(DEMO_INTENTS.fillSynopses);
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  const limit = page.getByRole('complementary', { name: 'Needs your input' }).last();
  await expect(limit).toBeVisible();
  await expect(limit).toContainText('made 1 model calls');
  await expect(page.getByTestId('plan-card')).toHaveCount(0);
  const synopsis = await page.evaluate(() => {
    const caotang = (globalThis as unknown as { __caotang?: { tree(): { title: string; synopsis: string }[] } }).__caotang;
    return caotang?.tree().find((row) => row.title === 'The Storm')?.synopsis ?? '';
  });
  expect(synopsis).toBe('');
});

test('a cost limit on a profile with no prices stops the turn before any request, in the words of the limit', async ({ page }) => {
  await page.goto('/');
  const settings = await openAgentSettings(page);
  await settings.getByLabel('Cost per turn, in dollars').fill('1');
  await settings.getByRole('button', { name: 'Save limits' }).click();
  await expect(settings.getByText('Saved. It applies from the next card.')).toBeVisible();
  await settings.getByRole('button', { name: 'Close' }).click();

  await openSample(page);
  const field = page.getByRole('combobox', { name: 'Intent' });
  await expect(field).toBeEnabled();
  await field.fill(DEMO_INTENTS.fillSynopses);
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  const limit = page.getByRole('complementary', { name: 'The run reached a limit' }).last();
  await expect(limit).toBeVisible();
  await expect(limit).toContainText('This run has a cost limit, and the profile');
  await expect(limit).toContainText('has no prices, so its cost cannot be counted');
});
