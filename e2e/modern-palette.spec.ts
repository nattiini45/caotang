import { createRequire } from 'node:module';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { composeAndConfirm, createProject, waitForSaved } from './support.js';

/**
 * Modern's palette (M9, #310; modern-interface.md §8.9, §8.11, §9.1, §9.2): Ctrl+K (Cmd+K) opens a modal dialog "Search and
 * commands" with a combobox over a grouped listbox (the APG pattern, `aria-activedescendant`). Keyboard only: the arrow keys move,
 * Enter runs, Escape closes and gives focus back. An input method's composing Enter is not the palette's, and a composing Ctrl+K
 * opens nothing. Every shell action is reachable by its name; with no match Enter opens the agent with the text in the Intent box,
 * unsent. Classic has no palette (D11).
 *
 * The project is built in Classic (the suite's pin) and switched to Modern live, as a writer does, so the codex entry and the scenes
 * exist before Modern's own views do.
 */

async function openAppearance(page: Page): Promise<Locator> {
  const toolbarSettings = page.locator('.toolbar').getByRole('button', { name: 'Settings', exact: true });
  if ((await toolbarSettings.count()) > 0) {
    await toolbarSettings.click();
  } else {
    await page.getByTestId('modern-top-ornament').getByRole('button', { name: 'More' }).click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
  }
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
  return settings;
}

async function switchTo(page: Page, name: 'Classic' | 'Modern (Preview)'): Promise<void> {
  const settings = await openAppearance(page);
  await settings.getByRole('group', { name: 'Interface', exact: true }).getByRole('radio', { name }).check();
  await settings.getByRole('button', { name: 'Close' }).click();
  await expect(settings).toHaveCount(0);
}

/** A chapter with two scenes and a codex entry, built in Classic, then Modern on, with the first scene open in the editor. */
async function harbourInModern(page: Page): Promise<void> {
  await createProject(page, 'Harbour Book');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  const newDocument = page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' });
  await newDocument.click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('Lin’s ticket');
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Document text' }).fill('The ferry left at dawn, and Lin had the only ticket.');
  await newDocument.click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('The harbour at night');
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Document text' }).fill('Lanterns on the water.');
  await page.getByRole('tab', { name: 'Codex' }).click();
  await page.getByRole('button', { name: 'New entry' }).click();
  const name = page.getByRole('textbox', { name: 'Name', exact: true });
  await name.fill('Zoë Hart');
  await name.press('Enter');
  await page.getByRole('tab', { name: 'Binder' }).click();
  await waitForSaved(page);
  await switchTo(page, 'Modern (Preview)');
  await expect(page.getByTestId('modern-stage')).toBeVisible();
}

function palette(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Search and commands' });
}

function field(page: Page): Locator {
  return palette(page).getByRole('combobox', { name: 'Search scenes, codex and commands' });
}

/** The option the combobox names as active (`aria-activedescendant`). */
async function activeOption(page: Page): Promise<Locator> {
  const id = await field(page).getAttribute('aria-activedescendant');
  expect(id).not.toBeNull();
  return page.locator(`[id="${id ?? ''}"]`);
}

/** The option shown as active: the one with aria-selected, which is the one aria-activedescendant names. */
function selected(page: Page): Locator {
  return palette(page).getByRole('option', { selected: true });
}

async function openWithKeys(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k');
  await expect(palette(page)).toBeVisible();
  await expect(field(page)).toBeFocused();
}

