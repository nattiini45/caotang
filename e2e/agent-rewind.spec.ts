import { expect, test, type Page } from '@playwright/test';

import { fakeEndpoint, planThenAnswer, useFakeEndpoint, type FakeReply } from './endpoint.js';

/**
 * The two axes of a turn's checkpoint in the agent panel (agent-harness §5): the project is restored, the conversation is rewound,
 * or both. Each turn labels a different scene, so the binder shows what the project holds. The endpoint is a fake (endpoint.ts);
 * the panel, the menu, the dialog and the undo are the app's own.
 */

const FIRST = 'Mark The Landing as a draft.';
const SECOND = 'Mark The Storm as final.';

const planFor = (doc: string, status: string) => ({
  steps: [{ tool: 'meta.set', params: { targets: [doc], status }, expect: `${doc} is ${status}` }],
});

/** The first intent gets its plan, the second gets its own: the fake picks by the request the planner was sent. */
const reply: FakeReply = (request) => {
  const plan = request.user.includes(`Request: ${SECOND}`) ? planFor('The Storm', 'final') : planFor('The Landing', 'draft');
  return planThenAnswer(plan, 'Marked.')(request);
};

async function openSample(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
}

async function sendIntent(page: Page, intent: string): Promise<void> {
  const field = page.getByRole('combobox', { name: 'Intent' });
  await expect(field).toBeEnabled();
  await field.fill(intent);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

/** Both turns, finished: each wrote one status and left a checkpoint. */
async function twoTurns(page: Page): Promise<void> {
  await fakeEndpoint(page, reply);
  await useFakeEndpoint(page);
  await openSample(page);
  await sendIntent(page, FIRST);
  await expect(page.getByTestId('checkpoint')).toHaveCount(1);
  await sendIntent(page, SECOND);
  await expect(page.getByTestId('checkpoint')).toHaveCount(2);
  await expect(page.getByRole('treeitem', { name: /The Landing/ })).toContainText(/draft/i);
  await expect(page.getByRole('treeitem', { name: /The Storm/ })).toContainText(/final/i);
}

const menuOfTurn = (page: Page, intent: string) => page.locator('.agent-turn', { hasText: intent }).getByTestId('turn-menu');

test('rewinding the conversation sets the turn and the later ones aside, refills the Intent box and leaves the project alone', async ({ page }) => {
  await twoTurns(page);

  await menuOfTurn(page, FIRST).getByRole('button', { name: /^Rewind options/ }).click();
  await page.getByRole('button', { name: /Rewind conversation to before this turn/ }).click();

  const rewound = page.getByTestId('agent-rewound');
  await expect(rewound.locator(':scope > summary')).toHaveText('Rewound - not sent to the model (2 turns)');
  // Collapsed: the turns are kept, not shown, until the writer opens the block.
  await expect(rewound.locator('.agent-turn')).toHaveCount(2);
  await expect(rewound.locator('.agent-turn').first()).toBeHidden();
  await rewound.locator(':scope > summary').click();
  await expect(rewound.locator('.agent-turn').first()).toBeVisible();

  await expect(page.getByRole('combobox', { name: 'Intent' })).toHaveValue(FIRST);
  await expect(page.getByRole('status').filter({ hasText: 'Rewound the conversation to before that turn.' })).toBeVisible();
  // Nothing in the project moved, and the checkpoints still stand.
  await expect(page.getByRole('treeitem', { name: /The Landing/ })).toContainText(/draft/i);
  await expect(page.getByRole('treeitem', { name: /The Storm/ })).toContainText(/final/i);
  await expect(rewound.getByRole('button', { name: 'Restore to before this turn' })).toHaveCount(2);
});

test('a draft in the Intent box is kept, and the old instruction is offered as a button', async ({ page }) => {
  await twoTurns(page);
  const intent = page.getByRole('combobox', { name: 'Intent' });
  await intent.fill('My own half-written request');

  await menuOfTurn(page, SECOND).getByRole('button', { name: /^Rewind options/ }).click();
  await page.getByRole('button', { name: /Rewind conversation to before this turn/ }).click();

  await expect(intent).toHaveValue('My own half-written request');
  const offer = page.getByTestId('agent-old-instruction');
  await expect(offer).toContainText(SECOND);
  await offer.getByRole('button', { name: 'Use the old instruction' }).click();
  await expect(intent).toHaveValue(SECOND);
  await expect(offer).toBeHidden();
  // Only the second turn was rewound.
  await expect(page.getByTestId('agent-rewound').locator(':scope > summary')).toHaveText('Rewound - not sent to the model (1 turn)');
});

test('restore both takes the project back and rewinds the conversation after a confirmation', async ({ page }) => {
  await twoTurns(page);

  await menuOfTurn(page, FIRST).getByRole('button', { name: /^Rewind options/ }).click();
  await page.getByRole('button', { name: /^Restore both/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Restore the project and rewind the conversation?' });
  await expect(dialog).toContainText('The agent then forgets this turn and the ones after it.');
  await expect(dialog).toContainText('Your edits since then are included in the restore');
  await dialog.getByRole('button', { name: 'Restore both', exact: true }).click();

  await expect(page.getByRole('status').filter({ hasText: 'The conversation was rewound too.' })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: /The Landing/ })).not.toContainText(/draft/i);
  await expect(page.getByRole('treeitem', { name: /The Storm/ })).not.toContainText(/final/i);
  await expect(page.getByTestId('agent-rewound').locator(':scope > summary')).toHaveText('Rewound - not sent to the model (2 turns)');
  await expect(page.getByRole('combobox', { name: 'Intent' })).toHaveValue(FIRST);
});

test('restoring the project alone keeps the conversation: the turns stay in the list, outside the rewound block', async ({ page }) => {
  await twoTurns(page);

  await menuOfTurn(page, FIRST).getByRole('button', { name: /^Rewind options/ }).click();
  await page.getByRole('button', { name: /^Restore project to before this turn/ }).click();
  await page.getByRole('dialog', { name: 'Restore to before this turn?' }).getByRole('button', { name: 'Restore', exact: true }).click();

  await expect(page.getByRole('status').filter({ hasText: 'Restored to before that turn. 1 later change was taken back with it.' })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: /The Storm/ })).not.toContainText(/final/i);
  await expect(page.getByTestId('agent-rewound')).toHaveCount(0);
  // The first-run demo turn, and the two of this test.
  await expect(page.locator('.agent-turn')).toHaveCount(3);
});

test('the menu opens from the keyboard, closes with Escape and returns focus to its button', async ({ page }) => {
  await twoTurns(page);
  const toggle = menuOfTurn(page, FIRST).getByRole('button', { name: /^Rewind options/ });

  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: /^Restore project to before this turn/ })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();
});
