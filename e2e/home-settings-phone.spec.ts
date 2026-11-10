import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 } });

test('Modern Home wraps unbroken introduction text and demo labels without page overflow', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('caotang.interface', 'modern'));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-shell', 'modern');
  const home = page.locator('.home');
  const introduction = home.locator('.first-run > p').first();
  const demo = home.locator('.first-run-actions button').last();
  await expect(introduction).toBeVisible();
  await introduction.evaluate((element) => { element.textContent = 'W'.repeat(80); });
  await demo.evaluate((element) => { element.textContent = 'W'.repeat(80); });
  for (const content of [introduction, demo]) {
    const geometry = await content.evaluate((element) => ({
      scroll: element.scrollWidth, width: element.clientWidth, wrap: getComputedStyle(element).overflowWrap,
    }));
    expect(geometry.scroll <= geometry.width, JSON.stringify(geometry)).toBe(true);
    const box = await content.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const shell of ['classic', 'modern'] as const) {
  test.describe(`${shell} Home and Settings on a phone`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((value) => localStorage.setItem('caotang.interface', value), shell);
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-shell', shell);
      await expect(page.getByRole('heading', { name: 'Projects in this browser', exact: true })).toBeVisible();
    });

    test('empty Home keeps its introduction first; returning projects come first and still open', async ({ page }, testInfo) => {
      await expect(page.getByRole('heading', { name: 'No projects here yet', exact: true })).toBeVisible();
      await expect(page.locator('.project-list')).toHaveCount(0);
      const emptyOrder = await page.locator('.home').evaluate((home) => {
        const top = (selector: string): number => home.querySelector(selector)?.getBoundingClientRect().top ?? -1;
        return [top('.home-head'), top('.first-run'), top('[aria-labelledby="home-new"]'), top('[aria-labelledby="home-projects"]')];
      });
      expect(emptyOrder.every((top) => top >= 0)).toBe(true);
      expect(emptyOrder).toEqual([...emptyOrder].sort((a, b) => a - b));

      await page.getByRole('textbox', { name: 'Project name', exact: true }).fill('Phone project');
      await page.getByRole('button', { name: 'Create project', exact: true }).click();
      await expect(page.locator(shell === 'modern' ? '[data-testid="modern-stage"]' : '.workspace')).toBeVisible();
      await page.reload();

      const projects = page.getByRole('region', { name: 'Projects in this browser', exact: true });
      await expect(projects.getByRole('listitem')).toHaveCount(1);
      const order = await page.locator('.home').evaluate((home) =>
        [...home.children]
          .filter((child) => child.getBoundingClientRect().height > 0)
          .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
          .map((child) => child.getAttribute('aria-labelledby')),
      );
      expect(order[0]).toBe('home-projects');
      await expect(projects.getByRole('heading', { name: 'Projects in this browser', exact: true })).toBeInViewport();
      await expect(projects.getByRole('button', { name: 'Open', exact: true })).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath('returning-home.png') });
      await projects.getByRole('button', { name: 'Open', exact: true }).click();
      await expect(page.locator(shell === 'modern' ? '[data-testid="modern-stage"]' : '.workspace')).toBeVisible();
    });

    test('Settings sections stay in one scrolling strip, with a pill on the section in use', async ({ page }, testInfo) => {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
      const nav = settings.getByRole('navigation', { name: 'Settings sections', exact: true });
      const sections = nav.getByRole('button');
      await expect(sections).toHaveCount(10);
      await expect(nav).toHaveCSS('flex-wrap', 'nowrap');
      await expect(nav).toHaveCSS('overflow-x', 'auto');
      await expect(nav).toHaveCSS('scroll-snap-type', /^x(?: proximity)?$/);
      expect(await nav.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
      const tops = await sections.evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().top));
      expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(1);
      expect(await sections.evaluateAll((buttons) => buttons.every((button, index) => {
        const next = buttons[index + 1];
        return next === undefined || button.getBoundingClientRect().right <= next.getBoundingClientRect().left;
      }))).toBe(true);
      expect(await sections.evaluateAll((buttons) => buttons.every((button) => getComputedStyle(button).scrollSnapAlign === 'start'))).toBe(true);

      const providers = nav.getByRole('button', { name: 'Providers', exact: true });
      await expect(providers).toHaveAttribute('aria-current', 'page');
      await expect(providers).toHaveCSS('border-radius', '999px');
      await nav.evaluate((node) => node.scrollTo({ left: node.scrollWidth }));
      await expect.poll(() => nav.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
      const data = nav.getByRole('button', { name: 'Data', exact: true });
      await data.click();
      await expect(data).toHaveAttribute('aria-current', 'page');
      await expect(data).toHaveCSS('border-radius', '999px');
      await expect(providers).not.toHaveAttribute('aria-current');
      await expect(settings.getByRole('heading', { name: 'Data', exact: true })).toBeVisible();
      await providers.focus();
      await expect(providers).toBeFocused();
      for (const section of (await sections.all()).slice(1)) {
        await page.keyboard.press('Tab');
        await expect(section).toBeFocused();
      }
      await page.keyboard.press('Shift+Tab');
      const appearance = nav.getByRole('button', { name: 'Appearance', exact: true });
      await expect(appearance).toBeFocused();
      await appearance.press('Enter');
      await expect(appearance).toHaveAttribute('aria-current', 'page');
      await expect(appearance).toHaveCSS('border-radius', '999px');
      await settings.getByRole('radio', { name: 'Dark', exact: true }).check();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      const overflow = await settings.evaluate((node) => node.scrollWidth - node.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      await page.screenshot({ path: testInfo.outputPath('settings-strip.png') });
      await settings.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(settings).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    });
  });
}
