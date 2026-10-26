import { createRequire } from 'node:module';

import { expect, test, type Page } from '@playwright/test';

import { binderTitle, createProject, firstChapter, waitForSaved } from './support.js';

/**
 * The shell's surfaces, as rendered, pass the axe rules the suite holds them to: no colour-contrast violation (WCAG 2.2 1.4.3;
 * ui-modules §0 item 5), no target smaller than 24 by 24 CSS pixels (WCAG 2.2 2.5.8, target size), and no role ARIA does not allow on
 * its element. axe-core runs each rule on each region, so a colour or size a component sets on its own is checked too,
 * not only the stylesheet's tokens (e2e/unit/theme-contrast.spec.ts reads those). A node axe cannot decide (its "incomplete" list: an
 * overlapping or see-through background, say) is counted as a failure, with two exceptions: a node axe calls partly obscured is scrolled
 * into view and run again, and an undecided colour-contrast node passes when its own text colour reaches 4.5 to 1 against the nearest
 * opaque ancestor's background. That fallback reads computed styles only: it does not see translucent layers between the two, element
 * opacity, or an element drawn over the text, so for those it is weaker than axe's own measure.
 */

const require = createRequire(import.meta.url);
const AXE = require.resolve('axe-core');

// axe-core is injected as an inline script, which the app's Content-Security-Policy (script-src 'self') refuses, as it
// should. The scanner is test tooling, not part of the app, so this file alone runs with the policy bypassed.
test.use({ bypassCSP: true });

interface AxeNode {
  readonly target: readonly string[];
  readonly any: readonly { readonly data?: { readonly messageKey?: string } | null }[];
}

interface AxeResult {
  readonly id: string;
  readonly nodes: readonly AxeNode[];
}

/** The rules the shell's surfaces are held to beside colour contrast: the target size and the roles ARIA allows. */
const SHELL_RULES = ['target-size', 'aria-allowed-role'] as const;

/**
 * The problems axe finds inside `selector` for `rules`, one line per node: whether it failed or was undecided, the rule, the element's
 * selector, and for an undecided node axe's reason. A node axe could not decide only because it is scrolled partly out of its pane is
 * scrolled into view and checked again on its own.
 *
 * A colour-contrast node axe still cannot decide is computed here, not passed: its own colours and the nearest opaque background behind
 * it give a ratio, and a pair at 4.5 to 1 or more passes. axe leaves a node undecided for a geometric reason (its corner sits over an
 * ancestor, which axe reads as an overlap) or for a glyph it treats as an icon (a symbol from a block such as Geometric Shapes), and
 * neither says the colours are wrong. Every other pair is still reported.
 */
