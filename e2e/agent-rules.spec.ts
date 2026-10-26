import { expect, test, type Page } from '@playwright/test';

import { DEMO_INTENTS } from '../packages/gateway/src/mock/index.js';

/**
 * The agent's rules (agent-harness §4, Rules) in the binder and in Settings, on the demo provider so no key is needed. A folder is marked
 * from its menu, the mark is an icon with words, and the demo agent's draft into it is refused as a failed card that names the rule and
 * writes nothing. Settings lists the rule and removes it, and the same draft then reaches a card. A folder marked as hidden is named in
 * the card's list of what the prompt left out. The sample project is opened by the first-run card's read-only demo.
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

async function setAccess(page: Page, folder: string, choice: string): Promise<void> {
  await page.locator('.binder-tree .row', { hasText: folder }).first().locator('.row-title').click({ button: 'right' });
  await page.getByRole('menu', { name: `Actions for ${folder}` }).getByRole('menuitemradio', { name: choice }).click();
}

async function bodyOf(page: Page, title: string): Promise<string> {
  return page.evaluate((wanted) => {
    const caotang = (globalThis as unknown as { __caotang?: { tree(): { id: string; title: string }[]; body(id: string): string | null } }).__caotang;
    const id = caotang?.tree().find((row) => row.title === wanted)?.id;
    return (id === undefined ? null : caotang?.body(id)) ?? '';
  }, title);
}

test('a folder marked read only refuses the demo agent’s draft into it as a failed card, and writes nothing', async ({ page }) => {
  await openSample(page);
  await setAccess(page, 'Chapter 2', 'Agent: may read only');

  // The mark is an icon and words, not colour alone.
  const row = page.locator('.binder-tree .row', { hasText: 'Chapter 2' }).first();
  await expect(row.locator('.row-agent')).toHaveText(/Agent: read only/);

  await sendIntent(page, DEMO_INTENTS.draftScene);
  const refused = page.locator('.status-card', { hasText: 'scene.draft' }).first();
  await expect(refused).toContainText('locked against changes by a rule in this project’s file');
  await expect(page.getByTestId('plan-card')).toHaveCount(0);
  expect(await bodyOf(page, 'The Friend')).toBe('');

  // The menu shows the choice that is in force.
  await page.locator('.binder-tree .row', { hasText: 'Chapter 2' }).first().locator('.row-title').click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Actions for Chapter 2' });
  await expect(menu.getByRole('menuitemradio', { name: 'Agent: may read only' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
});

test('Settings › Agent lists the rule with its folder, removing it lifts the lock, and the draft reaches a card', async ({ page }) => {
  await openSample(page);
  await setAccess(page, 'Chapter 2', 'Agent: may read only');

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Agent', exact: true }).click();
  const rules = settings.getByRole('list', { name: 'Rules in this project' });
  await expect(rules).toContainText('“Chapter 2” is read only for the agent');
  await rules.getByRole('button', { name: /^Remove rule/ }).click();
  await expect(settings.getByRole('list', { name: 'Rules in this project' })).toHaveCount(0);
  await settings.getByRole('button', { name: 'Close' }).click();

  await expect(page.locator('.binder-tree .row', { hasText: 'Chapter 2' }).first().locator('.row-agent')).toHaveCount(0);
  await sendIntent(page, DEMO_INTENTS.draftScene);
  await expect(page.getByTestId('plan-card')).toBeVisible();
});

test('a folder marked hidden is named in the card’s list of what the prompt left out', async ({ page }) => {
  await openSample(page);
  await setAccess(page, 'Chapter 1', 'Agent: may not read');
  await expect(page.locator('.binder-tree .row', { hasText: 'Chapter 1' }).first().locator('.row-agent')).toHaveText(/Agent: hidden/);

  await sendIntent(page, DEMO_INTENTS.draftScene);
  const card = page.getByTestId('plan-card');
  await expect(card).toBeVisible();
  await card.locator('details.context-preview summary').click();
  await expect(card.getByRole('list', { name: 'Left out' })).toContainText('Chapter 1 (folder): withheld by a read rule');
  await card.getByRole('button', { name: /^Cancel/ }).click();
});

test('a rule of your own that asks before a tool keeps Auto mode from approving its card', async ({ page }) => {
  await openSample(page);
  await page.getByRole('group', { name: 'Mode' }).getByRole('radio', { name: 'Auto' }).check();

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Agent', exact: true }).click();
  await settings.getByRole('combobox', { name: 'Tool' }).fill('scene.draft');
  await settings.getByRole('combobox', { name: 'Rule' }).selectOption('ask');
  await settings.getByRole('button', { name: 'Add rule' }).click();
  await expect(settings.getByRole('list', { name: 'Rules in every project' })).toContainText('Asks you before the agent uses scene.draft');
  await settings.getByRole('button', { name: 'Close' }).click();

  await sendIntent(page, DEMO_INTENTS.draftScene);
  // Auto would apply the draft at once; the rule makes the card the writer’s.
  await expect(page.getByTestId('plan-card')).toBeVisible();
  await expect(page.getByTestId('plan-auto')).toHaveCount(0);
  expect(await bodyOf(page, 'The Friend')).toBe('');
});
