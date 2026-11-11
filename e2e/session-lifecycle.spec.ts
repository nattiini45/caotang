import { expect, test, type Locator, type Page } from '@playwright/test';
import type * as SessionModule from '../apps/desktop/src/app/session.js';
import { createProject, waitForSaved } from './support.js';

async function holdOpening(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const path = '/src/app/session.ts';
    const { ProjectSession } = await import(path) as typeof SessionModule;
    const settle = ProjectSession.prototype.settle;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    Object.assign(window, { releaseB5Demo: release });
    ProjectSession.prototype.settle = async function () { await held; return settle.call(this); };
  });
}

async function expectOpeningInViewport(page: Page, button: Locator): Promise<void> {
  await expect(button).toHaveAttribute('aria-busy', 'true');
  await expect(button).toHaveClass(/\bis-opening\b/);
  const geometry = await button.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const spinner = getComputedStyle(element, '::before');
    return {
      left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
      viewportWidth: innerWidth, viewportHeight: innerHeight,
      spinnerWidth: parseFloat(spinner.inlineSize), content: spinner.content, animation: spinner.animationName,
      fits: element.scrollWidth <= element.clientWidth,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.spinnerWidth).toBeGreaterThan(0);
  expect(geometry.content).not.toBe('none');
  expect(geometry.animation).toBe('none');
  expect(geometry.fits).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('.home .is-opening')).toHaveCount(1);
  await expect(page.getByRole('status').filter({ hasText: /Opening the project|Projekt wird geöffnet/ })).toHaveClass('visually-hidden');
}

for (const shell of ['classic', 'modern'] as const) {
  test(`${shell}: a rejected close settle reports the failure and lets another tab open the project`, async ({ page, context }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript((value) => localStorage.setItem('caotang.interface', value), shell);
    await createProject(page, 'A released project');
    await waitForSaved(page);
    await page.evaluate(async () => {
      const path = '/src/app/session.ts';
      const { ProjectSession } = await import(path) as typeof SessionModule;
      const close = ProjectSession.prototype.closeSafely;
      ProjectSession.prototype.closeSafely = function () {
        this.settle = () => Promise.reject(new Error('The final asset check failed.'));
        return close.call(this);
      };
    });
    if (shell === 'modern') {
      await page.getByRole('toolbar', { name: 'Scene' }).getByRole('button', { name: 'More', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Projects', exact: true }).click();
    } else {
      await page.getByRole('button', { name: 'Projects', exact: true }).click();
    }
    await expect(page.locator('.home')).toHaveAttribute('data-state', 'idle');
    await expect(page.getByRole('status').filter({ hasText: 'The writing session could not be recorded:' })).toContainText('The final asset check failed.');
    const other = await context.newPage();
    try {
      await other.goto('/');
      await expect(other.locator('.home')).toHaveAttribute('data-state', 'idle');
      await other.getByRole('listitem').filter({ hasText: 'A released project' }).getByRole('button', { name: 'Open', exact: true }).click();
      await expect(other.getByRole('tree', { name: 'Binder' }).or(other.getByTestId('modern-binder-bar')).first()).toBeVisible();
      expect(errors).toEqual([]);
    } finally {
      await other.close();
    }
  });
}

test('demo opening keeps one intent and blocks competing project actions', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.home')).toHaveAttribute('data-demo-state', 'idle');
  await holdOpening(page);
  const demoButtons = page.getByRole('group', { name: 'Demo intents' }).getByRole('button');
  await demoButtons.first().evaluate((button) => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(page.locator('.home')).toHaveAttribute('data-demo-state', 'opening');
  await expect(page.getByRole('button', { name: 'Create project', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Import bundle (.caotang)', exact: true })).toBeDisabled();
  for (const button of await demoButtons.all()) await expect(button).toBeDisabled();
  await expect(demoButtons.first()).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('status').filter({ hasText: 'Opening the project' })).toHaveClass('visually-hidden');
  await page.evaluate(() => (window as unknown as { releaseB5Demo(): void }).releaseB5Demo());
  await expect(page.getByTestId('ghost-bar')).toBeVisible();
  await page.reload();
  await expect(page.locator('.project-list > li')).toHaveCount(1);
});

for (const shell of ['classic', 'modern'] as const) {
  for (const locale of ['en', 'de'] as const) {
    test.describe(`${shell} ${locale}: opening feedback at 390 px`, () => {
      test.use({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
      test.beforeEach(async ({ page }) => {
        await page.addInitScript((value) => localStorage.setItem('caotang.interface', value), shell);
        await page.goto('/');
        await expect(page.locator('.home')).toHaveAttribute('data-state', 'idle');
        if (locale === 'de') {
          await page.getByTestId('open-settings').click();
          await page.getByTestId('settings').locator('[data-section="appearance"]').click();
          await page.locator('input[name="interface-language"][value="de"]').click();
          await expect(page.locator('html')).toHaveAttribute('lang', 'de');
          await page.keyboard.press('Escape');
          await expect(page.getByTestId('settings')).toBeHidden();
        }
      });

      test('the pressed demo button keeps its visible progress inside the viewport', async ({ page }) => {
        await holdOpening(page);
        const button = page.locator('.first-run-actions button').first();
        const label = await button.textContent();
        await button.click();
        await expect(page.locator('.home')).toHaveAttribute('data-demo-state', 'opening');
        await expect(button).toHaveText(label!);
        await expectOpeningInViewport(page, button);
        await expect(page.locator('.new-project button')).toBeDisabled();
      });

      test('the pressed project button keeps its visible progress inside the viewport', async ({ page }) => {
        await page.locator('.new-project input').fill('Visible opening');
        await page.locator('.new-project button').click();
        await expect(page.locator('.home')).toHaveCount(0);
        await waitForSaved(page);
        await page.reload();
        await expect(page.locator('.home')).toHaveAttribute('data-state', 'idle');
        await holdOpening(page);
        const button = page.locator('.project-list .project-actions > button').first();
        const label = await button.textContent();
        await button.click();
        await expect(button).toHaveText(label!);
        await expectOpeningInViewport(page, button);
        await expect(page.locator('.project-list .project-name').first()).toBeVisible();
        await expect(page.locator('.new-project button')).toBeDisabled();
      });
    });
  }
}