test('Ctrl+K opens a modal combobox over a grouped listbox; the arrow keys move, Enter opens the scene, and the rest is inert', async ({ page }) => {
  await harbourInModern(page);
  const text = page.getByRole('main', { name: 'Harbour Book' }).getByRole('textbox', { name: 'Document text' });
  await text.click();
  await openWithKeys(page);

  // The APG combobox: expanded, controlling a listbox, an active option named by aria-activedescendant.
  const combobox = field(page);
  await expect(combobox).toHaveAttribute('aria-expanded', 'true');
  await expect(combobox).toHaveAttribute('aria-autocomplete', 'list');
  const listId = await combobox.getAttribute('aria-controls');
  const listbox = page.locator(`[id="${listId ?? ''}"]`);
  await expect(listbox).toHaveAttribute('role', 'listbox');
  // Empty, it shows the recent scenes and the commands, each a named group.
  await expect(listbox.getByRole('group', { name: 'Recent scenes' })).toBeVisible();
  await expect(listbox.getByRole('group', { name: 'Commands' })).toBeVisible();
  await expect(await activeOption(page)).toHaveAttribute('aria-selected', 'true');
  await expect(listbox.getByRole('option', { selected: true })).toHaveCount(1);

  // Modal: the page behind is inert, and the dialog is the modal one.
  expect(await palette(page).evaluate((dialog) => dialog.matches(':modal'))).toBe(true);
  // A control behind it cannot take focus while the palette is open.
  expect(
    await page.getByTestId('modern-top-ornament').getByRole('button', { name: 'More', includeHidden: true }).evaluate((button) => {
      (button as HTMLElement).focus();
      return document.activeElement === button;
    }),
  ).toBe(false);
  await expect(combobox).toBeFocused();

  // "the" finds the scene by its title and the theme command by its words: two options in two groups.
  await page.keyboard.type('the');
  await expect(listbox.getByRole('group', { name: 'Scenes and folders' })).toBeVisible();
  const first = await activeOption(page);
  await expect(first).toContainText('The harbour at night');
  const firstId = (await first.getAttribute('id')) ?? '';
  await page.keyboard.press('ArrowDown');
  await expect(combobox).not.toHaveAttribute('aria-activedescendant', firstId);
  await expect(await activeOption(page)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowUp');
  await expect(combobox).toHaveAttribute('aria-activedescendant', firstId);
  // Up from the first wraps to the last, and Down wraps back.
  await page.keyboard.press('ArrowUp');
  await expect(combobox).not.toHaveAttribute('aria-activedescendant', firstId);
  await page.keyboard.press('ArrowDown');
  await expect(combobox).toHaveAttribute('aria-activedescendant', firstId);

  await page.keyboard.press('Enter');
  await expect(palette(page)).toHaveCount(0);
  await expect(text).toHaveText('Lanterns on the water.');
});

test('Escape closes the palette and gives focus back to what had it', async ({ page }) => {
  await harbourInModern(page);
  const more = page.getByTestId('modern-top-ornament').getByRole('button', { name: 'More' });
  await more.focus();
  await openWithKeys(page);
  await page.keyboard.type('ticket');
  await page.keyboard.press('Escape');
  await expect(palette(page)).toHaveCount(0);
  await expect(more).toBeFocused();

  // It opens again empty.
  await openWithKeys(page);
  await expect(field(page)).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(more).toBeFocused();
});

test('every shell action is reachable by its name, and Enter runs it', async ({ page }) => {
  await harbourInModern(page);
  const labels = ['Projects', 'Project details', 'Undo', 'Focus mode', 'Skills', 'Instructions', 'Compile…', 'Export bundle', 'Settings', 'Dark theme'];
  const folderPicker = await page.evaluate(() => 'showDirectoryPicker' in window);
  if (folderPicker) labels.push('Save to folder');
  await openWithKeys(page);
  for (const label of labels) {
    await field(page).fill(label);
    await expect(palette(page).getByRole('option').filter({ has: page.locator('.modern-palette-label', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) })).toHaveCount(1);
  }

  // Running one: the theme changes, and the palette is gone.
  await field(page).fill('Dark theme');
  await expect(selected(page)).toContainText('Dark theme');
  await page.keyboard.press('Enter');
  await expect(palette(page)).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // A Settings section by its name opens Settings on that section.
  await openWithKeys(page);
  await page.keyboard.type('appearance');
  await expect(selected(page)).toContainText('Appearance');
  await page.keyboard.press('Enter');
  const settings = page.getByTestId('settings');
  await expect(settings).toBeVisible();
  await expect(settings.getByRole('group', { name: 'Interface', exact: true })).toBeVisible();
  await settings.getByRole('button', { name: 'Close' }).click();
});

test('a codex entry is found by its name without the accent', async ({ page }) => {
  await harbourInModern(page);
  await openWithKeys(page);
  await page.keyboard.type('zoe');
  await expect(palette(page).getByRole('group', { name: 'Codex' }).getByRole('option')).toContainText(['Zoë Hart']);
});

test('an input method’s composing Enter stays in the field, and a composing Ctrl+K opens nothing', async ({ page }) => {
  await harbourInModern(page);
  const text = page.getByRole('main', { name: 'Harbour Book' }).getByRole('textbox', { name: 'Document text' });
  await text.click();
  // A Ctrl+K that arrives while a composition is active belongs to the input method.
  await text.evaluate((element) => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true, cancelable: true, isComposing: true }));
  });
  await expect(palette(page)).toHaveCount(0);

  await openWithKeys(page);
  expect(await composeAndConfirm(field(page), '码头')).toBe(false);
  expect(await composeAndConfirm(field(page), '码头', 'keyCode')).toBe(false);
  await expect(palette(page)).toBeVisible();
  await expect(field(page)).toHaveValue('码头');
  await expect(field(page)).toBeFocused();
  // An Escape inside a composition is the input method's too.
  await field(page).evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
  });
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeVisible();
  await field(page).evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
  });
  await page.keyboard.press('Escape');
  await expect(palette(page)).toHaveCount(0);
});

