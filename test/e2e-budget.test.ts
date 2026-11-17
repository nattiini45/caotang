import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { modernWebkitBudget } from '../e2e/test-budget.js';

describe('the Modern WebKit per-test budget', () => {
  it('changes only explicitly tagged default-budget WebKit cases', () => {
    for (const browser of ['chromium', 'firefox', 'webkit']) {
      for (const tags of [[], ['@classic'], ['@modern'], ['@modern-extra']]) {
        for (const timeout of [0, 10_000, 30_000, 60_000, 90_000, 120_000]) {
          expect(modernWebkitBudget(browser, tags, timeout)).toBe(
            browser === 'webkit' && tags.includes('@modern') && timeout === 30_000 ? 60_000 : timeout,
          );
        }
      }
    }
  });

  it('preserves real Playwright Classic, other-engine and larger callback/describe controls', () => {
    const root = resolve(__dirname, '..');
    const output = execFileSync(process.execPath, [
      resolve(root, 'node_modules/@playwright/test/cli.js'), 'test',
      '--config=test/fixtures/e2e-budget/playwright.config.ts',
    ], { cwd: root, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } });
    const report = JSON.parse(output) as { stats: { expected: number; unexpected: number; skipped: number } };
    expect(report.stats).toMatchObject({ expected: 18, unexpected: 0, skipped: 0 });
  }, 30_000);
});
