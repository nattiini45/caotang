import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { NO_PIN } from './classic-pin.js';
import { createProject, waitForSaved } from './support.js';

/**
 * The gaps the Modern accessibility gate (#313) found on surfaces already built, each held here on its own (modern-interface.md §9.1,
 * §9.3, §9.5), with Classic unchanged beside it:
 *
 * - **the page**: the editor's Insert picture, Add footnote and daily-target buttons are 44 px targets in Modern (the footer stays on
 *   the page, since Scene info › Progress has neither the scene's word count nor Add footnote), and keep Classic's sizes in Classic;
 * - **Scene info**: every field, picker and button is at least 44 px, the field notes keep 4.5:1 on the thick glass and on a
 *   disclosure's scrim over every wallpaper colour, and the project's line opens Project details (§7.1);
 * - **the agent window**: its sections are h3 under the window's h2 (h4 in Classic's drawer), Close keeps 4.5:1 on the glass, and the
 *   Mode radios with their labels and New task are 44 px.
 *
 * The project is made in Classic and Modern is switched on live in Settings › Appearance, so the spec starts the same way whatever
 * the ornaments (#306) and the sidebar (#307) put on the screen.
 */

test.use({ storageState: NO_PIN, viewport: { width: 1440, height: 900 } });

const SCHEMES = ['light', 'dark'] as const;
type Scheme = (typeof SCHEMES)[number];

/** Every colour each scheme's wallpaper draws: the backdrop the glass is composited over (each taken as opaque, the worst case). */
const WALLPAPER: Readonly<Record<Scheme, readonly string[]>> = Object.fromEntries(
  SCHEMES.map((scheme) => [
    scheme,
    [
      ...new Set(
        [...readFileSync(fileURLToPath(new URL(`../apps/desktop/src/components/shell/modern/wallpaper-${scheme}.svg`, import.meta.url)), 'utf8').matchAll(/#[0-9a-f]{6}\b/gi)].map((match) =>
          match[0].toLowerCase(),
        ),
      ),
    ],
  ]),
) as Record<Scheme, string[]>;

/** A project with one scene and its text, made in Classic, in the scheme asked for. */
async function sceneInClassic(page: Page, scheme: Scheme = 'light'): Promise<void> {
  await page.addInitScript((chosen: string) => {
    localStorage.setItem('caotang.theme', chosen);
    // The browser keeps this origin's storage, so the storage banner stays away.
    const storage = (globalThis as unknown as { navigator: { storage?: object } }).navigator.storage;
    if (storage !== undefined) {
      const proto = Object.getPrototypeOf(storage) as Record<string, unknown>;
      proto['persisted'] = async () => true;
      proto['persist'] = async () => true;
    }
  }, scheme);
  await createProject(page, 'Gaps Book');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('The crossing');
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Document text' }).fill('The ferry left at dawn. Nobody was on it.');
  await waitForSaved(page);
}

/** Settings › Appearance › Interface › Modern, from Classic's toolbar. */
async function switchToModern(page: Page): Promise<void> {
  await page.locator('.toolbar').getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
  await settings.getByRole('group', { name: 'Interface', exact: true }).getByRole('radio', { name: /^Modern/ }).check();
  await settings.getByRole('button', { name: 'Close' }).click();
  await expect(settings).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-shell', 'modern');
}

/** Lets a morph or a fade run out, so a measure reads the surface where it rests. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))));
}

/** Scene info, from the palette (Ctrl+K). */
async function openSceneInfo(page: Page): Promise<Locator> {
  await page.getByRole('textbox', { name: 'Document text' }).click();
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Search and commands' });
  await palette.getByRole('combobox', { name: 'Search scenes, codex and commands' }).fill('Scene info');
  await palette
    .getByRole('option')
    .filter({ has: page.locator('.modern-palette-label', { hasText: /^Scene info$/ }) })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: 'Scene info' });
  await expect(dialog).toBeVisible();
  await settle(page);
  return dialog;
}

/** The agent window, from Ctrl+J in the editor. */
async function openAgentWindow(page: Page): Promise<Locator> {
  await page.getByRole('textbox', { name: 'Document text' }).click();
  await page.keyboard.press('ControlOrMeta+j');
  const window = page.getByRole('complementary', { name: 'Agent' });
  await expect(window).toBeVisible();
  await settle(page);
  return window;
}

async function boxOf(locator: Locator): Promise<{ width: number; height: number }> {
  const box = await locator.boundingBox();
  expect(box, 'the control has a box').not.toBeNull();
  return { width: box?.width ?? 0, height: box?.height ?? 0 };
}