test('with no match, Enter opens the agent with the words in the Intent box, not sent', async ({ page }) => {
  await harbourInModern(page);
  await openWithKeys(page);
  await page.keyboard.type('a storm that strands the ferry');
  await expect(selected(page)).toContainText('Ask the agent: “a storm that strands the ferry”');
  await expect(palette(page).getByRole('status')).toContainText('Nothing found');
  await page.keyboard.press('Enter');
  await expect(palette(page)).toHaveCount(0);
  const intent = page.getByRole('combobox', { name: 'Intent' });
  await expect(intent).toHaveValue('a storm that strands the ferry');
  // The caret goes to the Intent box when it can take it (it is disabled until a provider is set up).
  if (await intent.isEnabled()) await expect(intent).toBeFocused();
  // Nothing was sent: no turn is in the panel.
  await expect(page.getByTestId('agent-stop')).toHaveCount(0);
});

test('the palette offers the way back to Classic, and Classic has no palette', async ({ page }) => {
  await harbourInModern(page);
  await openWithKeys(page);
  await page.keyboard.type('classic');
  await page.keyboard.press('Enter');
  await expect(page.locator('.toolbar')).toBeVisible();
  await expect(page.getByTestId('modern-stage')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('caotang.interface'))).toBe('classic');

  await page.getByRole('textbox', { name: 'Document text' }).click();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(palette(page)).toHaveCount(0);
});

test.describe('axe', () => {
  // axe-core is injected as an inline script, which the app's Content-Security-Policy refuses; the scanner is test tooling.
  test.use({ bypassCSP: true });

  test('the open palette passes axe (contrast on glass is the computed test’s, §9.3)', async ({ page }) => {
    await harbourInModern(page);
    await openWithKeys(page);
    await page.keyboard.type('the');
    const require = createRequire(import.meta.url);
    await page.addScriptTag({ path: require.resolve('axe-core') });
    const violations = await page.evaluate(async () => {
      const axe = (globalThis as unknown as {
        axe: { run: (context: Element | string, options: unknown) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> };
      }).axe;
      const dialog = document.querySelector('dialog.modern-palette');
      if (dialog === null) return ['no dialog'];
      const result = await axe.run(dialog, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
        rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
      });
      return result.violations.flatMap((violation) => violation.nodes.map((node) => `${violation.id}: ${node.target.join(' ')}`));
    });
    expect(violations).toEqual([]);
  });
});
