import { expect, test, type Page } from '@playwright/test';

import { fakeEndpoint, useFakeEndpoint, type FakeAnswer, type FakeReply } from './endpoint.js';
import { projectTrace } from './support.js';

/**
 * A delegated agent in the agent panel (agent-harness §2, §8): the planner hands a reading to the reader, whose call is a status card
 * with its agent, its reserved calls, a word for how it stands, an elapsed time, and its brief, notes and transcript to open; and an
 * agent that wants a change proposes it, which reaches the writer only as a badged step of the planner's own plan card. The endpoint
 * is the fake of endpoint.ts, so both the planner and the agent are scripted; the cards and the approval are the app's own.
 */

const SUBAGENT_PREFIX = 'You are a delegated agent for Caotang.';
const NOTES = 'Only the keeper knows the lamp failed. The ferry crew do not.';
const BRIEF = 'Note who knows the lamp failed, with the scene each note comes from.';
const HERON = { action: 'create', name: 'Heron', type: 'other', description: 'The grey bird that stands on the breakwater at dusk.' };

/** The sample project, opened by the first-run card's read-only demo. */
async function openSample(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
}

async function sendIntent(page: Page, intent: string): Promise<void> {
  const field = page.getByRole('textbox', { name: 'Intent' });
  await expect(field).toBeEnabled();
  await field.fill(intent);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

const call = (id: string, name: string, args: unknown) => ({ id, name, arguments: JSON.stringify(args) });

/**
 * The planner finds the delegate tool by a search, delegates, and (when it has a plan) puts the agent's proposal in its own plan; the
 * agent reads The Landing, proposes `proposal` if it has one, and reports `notes`. Every request is answered from how far its own
 * conversation has gone, so the scripts hold on the native wire the generic preset speaks.
 */
function scripted(agent: 'reader' | 'general', proposal?: unknown): FakeReply {
  return (request): FakeAnswer | string => {
    if (request.system.startsWith(SUBAGENT_PREFIX)) {
      if (request.assistantTurns > 0) return { text: NOTES };
      return {
        text: '',
        toolCalls: [call('child_1', 'doc.read', { doc: 'The Landing' }), ...(proposal === undefined ? [] : [call('child_2', 'codex.write', proposal)])],
      };
    }
    if (request.assistantTurns === 0) return { text: 'Find the delegate tool.', toolCalls: [call('plan_1', 'tool.search', { query: 'delegate reading to a helper agent' })] };
    if (request.assistantTurns === 1) {
      return { text: 'Hand the reading over.', toolCalls: [call('plan_2', 'agent.delegate', { agent, brief: BRIEF, scope: ['The Landing', 'The Storm'] })] };
    }
    if (request.assistantTurns === 2 && proposal !== undefined) return { text: 'Add the entry the agent proposed.', toolCalls: [call('plan_3', 'codex.write', proposal)] };
    return { text: 'Only the keeper knows.' };
  };
}

test('a delegated reading is a status card with its agent, reserved calls, elapsed time, brief, notes and transcript, and writes nothing', async ({ page }) => {
  await fakeEndpoint(page, scripted('reader'));
  await useFakeEndpoint(page);
  await openSample(page);
  await sendIntent(page, 'Who knows the lamp failed?');

  // The search and the delegation are consecutive calls, so a finished turn folds them into one group, which opens from its summary.
  await page.getByText('2 calls · done', { exact: true }).click();
  const card = page.locator('article.status-card[data-tool="agent.delegate"]');
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-status', 'done');
  const agent = card.getByRole('region', { name: 'Reader agent' });
  // The state is in words, not colour alone: the call says Done, and the agent says it finished.
  await expect(card.locator('.status-pill')).toHaveText('Done');
  await expect(agent).toContainText('3 model calls reserved');
  await expect(agent).toContainText('Finished');
  await expect(card.locator('.status-card-elapsed')).toBeVisible();

  // The brief, the notes and the transcript are closed disclosures, each opened from the keyboard.
  const brief = agent.getByText('Brief', { exact: true });
  await expect(agent.getByText(BRIEF)).toBeHidden();
  await brief.focus();
  await page.keyboard.press('Enter');
  await expect(agent.getByText(BRIEF)).toBeVisible();
  await expect(agent).toContainText('Starts from: The Landing, The Storm');

  const notes = agent.getByText('Notes', { exact: true });
  await expect(agent.getByText(NOTES)).toBeHidden();
  await notes.focus();
  await page.keyboard.press('Enter');
  await expect(agent.getByText(NOTES)).toBeVisible();

  const transcript = agent.getByText('Transcript (1)', { exact: true });
  await transcript.focus();
  await page.keyboard.press('Enter');
  await expect(agent.getByRole('listitem')).toHaveText(['Read “The Landing” — done']);

  await expect(page.locator('.agent-turn').last()).toContainText('Only the keeper knows.');
  // A reading changes nothing: no checkpoint, no command.
  await expect(page.getByTestId('checkpoint')).toHaveCount(0);
  expect((await projectTrace(page)).filter((name) => name === 'codex.upsert')).toEqual([]);
});

test('a change the agent proposes is a badged step of the planner’s own plan, and nothing is written until it is approved', async ({ page }) => {
  await fakeEndpoint(page, scripted('general', { entries: [HERON] }));
  await useFakeEndpoint(page);
  await openSample(page);
  await sendIntent(page, 'Who knows the lamp failed, and what should the codex say about the bird?');

  // The delegate's card says it proposed a step and that none has run.
  const delegate = page.locator('article.status-card[data-tool="agent.delegate"]');
  await expect(delegate.getByRole('region', { name: 'General agent' })).toContainText('1 step proposed. None has run');

  const card = page.getByTestId('plan-card');
  const step = card.locator('.plan-step[data-tool="codex.write"]');
  await expect(step).toContainText('Proposed by the general agent');
  await expect(card.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
  expect((await projectTrace(page)).filter((name) => name === 'codex.upsert')).toEqual([]);

  await card.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByTestId('checkpoint')).toBeVisible();
  expect((await projectTrace(page)).filter((name) => name === 'codex.upsert')).toEqual(['codex.upsert']);
});
