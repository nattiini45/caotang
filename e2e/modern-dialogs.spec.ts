import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

import { ZIP_ENGINE } from '../packages/store/src/index.js';

import { NO_PIN } from './classic-pin.js';
import { binderTitle, waitForSaved } from './support.js';

/**
 * Modern's dialogs, menus, notices and projects screen (M10, #311; modern-interface.md §6, §7.6, §8.2, §8.3, §8.6, §9.5): in Modern
 * every dialog is Classic's own component in sheet glass, grows out of the control that opened it, keeps Classic's focus handling
 * (focus inside while open, back on the opener after), and every control in it is at least 44 px; context menus are glass with 44 px
 * rows; the status line is a toast at the top centre; Home is on the wallpaper with its sections on paper. axe checks each surface for
 * the rules it can judge through glass (contrast on glass is computed in e2e/unit/modern-surfaces.spec.ts, §9.3).
 *
 * These specs run Modern, so they start without the suite's Classic pin.
 */

test.use({ storageState: NO_PIN, bypassCSP: true });

const require = createRequire(import.meta.url);
const AXE = require.resolve('axe-core');

/** The axe rules a Modern surface is held to here; colour contrast on glass is the computed test's (§9.3). */
const AXE_RULES = ['target-size', 'aria-allowed-role', 'aria-dialog-name', 'button-name', 'label', 'select-name'] as const;

/** Records every Web Animations call, so the morph can be checked without racing it. */
async function start(page: Page, options: { reducedMotion?: boolean } = {}): Promise<void> {
  if (options.reducedMotion === true) await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const store = globalThis as unknown as {
      localStorage: Storage;
      __animations?: { tag: string; first: string }[];
    };
    store.localStorage.setItem('caotang.interface', 'modern');
    store.__animations = [];
    const original = Element.prototype.animate;
    Element.prototype.animate = function animate(this: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes | null, timing?: number | KeyframeAnimationOptions) {
      const frames = Array.isArray(keyframes) ? keyframes : [];
      store.__animations?.push({ tag: this.tagName.toLowerCase(), first: JSON.stringify(frames[0] ?? {}) });
      return original.call(this, keyframes, timing);
    };
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Projects in this browser' })).toBeVisible();
}

async function animations(page: Page): Promise<{ tag: string; first: string }[]> {
  return page.evaluate(() => (globalThis as unknown as { __animations?: { tag: string; first: string }[] }).__animations ?? []);
}

async function clearAnimations(page: Page): Promise<void> {
  await page.evaluate(() => {
    (globalThis as unknown as { __animations?: unknown[] }).__animations = [];
  });
}

/** Waits until nothing on the page is animating, so sizes are read at rest. */
async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
}

interface Material {
  readonly background: string;
  readonly backdrop: string;
  readonly radius: string;
}

function material(target: Locator): Promise<Material> {
  return target.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      backdrop: style.getPropertyValue('backdrop-filter') || style.getPropertyValue('-webkit-backdrop-filter'),
      radius: style.borderStartStartRadius,
    };
  });
}

function alphaOf(colour: string): number {
  const match = /rgba?\(([^)]*)\)/.exec(colour);
  if (match === null) return 1;
  const parts = (match[1] ?? '').split(/[\s,/]+/).filter((part) => part !== '');
  return parts.length < 4 ? 1 : Number.parseFloat(parts[3] ?? '1');
}

/** Glass: see-through and blurred, with the sheet's concentric corner. */
async function expectGlass(target: Locator, radius: string): Promise<void> {
  const look = await material(target);
  expect(alphaOf(look.background), `background ${look.background}`).toBeLessThan(1);
  expect(alphaOf(look.background)).toBeGreaterThan(0);
  expect(look.backdrop).toContain('blur(');
  expect(look.radius).toBe(radius);
}

/**
 * Every control inside `scope` that is under 44 px tall (§9.5): buttons, fields, menu items, tabs and links; a checkbox or radio is
 * measured with its label; a link or button inside a sentence keeps its line and is left out, as is a visually hidden file input.
 */
