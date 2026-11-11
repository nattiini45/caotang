import { expect, test, type Page } from '@playwright/test';
import { endpointRoute, fakeEndpoint, planThenAnswer, useFakeEndpoint as addFakeProvider, type FakeRequest } from './endpoint.js';
import { binderTitle, idOf, projectTrace, loose, waitForSaved } from './support.js';

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
  await expect(choices(page).getByRole('option')).toHaveCount(0);
  await expect(choices(page)).toContainText('Three documents are pinned.');
  await intent(page).press('Enter');
  await expect(intent(page)).toHaveValue('Consider @Landing');
  expect(seen).toHaveLength(0);
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
  await intent(page).fill('Consider @Land');
  await expect(choices(page).getByRole('option')).toHaveCount(0);
  await expect(choices(page)).toContainText('No readable context matches.');
  await expect(choices(page)).not.toContainText('The Landing');
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
  await expect(pins(page)).toContainText('Pinned: The Landing');
  await expect(pins(page)).toContainText('Not sent in this estimate');
  await context.getByText('Preview this request', { exact: true }).click();
  await expect(context.getByRole('list', { name: 'Pinned context not sent' })).toContainText('The Landing: The L5 budget of 200 tokens is full');
  await expect(context.getByRole('list', { name: 'Layers' })).toBeHidden();
  await context.getByText('Token breakdown', { exact: true }).click();
  await expect(context.getByRole('list', { name: 'Layers' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Document text', exact: true }).fill('Changed excerpt. '.repeat(200));
  await waitForSaved(page);
  await expect(context.locator('details.context-preview')).toHaveAttribute('open', '');
  await expect(context.locator('details.context-accounting')).toHaveAttribute('open', '');
  await expect(context.getByRole('list', { name: 'Pinned context not sent' })).toContainText('The Landing: The L5 budget of 200 tokens is full');
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
  await expect(page.locator('.context-submit')).toContainText('For the next request');
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
  await card.getByRole('button', { name: loose('Leave out The Landing from optional context for this request') }).click();
  await expect(card).toContainText('Left out of optional context for this request.');
  await card.locator('.context-preview summary').click();
  await expect(card.getByRole('list', { name: 'Excluded context' })).toContainText('The Landing');
  await expect(card.getByRole('list', { name: 'Included context' })).not.toContainText('The Landing');
  await expect(card.getByRole('button', { name: /Approve/, exact: false }).first()).toBeEnabled();
  expect((await projectTrace(page)).filter((command) => command === 'doc.write' || command === 'editor.insert')).toEqual([]);
  const drafts = seen.filter((request) => request.system.startsWith('You are drafting prose'));
  expect(drafts.length).toBeGreaterThanOrEqual(2);
  await card.getByRole('button', { name: loose('Clear leave-out for The Landing') }).click();
  await expect(card).not.toContainText('Left out of optional context for this request.');
  await card.locator('.context-preview summary').click();
  await expect(card.getByRole('list', { name: 'Included context' })).toContainText('The Landing');
  await expect(card).not.toContainText('Pinned for this request');
  const restored = seen.filter((request) => request.system.startsWith('You are drafting prose')).at(-1);
  expect(restored?.user).not.toContain('The Landing (pinned excerpt)');
});

test('context completion explains truncated and empty matches without sending an unresolved query', async ({ page }, testInfo) => {
  const seen: FakeRequest[] = [];
  await sample(page, seen);
  await binderTitle(page, 'Chapter 2').click();
  for (const number of ['01', '02', '03', '04', '05', '06']) {
    await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
    const rename = page.getByRole('textbox', { name: 'Rename Untitled' });
    await rename.fill(`Extra${number}`);
    await rename.press('Enter');
  }
  await intent(page).fill('Consider @');
  await expect(choices(page).getByRole('option')).toHaveCount(8);
  await expect(choices(page)).toContainText('Showing 8 of 10 matches. Type more to narrow the list.');
  await expect(choices(page)).not.toContainText('The Storm');
  await pin(page, 'Storm');
  await intent(page).fill('Keep literal @not-a-title');
  await expect(choices(page).getByRole('option')).toHaveCount(0);
  await expect(choices(page)).toContainText('No readable context matches.');
  await intent(page).press('Enter');
  await expect(intent(page)).toHaveValue('Keep literal @not-a-title');
  await expect(page.getByTestId('agent-panel')).toHaveAttribute('data-state', 'idle');
  expect(seen).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath('context-empty-picker-classic.png') });
  await intent(page).press('Escape');
  await expect(choices(page)).toHaveCount(0);
  await intent(page).press('Enter');
  await expect.poll(() => seen.some((request) => request.user.includes('Keep literal @not-a-title'))).toBe(true);
});

for (const change of ['delete', 'deny'] as const) {
  test(`an unavailable pin stays removable after ${change} and releases its document slot`, async ({ page }) => {
    await sample(page);
    const hiddenId = await idOf(page, 'The Landing');
    for (const name of ['Landing', 'Storm', 'Friend']) await pin(page, name);
    await binderTitle(page, 'Chapter 2').click();
    await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
    await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('Fourth');
    await page.keyboard.press('Enter');
    if (change === 'delete') {
      await binderTitle(page, 'The Landing').click();
      await page.keyboard.press('Delete');
      await page.getByRole('dialog', { name: 'Delete “The Landing”?' }).getByRole('button', { name: 'Delete', exact: true }).click();
    } else {
      await binderTitle(page, 'Chapter 1').click({ button: 'right' });
      await page.getByRole('menu', { name: 'Actions for Chapter 1' }).getByRole('menuitemradio', { name: 'Agent: may not read' }).click();
    }
    const unavailable = pins(page).getByRole('button').filter({ hasText: hiddenId });
    await expect(unavailable).toContainText('Unavailable context');
    await expect(unavailable).not.toContainText('The Landing');
    await intent(page).fill('Consider @Fourth');
    await expect(choices(page).getByRole('option')).toHaveCount(0);
    await expect(choices(page)).toContainText('Three documents are pinned.');
    await unavailable.click();
    await expect(intent(page)).toBeFocused();
    await expect(choices(page).getByRole('option')).toHaveCount(1);
    await intent(page).press('Enter');
    await expect(intent(page)).toHaveValue('Consider ');
    await expect(pins(page).getByRole('button')).toHaveCount(3);
    await expect(pins(page)).toContainText('Fourth');
    await expect(pins(page)).not.toContainText(hiddenId);
  });
}

test('a codex pin remains removable after its policy changes to Never', async ({ page }) => {
  await sample(page);
  await pin(page, 'Elena');
  await page.getByRole('tab', { name: 'Codex', exact: true }).click();
  await page.getByRole('button', { name: /^Elena/ }).click();
  await page.getByRole('radio', { name: 'Never', exact: true }).check();
  const unavailable = pins(page).getByRole('button', { name: /Remove context choice.*Unavailable context/ });
  await expect(unavailable).not.toContainText('Elena');
  await unavailable.click();
  await expect(pins(page)).toHaveCount(0);
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
  const action = context.getByRole('button', { name: loose('The Storm für diese Anfrage aus dem optionalen Kontext weglassen') });
  await expect(action).toBeVisible();
  await expect(action).toBeInViewport();
  await expect(context.getByRole('list', { name: 'Ebenen', exact: true })).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('context-modern-narrow-de.png') });
  await context.getByText('Tokenaufteilung', { exact: true }).click();
  await expect(context.getByRole('list', { name: 'Ebenen', exact: true })).toContainText('Dokumenttext fokussieren');
});
