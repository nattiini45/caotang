import { expect, type Page } from '@playwright/test';

export async function openHealthCard(page: Page, locale: 'en' | 'de', shell: 'classic' | 'modern' = 'classic') {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('https://health.example.test/mcp', async (route) => {
    await held;
    await route.abort('failed');
  });
  await page.addInitScript((chosen) => { localStorage.setItem('caotang.interface', chosen); }, shell);
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  if (locale === 'de') {
    await settings.locator('[data-section="appearance"]').click();
    await settings.locator('input[name="interface-language"][value="de"]').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  }
  await settings.locator('[data-section="mcp"]').click();
  await settings.getByTestId('mcp-master').check();
  const form = settings.getByRole('form');
  await form.locator('input[type="text"]').first().fill('Story Bible');
  await form.locator('input[type="url"]').fill('https://health.example.test/mcp');
  await form.locator('button[type="submit"]').click();
  const card = settings.locator('[data-server="Story Bible"]');
  await expect(card).toHaveAttribute('data-state', 'configured');
  const connect = () => card.getByRole('button', { name: locale === 'de' ? 'Verbinden' : 'Connect', exact: true });
  await connect().click();
  await expect(card).toHaveAttribute('data-state', 'connecting');
  return { settings, card, connect, release };
}
