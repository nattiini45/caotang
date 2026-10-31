import { expect, test, type Page } from '@playwright/test';

import { fakeEndpoint, planThenAnswer, useFakeEndpoint, type FakeReply } from './endpoint.js';
import { composeAndConfirm } from './support.js';

/**
 * Stop, steer and the queue in the agent panel (agent-harness §8, "Stop and steer"). The model is a fake endpoint (endpoint.ts), and
 * a turn is held in flight by a route the test opens when it wants the turn to go on, so the panel is driven while a turn runs.
 */

/** The text after "Request: " in the request's user messages, up to the line's end. */
function requestOf(user: string): string {
  const at = user.indexOf('Request: ');
  if (at === -1) return '';
  const rest = user.slice(at + 'Request: '.length);
  const end = rest.indexOf('\n');
  return end === -1 ? rest : rest.slice(0, end);
}

/** Answers every planner request with "Answered: <the request>", so each turn's text names the message it ran. */
const echo: FakeReply = (request) => {
  if (request.system.startsWith('You are drafting prose')) return 'A drafted synopsis.';
  const text = `Answered: ${requestOf(request.user)}`;
  return request.tools !== undefined ? { text } : JSON.stringify({ reply: text });
};

/**
 * Holds every request that carries `marker` until the returned function is called, then lets it through to the fake endpoint.
 * Registered after the fake, so it runs first; `fallback` hands the request on.
 */
async function hold(page: Page, marker: string): Promise<() => void> {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('https://127.0.0.1:5999/**', async (route) => {
    const body = route.request().postData() ?? '';
    if (route.request().method() === 'POST' && body.includes(marker)) await released;
    try {
      await route.fallback();
    } catch {
      // The app stopped the request while it was held: there is nothing left to hand on.
    }
  });
  return release;
}

async function openSample(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  await expect(page.locator('.agent-turn')).toHaveCount(1);
}

const intentBox = (page: Page) => page.getByRole('combobox', { name: 'Intent' });
const turns = (page: Page) => page.locator('.agent-turn');

async function typeAndPress(page: Page, text: string, key: string): Promise<void> {
  await intentBox(page).fill(text);
  await intentBox(page).press(key);
}

test('messages typed while a turn runs are queued and run in order, and a note the turn did not read becomes the next message', async ({ page }) => {
  await fakeEndpoint(page, echo);
  const release = await hold(page, 'Request: First held question');
  await useFakeEndpoint(page);
  await openSample(page);

  await typeAndPress(page, 'First held question', 'Enter');
  await expect(page.getByTestId('agent-stop')).toBeVisible();
  // The Intent box stays open while the turn runs.
  await expect(intentBox(page)).toBeEnabled();

  await typeAndPress(page, 'Second question', 'Enter');
  await typeAndPress(page, 'Third question', 'Enter');
  const queue = page.getByTestId('agent-queue');
  await expect(queue.locator('.agent-chip')).toHaveText([/Second question/, /Third question/]);
  // Queued is not started: the held turn is the only one of the three that exists.
  await expect(turns(page)).toHaveCount(2);

  // Ctrl+Enter sends the text to the running turn as a note, which waits for the turn's next step.
  await typeAndPress(page, 'A word for the running turn', 'Control+Enter');
  await expect(page.getByRole('list', { name: 'Notes sent to the agent' })).toContainText('A word for the running turn');

  release();
  await expect(turns(page)).toHaveCount(5);
  // The first turn ended without reading the note, so the note is the first queued message, then each queued message in turn.
  await expect(turns(page).locator('.agent-intent-text')).toHaveText([
    /Check the manuscript for continuity problems/,
    /First held question/,
    /A word for the running turn/,
    /Second question/,
    /Third question/,
  ]);
  await expect(turns(page).last().locator('.agent-report-text')).toHaveText('Answered: Third question');
  await expect(queue).toHaveCount(0);
});

