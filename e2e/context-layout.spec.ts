import { expect, test, type Page } from '@playwright/test';
import { fakeEndpoint, useFakeEndpoint } from './endpoint.js';

async function visibleTurnLines(page: Page): Promise<number> {
  return page.locator('.agent-body').evaluate((body) => {
    const bounds = body.getBoundingClientRect();
    return Math.max(0, ...Array.from(body.querySelectorAll('.agent-turn')).map((turn) => {
      const box = turn.getBoundingClientRect();
      const style = getComputedStyle(turn);
      const line = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.5;
      return Math.max(0, Math.min(box.bottom, bounds.bottom) - Math.max(box.top, bounds.top)) / line;
    }));
  });
}

for (const variant of [
  { shell: 'modern', language: 'en', width: 1280, height: 900, theme: 'dark' },
  { shell: 'modern', language: 'de', width: 390, height: 844, theme: 'light' },
  { shell: 'classic', language: 'en', width: 1280, height: 900, theme: 'light' },
  { shell: 'classic', language: 'de', width: 390, height: 844, theme: 'dark' },
]) {
  test(`${variant.shell} ${variant.language} context stays bounded in default and opened states`, async ({ page }, testInfo) => {
    await page.addInitScript(({ shell, theme }) => {
      localStorage.setItem('caotang.interface', shell);
      localStorage.setItem('caotang.theme', theme);
    }, variant);
    await fakeEndpoint(page, () => JSON.stringify({ reply: 'Answered.' }));
    await useFakeEndpoint(page);
    await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
    const panel = page.getByTestId('agent-panel');
    await expect(panel).toHaveAttribute('data-state', 'idle');
    if (variant.language === 'de') {
      if (variant.shell === 'modern') {
        await page.getByTestId('agent-close').click();
        await page.getByTestId('modern-top-ornament').getByRole('button', { name: 'More' }).click();
        await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
      } else await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const settings = page.getByTestId('settings');
      await settings.locator('[data-section="appearance"]').click();
      await settings.locator('input[name="interface-language"][value="de"]').click();
      await expect(page.locator('html')).toHaveAttribute('lang', 'de');
      await settings.locator('.settings-head button').click();
      if (variant.shell === 'modern') await page.keyboard.press('Control+j');
    }
    await page.setViewportSize({ width: variant.width, height: variant.height });
    const input = panel.getByRole('combobox');
    await input.fill('Consider @Storm');
    await expect(page.getByTestId('command-menu').getByRole('option')).toHaveCount(1);
    await input.press('Enter');
    const request = panel.getByTestId('request-context');
    await expect(request).toHaveAttribute('aria-busy', 'false');
    await expect(request.locator('details.context-preview')).not.toHaveAttribute('open');
    await expect(request.locator('details.context-accounting')).not.toHaveAttribute('open');
    if (variant.shell === 'modern') expect(await visibleTurnLines(page)).toBeGreaterThanOrEqual(3);
    await page.screenshot({ path: testInfo.outputPath(`context-${variant.shell}-${variant.language}-${variant.width}-default.png`) });
    await request.locator('details.context-preview > summary').click();
    await expect(request.locator('details.context-preview')).toHaveAttribute('open', '');
    await request.locator('details.context-accounting > summary').click();
    await expect(request.locator('details.context-accounting')).toHaveAttribute('open', '');
    await expect(request.locator('.context-layers')).toBeVisible();
    await request.locator('.context-layers > li').first().scrollIntoViewIfNeeded();
    await expect(request.locator('.context-layers > li').first()).toBeInViewport();
    if (variant.shell === 'modern') expect(await visibleTurnLines(page)).toBeGreaterThanOrEqual(3);
    const context = panel.locator('.composer-context');
    expect(await context.evaluate((element) => element.clientHeight)).toBeLessThanOrEqual(Math.min(variant.height * 0.3, 256));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`context-${variant.shell}-${variant.language}-${variant.width}-opened.png`) });
  });
}

test('context options show a document path or a codex type instead of storage IDs', async ({ page }) => {
  await fakeEndpoint(page, () => JSON.stringify({ reply: 'Answered.' }));
  await useFakeEndpoint(page);
  await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
  await expect(page.getByTestId('agent-panel')).toHaveAttribute('data-state', 'idle');
  const input = page.getByRole('combobox', { name: 'Intent' });
  for (const [query, description] of [['Landing', 'Manuscript / Chapter 1'], ['Elena', 'Character']]) {
    await input.fill(`Consider @${query}`);
    const option = page.getByRole('listbox', { name: 'Context to include' }).getByRole('option');
    await expect(option).toHaveCount(1);
    await expect(option).toContainText(description!);
    const id = await option.getAttribute('data-context-id');
    expect(id).toBeTruthy();
    await expect(option).not.toContainText(id!);
  }
});

for (const width of [390, 1440]) {
  test(`Modern Rewind labels and consequences fit at ${width}px`, async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('caotang.interface', 'modern'));
    await page.goto('/');
    await page.getByRole('button', { name: 'Fill in the synopses', exact: true }).click();
    const panel = page.getByTestId('agent-panel');
    await panel.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(panel.getByTestId('checkpoint')).toBeVisible();
    await page.setViewportSize({ width, height: 900 });
    const menu = panel.getByTestId('turn-menu').last();
    const toggle = menu.locator('.turn-menu-toggle');
    await expect(toggle).toHaveText('Rewind');
    expect(await toggle.evaluate((element) => element.scrollWidth <= element.clientWidth && getComputedStyle(element).whiteSpace === 'nowrap')).toBe(true);
    await toggle.focus();
    await page.keyboard.press('Enter');
    const options = menu.getByRole('group');
    await expect(options).toBeVisible();
    expect(await options.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const body = element.closest('.agent-body')!.getBoundingClientRect();
      return box.left >= body.left && box.right <= body.right && element.scrollWidth <= element.clientWidth &&
        Array.from(element.querySelectorAll('button, span')).every((node) => node.scrollWidth <= node.clientWidth);
    })).toBe(true);
    await page.keyboard.press('Escape');
    await expect(options).toHaveCount(0);
    await expect(toggle).toBeFocused();
    await toggle.click();
    await menu.getByRole('button', { name: /^Restore both/ }).click();
    await expect(page.getByRole('dialog', { name: 'Restore the project and rewind the conversation?' })).toBeVisible();
  });
}
