import { expect, test, type Page } from '@playwright/test';

declare global {
  interface Window {
    b2Export: { ready(): void; failReady(): void; stop(): void; closes(): number; unmount(): void };
    b2Encoding: { answer(index?: number): void; fail(index?: number): void; unmount(): void };
  }
}

async function mount(page: Page, kind: 'export' | 'readiness' | 'encoding'): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Caotang', exact: true })).toBeVisible();
  await page.evaluate(async (kind) => {
    const url = '/test/dialog-races-fixture.tsx';
    const fixture = await import(/* @vite-ignore */ url) as {
      mountExportRace(failReadiness: boolean): Promise<Window['b2Export']>;
      mountEncodingRace(): Window['b2Encoding'];
    };
    if (kind === 'encoding') window.b2Encoding = fixture.mountEncodingRace();
    else window.b2Export = await fixture.mountExportRace(kind === 'readiness');
  }, kind);
}

test('B2 compile keeps Escape and Cancel blocked until its running work settles', async ({ page }) => {
  await mount(page, 'export');
  const dialog = page.getByRole('dialog', { name: 'Export', exact: true });
  await dialog.getByRole('button', { name: 'Compile', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Compiling…' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('data-state', 'running');
  expect(await page.evaluate(() => window.b2Export.closes())).toBe(0);
  await page.evaluate(() => window.b2Export.ready());
  await expect(dialog).toHaveAttribute('data-preview-state', 'ready');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await page.evaluate(() => window.b2Export.stop());
  await downloaded;
  await expect(dialog).not.toBeVisible();
  expect(await page.evaluate(() => window.b2Export.closes())).toBe(1);
});

test('B2 compile blocks Cancel in the same synchronous event batch', async ({ page }) => {
  await mount(page, 'export');
  const dialog = page.getByRole('dialog', { name: 'Export', exact: true });
  await expect(dialog).toHaveAttribute('data-state', 'idle');
  await page.evaluate(() => {
    const dialog = document.querySelector('.export-dialog');
    const buttons = Array.from(dialog!.querySelectorAll('button'));
    buttons.find((button) => button.textContent === 'Compile')!.click();
    buttons.find((button) => button.textContent === 'Cancel')!.click();
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('data-state', 'running');
  expect(await page.evaluate(() => window.b2Export.closes())).toBe(0);
});

test('B2 compile retry clears the failed preview readiness before checking again', async ({ page }) => {
  await mount(page, 'readiness');
  const dialog = page.getByRole('dialog', { name: 'Export', exact: true });
  await expect(dialog.getByRole('group', { name: 'Preview' })).toContainText('B2 readiness failed');
  await dialog.getByRole('button', { name: 'Compile', exact: true }).click();
  await expect(dialog.getByRole('group', { name: 'Preview' })).not.toContainText('B2 readiness failed');
  await page.evaluate(() => window.b2Export.ready());
  await expect(dialog.getByRole('region', { name: 'What will be compiled' })).toBeVisible();
});

test('B2 compile exposes a failed attempt and retries it without reopening the dialog', async ({ page }) => {
  await mount(page, 'export');
  const dialog = page.getByRole('dialog', { name: 'Export', exact: true });
  await expect(dialog).toHaveAttribute('data-state', 'idle');
  await dialog.getByRole('button', { name: 'Compile', exact: true }).click();
  await expect(dialog).toHaveAttribute('data-state', 'running');
  await page.evaluate(() => window.b2Export.failReady());
  await expect(dialog).toHaveAttribute('data-state', 'failed');
  await expect(dialog).toHaveAttribute('data-preview-state', 'failed');
  await expect(dialog.getByRole('alert')).toContainText('B2 compile readiness failed');
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Compile', exact: true }).click();
  await expect(dialog).toHaveAttribute('data-state', 'running');
  await expect(dialog).toHaveAttribute('data-preview-state', 'waiting');
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  const downloaded = page.waitForEvent('download');
  await page.evaluate(() => { window.b2Export.ready(); window.b2Export.stop(); });
  await downloaded;
  await expect(dialog).not.toBeVisible();
  expect(await page.evaluate(() => window.b2Export.closes())).toBe(1);
});

test('B2 encoding keeps a later manual decision when an earlier AI answer arrives', async ({ page }) => {
  await mount(page, 'encoding');
  const dialog = page.getByTestId('encoding-dialog');
  const picker = dialog.getByRole('combobox', { name: 'Read it as' });
  await expect(picker).toHaveValue('windows-1252');
  await dialog.getByRole('button', { name: 'Ask the AI', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Asking…' })).toBeVisible();
  await dialog.getByRole('radio', { name: /^Convert it/ }).check();
  await page.evaluate(() => window.b2Encoding.answer());
  await expect(dialog.getByRole('button', { name: 'Ask the AI', exact: true })).toBeVisible();
  await expect(picker).toHaveValue('windows-1252');
});

test('B2 encoding lets a manual encoding selection supersede pending advice and a newer request', async ({ page }) => {
  await mount(page, 'encoding');
  const dialog = page.getByTestId('encoding-dialog');
  const picker = dialog.getByRole('combobox', { name: 'Read it as' });
  const card = dialog.locator('.encoding-file');
  await dialog.getByRole('button', { name: 'Ask the AI', exact: true }).click();
  await expect(card).toHaveAttribute('data-state', 'asking');
  await expect(picker).toBeEnabled();
  const another = await picker.locator('option').evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value).find((value) => value !== 'windows-1252'));
  expect(another).toBeDefined();
  await picker.selectOption(another!);
  await expect(card).toHaveAttribute('data-state', 'ready');
  await dialog.getByRole('button', { name: 'Ask the AI', exact: true }).click();
  await page.evaluate(() => window.b2Encoding.answer(0));
  await expect(card).toHaveAttribute('data-state', 'asking');
  await expect(picker).toHaveValue(another!);
  await page.evaluate(() => window.b2Encoding.fail(1));
  await expect(card).toHaveAttribute('data-state', 'ready');
  await expect(dialog.getByRole('status')).toContainText('B2 advice failed');
  await picker.selectOption('windows-1252');
  await expect(dialog.getByRole('status')).toHaveCount(0);
});

test('B2 encoding accepts current advice without changing the default Leave choice', async ({ page }) => {
  await mount(page, 'encoding');
  const dialog = page.getByTestId('encoding-dialog');
  await dialog.getByRole('button', { name: 'Ask the AI', exact: true }).click();
  await expect(dialog.locator('.encoding-file')).toHaveAttribute('data-state', 'asking');
  await page.evaluate(() => window.b2Encoding.answer());
  await expect(dialog.getByRole('combobox', { name: 'Read it as' })).toHaveValue('utf-16le');
  await expect(dialog.getByRole('radio', { name: /^Leave it/ })).toBeChecked();
  await expect(dialog.getByRole('status')).toContainText('The AI suggests');
});

for (const exit of ['Cancel', 'Open the project', 'Escape', 'unmount'] as const) {
  test(`B2 encoding ignores pending advice after ${exit}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await mount(page, 'encoding');
    const dialog = page.getByTestId('encoding-dialog');
    await dialog.getByRole('button', { name: 'Ask the AI', exact: true }).click();
    await expect(dialog.locator('.encoding-file')).toHaveAttribute('data-state', 'asking');
    if (exit === 'unmount') await page.evaluate(() => window.b2Encoding.unmount());
    else if (exit === 'Escape') await page.keyboard.press('Escape');
    else await dialog.getByRole('button', { name: exit, exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page.evaluate(async () => {
      window.b2Encoding.answer();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    await expect(dialog).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
