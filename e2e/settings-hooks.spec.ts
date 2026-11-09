import { expect, test, type Page } from '@playwright/test';
import { bodyOf, traceNames, treeOf, waitForSaved } from './support.js';

async function openHooks(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByTestId('settings').getByRole('button', { name: 'Hooks', exact: true }).click();
}

async function sample(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  await openHooks(page);
}

async function newPattern(page: Page): Promise<void> {
  const panel = page.getByTestId('hook-settings');
  await panel.getByRole('button', { name: 'Add hook', exact: true }).click();
  await panel.getByLabel('Name', { exact: true }).fill('No suddenly');
  await panel.getByLabel('Word or phrase', { exact: true }).fill('suddenly');
  await panel.getByLabel('Message when found', { exact: true }).fill('Let the action carry the surprise.');
}

test('Hooks is project-only and explains how to begin without a project', async ({ page }) => {
  await page.goto('/');
  await openHooks(page);
  await expect(page.getByText('Open a project to manage its hooks.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add hook', exact: true })).toHaveCount(0);
});

test('create, edit, toggle, test and delete a project hook without a provider or project writes during tests', async ({ page }) => {
  await sample(page);
  const panel = page.getByTestId('hook-settings');
  await newPattern(page);
  await panel.getByLabel('Tools (optional, comma-separated)', { exact: true }).fill('notes.append, scene.*');
  await panel.getByRole('button', { name: 'Save hook', exact: true }).click();
  const row = panel.getByTestId('hook-row');
  await expect(row).toContainText('No suddenly');
  await row.getByRole('checkbox').uncheck();
  await expect(row.getByRole('checkbox')).not.toBeChecked();
  await row.getByRole('button', { name: /Edit/ }).click();
  await expect(panel.getByLabel('Tools (optional, comma-separated)')).toHaveValue('notes.append, scene.*');
  await panel.getByRole('button', { name: 'Test hook', exact: true }).click();
  const testPanel = panel.getByRole('region', { name: 'Hook test' });
  await expect(testPanel.getByLabel('Test document', { exact: true })).toBeFocused();
  await expect(panel.getByRole('button', { name: 'Test hook', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await testPanel.getByRole('button', { name: 'Run test', exact: true }).click();
  await expect(panel.getByTestId('hook-test-result')).toContainText('Not run.');
  await panel.getByRole('form').getByLabel('Enabled', { exact: true }).check();
  await panel.getByRole('button', { name: 'Test hook', exact: true }).click();
  await testPanel.getByLabel('Text to test', { exact: true }).fill('Suddenly the light went out.');
  const tree = await treeOf(page);
  const document = tree.find((node) => node.type === 'document');
  if (document === undefined) throw new Error('sample has no document');
  await testPanel.getByLabel('Test document', { exact: true }).selectOption(document.id);
  await testPanel.getByLabel('Text to test', { exact: true }).fill('Suddenly the light went out.');
  const body = await bodyOf(page, document.id);
  const commands = await traceNames(page);
  const providerRequests: string[] = [];
  page.on('request', (request) => { if (request.method() === 'POST') providerRequests.push(request.url()); });
  await testPanel.getByRole('button', { name: 'Run test', exact: true }).click();
  const result = panel.getByTestId('hook-test-result');
  await expect(result).toContainText('Warning:');
  await expect(result).toContainText('tool.before');
  await expect(result).toContainText('notes.append');
  await expect(result).toContainText(document.title);
  await expect(result).toContainText('Let the action carry the surprise.');
  await panel.getByLabel('When the check fails', { exact: true }).selectOption('block');
  await panel.getByRole('button', { name: 'Test hook', exact: true }).click();
  await testPanel.getByLabel('Text to test', { exact: true }).fill('Suddenly the light went out.');
  await testPanel.getByRole('button', { name: 'Run test', exact: true }).click();
  await expect(result).toContainText('Blocked:');
  await testPanel.getByLabel('Test issued by', { exact: true }).selectOption('user');
  await testPanel.getByRole('button', { name: 'Run test', exact: true }).click();
  await expect(result).toContainText('Not run.');
  await testPanel.getByLabel('Test issued by', { exact: true }).selectOption('agent');
  await testPanel.getByLabel('Text to test', { exact: true }).fill('The light went out.');
  await testPanel.getByRole('button', { name: 'Run test', exact: true }).click();
  await expect(result).toContainText('Passed:');
  expect(await bodyOf(page, document.id)).toBe(body);
  expect(await treeOf(page)).toEqual(tree);
  expect(await traceNames(page)).toEqual(commands);
  expect(providerRequests).toEqual([]);
  await panel.getByLabel('Name', { exact: true }).fill('Keep surprises concrete');
  await panel.getByRole('button', { name: 'Save hook', exact: true }).click();
  await expect(row).toContainText('Keep surprises concrete');
  await waitForSaved(page);
  await page.reload();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await openHooks(page);
  await expect(row.getByRole('checkbox')).toBeChecked();
  await row.getByRole('button', { name: /Edit/ }).click();
  await expect(panel.getByLabel('When the check fails')).toHaveValue('block');
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
  await row.getByRole('button', { name: /Delete/ }).click();
  await expect(row).toHaveCount(0);
  expect((await traceNames(page)).filter((name) => name === 'hook.delete')).toHaveLength(1);
});

test('all check kinds have labelled fields and invalid word bounds stay in the form', async ({ page }) => {
  await sample(page);
  const panel = page.getByTestId('hook-settings');
  await newPattern(page);
  await panel.getByLabel('Check', { exact: true }).selectOption('words');
  await panel.getByLabel('Minimum words (optional)').fill('10');
  await panel.getByLabel('Maximum words (optional)').fill('2');
  await panel.getByRole('button', { name: 'Save hook', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('min');
  await panel.getByLabel('Maximum words (optional)').fill('20');
  await panel.getByRole('button', { name: 'Test hook', exact: true }).click();
  await panel.getByLabel('Text to test').fill('A short sample.');
  await panel.getByRole('button', { name: 'Run test', exact: true }).click();
  await expect(panel.getByTestId('hook-test-result')).toContainText('Warning:');
  await panel.getByRole('button', { name: 'Save hook', exact: true }).click();
  await panel.getByTestId('hook-row').getByRole('button', { name: /Edit/ }).click();
  await expect(panel.getByLabel('Minimum words (optional)')).toHaveValue('10');
  await panel.getByLabel('Check', { exact: true }).selectOption('status');
  await panel.getByLabel('Allowed statuses (comma-separated)').fill('draft, revised');
  await panel.getByRole('button', { name: 'Save hook', exact: true }).click();
  await panel.getByTestId('hook-row').getByRole('button', { name: /Edit/ }).click();
  await expect(panel.getByLabel('Allowed statuses (comma-separated)')).toHaveValue('draft, revised');
  await panel.getByLabel('Check', { exact: true }).selectOption('coherence');
  await panel.getByLabel('pov.coverage', { exact: true }).uncheck();
  await panel.getByLabel('codex.alias-collisions', { exact: true }).check();
  await panel.getByLabel('Minimum finding severity').selectOption('warning');
  await panel.getByLabel('Block if the check cannot run (before events only)').check();
  await panel.getByRole('button', { name: 'Save hook', exact: true }).click();
  await panel.getByTestId('hook-row').getByRole('button', { name: /Edit/ }).click();
  await expect(panel.getByLabel('codex.alias-collisions', { exact: true })).toBeChecked();
  await expect(panel.getByLabel('pov.coverage', { exact: true })).not.toBeChecked();
  await expect(panel.getByLabel('Minimum finding severity')).toHaveValue('warning');
  await expect(panel.getByLabel('Block if the check cannot run (before events only)')).toBeChecked();
});

test('every event tests its actual input and after-events cannot block', async ({ page }) => {
  await sample(page);
  const panel = page.getByTestId('hook-settings');
  await newPattern(page);
  await panel.getByLabel('Issued by', { exact: true }).selectOption('any');
  await panel.getByLabel('When the check fails').selectOption('block');
  for (const event of ['tool.before', 'tool.after', 'export.before', 'export.after', 'project.save', 'turn.submit', 'turn.end']) {
    await panel.getByLabel('Event', { exact: true }).selectOption(event);
    await panel.getByRole('button', { name: 'Test hook', exact: true }).click();
    const tool = event.startsWith('tool.') ? 'notes.append' : event.startsWith('export.') ? 'export.compile' : '';
    await expect(panel.getByLabel('Test tool', { exact: true })).toHaveValue(tool);
    await panel.getByLabel('Text to test').fill('Suddenly a wave broke.');
    await panel.getByRole('button', { name: 'Run test', exact: true }).click();
    const result = panel.getByTestId('hook-test-result');
    await expect(result).toContainText(event);
    await expect(result).toContainText(['tool.before', 'export.before', 'turn.submit'].includes(event) ? 'Blocked:' : event === 'tool.after' ? 'Note:' : 'Warning:');
  }
});
