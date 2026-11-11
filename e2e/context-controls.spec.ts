import { expect, test, type Page } from '@playwright/test';
import { endpointRoute, fakeEndpoint, planThenAnswer, useFakeEndpoint as addFakeProvider, type FakeRequest } from './endpoint.js';
import { binderTitle, projectTrace, loose, waitForSaved } from './support.js';

const intent = (page: Page) => page.getByRole('combobox', { name: 'Intent' });
const choices = (page: Page) => page.getByRole('listbox', { name: 'Context to include' });
const pins = (page: Page) => page.getByRole('list', { name: 'Context choices for the next request' });

async function sample(page: Page, seen: FakeRequest[] = [], windowTokens?: number): Promise<void> {
  const reply = (request: FakeRequest) => {
    seen.push(request);
    return request.tools === undefined ? JSON.stringify({ reply: 'Answered.' }) : { text: 'Answered.' };
  };
  if (windowTokens === undefined) await fakeEndpoint(page, reply);
  else await endpointRoute(page, 'https://127.0.0.1:5999', reply, [{ id: 'test-model', context_length: windowTokens }]);
  await addFakeProvider(page);
  await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
  await expect(page.getByTestId('agent-panel')).toHaveAttribute('data-state', 'idle');
  seen.length = 0;
}

async function pin(page: Page, query: string, line = 'Consider these scenes.'): Promise<void> {
  await intent(page).fill(`${line} @${query}`);
  await expect(choices(page).getByRole('option')).toHaveCount(1);
  await intent(page).press('Enter');
  await expect(intent(page)).toHaveValue(`${line} `);
}

test('the shared combobox pins readable context by keyboard, caps document pins and previews without requests', async ({ page }, testInfo) => {
  const seen: FakeRequest[] = [];
  await sample(page, seen);
  const before = await projectTrace(page);
  await intent(page).fill('/');
  await intent(page).press('End');
  const lastCommand = page.getByRole('listbox', { name: 'Commands' }).getByRole('option').last();
  await expect(lastCommand).toHaveAttribute('aria-selected', 'true');
  await expect(lastCommand).toBeInViewport();
  await intent(page).fill('Consider @');
  await expect(choices(page)).toBeVisible();
  const menuBox = await choices(page).boundingBox();
  expect(menuBox).not.toBeNull();
  expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await page.screenshot({ path: testInfo.outputPath('context-menu-classic.png') });
  await expect(choices(page).getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  await intent(page).press('ArrowDown');
  await intent(page).press('Escape');
  await expect(choices(page)).toHaveCount(0);
  await pin(page, 'Landing');
  await pin(page, 'Storm');
  await pin(page, 'Friend');
  await expect(pins(page).getByRole('button')).toHaveCount(3);
  await expect(page.locator('.composer-context')).toContainText('Foreground only');
  await intent(page).fill('Consider @Landing');
  await expect(choices(page)).toHaveCount(0);
  await pins(page).getByRole('button', { name: loose('Remove context choice The Landing') }).click();
  await expect(intent(page)).toBeFocused();
  await expect(pins(page).getByRole('button')).toHaveCount(2);
  await intent(page).fill('Consider the weather.');
  const context = page.getByTestId('request-context');
  await expect(context).toHaveAttribute('data-source', 'typed');
  await expect(context).toContainText('12,000 budgeted tokens');
  await expect(context).toContainText('Model window: unknown.');
  await page.locator('.agent-body').evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: testInfo.outputPath('context-classic.png') });
  await context.getByText('Preview this request', { exact: true }).click();
  await expect(context.getByRole('list', { name: 'Included context' })).toContainText('The Storm');
  expect(seen).toHaveLength(0);
  expect(await projectTrace(page)).toEqual(before);
});

