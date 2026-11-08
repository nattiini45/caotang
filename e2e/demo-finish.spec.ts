import { expect, test } from '@playwright/test';

import { DEMO_INTENTS, DEMO_REFUSAL } from '../packages/gateway/src/mock/index.js';

import { NO_PIN } from './classic-pin.js';
import { bodyOf, idOf, trace } from './support.js';

test.use({ storageState: NO_PIN });

for (const demo of [
  { name: 'draft', intent: DEMO_INTENTS.draftScene, tool: 'scene.draft', output: 'The ferry came in on the evening tide' },
  { name: 'synopses', intent: DEMO_INTENTS.fillSynopses, tool: 'synopsis.fill', output: 'A storm takes the lamp' },
]) {
  test(`the demo ${demo.name} finish offers a provider for a refusal, but not a held plan or an applied write`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/');
    await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();

    const panel = page.getByTestId('agent-panel');
    const reports = panel.locator('.agent-report-text');
    const addProvider = panel.getByRole('button', { name: 'Add a provider', exact: true });
    await expect(reports).toHaveCount(1);
    await expect(reports.last()).toContainText('continuity finding');
    await expect(addProvider).toHaveCount(0);

    await panel.getByRole('radio', { name: 'Plan only', exact: true }).check();
    await panel.getByRole('combobox', { name: 'Intent' }).fill('Write a new scene about a moonlit harbour.');
    await panel.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(reports).toHaveCount(2);
    await expect(reports.last()).toHaveText(DEMO_REFUSAL);
    await expect(addProvider).toBeVisible();

    await addProvider.click();
    const settings = page.getByTestId('settings');
    await expect(settings.getByRole('heading', { name: 'Providers', exact: true })).toBeVisible();
    await settings.getByRole('button', { name: 'Close', exact: true }).click();

    const before = await trace(page);
    await panel.getByRole('combobox', { name: 'Intent' }).fill(demo.intent);
    await panel.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(reports).toHaveCount(3);
    await expect(reports.last()).toContainText('Plan:');
    await expect(reports.last()).toContainText('Nothing was written.');
    const held = panel.getByTestId('held-plan');
    await expect(held).toContainText('Plan only: 1 step not run');
    await expect(panel.getByTestId('checkpoint')).toHaveCount(0);
    await expect(addProvider).toHaveCount(0);
    expect(await trace(page)).toEqual(before);

    await held.getByRole('button', { name: 'Switch to Ask and run this plan' }).click();
    const card = panel.getByTestId('plan-card');
    await expect(card).toContainText(demo.tool);
    await expect(addProvider).toHaveCount(0);
    await card.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(panel.getByTestId('checkpoint')).toBeVisible();
    await expect(reports).toHaveCount(4);
    await expect(reports.last()).toContainText('Applied:');
    await expect(addProvider).toHaveCount(0);

    if (demo.tool === 'scene.draft') {
      const friend = await idOf(page, 'The Friend');
      expect(await bodyOf(page, friend)).toContain(demo.output);
    } else {
      const synopsis = await page.evaluate(() => {
        const hook = (globalThis as unknown as { __caotang?: { tree(): { title: string; synopsis: string }[] } }).__caotang;
        return hook?.tree().find((node) => node.title === 'The Storm')?.synopsis;
      });
      expect(synopsis).toContain(demo.output);
    }
  });
}
