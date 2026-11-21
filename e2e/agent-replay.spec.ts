import { expect, type Page } from '@playwright/test';
import { test } from './test.js';

import { DEMO_INTENTS } from '../packages/gateway/src/mock/index.js';

/**
 * **Replay…** on a traced turn (agent-harness §8.1), on the demo provider so no key is needed and nothing is spent: the action is on the
 * turn in the Trace tab, the dialog offers a mode only when the recording supports it, the estimate is shown before **Replay** is
 * offered, and a replay of the demo turn changes nothing in the project.
 *
 * The demo turn's model calls go through the mock provider, so a cassette replay answers from the recording and costs nothing — which is
 * the one mode an end-to-end run can exercise without a real provider. The writer-facing refusal for the other two is what these cases
 * pin: with no real profile saved there is nowhere to send them, and the dialog says so instead of failing on press.
 */

async function openSample(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  await expect(page.locator('.agent-report-text').first()).toBeVisible();
}

async function openReplay(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Trace' }).click();
  await expect(page.getByTestId('trace-panel')).toBeVisible();
  // The newest turn is open when the tab opens; open it only if it is not (a click on an open head would close it).
  const head = page.getByTestId('trace-turn').first().getByRole('button').first();
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  await page.getByTestId('trace-replay').first().click();
  await expect(page.getByRole('dialog', { name: 'Replay this turn' })).toBeVisible();
}

test('a traced turn offers Replay…, and the dialog says what it would cost before it sends anything', async ({ page }) => {
  await openSample(page);
  await openReplay(page);

  const dialog = page.getByRole('dialog', { name: 'Replay this turn' });
  await expect(dialog).toContainText(DEMO_INTENTS.continuity);
  // It says the replay cannot touch the manuscript, in the writer's own reading of it.
  await expect(dialog).toContainText('nothing here changes your manuscript');

  // Nothing can be run before the estimate is asked for.
  const replay = dialog.getByRole('button', { name: 'Replay', exact: true });
  await expect(replay).toBeDisabled();

  await dialog.getByRole('button', { name: 'What it would cost' }).click();
  await expect(dialog.getByTestId('replay-cost')).toBeVisible();
  await expect(dialog.getByTestId('replay-cost')).toContainText('prompt tokens');
  await expect(replay).toBeEnabled();
});

test('a cassette replay of the recorded turn runs with no key, makes no model call and leaves the project as it was', async ({ page }) => {
  await openSample(page);
  await openReplay(page);

  const dialog = page.getByRole('dialog', { name: 'Replay this turn' });
  // The demo profile answers from a script, so it is not a destination: only a cassette can run here.
  await expect(dialog.getByRole('radio', { name: /^One model call/ })).toBeDisabled();
  await expect(dialog.getByRole('radio', { name: /^The whole turn/ })).toBeDisabled();
  await expect(dialog.getByRole('radio', { name: /^From the recording, free/ })).toBeEnabled();
  // Each mode that needs a provider says why it cannot run, in its own row.
  await expect(dialog.getByText('No provider is saved, so there is nowhere to send this.', { exact: false }).first()).toBeVisible();

  await dialog.getByRole('button', { name: 'What it would cost' }).click();
  await dialog.getByRole('button', { name: 'Replay', exact: true }).click();

  // The comparison appears, and it says the project was not changed.
  await expect(dialog.getByTestId('replay-result')).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByTestId('replay-result')).toContainText('The project was not changed');
  // The recording's own turn applies one step, and the replay reaches the same end.
  await expect(dialog.getByTestId('replay-result')).toContainText(/applied|replied/);
});

test('Escape closes the dialog and puts the writer back on the turn they came from', async ({ page }) => {
  await openSample(page);
  await openReplay(page);

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Replay this turn' })).toHaveCount(0);
  await expect(page.getByTestId('trace-replay').first()).toBeFocused();
});