test('context completion ignores emails and composing text and does not offer read-denied documents', async ({ page }) => {
  await sample(page);
  await intent(page).fill('Write to me@example');
  await expect(choices(page)).toHaveCount(0);
  await intent(page).fill('Consider @Landing');
  await intent(page).dispatchEvent('compositionstart');
  await expect(choices(page)).toHaveCount(0);
  await intent(page).dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  await expect(page.getByTestId('agent-panel')).toHaveAttribute('data-state', 'idle');
  await intent(page).dispatchEvent('compositionend');
  await expect(choices(page)).toBeVisible();
  await binderTitle(page, 'Chapter 1').click({ button: 'right' });
  await page.getByRole('menu', { name: 'Actions for Chapter 1' }).getByRole('menuitemradio', { name: 'Agent: may not read' }).click();
  await intent(page).fill('Consider @Landing');
  await expect(choices(page)).toHaveCount(0);
});

test('context completion uses the binder fold but removes the raw trailing query', async ({ page }) => {
  const seen: FakeRequest[] = [];
  await sample(page, seen);
  await binderTitle(page, 'The Landing').dblclick();
  const rename = page.getByRole('textbox', { name: loose('Rename The Landing') });
  await rename.fill('Élan’s');
  await rename.press('Enter');
  await pin(page, "E\u0301LAN'S", 'Consider the first scene.');
  await expect(pins(page)).toContainText('Élan’s');
  expect(seen).toHaveLength(0);
});

test('the meter distinguishes configured budget from a known model window and effective capacity', async ({ page }) => {
  await sample(page, [], 6_000);
  await intent(page).fill('Consider the weather.');
  const context = page.getByTestId('request-context');
  await expect(context).toHaveAttribute('data-level', 'over');
  await expect(context).toContainText('12,000 budgeted tokens');
  await expect(context).toContainText('Model window: 6,000 tokens.');
});

