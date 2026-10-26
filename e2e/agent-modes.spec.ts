import { expect, test, type Page } from '@playwright/test';

import { DEMO_INTENTS } from '../packages/gateway/src/mock/index.js';

/**
 * The permission modes (agent-harness §4) in the agent panel, on the demo provider so no key is needed: Plan only keeps a write it
 * refused as a plan nobody can approve, with the one way to run it; Accept edits applies the demo's synopses with no card, behind a
 * collapsed card with an auto-approved badge, and its checkpoint restores them; Settings can turn Auto off. The sample project is
 * opened by the first-run card's read-only demo, which runs the continuity scan and writes nothing.
 */

async function openSample(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  await expect(page.locator('.agent-report-text').first()).toBeVisible();
}

async function sendIntent(page: Page, intent: string): Promise<void> {
  const field = page.getByRole('combobox', { name: 'Intent' });
  await expect(field).toBeEnabled();
  await field.fill(intent);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

const modes = (page: Page) => page.getByRole('group', { name: 'Mode' });

async function synopsisOf(page: Page, title: string): Promise<string> {
  const found = await page.evaluate((wanted) => {
    const caotang = (globalThis as unknown as { __caotang?: { tree(): { title: string; synopsis: string }[] } }).__caotang;
    return caotang?.tree().find((row) => row.title === wanted)?.synopsis ?? null;
  }, title);
  return found ?? '';
}

test('the mode control is a radio group named by its visible label, Ask is on, and a pick moves the choice', async ({ page }) => {
  await openSample(page);
  await expect(modes(page)).toBeVisible();
  await expect(modes(page).getByRole('radio')).toHaveCount(4);
  await expect(modes(page).getByRole('radio', { name: 'Ask' })).toBeChecked();
  await modes(page).getByRole('radio', { name: 'Accept edits' }).check();
  await expect(modes(page).getByRole('radio', { name: 'Accept edits' })).toBeChecked();
  await expect(modes(page).getByRole('radio', { name: 'Ask' })).not.toBeChecked();
  // The turn row names the mode of the turn it belongs to.
  await expect(page.getByTestId('turn-mode').first()).toHaveText('Ask');
});

test('Plan only keeps the refused write as a plan with no Approve, and Switch to Ask runs it on a card the writer decides', async ({ page }) => {
  await openSample(page);
  await modes(page).getByRole('radio', { name: 'Plan only' }).check();
  await sendIntent(page, DEMO_INTENTS.fillSynopses);

  const held = page.getByTestId('held-plan');
  await expect(held).toBeVisible();
  await expect(held).toContainText('Plan only: 1 step not run');
  await expect(page.getByTestId('plan-card')).toHaveCount(0);
  await expect(held.getByRole('button', { name: /^Approve/ })).toHaveCount(0);
  await expect(page.locator('.status-card', { hasText: 'Plan-only mode' }).first()).toBeVisible();
  expect(await synopsisOf(page, 'The Storm')).toBe('');
  await expect(page.getByTestId('turn-mode').last()).toHaveText('Plan only');

  await held.getByRole('button', { name: 'Switch to Ask and run this plan' }).click();
  await expect(modes(page).getByRole('radio', { name: 'Ask' })).toBeChecked();
  const card = page.getByTestId('plan-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('synopsis.fill');
  await card.locator('button.is-primary').click();
  await expect(page.getByTestId('checkpoint')).toBeVisible();
  await expect.poll(() => synopsisOf(page, 'The Storm')).toMatch(/^A storm takes the lamp/);
});

test('Accept edits applies the demo synopses with no card, behind an auto-approved badge, and the checkpoint restores them', async ({ page }) => {
  await openSample(page);
  await modes(page).getByRole('radio', { name: 'Accept edits' }).check();
  await sendIntent(page, DEMO_INTENTS.fillSynopses);

  const auto = page.getByTestId('plan-auto');
  await expect(auto).toBeVisible();
  await expect(auto).toContainText('Auto-approved');
  // The card is collapsed: its steps are not open, and nothing waits for the writer.
  await expect(auto).not.toHaveAttribute('open', /.*/);
  await expect(page.getByTestId('plan-card')).toBeHidden();
  const checkpoint = page.getByTestId('checkpoint');
  await expect(checkpoint).toBeVisible();
  await expect(checkpoint).toContainText('Accept edits');
  await expect.poll(() => synopsisOf(page, 'The Storm')).toMatch(/^A storm takes the lamp/);

  await checkpoint.getByRole('button', { name: 'Restore to before this turn' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Restore', exact: true }).click();
  await expect.poll(() => synopsisOf(page, 'The Storm')).toBe('');
});

test('Settings › Agent can turn Auto off, and the panel stops offering it', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Agent', exact: true }).click();
  await settings.getByRole('radio', { name: /^Auto/ }).check();
  await settings.getByRole('checkbox', { name: 'Turn Auto mode off' }).check();
  await expect(settings.getByRole('radio', { name: /^Auto/ })).toHaveCount(0);
  await expect(settings.getByRole('radio', { name: /^Ask/ })).toBeChecked();
  await settings.getByRole('button', { name: 'Close' }).click();

  await openSample(page);
  await expect(modes(page).getByRole('radio')).toHaveCount(3);
  await expect(modes(page).getByRole('radio', { name: 'Auto' })).toHaveCount(0);
  await expect(modes(page).getByRole('radio', { name: 'Ask' })).toBeChecked();
});
