import { expect } from '@playwright/test';
import { DEMO_INTENTS } from '../packages/gateway/src/mock/index.js';
import { setUp, test } from './modern-walk.js';

test.use({ setup: 'draft' });

test('the agent header keeps spend and lifecycle readable while a draft awaits approval', { tag: '@modern' }, async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await setUp(page, 'draft');
  await page.getByTestId('modern-ask').click();
  const intent = page.getByRole('combobox', { name: 'Intent' });
  await intent.fill(DEMO_INTENTS.draftScene);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('ghost-bar')).toBeAttached();
  const step = page.getByTestId('agent-step');
  const spend = page.getByTestId('agent-spend');
  await expect(spend).toContainText(/tokens/);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const line of [step, spend]) {
      await expect(line).toBeInViewport();
      const clipped = await line.evaluate((element) =>
        element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight,
      );
      expect(clipped, `${await line.getAttribute('data-testid')} at ${width}px`).toBe(false);
    }
    await expect(page.getByTestId('agent-close')).toBeInViewport();
  }
});
