import { readFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import { DEMO_INTENTS } from '../packages/gateway/src/mock/index.js';
import { parseTrace } from '../packages/harness/src/agent/trace.js';

/**
 * The Trace tab (agent-harness §5.2) on the demo provider, so no key is needed: a turn appears as a timeline, a model call opens to what
 * it was sent and what came back, the export downloads a file `parseTrace` reads, the export that leaves out manuscript text carries none,
 * and with the setting off nothing is recorded. The sample project is opened by the first-run card's read-only demo.
 */

async function openSample(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  await expect(page.locator('.agent-report-text').first()).toBeVisible();
}

async function openTrace(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Trace' }).click();
  await expect(page.getByTestId('trace-panel')).toBeVisible();
}

test('a demo turn is a timeline in the Trace tab, and a model call opens to its messages and its reply', async ({ page }) => {
  await openSample(page);
  await openTrace(page);

  const turns = page.getByTestId('trace-turn');
  await expect(turns).toHaveCount(1);
  const turn = turns.first();
  await expect(turn.getByRole('button', { expanded: true })).toContainText(DEMO_INTENTS.continuity);
  await expect(page.getByText('Kept in this tab', { exact: false }).or(page.getByText('stays in this tab', { exact: false })).first()).toBeVisible();

  const call = turn.getByTestId('trace-call').first();
  await expect(call).toContainText('Model call 1');
  // A call is closed until it is asked for, and its system prompt is closed inside it.
  await expect(call.locator('pre')).toHaveCount(0);
  await call.locator('summary').first().click();
  await expect(call.getByRole('heading', { name: /^Sent: \d+ messages/ })).toBeVisible();
  await expect(call.locator('details.trace-message').first()).not.toHaveJSProperty('open', true);
  await expect(call.locator('pre').filter({ hasText: DEMO_INTENTS.continuity }).first()).toBeVisible();
  await expect(call.getByRole('heading', { name: 'Reply' })).toBeVisible();

  // The tool rows carry their risk and outcome.
  const tool = turn.getByTestId('trace-tool').first();
  await expect(tool).toContainText('read');
  await expect(tool).toContainText('ok');
  // Each bar has a text equivalent.
  await expect(call.locator('.visually-hidden').first()).toContainText('ms in');
});

test('the tab is operable from the keyboard: a turn opens with Enter, a call with Space', async ({ page }) => {
  await openSample(page);
  await openTrace(page);
  const head = page.getByTestId('trace-turn').first().getByRole('button', { expanded: true });
  await head.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('trace-turn').first().getByRole('button', { expanded: false })).toBeVisible();
  await page.keyboard.press('Enter');
  const summary = page.getByTestId('trace-call').first().locator('summary').first();
  await summary.focus();
  await page.keyboard.press('Space');
  await expect(page.getByTestId('trace-call').first().getByRole('heading', { name: 'Reply' })).toBeVisible();
});

test('Export trace downloads JSONL that parseTrace reads, and the file carries the prompts that were sent', async ({ page }) => {
  await openSample(page);
  await openTrace(page);

  await page.getByRole('button', { name: 'Export trace…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export trace' });
  await expect(dialog).toContainText('prompts and the manuscript text that were sent');
  await expect(dialog).toContainText('best-effort');
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Export', exact: true }).click()]);
  expect(download.suggestedFilename()).toMatch(/-trace-.+\.turn-1\.jsonl$/);

  const path = await download.path();
  const text = readFileSync(path, 'utf8');
  const parsed = parseTrace(text);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  const kinds = parsed.value.map((record) => record.kind);
  expect(kinds[0]).toBe('header');
  expect(kinds).toContain('turn.start');
  expect(kinds).toContain('model.request');
  expect(kinds).toContain('model.response');
  expect(kinds.at(-1)).toBe('turn.end');
  expect(text).toContain(DEMO_INTENTS.continuity);
});

test('Leave out manuscript text exports the structure with every text replaced by its length', async ({ page }) => {
  await openSample(page);
  await openTrace(page);

  await page.getByRole('button', { name: 'Export trace…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export trace' });
  await dialog.getByRole('checkbox', { name: 'Leave out manuscript text' }).check();
  await dialog.getByRole('radio', { name: 'All turns in this tab' }).check();
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Export', exact: true }).click()]);
  expect(download.suggestedFilename()).toMatch(/-trace-all\.jsonl$/);

  const text = readFileSync(await download.path(), 'utf8');
  expect(parseTrace(text).ok).toBe(true);
  expect(text).not.toContain(DEMO_INTENTS.continuity);
  expect(text).not.toContain('Lighthouse');
  expect(text).toContain('"omitted":{"chars":');
  expect(text).toContain('"gen_ai.usage.input_tokens"');
});

test('Clear trace empties the tab, and with the setting off a new turn records nothing', async ({ page }) => {
  await openSample(page);
  await openTrace(page);
  await expect(page.getByTestId('trace-turn')).toHaveCount(1);

  await page.getByRole('button', { name: 'Clear trace' }).click();
  await expect(page.getByRole('heading', { name: 'No turns traced yet' })).toBeVisible();

  await page.getByTestId('trace-keep').uncheck();
  await expect(page.getByRole('heading', { name: 'Traces are off' })).toBeVisible();
  const field = page.getByRole('combobox', { name: 'Intent' });
  await field.fill(DEMO_INTENTS.continuity);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.agent-report-text').nth(1)).toBeVisible();

  await page.getByTestId('trace-keep').check();
  await expect(page.getByRole('heading', { name: 'No turns traced yet' })).toBeVisible();
});

test('a reload loses the trace', async ({ page }) => {
  await openSample(page);
  await openTrace(page);
  await expect(page.getByTestId('trace-turn')).toHaveCount(1);
  await page.reload();
  // The project is kept; the turn is not. Open the project again from the list.
  await page.getByRole('listitem').getByRole('button', { name: 'Open' }).first().click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  await openTrace(page);
  await expect(page.getByTestId('trace-turn')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'No turns traced yet' })).toBeVisible();
});
