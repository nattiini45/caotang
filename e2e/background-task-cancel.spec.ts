import { expect, test } from '@playwright/test';

import { projectTrace } from './support.js';
import { holdCancellingTask, releaseTaskStartup } from './task-cancellation.js';

test('cancel during the startup save is visible until it settles and cannot offer Resume', async ({ page }) => {
  const task = await holdCancellingTask(page);
  await page.screenshot({ path: 'test-results/background-task-cancelling.png' });
  await releaseTaskStartup(page);
  await expect(task).toHaveAttribute('data-state', 'cancelled');
  await expect(task.getByRole('button', { name: /^Resume/ })).toHaveCount(0);
  expect(await projectTrace(page)).not.toContain('doc.replace');
});
