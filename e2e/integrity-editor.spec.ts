import { expect, test } from '@playwright/test';

import { DEMO_INTENTS } from '../packages/gateway/src/mock/index.js';

import { bodyOf, createProject, idOf, waitForSaved } from './support.js';

/**
 * The editor's own-write test (editor-engine §9): a store change is this session's own write only when the body and the revision
 * both match. After an undo, an agent's draft is a change this session did not make, at a revision past the writer's typing and its
 * undo. The editor must show the draft, and the writer's next keystroke must add to it rather than replace it.
 */

/** The opening of the prose the demo provider drafts into "The Friend" (the same words demo.spec checks). */
const DRAFT_OPENING = 'The ferry came in on the evening tide, low in the water and slow to answer the rope.';

test('an agent draft that lands after an undo shows in the editor, and the next keystroke does not replace it', async ({ page }) => {
  await createProject(page, 'Own Write');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('The Friend');
  await page.keyboard.press('Enter');

  // The writer types, and the text is saved. Undo writes the empty scene back as a write of its own, so the scene is empty again at a
  // revision past the typing.
  await page.getByRole('textbox', { name: 'Document text' }).fill('typed by the writer');
  await waitForSaved(page);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Document text' })).not.toContainText('typed by the writer');

  // The agent drafts into the scene, and the writer approves the draft once it is on screen.
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await page.getByRole('combobox', { name: 'Intent' }).fill(DEMO_INTENTS.draftScene);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const plan = page.getByTestId('plan-card');
  await expect(plan.getByRole('heading', { name: 'One step to confirm' })).toBeVisible();
  const approve = plan.getByRole('button', { name: 'Approve', exact: true });
  await expect(approve).toBeEnabled();
  await approve.click();

  // The store holds the draft, and the editor shows it.
  const friend = await idOf(page, 'The Friend');
  await expect.poll(async () => (await bodyOf(page, friend)) ?? '').toContain(DRAFT_OPENING);
  await expect(page.getByRole('textbox', { name: 'Document text' })).toContainText(DRAFT_OPENING);

  // The writer's next keystroke is added to the draft, not written over it.
  await page.getByRole('textbox', { name: 'Document text' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Then the lamp.');
  await waitForSaved(page);
  const after = (await bodyOf(page, friend)) ?? '';
  expect(after).toContain(DRAFT_OPENING);
  expect(after).toContain('Then the lamp.');
});
