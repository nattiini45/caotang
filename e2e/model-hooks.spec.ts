import { expect, test } from '@playwright/test';

import { fakeEndpoint, planThenAnswer, useFakeEndpoint, type FakeRequest } from './endpoint.js';
import { chooseInterfaceLanguage, createProject, projectTrace } from './support.js';

test('the plan previews a private model hook before approval and sends it only at execution', async ({ page }, info) => {
  const check = 'Check the note for a change of viewpoint.';
  const prose = 'The tide rose before dawn.';
  const observed: FakeRequest[] = [];
  const plan = planThenAnswer({ steps: [
    { tool: 'notes.append', params: { doc: 'The Landing', text: prose }, expect: 'Add a note to The Landing.' },
    { tool: 'notes.append', params: { doc: 'The Friend', text: 'The wind fell.' }, expect: 'Add a note to The Friend.' },
  ] });
  await fakeEndpoint(page, (request) => {
    if (!request.system.includes(check)) return plan(request);
    observed.push(request);
    return '{"decision":"allow","reason":""}';
  });
  await useFakeEndpoint(page);
  await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  await page.getByTestId('open-settings').click();
  const settings = page.getByTestId('settings');
  await settings.locator('[data-section="hooks"]').click();
  await settings.getByRole('button', { name: 'Add model hook', exact: true }).click();
  const form = settings.getByRole('form', { name: 'New model hook' });
  await form.getByRole('textbox', { name: 'Name', exact: true }).fill('Check viewpoint');
  const trigger = form.getByRole('combobox', { name: 'Built-in agent tool' });
  await trigger.click();
  await page.getByRole('option', { name: 'notes.append', exact: true }).click();
  await form.getByRole('textbox', { name: 'Check instructions' }).fill(check);
  const save = form.getByRole('button', { name: 'Save model hook', exact: true });
  await save.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('model-hook-settings.png') });
  await save.click();
  await expect(settings.getByRole('strong').filter({ hasText: 'Check viewpoint' })).toBeVisible();
  expect(observed).toEqual([]);
  await settings.getByRole('button', { name: 'Close', exact: true }).click();

  const field = page.getByRole('combobox', { name: 'Intent' });
  await expect(field).toBeEnabled();
  await field.fill('Add the two requested notes.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const card = page.getByTestId('plan-card');
  await expect(card.getByRole('list', { name: 'Model hook prompt estimates' })).toHaveCount(2);
  const first = card.getByRole('list', { name: 'Model hook prompt estimates' }).first();
  await expect(first).toContainText(/Check viewpoint before this step: about \d+ tokens in, up to \d+ out/);
  await expect(card.getByText(/These checks use your Background provider/).first()).toBeVisible();
  expect(observed).toEqual([]);
  const estimate = card.locator('.context-preview').filter({ has: page.getByRole('list', { name: 'Model hook prompt estimates' }) }).first();
  await estimate.scrollIntoViewIfNeeded();
  await estimate.screenshot({ path: info.outputPath('model-hook-preview.png') });
  await card.getByRole('button', { name: 'Approve plan', exact: true }).click();
  await expect.poll(async () => (await projectTrace(page)).filter((name) => name === 'notes.append')).toHaveLength(2);
  expect(observed).toHaveLength(2);
  expect(observed[0]?.user).toContain(prose);
  expect(observed[0]?.user).not.toContain('Add the two requested notes.');
  expect(observed[0]?.tools).toBeUndefined();
});

test('German model hook settings can be saved with the keyboard and survive reload', async ({ page }, info) => {
  await page.goto('/');
  await createProject(page, 'Hook rehearsal');
  await page.getByTestId('open-settings').click();
  const settings = page.getByTestId('settings');
  await settings.locator('[data-section="appearance"]').click();
  await chooseInterfaceLanguage(page, settings, 'de');
  await settings.locator('[data-section="hooks"]').click();
  await expect(settings.getByText(/Aktive Modell-Hooks senden Ihre Prüfanweisungen/)).toBeVisible();
  const add = settings.getByRole('button', { name: 'Modell-Hook hinzufügen', exact: true });
  await add.press('Enter');
  const form = settings.getByRole('form', { name: 'Neuer Modell-Hook' });
  await form.getByRole('textbox', { name: 'Name', exact: true }).fill('Perspektive prüfen');
  const trigger = form.getByRole('combobox', { name: 'Integriertes Agentenwerkzeug' });
  await trigger.press('Enter');
  await page.getByRole('option', { name: 'notes.append', exact: true }).click();
  await form.getByRole('textbox', { name: 'Prüfanweisungen' }).fill('Prüfen Sie die Perspektive.');
  const save = form.getByRole('button', { name: 'Modell-Hook speichern', exact: true });
  await save.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('model-hook-settings-de.png') });
  await save.press('Enter');
  await expect(settings.getByRole('status').filter({ hasText: 'Modell-Hook gespeichert.' })).toBeVisible();

  await page.reload();
  await page.getByRole('listitem').filter({ hasText: 'Hook rehearsal' }).getByRole('button', { name: 'Öffnen', exact: true }).click();
  await page.getByTestId('open-settings').click();
  await settings.locator('[data-section="hooks"]').click();
  await expect(settings.getByRole('strong').filter({ hasText: 'Perspektive prüfen' })).toBeVisible();
});