async function expectTarget(locator: Locator, what: string): Promise<void> {
  const { width, height } = await boxOf(locator);
  expect(Math.round(height), `${what}: height`).toBeGreaterThanOrEqual(44);
  expect(Math.round(width), `${what}: width`).toBeGreaterThanOrEqual(44);
}

/**
 * Every control inside the element under 44 by 44 CSS px. A checkbox or radio counts with its label; a link or button inside a
 * sentence keeps its line (WCAG 2.5.8's inline exception); a visually hidden file input behind its button is not a target.
 */
function smallControls(scope: Locator): Promise<string[]> {
  return scope.evaluate((root) => {
    const CONTROLS = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=radio], [role=checkbox], [role=combobox]';
    const small: string[] = [];
    for (const element of root.querySelectorAll(CONTROLS)) {
      if (element.closest('[aria-hidden="true"], [inert], [hidden]') !== null) continue;
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      const inSentence = [...(element.parentElement?.childNodes ?? [])].some((child) => child.nodeType === Node.TEXT_NODE && (child.textContent ?? '').trim() !== '');
      if (element.matches('a, button') && inSentence) continue;
      let measured: Element = element;
      if (element.matches('input[type=checkbox], input[type=radio]')) measured = element.closest('label') ?? (element.id === '' ? null : document.querySelector(`label[for="${element.id}"]`)) ?? element;
      const box = measured.getBoundingClientRect();
      if (box.width <= 2 && box.height <= 2) continue;
      if (box.width < 43.5 || box.height < 43.5) {
        const name = element.getAttribute('aria-label') ?? (element.textContent ?? '').trim().slice(0, 30);
        small.push(`${element.tagName.toLowerCase()} “${name}”: ${Math.round(box.width)}×${Math.round(box.height)}`);
      }
    }
    return small;
  });
}

/**
 * The worst contrast of an element's text over its layers: each ancestor's background colour (and a material layer drawn behind the
 * content, such as Scene info's glass) up to the stage, composited over every wallpaper colour and the paper.
 */
function worstContrast(element: Locator, wallpaper: readonly string[]): Promise<number> {
  return element.evaluate((target, wall) => {
    type Rgba = [number, number, number, number];
    const parse = (value: string): Rgba | null => {
      const rgb = /rgba?\(([^)]+)\)/.exec(value);
      if (rgb !== null) {
        const parts = (rgb[1] ?? '').split(/[\s,/]+/).filter((part) => part !== '').map(Number);
        return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
      }
      const srgb = /color\(srgb ([^)]+)\)/.exec(value);
      if (srgb !== null) {
        const parts = (srgb[1] ?? '').split(/[\s/]+/).filter((part) => part !== '').map(Number);
        return [(parts[0] ?? 0) * 255, (parts[1] ?? 0) * 255, (parts[2] ?? 0) * 255, parts[3] ?? 1];
      }
      const hex = /#([0-9a-f]{6})\b/i.exec(value);
      if (hex !== null) {
        const digits = hex[1] ?? '000000';
        return [Number.parseInt(digits.slice(0, 2), 16), Number.parseInt(digits.slice(2, 4), 16), Number.parseInt(digits.slice(4, 6), 16), 1];
      }
      return null;
    };
    const over = (top: Rgba, below: Rgba): Rgba => [0, 1, 2].map((at) => (top[at] ?? 0) * top[3] + (below[at] ?? 0) * (1 - top[3])).concat(1) as Rgba;
    const luminance = (rgb: Rgba): number => {
      const [r, g, b] = [rgb[0], rgb[1], rgb[2]].map((channel) => {
        const c = channel / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: Rgba, b: Rgba): number => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };
    const layers: Rgba[] = [];
    for (let node: Element | null = target; node !== null; node = node.parentElement) {
      if (node.matches('[data-testid="modern-stage"]')) break;
      for (const child of node.children) {
        if (child.contains(target) || child.getAttribute('aria-hidden') !== 'true' || !/\bmat-/.test(child.className)) continue;
        const glass = parse(getComputedStyle(child).backgroundColor);
        if (glass !== null && glass[3] > 0) layers.push(glass);
      }
      const own = parse(getComputedStyle(node).backgroundColor);
      if (own !== null && own[3] > 0) layers.push(own);
      if (own !== null && own[3] >= 1) break;
    }
    const paper = parse(getComputedStyle(document.documentElement).getPropertyValue('--surface-page'));
    const backdrops = [...wall.map((hex) => parse(hex)), paper].filter((value): value is Rgba => value !== null);
    const fg = parse(getComputedStyle(target).color) ?? [0, 0, 0, 1];
    let worst = Number.POSITIVE_INFINITY;
    for (const backdrop of backdrops) {
      let background = backdrop;
      for (const layer of [...layers].reverse()) background = layer[3] >= 1 ? layer : over(layer, background);
      worst = Math.min(worst, ratio(over(fg, background), background));
    }
    return worst;
  }, wallpaper);
}

