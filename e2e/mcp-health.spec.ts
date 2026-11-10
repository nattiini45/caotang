import { expect, test } from '@playwright/test';
import { openHealthCard } from './mcp-health-support.js';

for (const locale of ['en', 'de'] as const) {
  test(`MCP health survives reopening Settings and a failed connect can retry (${locale})`, async ({ page }) => {
    const { card, settings, connect, release } = await openHealthCard(page, locale);
    await expect(card.getByTestId('mcp-state')).toHaveText(locale === 'de' ? 'Wird verbunden' : 'Connecting');
    await expect(connect()).toBeDisabled();
    await expect(card.getByTestId('mcp-detail')).toHaveText(locale === 'de'
      ? 'Die Verbindung zum Server wird hergestellt und seine Werkzeugliste geprüft…'
      : 'Connecting to the server and checking its tool list…');
    await page.keyboard.press('Escape');
    await expect(settings).toBeHidden();
    await page.getByRole('button', { name: locale === 'de' ? 'Einstellungen' : 'Settings', exact: true }).click();
    await settings.locator('[data-section="mcp"]').click();
    await expect(card).toHaveAttribute('data-state', 'connecting');
    await expect(connect()).toBeDisabled();
    release();
    await expect(card).toHaveAttribute('data-state', 'failed', { timeout: 20_000 });
    await expect(card).toHaveAttribute('data-reason', 'network');
    await expect(card.getByTestId('mcp-state')).toHaveText(locale === 'de' ? 'Fehlgeschlagen' : 'Failed');
    await expect(connect()).toBeEnabled();
    await expect(card.getByTestId('mcp-detail')).toContainText('server unreachable');
    await expect(card).not.toContainText('Connected.');
    for (const width of [390, 960]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(() => card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
    let releaseRetry!: () => void;
    const retry = new Promise<void>((resolve) => { releaseRetry = resolve; });
    await page.unroute('https://health.example.test/mcp');
    await page.route('https://health.example.test/mcp', async (route) => { await retry; await route.abort('failed'); });
    await connect().click();
    await expect(card).toHaveAttribute('data-state', 'connecting');
    await expect(card).not.toHaveAttribute('data-reason');
    releaseRetry();
    await expect(card).toHaveAttribute('data-state', 'failed', { timeout: 20_000 });
    await page.reload();
    await page.getByRole('button', { name: locale === 'de' ? 'Einstellungen' : 'Settings', exact: true }).click();
    await settings.locator('[data-section="mcp"]').click();
    await expect(card).toHaveAttribute('data-state', 'configured');
    await expect(card).not.toHaveAttribute('data-reason');
  });
}
