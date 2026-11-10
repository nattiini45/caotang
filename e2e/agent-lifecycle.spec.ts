import { expect, test } from '@playwright/test';

for (const shell of ['classic', 'modern'] as const) {
  test(`${shell}: a loading turn keeps the composer and Stop available and settles on its published idle state`, async ({ page }, testInfo) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.addInitScript((chosen) => localStorage.setItem('caotang.interface', chosen), shell);
    await page.route('**/src/app/lazy-harness.ts*', async (route) => { await held; await route.continue(); });
    try {
      await page.goto('/');
      await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
      const panel = page.getByTestId('agent-panel');
      await expect(panel).toHaveAttribute('data-state', 'starting');
      await expect(panel.getByTestId('agent-step')).toHaveText('The agent is loading.');
      await expect(panel.getByRole('combobox', { name: 'Intent' })).toBeEnabled();
      const stop = panel.getByRole('button', { name: 'Stop', exact: true });
      await expect(stop).toBeEnabled();
      await page.screenshot({ path: testInfo.outputPath('agent-loading.png') });
      await stop.click();
      await expect(panel).toHaveAttribute('data-state', 'stopping');
      await expect(panel.getByTestId('agent-step')).toHaveText('The agent is stopping.');
      release();
      await expect(panel).toHaveAttribute('data-state', 'idle');
      await expect(panel.getByTestId('agent-stop')).toHaveCount(0);
      await expect(panel.locator('.agent-report-text')).toContainText('Stopped by you.');
    } finally {
      release();
    }
  });
}
