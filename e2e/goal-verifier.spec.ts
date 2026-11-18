import { expect, type Locator } from '@playwright/test';
import { test } from './test.js';
import { fakeEndpoint, planThenAnswer, useFakeEndpoint } from './endpoint.js';
import { createGoalScene } from './goal-scene-flow.js';
import { waitForSaved, chooseInterfaceLanguage} from './support.js';

async function controlContrast(control: Locator) {
  return control.evaluate(node => {
    const style = getComputedStyle(node);
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('The contrast check needs a canvas.');
    const rgba = (color: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    const background = rgba(style.backgroundColor);
    const luminance = (channels: readonly number[]) => channels.slice(0, 3).map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
    const ratio = (color: string) => {
      const foreground = rgba(color);
      const alpha = foreground[3]! / 255;
      const visible = foreground.slice(0, 3).map((value, index) => value * alpha + background[index]! * (1 - alpha));
      const light = [luminance(visible), luminance(background)].sort((a, b) => b - a);
      return (light[0]! + 0.05) / (light[1]! + 0.05);
    };
    return { opaque: background[3] === 255, text: ratio(style.color), edge: ratio(style.borderColor) };
  });
}

for (const shell of ['classic', 'modern'] as const) {
  for (const locale of ['en', 'de'] as const) {
    for (const theme of ['light', 'dark'] as const) {
      test(`independent review remains explicit, isolated and durable (${shell}, ${locale}, ${theme})`, { tag: shell === 'modern' ? '@modern' : [] }, async ({ page }, testInfo) => {
        test.setTimeout(60_000);
        await page.addInitScript(({ shell, theme }) => {
          localStorage.setItem('caotang.interface', shell);
          localStorage.setItem('caotang.theme', theme);
        }, { shell, theme });
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        const wire: { stream?: boolean; messages: { role: string; content: string }[]; tools?: unknown }[] = [];
        page.on('request', request => {
          if (request.method() === 'POST' && request.url().endsWith('/chat/completions')) wire.push(request.postDataJSON() as typeof wire[number]);
        });
        let requests = 0;
        let reviews = 0;
        const gate = theme === 'dark';
        const actorIntent = 'Clarify the departure synopsis without changing the scene.';
        const rubric = locale === 'de' ? 'Die Synopsis nennt die Abfahrtszeit.' : 'The synopsis names the departure time.';
        const synopsis = 'The ferry leaves at dawn.';
        const actor = planThenAnswer({ steps: [{ tool: 'synopsis.fill', params: { docs: ['Opening'], source: 'text', max_words: 30 }, expect: 'The departure is named.' }] }, 'Done.', synopsis);
        await fakeEndpoint(page, request => {
          requests += 1;
          if (request.system.includes('You are an independent verifier.')) {
            reviews += 1;
            expect(request.tools).toBeUndefined();
            expect(request.user).toContain(rubric);
            expect(request.user).toContain(synopsis);
            expect(request.user).not.toContain(actorIntent);
            expect(request.user).not.toContain('ACTOR_ONLY_REASONING');
            return { text: JSON.stringify({ pass: gate, reasons: gate ? [] : [locale === 'de' ? 'Die Abfahrt könnte deutlicher sein.' : 'The departure could be clearer.'] }), reasoning: 'VERIFIER_ONLY_REASONING' };
          }
          const reply = actor(request);
          return typeof reply === 'string' ? { text: reply, reasoning: 'ACTOR_ONLY_REASONING' } : { ...reply, reasoning: 'ACTOR_ONLY_REASONING' };
        });
        await useFakeEndpoint(page);
        const title = `Review Book ${shell} ${locale} ${theme}`;
        await createGoalScene(page, title, shell);
        if (locale === 'de') {
          if (shell === 'modern') {
            await page.getByRole('toolbar', { name: 'Scene' }).getByRole('button', { name: 'More', exact: true }).click();
            await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
          } else await page.getByTestId('open-settings').click();
          const settings = page.getByTestId('settings');
          await settings.locator('[data-section="appearance"]').click();
          await chooseInterfaceLanguage(page, settings, 'de');
          await expect(page.locator('html')).toHaveAttribute('lang', 'de');
          await page.keyboard.press('Escape');
          await expect(settings).toBeHidden();
        }
        if (shell === 'modern') await page.keyboard.press('Control+j');
        else await page.getByRole('button', { name: 'Agent', exact: true }).click();
        await page.getByRole('button', { name: locale === 'de' ? 'Ziel' : 'Goal', exact: true }).click();
        const form = page.getByRole('form', { name: locale === 'de' ? 'Auf ein Ziel hinarbeiten' : 'Run toward a goal', exact: true });
        await form.getByRole('textbox', { name: locale === 'de' ? 'Zielauftrag' : 'Goal intent', exact: true }).fill(actorIntent);
        const synopses = form.getByRole('checkbox', { name: locale === 'de' ? 'Jede Synopsis ist ausgefüllt' : 'Every synopsis is filled', exact: true });
        await synopses.focus();
        await page.keyboard.press('Space');
        await expect(synopses).toBeChecked();
        const optional = form.getByRole('checkbox', { name: locale === 'de' ? 'Eine unabhängige Prüfung hinzufügen' : 'Add an independent review', exact: true });
        await expect(optional).not.toBeChecked();
        await optional.focus();
        await page.keyboard.press('Space');
        await expect(optional).toBeChecked();
        const required = form.getByRole('checkbox', { name: locale === 'de' ? 'Diese Prüfung muss bestanden werden' : 'Require this review to pass', exact: true });
        await expect(required).not.toBeChecked();
        const criterion = form.getByRole('textbox', { name: locale === 'de' ? 'Prüfkriterium' : 'Review criterion', exact: true });
        await expect(criterion).toHaveAttribute('aria-invalid', 'false');
        const start = form.getByRole('button', { name: locale === 'de' ? 'Das Ziel starten' : 'Start the goal', exact: true });
        await start.click();
        await expect(criterion).toBeFocused();
        await expect(criterion).toHaveAttribute('aria-invalid', 'true');
        expect(requests).toBe(0);
        await criterion.fill(rubric);
        await expect(criterion).toHaveAttribute('aria-invalid', 'false');
        const appearance = await controlContrast(criterion);
        expect(appearance.opaque).toBe(true);
        expect(appearance.text).toBeGreaterThanOrEqual(4.5);
        expect(appearance.edge).toBeGreaterThanOrEqual(3);
        await required.focus();
        await page.keyboard.press('Space');
        await expect(required).toBeChecked();
        await page.keyboard.press('Space');
        await expect(required).not.toBeChecked();
        if (gate) await page.keyboard.press('Space');
        await expect(form.getByRole('spinbutton', { name: locale === 'de' ? 'Limit für Modellaufrufe' : 'Model-call limit', exact: true })).toHaveValue('8');
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: width === 390 ? 844 : 720 });
          await criterion.scrollIntoViewIfNeeded();
          if (shell === 'modern') await expect(page.getByRole('status').filter({ hasText: /(?:Loading the binder|Der Binder wird geladen)/ })).toHaveCount(0);
          const overflow = await form.locator('.goal-composer-fields').evaluate(node => node.scrollWidth > node.clientWidth + 1);
          expect(overflow).toBe(false);
          await expect(start).toBeInViewport({ ratio: 1 });
          const image = testInfo.outputPath(`review-setup-${shell}-${locale}-${theme}-${width}.png`);
          await page.screenshot({ path: image });
          await testInfo.attach('Independent review setup', { path: image, contentType: 'image/png' });
        }
        await start.focus();
        await page.keyboard.press('Enter');
        const approval = page.getByTestId('plan-card').getByRole('button', { name: locale === 'de' ? 'Genehmigen' : 'Approve', exact: true });
        await expect(approval).toBeVisible();
        expect(reviews).toBe(0);
        await approval.click();
        const progress = page.getByRole('region', { name: /^Goal progress:|^Zielfortschritt:/ });
        const review = page.getByTestId('goal-independent-review');
        await expect(progress).toHaveAttribute('data-status', 'passed');
        await expect(review).toHaveAttribute('data-review-status', 'complete');
        await expect(review).toContainText(gate ? locale === 'de' ? 'Prüfung bestanden' : 'Review passed' : locale === 'de' ? 'Überarbeitung nötig' : 'Review needs work');
        await expect(review).not.toContainText('VERIFIER_ONLY_REASONING');
        expect(reviews).toBe(1);
        const sent = wire.filter(request => request.messages[0]?.content.includes('You are an independent verifier.'));
        expect(sent).toHaveLength(1);
        expect(sent[0]?.messages.map(message => message.role)).toEqual(['system', 'user']);
        expect(sent[0]?.tools).toBeUndefined();
        expect(JSON.stringify(sent[0]?.messages)).not.toContain('ACTOR_ONLY_REASONING');
        for (const width of [390, 1280]) {
          await page.setViewportSize({ width, height: width === 390 ? 844 : 720 });
          await review.scrollIntoViewIfNeeded();
          expect(await review.evaluate(node => node.scrollWidth > node.clientWidth + 1)).toBe(false);
          const image = testInfo.outputPath(`review-result-${shell}-${locale}-${theme}-${width}.png`);
          await page.screenshot({ path: image });
          await testInfo.attach('Independent review result', { path: image, contentType: 'image/png' });
        }
        await waitForSaved(page);
        const beforeReload = requests;
        await page.reload();
        await page.getByRole('listitem').filter({ hasText: title }).getByRole('button', { name: locale === 'de' ? 'Öffnen' : 'Open', exact: true }).click();
        if (shell === 'modern') await page.keyboard.press('Control+j');
        await expect(page.getByTestId('goal-independent-review')).toHaveAttribute('data-review-status', 'complete');
        expect(requests).toBe(beforeReload);
        expect(reviews).toBe(1);
        expect(errors).toEqual([]);
      });
    }
  }
}