async function problemsIn(page: Page, selector: string, rules: readonly string[]): Promise<string[]> {
  await page.addScriptTag({ path: AXE });
  return page.evaluate(
    async ({ scope, ruleIds }) => {
      const axe = (globalThis as unknown as {
        axe: {
          run: (context: string | Element, options: unknown) => Promise<{ violations: AxeResult[]; incomplete: AxeResult[] }>;
        };
      }).axe;
      const options = { runOnly: { type: 'rule', values: ruleIds } };
      const reasonOf = (node: AxeNode): string | undefined => node.any.map((check) => check.data?.messageKey).find((key) => key !== undefined);
      const lines = (kind: string, results: AxeResult[]): string[] =>
        results.flatMap((entry) =>
          entry.nodes.map((node) => {
            const reason = reasonOf(node);
            return `${kind} ${entry.id}: ${node.target.join(' ')}${reason === undefined ? '' : ` (${reason})`}`;
          }),
        );

      type Rgba = [number, number, number, number];
      const parseColour = (value: string): Rgba | null => {
        const match = /rgba?\(([^)]+)\)/.exec(value);
        if (match === null) return null;
        const parts = (match[1] ?? '').split(/[\s,/]+/).filter((part) => part !== '').map(Number);
        return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
      };
      const luminance = ([r, g, b]: Rgba): number => {
        const [lr, lg, lb] = [r, g, b].map((channel) => {
          const s = channel / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * (lr ?? 0) + 0.7152 * (lg ?? 0) + 0.0722 * (lb ?? 0);
      };
      const ratioOf = (a: Rgba, b: Rgba): number => {
        const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
        return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
      };
      const backgroundBehind = (element: Element): Rgba => {
        for (let node: Element | null = element; node !== null; node = node.parentElement) {
          const colour = parseColour(getComputedStyle(node).backgroundColor);
          if (colour !== null && colour[3] >= 1) return colour;
        }
        return [255, 255, 255, 1];
      };
      /** Whether the element's own text colour, over the nearest opaque background, reaches 4.5 to 1 (WCAG 1.4.3). */
      const computedPasses = (node: AxeNode): boolean => {
        const element = document.querySelector(node.target.join(' '));
        const foreground = element === null ? null : parseColour(getComputedStyle(element).color);
        if (element === null || foreground === null) return false;
        const background = backgroundBehind(element);
        const alpha = foreground[3];
        const mix = (channel: number): number => (foreground[channel] ?? 0) * alpha + (background[channel] ?? 0) * (1 - alpha);
        const blended: Rgba = [mix(0), mix(1), mix(2), 1];
        return ratioOf(blended, background) >= 4.5;
      };

      const result = await axe.run(scope, options);
      const problems = lines('violation', result.violations);
      const undecided: { readonly id: string; readonly node: AxeNode }[] = [];
      for (const entry of result.incomplete) {
        for (const node of entry.nodes) {
          const element = reasonOf(node) === 'elmPartiallyObscured' ? document.querySelector(node.target.join(' ')) : null;
          if (element === null) {
            undecided.push({ id: entry.id, node });
            continue;
          }
          element.scrollIntoView({ block: 'center' });
          const again = await axe.run(element, options);
          problems.push(...lines('violation', again.violations));
          for (const inner of again.incomplete) for (const innerNode of inner.nodes) undecided.push({ id: inner.id, node: innerNode });
        }
      }
      for (const { id, node } of undecided) {
        if (id === 'color-contrast' && computedPasses(node)) continue;
        problems.push(...lines('undecided', [{ id, nodes: [node] }]));
      }
      return problems;
    },
    { scope: selector, ruleIds: [...rules] },
  );
}

/** The colour-contrast problems inside `selector`. */
function contrastProblemsIn(page: Page, selector: string): Promise<string[]> {
  return problemsIn(page, selector, ['color-contrast']);
}

/** The target-size and role problems inside `selector`. */
function shellProblemsIn(page: Page, selector: string): Promise<string[]> {
  return problemsIn(page, selector, SHELL_RULES);
}

test.describe('the light theme', () => {
  test.use({ colorScheme: 'light' });

  test('the binder rail and the binder footer have no colour-contrast violations and no node axe could not decide', async ({ page }) => {
    await createProject(page, 'Contrast Light');
    await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
    expect(await contrastProblemsIn(page, '.rail')).toEqual([]);
    expect(await contrastProblemsIn(page, '.binder-footer')).toEqual([]);
  });
});

test.describe('the dark theme', () => {
  test.use({ colorScheme: 'dark' });

  test('the binder rail and the binder footer have no colour-contrast violations and no node axe could not decide', async ({ page }) => {
    await createProject(page, 'Contrast Dark');
    await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
    expect(await contrastProblemsIn(page, '.rail')).toEqual([]);
    expect(await contrastProblemsIn(page, '.binder-footer')).toEqual([]);
  });
});

test('every surface of the shell and its dialogs passes the colour-contrast, target-size and role rules, one surface at a time', async ({
  page,
}) => {
  test.setTimeout(180_000);
  // A chapter with a scene in it, so the binder has a container row, a document row with its status chip, and a scene to open.
  await createProject(page, 'Every Surface');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('The Landing');
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Document text' }).fill('The ferry was late, as always.');
  await waitForSaved(page);

  const found: Record<string, string[]> = {};
  const check = async (name: string, selector: string): Promise<void> => {
    found[name] = [...(await contrastProblemsIn(page, selector)), ...(await shellProblemsIn(page, selector))];
  };

  await check('toolbar', '.toolbar');
  await check('rail', '.rail');
  await check('footer', '.binder-footer');
  await check('editor', '.center');
  await check('inspector', '.inspector');
  await check('agent drawer', '.agent');

  await page.getByRole('radio', { name: 'Corkboard' }).click();
  await check('corkboard', '.corkboard');
  await page.getByRole('radio', { name: 'Editor' }).click();

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('dialog.settings')).toBeVisible();
  await check('settings', 'dialog.settings');
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.settings')).toBeHidden();

  await page.getByRole('button', { name: 'Compile…', exact: true }).click();
  await expect(page.locator('dialog.export-dialog')).toBeVisible();
  await check('export dialog', 'dialog.export-dialog');
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.export-dialog')).toBeHidden();

  await page.getByRole('button', { name: 'Every Surface', exact: true }).click();
  await expect(page.locator('dialog.project-dialog')).toBeVisible();
  await check('project panel', 'dialog.project-dialog');
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.project-dialog')).toBeHidden();

  // Focus mode keeps the toolbar, with its Projects button (the button was squeezed to a target under 24 px).
  await page.getByRole('button', { name: 'Focus', exact: true }).click();
  await check('focus toolbar', '.toolbar');
  await page.getByRole('button', { name: 'Focus', exact: true }).click();

  // The problems, by surface: a surface with none maps to an empty list, so a failure names the surface and the element.
  expect(Object.fromEntries(Object.entries(found).filter(([, problems]) => problems.length > 0))).toEqual({});
  await expect(binderTitle(page, 'The Landing')).toBeVisible();
});

