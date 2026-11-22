import { expect } from '@playwright/test';
import { test } from '../../../e2e/test.js';

test('Classic proves the Modern chunk stays unloaded', async ({ browserName: _browserName }, info) => {
  expect(info.timeout).toBe(30_000);
});

for (const shell of ['classic', 'modern']) {
  test(`${shell} default budget`, { tag: shell === 'modern' ? '@modern' : [] }, async ({ browserName }, info) => {
    expect(info.timeout).toBe(browserName === 'webkit' && shell === 'modern' ? 60_000 : 30_000);
  });
}

test('Modern retains a larger callback budget', { tag: '@modern' }, async ({ browserName: _browserName }, info) => {
  test.setTimeout(90_000);
  expect(info.timeout).toBe(90_000);
});

test('an existing slow case keeps its original budget', async ({ browserName: _browserName }, info) => {
  test.slow();
  expect(info.timeout).toBe(90_000);
});

test.describe('an explicit describe budget', () => {
  test.describe.configure({ timeout: 120_000 });
  test('Modern retains its larger describe budget', { tag: '@modern' }, async ({ browserName: _browserName }, info) => {
    expect(info.timeout).toBe(120_000);
  });
});