test.describe('the page (Write)', () => {
  test('Insert picture, Add footnote and the daily target are 44 px in Modern, and keep their size in Classic', async ({ page }) => {
    await sceneInClassic(page);
    const toolbar = page.getByRole('toolbar', { name: 'Insert into the scene' });
    const footer = page.locator('footer.editor-status');
    const target = footer.getByRole('button', { name: /words today/ });
    const controls = (): Record<string, Locator> => ({
      'Insert picture': toolbar.getByRole('button', { name: 'Insert picture' }),
      'Add footnote': footer.getByRole('button', { name: 'Add footnote' }),
      'the daily target': target,
    });
    // Classic: the same controls, as they were (Classic's 24 px pointer target, not Modern's 44).
    for (const [what, control] of Object.entries(controls())) {
      expect((await boxOf(control)).height, `${what} in Classic`).toBeLessThan(44);
    }

    await switchToModern(page);
    await settle(page);
    // The footer stays on the page: Scene info › Progress has the target and the save state, not the word count or Add footnote.
    await expect(page.locator('#modern-page footer.editor-status')).toBeVisible();
    for (const [what, control] of Object.entries(controls())) await expectTarget(control, what);
    expect(await smallControls(page.locator('#modern-page .editor-toolbar'))).toEqual([]);
    expect(await smallControls(page.locator('#modern-page footer.editor-status'))).toEqual([]);

    // The target's own form, open: its field and buttons too.
    await target.click();
    const form = footer.locator('form.target-quick-set');
    await expect(form).toBeVisible();
    expect(await smallControls(form)).toEqual([]);
  });
});