function undersized(scope: Locator): Promise<string[]> {
  return scope.evaluate((root) => {
    const out: string[] = [];
    for (const element of Array.from(root.querySelectorAll<HTMLElement>('button, select, input, textarea, a[href], [role="menuitem"], [role="menuitemradio"], [role="tab"]'))) {
      const rect = element.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      if (getComputedStyle(element).visibility === 'hidden') continue;
      if (element.closest('p') !== null && (element.matches('a, .status-link') || element.closest('button, a') !== null)) continue;
      const box = element.matches('input[type="checkbox"], input[type="radio"]') ? (element.closest('label') ?? element).getBoundingClientRect() : rect;
      if (box.height < 43.5) {
        const name = (element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 40);
        out.push(`${element.tagName.toLowerCase()} "${name}" ${box.height.toFixed(1)} px`);
      }
    }
    return out;
  });
}

async function axeProblems(page: Page, selector: string): Promise<string[]> {
  if (!(await page.evaluate(() => 'axe' in globalThis))) await page.addScriptTag({ path: AXE });
  return page.evaluate(
    async ({ scope, rules }) => {
      const axe = (globalThis as unknown as {
        axe: { run: (context: Element, options: unknown) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> };
      }).axe;
      const root = document.querySelector(scope);
      if (root === null) return [`no ${scope}`];
      const result = await axe.run(root, { runOnly: { type: 'rule', values: rules } });
      return result.violations.flatMap((violation) => violation.nodes.map((node) => `${violation.id}: ${node.target.join(' ')}`));
    },
    { scope: selector, rules: [...AXE_RULES] },
  );
}

/**
 * A dialog in Modern: glass, focus inside, every control 44 px, axe clean. A dialog that holds text to read (Export, Import) is an
 * opaque sheet with the same corner instead (#363).
 */
async function expectModernDialog(page: Page, dialog: Locator, selector: string, opaque = false): Promise<void> {
  await expect(dialog).toBeVisible();
  await settle(page);
  if (opaque) {
    const look = await material(dialog);
    expect(alphaOf(look.background), `background ${look.background}`).toBe(1);
    expect(look.radius).toBe('32px');
  } else await expectGlass(dialog, '32px');
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  expect(await undersized(dialog)).toEqual([]);
  expect(await axeProblems(page, selector)).toEqual([]);
}

