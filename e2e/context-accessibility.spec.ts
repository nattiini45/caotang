import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import { fakeEndpoint, useFakeEndpoint } from './endpoint.js';

const require = createRequire(import.meta.url);
const axePath = require.resolve('axe-core');
test.use({ bypassCSP: true });

for (const shell of ['classic', 'modern']) {
  test(`${shell} context completion keeps recovery guidance outside its option list`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('caotang.interface', value), shell);
    await fakeEndpoint(page, () => JSON.stringify({ reply: 'Answered.' }));
    await useFakeEndpoint(page);
    await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
    const panel = page.getByTestId('agent-panel');
    await expect(panel).toHaveAttribute('data-state', 'idle');
    const input = panel.getByRole('combobox', { name: 'Intent' });
    await page.addScriptTag({ path: axePath });
    for (const query of ['Storm', 'no-readable-item-matches']) {
      await input.fill(`Consider @${query}`);
      const menu = page.getByTestId('command-menu');
      const options = menu.getByRole('listbox', { name: 'Context to include' });
      await expect(menu).toBeVisible();
      await expect(options.getByRole('option')).toHaveCount(query === 'Storm' ? 1 : 0);
      await expect(input).toHaveAttribute('aria-expanded', query === 'Storm' ? 'true' : 'false');
      await expect(options).toHaveCount(query === 'Storm' ? 1 : 0);
      await expect(options.getByRole('status')).toHaveCount(0);
      const audit = await page.evaluate(async () => {
        const axe = (window as unknown as { axe: { run: (element: Element, options: unknown) => Promise<{ violations: unknown[]; incomplete: unknown[] }> } }).axe;
        const result = await axe.run(document.querySelector('[data-testid="command-menu"]')!, {
          runOnly: { type: 'rule', values: ['aria-required-children', 'aria-allowed-role', 'aria-valid-attr-value', 'scrollable-region-focusable'] },
        });
        return { violations: result.violations, incomplete: result.incomplete };
      });
      expect(audit).toEqual({ violations: [], incomplete: [] });
    }
    await expect(page.getByTestId('command-menu').getByRole('status')).toContainText('No readable context matches.');
    await input.press('Enter');
    await expect(panel).toHaveAttribute('data-state', 'idle');
    await input.press('Escape');
    await expect(page.getByTestId('command-menu')).toHaveCount(0);
  });
}
