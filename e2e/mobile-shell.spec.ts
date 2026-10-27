import { expect, test, type Page } from '@playwright/test';

import { fakeEndpoint, planThenAnswer, useFakeEndpoint, type FakeReply } from './endpoint.js';
import { bodyOf, idOf, waitForSaved } from './support.js';

/**
 * The narrow layout (ui-modules §0.6, §1), below 960 px: one centre column, the binder rail as a drawer, the inspector as a bottom
 * sheet, the toolbar's other controls in a More menu, 44 px targets, and "Open on desktop" in place of the views a phone does not have.
 * The `mobile` and `mobile-iphone-size` projects run this file only, in Chromium with touch (playwright.config.ts). That is emulation of a
 * phone's size and input: it is not WebKit and not a device, so it says nothing about iOS Safari, the on-screen keyboard, selection
 * handles, IME or storage eviction on a real phone.
 */

const PHONE = { width: 375, height: 812 };
const TABLET = { width: 768, height: 1024 };

/** A project made from the projects screen, with the shell showing. The binder is in the drawer, so the shell's cue is its button. */
async function newProject(page: Page, name = 'Phone Book'): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(toggle(page, 'Binder')).toBeVisible();
  await waitForSaved(page);
}

/** The sample project, opened by the first-run card with its demo turn. */
async function openSample(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
  await expect(toggle(page, 'Binder')).toBeVisible();
  await expect(page.locator('.agent-report-text').first()).toBeVisible();
}

const toggle = (page: Page, name: 'Binder' | 'Inspector') => page.getByRole('button', { name, exact: true });
const more = (page: Page) => page.getByRole('button', { name: 'More', exact: true });
const tree = (page: Page) => page.getByRole('tree', { name: 'Binder' });
const sheetTitle = (page: Page) => page.getByRole('complementary', { name: 'Inspector' });

async function openDrawer(page: Page): Promise<void> {
  await toggle(page, 'Binder').click();
  await expect(tree(page)).toBeVisible();
}

async function openMenuItem(page: Page, name: string | RegExp): Promise<void> {
  await more(page).click();
  await page.getByRole('menuitem', { name }).click();
}

/** A chapter and a scene made in the drawer, then the drawer closed by choosing the scene. */
async function sceneInDrawer(page: Page, title: string): Promise<void> {
  await openDrawer(page);
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill(title);
  await page.keyboard.press('Enter');
  await tree(page).locator('.row-title', { hasText: title }).tap();
  await expect(tree(page)).toBeHidden();
}

/** Whether the page scrolls sideways: its scroll width is more than the width it is shown in. */
async function sidewaysOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

/**
 * The controls on screen smaller than 44 by 44 px, one line each. A checkbox or a radio is measured by its label, which is what a touch
 * lands on. Anything inert, hidden or off screen is not a target the writer can reach, and a link inside a sentence (an inline button) keeps its line.
 */
async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = [];
    const selector =
      'button, [role=tab], [role=radio], [role=menuitem], [role=menuitemradio], [role=treeitem], select, summary, textarea, input:not([type=hidden]):not([type=file])';
    for (const element of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      if (element.closest('[inert]') !== null || element.classList.contains('visually-hidden')) continue;
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      // A link in a sentence has text beside it in its parent, and keeps its line (WCAG 2.5.8, inline).
      const inSentence = [element.previousSibling, element.nextSibling].some((side) => side?.nodeType === Node.TEXT_NODE && (side.textContent ?? '').trim() !== '');
      if (inSentence) continue;
      const label = element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio') ? element.closest('label') : null;
      const box = (label ?? element).getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.right < 0 || box.left > window.innerWidth || box.bottom < 0 || box.top > window.innerHeight) continue;
      if (box.width < 43.5 || box.height < 43.5) {
        const name = element.getAttribute('aria-label') ?? element.textContent ?? '';
        found.push(`${element.tagName.toLowerCase()}.${element.className} "${name.trim().slice(0, 40)}" ${Math.round(box.width)}x${Math.round(box.height)}`);
      }
    }
    return found;
  });
}