test('the storage banner, shown while the browser has not kept the project, passes the colour-contrast, target-size and role rules', async ({
  page,
}) => {
  // The banner shows only while the browser reports the project's storage as not kept, so the check stubs that answer (as
  // sessions.spec.ts does) before the app loads.
  await page.addInitScript(() => {
    const storage = (globalThis as unknown as { navigator: { storage?: object } }).navigator.storage;
    if (storage === undefined) return;
    const proto = Object.getPrototypeOf(storage) as Record<string, unknown>;
    proto['persisted'] = async () => false;
    proto['persist'] = async () => false;
  });
  await createProject(page, 'Banner Book');
  const banner = page.getByTestId('storage-banner');
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: 'Learn why' }).click();
  await expect(banner).toContainText('Browsers may remove stored data');

  expect([...(await contrastProblemsIn(page, '.storage-banner')), ...(await shellProblemsIn(page, '.storage-banner'))]).toEqual([]);
});

test('the Pages tab of a screenplay scene, with its lines that open the Source tab, passes the colour-contrast and role rules', async ({
  page,
}) => {
  await createProject(page, 'Pages Book');
  await binderTitle(page, await firstChapter(page)).click({ button: 'right' });
  await page.getByRole('menu', { name: 'Actions for Chapter 1' }).getByRole('menuitem', { name: 'New screenplay scene here' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'Screenplay: Untitled scene' })).toBeVisible();
  await page.getByRole('radio', { name: 'Source', exact: true }).click();
  await page.getByRole('textbox', { name: 'Fountain source' }).fill(['INT. HOUSE - DAY', '', 'MARCUS', 'Hi.', '', 'Rain falls.'].join('\n'));
  await page.getByRole('radio', { name: 'Pages', exact: true }).click();
  await expect(page.getByRole('button', { name: 'MARCUS' })).toBeVisible();

  // Not the target-size rule: a line is a row of the page's own 14px grid, and the function it has is also reached by the Source tab
  // (WCAG 2.5.8, the equivalent-control exception), which axe cannot know.
  expect(await problemsIn(page, '.sp-preview', ['color-contrast', 'aria-allowed-role'])).toEqual([]);
});

test('the recurring tasks, with a task due, its form, its runs and a confirmation, pass the colour-contrast, target-size and role rules', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await createProject(page, 'Tasks Surface');
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  const tasks = page.getByTestId('recurring-tasks');
  await expect(tasks).toBeVisible();

  const make = async (name: string, does: string, when: string): Promise<void> => {
    await page.getByRole('button', { name: 'New task' }).click();
    const form = page.getByRole('form', { name: 'New task' });
    await form.getByLabel('Task name').fill(name);
    await form.getByLabel('What it does').selectOption({ label: does });
    if (does === 'Ask the agent') await form.getByLabel('What to ask').fill('Look over the newest scene.');
    await form.getByLabel('When', { exact: true }).selectOption({ label: when });
    if (when === 'Every day') await form.getByLabel('From').fill('00:00');
    // The form is checked while it is open, with every control it can show.
    if (when === 'Every week') expect([...(await contrastProblemsIn(page, '.recurring-form')), ...(await shellProblemsIn(page, '.recurring-form'))]).toEqual([]);
    await form.getByRole('button', { name: 'Save task' }).click();
    await expect(tasks.locator('[data-task]', { hasText: name })).toBeVisible();
  };
  await make('Weekly scan', 'Scan for continuity problems', 'Every week');
  await make('Daily read', 'Ask the agent', 'Every day');
  const scan = tasks.locator('[data-task]', { hasText: 'Weekly scan' });
  await scan.getByRole('button', { name: /^Run now/ }).click();
  await scan.getByText(/Runs on this machine/).click();
  await expect(scan.getByRole('list', { name: 'Runs of Weekly scan' })).toContainText('Done');

  // The daily task is due as the project opens again, and its offer is shown with the drawer closed.
  await page.reload();
  const row = page.getByRole('listitem').filter({ hasText: 'Tasks Surface' });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByTestId('task-offers').getByRole('group', { name: 'Task due: Daily read' })).toBeVisible({ timeout: 20_000 });
  expect([...(await contrastProblemsIn(page, '.recurring-offers')), ...(await shellProblemsIn(page, '.recurring-offers'))]).toEqual([]);

  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await expect(tasks).toBeVisible();
  await tasks.locator('[data-task]', { hasText: 'Weekly scan' }).getByText(/Runs on this machine/).click();
  expect([...(await contrastProblemsIn(page, '.recurring')), ...(await shellProblemsIn(page, '.recurring'))]).toEqual([]);

  await tasks.locator('[data-task]', { hasText: 'Daily read' }).getByRole('button', { name: /^Delete/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect([...(await contrastProblemsIn(page, 'dialog[open]')), ...(await shellProblemsIn(page, 'dialog[open]'))]).toEqual([]);
});
