import { expect, test, type Page } from '@playwright/test';
import { fakeEndpoint, planThenAnswer, useFakeEndpoint as addFakeProvider, type FakeRequest } from './endpoint.js';
import { binderRow } from './support.js';

async function sample(page: Page, seen: FakeRequest[]): Promise<void> {
  await fakeEndpoint(page, (request) => { seen.push(request); return request.tools === undefined ? JSON.stringify({ reply: 'Done.' }) : { text: 'Done.' }; });
  await addFakeProvider(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
  await expect(page.locator('.agent-report-text')).toHaveCount(1);
  seen.length = 0;
}

async function makeCommand(page: Page, name: string, body: string, extra = ''): Promise<void> {
  await page.getByRole('button', { name: 'Skills', exact: true }).click();
  const skills = page.getByRole('dialog', { name: 'Skills' });
  await skills.getByRole('button', { name: 'New skill…' }).click();
  await skills.getByRole('textbox', { name: /^Name/ }).fill(name);
  await skills.getByRole('button', { name: 'Create', exact: true }).click();
  await skills.getByRole('textbox', { name: 'Instructions', exact: true }).fill(`---\nname: ${name}\ndescription: A reusable writing request.\ndisable-model-invocation: true\narguments: [subject]\nargument-hint: <subject>\n${extra}\n---\n${body}`);
  await skills.getByRole('button', { name: 'Save', exact: true }).click();
  await skills.locator(`[data-skill="${name}"]`).getByRole('button', { name: /Read and approve/ }).click();
  await skills.getByRole('button', { name: 'Approve this skill' }).click();
  await skills.getByRole('button', { name: 'Done', exact: true }).click();
}

test('Save as command writes one user-only skill and refuses a collision without overwriting', async ({ page }) => {
  const seen: FakeRequest[] = [];
  await sample(page, seen);
  const original = await page.locator('.agent-intent-text').first().textContent();
  await page.getByRole('button', { name: 'Save as command…' }).click();
  const save = page.getByRole('form', { name: 'Save as command', exact: true });
  await save.getByLabel('Command name').fill('draft');
  await save.getByRole('button', { name: 'Save command', exact: true }).click();
  await expect(save).toContainText('already used or reserved');
  await save.getByLabel('Command name').fill('my-request');
  await save.getByRole('button', { name: 'Save command', exact: true }).click();
  await expect(save).toContainText('Saved. Review and approve it in Skills');
  await page.getByRole('button', { name: 'Skills', exact: true }).click();
  const skills = page.getByRole('dialog', { name: 'Skills' });
  await skills.getByRole('button', { name: 'Edit my-request' }).click();
  const text = await skills.getByRole('textbox', { name: 'Instructions', exact: true }).inputValue();
  expect(text).toContain('disable-model-invocation: true');
  expect(text).toContain(original ?? '');
  await expect(skills).toContainText('This skill can be used.');
  expect(seen).toHaveLength(0);
});

test('a missing named argument is asked inline before the expanded skill reaches the model', async ({ page }) => {
  const seen: FakeRequest[] = [];
  await sample(page, seen);
  await makeCommand(page, 'focus-pass', 'Write about $subject in $DOC. Keep $$ literal.');
  await binderRow(page, 'The Landing').dblclick();
  const box = page.getByRole('combobox', { name: 'Intent' });
  await box.fill('/focus');
  await expect(page.getByRole('option', { name: /\/focus-pass/ })).toContainText('Project skill');
  await box.press('Tab');
  await box.press('Enter');
  const note = page.getByTestId('agent-command-note');
  await expect(note).toContainText('missing argument');
  expect(seen).toHaveLength(0);
  await note.getByLabel('Argument: subject').fill('the quiet tide');
  await note.getByRole('button', { name: 'Run command' }).click();
  await expect(page.locator('.agent-intent-text').last()).toContainText('Write about the quiet tide');
  await expect.poll(() => seen.length).toBeGreaterThan(0);
  const request = seen.map((item) => item.user).join('\n');
  expect(request).toContain('Writer-approved skill');
  expect(request).toContain('Keep $ literal.');
  expect(request).not.toContain('/focus-pass');
  expect(request).not.toContain('- focus-pass:');
  await expect(note).toContainText('foreground');
});

test('the inline argument form and save action render in German without overflowing', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  const seen: FakeRequest[] = [];
  await sample(page, seen);
  await makeCommand(page, 'fokus', 'Write about $subject.');
  await page.getByTestId('open-settings').click();
  const settings = page.getByTestId('settings');
  await settings.locator('[data-section="appearance"]').click();
  await settings.locator('input[name="interface-language"][value="de"]').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await page.keyboard.press('Escape');
  await page.getByRole('combobox', { name: 'Absicht' }).fill('/fokus');
  await page.getByRole('combobox', { name: 'Absicht' }).press('Enter');
  const note = page.getByTestId('agent-command-note');
  await expect(note).toContainText('fehlende Argument');
  await expect(note.getByRole('button', { name: 'Befehl ausführen' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Als Befehl speichern…' })).toBeVisible();
  for (const width of [960, 1100, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const bounds = await note.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
  }
  expect(seen).toHaveLength(0);
});

test('connected MCP prompt commands refuse an unreviewed prompt and envelope a reviewed answer', async ({ page }) => {
  await page.addInitScript(() => {
    (globalThis as unknown as { __caotangMcpFixture: unknown }).__caotangMcpFixture = {
      'https://commands.example.com/mcp': { tools: [], prompts: [{ name: 'recap', description: 'Recap this chapter.', arguments: [{ name: 'chapter-id', required: true }] }], content: [{ type: 'text', text: 'Consider the tide.' }] },
    };
  });
  const seen: FakeRequest[] = [];
  await sample(page, seen);
  await page.getByTestId('open-settings').click();
  const settings = page.getByTestId('settings');
  await settings.locator('[data-section="mcp"]').click();
  await settings.getByTestId('mcp-master').check();
  const form = settings.getByRole('form', { name: 'Add a server' });
  await form.getByLabel('Name').fill('Story prompts');
  await form.getByLabel('Server address (https://…, or http://localhost…)').fill('https://commands.example.com/mcp');
  await form.getByRole('button', { name: 'Add server' }).click();
  const server = settings.locator('[data-server="Story prompts"]');
  await server.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(server.getByTestId('mcp-review')).toBeVisible();
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  const box = page.getByRole('combobox', { name: 'Intent' });
  await box.fill('/mcp-recap');
  await page.getByRole('option', { name: /\/mcp-recap-/ }).click();
  const command = (await box.inputValue()).trim();
  await box.fill(command);
  await box.press('Enter');
  await page.getByTestId('agent-command-note').getByLabel('Argument: chapter-id').fill('Arrival');
  await page.getByTestId('agent-command-note').getByRole('button', { name: 'Run command' }).click();
  await expect(page.getByTestId('agent-command-note')).toContainText('The prompt was not run.');
  expect(seen).toHaveLength(0);
  await page.getByTestId('open-settings').click();
  await settings.locator('[data-section="mcp"]').click();
  await server.getByRole('button', { name: 'Approve these prompts and templates' }).click();
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await box.fill(`${command} chapter-id=Arrival`);
  await box.press('Enter');
  await expect.poll(() => seen.length).toBeGreaterThan(0);
  expect(seen[0]?.user).toContain('source="mcp');
  expect(seen[0]?.user).toContain('Consider the tide.');
  expect(seen[0]?.user).not.toContain(command);
});

test('a skill’s held plan explains that its restrictions require a fresh invocation in Ask', async ({ page }) => {
  const seen: FakeRequest[] = [];
  await sample(page, seen);
  await makeCommand(page, 'read-only', 'Read $subject.', 'allowed-tools: doc.read');
  await fakeEndpoint(page, planThenAnswer({ steps: [{ tool: 'notes.append', params: { doc: 'The Landing', text: 'This must not bypass the skill.' }, expect: 'A note is added' }] }));
  await page.getByRole('radio', { name: 'Plan only', exact: true }).check();
  await page.getByRole('combobox', { name: 'Intent' }).fill('/read-only tides');
  await page.getByRole('combobox', { name: 'Intent' }).press('Enter');
  const held = page.getByTestId('held-plan');
  await expect(held).toContainText('start the original command or request again');
  await expect(held.getByRole('button', { name: 'Switch to Ask and run this plan' })).toHaveCount(0);
  await expect(page.getByTestId('plan-card')).toHaveCount(0);
  await expect(page.getByTestId('checkpoint')).toHaveCount(0);
  await page.getByTestId('open-settings').click();
  const settings = page.getByTestId('settings');
  await settings.locator('[data-section="appearance"]').click();
  await settings.locator('input[name="interface-language"][value="de"]').click();
  await page.keyboard.press('Escape');
  await expect(held).toContainText('Wechseln Sie zu „Fragen“');
  for (const width of [960, 1100, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const bounds = await held.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
  }
});

test('MCP inline arguments keep arbitrary names and previous values, and can be dismissed', async ({ page }) => {
  await page.addInitScript(() => {
    (globalThis as unknown as { __caotangMcpFixture: unknown }).__caotangMcpFixture = {
      'https://commands.example.com/mcp': { tools: [], prompts: [{ name: 'recap', arguments: [
        { name: 'chapter title', required: true }, { name: 'audience=group', required: true }, { name: 'tone', required: true },
      ] }] },
    };
  });
  const seen: FakeRequest[] = [];
  await sample(page, seen);
  await page.getByTestId('open-settings').click();
  const settings = page.getByTestId('settings');
  await settings.locator('[data-section="mcp"]').click();
  await settings.getByTestId('mcp-master').check();
  const form = settings.getByRole('form', { name: 'Add a server' });
  await form.getByLabel('Name').fill('Story prompts');
  await form.getByLabel('Server address (https://…, or http://localhost…)').fill('https://commands.example.com/mcp');
  await form.getByRole('button', { name: 'Add server' }).click();
  const server = settings.locator('[data-server="Story prompts"]');
  await server.getByRole('button', { name: 'Connect', exact: true }).click();
  await server.getByRole('button', { name: 'Approve these prompts and templates' }).click();
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  const box = page.getByRole('combobox', { name: 'Intent' });
  await box.fill('/mcp-recap');
  await page.getByRole('option', { name: /\/mcp-recap-/ }).click();
  const command = (await box.inputValue()).trim();
  await box.press('Enter');
  const note = page.getByTestId('agent-command-note');
  await note.getByLabel('Argument: chapter title').fill('Discard me');
  await page.getByTestId('open-settings').click();
  await settings.locator('[data-section="mcp"]').click();
  await server.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await server.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(server.getByRole('button', { name: 'Disconnect', exact: true })).toBeEnabled();
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await box.fill(command);
  await box.press('Enter');
  await expect(note.getByLabel('Argument: chapter title')).toHaveValue('');
  await note.getByLabel('Argument: chapter title').fill('Discard me');
  await note.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(note).toHaveCount(0);
  expect(seen).toHaveLength(0);
  await box.fill(`${command} Arrival`);
  await box.press('Enter');
  const audience = note.getByLabel('Argument: audience=group');
  await expect(audience).toHaveValue('');
  await audience.fill('Adults "and" teens');
  await audience.press('Enter');
  const tone = note.getByLabel('Argument: tone');
  await expect(tone).toHaveValue('');
  expect(seen).toHaveLength(0);
  await tone.fill('Quiet = thoughtful');
  await tone.press('Enter');
  await expect.poll(() => seen.length).toBeGreaterThan(0);
  const request = seen.map((item) => item.user).join('\n');
  const envelope = request.match(/<<untrusted [^\n]+>>\n([^\n]+)\n<<\/untrusted/u)?.[1];
  const prompt = JSON.parse(JSON.parse(envelope!)) as { messages: { content: { text: string } }[] };
  expect(JSON.parse(prompt.messages[0]!.content.text).args).toEqual({
    'chapter title': 'Arrival', 'audience=group': 'Adults "and" teens', tone: 'Quiet = thoughtful',
  });
  expect(request).not.toContain('Discard me');
  await expect(page.locator('.agent-report-text')).toHaveCount(2);
  const requestsBeforeRetry = seen.length;
  await box.fill(command);
  await box.press('Enter');
  await note.getByLabel('Argument: chapter title').fill('Private pending chapter');
  await note.getByLabel('Argument: chapter title').press('Enter');
  await expect(note.getByLabel('Argument: audience=group')).toBeVisible();
  await page.getByTestId('open-settings').click();
  await settings.locator('[data-section="mcp"]').click();
  await server.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await server.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(server.getByRole('button', { name: 'Disconnect', exact: true })).toBeEnabled();
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await note.getByLabel('Argument: audience=group').fill('Private pending audience');
  await note.getByLabel('Argument: audience=group').press('Enter');
  await expect(note).toContainText('The prompt was not run.');
  await expect(note.getByRole('textbox')).toHaveCount(0);
  await expect(page.locator('.agent-report-text')).toHaveCount(2);
  expect(seen).toHaveLength(requestsBeforeRetry);
  await page.getByTestId('open-settings').click();
  await settings.locator('[data-section="mcp"]').click();
  await server.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  const unavailable = `${command} "Private server-only chapter"`;
  await box.fill(unavailable);
  await box.press('Enter');
  await expect(note).toContainText('The prompt was not run.');
  await expect(box).toHaveValue(unavailable);
  await expect(page.locator('.agent-report-text')).toHaveCount(2);
  expect(seen).toHaveLength(requestsBeforeRetry);
});
