import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

import { createProject } from './support.js';

const fixtureUrl = `/@fs/${fileURLToPath(new URL('./import-preview-fixture.ts', import.meta.url)).replaceAll('\\', '/').replace(/^\/+/, '')}`;

async function openCommit(page: Page, mode: 'reject' | 'hold'): Promise<void> {
  await page.evaluate(async ({ fixtureUrl, mode }) => {
    const { lighthouseSource } = await import(/* @vite-ignore */ fixtureUrl);
    const store = '/src/import-preview/requests.ts';
    const { openImportPreview } = await import(/* @vite-ignore */ store);
    const state = { attempts: 0, closes: [] as boolean[], release: () => {}, pending: null as Promise<{ ok: true }> | null };
    Object.assign(globalThis, { ui12: state });
    openImportPreview({
      source: {
        ...lighthouseSource(),
        commit: () => {
          state.pending = (async () => {
            state.attempts += 1;
            if (mode === 'reject' && state.attempts === 1) throw new Error('The test import was refused.');
            if (mode === 'hold') await new Promise<void>((resolve) => { state.release = resolve; });
            return { ok: true };
          })();
          return state.pending;
        },
      },
      onClose: (committed: boolean) => { state.closes.push(committed); },
    });
  }, { fixtureUrl, mode });
}

test('UI-12 a rejected custom commit shows its error and allows retry', async ({ page }) => {
  await createProject(page, 'UI12 retry');
  await openCommit(page, 'reject');
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Import 3 chapters' }).click();
  await expect(dialog.getByRole('alert')).toContainText('The test import was refused.');
  await expect(dialog.getByRole('alert')).toBeInViewport();
  await expect(dialog).toHaveAttribute('data-state', 'commit-failed');
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Import 3 chapters' }).click();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => (globalThis as unknown as { ui12: { attempts: number; closes: boolean[] } }).ui12)).toMatchObject({ attempts: 2, closes: [true] });
});

test('UI-12 Escape cannot cancel an irreversible commit', async ({ page }) => {
  await createProject(page, 'UI12 commit guard');
  await openCommit(page, 'hold');
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Import 3 chapters' }).click();
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('data-state', 'committing');
  await page.evaluate(() => (globalThis as unknown as { ui12: { release(): void } }).ui12.release());
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => (globalThis as unknown as { ui12: { closes: boolean[] } }).ui12.closes)).toEqual([true]);
});

test('UI-12 an old commit completion cannot close a newer request', async ({ page }) => {
  await createProject(page, 'UI12 replacement');
  await openCommit(page, 'hold');
  await page.getByRole('dialog').getByRole('button', { name: 'Import 3 chapters' }).click();
  await page.evaluate(async (fixtureUrl) => {
    const { lighthouseSource } = await import(/* @vite-ignore */ fixtureUrl);
    const store = '/src/import-preview/requests.ts';
    const { openImportPreview } = await import(/* @vite-ignore */ store);
    openImportPreview({ source: { ...lighthouseSource(), title: 'The newer import' } });
  }, fixtureUrl);
  const newer = page.getByRole('dialog', { name: 'The newer import' });
  await expect(newer).toBeVisible();
  const stillOpen = await page.evaluate(async () => {
    const state = (globalThis as unknown as { ui12: { release(): void; pending: Promise<unknown> } }).ui12;
    state.release();
    await state.pending;
    const store = '/src/import-preview/requests.ts';
    const { currentImportPreview } = await import(/* @vite-ignore */ store);
    return currentImportPreview() !== null;
  });
  expect(stillOpen).toBe(true);
  await expect(newer).toBeVisible();
  expect(await page.evaluate(() => (globalThis as unknown as { ui12: { closes: boolean[] } }).ui12.closes)).toEqual([false]);
  await newer.getByRole('button', { name: 'Cancel', exact: true }).click();
});
