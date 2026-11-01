import { expect, test, type Page } from '@playwright/test';

import { NO_PIN } from './classic-pin.js';
import { createProject, waitForSaved } from './support.js';

/**
 * The Modern stage, page and materials (M4, #305; modern-interface.md §5.3, §6, §9.4, §11): choosing Modern in Settings › Appearance
 * switches the workspace to the stage (the wallpaper) and one page of paper with today's centre content on it, with glass on the
 * controls around it; switching back gives Classic as it was. Then each fallback: the Reduce transparency and Reduce motion switches,
 * the system's reduced motion and reduced transparency, more contrast and forced colours. No Content-Security-Policy violation on the
 * way. These specs run Modern, so they start without the suite's Classic pin.
 */

test.use({ storageState: NO_PIN });

interface Look {
  readonly background: string;
  readonly backgroundImage: string;
  readonly backdrop: string;
  readonly radius: string;
  readonly borderStyle: string;
}

/** The computed look of the first element a selector matches. */
function look(page: Page, selector: string): Promise<Look> {
  return page.locator(selector).first().evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      backdrop: style.getPropertyValue('backdrop-filter') || style.getPropertyValue('-webkit-backdrop-filter'),
      radius: style.borderStartStartRadius,
      borderStyle: style.borderBlockStartStyle,
    };
  });
}

function token(page: Page, name: string): Promise<string> {
  return page.evaluate((property) => getComputedStyle(document.documentElement).getPropertyValue(property).trim(), name);
}

/** Whether an rgb()/rgba() colour is fully opaque. */
function isOpaque(colour: string): boolean {
  const match = /rgba?\(([^)]*)\)/.exec(colour);
  if (match === null) return false;
  const parts = (match[1] ?? '').split(/[\s,/]+/).filter((part) => part !== '');
  return parts.length < 4 || Number.parseFloat(parts[3] ?? '1') === 1;
}

async function watchCsp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as Window & { __cspViolations?: string[] }).__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      (window as Window & { __cspViolations?: string[] }).__cspViolations?.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
}

function cspViolations(page: Page): Promise<string[] | undefined> {
  return page.evaluate(() => (window as Window & { __cspViolations?: string[] }).__cspViolations);
}

/** A project with one scene that has words in it, open in Classic. */
async function sceneWithWords(page: Page): Promise<void> {
  await createProject(page, 'Harbour Book');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('Lin’s ticket');
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Document text' }).fill('The ferry left at dawn, and Lin had the only ticket.');
  await waitForSaved(page);
}

