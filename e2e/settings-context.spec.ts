import { expect, test } from '@playwright/test';

import { createProject } from './support.js';

/**
 * Settings › Context (ui-modules §5.2, context-assembly §5): the section's link shows the prompt a scene draft would send, under the
 * budgets the writer typed. The link needs the project in view, so it is there inside a project and not on the projects screen.
 */

test('inside a project, the Context section offers the prompt for a scene, and the link opens and closes it', async ({ page }) => {
  await createProject(page, 'Context Book');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Context', exact: true }).click();

  const show = settings.getByRole('button', { name: 'See the prompt for a scene', exact: true });
  await expect(show).toBeVisible();
  await show.click();
  await expect(settings.getByRole('button', { name: 'Hide the prompt for a scene', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await settings.getByRole('button', { name: 'Hide the prompt for a scene', exact: true }).click();
  await expect(show).toHaveAttribute('aria-expanded', 'false');
});

test('on the projects screen there is no project to preview, so the Context section has no prompt link', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Context', exact: true }).click();
  await expect(settings.getByRole('button', { name: 'See the prompt for a scene', exact: true })).toHaveCount(0);
});

test('the Context section lists every layer budget with its default, and the reply the Chat role keeps room for (issue #69)', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Context', exact: true }).click();

  const fields: readonly (readonly [string, string])[] = [
    ['Instructions (CAOTANG.md and memory)', '1,500 by default'],
    ['Project summary', '1,500 by default'],
    ['Codex entries', '1,000 by default'],
    ['Structure around the focus document', '1,200 by default'],
    ['Story so far, from the synopses', '2,000 by default'],
    ['Focus document text', '2,000 by default'],
    ['Recent turns of the conversation', '1,500 by default'],
  ];
  const form = settings.getByRole('form', { name: 'Context budgets' });
  for (const [label, placeholder] of fields) await expect(form.getByLabel(label, { exact: true })).toHaveAttribute('placeholder', placeholder);
  // The demo profile sets no reply cap of its own, so the reserve is Caotang's default, and the line says so.
  await expect(settings.getByTestId('context-reserve')).toContainText('Kept for the reply: 4,096 tokens, Caotang’s default reply cap');
});
