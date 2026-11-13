import { expect, type BrowserContext, type Page } from '@playwright/test';
import { fakeEndpoint, useFakeEndpoint as configureEndpoint } from './endpoint.js';
import { binderTitle } from './support.js';

export async function searchWhileTyping(page: Page, context: BrowserContext): Promise<void> {
  const sent: string[] = [];
  const violations: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error' && /content.security.policy/i.test(message.text())) violations.push(message.text()); });
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  let workers = 0;
  await context.route(/text-search\.worker(?:\.ts|-[^/]+\.js)/, async (route) => {
    workers++;
    started();
    await held;
    await route.continue();
  });
  await fakeEndpoint(page, (request) => {
    if (request.tools === undefined) return 'Ready.';
    sent.push(request.tool);
    if (request.assistantTurns === 0) return { text: '', toolCalls: [{ id: 'discover', name: 'tool.search', arguments: '{"query":"find project passages"}' }] };
    if (request.assistantTurns === 1) return { text: '', toolCalls: [{ id: 'search', name: 'text.search', arguments: '{"query":"ferry"}' }] };
    return { text: request.tool.includes('The ferry was late') ? 'The local search returned the ferry passage.' : 'No passage.' };
  });
  try {
    await configureEndpoint(page);
    await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
    const panel = page.getByTestId('agent-panel');
    await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
    await expect(panel.locator('.agent-turn')).toHaveCount(1);
    await expect(panel).toHaveAttribute('data-state', 'idle');
    await binderTitle(page, 'The Landing').click();
    expect(workers).toBe(0);
    await panel.getByRole('combobox', { name: 'Intent' }).fill('Find the ferry passage.');
    await panel.getByRole('button', { name: 'Send', exact: true }).click();
    await entered;
    const editor = page.getByRole('textbox', { name: 'Document text' });
    await editor.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type(' The writer keeps typing.');
    await expect(editor).toContainText('The writer keeps typing.');
    expect(sent).toHaveLength(2);
    expect(workers).toBe(1);
    release();
    await expect(panel.locator('.agent-turn').last()).toContainText('The local search returned the ferry passage.');
    await expect(panel).toHaveAttribute('data-state', 'idle');
    expect(sent).toHaveLength(3);
    expect(violations).toEqual([]);
  } finally { release(); }
}