test('a queued message can be edited, moved by the arrow buttons and by dragging, and removed', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  await fakeEndpoint(page, echo);
  const release = await hold(page, 'Request: Keep me busy');
  await useFakeEndpoint(page);
  await openSample(page);

  await typeAndPress(page, 'Keep me busy', 'Enter');
  await expect(page.getByTestId('agent-stop')).toBeVisible();
  for (const text of ['Alpha', 'Beta', 'Gamma', 'Delta']) await typeAndPress(page, text, 'Enter');
  const chips = page.getByTestId('agent-queue').locator('.agent-chip');
  await expect(chips).toHaveCount(4);

  await page.getByRole('button', { name: 'Edit queued message 1' }).click();
  const editor = page.getByRole('textbox', { name: 'Edit queued message 1' });
  await editor.fill('Alpha, edited');
  await editor.press('Enter');
  await page.getByRole('button', { name: 'Move queued message 2 up' }).click();
  await expect(chips).toHaveText([/Beta/, /Alpha, edited/, /Gamma/, /Delta/]);
  await page.getByRole('button', { name: 'Remove queued message 3' }).click();
  await expect(chips).toHaveText([/Beta/, /Alpha, edited/, /Delta/]);

  // Dragging the last chip onto the first puts it first.
  await chips.nth(2).dragTo(chips.nth(0));
  await expect(chips).toHaveText([/Delta/, /Beta/, /Alpha, edited/]);

  release();
  await expect(turns(page)).toHaveCount(5);
  await expect(turns(page).locator('.agent-intent-text')).toHaveText([
    /Check the manuscript/,
    /Keep me busy/,
    /Delta/,
    /Beta/,
    /Alpha, edited/,
  ]);
});

test('the Enter that confirms an input-method candidate neither sends from the Intent box nor commits a queued message’s edit (#188)', async ({
  page,
}) => {
  await fakeEndpoint(page, echo);
  const release = await hold(page, 'Request: Keep me busy');
  await useFakeEndpoint(page);
  await openSample(page);

  // The Intent box is in a form: the composing Enter is cancelled, so the form is not submitted, and the line stays in the box.
  expect(await composeAndConfirm(intentBox(page), '保持忙碌')).toBe(true);
  expect(await composeAndConfirm(intentBox(page), '保持忙碌', 'keyCode')).toBe(true);
  await expect(intentBox(page)).toHaveValue('保持忙碌');
  await expect(turns(page)).toHaveCount(1);

  await typeAndPress(page, 'Keep me busy', 'Enter');
  await expect(page.getByTestId('agent-stop')).toBeVisible();
  await typeAndPress(page, 'Alpha', 'Enter');
  const chips = page.getByTestId('agent-queue').locator('.agent-chip');
  await expect(chips).toHaveText([/Alpha/]);

  // A queued message's edit stays open on the composing Enter, and the next Enter commits it.
  await page.getByRole('button', { name: 'Edit queued message 1' }).click();
  const editor = page.getByRole('textbox', { name: 'Edit queued message 1' });
  expect(await composeAndConfirm(editor, '阿尔法')).toBe(false);
  expect(await composeAndConfirm(editor, '阿尔法', 'keyCode')).toBe(false);
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue('阿尔法');
  await editor.press('Enter');
  await expect(editor).toHaveCount(0);
  await expect(chips).toHaveText([/阿尔法/]);

  release();
  await expect(turns(page)).toHaveCount(3);
  await expect(turns(page).last().locator('.agent-intent-text')).toHaveText(/阿尔法/);
});

test('Stop ends a running turn as "Stopped by you.", and the queued message behind it still runs', async ({ page }) => {
  await fakeEndpoint(page, echo);
  await hold(page, 'Request: Stop this one');
  await useFakeEndpoint(page);
  await openSample(page);

  await typeAndPress(page, 'Stop this one', 'Enter');
  await typeAndPress(page, 'Then this', 'Enter');
  await page.getByTestId('agent-stop').click();

  const stopped = turns(page).nth(1);
  await expect(stopped.locator('.agent-report-text')).toContainText('Stopped by you.');
  await expect(stopped.locator('.agent-phase')).toHaveText('Stopped by you');
  await expect(turns(page).nth(2).locator('.agent-report-text')).toHaveText('Answered: Then this');
  await expect(page.getByTestId('agent-stop')).toHaveCount(0);
});

