import { expect, test } from '@playwright/test';
import { fakeEndpoint, useFakeEndpoint } from './endpoint.js';
import { projectTrace } from './support.js';

test('the agent discovers local passage search and reads its result without a manuscript write', async ({ page }) => {
  const received: string[] = [];
  await fakeEndpoint(page, (request) => {
    if (request.tools === undefined) return 'Ready.';
    received.push(request.tool);
    if (request.assistantTurns === 0) return { text: '', toolCalls: [{ id: 'discover-search', name: 'tool.search', arguments: JSON.stringify({ query: 'find project passages' }) }] };
    if (request.assistantTurns === 1) return { text: '', toolCalls: [{ id: 'find-ferry', name: 'text.search', arguments: JSON.stringify({ query: 'ferry', fields: ['body'] }) }] };
    return { text: request.tool.includes('The ferry was late') ? 'The ferry first appears in The Landing.' : 'The ferry passage was not returned.' };
  });
  await useFakeEndpoint(page);
  await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  const panel = page.getByTestId('agent-panel');
  await expect.poll(() => projectTrace(page)).toContain('coherence.scan');
  await expect(panel).toHaveAttribute('data-state', 'idle');
  const before = await projectTrace(page);
  await panel.getByRole('combobox', { name: 'Intent' }).fill('Where did I first mention the ferry?');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(panel.locator('.agent-turn').last()).toContainText('The ferry first appears in The Landing.');
  await expect(panel).toHaveAttribute('data-state', 'idle');
  expect(received).toHaveLength(3);
  const result = JSON.parse(received.at(-1)!.split('\n').at(-1)!);
  expect(result).toMatchObject({ ok: true, data: { total: 1, truncated: false, hits: [{ field: 'body', title: 'The Landing', snippet: { text: 'The ferry was late, as always.' } }] } });
  expect(await projectTrace(page)).toEqual(before);
  await expect(page.getByTestId('plan-card')).toHaveCount(0);
  await expect(page.getByTestId('checkpoint')).toHaveCount(0);
});
