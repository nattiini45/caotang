import { test as base } from '@playwright/test';
import { modernWebkitBudget } from './test-budget.js';

export const test = base.extend<{ modernBudget: void }>({
  modernBudget: [async ({ browserName }, use, testInfo) => {
    const timeout = modernWebkitBudget(browserName, testInfo.tags, testInfo.timeout);
    if (timeout !== testInfo.timeout) testInfo.setTimeout(timeout);
    await use();
  }, { auto: true }],
});