test.describe('the shell at 375 and 768 px', () => {
  for (const size of [PHONE, TABLET]) {
    test(`the page does not scroll sideways at ${size.width} px, on the projects screen or in the shell, with either panel open`, async ({ page }) => {
      await page.setViewportSize(size);
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'No projects here yet' })).toBeVisible();
      expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0);

      await newProject(page);
      expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0);
      await openDrawer(page);
      expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0);
      await page.getByRole('button', { name: 'Close panels' }).click();
      await toggle(page, 'Inspector').click();
      await expect(page.getByRole('button', { name: 'Close inspector' })).toBeVisible();
      expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0);
    });
  }

  test('the shell fills the screen: no minimum width, and the toolbar is the page width', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await newProject(page);
    const toolbar = await page.locator('.toolbar').boundingBox();
    expect(toolbar?.width).toBe(PHONE.width);
    const workspace = await page.locator('.workspace').boundingBox();
    expect(workspace?.width).toBe(PHONE.width);
    expect(workspace?.height).toBeCloseTo(PHONE.height, 0);
  });

  test('a wide window is the desktop shell again: no drawer, no More menu, both side panels shown', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await newProject(page);
    await expect(more(page)).toBeVisible();
    await page.setViewportSize({ width: 960, height: 720 });
    await expect(more(page)).toHaveCount(0);
    await expect(toggle(page, 'Binder')).toHaveCount(0);
    await expect(tree(page)).toBeVisible();
    await expect(sheetTitle(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Compile…' })).toBeVisible();
  });
});