test('the shared preview names a document excerpt dropped by its L5 budget', async ({ page }) => {
  const seen: FakeRequest[] = [];
  await sample(page, seen);
  await binderTitle(page, 'The Landing').click();
  await page.keyboard.press('Control+Enter');
  await page.getByRole('textbox', { name: 'Document text', exact: true }).fill('Long excerpt. '.repeat(200));
  await waitForSaved(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Context', exact: true }).click();
  const budgets = settings.getByRole('form', { name: 'Context budgets' });
  await budgets.getByLabel('Focus document text', { exact: true }).fill('200');
  await budgets.getByRole('button', { name: 'Save budgets', exact: true }).click();
  await expect(settings).toContainText('Saved. The agent’s next request uses these budgets.');
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await pin(page, 'Landing');
  const context = page.getByTestId('request-context');
  await context.getByText('Preview this request', { exact: true }).click();
  await expect(context.getByRole('list', { name: 'Left out' })).toContainText('The Landing: dropped budget (L5, 200 tokens');
  await page.getByRole('textbox', { name: 'Document text', exact: true }).fill('Changed excerpt. '.repeat(200));
  await waitForSaved(page);
  await expect(context.locator('details')).toHaveAttribute('open', '');
  await expect(context.getByRole('list', { name: 'Left out' })).toContainText('The Landing: dropped budget (L5, 200 tokens');
  expect(seen).toHaveLength(0);
});

test('queued choices are snapshotted and busy meters show the actual request rather than typed estimates', async ({ page }) => {
  const seen: FakeRequest[] = [];
  await sample(page, seen);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('https://127.0.0.1:5999/**', async (route) => {
    if (route.request().method() === 'POST' && (route.request().postData() ?? '').includes('First held request')) await held;
    await route.fallback();
  });
  await intent(page).fill('First held request');
  await intent(page).press('Enter');
  await expect(page.getByTestId('request-context')).toHaveAttribute('data-source', 'running');
  await pin(page, 'Storm', 'Second queued request');
  await intent(page).press('Enter');
  await expect(page.getByTestId('agent-queue')).toContainText('Second queued request');
  await pin(page, 'Friend', 'Unsent third request');
  await expect(page.getByTestId('request-context')).toHaveAttribute('data-source', 'running');
  await intent(page).fill('/context');
  await intent(page).press('Enter');
  const note = page.getByTestId('agent-command-note');
  await expect(note).toContainText('Current request context');
  await expect(note.getByTestId('request-context')).toHaveAttribute('data-source', 'running');
  await note.getByText('View the current planner prompt', { exact: true }).click();
  await expect(note.getByRole('button', { name: /^Leave out/ })).toHaveCount(0);
  await expect(note).not.toContainText('The Friend');
  expect(seen).toHaveLength(0);
  release();
  await expect(page.getByTestId('agent-panel')).toHaveAttribute('data-state', 'idle');
  const second = seen.find((request) => request.user.includes('Second queued request'));
  expect(second?.user).toContain('The Storm (pinned excerpt)');
  expect(second?.user).not.toContain('The Friend (pinned excerpt)');
  await expect(pins(page)).toContainText('The Friend');
});

test('leaving optional step context out re-previews its plan before fresh approval', async ({ page }) => {
  await sample(page);
  const seen: FakeRequest[] = [];
  const answer = planThenAnswer({ steps: [{ tool: 'scene.draft', params: { doc: 'The Friend', instruction: 'Write a new opening.', mode: 'draft' }, expect: 'The opening is drafted.' }] }, 'Done.', 'A fresh opening.');
  await fakeEndpoint(page, (request) => { seen.push(request); return answer(request); });
  await intent(page).fill('Draft the friend scene.');
  await intent(page).press('Enter');
  const card = page.getByTestId('plan-card').last();
  await expect(card).toBeVisible();
  await card.locator('.context-preview summary').click();
  await card.getByRole('button', { name: loose('Leave out The Landing for this request') }).click();
  await expect(card).toContainText('Excluded for this request');
  await card.locator('.context-preview summary').click();
  await expect(card.getByRole('list', { name: 'Excluded context' })).toContainText('The Landing');
  await expect(card.getByRole('list', { name: 'Included context' })).not.toContainText('The Landing');
  await expect(card.getByRole('button', { name: /Approve/, exact: false }).first()).toBeEnabled();
  expect((await projectTrace(page)).filter((command) => command === 'doc.write' || command === 'editor.insert')).toEqual([]);
  const drafts = seen.filter((request) => request.system.startsWith('You are drafting prose'));
  expect(drafts.length).toBeGreaterThanOrEqual(2);
  await card.getByRole('button', { name: loose('Clear leave-out for The Landing') }).click();
  await expect(card).not.toContainText('Excluded for this request');
  await card.locator('.context-preview summary').click();
  await expect(card.getByRole('list', { name: 'Included context' })).toContainText('The Landing');
  await expect(card).not.toContainText('Pinned for this request');
  const restored = seen.filter((request) => request.system.startsWith('You are drafting prose')).at(-1);
  expect(restored?.user).not.toContain('The Landing (pinned excerpt)');
});

test('German narrow Modern context controls wrap and remain keyboard-reachable', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('caotang.interface', 'modern'));
  await sample(page);
  await page.getByTestId('agent-close').click();
  await page.getByTestId('modern-top-ornament').getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.locator('[data-section="appearance"]').click();
  await settings.locator('input[name="interface-language"][value="de"]').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await settings.getByRole('button', { name: 'Schließen', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press('Control+j');
  const box = page.getByRole('combobox', { name: 'Absicht' });
  await box.fill('Betrachten Sie @Storm');
  await expect(page.getByRole('listbox', { name: 'Einzubeziehender Kontext' })).toBeVisible();
  await box.press('Tab');
  await expect(box).toBeFocused();
  await expect(page.getByRole('list', { name: 'Kontextauswahl für die nächste Anfrage' })).toContainText('The Storm');
  const context = page.getByTestId('request-context');
  await expect(context).toContainText('Kontextschätzung');
  await context.getByText('Vorschau dieser Anfrage', { exact: true }).click();
  await expect(context.getByRole('button', { name: loose('The Storm für diese Anfrage weglassen') })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('context-modern-narrow-de.png') });
});
