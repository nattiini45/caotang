import { expect, test } from '@playwright/test';

import { fakeEndpoint, planThenAnswer, useFakeEndpoint } from './endpoint.js';
import { createProject, projectTrace, waitForSaved } from './support.js';
import { createGoalScene } from './goal-scene-flow.js';


for (const shell of ['classic', 'modern'] as const) {
  test(`a goal started in the panel waits after reload and resumes only with its own approvals (${shell})`, async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    await page.addInitScript((shell) => localStorage.setItem('caotang.interface', shell), shell);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let requests = 0;
    const reply = planThenAnswer({ steps: [{ tool: 'synopsis.fill', params: { docs: ['Opening'], source: 'text', max_words: 30 }, expect: 'Opening has a synopsis.' }] });
    await fakeEndpoint(page, (request) => {
      requests += 1;
      return reply({ ...request, assistantTurns: request.tool === '' ? 0 : 1 });
    });
    await useFakeEndpoint(page);
    await createGoalScene(page, 'Goal Loop Book', shell);
    if (shell === 'modern') await page.keyboard.press('Control+j');
    else await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.getByRole('button', { name: 'Goal', exact: true }).click();
    await page.getByRole('textbox', { name: 'Goal intent' }).fill('Fill every empty synopsis.');
    await page.getByRole('checkbox', { name: 'Every synopsis is filled', exact: true }).check();
    await page.getByRole('spinbutton', { name: 'Model-call limit', exact: true }).fill('8');
    expect(requests).toBe(0);
    await page.getByRole('button', { name: 'Start the goal', exact: true }).click();
    const plan = page.getByTestId('plan-card');
    await expect(plan.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
    const progress = page.getByRole('region', { name: /^Goal progress:/ });
    await expect(page.getByTestId('goal-recovery-card')).toHaveAttribute('data-owned', 'true');
    await progress.getByRole('button', { name: 'Saved checks and spend', exact: true }).click();
    await progress.getByRole('rowheader', { name: 'Every synopsis is filled', exact: true }).scrollIntoViewIfNeeded();
    await expect(progress.getByRole('rowheader', { name: 'Every synopsis is filled', exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('goal-running-expanded.png') });
    await progress.getByRole('button', { name: 'Saved checks and spend', exact: true }).click();
    await expect(progress).toContainText('Passing checks: 0 of 1');
    await page.screenshot({ path: testInfo.outputPath('goal-running.png') });
    expect(await projectTrace(page)).not.toContain('binder.setSynopsis');
    const beforeReload = requests;

    await page.reload();
    await page.getByRole('listitem').filter({ hasText: 'Goal Loop Book' }).getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page.getByRole('tree', { name: 'Binder' }).or(page.getByTestId('modern-binder-bar')).first()).toBeVisible();
    if (shell === 'modern') await page.keyboard.press('Control+j');
    const recovery = page.getByTestId('goal-recovery-card');
    await expect(recovery).toHaveCount(1);
    await expect(recovery).toHaveAttribute('data-status', 'interrupted');
    await expect(recovery).toHaveAttribute('data-owned', 'false');
    await page.screenshot({ path: testInfo.outputPath('goal-interrupted.png') });
    await expect(plan).toHaveCount(0);
    await expect(page.locator('[data-testid="interrupted-runs"]:visible')).toHaveCount(0);
    expect(requests).toBe(beforeReload);
    await recovery.getByRole('button', { name: 'Resume the goal', exact: true }).click();
    await expect(plan.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
    expect(requests).toBeGreaterThan(beforeReload);
    expect(await projectTrace(page)).not.toContain('binder.setSynopsis');
    await plan.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(recovery).toHaveAttribute('data-status', 'settled');
    await expect(progress).toHaveAttribute('data-status', 'passed');
    await progress.getByRole('table').scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('goal-passed.png') });
    expect((await projectTrace(page)).filter((name) => name === 'binder.setSynopsis')).toHaveLength(1);
    await waitForSaved(page);
    expect(errors).toEqual([]);
  });
}