/** The dialog grew out of its opener: its first keyframe moved and scaled it from elsewhere (§8.3). */
async function expectMorphed(page: Page): Promise<void> {
  const morphs = (await animations(page)).filter((call) => call.tag === 'dialog');
  expect(morphs.length).toBeGreaterThan(0);
  expect(morphs[0]?.first).toMatch(/translate\(.*scale\(/);
}

/** The Modern **More** / **⋯** menu, whichever ornament carries it. */
function moreButton(page: Page): Locator {
  return page.getByTestId('modern-stage').getByRole('button', { name: /^(More|⋯)$/ }).first();
}

async function openFromMore(page: Page, item: string): Promise<void> {
  await moreButton(page).click();
  await page.getByRole('menuitem', { name: item }).click();
}

/**
 * Opens the binder where Modern keeps it in a sidebar (#307's tab bar: the sidebar is closed and inert until **Manuscript** opens it).
 * With the provisional sidebar (before #307) the binder is always shown, so this does nothing.
 */
async function openBinder(page: Page): Promise<void> {
  if ((await page.getByTestId('modern-binder-bar').count()) === 0) return;
  if (await page.getByRole('tree', { name: 'Binder' }).isVisible()) return;
  await page.getByRole('navigation', { name: 'Binder' }).getByRole('button', { name: 'Binder', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
}

async function projectWithScene(page: Page, name: string): Promise<void> {
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByTestId('modern-stage')).toBeVisible();
  await openBinder(page);
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('The Landing');
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Document text' }).fill('The boat came in with the tide. Nobody was on it.');
  await waitForSaved(page);
}

test('Import and More disclosures dismiss without swallowing the next action or the sidebar’s Escape', async ({ page }) => {
  await start(page);
  await projectWithScene(page, 'Disclosure Book');
  await openBinder(page);
  const imports = page.locator('details.binder-import');
  const importSummary = imports.locator(':scope > summary');
  const filters = page.locator('details.filter-more');
  const filterSummary = filters.locator(':scope > summary');
  await importSummary.click();
  await imports.getByRole('button', { name: 'Import script', exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(imports).not.toHaveAttribute('open');
  await expect(importSummary).toBeFocused();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();

  await page.keyboard.press('Enter');
  await expect(imports).toHaveAttribute('open', '');
  const pin = page.getByRole('button', { name: 'Keep open', exact: true });
  await pin.click();
  await expect(imports).not.toHaveAttribute('open');
  await expect(pin).toHaveAttribute('aria-pressed', 'true');
  await filterSummary.click();
  await expect(filters).toHaveAttribute('open', '');
  const status = filters.getByRole('combobox', { name: 'Status filter' });
  await status.focus();
  await page.keyboard.press('Tab');
  await expect(filters).toHaveAttribute('open', '');
  const search = page.getByRole('searchbox', { name: 'Filter the binder by text' });
  await search.click();
  await expect(filters).not.toHaveAttribute('open');
  await expect(search).toBeFocused();

  await importSummary.click();
  const fdx = '<FinalDraft DocumentType="Script" Version="3"><Content><Paragraph Type="Scene Heading"><Text>INT. HARBOUR - NIGHT</Text></Paragraph></Content></FinalDraft>';
  await page.locator('input[type="file"][aria-label="Script file"]').setInputFiles({ name: 'harbour.fdx', mimeType: 'application/xml', buffer: Buffer.from(fdx) });
  const dialog = page.getByRole('dialog', { name: 'Import this Final Draft script?' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(imports).toHaveAttribute('open', '');
  await page.keyboard.press('Escape');
  await expect(imports).not.toHaveAttribute('open');
  await expect(importSummary).toBeFocused();
});

test('the Codex Filter dismisses on Escape and an outside click', async ({ page }) => {
  await start(page);
  await projectWithScene(page, 'Codex Disclosure Book');
  await page.getByRole('navigation', { name: 'Views and tools' }).getByRole('radio', { name: 'Codex', exact: true }).click();
  const filter = page.locator('details.codex-filter');
  const summary = filter.locator(':scope > summary');
  await summary.click();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Escape');
  await expect(filter).not.toHaveAttribute('open');
  await expect(summary).toBeFocused();
  await page.keyboard.press('Enter');
  await moreButton(page).click();
  await expect(filter).not.toHaveAttribute('open');
  await expect(page.getByRole('menu', { name: 'More', exact: true })).toBeVisible();
});

test('Classic keeps its permanently expanded More controls visible after outside actions and Escape', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('caotang.interface', 'classic'));
  await page.goto('/');
  await page.getByLabel('Project name').fill('Classic Disclosure Book');
  await page.getByRole('button', { name: 'Create project' }).click();
  const imports = page.locator('details.binder-import');
  await expect(imports.getByRole('button', { name: 'Import script', exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Filter the binder by text' }).click();
  await page.keyboard.press('Escape');
  await expect(imports).toHaveAttribute('open', '');
  await expect(imports.getByRole('button', { name: 'Import script', exact: true })).toBeVisible();
});

test('Home is on the wallpaper with its sections on paper, and every control on it is 44 px', async ({ page }) => {
  await start(page);
  const home = page.locator('.home');
  const look = await home.evaluate((element) => getComputedStyle(element).backgroundImage);
  expect(look).toMatch(/url\("?[^)]*wallpaper-light[^)]*\.svg"?\)/);

  const sections = page.locator('.home > .home-head, .home > .home-section');
  expect(await sections.count()).toBeGreaterThanOrEqual(3);
  for (const section of await sections.all()) {
    const paper = await material(section);
    expect(alphaOf(paper.background), 'a section is paper: opaque').toBe(1);
    expect(paper.backdrop === '' || paper.backdrop === 'none').toBe(true);
    expect(paper.radius).toBe('32px');
  }
  expect(await undersized(home)).toEqual([]);
  expect(await axeProblems(page, '.home')).toEqual([]);
});

test('Settings from Home: glass, grown out of its button, every one of the nine sections 44 px, focus back on Settings', async ({ page }) => {
  test.setTimeout(90_000);
  await start(page);
  const opener = page.getByTestId('open-settings');
  await clearAnimations(page);
  await opener.click();
  const settings = page.getByTestId('settings');
  await expect(settings.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
  await expectModernDialog(page, settings, '[data-testid="settings"]');
  await expectMorphed(page);

  const sections = settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button');
  await expect(sections).toHaveCount(9);
  for (const section of await sections.all()) {
    await section.click();
    await settle(page);
    expect(await undersized(settings), `section ${await section.textContent()}`).toEqual([]);
  }
  expect(await axeProblems(page, '[data-testid="settings"]')).toEqual([]);

  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('the More menu is glass with 44 px rows, and each dialog it opens is glass, keeps its focus and returns it', async ({ page }) => {
  test.setTimeout(120_000);
  await start(page);
  await projectWithScene(page, 'Harbour Book');

  await moreButton(page).click();
  const menu = page.getByRole('menu', { name: /^(More|⋯)$/ });
  await expect(menu).toBeVisible();
  await settle(page);
  // #306's ⋯ menu wears its glass on the popover around the menu (.modern-popover, the sheet radius); the menu inside is clear.
  await expectGlass(page.locator('.modern-popover').filter({ has: menu }), '32px');
  expect(await undersized(menu)).toEqual([]);
  const rows = await menu.getByRole('menuitem').all();
  for (const row of rows) expect((await row.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  const dialogs: readonly { item: string; dialog: Locator; selector: string; opaque?: boolean }[] = [
    { item: 'Project details', dialog: page.locator('dialog.project-dialog'), selector: 'dialog.project-dialog' },
    { item: 'Skills', dialog: page.getByRole('dialog', { name: /Skills/ }), selector: 'dialog.skills-dialog' },
    { item: 'Instructions', dialog: page.locator('dialog.skills-dialog'), selector: 'dialog.skills-dialog' },
    { item: 'Compile…', dialog: page.locator('dialog.export-dialog'), selector: 'dialog.export-dialog', opaque: true },
    { item: 'Settings', dialog: page.getByTestId('settings'), selector: '[data-testid="settings"]' },
  ];
  for (const { item, dialog, selector, opaque } of dialogs) {
    await clearAnimations(page);
    await openFromMore(page, item);
    await expectModernDialog(page, dialog.first(), selector, opaque);
    await expectMorphed(page);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    // dialog-focus.ts hands focus back to the control the dialog opened from: the menu's button.
    await expect(moreButton(page)).toBeFocused();
  }
});

test('a Confirm dialog is glass and grows out of the row; the status line that follows is a glass toast at the top centre', async ({ page }) => {
  await start(page);
  await projectWithScene(page, 'Harbour Book');
  // Where storage is not persisted (WebKit), the storage notice is a toast of its own above the status line; it is dismissed so the
  // status line is the one toast measured here.
  const banner = page.getByTestId('storage-banner');
  if (await banner.isVisible()) {
    await banner.getByRole('button', { name: 'Dismiss' }).click();
    await expect(banner).toBeHidden();
  }

  await openBinder(page);
  // Focus the row from the keyboard's side: a click would choose the scene, and choosing one closes an unpinned sidebar (#307).
  const row = page.getByRole('treeitem', { name: /The Landing/ });
  await row.focus();
  await clearAnimations(page);
  await page.keyboard.press('Delete');
  const confirm = page.getByRole('dialog', { name: 'Delete “The Landing”?' });
  await expectModernDialog(page, confirm, 'dialog.confirm[open]');
  await expectMorphed(page);
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expect(confirm.locator('.confirm-actions > button')).toHaveText(['Cancel', 'Delete']);
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click();

  const toast = page.getByTestId('modern-notices').getByRole('status').filter({ hasText: /Deleted/ });
  await expect(toast).toContainText(/Deleted “\u2068?The Landing\u2069?”/);
  await settle(page);
  await expectGlass(toast, '32px');
  expect(await undersized(page.getByTestId('modern-notices'))).toEqual([]);
  // At the top centre of the page, below the top ornament.
  const box = await toast.boundingBox();
  const sheet = await page.locator('#modern-page').boundingBox();
  expect(box).not.toBeNull();
  expect(sheet).not.toBeNull();
  expect(box?.y ?? 999).toBeGreaterThan(sheet?.y ?? 0);
  expect(box?.y ?? 999).toBeLessThan((sheet?.y ?? 0) + 120);
  expect(Math.abs((box?.x ?? 0) + (box?.width ?? 0) / 2 - ((sheet?.x ?? 0) + (sheet?.width ?? 0) / 2))).toBeLessThan(4);
  // It stays until dismissed: no timer takes it away.
  await page.waitForTimeout(1500);
  await expect(toast).toBeVisible();
  await toast.getByRole('button', { name: 'Dismiss' }).click();
  await expect(toast).toHaveCount(0);
});

test('removing a project from Home asks in a glass Confirm dialog, and Cancel gives focus back to Remove', async ({ page }) => {
  await start(page);
  await page.getByLabel('Project name').fill('Short Story');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByTestId('modern-stage')).toBeVisible();
  await openFromMore(page, 'Projects');
  await expect(page.getByRole('heading', { name: 'Projects in this browser' })).toBeVisible();

  const remove = page.getByRole('listitem').filter({ hasText: 'Short Story' }).getByRole('button', { name: 'Remove' });
  await remove.click();
  const confirm = page.getByRole('dialog', { name: 'Remove “Short Story” from this browser?' });
  await expectModernDialog(page, confirm, 'dialog.confirm[open]');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();
  await expect(remove).toBeFocused();
});

/** The bundle Modern's **More › Export bundle** writes for the open project, as bytes. */
async function exportedBundle(page: Page): Promise<Uint8Array> {
  const [download] = await Promise.all([page.waitForEvent('download'), openFromMore(page, 'Export bundle')]);
  return new Uint8Array(readFileSync((await download.path()) ?? ''));
}

/** The bundle changed the way integrity-recovery.spec.ts and encoding-review.spec.ts change theirs, written to a file to import. */
async function changedBundle(testInfo: TestInfo, bytes: Uint8Array, change: 'manifest' | 'encoding'): Promise<string> {
  const { unzipSync, zipSync } = await ZIP_ENGINE.load();
  const entries = unzipSync(bytes);
  if (change === 'manifest') {
    // Cut short, with no backup copy: the recovery offers a rebuild.
    entries['caotang.json'] = new TextEncoder().encode('{"formatVersion": 1, "project": ');
  } else {
    // The scene's file gains a windows-1252 “Café” (0xE9 is not UTF-8): the import pauses on the encoding review.
    const doc = Object.keys(entries).find((path) => path.startsWith('docs/') && path.endsWith('.md') && new TextDecoder().decode(entries[path]).includes('Nobody was on it.'));
    if (doc === undefined) throw new Error('the exported bundle has no scene file');
    const text = new TextDecoder().decode(entries[doc]);
    const at = text.indexOf('Nobody was on it.');
    const encoder = new TextEncoder();
    entries[doc] = Uint8Array.from([...encoder.encode(text.slice(0, at)), ...encoder.encode('Caf'), 0xe9, ...encoder.encode(text.slice(at))]);
  }
  const path = testInfo.outputPath(`modern-${change}.caotang`);
  writeFileSync(path, zipSync(entries));
  return path;
}

test('the Recovery and Encoding dialogs a bundle import asks are glass, keep the focus inside, and every control in them is 44 px', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await start(page);
  await projectWithScene(page, 'Harbour Book');
  const bundle = await exportedBundle(page);
  await openFromMore(page, 'Projects');
  await expect(page.getByRole('heading', { name: 'Projects in this browser' })).toBeVisible();

  await page.getByTestId('bundle-input').setInputFiles(await changedBundle(testInfo, bundle, 'manifest'));
  const recovery = page.getByRole('dialog', { name: 'Rebuild this project from its documents?' });
  await expectModernDialog(page, recovery, 'dialog.confirm[open]');
  await expect(recovery.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await recovery.getByRole('button', { name: 'Cancel' }).click();
  await expect(recovery).toBeHidden();

  await page.getByTestId('bundle-input').setInputFiles(await changedBundle(testInfo, bundle, 'encoding'));
  const encoding = page.getByTestId('encoding-dialog');
  await expect(encoding.getByRole('heading', { name: 'One file is not UTF-8 text' })).toBeVisible();
  // Focus starts on Cancel, the safe answer, in every engine (#347): Firefox's showModal() alone would take the first radio.
  await expect(encoding.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expectModernDialog(page, encoding, '[data-testid="encoding-dialog"]');
  await page.keyboard.press('Escape');
  await expect(encoding).toBeHidden();
});

test('a Choice dialog (the Final Draft import question) is glass, keeps the focus inside, and every control in it is 44 px', async ({ page }) => {
  await start(page);
  await projectWithScene(page, 'Harbour Book');
  const fdx = [
    '<?xml version="1.0" encoding="UTF-8" standalone="no" ?>',
    '<FinalDraft DocumentType="Script" Template="No" Version="3">',
    '  <Content>',
    '    <Paragraph Type="Scene Heading"><Text>INT. HARBOUR - NIGHT</Text></Paragraph>',
    '    <Paragraph Type="Action"><Text>The boat waits.</Text></Paragraph>',
    '  </Content>',
    '</FinalDraft>',
  ].join('\n');
  await page.locator('input[type="file"][aria-label="Script file"]').setInputFiles({ name: 'harbour.fdx', mimeType: 'application/xml', buffer: Buffer.from(fdx, 'utf8') });
  const choice = page.getByRole('dialog', { name: 'Import this Final Draft script?' });
  // Focus starts on Cancel in every engine (#347), so Enter never takes an answer; the first answer is the one filled primary (#362).
  await expect(choice.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expect(choice.getByRole('button', { name: 'Import' })).toHaveClass(/is-primary/);
  await expect(choice.locator('.confirm-actions > button')).toHaveText(['Cancel', 'Import']);
  const cancelBox = await choice.getByRole('button', { name: 'Cancel' }).boundingBox();
  const importBox = await choice.getByRole('button', { name: 'Import', exact: true }).boundingBox();
  expect(importBox?.x).toBeGreaterThan((cancelBox?.x ?? 0) + (cancelBox?.width ?? 0));
  await expectModernDialog(page, choice, 'dialog.confirm[open]');
  await page.keyboard.press('Escape');
  await expect(choice).toBeHidden();
});

test('the Vocabulary dialog, opened from Scene info’s label picker, is glass, keeps the focus inside, and every control in it is 44 px', async ({ page }) => {
  await start(page);
  await projectWithScene(page, 'Harbour Book');
  await openBinder(page);
  // Scene info (#308) holds the inspector in Modern; its label picker opens the Vocabulary dialog as Classic's does.
  await binderTitle(page, 'The Landing').click({ button: 'right' });
  await page.getByRole('menu', { name: 'Actions for The Landing' }).getByRole('menuitem', { name: 'Edit synopsis' }).click();
  const info = page.getByRole('dialog', { name: 'Scene info' });
  await expect(info).toBeVisible();
  await info.getByRole('button', { name: /^Label: No label/ }).click();
  await page.getByRole('menuitem', { name: '+ Add label…' }).click();
  const vocabulary = page.getByRole('dialog', { name: 'Statuses and labels' });
  await expectModernDialog(page, vocabulary, 'dialog.vocabulary-dialog');
  await page.keyboard.press('Escape');
  await expect(vocabulary).toHaveCount(0);
});

test('under reduced motion a dialog only fades in: nothing moves', async ({ page }) => {
  await start(page, { reducedMotion: true });
  await clearAnimations(page);
  await page.getByTestId('open-settings').click();
  const settings = page.getByTestId('settings');
  await expect(settings).toBeVisible();
  await settle(page);
  const calls = (await animations(page)).filter((call) => call.tag === 'dialog');
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.first).not.toContain('translate');
    expect(call.first).not.toContain('scale');
  }
  await page.keyboard.press('Escape');
  await expect(page.locator('.modern-morph-ghost')).toHaveCount(0);
});

test('Reduce transparency makes every dialog and menu an opaque sheet', async ({ page }) => {
  await page.addInitScript(() => (globalThis as unknown as { localStorage: Storage }).localStorage.setItem('caotang.modern.transparency', 'reduced'));
  await start(page);
  await page.getByTestId('open-settings').click();
  const settings = page.getByTestId('settings');
  await expect(settings).toBeVisible();
  await settle(page);
  const look = await material(settings);
  expect(alphaOf(look.background)).toBe(1);
  expect(look.backdrop === '' || look.backdrop === 'none' || look.backdrop.includes('blur(0px)')).toBe(true);
});

test('Classic Confirm and Choice dialogs put Cancel first and keep the action on the trailing edge', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('caotang.interface', 'classic'));
  await page.goto('/');
  await page.getByLabel('Project name').fill('Classic Order');
  await page.getByRole('button', { name: 'Create project' }).click();
  const fdx = '<FinalDraft DocumentType="Script" Version="3"><Content><Paragraph Type="Scene Heading"><Text>INT. HARBOUR - NIGHT</Text></Paragraph></Content></FinalDraft>';
  await page.locator('input[type="file"][aria-label="Script file"]').setInputFiles({ name: 'harbour.fdx', mimeType: 'application/xml', buffer: Buffer.from(fdx) });
  const choice = page.getByRole('dialog', { name: 'Import this Final Draft script?' });
  await expect(choice.locator('.confirm-actions > button')).toHaveText(['Cancel', 'Import']);
  await expect(choice.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expect(choice.getByRole('button', { name: 'Import', exact: true })).toHaveClass(/is-primary/);
  const cancelBox = await choice.getByRole('button', { name: 'Cancel' }).boundingBox();
  const importBox = await choice.getByRole('button', { name: 'Import', exact: true }).boundingBox();
  expect(importBox?.x).toBeGreaterThan((cancelBox?.x ?? 0) + (cancelBox?.width ?? 0));
  await page.keyboard.press('Tab');
  await expect(choice.getByRole('button', { name: 'Import', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: 'Remove Classic Order from this browser', exact: true }).click();
  const confirm = page.locator('dialog.confirm[open]');
  await expect(confirm.locator('.confirm-actions > button')).toHaveText(['Cancel', 'Remove']);
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
});

test('Classic dialogs keep Classic’s look: no glass, no morph', async ({ page }) => {
  await page.addInitScript(() => (globalThis as unknown as { localStorage: Storage }).localStorage.setItem('caotang.interface', 'classic'));
  await page.goto('/');
  await page.getByTestId('open-settings').click();
  const settings = page.getByTestId('settings');
  await expect(settings).toBeVisible();
  const look = await material(settings);
  expect(alphaOf(look.background)).toBe(1);
  expect(look.backdrop === '' || look.backdrop === 'none').toBe(true);
  expect(look.radius).not.toBe('32px');
});
