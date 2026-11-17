import { writeFile } from 'node:fs/promises';
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
    await page.getByRole('button', { name: 'Start the goal', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('agent-stop')).toBeFocused();
    const plan = page.getByTestId('plan-card');
    await expect(plan.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
    await expect(page.getByTestId('agent-step')).toContainText('Waiting for you');
    await expect(page.getByTestId('agent-step')).toContainText('Fill the synopsis');
    await expect(page.getByTestId('agent-step')).toHaveCSS('white-space', 'normal');
    await expect(page.getByTestId('agent-step')).toHaveCSS('overflow', 'hidden');
    const chip = await page.getByTestId('agent-step').evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        contentHeight: node.getBoundingClientRect().height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth),
        lineHeight: style.lineHeight === 'normal' ? parseFloat(style.fontSize) * 1.5 : parseFloat(style.lineHeight),
      };
    });
    expect(chip.contentHeight).toBeLessThanOrEqual(chip.lineHeight * 2 + 1);
    await expect(page.getByTestId('agent-step')).toHaveAttribute('title', /Fill the synopsis/);
    const progress = page.getByRole('region', { name: /^Goal progress:/ });
    if (shell === 'modern') {
      const frame = await page.getByTestId('agent-panel').boundingBox();
      const footer = await page.locator('.agent-foot').boundingBox();
      const body = await page.locator('.agent-body').boundingBox();
      expect(frame).not.toBeNull();
      expect(footer).not.toBeNull();
      expect(body).not.toBeNull();
      expect(footer!.y + footer!.height).toBeLessThanOrEqual(frame!.y + frame!.height + 1);
      expect(body!.height).toBeGreaterThanOrEqual(80);
    }
    await expect(page.getByTestId('goal-recovery-card')).toHaveAttribute('data-owned', 'true');
    await progress.getByRole('button', { name: 'Saved checks and spend', exact: true }).click();
    await progress.getByRole('rowheader', { name: 'Every synopsis is filled', exact: true }).scrollIntoViewIfNeeded();
    await expect(progress.getByRole('rowheader', { name: 'Every synopsis is filled', exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('goal-running-expanded.png') });
    await progress.getByRole('button', { name: 'Saved checks and spend', exact: true }).click();
    await expect(progress).toContainText('Passing checks: 0 of 1');
    await progress.getByText('Completed iterations: 0 of 10', { exact: true }).scrollIntoViewIfNeeded();
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

  test(`goal setup leaves an ordinary turn's pending approval accessible (${shell})`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.addInitScript((shell) => localStorage.setItem('caotang.interface', shell), shell);
    await fakeEndpoint(page, planThenAnswer({ steps: [{ tool: 'synopsis.fill', params: { docs: ['Opening'], source: 'text', max_words: 30 }, expect: 'Opening has a synopsis.' }] }));
    await useFakeEndpoint(page);
    await createGoalScene(page, 'Pending Approval Book', shell);
    if (shell === 'modern') await page.keyboard.press('Control+j');
    else await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.getByRole('combobox', { name: 'Intent', exact: true }).fill('Fill the synopsis of Opening.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const approval = page.getByTestId('plan-card').getByRole('button', { name: 'Approve', exact: true });
    await expect(approval).toBeVisible();
    const goal = page.getByRole('button', { name: 'Goal', exact: true });
    await expect(goal).toBeDisabled();
    await goal.focus();
    await page.keyboard.press('Enter');
    await expect(approval).toBeVisible();
    await expect(page.getByRole('form', { name: 'Run toward a goal', exact: true })).toHaveCount(0);
    expect(await projectTrace(page)).not.toContain('binder.setSynopsis');
    await page.getByTestId('agent-stop').click();
  });

  test(`a completed goal returns focus from Stop to Goal (${shell})`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.addInitScript((shell) => localStorage.setItem('caotang.interface', shell), shell);
    await fakeEndpoint(page, () => 'No edit was made.');
    await useFakeEndpoint(page);
    await createGoalScene(page, 'Goal Focus Book', shell);
    if (shell === 'modern') await page.keyboard.press('Control+j');
    else await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.getByRole('button', { name: 'Goal', exact: true }).click();
    await page.getByRole('textbox', { name: 'Goal intent', exact: true }).fill('Fill every empty synopsis.');
    await page.getByRole('checkbox', { name: 'Every synopsis is filled', exact: true }).check();
    await page.getByRole('spinbutton', { name: 'Model-call limit', exact: true }).fill('1');
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let requested = false;
    await page.route('https://127.0.0.1:5999/**', async (route) => {
      if (route.request().method() === 'POST') { requested = true; await held; }
      await route.fallback();
    });
    try {
      await page.getByRole('button', { name: 'Start the goal', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('agent-stop')).toBeFocused();
      await expect.poll(() => requested).toBe(true);
    } finally { release(); }
    await expect(page.getByTestId('goal-recovery-card')).toHaveAttribute('data-status', 'settled');
    await expect(page.getByRole('button', { name: 'Goal', exact: true })).toBeFocused();
    expect(await projectTrace(page)).not.toContain('binder.setSynopsis');
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
  for (const { locale, theme } of (shell === 'modern' ? [
    { locale: 'en', theme: 'light' }, { locale: 'en', theme: 'dark' },
    { locale: 'de', theme: 'light' }, { locale: 'de', theme: 'dark' },
  ] as const : [{ locale: 'en', theme: 'light' }, { locale: 'de', theme: 'dark' }] as const)) {
    test(`the goal form fits and retains a no-turn result after reload (${shell}, ${locale}, ${theme})`, async ({ page }, testInfo) => {
      test.setTimeout(60_000);
      let requests = 0;
      await page.addInitScript(({ shell, theme }) => {
        localStorage.setItem('caotang.interface', shell);
        localStorage.setItem('caotang.theme', theme);
      }, { shell, theme });
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
      if (shell === 'classic' && locale === 'en') {
        await page.getByRole('radio', { name: 'A binder document or folder', exact: true }).click();
        await page.getByRole('combobox', { name: 'Binder document or folder', exact: true }).click();
        await page.getByRole('option', { name: 'Chapter 1', exact: true }).click();
        await expect(page.getByRole('radio', { name: 'Only the named binder items', exact: true })).toBeChecked();
      }
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
      let releaseBinder: () => void = () => undefined;
      let binderHeld = false;
      if (shell === 'modern' && locale === 'de') {
        const held = new Promise<void>((resolve) => { releaseBinder = resolve; });
        await page.route(/\/src\/components\/shell\/modern\/narrow-panels\.(?:tsx|js)(?:\?|$)/, async (route) => {
          binderHeld = true;
          await held;
          await route.continue();
        });
      }
      await page.setViewportSize({ width: 390, height: 844 });
      if (shell === 'modern') await form.getByRole('radiogroup', { name: locale === 'de' ? 'Prüfbereich' : 'Check scope', exact: true }).scrollIntoViewIfNeeded();
      if (shell === 'modern' && locale === 'de') {
        try {
          await expect.poll(() => binderHeld).toBe(true);
          await expect(page.getByRole('status').filter({ hasText: 'Der Binder wird geladen …' })).toBeVisible();
          await page.screenshot({ path: testInfo.outputPath('binder-loading-modern-de.png') });
        } finally { releaseBinder(); }
        await expect(page.getByRole('status').filter({ hasText: 'Der Binder wird geladen …' })).toHaveCount(0);
      }
      if (shell === 'modern') {
        const scopes = form.getByRole('radiogroup', { name: locale === 'de' ? 'Prüfbereich' : 'Check scope', exact: true });
        await scopes.scrollIntoViewIfNeeded();
        const radios = scopes.getByRole('radio');
        await expect(radios).toHaveCount(3);
        for (const radio of await radios.all()) {
          await expect(radio).toBeInViewport({ ratio: 1 });
          const geometry = await radio.evaluate((node) => {
            const box = node.getBoundingClientRect();
            const label = node.closest('label')!;
            const text = label.querySelector(':scope > span')!.getBoundingClientRect();
            return { width: box.width, height: box.height, offset: Math.abs(box.y + box.height / 2 - text.y - text.height / 2), targetHeight: label.getBoundingClientRect().height };
          });
          expect(geometry.width).toBeLessThanOrEqual(24);
          expect(geometry.height).toBeLessThanOrEqual(24);
          expect(geometry.offset).toBeLessThanOrEqual(2);
          expect(geometry.targetHeight).toBeGreaterThanOrEqual(44);
        }
        await radios.first().focus();
        await page.keyboard.press('ArrowDown');
        await expect(radios.nth(1)).toBeChecked();
        await page.keyboard.press('ArrowDown');
        await expect(radios.nth(2)).toBeFocused();
        await expect(radios.nth(2)).toBeChecked();
        await expect(radios.nth(2)).toBeInViewport({ ratio: 1 });
        await page.keyboard.press('ArrowDown');
        await expect(radios.first()).toBeChecked();
        await form.locator('[data-goal-field="intent"]').evaluate((node) => node.scrollIntoView({ block: 'start' }));
        await expect(scopes).toBeInViewport({ ratio: 1 });
        await page.screenshot({ path: testInfo.outputPath(`goal-scopes-modern-${locale}-${theme}.png`) });
      }
      if (shell === 'classic') await expect(page.locator('.rail.is-drawer')).toBeHidden();
      const start = page.getByRole('button', { name: locale === 'de' ? 'Das Ziel starten' : 'Start the goal', exact: true });
      await expect(start).toBeEnabled();
      if (locale === 'de') {
        const appearance = await start.evaluate((button) => {
          const style = getComputedStyle(button);
          const luminance = (color: string) => {
            const channels = color.match(/[\d.]+/g)!.slice(0, 3).map((part) => Number(part) / 255).map((part) => part <= 0.04045 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4);
            return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
          };
          const foreground = luminance(style.color);
          const background = luminance(style.backgroundColor);
          return { color: style.color, background: style.backgroundColor, opacity: Number(style.opacity), weight: Number(style.fontWeight), contrast: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05) };
        });
        expect(appearance.opacity).toBe(1);
        expect(appearance.weight).toBeGreaterThanOrEqual(600);
        expect(appearance.contrast).toBeGreaterThanOrEqual(4.5);
        await writeFile(testInfo.outputPath('start-appearance.json'), JSON.stringify(appearance));
        await testInfo.attach('Enabled dark Start contrast', { body: JSON.stringify(appearance), contentType: 'application/json' });
      }
      const narrowFormImage = testInfo.outputPath(`goal-form-narrow-${shell}-${locale}.png`);
      await page.screenshot({ path: narrowFormImage });
      await testInfo.attach('Narrow goal form', { path: narrowFormImage, contentType: 'image/png' });
      const geometry = testInfo.outputPath('narrow-goal-bounds.json');
      await writeFile(geometry, JSON.stringify(await page.locator('html, body, .workspace, .center, .goal-composer, .goal-composer-slot, .agent-body, .agent-head, .agent').evaluateAll((nodes) => nodes.map((node) => ({ className: node.className, box: node.getBoundingClientRect().toJSON(), scrollHeight: node.scrollHeight, scrollWidth: node.scrollWidth, scrollLeft: node.scrollLeft, minWidth: getComputedStyle(node).minWidth, overflow: getComputedStyle(node).overflow })))));
      await testInfo.attach('Narrow goal bounds', { path: geometry, contentType: 'application/json' });
      await expect(form).toBeInViewport({ ratio: 1 });
      await expect(page.getByRole('button', { name: locale === 'de' ? 'Das Ziel starten' : 'Start the goal', exact: true })).toBeInViewport({ ratio: 1 });
      await page.setViewportSize({ width: 1280, height: 720 });
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
      const saveCellBounds = async (name: string) => {
        await writeFile(testInfo.outputPath(name), JSON.stringify(await passed.evaluate((node) => {
          const ancestors = [];
          for (let element: Element | null = node; element !== null; element = element.parentElement) {
            const style = getComputedStyle(element);
            ancestors.push({ tag: element.tagName, className: element.className, box: element.getBoundingClientRect().toJSON(), clientWidth: element.clientWidth, clientHeight: element.clientHeight, scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight, scrollLeft: element.scrollLeft, scrollTop: element.scrollTop, overflow: style.overflow });
          }
          return ancestors;
        })));
      };
      await passed.scrollIntoViewIfNeeded();
      await saveCellBounds('goal-cell-wide.json');
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
      await page.setViewportSize({ width: 390, height: 844 });
      await passed.scrollIntoViewIfNeeded();
      await saveCellBounds('goal-cell-narrow.json');
      await expect(passed).toBeInViewport({ ratio: 1 });
      if (shell === 'modern') await expect(page.getByRole('status').filter({ hasText: /(?:Loading the binder|Der Binder wird geladen)/ })).toHaveCount(0);
      const brokenWords = await progress.getByRole('columnheader').evaluateAll((headers) => headers.flatMap((header) => {
        const words: string[] = [];
        const walker = document.createTreeWalker(header, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          for (const match of node.textContent!.matchAll(/\S+/g)) {
            const range = document.createRange();
            range.setStart(node, match.index);
            range.setEnd(node, match.index + match[0].length);
            const rectangles = Array.from(range.getClientRects());
            if (rectangles.some((rectangle) => Math.abs(rectangle.top - rectangles[0]!.top) > 0.5)) words.push(match[0]);
          }
        }
        return words;
      }));
      expect(brokenWords).toEqual([]);
      await progress.getByRole('table').scrollIntoViewIfNeeded();
      await expect(progress.getByRole('columnheader', { name: locale === 'de' ? 'Letzte Abstände' : 'Recent distances', exact: true })).toBeInViewport({ ratio: 1 });
      await expect(passed).toBeInViewport({ ratio: 1 });
      const narrowWatchImage = testInfo.outputPath(`goal-watch-narrow-${shell}-${locale}.png`);
      await page.screenshot({ path: narrowWatchImage });
      await testInfo.attach('Narrow saved result', { path: narrowWatchImage, contentType: 'image/png' });
      expect(requests).toBe(0);
    });
  }
}
