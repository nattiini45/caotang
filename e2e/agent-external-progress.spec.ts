import { expect, test, type Page } from '@playwright/test';

import { fakeEndpoint, useFakeEndpoint as chooseFakeEndpoint, type FakeAnswer, type FakeReply } from './endpoint.js';

/**
 * A long external call in the agent panel (extensibility §3.3, §6): the server’s progress shows on the call’s running card as a bar and its
 * own words, Stop reaches the call in flight and the card says what is true, and a write that was stopped is not reported as one that did
 * nothing. The server is the development fixture the MCP settings spec uses, with a slow tool, and the model is the fake endpoint, so
 * nothing leaves the page.
 */

const FIXTURE_URL = 'https://tools.example.com/mcp';
const call = (id: string, name: string, args: unknown) => ({ id, name, arguments: JSON.stringify(args) });

/** The qualified name of a loaded server tool, from the tools the request declares. */
const loaded = (tools: readonly string[] | undefined, tool: string): string => tools?.find((name) => name.startsWith('mcp__') && name.endsWith(`__${tool}`)) ?? `missing_${tool}`;

const model: FakeReply = (request): FakeAnswer | string => {
  const intent = (text: string): boolean => request.user.includes(`Request: ${text}`);
  const turn = request.assistantTurns;
  if (intent('Search the shelf for Hanne.')) {
    if (turn === 0) return { text: 'Find the lore tool.', toolCalls: [call('c1', 'tool.search', { query: 'lore' })] };
    if (turn === 1) return { text: 'Search for Hanne.', toolCalls: [call('c2', loaded(request.tools, 'search_lore'), {})] };
    return { text: 'Done.' };
  }
  if (intent('Send a note to the story bible.')) {
    if (turn === 0) return { text: 'Find the note tool.', toolCalls: [call('c3', 'tool.search', { query: 'note' })] };
    if (turn === 1) return { text: 'Send it.', toolCalls: [call('c4', loaded(request.tools, 'write_note'), { text: 'A note.' })] };
    return { text: 'Sent.' };
  }
  return { text: 'Done.' };
};

/** A fixture server whose `tool` reports two stages of progress and then holds until the call is stopped. */
async function fixtureServer(page: Page, tool: string): Promise<void> {
  await page.addInitScript(
    ({ url, slowTool }) => {
      (globalThis as unknown as { __caotangMcpFixture: unknown }).__caotangMcpFixture = {
        [url]: {
          tools: [
            { name: 'search_lore', description: 'Finds entries in the story bible.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
            { name: 'write_note', description: 'Writes a note into the story bible.', inputSchema: { type: 'object' } },
          ],
          content: [{ type: 'text', text: 'Hanne keeps the light.' }],
          slow: {
            tool: slowTool,
            progress: [
              { progress: 1, total: 4, message: 'Reading the shelf' },
              { progress: 2, total: 4, message: 'Cross-checking the entries' },
            ],
            hold: true,
          },
        },
      };
    },
    { url: FIXTURE_URL, slowTool: tool },
  );
}

/** Connects the fixture server as a person would: switch on, add, connect, approve the tool list, trust its reads. */
async function connectServer(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'MCP & tools' }).click();
  await settings.getByTestId('mcp-master').check();
  const form = settings.getByRole('form', { name: 'Add a server' });
  await form.getByLabel('Name').fill('Story bible');
  await form.getByLabel('Server address (https://…, or http://localhost…)').fill(FIXTURE_URL);
  await form.getByRole('button', { name: 'Add server' }).click();
  const bible = settings.locator('[data-server="Story bible"]');
  await bible.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(bible.getByTestId('mcp-state')).toHaveText('Connected');
  await bible.getByRole('button', { name: 'Approve this tool list' }).click();
  await expect(bible.getByTestId('mcp-state')).toHaveText('Healthy');
  await bible.getByRole('checkbox', { name: 'Trusted for reads: Story bible' }).check();
  await settings.getByRole('button', { name: 'Close' }).click();
}

async function ready(page: Page, slowTool: string): Promise<void> {
  await fixtureServer(page, slowTool);
  await fakeEndpoint(page, model);
  await chooseFakeEndpoint(page);
  await connectServer(page);
  await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
}

async function sendIntent(page: Page, intent: string): Promise<void> {
  const field = page.getByRole('combobox', { name: 'Intent' });
  await expect(field).toBeEnabled();
  await field.fill(intent);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

const cancelledCalls = (page: Page): Promise<number> =>
  page.evaluate(() => (globalThis as unknown as { __caotangMcpFixtureCancelled?: number }).__caotangMcpFixtureCancelled ?? 0);

test('a read shows the server’s progress on its running card, and Stop ends the call and the card', async ({ page }) => {
  await ready(page, 'search_lore');
  await sendIntent(page, 'Search the shelf for Hanne.');

  const card = page.locator('.status-card[data-status="running"]').filter({ hasText: 'search_lore' });
  const progress = card.getByTestId('call-progress');
  // The bar is the server’s own total, and the words say the same, so the bar is never the only signal.
  await expect(progress).toContainText('2 of 4');
  await expect(progress).toContainText('The server says: Cross-checking the entries');
  await expect(progress.getByRole('progressbar', { name: /Progress of .*search_lore/ })).toHaveAttribute('value', '0.5');

  await page.getByTestId('agent-stop').click();
  const stopped = page.locator('.status-card[data-status="failed"]').filter({ hasText: 'search_lore' });
  // The finished calls of a turn are folded into one group, so the card is in the page but may not be open.
  await expect(stopped).toHaveCount(1);
  await expect(stopped).toContainText('the writer stopped the turn before this step finished');
  // The progress is gone with the running state, and the server was told to stop.
  await expect(stopped.getByTestId('call-progress')).toHaveCount(0);
  await expect.poll(() => cancelledCalls(page)).toBe(1);
});

test('a write that was stopped says the server may already have done part of the work', async ({ page }) => {
  await ready(page, 'write_note');
  await sendIntent(page, 'Send a note to the story bible.');

  const confirm = page.getByTestId('plan-card');
  await expect(confirm).toContainText('write_note');
  await confirm.getByRole('button', { name: 'Approve', exact: true }).click();

  const running = page.locator('.status-card[data-status="running"]').filter({ hasText: 'write_note' });
  await expect(running.getByTestId('call-progress')).toContainText('2 of 4');

  await page.getByTestId('agent-stop').click();
  const stopped = page.locator('.status-card[data-status="failed"]').filter({ hasText: 'write_note' });
  await expect(stopped).toContainText('the server may already have done part of the work');
  await expect(stopped.locator('summary', { hasText: 'Why it did not finish' })).toHaveCount(1);
  await expect.poll(() => cancelledCalls(page)).toBe(1);
  // The turn’s summary does not say nothing was written.
  await expect(page.locator('.agent-turn').last()).toContainText('did not finish, so the server may already have done part of the work');
});
