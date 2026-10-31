import { expect, test, type Page } from '@playwright/test';

import { fakeEndpoint, planThenAnswer, useFakeEndpoint as addFakeProvider, type FakeReply, type FakeRequest } from './endpoint.js';

/**
 * Slash commands in the agent panel (agent-harness §2, "Slash commands"): the Intent box is a combobox that lists the commands while a
 * `/name` is typed and is operated by keys alone; a command builds the plan the app means without asking the planner; an ambiguous title
 * is answered under the box before any request; no command skips a card. The model is a fake endpoint (endpoint.ts), and it keeps every
 * request it was sent so a test can say what a line did and did not cause.
 */

const DRAFTING = 'You are drafting prose';

/** Answers a drafting call with prose; any planner call is a test failure, so it is answered with a reply that says so. */
const reply = (seen: FakeRequest[]): FakeReply => (request) => {
  seen.push(request);
  if (request.system.startsWith(DRAFTING)) return 'The ferry rowed on.';
  const text = 'The planner was asked.';
  return request.tools !== undefined ? { text } : JSON.stringify({ reply: text });
};

async function openSample(page: Page, seen: FakeRequest[]): Promise<void> {
  await fakeEndpoint(page, reply(seen));
  await addFakeProvider(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  await expect(page.locator('.agent-turn')).toHaveCount(1);
  // The sample's demo run is the built-in provider's, not the fake's.
  seen.length = 0;
}

const intentBox = (page: Page) => page.getByRole('combobox', { name: 'Intent' });
const menu = (page: Page) => page.getByRole('listbox', { name: 'Commands' });
const note = (page: Page) => page.getByTestId('agent-command-note');

test('typing a slash opens the list of commands, which keys alone can narrow, move through, complete and close', async ({ page }) => {
  const seen: FakeRequest[] = [];
  await openSample(page, seen);
  const box = intentBox(page);
  await expect(box).toHaveAttribute('aria-expanded', 'false');

  await box.click();
  await page.keyboard.type('/');
  await expect(box).toHaveAttribute('aria-expanded', 'true');
  await expect(menu(page).getByRole('option')).toHaveText([/\/help/, /\/plan/, /\/draft/, /\/synopses/, /\/scan/, /\/review/, /\/compile/, /\/restore/, /\/context/]);

  // Narrowing: the first match is active, and the box names it as the active descendant.
  await page.keyboard.type('s');
  await expect(menu(page).getByRole('option')).toHaveText([/\/synopses/, /\/scan/]);
  const synopses = menu(page).getByRole('option', { name: /\/synopses/ });
  await expect(synopses).toHaveAttribute('aria-selected', 'true');
  await expect(box).toHaveAttribute('aria-activedescendant', (await synopses.getAttribute('id')) ?? '');

  // Down moves to the next, and wraps.
  await page.keyboard.press('ArrowDown');
  await expect(menu(page).getByRole('option', { name: /\/scan/ })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(synopses).toHaveAttribute('aria-selected', 'true');

  // Escape closes the list and keeps the text; one more key opens it again.
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  await expect(box).toHaveAttribute('aria-expanded', 'false');
  await expect(box).toHaveValue('/s');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('s');
  await expect(menu(page)).toBeVisible();

  // Tab completes the active command with its space, and closes the list.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab');
  await expect(box).toHaveValue('/scan ');
  await expect(menu(page)).toHaveCount(0);
  // Focus is still in the box: Tab completed, it did not leave.
  await expect(box).toBeFocused();

  // Enter on a command that needs an argument completes it instead of sending it.
  await box.fill('/dr');
  await page.keyboard.press('Enter');
  await expect(box).toHaveValue('/draft ');
  expect(seen).toHaveLength(0);
  await expect(page.locator('.agent-turn')).toHaveCount(1);
});

test('the list does not open for a full-width slash, a slash mid-sentence, or an escaped //', async ({ page }) => {
  const seen: FakeRequest[] = [];
  await openSample(page, seen);
  const box = intentBox(page);
  await box.fill('／draft');
  await expect(menu(page)).toHaveCount(0);
  await box.fill('draft /');
  await expect(menu(page)).toHaveCount(0);
  await box.fill('//');
  await expect(menu(page)).toHaveCount(0);
});

test('the list does not open while an input method is composing', async ({ page }) => {
  const seen: FakeRequest[] = [];
  await openSample(page, seen);
  const box = intentBox(page);
  await box.focus();
  await box.evaluate((element) => {
    const input = element as HTMLInputElement;
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '/');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(box).toHaveValue('/');
  await expect(menu(page)).toHaveCount(0);
  await box.evaluate((element) => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  await expect(menu(page)).toBeVisible();
});

test('/draft on the demo project builds the plan itself, shows the draft card, and writes nothing before the card is decided', async ({ page }) => {
  const seen: FakeRequest[] = [];
  await openSample(page, seen);
  await intentBox(page).fill('/draft "The Landing" continue 50 -- Add a line about the tide.');
  await intentBox(page).press('Enter');

  const card = page.getByTestId('plan-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('scene.draft');
  // The turn is named by what it does and by the command that started it, and the planner was never asked: only the draft call went out.
  await expect(page.locator('.agent-intent-text').last()).toHaveText('Continue “The Landing” (about 50 words)');
  await expect(page.getByTestId('turn-command').last()).toHaveText('/draft');
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((request) => request.system.startsWith(DRAFTING))).toBe(true);
  expect(seen.some((request) => request.user.includes('/draft'))).toBe(false);
  expect(seen.some((request) => request.user.includes('Add a line about the tide.'))).toBe(true);
  await expect(page.getByTestId('checkpoint')).toHaveCount(0);
});

test('an ambiguous title is listed under the box, the text stays to be corrected, and no request is sent', async ({ page }) => {
  const seen: FakeRequest[] = [];
  await openSample(page, seen);
  await intentBox(page).fill('/draft The');
  await intentBox(page).press('Enter');
  await expect(note(page)).toBeVisible();
  await expect(note(page)).toContainText('matches');
  await expect(note(page).getByRole('listitem')).toContainText(['The Landing', 'The Storm']);
  await expect(intentBox(page)).toHaveValue('/draft The');
  expect(seen).toHaveLength(0);
  await expect(page.locator('.agent-turn')).toHaveCount(1);
  await note(page).getByRole('button', { name: 'Dismiss' }).click();
  await expect(note(page)).toHaveCount(0);
});

test('/context shows the layers of the next request and what was left out, and sends nothing', async ({ page }) => {
  const seen: FakeRequest[] = [];
  await openSample(page, seen);
  await intentBox(page).fill('/context');
  await intentBox(page).press('Enter');
  await expect(note(page)).toContainText('The next request would send about');
  await expect(note(page)).toContainText('L0 System:');
  await expect(note(page)).toContainText('No request was sent to work this out.');
  await expect(intentBox(page)).toHaveValue('');
  expect(seen).toHaveLength(0);
});

test('/help lists the commands, and /restore says when there is nothing to restore', async ({ page }) => {
  const seen: FakeRequest[] = [];
  await openSample(page, seen);
  await intentBox(page).fill('/help');
  await intentBox(page).press('Enter');
  for (const name of ['help', 'plan', 'draft', 'synopses', 'scan', 'review', 'compile', 'restore', 'context']) {
    await expect(note(page)).toContainText(`/${name}`);
  }
  await intentBox(page).fill('/restore');
  await intentBox(page).press('Enter');
  await expect(note(page)).toContainText('No finished turn has a checkpoint to restore');
  expect(seen).toHaveLength(0);
});

test('/compile stops at its confirm card: a command is not an approval', async ({ page }) => {
  const seen: FakeRequest[] = [];
  await openSample(page, seen);
  await intentBox(page).fill('/compile md');
  await intentBox(page).press('Enter');
  const card = page.getByTestId('plan-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('export.compile');
  await expect(page.getByTestId('checkpoint')).toHaveCount(0);
  await card.getByRole('button', { name: /^Cancel/ }).click();
  await expect(page.getByTestId('turn-command').last()).toHaveText('/compile');
  expect(seen).toHaveLength(0);
});

test('a line that names no command is sent as a request, with a note', async ({ page }) => {
  const seen: FakeRequest[] = [];
  await openSample(page, seen);
  await intentBox(page).fill('/foo bar');
  await intentBox(page).press('Enter');
  await expect(note(page)).toContainText('No command /foo; sent as a request');
  await expect(page.locator('.agent-intent-text').last()).toHaveText('/foo bar');
  await expect.poll(() => seen.length).toBeGreaterThan(0);
});

test('/scan runs the coherence scan with no card and no model request', async ({ page }) => {
  const seen: FakeRequest[] = [];
  await openSample(page, seen);
  await intentBox(page).fill('/scan');
  await intentBox(page).press('Enter');
  await expect(page.getByTestId('turn-command').last()).toHaveText('/scan');
  await expect(page.locator('.agent-turn').last().locator('.agent-report-text')).toBeVisible();
  await expect(page.getByTestId('plan-card')).toHaveCount(0);
  expect(seen).toHaveLength(0);
});

test('/restore last asks the checkpoint row’s own confirmation for the newest turn that wrote, and restores nothing until it is confirmed', async ({ page }) => {
  const seen: FakeRequest[] = [];
  const plan = planThenAnswer({ steps: [{ tool: 'notes.append', params: { doc: 'The Landing', text: 'Check the tide.' }, expect: 'the note is added' }] });
  await fakeEndpoint(page, (request) => (seen.push(request), plan(request)));
  await addFakeProvider(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  await expect(page.locator('.agent-turn')).toHaveCount(1);
  // A single note runs at once in Ask, so the turn leaves a checkpoint with no card.
  await intentBox(page).fill('Add a note to The Landing.');
  await intentBox(page).press('Enter');
  await expect(page.getByTestId('checkpoint')).toBeVisible();
  seen.length = 0;

  await intentBox(page).fill('/restore last');
  await intentBox(page).press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Restore to before this turn?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('This restores the project to its state before this turn');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('checkpoint')).not.toContainText('Taken back');

  await intentBox(page).fill('/restore last');
  await intentBox(page).press('Enter');
  await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByTestId('checkpoint')).toContainText('Taken back');
  expect(seen).toHaveLength(0);
});
