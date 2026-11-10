import { expect, test } from '@playwright/test';

for (const logFailure of [false, true]) {
  test(`a failed ${logFailure ? 'compile log' : 'artifact'} write stays visible and can be retried`, async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Caotang', exact: true })).toBeVisible();
    await page.evaluate(async (logFailure) => {
      const path = '/test/export-job-fixture.tsx';
      const fixture = await import(/* @vite-ignore */ path) as { mountExportJobFailure(logFailure: boolean): Promise<{ fail(): void }> };
      Object.assign(window, { b8Job: await fixture.mountExportJobFailure(logFailure) });
    }, logFailure);
    const dialog = page.getByRole('dialog', { name: 'Export', exact: true });
    await dialog.getByRole('radio', { name: /^Markdown \(\.md\)/ }).check();
    let downloads = 0;
    page.on('download', () => { downloads++; });
    await dialog.getByRole('button', { name: 'Compile', exact: true }).click();
    await expect(dialog).toHaveAttribute('data-state', 'running');
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
    await page.evaluate(() => (window as unknown as { b8Job: { fail(): void } }).b8Job.fail());
    await expect(dialog).toHaveAttribute('data-state', 'failed');
    await expect(dialog.getByRole('alert')).toContainText(logFailure ? 'The compile log could not be saved.' : 'The export folder is full.');
    expect(downloads).toBe(0);
    await expect(dialog.getByRole('button', { name: 'Compile', exact: true })).toBeEnabled();
    const downloaded = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Compile', exact: true }).click();
    expect((await downloaded).suggestedFilename()).toMatch(/\.md$/);
    await expect(dialog).not.toBeVisible();
    expect(downloads).toBe(1);
  });
}
