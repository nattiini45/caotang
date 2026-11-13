import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { fakeEndpoint, useFakeEndpoint } from './endpoint.js';
import { projectTrace } from './support.js';
import { searchWhileTyping } from './text-search-flow.js';
import type * as Store from '../packages/store/src/index.js';

const STORE_URL = `/@fs/${fileURLToPath(new URL('../packages/store/src/index.ts', import.meta.url)).replaceAll('\\', '/').replace(/^\/+/, '')}`;

test('cold local passage search leaves typing responsive under the development CSP', async ({ page, context }) => {
  await searchWhileTyping(page, context);
});

test('a scoped read-ask waits for approval before starting local passage search', async ({ page }) => {
  const received: string[] = [];
  let workers = 0;
  page.on('worker', () => { workers++; });
  await fakeEndpoint(page, (request) => {
    if (request.tools === undefined) return 'Ready.';
    received.push(request.tool);
    if (request.assistantTurns === 0) return { text: '', toolCalls: [{ id: 'discover-search', name: 'tool.search', arguments: '{"query":"find project passages"}' }] };
    if (request.assistantTurns === 1) return { text: '', toolCalls: [{ id: 'find-ferry', name: 'text.search', arguments: '{"query":"ferry"}' }] };
    return { text: request.tool.includes('The ferry was late') ? 'The approved search found the ferry.' : 'No passage.' };
  });
  await useFakeEndpoint(page);
  await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
  await expect.poll(() => projectTrace(page)).toContain('coherence.scan');
  const panel = page.getByTestId('agent-panel');
  await expect(panel).toHaveAttribute('data-state', 'idle');
  const projectId = await page.evaluate(() => {
    const id = (globalThis as unknown as { __caotang?: { projectId(): string | null } }).__caotang?.projectId();
    if (id === undefined || id === null) throw new Error('The sample project must be open.');
    return id;
  });
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.evaluate(async ({ url, projectId }) => {
    const store = await import(/* @vite-ignore */ url) as typeof Store;
    const runtime = await store.openRuntimeStore(indexedDB);
    try {
      const state = await store.readProjectState(runtime, projectId);
      const folder = state.manifest.tree.find((node) => node.title === 'Chapter 1')!;
      state.manifest.agent = { ...state.manifest.agent, rules: [{ tool: 'text.search', effect: 'ask', access: 'read', scope: { subtree: folder.id } }] };
      await store.writeProjectState(runtime, state);
    } finally { runtime.close(); }
  }, { url: STORE_URL, projectId });
  await page.reload();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await panel.getByRole('button', { name: 'Agent', exact: true }).click();
  await expect(panel).toHaveAttribute('data-state', 'idle');
  await panel.getByRole('combobox', { name: 'Intent' }).fill('Find the ferry passage.');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  const card = page.getByTestId('plan-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('text.search');
  expect(received).toHaveLength(2);
  expect(workers).toBe(0);
  await card.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(panel.locator('.agent-turn').last()).toContainText('The approved search found the ferry.');
  expect(received).toHaveLength(3);
  expect(workers).toBe(1);
});

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
