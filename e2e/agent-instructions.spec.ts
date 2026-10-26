import { expect, test, type Page } from '@playwright/test';

import { DEMO_INSTRUCTIONS, DEMO_INTENTS } from '../packages/gateway/src/mock/index.js';
import { fakeEndpoint, planThenAnswer, useFakeEndpoint, type FakeRequest } from './endpoint.js';
import { createProject, waitForSaved } from './support.js';

/**
 * Agent instructions (context-assembly.md §2, layer LI): the writer's CAOTANG.md and the notes the agent keeps. The panel edits the file and
 * the notes, shows their size against the layer's cap, and says what the cap cut; Initialise asks the agent for a first draft behind one
 * confirm card. The model is the built-in demo provider or a fake endpoint (endpoint.ts), so nothing reaches a real provider.
 */

const RULE = 'No semicolons in dialogue.';

async function openInstructions(page: Page) {
  await page.getByRole('button', { name: 'Instructions', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Agent instructions' });
  await expect(panel).toBeVisible();
  return panel;
}

async function sendIntent(page: Page, intent: string): Promise<void> {
  const field = page.getByRole('textbox', { name: 'Intent' });
  if (!(await field.isVisible())) await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await expect(field).toBeEnabled();
  await field.fill(intent);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

async function reopenProject(page: Page, name: string): Promise<void> {
  await page.reload();
  const row = page.getByRole('listitem').filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
}

function recordingEndpoint(): { seen: FakeRequest[]; reply: ReturnType<typeof planThenAnswer> } {
  const seen: FakeRequest[] = [];
  const answer = planThenAnswer({ steps: [{ tool: 'project.overview', params: {}, expect: 'The overview is read' }] }, 'Done.');
  return {
    seen,
    reply: (request) => {
      seen.push(request);
      return answer(request);
    },
  };
}

test('a rule saved in the panel survives a reload and reaches the model in the next request, ahead of the project summary', async ({ page }) => {
  const endpoint = recordingEndpoint();
  await fakeEndpoint(page, endpoint.reply);
  await useFakeEndpoint(page);
  await createProject(page, 'Rules Book');

  let panel = await openInstructions(page);
  await expect(panel.getByText('The agent has kept no notes yet.')).toBeVisible();
  const box = panel.getByRole('textbox', { name: 'Your instructions to the agent' });
  await box.fill(`British spelling.\n${RULE}\n`);
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved CAOTANG.md. Undo brings the old text back.')).toBeVisible();
  await panel.getByRole('button', { name: 'Done' }).click();
  await waitForSaved(page);

  await reopenProject(page, 'Rules Book');
  panel = await openInstructions(page);
  await expect(panel.getByRole('textbox', { name: 'Your instructions to the agent' })).toHaveValue(`British spelling.\n${RULE}\n`);
  await panel.getByRole('button', { name: 'Done' }).click();

  await sendIntent(page, 'What is in my project?');
  await expect.poll(() => endpoint.seen.length).toBeGreaterThanOrEqual(1);
  const first = endpoint.seen[0]?.user ?? '';
  expect(first).toContain('# Instructions');
  expect(first).toContain(RULE);
  expect(first.indexOf('# Instructions')).toBeLessThan(first.indexOf('# Project'));
  // The writer's rules ride the user message: the system message is the harness's own text.
  expect(endpoint.seen[0]?.system ?? '').not.toContain(RULE);
});

test('a file over the cap is named with how much was sent, in the panel and in Settings', async ({ page }) => {
  await createProject(page, 'Cap Book');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Context', exact: true }).click();
  await settings.getByLabel('Instructions (CAOTANG.md and memory)').fill('200');
  await settings.getByRole('button', { name: 'Save budgets' }).click();
  await expect(settings.getByText('Saved. The agent’s next request uses these budgets.')).toBeVisible();
  await page.keyboard.press('Escape');

  const panel = await openInstructions(page);
  const long = Array.from({ length: 60 }, (_, i) => `Rule ${String(i + 1).padStart(2, '0')}: keep the voice dry, always, and never explain a joke.`).join('\n');
  await panel.getByRole('textbox', { name: 'Your instructions to the agent' }).fill(long);
  await panel.getByRole('button', { name: 'Save', exact: true }).click();

  const budget = panel.getByTestId('instructions-budget');
  await expect(budget).toContainText('of the 200 tokens allowed');
  await expect(budget.getByRole('alert')).toContainText(/^CAOTANG\.md is [\d,]+ tokens; the first [\d,]+ were sent\./u);
  const sentence = (await budget.getByRole('alert').textContent()) ?? '';
  const [, total, sent] = /is ([\d,]+) tokens; the first ([\d,]+) were sent/u.exec(sentence) ?? [];
  expect(Number((total ?? '').replace(',', ''))).toBeGreaterThan(Number((sent ?? '').replace(',', '')));
  expect(Number((sent ?? '').replace(',', ''))).toBeLessThanOrEqual(200);
  await panel.getByRole('button', { name: 'Done' }).click();

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settings.getByRole('button', { name: 'Context', exact: true }).click();
  await expect(settings.getByTestId('instructions-cap')).toContainText(`CAOTANG.md is ${total} tokens; the first ${sent} were sent.`);
});

test('Initialise asks the agent for a first CAOTANG.md behind one confirm card; approving writes it, and undo takes it away', async ({ page }) => {
  await createProject(page, 'Initialise Book');
  const panel = await openInstructions(page);
  await panel.getByRole('button', { name: 'Initialise from this project' }).click();

  // The panel steps aside, the agent drawer opens, and the draft waits on one card that shows the file as a difference.
  await expect(panel).toBeHidden();
  const card = page.getByTestId('plan-card');
  await expect(card.getByRole('heading', { name: 'One step to confirm' })).toBeVisible();
  await expect(card.locator('.plan-step[data-step="1"]')).toHaveAttribute('data-tool', 'instructions.propose');
  await expect(card.getByRole('figure', { name: 'Text this step writes' })).toContainText('Keep the spelling the manuscript already uses.');
  // Nothing is written before the writer decides.
  expect(DEMO_INTENTS.instructions).toContain('CAOTANG.md');

  await card.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.locator('.agent-report').last()).toContainText('Applied:');
  await waitForSaved(page);

  const after = await openInstructions(page);
  await expect(after.getByRole('textbox', { name: 'Your instructions to the agent' })).toHaveValue(DEMO_INSTRUCTIONS);
  await after.getByRole('button', { name: 'Done' }).click();

  await page.getByRole('button', { name: /^Undo/ }).click();
  const undone = await openInstructions(page);
  await expect(undone.getByRole('textbox', { name: 'Your instructions to the agent' })).toHaveValue('');
});

test('a memory note is added, edited and forgotten behind a question, survives a reload, and one undo brings it back', async ({ page }) => {
  await createProject(page, 'Notes Book');
  let panel = await openInstructions(page);
  await panel.getByRole('button', { name: 'Add a note…' }).click();
  await panel.getByRole('textbox', { name: 'Title' }).fill('Dialogue tags');
  await panel.getByRole('textbox', { name: 'Note' }).fill('Use "said" for tags.');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  const note = panel.getByTestId('memory-note-dialogue-tags');
  await expect(note).toContainText('Dialogue tags');
  await expect(note).toContainText('Written by you');
  await panel.getByRole('button', { name: 'Done' }).click();
  await waitForSaved(page);

  await reopenProject(page, 'Notes Book');
  panel = await openInstructions(page);
  await expect(panel.getByTestId('memory-note-dialogue-tags')).toContainText('Use "said" for tags.');
  await expect(panel.getByTestId('instructions-budget')).toContainText('in your instructions and the memory index');

  // Edit it.
  await panel.getByRole('button', { name: 'Edit Dialogue tags' }).click();
  await panel.getByRole('textbox', { name: 'Note' }).fill('Use "said" for tags, never "asked".');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByTestId('memory-note-dialogue-tags')).toContainText('never "asked"');

  // Forget it: the writer is asked first, and a cancelled question forgets nothing.
  await panel.getByRole('button', { name: 'Forget Dialogue tags' }).click();
  const question = page.getByRole('dialog', { name: 'Forget “Dialogue tags”?' });
  await question.getByRole('button', { name: 'Cancel' }).click();
  await expect(panel.getByTestId('memory-note-dialogue-tags')).toBeVisible();
  await panel.getByRole('button', { name: 'Forget Dialogue tags' }).click();
  await page.getByRole('dialog', { name: 'Forget “Dialogue tags”?' }).getByRole('button', { name: 'Forget', exact: true }).click();
  await expect(panel.getByTestId('memory-note-dialogue-tags')).toHaveCount(0);
  await expect(panel.getByText('The agent has kept no notes yet.')).toBeVisible();
  await panel.getByRole('button', { name: 'Done' }).click();

  await page.getByRole('button', { name: /^Undo/ }).click();
  panel = await openInstructions(page);
  await expect(panel.getByTestId('memory-note-dialogue-tags')).toContainText('never "asked"');
});

test('a title that is a codex name is refused in the panel, naming the codex', async ({ page }) => {
  await createProject(page, 'Codex Book');
  // A codex entry named Elena, made through the codex tab.
  await page.getByRole('tab', { name: 'Codex' }).click();
  await page.getByRole('button', { name: 'New entry' }).click();
  const name = page.getByRole('textbox', { name: 'Name' });
  await name.fill('Elena');
  await name.press('Enter');
  await waitForSaved(page);

  const panel = await openInstructions(page);
  await panel.getByRole('button', { name: 'Add a note…' }).click();
  await panel.getByRole('textbox', { name: 'Title' }).fill('Elena');
  await panel.getByRole('textbox', { name: 'Note' }).fill('Elena is left-handed.');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('codex.write');
});