test.describe('Scene info', () => {
  for (const scheme of SCHEMES) {
    test(`${scheme}: every field, picker and button is 44 px, and the field notes keep 4.5:1 on the glass`, async ({ page }) => {
      await sceneInClassic(page, scheme);
      await switchToModern(page);
      const dialog = await openSceneInfo(page);
      // Open every disclosure, the nested ones too, so every field the inspector has is measured. Each summary is activated in the
      // page (its own click, so the inspector's toggle handlers run) rather than by a pointer: WebKit scrolls the body's lower
      // disclosures past the viewport's edge while the one above it opens, and the measure needs them open, not on screen.
      for (let round = 0; round < 4; round += 1) {
        const opened = await dialog.evaluate((root) => {
          const closed = [...root.querySelectorAll<HTMLElement>('details:not([open]) > summary')];
          for (const summary of closed) summary.click();
          return closed.length;
        });
        if (opened === 0) break;
        await settle(page);
      }
      await expect(dialog.locator('details:not([open])')).toHaveCount(0);
      await settle(page);
      expect(await smallControls(dialog)).toEqual([]);

      const notes = dialog.locator('.field-note');
      expect(await notes.count(), 'the inspector shows field notes').toBeGreaterThan(0);
      for (const note of await notes.all()) {
        if (!(await note.isVisible())) continue;
        const worst = await worstContrast(note, WALLPAPER[scheme]);
        expect(worst, `“${((await note.textContent()) ?? '').slice(0, 40)}”`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  test('the project’s line names the project and opens Project details (§7.1)', async ({ page }) => {
    await sceneInClassic(page);
    await switchToModern(page);
    const dialog = await openSceneInfo(page);
    const project = dialog.getByRole('button', { name: 'Project Gaps Book', exact: true });
    await expect(project).toBeVisible();
    await expectTarget(project, 'the project line');
    await project.click();
    await expect(page.locator('dialog.project-dialog')).toBeVisible();
  });
});

test.describe('the agent window', () => {
  for (const scheme of SCHEMES) {
    test(`${scheme}: sections are h3 under the window's h2, Close keeps 4.5:1 on the glass, Mode and New task are 44 px`, async ({ page }) => {
      await sceneInClassic(page, scheme);
      // Classic's drawer keeps its h4 (its DOM does not change).
      const drawer = page.getByTestId('agent-panel');
      const hide = drawer.getByRole('button', { name: 'Hide the agent' });
      if (!(await hide.isVisible())) await drawer.getByRole('button', { name: 'Agent', exact: true }).click();
      await expect(drawer.getByRole('heading', { name: 'Recurring tasks', level: 4 })).toBeVisible();
      await hide.click();

      await switchToModern(page);
      const window = await openAgentWindow(page);
      await expect(window.getByRole('heading', { name: 'Agent', level: 2, exact: true })).toBeVisible();
      await expect(window.getByRole('heading', { name: 'Recurring tasks', level: 3 })).toBeVisible();
      await expect(window.getByRole('heading', { level: 4 })).toHaveCount(0);

      const close = window.getByRole('button', { name: 'Close', exact: true });
      expect(await worstContrast(close, WALLPAPER[scheme]), 'Close on the glass').toBeGreaterThanOrEqual(4.5);
      await expectTarget(close, 'Close');

      for (const radio of await window.getByRole('group', { name: 'Mode' }).getByRole('radio').all()) {
        const label = radio.locator('xpath=ancestor::label[1]');
        await expectTarget(label, `Mode ${(await label.textContent()) ?? ''}`);
      }
      await expectTarget(window.getByRole('button', { name: 'New task', exact: true }), 'New task');
      expect(await smallControls(window)).toEqual([]);
    });
  }
});

test.describe('the top ornament', () => {
  for (const scheme of SCHEMES) {
    test(`${scheme}: the save state sits on the scrim and keeps 4.5:1 on the thin glass`, async ({ page }) => {
      await sceneInClassic(page, scheme);
      await switchToModern(page);
      await settle(page);
      const state = page.getByTestId('modern-top-ornament').getByTestId('save-state');
      await expect(state).toBeVisible();
      expect(await worstContrast(state, WALLPAPER[scheme]), `“${(await state.textContent()) ?? ''}” on the thin glass`).toBeGreaterThanOrEqual(4.5);
    });
  }
});

/** A centre view, from the bottom ornament's View group. */
async function openView(page: Page, name: 'Board' | 'Codex'): Promise<void> {
  await page.getByTestId('modern-bottom-ornament').getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name, exact: true }).click();
  await settle(page);
}

test.describe('the Board and the Codex', () => {
  test('the Board’s New card and card size (S/M/L, in the top ornament) are 44 px', async ({ page }) => {
    await sceneInClassic(page);
    await switchToModern(page);
    await openView(page, 'Board');
    const board = page.locator('.corkboard');
    await expect(board).toBeVisible();
    const controls = board.locator('.corkboard-controls');
    await expectTarget(controls.getByRole('button', { name: 'New card', exact: true }), 'New card');
    // The card size is the top ornament's (§7.3); the page's copy is hidden.
    await expect(controls.getByRole('radiogroup', { name: 'Card size' })).toHaveCount(0);
    const sizes = page.getByTestId('modern-top-ornament').getByRole('radiogroup', { name: 'Card size' }).getByRole('radio');
    expect(await sizes.count(), 'the card sizes').toBe(3);
    for (const size of await sizes.all()) await expectTarget(size, `card size ${(await size.textContent()) ?? ''}`);
    expect(await smallControls(controls)).toEqual([]);
  });

  test('the Codex’s buttons, filter chips and search field are 44 px', async ({ page }) => {
    await sceneInClassic(page);
    await switchToModern(page);
    await openView(page, 'Codex');
    const codex = page.locator('.codex');
    await expect(codex).toBeVisible();
    await expectTarget(codex.getByRole('searchbox', { name: 'Search the codex' }), 'the search field');
    // The chips are in the Filter disclosure (#361); its summary is a target too.
    const filter = codex.locator('details.codex-filter > summary');
    await expectTarget(filter, 'the Filter disclosure');
    await filter.click();
    const chips = codex.locator('.codex-chips').getByRole('button');
    expect(await chips.count(), 'the filter chips').toBeGreaterThan(0);
    for (const chip of await chips.all()) await expectTarget(chip, `the chip ${(await chip.textContent()) ?? ''}`);
    const buttons = codex.locator('.button');
    expect(await buttons.count(), 'the Codex’s buttons').toBeGreaterThan(0);
    for (const button of await buttons.all()) if (await button.isVisible()) await expectTarget(button, `the button ${(await button.textContent()) ?? ''}`);
  });
});
