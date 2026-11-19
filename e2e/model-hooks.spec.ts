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
