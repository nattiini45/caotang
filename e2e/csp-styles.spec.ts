import { expect, test } from '@playwright/test';

declare global {
  interface Window {
    __stylePolicyViolations?: string[];
  }
}

test('development and lazy SDK styles use Vite’s one admitted nonce without CSP violations', async ({ page }) => {
  await page.addInitScript(() => {
    window.__stylePolicyViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__stylePolicyViolations?.push(`${event.effectiveDirective}: ${event.blockedURI}`);
    });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Projects in this browser' })).toBeVisible();
  await expect(page.locator('meta[property="csp-nonce"]')).toHaveCount(1);

  await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
  const panel = page.getByTestId('agent-panel');
  await expect(panel.locator('.agent-turn').last()).toHaveClass(/is-done/);
  await panel.getByRole('button', { name: 'Conversation memory', exact: true }).click();
  await expect(panel.getByRole('radiogroup', { name: 'Conversation role' })).toBeVisible();

  const styles = await page.evaluate(() => {
    const nonce = document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')?.nonce ?? '';
    const tags = [...document.querySelectorAll<HTMLStyleElement>('style[data-vite-dev-id]')];
    return { nonce, count: tags.length, admitted: tags.every((tag) => tag.nonce === nonce && tag.sheet !== null), violations: window.__stylePolicyViolations ?? [] };
  });
  expect(styles.nonce).not.toBe('');
  expect(styles.count).toBeGreaterThan(0);
  expect(styles.admitted).toBe(true);
  expect(styles.violations).toEqual([]);
});