test.describe('the binder drawer', () => {
  test('it is out of the page while closed, opens from the toolbar into its tabs, and closes by its button, the scrim and Escape', async ({ page }) => {
    await newProject(page);
    await expect(tree(page)).toBeHidden();
    await expect(toggle(page, 'Binder')).toHaveAttribute('aria-expanded', 'false');

    // Opened: focus is inside the drawer, on the selected tab, and the page behind it is not reachable.
    await toggle(page, 'Binder').click();
    await expect(tree(page)).toBeVisible();
    await expect(toggle(page, 'Binder')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('tab', { name: 'Binder' })).toBeFocused();
    await expect(page.locator('main.center')).toHaveAttribute('inert', '');

    // Its button.
    await page.getByRole('button', { name: 'Close panels' }).click();
    await expect(tree(page)).toBeHidden();
    await expect(toggle(page, 'Binder')).toBeFocused();
    await expect(page.locator('main.center')).not.toHaveAttribute('inert', '');

    // The scrim.
    await toggle(page, 'Binder').click();
    await expect(tree(page)).toBeVisible();
    await page.getByTestId('panel-scrim').click({ position: { x: PHONE.width - 10, y: 400 } });
    await expect(tree(page)).toBeHidden();
    await expect(toggle(page, 'Binder')).toBeFocused();

    // Escape, from the keyboard.
    await toggle(page, 'Binder').focus();
    await page.keyboard.press('Enter');
    await expect(tree(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(tree(page)).toBeHidden();
    await expect(toggle(page, 'Binder')).toBeFocused();
  });

  test('the drawer’s five tabs, the Trace tab among them, are reached by the arrow keys', async ({ page }) => {
    await newProject(page);
    await openDrawer(page);
    await expect(page.getByRole('tab')).toHaveText([/Binder/, /Codex/, /Activity/, /Trace/, /Findings/]);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Trace' })).toBeFocused();
    await expect(page.getByRole('tab', { name: 'Trace' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('trace-panel')).toBeVisible();
  });

  test('choosing a scene closes the drawer on it, and a chapter chosen to add under keeps the writer’s page', async ({ page }) => {
    await newProject(page);
    await openDrawer(page);
    await page.getByRole('button', { name: 'Create Chapter 1' }).click();
    // A chapter is chosen with the drawer open, and the centre keeps the editor rather than turning into the corkboard notice.
    await tree(page).locator('.row-title', { hasText: 'Chapter 1' }).tap();
    await expect(tree(page)).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Editor' })).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).tap();
    await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('Landing');
    await page.keyboard.press('Enter');
    // Naming a scene leaves the drawer open: choosing it is what closes it.
    await expect(tree(page)).toBeVisible();
    await tree(page).locator('.row-title', { hasText: 'Landing' }).tap();
    await expect(tree(page)).toBeHidden();
    await expect(page.getByRole('textbox', { name: 'Document text' })).toBeVisible();
  });

  test('a row’s Actions button opens its menu, where a phone has no right click, and Rename works from it', async ({ page }) => {
    await newProject(page);
    await openDrawer(page);
    await page.getByRole('button', { name: 'Create Chapter 1' }).click();
    await page.getByRole('button', { name: 'Actions for Chapter 1' }).tap();
    const menu = page.getByRole('menu', { name: 'Actions for Chapter 1' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'New screenplay scene here' })).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Rename' }).tap();
    await page.getByRole('textbox', { name: 'Rename Chapter 1' }).fill('The Crossing');
    await page.keyboard.press('Enter');
    await expect(tree(page).locator('.row-title', { hasText: 'The Crossing' })).toBeVisible();
  });
});

test.describe('the inspector sheet', () => {
  test('it rises from the bottom, takes focus, and closes by its button, the scrim and Escape', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await newProject(page);
    await sceneInDrawer(page, 'Opening');
    await expect(sheetTitle(page)).toBeHidden();

    await toggle(page, 'Inspector').click();
    await expect(sheetTitle(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close inspector' })).toBeFocused();
    // The sheet slides in: its bottom edge is the screen's once the slide has ended.
    await expect
      .poll(async () => {
        const sheet = await page.locator('#narrow-sheet').boundingBox();
        return Math.round((sheet?.y ?? 0) + (sheet?.height ?? 0));
      })
      .toBe(PHONE.height);
    expect((await page.locator('#narrow-sheet').boundingBox())?.width).toBe(PHONE.width);
    await expect(sheetTitle(page).getByRole('heading', { name: 'Opening', level: 2 })).toBeVisible();

    await page.getByRole('button', { name: 'Close inspector' }).click();
    await expect(sheetTitle(page)).toBeHidden();
    await expect(toggle(page, 'Inspector')).toBeFocused();

    await toggle(page, 'Inspector').click();
    await page.getByTestId('panel-scrim').click({ position: { x: 187, y: 20 } });
    await expect(sheetTitle(page)).toBeHidden();

    await toggle(page, 'Inspector').click();
    await page.keyboard.press('Escape');
    await expect(sheetTitle(page)).toBeHidden();
    await expect(toggle(page, 'Inspector')).toBeFocused();
  });

  test('the drawer and the sheet are never open together, and Edit synopsis opens the sheet with the field focused', async ({ page }) => {
    await newProject(page);
    await sceneInDrawer(page, 'Opening');
    await openDrawer(page);
    await page.getByRole('button', { name: 'Actions for Opening' }).tap();
    await page.getByRole('menuitem', { name: 'Edit synopsis' }).tap();
    await expect(sheetTitle(page)).toBeVisible();
    await expect(tree(page)).toBeHidden();
    await expect(page.locator('#inspector-synopsis')).toBeFocused();
    await page.keyboard.type('A ferry, late.');
    await page.getByRole('button', { name: 'Close inspector' }).click();
    await toggle(page, 'Inspector').click();
    await expect(page.locator('#inspector-synopsis')).toHaveValue('A ferry, late.');
  });
});

test.describe('the toolbar', () => {
  test('it is the two panel buttons, the save state under the name, and a More menu that the keyboard operates', async ({ page }) => {
    await newProject(page, 'Phone Book');
    await expect(page.getByRole('heading', { name: 'Phone Book', level: 1 })).toBeVisible();
    await expect(page.getByTestId('save-state')).toBeVisible();
    await expect(page.locator('.toolbar').getByRole('button')).toHaveText(['Binder', 'Inspector', 'More']);

    await more(page).focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu', { name: 'More' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Projects',
      'Project details',
      'Undo',
      'Focus mode',
      'Skills',
      'Instructions',
      'Compile…',
      'Export bundle',
      'Save to folder',
      'Settings',
      'Dark theme',
    ]);
    // Undo has nothing to undo in a new project, so it is disabled, and the arrow keys skip it.
    await expect(menu.getByRole('menuitem', { name: 'Undo' })).toBeDisabled();
    await expect(menu.getByRole('menuitem', { name: 'Projects' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Project details' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(more(page)).toBeFocused();

    await openMenuItem(page, 'Settings');
    await expect(page.getByTestId('settings')).toBeVisible();
  });

  test('focus mode keeps the page and the way out: the panel buttons go, and the menu offers to leave', async ({ page }) => {
    await newProject(page);
    await sceneInDrawer(page, 'Opening');
    await page.getByRole('textbox', { name: 'Document text' }).fill('Still here after focus.');
    await waitForSaved(page);

    await openMenuItem(page, 'Focus mode');
    await expect(toggle(page, 'Binder')).toHaveCount(0);
    await expect(toggle(page, 'Inspector')).toHaveCount(0);
    await expect(page.getByTestId('agent-panel')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Document text' })).toHaveText('Still here after focus.');

    await openMenuItem(page, 'Leave focus mode');
    await expect(toggle(page, 'Binder')).toBeVisible();
    await expect(toggle(page, 'Inspector')).toBeVisible();
  });

  test('Projects in the menu leaves the project, and Export bundle downloads a bundle', async ({ page }) => {
    await newProject(page, 'Leaving Book');
    const download = page.waitForEvent('download');
    await openMenuItem(page, 'Export bundle');
    expect((await download).suggestedFilename()).toBe('Leaving Book.caotang');
    await openMenuItem(page, 'Projects');
    await expect(page.getByRole('heading', { name: 'Projects in this browser' })).toBeVisible();
  });
});

test.describe('touch targets', () => {
  test('every control on screen is at least 44 by 44 px: the shell, both panels, the menu, the agent drawer and the dialogs', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await newProject(page);
    expect(await smallTargets(page)).toEqual([]);

    await openDrawer(page);
    await page.getByRole('button', { name: 'Create Chapter 1' }).click();
    expect(await smallTargets(page)).toEqual([]);
    for (const tab of ['Codex', 'Activity', 'Trace', 'Findings', 'Binder']) {
      await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
      expect(await smallTargets(page), tab).toEqual([]);
    }
    await tree(page).locator('.row-title', { hasText: 'Chapter 1' }).tap();
    await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).tap();
    await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('Opening');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Actions for Opening' }).tap();
    expect(await smallTargets(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await tree(page).locator('.row-title', { hasText: 'Opening' }).tap();

    expect(await smallTargets(page)).toEqual([]);
    await toggle(page, 'Inspector').click();
    expect(await smallTargets(page)).toEqual([]);
    await page.getByRole('button', { name: 'Close inspector' }).click();

    await more(page).click();
    expect(await smallTargets(page)).toEqual([]);
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    expect(await smallTargets(page)).toEqual([]);

    await openMenuItem(page, 'Compile…');
    await expect(page.getByRole('dialog', { name: 'Export' })).toBeVisible();
    expect(await smallTargets(page)).toEqual([]);
    await page.keyboard.press('Escape');

    await openMenuItem(page, 'Settings');
    await expect(page.getByTestId('settings')).toBeVisible();
    for (const section of ['Providers', 'Writing', 'MCP & tools', 'Data']) {
      await page.getByTestId('settings').getByRole('button', { name: section }).click();
      expect(await smallTargets(page), section).toEqual([]);
    }
  });

  test('the projects screen’s controls are 44 px too', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Create project' })).toBeVisible();
    expect(await smallTargets(page)).toEqual([]);
  });
});

test.describe('writing on a touch screen', () => {
  test('a scene is opened by a tap, written in and saved, and is still there after a reload', async ({ page }) => {
    await newProject(page, 'Touch Book');
    await sceneInDrawer(page, 'The Ferry');
    const field = page.getByRole('textbox', { name: 'Document text' });
    await field.tap();
    await page.keyboard.type('The ferry was late, as always.');
    await waitForSaved(page);
    const id = await idOf(page, 'The Ferry');
    expect(await bodyOf(page, id)).toContain('The ferry was late, as always.');

    await page.reload();
    const row = page.getByRole('listitem').filter({ hasText: 'Touch Book' });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Open' }).tap();
    await openDrawer(page);
    await tree(page).locator('.row-title', { hasText: 'The Ferry' }).tap();
    await expect(field).toContainText('The ferry was late, as always.');
  });

  test('the storage banner says what a phone’s browser may do, and Export a backup is one tap away', async ({ page }) => {
    await page.addInitScript(() => {
      const storage = navigator.storage;
      if (storage === undefined) return;
      const proto = Object.getPrototypeOf(storage) as Record<string, unknown>;
      proto['persisted'] = async () => false;
      proto['persist'] = async () => false;
    });
    await newProject(page);
    const banner = page.getByTestId('storage-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('A phone or tablet clears browser storage sooner than a computer');
    await expect(banner).toContainText('nothing syncs yet');
    const download = page.waitForEvent('download');
    await banner.getByRole('button', { name: 'Export a backup' }).tap();
    await download;
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(banner).not.toContainText('phone');
  });
});

test.describe('what a phone leaves to a desktop', () => {
  /** The notice a view shows in place of itself, found by its feature. */
  const notice = (page: Page, feature: string) => page.locator(`[data-testid="open-on-desktop"][data-feature="${feature}"]`);

  /** A node made from the Actions menu of the chapter, as the media specs make theirs from the context menu. */
  async function makeUnderChapter(page: Page, item: string): Promise<void> {
    await openDrawer(page);
    await page.getByRole('button', { name: 'Create Chapter 1' }).click();
    await page.getByRole('button', { name: 'Actions for Chapter 1' }).tap();
    await page.getByRole('menuitem', { name: item }).tap();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Close panels' }).click();
  }

  test('the corkboard says Open on desktop, in words, with a way back to the editor', async ({ page }) => {
    await newProject(page);
    await page.getByRole('radio', { name: 'Corkboard' }).tap();
    const corkboard = notice(page, 'corkboard');
    await expect(corkboard).toBeVisible();
    await expect(corkboard.getByRole('heading', { name: 'Open on desktop: the corkboard' })).toBeVisible();
    await expect(corkboard).toContainText('narrower than 960 px');
    await expect(page.locator('.corkboard')).toHaveCount(0);
    await corkboard.getByRole('button', { name: 'Back to the editor' }).tap();
    await expect(corkboard).toHaveCount(0);
    await expect(page.getByRole('radio', { name: 'Editor' })).toHaveAttribute('aria-checked', 'true');
  });

  test('a storyboard says Open on desktop in place of its board, and the drawer is one button away', async ({ page }) => {
    await newProject(page);
    await makeUnderChapter(page, 'New storyboard here');
    const storyboard = notice(page, 'storyboard');
    await expect(storyboard).toBeVisible();
    await expect(storyboard.getByRole('heading', { name: 'Open on desktop: the storyboard' })).toBeVisible();
    await expect(page.locator('article.sb-card')).toHaveCount(0);
    await storyboard.getByRole('button', { name: 'Open the binder' }).tap();
    await expect(tree(page)).toBeVisible();
  });

  test('a dialogue container says Open on desktop in place of its branch graph', async ({ page }) => {
    await newProject(page);
    await makeUnderChapter(page, 'New dialogue here');
    const dialogue = notice(page, 'dialogue');
    await expect(dialogue).toBeVisible();
    await expect(dialogue.getByRole('heading', { name: 'Open on desktop: the dialogue branch graph' })).toBeVisible();
    await expect(page.getByRole('region', { name: /^Branch graph/ })).toHaveCount(0);
    await expect(page.getByLabel('Branch graph', { exact: true })).toHaveCount(0);
  });

  test('a screenplay scene writes in Script and Source, and its Pages view says Open on desktop', async ({ page }) => {
    await newProject(page);
    await makeUnderChapter(page, 'New screenplay scene here');
    const scene = page.getByRole('region', { name: 'Screenplay: Untitled scene' });
    await expect(scene).toBeVisible();
    await scene.getByRole('radio', { name: 'Source' }).tap();
    await expect(page.getByRole('textbox', { name: 'Fountain source' })).toBeVisible();
    await scene.getByRole('radio', { name: 'Pages' }).tap();
    const pages = notice(page, 'screenplay-pages');
    await expect(pages).toBeVisible();
    await expect(pages.getByRole('heading', { name: 'Open on desktop: the screenplay Pages view' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Fountain source' })).toHaveCount(0);
    await pages.getByRole('button', { name: 'Show the script' }).tap();
    await expect(scene.getByRole('radio', { name: 'Script' })).toHaveAttribute('aria-checked', 'true');
  });

  test('Settings › MCP & tools says Open on desktop, and the other sections work', async ({ page }) => {
    await newProject(page);
    await openMenuItem(page, 'Settings');
    const settings = page.getByTestId('settings');
    await settings.getByRole('button', { name: 'MCP & tools' }).click();
    await expect(notice(page, 'mcp')).toBeVisible();
    await expect(settings.getByRole('heading', { name: 'Open on desktop: MCP & tools' })).toBeVisible();
    await settings.getByRole('button', { name: 'Writing' }).click();
    await expect(notice(page, 'mcp')).toHaveCount(0);
    await expect(settings.getByRole('button', { name: 'Save writing settings' })).toBeVisible();
  });

  test('the Export dialog offers Markdown and plain text, names the rest as Open on desktop, and Markdown compiles', async ({ page }) => {
    await newProject(page);
    await sceneInDrawer(page, 'Opening');
    await page.getByRole('textbox', { name: 'Document text' }).tap();
    await page.keyboard.type('The ferry was late.');
    await waitForSaved(page);
    await openMenuItem(page, 'Compile…');
    const dialog = page.getByRole('dialog', { name: 'Export' });
    await expect(dialog.getByRole('radio')).toHaveCount(4);
    await expect(dialog.getByRole('radio', { name: /^Markdown/ })).toBeChecked();
    await expect(dialog.getByRole('radio', { name: /^Plain text/ })).toBeVisible();
    await expect(dialog.getByRole('radio', { name: /Word|EPUB|PDF|Final Draft|Fountain/ })).toHaveCount(0);
    await expect(notice(page, 'exports')).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Open on desktop: the other export formats' })).toBeVisible();

    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: /^Compile/ }).tap();
    expect((await download).suggestedFilename()).toMatch(/\.md$/);
  });
});

test.describe('what the base keeps reachable at this width', () => {
  test('the Export Preview fits the dialog and says what the compile will hold', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await newProject(page);
    await sceneInDrawer(page, 'The Landing');
    await page.getByRole('textbox', { name: 'Document text' }).tap();
    await page.keyboard.type('The boat came in with the tide.');
    await waitForSaved(page);
    await openMenuItem(page, 'Compile…');
    const dialog = page.getByRole('dialog', { name: 'Export' });
    const preview = dialog.getByRole('group', { name: 'Preview' });
    await preview.scrollIntoViewIfNeeded();
    await expect(preview).toBeVisible();
    await expect(dialog.getByRole('region', { name: 'What will be compiled' })).toContainText('The Landing');
    const box = await dialog.getByRole('region', { name: 'What will be compiled' }).boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(PHONE.width);
    expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0);
    // Keyboard: Escape closes the dialog and focus returns to the control that opened it.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('the Trace tab shows a demo turn in the drawer and a turn opens from the keyboard', async ({ page }) => {
    await openSample(page);
    await openDrawer(page);
    await page.getByRole('tab', { name: 'Trace' }).click();
    await expect(page.getByTestId('trace-panel')).toBeVisible();
    const turn = page.getByTestId('trace-turn').first();
    await expect(turn).toBeVisible();
    const head = turn.getByRole('button', { expanded: true });
    await head.focus();
    await page.keyboard.press('Enter');
    await expect(turn.getByRole('button', { expanded: false })).toBeVisible();
    const box = await page.getByTestId('trace-panel').boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(PHONE.width + 1);
  });

  test('the command menu opens under the Intent box and fits, its options are 44 px, and the keys choose', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openSample(page);
    const box = page.getByRole('combobox', { name: 'Intent' });
    await box.tap();
    await page.keyboard.type('/');
    const list = page.getByRole('listbox', { name: 'Commands' });
    await expect(list).toBeVisible();
    const options = list.getByRole('option');
    await expect(options).toHaveCount(9);
    const first = await options.first().boundingBox();
    expect(first?.height).toBeGreaterThanOrEqual(43.5);
    const frame = await list.boundingBox();
    expect(frame?.x).toBeGreaterThanOrEqual(0);
    expect((frame?.x ?? 0) + (frame?.width ?? 0)).toBeLessThanOrEqual(PHONE.width);
    await page.keyboard.type('s');
    await expect(options).toHaveCount(2);
    await page.keyboard.press('ArrowDown');
    await expect(list.getByRole('option', { name: /\/scan/ })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Tab');
    await expect(box).toHaveValue('/scan ');
    await page.keyboard.press('Escape');
    expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0);
  });
});

/** A fake model that counts its calls and answers with a plain reply (as e2e/recurring-tasks.spec.ts does). */
function countingReply(counter: { calls: number }): FakeReply {
  return (request) => {
    counter.calls += 1;
    return request.tools !== undefined ? { text: 'Looked it over.' } : JSON.stringify({ reply: 'Looked it over.' });
  };
}

test('a task that is due is offered above the closed agent drawer, with Run now and Skip a keyboard and a tap away', async ({ page }) => {
  const counter = { calls: 0 };
  await fakeEndpoint(page, countingReply(counter));
  await useFakeEndpoint(page);
  await newProject(page, 'Offer Book');
  await sceneInDrawer(page, 'Opening');
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await page.getByRole('button', { name: 'New task' }).click();
  const form = page.getByRole('form', { name: 'New task' });
  await form.getByLabel('Task name').fill('Daily read');
  await form.getByLabel('What it does').selectOption({ label: 'Ask the agent' });
  await form.getByLabel('What to ask').fill('Look over the newest scene.');
  await form.getByLabel('When', { exact: true }).selectOption({ label: 'Every day' });
  await form.getByLabel('From').fill('00:00');
  await form.getByLabel('When it is due').selectOption({ label: 'Offer it to me' });
  await form.getByRole('button', { name: 'Save task' }).click();
  await expect(page.getByTestId('recurring-tasks').locator('[data-task]', { hasText: 'Daily read' })).toBeVisible();

  await waitForSaved(page);
  await page.reload();
  const row = page.getByRole('listitem').filter({ hasText: 'Offer Book' });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole('button', { name: 'Open' }).tap();
  await expect(toggle(page, 'Binder')).toBeVisible();

  const offer = page.getByTestId('task-offers').getByRole('group', { name: 'Task due: Daily read' });
  await expect(offer).toBeVisible({ timeout: 20_000 });
  expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0);
  for (const name of ['Run now', 'Skip']) {
    const button = await offer.getByRole('button', { name }).boundingBox();
    expect(button?.height, name).toBeGreaterThanOrEqual(43.5);
    expect((button?.x ?? 0) + (button?.width ?? 0), name).toBeLessThanOrEqual(PHONE.width);
  }
  await offer.getByRole('button', { name: 'Skip' }).focus();
  await page.keyboard.press('Enter');
  await expect(offer).toHaveCount(0);
  expect(counter.calls).toBe(0);
});

test.describe('review marks', () => {
  const BEFORE = 'The harbour was quiet and the tide was slow.';
  const REWRITE = 'The harbour was silent and the tide was late.';
  const PLAN = {
    steps: [
      {
        tool: 'scene.draft',
        params: {
          doc: 'The Friend',
          instruction: 'Reword the sentence.',
          mode: 'rewrite_selection',
          selection: { from: 0, to: BEFORE.length, exact: BEFORE, prefix: '', suffix: '', capturedRevision: 0 },
        },
        expect: 'The Friend is reworded',
      },
    ],
  };

  test('an applied rewrite is marked, and the review bar’s buttons are on the page, 44 px, and keyboard operable', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await fakeEndpoint(page, planThenAnswer(PLAN, 'Reworded.', REWRITE));
    await useFakeEndpoint(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByTestId('settings');
    await settings.getByRole('button', { name: 'Writing' }).click();
    await settings.getByRole('combobox', { name: 'When you apply an agent edit' }).selectOption('suggestions');
    await settings.getByRole('button', { name: 'Save writing settings' }).click();
    await expect(settings.getByText(/Saved\./)).toBeVisible();
    await settings.getByRole('button', { name: 'Close' }).click();

    await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
    await expect(toggle(page, 'Binder')).toBeVisible();
    await openDrawer(page);
    await tree(page).locator('.row-title', { hasText: 'The Friend' }).tap();
    await expect(tree(page)).toBeHidden();
    await page.getByRole('textbox', { name: 'Document text' }).tap();
    await page.keyboard.type(BEFORE);
    await waitForSaved(page);
    await page.keyboard.press('Control+A');
    const friend = await idOf(page, 'The Friend');

    const field = page.getByRole('combobox', { name: 'Intent' });
    await expect(field).toBeEnabled();
    await field.fill('Reword the sentence in The Friend.');
    await page.getByRole('button', { name: 'Send', exact: true }).tap();
    await expect(page.getByTestId('ghost-bar')).toContainText('The Friend');
    await page.getByTestId('plan-card').getByRole('button', { name: 'Approve', exact: true }).tap();
    await expect(page.getByTestId('checkpoint')).toBeVisible();

    const bar = page.getByTestId('review-bar');
    await expect(bar).toContainText('2 suggestions pending review');
    const surface = page.getByRole('textbox', { name: 'Document text' });
    await expect(surface.locator('del')).toContainText(['quiet', 'slow']);
    await expect(surface.locator('ins')).toContainText(['silent', 'late']);
    expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0);

    for (const name of ['Next', 'Reject', 'Accept all']) {
      const button = await bar.getByRole('button', { name, exact: true }).boundingBox();
      expect(button?.height, name).toBeGreaterThanOrEqual(43.5);
      expect(button?.width, name).toBeGreaterThanOrEqual(43.5);
      expect((button?.x ?? 0) + (button?.width ?? 0), name).toBeLessThanOrEqual(PHONE.width);
    }

    // The keyboard: Next selects a change, Reject puts its word back, and Accept all keeps the rest. Which change Next reaches first
    // depends on where the editor's caret is when the key lands, so the test reads which one it got.
    await surface.press('Control+Home');
    await bar.getByRole('button', { name: 'Next', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(bar).toContainText(/· \d of 2/);
    await bar.getByRole('button', { name: 'Reject', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(bar).toContainText('1 suggestion pending review');
    await expect
      .poll(async () => (await bodyOf(page, friend)) ?? '')
      .toMatch(/^The harbour was (quiet and the tide was late|silent and the tide was slow)\.\n$/);
    await bar.getByRole('button', { name: 'Accept all', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(bar).toHaveCount(0);
  });
});