test('a model hook rewrite needs a fresh approval in Auto mode', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const check = 'Replace rose with fell in the note.';
  const original = 'The tide rose before dawn.';
  const replacement = 'The tide fell before dawn.';
  const plan = planThenAnswer({ steps: [{ tool: 'notes.append', params: { doc: 'The Landing', text: original }, expect: 'Add a note.' }] });
  await fakeEndpoint(page, (request) => request.system.includes(check)
    ? JSON.stringify({ decision: 'transform', reason: 'Use the opposite movement.', replacement })
    : plan(request));
  await useFakeEndpoint(page);
  await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
  await expect(page.locator('.agent-report-text').filter({ hasText: 'continuity finding' })).toBeVisible();
  await page.getByTestId('open-settings').click();
  const settings = page.getByTestId('settings');
  await settings.locator('[data-section="hooks"]').click();
  await settings.getByRole('button', { name: 'Add model hook' }).click();
  const form = settings.getByRole('form', { name: 'New model hook' });
  await form.getByRole('textbox', { name: 'Name', exact: true }).fill('Tide direction');
  await form.getByRole('combobox', { name: 'Built-in agent tool' }).click();
  await page.getByRole('option', { name: 'notes.append', exact: true }).click();
  await form.getByRole('textbox', { name: 'Check instructions' }).fill(check);
  await form.getByRole('checkbox', { name: 'Let this hook propose replacement text' }).check();
  await form.getByRole('button', { name: 'Save model hook' }).click();
  await expect(settings.getByRole('status', { name: '' }).filter({ hasText: 'Saved the model hook.' })).toBeVisible();
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('group', { name: 'Mode' }).getByRole('radio', { name: 'Auto' }).check();
  await page.getByRole('combobox', { name: 'Intent' }).fill('Add the requested tide note.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const card = page.getByTestId('plan-card');
  const diff = card.getByRole('figure', { name: 'Model hook rewrite' });
  await expect(diff.getByText('Tide direction')).toBeVisible();
  await expect(diff).toContainText('You need to approve the rewrite yourself, even in Auto mode.');
  await expect(diff.locator('dd').nth(0)).toHaveText(original);
  await expect(diff.locator('dd').nth(1)).toHaveText(replacement);
  expect((await projectTrace(page)).filter((name) => name === 'notes.append')).toHaveLength(0);
  await diff.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await diff.screenshot({ path: info.outputPath('model-hook-rewrite.png') });
  await card.getByRole('button', { name: 'Approve plan', exact: true }).click();
  await expect.poll(async () => (await projectTrace(page)).filter((name) => name === 'notes.append')).toHaveLength(1);
});

test('a turn-end model hook can request a follow-up without receiving the conversation', async ({ page }, info) => {
  const check = 'Ask for a follow-up after the first answer.';
  const privateIntent = 'Summarize the lighthouse scene.';
  const received: string[] = [];
  let hooks = 0;
  await fakeEndpoint(page, (request) => {
    if (request.system.includes(check)) {
      received.push(request.user);
      hooks += 1;
      return hooks === 1 ? '{"decision":"continue","reason":"Mention the setting."}' : '{"decision":"allow","reason":""}';
    }
    const text = request.user.includes('Mention the setting.') ? 'Follow-up: the scene takes place by the coast.' : 'The scene introduces the lighthouse keeper.';
    return request.tools === undefined ? JSON.stringify({ reply: text }) : { text };
  });
  await useFakeEndpoint(page);
  await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
  await expect(page.locator('.agent-report-text').filter({ hasText: 'continuity finding' })).toBeVisible();
  await page.getByTestId('open-settings').click();
  const settings = page.getByTestId('settings');
  await settings.locator('[data-section="hooks"]').click();
  await settings.getByRole('button', { name: 'Add model hook' }).click();
  const form = settings.getByRole('form', { name: 'New model hook' });
  await form.getByRole('textbox', { name: 'Name', exact: true }).fill('Follow-up check');
  await form.getByRole('combobox', { name: 'Event', exact: true }).click();
  await page.getByRole('option', { name: 'When the agent finishes a turn' }).click();
  await expect(form.getByRole('combobox', { name: 'Built-in agent tool' })).toHaveCount(0);
  await expect(form.getByText(/not the conversation, manuscript or tool results/)).toBeVisible();
  await form.getByRole('textbox', { name: 'Check instructions' }).fill(check);
  await form.screenshot({ path: info.outputPath('model-hook-continuation.png') });
  await form.getByRole('button', { name: 'Save model hook' }).click();
  await expect(settings.getByRole('status').filter({ hasText: 'Saved the model hook.' })).toBeVisible();
  expect(received).toEqual([]);
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('combobox', { name: 'Intent' }).fill(privateIntent);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.agent-report-text').filter({ hasText: /^Follow-up: the scene takes place by the coast\.$/ })).toBeVisible();
  expect(received).toHaveLength(2);
  expect(received.every((request) => !request.includes(privateIntent) && !request.includes('lighthouse') && request.includes('replied'))).toBe(true);
});