for (const shell of ['classic', 'modern'] as const) {
  test(`Goal Start describes missing Web Locks and preserves the one-turn draft (${shell})`, async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    let requests = 0;
    await page.addInitScript((shell) => {
      localStorage.setItem('caotang.interface', shell);
      Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    }, shell);
    await fakeEndpoint(page, () => { requests += 1; return 'No request should be sent.'; });
    await useFakeEndpoint(page);
    await createProject(page, 'Goal Capability Book');
    if (shell === 'modern') await page.keyboard.press('Control+j');
    else await page.getByRole('button', { name: 'Agent', exact: true }).click();
    const intent = page.getByRole('combobox', { name: 'Intent', exact: true });
    await intent.fill('Keep this ordinary one-turn draft.');
    await page.getByRole('button', { name: 'Goal', exact: true }).click();
    const start = page.getByRole('button', { name: 'Start the goal', exact: true });
    await expect(start).toBeDisabled();
    await expect(start).toHaveAccessibleDescription(/Web Locks/);
    await start.focus();
    await expect(start).toBeFocused();
    await expect(start).toHaveCSS('cursor', 'not-allowed');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    expect(requests).toBe(0);
    await expect(page.getByTestId('goal-recovery-card')).toHaveCount(0);
    const image = testInfo.outputPath(`goal-start-unavailable-${shell}.png`);
    await page.screenshot({ path: image });
    await testInfo.attach('Unavailable Goal Start', { path: image, contentType: 'image/png' });
    await page.getByRole('button', { name: 'Back to one turn', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Goal', exact: true })).toBeFocused();
    await expect(intent).toHaveValue('Keep this ordinary one-turn draft.');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    expect(requests).toBe(0);
  });
}

test('Findings offers its selected scope as a goal without running it', async ({ page }) => {
  test.setTimeout(60_000);
  let requests = 0;
  await fakeEndpoint(page, () => { requests += 1; return 'No request should be sent.'; });
  await useFakeEndpoint(page);
  await createProject(page, 'Findings Goal Book');
  await page.getByRole('tab', { name: 'Findings', exact: true }).click();
  await page.getByRole('combobox', { name: 'Scope of the scan and the review' }).selectOption('changed');
  await page.getByRole('button', { name: 'Fix all in scope until clean', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Goal intent', exact: true })).toHaveValue('Fix the findings in this scope until the selected coherence checks pass.');
  await expect(page.getByRole('button', { name: 'Start the goal', exact: true })).toBeVisible();
  await expect(page.getByTestId('goal-recovery-card')).toHaveCount(0);
  expect(requests).toBe(0);
  expect(await projectTrace(page)).not.toContain('binder.setSynopsis');
});

for (const shell of ['classic', 'modern'] as const) {
  for (const locale of ['en', 'de'] as const) {
    test(`the goal form fits and retains a no-turn result after reload (${shell}, ${locale})`, async ({ page }, testInfo) => {
      test.setTimeout(60_000);
      let requests = 0;
      await page.addInitScript(({ shell, locale }) => {
        localStorage.setItem('caotang.interface', shell);
        localStorage.setItem('caotang.theme', locale === 'de' ? 'dark' : 'light');
      }, { shell, locale });
      await fakeEndpoint(page, () => { requests += 1; return 'No request should be sent.'; });
      await useFakeEndpoint(page);
      const title = `Saved Goal ${shell} ${locale}`;
      await createGoalScene(page, title, shell, true);
      if (locale === 'de') {
        if (shell === 'modern') {
          await page.getByRole('toolbar', { name: 'Scene' }).getByRole('button', { name: 'More', exact: true }).click();
          await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
        } else await page.getByTestId('open-settings').click();
        const settings = page.getByTestId('settings');
        await settings.locator('[data-section="appearance"]').click();
        await settings.locator('input[name="interface-language"][value="de"]').click();
        await expect(page.locator('html')).toHaveAttribute('lang', 'de');
        await page.keyboard.press('Escape');
        await expect(settings).toBeHidden();
      }
      if (shell === 'modern') await page.keyboard.press('Control+j');
      else await page.getByRole('button', { name: 'Agent', exact: true }).click();
      await page.getByRole('button', { name: locale === 'de' ? 'Ziel' : 'Goal', exact: true }).click();
      const intent = page.getByRole('textbox', { name: locale === 'de' ? 'Zielauftrag' : 'Goal intent', exact: true });
      await expect(intent).toBeFocused();
      await intent.fill('Keep every synopsis filled.');
      const synopses = page.getByRole('checkbox', { name: locale === 'de' ? 'Jede Synopsis ist ausgefüllt' : 'Every synopsis is filled', exact: true });
      await synopses.focus();
      await page.keyboard.press('Space');
      await expect(synopses).toBeChecked();
      await page.getByRole('spinbutton', { name: locale === 'de' ? 'Limit für Modellaufrufe' : 'Model-call limit', exact: true }).fill('0');
      await intent.focus();
      const form = page.getByRole('form', { name: locale === 'de' ? 'Auf ein Ziel hinarbeiten' : 'Run toward a goal', exact: true });
      const bounds = await form.boundingBox();
      const panel = await page.getByTestId('agent-panel').boundingBox();
      expect(bounds).not.toBeNull();
      expect(panel).not.toBeNull();
      expect(bounds!.y).toBeGreaterThanOrEqual(panel!.y);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(panel!.y + panel!.height + 1);
      const formImage = testInfo.outputPath(`goal-form-${shell}-${locale}.png`);
      await page.screenshot({ path: formImage });
      await testInfo.attach('Goal form', { path: formImage, contentType: 'image/png' });
      await page.getByRole('button', { name: locale === 'de' ? 'Das Ziel starten' : 'Start the goal', exact: true }).click();
      const progress = page.getByRole('region', { name: locale === 'de' ? /^Zielfortschritt:/ : /^Goal progress:/ });
      await expect(progress).toHaveAttribute('data-status', 'passed');
      await expect(progress).toContainText(locale === 'de' ? 'Abgeschlossene Durchläufe: 0 von 10' : 'Completed iterations: 0 of 10');
      expect(requests).toBe(0);
      await page.reload();
      await page.getByRole('listitem').filter({ hasText: title }).getByRole('button', { name: locale === 'de' ? 'Öffnen' : 'Open', exact: true }).click();
      await expect(page.getByRole('tree', { name: 'Binder' }).or(page.getByTestId('modern-binder-bar')).first()).toBeVisible();
      if (shell === 'modern') await page.keyboard.press('Control+j');
      else await page.getByRole('button', { name: 'Agent', exact: true }).click();
      await expect(progress).toHaveAttribute('data-status', 'passed');
      const passed = progress.getByRole('cell', { name: locale === 'de' ? /Bestanden/ : /Passed/ });
      await passed.scrollIntoViewIfNeeded();
      await expect(passed).toBeInViewport({ ratio: 1 });
      await expect(progress.getByRole('rowheader', { name: locale === 'de' ? 'Jede Synopsis ist ausgefüllt' : 'Every synopsis is filled', exact: true })).toBeInViewport({ ratio: 1 });
      if (shell === 'modern') {
        const host = await page.getByTestId('agent-panel').boundingBox();
        const body = await page.locator('.agent-body').boundingBox();
        const composer = await page.getByRole('combobox', { name: locale === 'de' ? 'Absicht' : 'Intent', exact: true }).boundingBox();
        expect(host).not.toBeNull();
        expect(body).not.toBeNull();
        expect(composer).not.toBeNull();
        expect(body!.y + body!.height).toBeLessThanOrEqual(host!.y + host!.height + 1);
        expect(composer!.y + composer!.height).toBeLessThanOrEqual(host!.y + host!.height + 1);
      }
      const watchImage = testInfo.outputPath(`goal-watch-${shell}-${locale}.png`);
      await page.screenshot({ path: watchImage });
      await testInfo.attach('Saved no-turn result', { path: watchImage, contentType: 'image/png' });
      expect(requests).toBe(0);
    });
  }
}