/** Opens Settings › Appearance from either shell (Classic's toolbar, or Modern's provisional More menu). */
async function openAppearance(page: Page) {
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

async function switchTo(page: Page, name: 'Classic' | 'Modern (Preview)') {
  const settings = await openAppearance(page);
  const radio = settings.getByRole('group', { name: 'Interface', exact: true }).getByRole('radio', { name });
  await radio.check();
  await expect(radio).toBeFocused();
  return settings;
}

test('choosing Modern shows the stage, the wallpaper and one page of paper with the scene on it; Classic comes back as it was', async ({ page }) => {
  await watchCsp(page);
  await page.goto('/');
  await sceneWithWords(page);

  const settings = await switchTo(page, 'Modern (Preview)');
  await expect(page.getByTestId('modern-stage')).toBeVisible();
  // The live switch keeps Settings open, with focus on the radio, behind which the shell changed.
  await expect(settings).toBeVisible();
  await expect(page.locator('.toolbar')).toHaveCount(0);
  await expect(page.locator('.workspace')).toHaveCount(0);
  await settings.getByRole('button', { name: 'Close' }).click();

  // The wallpaper: a same-origin SVG file, decorative.
  const wallpaper = page.getByTestId('modern-wallpaper');
  await expect(wallpaper).toHaveAttribute('aria-hidden', 'true');
  const wall = await look(page, '[data-testid="modern-wallpaper"]');
  expect(wall.backgroundImage).toMatch(/url\("?[^)]*wallpaper-light[^)]*\.svg"?\)/);
  expect(wall.backgroundImage).not.toContain('data:');

  // The page: a main named by the project, paper (opaque, unblurred), 36 px corners, holding today's centre content.
  const main = page.getByRole('main', { name: 'Harbour Book' });
  await expect(main).toBeVisible();
  await expect(main.getByRole('textbox', { name: 'Document text' })).toHaveText('The ferry left at dawn, and Lin had the only ticket.');
  const paper = await look(page, '#modern-page');
  expect(isOpaque(paper.background)).toBe(true);
  expect(paper.backdrop === '' || paper.backdrop === 'none').toBe(true);
  expect(paper.radius).toBe('36px');

  // Glass on the controls around it: translucent, blurred, the ornament's radius.
  const glass = await look(page, '[data-testid="modern-top-ornament"]');
  expect(isOpaque(glass.background)).toBe(false);
  expect(glass.backdrop).toContain('blur(9px)');
  expect(glass.radius).toBe('30px');
  expect(await token(page, '--radius-control')).toBe('24px');

  // The centre views still switch, with Classic's ids, and the editor stays mounted.
  await page.getByRole('radio', { name: 'Corkboard' }).click();
  await expect(page.getByRole('radio', { name: 'Corkboard' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('radio', { name: 'Editor' }).click();
  await expect(main.getByRole('textbox', { name: 'Document text' })).toBeVisible();

  // Back to Classic: the toolbar and the grid return, the words are where they were.
  const back = await switchTo(page, 'Classic');
  await back.getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('.workspace')).toBeVisible();
  await expect(page.getByTestId('modern-stage')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Document text' })).toHaveText('The ferry left at dawn, and Lin had the only ticket.');

  expect(await cspViolations(page)).toEqual([]);
});

test('Reduce transparency and Reduce motion in Appearance make the glass solid and stop the motion, and are kept', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('caotang.interface', 'modern'));
  await page.goto('/');
  await createProject(page, 'Solid Book');
  await expect(page.getByTestId('modern-stage')).toBeVisible();
  expect(await token(page, '--dur-3')).toBe('520ms');

  const settings = await openAppearance(page);
  const group = settings.getByTestId('modern-preferences');
  await group.getByRole('checkbox', { name: 'Reduce transparency' }).check();
  await group.getByRole('checkbox', { name: 'Reduce motion' }).check();
  await expect(page.locator('html')).toHaveAttribute('data-transparency', 'reduced');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
  await settings.getByRole('button', { name: 'Close' }).click();

  const solid = await look(page, '[data-testid="modern-top-ornament"]');
  expect(isOpaque(solid.background)).toBe(true);
  expect(solid.backdrop).not.toMatch(/blur\([1-9]/);
  expect(await token(page, '--dur-3')).toBe('0s');
  expect(await token(page, '--dur-fade')).toBe('120ms');

  await page.reload();
  await expect(page.getByTestId('modern-stage').or(page.getByRole('heading', { name: 'Projects in this browser' }))).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-transparency', 'reduced');
  expect(await page.evaluate(() => [localStorage.getItem('caotang.modern.transparency'), localStorage.getItem('caotang.modern.motion')])).toEqual([
    'reduced',
    'reduced',
  ]);
});

test('Classic shows no Modern switches, and Modern’s chunk is not fetched while Classic is on', async ({ page }) => {
  const modern: string[] = [];
  page.on('request', (request) => {
    if (/modern-shell|shell[/\\]modern|tokens\/modern\.css/.test(request.url())) modern.push(request.url());
  });
  await page.addInitScript(() => localStorage.setItem('caotang.interface', 'classic'));
  await page.goto('/');
  await createProject(page, 'Classic Book');
  const settings = await openAppearance(page);
  await expect(settings.getByRole('group', { name: 'Interface', exact: true })).toBeVisible();
  await expect(settings.getByTestId('modern-preferences')).toHaveCount(0);
  expect(modern).toEqual([]);
});

test.describe('the system’s preferences', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('caotang.interface', 'modern'));
  });

  test('reduced motion zeroes every duration but the 120 ms fade', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await createProject(page, 'Still Book');
    await expect(page.getByTestId('modern-stage')).toBeVisible();
    expect([await token(page, '--dur-1'), await token(page, '--dur-2'), await token(page, '--dur-3')]).toEqual(['0s', '0s', '0s']);
    expect(await token(page, '--dur-fade')).toBe('120ms');
  });

  test('forced colours: no wallpaper, system colours and a border on every container', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Only Chromium emulates forced colours.');
    await page.emulateMedia({ forcedColors: 'active' });
    await page.goto('/');
    await createProject(page, 'Forced Book');
    await expect(page.getByTestId('modern-stage')).toBeVisible();
    expect((await look(page, '[data-testid="modern-wallpaper"]')).backgroundImage).toBe('none');
    const ornament = await look(page, '[data-testid="modern-top-ornament"]');
    expect(ornament.borderStyle).toBe('solid');
    expect(ornament.backdrop === '' || ornament.backdrop === 'none').toBe(true);
  });

  test('more contrast puts thick glass and scrims at full opacity', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'The contrast preference is emulated here through Chromium’s DevTools protocol.');
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-contrast', value: 'more' }] });
    await page.goto('/');
    await createProject(page, 'Contrast Book');
    await expect(page.getByTestId('modern-stage')).toBeVisible();
    const scrim = await page.locator('.modern-capsule').first().evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(isOpaque(scrim)).toBe(true);
  });

  test('reduced transparency makes the glass solid', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Reduced transparency is emulated through Chromium’s DevTools protocol.');
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
    await page.goto('/');
    await createProject(page, 'Opaque Book');
    await expect(page.getByTestId('modern-stage')).toBeVisible();
    test.skip(!(await page.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches)), 'This Chromium does not know the query.');
    const ornament = await look(page, '[data-testid="modern-top-ornament"]');
    expect(isOpaque(ornament.background)).toBe(true);
    expect(ornament.backdrop).not.toMatch(/blur\([1-9]/);
  });
});
