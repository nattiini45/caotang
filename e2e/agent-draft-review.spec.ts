import { expect, test, type Page } from '@playwright/test';

import { DEMO_INTENTS } from '../packages/gateway/src/mock/index.js';

import { binderTitle, createProject, waitForSaved } from './support.js';

/**
 * The draft review (agent-harness §8, "Draft review"): Settings › Providers has "Review drafts before showing them", off by default, with
 * what it costs and where the draft goes. Off, a draft is shown as it always was. On, the ghost lists the critic's notes beside the draft
 * with their category and severity in words, marks the quotes it can find in the draft, and the plan card says what the review added.
 * The review is advice: Apply still writes the draft. Everything runs on the built-in demo provider, whose critic is scripted for its own
 * draft, so no key is configured and nothing leaves the machine.
 */

const QUOTE = 'Elena was not on it.';

async function nameIt(page: Page, title: string): Promise<void> {
  const field = page.getByRole('textbox', { name: 'Rename Untitled' });
  await expect(field).toBeFocused();
  await field.fill(title);
  await page.keyboard.press('Enter');
}

/** A project with one chapter and an empty scene called The Friend, the scene the demo provider drafts into. */
async function projectWithFriend(page: Page): Promise<void> {
  await createProject(page, 'The Lighthouse Keeper');
  await page.getByRole('button', { name: 'New folder' }).click();
  await nameIt(page, 'The Crossing');
  await expect(binderTitle(page, 'The Crossing')).toBeVisible();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await nameIt(page, 'The Friend');
  await waitForSaved(page);
}

async function setReview(page: Page, on: boolean): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Providers', exact: true }).click();
  const toggle = settings.getByRole('checkbox', { name: 'Review drafts before showing them' });
  if (on) await toggle.check();
  else await toggle.uncheck();
  await expect(settings.getByText('Saved. It applies from the agent’s next turn.')).toBeVisible();
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
}

async function draftTheFriend(page: Page): Promise<void> {
  // The panel is closed until the writer opens it, and stays open after that.
  const open = page.getByRole('button', { name: 'Agent', exact: true });
  if (await open.isVisible()) await open.click();
  await page.getByRole('combobox', { name: 'Intent' }).fill(DEMO_INTENTS.draftScene);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('ghost-bar')).toContainText('The Friend');
}

test('Settings › Providers offers Review drafts before showing them, off by default, says what it costs and where the draft goes, and keeps the choice', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Providers', exact: true }).click();

  const toggle = settings.getByRole('checkbox', { name: 'Review drafts before showing them' });
  await expect(toggle).not.toBeChecked();
  const section = settings.getByRole('region', { name: 'Draft review' });
  await expect(section).toContainText('adds up to one more model call to each scene draft');
  await expect(section).toContainText('sent to the Background role’s model');
  await expect(section).toContainText('it never edits');
  await toggle.check();

  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByTestId('settings').getByRole('button', { name: 'Providers', exact: true }).click();
  await expect(page.getByTestId('settings').getByRole('checkbox', { name: 'Review drafts before showing them' })).toBeChecked();
});

test('with the review off a draft is shown with no review, and with it on the ghost lists the critic’s note, marks its quote, and Apply still writes the draft', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await projectWithFriend(page);

  // Off (the default): the ghost bar has no review, and the plan card adds no review call. Discard leaves the scene as it was.
  await draftTheFriend(page);
  await expect(page.getByTestId('ghost-review')).toHaveCount(0);
  await expect(page.getByTestId('plan-step-review')).toHaveCount(0);
  await page.getByTestId('ghost-bar').getByRole('button', { name: 'Discard', exact: true }).click();

  // On: the critic reads the draft after it is written, and the ghost lists what it found.
  await setReview(page, true);
  await draftTheFriend(page);
  const review = page.getByTestId('ghost-review');
  await expect(review).toBeVisible();
  await expect(page.getByTestId('ghost-review-summary')).toHaveText('1 note from the critic; applying it introduces no continuity finding.');
  const note = review.getByTestId('ghost-review-note');
  await expect(note).toHaveCount(1);
  // The category and the severity are words beside the note, and the quote is marked in the draft above and said to be.
  await expect(note).toContainText('Brief · Low severity');
  await expect(note).toContainText('The brief says the friend brings news of Elena');
  await expect(note).toContainText('Suggestion: Let the letter or the friend say what the news is.');
  await expect(note.locator('q')).toHaveText(QUOTE);
  await expect(note).toContainText('(marked in the draft)');
  await expect(page.locator('.caotang-ghost-note')).toHaveText(QUOTE);
  await expect(page.getByTestId('plan-step-review').last()).toContainText('plus up to 1 review call');

  // The review is advice: Apply writes the draft through the same card, and the review goes with the ghost.
  const plan = page.getByTestId('plan-card').last();
  await plan.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByTestId('checkpoint')).toBeVisible();
  await expect(page.getByTestId('ghost-bar')).toHaveCount(0);
  await expect(page.getByTestId('ghost-review')).toHaveCount(0);
  await expect(page.locator('.agent-report').last()).toContainText('Applied:');
});
