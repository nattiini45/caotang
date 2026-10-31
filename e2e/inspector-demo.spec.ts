import { expect, test } from '@playwright/test';

import { DEMO_CHOICES } from '../apps/desktop/src/app/demo.js';

import { fakeEndpoint, planThenAnswer, useFakeEndpoint } from './endpoint.js';
import { binderTitle, createProject, projectTrace, waitForSaved } from './support.js';

/**
 * The inspector (ui-modules §4.3, §4.1). With nothing selected it offers the three demo intents, and each starts an agent turn with
 * its intent. A document's notes that carry an agent divider open as a read view, with the divider drawn as a separator, and the
 * textarea is one button away.
 */

/** A note for The Landing, the one step of a plan, written as the agent writes it. */
const NOTE_PLAN = {
  steps: [{ tool: 'notes.append', params: { doc: 'The Landing', text: 'Check the ferry timetable.' }, expect: 'A note is added to The Landing' }],
};

test('with nothing selected, each demo intent in the inspector starts an agent turn with that intent', async ({ page }) => {
  test.setTimeout(90_000);
  for (const [index, choice] of DEMO_CHOICES.entries()) {
    // Each run opens a project of its own. A new project has an empty inspector again, and its agent has no turn running: the agent
    // refuses a request while another turn runs, so runs in one project would test the refusal, not the demo intents.
    await createProject(page, `Inspector Demo ${index + 1}`);
    const panel = page.getByRole('complementary', { name: 'Inspector' });
    await expect(panel.getByRole('heading', { name: 'Select a document' })).toBeVisible();

    for (const demo of DEMO_CHOICES) {
      await expect(panel.getByRole('button', { name: demo.label, exact: true })).toBeVisible();
    }

    await panel.getByRole('button', { name: choice.label, exact: true }).click();
    await expect(page.getByTestId('agent-panel')).toHaveClass(/is-open/);
    await expect(page.locator('.agent-intent-text', { hasText: choice.intent })).toBeVisible();
  }
});

test('notes with an agent divider open as a read view, where the divider is a separator, and Edit notes returns the textarea', async ({
  page,
}) => {
  await fakeEndpoint(page, planThenAnswer(NOTE_PLAN, 'The note is in.'));
  await useFakeEndpoint(page);
  await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();

  await page.getByRole('combobox', { name: 'Intent' }).fill('Add a note to The Landing.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  // A note is written by an auto-approved step, so the turn applies without a plan card, and it carries a checkpoint.
  await expect(page.getByTestId('checkpoint')).toBeVisible();
  expect(await projectTrace(page)).toContain('notes.append');

  await binderTitle(page, 'The Landing').click();
  const notes = page.getByTestId('notes-read');
  await expect(notes).toBeVisible();
  await expect(notes.getByRole('separator', { name: /^Agent note, / })).toBeVisible();
  await expect(notes).toContainText('Check the ferry timetable.');
  await expect(notes).not.toContainText('— agent');

  await notes.getByRole('button', { name: 'Edit notes', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Notes', exact: true })).toHaveValue(/Check the ferry timetable\./);
});

test('the demo draft in a project with no scene called The Friend says no draft was made, and the scene keeps its text', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await createProject(page, 'No Friend Here');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('The Landing');
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Document text' }).fill('The ferry was late.');
  await waitForSaved(page);

  // A reload leaves nothing selected, so the inspector offers the demo intents again.
  await page.reload();
  await page.getByRole('listitem').filter({ hasText: 'No Friend Here' }).getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  await page.getByRole('complementary', { name: 'Inspector' }).getByRole('button', { name: 'Draft the opening scene', exact: true }).click();

  // The turn's report says what happened: the draft was refused before any card, and nothing was drafted.
  await expect(page.locator('.agent-report-text')).toContainText('No draft was made, so nothing changed.');
  await expect(page.getByText('Drafted the opening scene')).toHaveCount(0);
  await expect(page.getByTestId('checkpoint')).toHaveCount(0);

  await binderTitle(page, 'The Landing').click();
  await expect(page.getByRole('textbox', { name: 'Document text' })).toHaveText('The ferry was late.');
});

test('the demo synopses in a project with no scenes called The Landing or The Storm say none were written, and claim no fill', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await createProject(page, 'No Landing Here');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('Other scene');
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Document text' }).fill('The quay was empty.');
  await waitForSaved(page);

  // A reload leaves nothing selected, so the inspector offers the demo intents again.
  await page.reload();
  await page.getByRole('listitem').filter({ hasText: 'No Landing Here' }).getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  await page.getByRole('complementary', { name: 'Inspector' }).getByRole('button', { name: 'Fill in the synopses', exact: true }).click();

  await expect(page.locator('.agent-report-text')).toContainText('No synopses were written, so nothing changed.');
  await expect(page.getByText('Filled the synopses')).toHaveCount(0);
  await expect(page.getByTestId('checkpoint')).toHaveCount(0);
});
