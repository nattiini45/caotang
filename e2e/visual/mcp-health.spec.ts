import { expect, test } from '@playwright/test';
import { openHealthCard } from '../mcp-health-support.js';

for (const locale of ['en', 'de'] as const) {
  for (const shell of ['classic', 'modern'] as const) {
    test(`${shell}: MCP connecting and failed in ${locale}`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
      const { card, release } = await openHealthCard(page, locale, shell);
      const look = shell === 'modern' ? 'modern-light-glass' : 'classic-light';
      await expect(card).toHaveScreenshot(`${look}-mcp-connecting-${locale}.png`, { animations: 'disabled', caret: 'hide', maxDiffPixels: 0 });
      release();
      await expect(card).toHaveAttribute('data-state', 'failed', { timeout: 20_000 });
      await expect(card).toHaveScreenshot(`${look}-mcp-failed-${locale}.png`, { animations: 'disabled', caret: 'hide', maxDiffPixels: 0 });
    });
  }
}