test('Escape stops the turn only when the Intent box is empty', async ({ page }) => {
  await fakeEndpoint(page, echo);
  const release = await hold(page, 'Request: Escape test');
  await useFakeEndpoint(page);
  await openSample(page);

  await typeAndPress(page, 'Escape test', 'Enter');
  await expect(page.getByTestId('agent-stop')).toBeVisible();

  // With text in the box, Escape leaves the turn alone, and the text stays.
  await intentBox(page).fill('half a thought');
  await intentBox(page).press('Escape');
  await expect(page.getByTestId('agent-stop')).toBeVisible();
  await expect(intentBox(page)).toHaveValue('half a thought');

  await intentBox(page).fill('');
  await intentBox(page).press('Escape');
  await expect(turns(page).last().locator('.agent-report-text')).toContainText('Stopped by you.');
  await expect(page.getByTestId('agent-announcement')).toContainText('Stopped by you.');
  release();
});

test('a note typed while a card waits offers Send with Cancel and Queue as next turn, and neither approves or drops the card', async ({ page }) => {
  const plan = {
    steps: [
      { tool: 'notes.append', params: { doc: 'The Landing', text: 'First note.' }, expect: 'A note is added to The Landing' },
      { tool: 'synopsis.fill', params: { docs: ['The Storm'], source: 'text', max_words: 30 }, expect: 'The Storm has a synopsis' },
    ],
  };
  const planning = planThenAnswer(plan, 'Understood.', 'A storm takes the lamp.');
  await fakeEndpoint(page, (request) => (requestOf(request.user).startsWith('Add a note') ? planning(request) : echo(request)));
  await useFakeEndpoint(page);
  await openSample(page);

  await typeAndPress(page, 'Add a note and a synopsis.', 'Enter');
  const card = page.getByTestId('plan-card');
  await expect(card.getByRole('heading', { name: 'Plan, 2 steps' })).toBeVisible();

  await typeAndPress(page, 'Skip the synopsis', 'Control+Enter');
  const held = page.getByRole('group', { name: 'A note while a card waits' });
  await expect(held).toBeVisible();
  // The card is still there, and still undecided.
  await expect(card.getByRole('button', { name: 'Approve plan', exact: true })).toBeEnabled();

  await held.getByRole('button', { name: 'Queue as next turn' }).click();
  await expect(held).toHaveCount(0);
  await expect(card).toBeVisible();
  await expect(page.getByTestId('agent-queue').locator('.agent-chip')).toHaveText([/Skip the synopsis/]);

  // The writer cancels the card; the queued message is the next turn.
  await card.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(turns(page).last().locator('.agent-report-text')).toHaveText('Answered: Skip the synopsis');

  // A second note, sent with the Cancel, goes back to the model within the same turn.
  await typeAndPress(page, 'Add a note and a synopsis, again.', 'Enter');
  await expect(card.getByRole('heading', { name: 'Plan, 2 steps' })).toBeVisible();
  // The card is the writer's to decide once its Approve is live; the turn logs its card before it waits on the writer (agent-harness §5.1).
  await expect(card.last().getByRole('button', { name: 'Approve plan', exact: true })).toBeEnabled();
  await typeAndPress(page, 'Never mind the synopsis', 'Control+Enter');
  await page.getByRole('group', { name: 'A note while a card waits' }).getByRole('button', { name: 'Send with Cancel' }).click();
  const sent = turns(page).last();
  await expect(sent.getByRole('list', { name: 'Notes you sent during this turn' })).toContainText('Never mind the synopsis');
  await expect(sent.locator('.agent-report')).toBeVisible();
});
