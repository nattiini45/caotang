import { test as base, expect, type BrowserContextOptions, type Locator, type Page } from '@playwright/test';

import { NO_PIN } from './classic-pin.js';
import { SCENE, type Route, type Setup, type Step, type Target } from './modern-homes.js';
import { binderTitle, createProject, waitForSaved } from './support.js';

/**
 * The walker for MODERN_HOMES (e2e/modern-homes.ts) and the surfaces of the Modern gate (e2e/modern-gate.spec.ts): it sets a
 * project up the way a writer would (in Classic, then Modern switched on live in Settings › Appearance, so every spec starts from
 * the same place whatever #306 and #307 put on the screen), and runs a route's steps.
 */

export const PROJECT = 'Gate Book';

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The locator for a target. */
export function locate(page: Page, target: Target): Locator {
  const scope: Page | Locator = target.within === undefined ? page : locate(page, target.within);
  const pattern = target.pattern === undefined ? undefined : new RegExp(target.pattern);
  let found: Locator;
  if (target.role !== undefined) {
    const name = target.name !== undefined ? { name: target.name, exact: true } : pattern !== undefined ? { name: pattern } : {};
    found = scope.getByRole(target.role as Parameters<Page['getByRole']>[0], name);
  } else if (target.testId !== undefined) {
    found = scope.getByTestId(target.testId);
    if (pattern !== undefined) found = found.filter({ hasText: pattern });
  } else if (target.css !== undefined) {
    found = scope.locator(target.css);
    if (pattern !== undefined) found = found.filter({ hasText: pattern });
    if (target.name !== undefined) found = found.filter({ hasText: new RegExp(`^${escapeRegExp(target.name)}$`) });
  } else {
    throw new Error(`a target needs a role, a test id or a selector: ${JSON.stringify(target)}`);
  }
  return found.first();
}

/** The browser keeps this origin's storage, so the storage banner stays away (a route that wants it asks for the other answer). */
async function storageKept(page: Page, kept: boolean): Promise<void> {
  await page.addInitScript((answer: boolean) => {
    const storage = (globalThis as unknown as { navigator: { storage?: object } }).navigator.storage;
    if (storage === undefined) return;
    const proto = Object.getPrototypeOf(storage) as Record<string, unknown>;
    proto['persisted'] = async () => answer;
    proto['persist'] = async () => answer;
  }, kept);
}

/** Settings › Appearance › Interface › Modern, from Classic's toolbar, then Settings closed. */
export async function switchToModern(page: Page): Promise<void> {
  await page.locator('.toolbar').getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
  await settings.getByRole('group', { name: 'Interface', exact: true }).getByRole('radio', { name: /^Modern/ }).check();
  await settings.getByRole('button', { name: 'Close' }).click();
  await expect(settings).toHaveCount(0);
  await expect(page.getByTestId('modern-stage')).toBeVisible();
}

export interface SetupOptions {
  /** The storage banner shows (the browser does not promise to keep the project). */
  readonly banner?: boolean;
  /** The scheme, set as an explicit choice before the app loads. */
  readonly scheme?: 'light' | 'dark';
  /** Reduce transparency in Appearance (`caotang.modern.transparency`). */
  readonly solid?: boolean;
}

/** Builds the project a setup starts from, in Classic, the way a writer would: a new project, and for 'scene' Chapter 1 with one scene. */
async function buildProject(page: Page, setup: Exclude<Setup, 'home'>): Promise<void> {
  await createProject(page, PROJECT);
  if (setup === 'scene') {
    await page.getByRole('button', { name: 'Create Chapter 1' }).click();
    await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
    await page.getByRole('textbox', { name: 'Rename Untitled' }).fill(SCENE);
    await page.keyboard.press('Enter');
    await page.getByRole('textbox', { name: 'Document text' }).fill(SCENE_TEXT);
    await waitForSaved(page);
  }
}

const SCENE_TEXT = 'The boat came in with the tide. Nobody was on it.';

type State = Exclude<BrowserContextOptions['storageState'], string | undefined>;

/**
 * The Modern specs' `test`: each worker builds the 'empty' and the 'scene' project once, in Classic in a context of its own, and keeps
 * the browser's storage (local storage and IndexedDB) as a storage state; every test then starts from a copy of it, opens the project
 * from the projects screen and switches to Modern live. A describe block names its setup with `test.use({ setup })`; 'home' starts
 * from a fresh profile.
 */
export const test = base.extend<{ setup: Setup }, { builtState: (setup: Exclude<Setup, 'home'>) => Promise<State> }>({
  setup: ['scene', { option: true }],
  builtState: [
    async ({ browser }, provide, workerInfo) => {
      const built = new Map<string, Promise<State>>();
      const build = async (setup: Exclude<Setup, 'home'>): Promise<State> => {
        const { baseURL, locale } = workerInfo.project.use;
        const context = await browser.newContext({ baseURL, locale, storageState: NO_PIN, viewport: { width: 1440, height: 900 } });
        try {
          const page = await context.newPage();
          await storageKept(page, true);
          await buildProject(page, setup);
          return await context.storageState({ indexedDB: true });
        } finally {
          await context.close();
        }
      };
      await provide((setup) => {
        let state = built.get(setup);
        if (state === undefined) {
          state = build(setup);
          built.set(setup, state);
        }
        return state;
      });
    },
    { scope: 'worker', timeout: 60_000 },
  ],
  storageState: async ({ setup, builtState }, provide) => {
    await provide(setup === 'home' ? NO_PIN : await builtState(setup));
  },
});

/** Puts the app where a route or a surface starts, in Modern: the built project (see `test`) opened in Classic, then Modern switched on. */
export async function setUp(page: Page, setup: Setup, options: SetupOptions = {}): Promise<void> {
  await storageKept(page, options.banner !== true);
  await page.addInitScript(
    ({ scheme, solid }: { scheme: string | null; solid: boolean }) => {
      if (scheme !== null) localStorage.setItem('caotang.theme', scheme);
      if (solid) localStorage.setItem('caotang.modern.transparency', 'reduced');
    },
    { scheme: options.scheme ?? null, solid: options.solid === true },
  );
  if (setup === 'home') {
    await page.addInitScript(() => localStorage.setItem('caotang.interface', 'modern'));
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Projects in this browser' })).toBeVisible();
    return;
  }
  await page.goto('/');
  const row = page.getByRole('listitem').filter({ hasText: PROJECT });
  await expect(row, 'the built project is listed (the spec uses the `test` of modern-walk.ts)').toBeVisible({ timeout: 20_000 });
  await row.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  if (setup === 'scene') {
    await binderTitle(page, SCENE).click();
    await expect(page.getByRole('textbox', { name: 'Document text' })).toContainText(SCENE_TEXT);
  }
  await switchToModern(page);
}

/**
 * Shows the binder in #307's sidebar. The sidebar closes 420 ms after the pointer or focus leaves it, so an open one may be about
 * to close: the pointer rests on the tab bar first, which keeps it open, and a closed (or closing) one is opened with Manuscript.
 */
export async function showBinder(page: Page): Promise<void> {
  const tree = page.getByRole('tree', { name: 'Binder' });
  const nav = page.getByTestId('modern-binder');
  await page.getByTestId('modern-binder-bar').hover();
  if ((await nav.getAttribute('data-state')) !== 'open') await page.getByRole('navigation', { name: 'Binder' }).getByRole('button', { name: 'Manuscript' }).click();
  await expect(nav).toHaveAttribute('data-state', 'open');
  await expect(tree).toBeVisible();
}

/** Closes the sidebar with Manuscript, as a writer does who opened it so. */
export async function closeBinder(page: Page): Promise<void> {
  const nav = page.getByTestId('modern-binder');
  if ((await nav.getAttribute('data-state')) === 'open') await page.getByRole('navigation', { name: 'Binder' }).getByRole('button', { name: 'Manuscript' }).click();
  await expect(nav).toHaveAttribute('data-state', 'closed');
}

/** **⋯**: the top ornament's More (M4's provisional one, or #306's). */
export async function openMore(page: Page): Promise<Locator> {
  await page.getByTestId('modern-top-ornament').getByRole('button', { name: 'More', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'More' });
  await expect(menu).toBeVisible();
  return menu;
}

/** An item of **⋯** by its name: a command, or one of Appearance's radio and checkbox items (#306). */
function menuItem(menu: Locator, name: string): Locator {
  const exact = { name, exact: true } as const;
  return menu.getByRole('menuitem', exact).or(menu.getByRole('menuitemradio', exact)).or(menu.getByRole('menuitemcheckbox', exact)).first();
}

function paletteOf(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Search and commands' });
}

/** Opens the palette with its chord and types a query; the option with exactly that label (and detail). */
async function paletteOption(page: Page, query: string, label: string, detail?: string): Promise<Locator> {
  await page.keyboard.press('ControlOrMeta+k');
  const field = paletteOf(page).getByRole('combobox', { name: 'Search scenes, codex and commands' });
  await expect(field).toBeFocused();
  await field.fill(query);
  let option = paletteOf(page)
    .getByRole('option')
    .filter({ has: page.locator('.modern-palette-label', { hasText: new RegExp(`^${escapeRegExp(label)}$`) }) });
  if (detail !== undefined) option = option.filter({ has: page.locator('.modern-palette-detail', { hasText: new RegExp(`^${escapeRegExp(detail)}$`) }) });
  await expect(option.first()).toBeVisible();
  return option.first();
}

async function withDownload(page: Page, wanted: boolean | undefined, act: () => Promise<void>): Promise<void> {
  if (wanted !== true) return act();
  const download = page.waitForEvent('download');
  await act();
  expect((await download).suggestedFilename()).not.toBe('');
}

async function provoke(page: Page, what: Extract<Step, { provoke: unknown }>['provoke']): Promise<void> {
  switch (what) {
    case 'storage-banner':
      await expect(page.getByTestId('storage-banner')).toBeVisible();
      return;
    case 'deleted-scene': {
      await showBinder(page);
      await binderTitle(page, SCENE).click({ button: 'right' });
      await page.getByRole('menu', { name: `Actions for ${SCENE}` }).getByRole('menuitem', { name: 'Delete' }).click();
      await page.getByRole('dialog', { name: `Delete “${SCENE}”?` }).getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(binderTitle(page, SCENE)).toHaveCount(0);
      return;
    }
    case 'screenplay':
    case 'storyboard':
    case 'dialogue': {
      const item = { screenplay: 'New screenplay scene here', storyboard: 'New storyboard here', dialogue: 'New dialogue here' }[what];
      await showBinder(page);
      await binderTitle(page, 'Chapter 1').click({ button: 'right' });
      await page.getByRole('menu', { name: 'Actions for Chapter 1' }).getByRole('menuitem', { name: item }).click();
      // The new node's title is in rename mode; Escape keeps its name.
      await page.keyboard.press('Escape');
      // Then Manuscript closes the sidebar it opened, so the route starts on the new item's page with the sidebar shut, as a writer
      // who goes on to work in it would have it (a pointer that left through the row's menu does not close it by itself).
      await closeBinder(page);
      return;
    }
  }
}

/** Runs one step. */
export async function runStep(page: Page, step: Step): Promise<void> {
  if ('more' in step) {
    const menu = await openMore(page);
    await withDownload(page, step.download, () => menuItem(menu, step.more).click());
  } else if ('menuHas' in step) {
    const menu = await openMore(page);
    await expect(menuItem(menu, step.menuHas)).toBeVisible();
    await page.keyboard.press('Escape');
  } else if ('palette' in step) {
    const option = await paletteOption(page, step.palette, step.option ?? step.palette);
    await withDownload(page, step.download, () => option.click());
  } else if ('offers' in step) {
    await paletteOption(page, step.offers, step.offers, step.detail);
    await page.keyboard.press('Escape');
    await expect(paletteOf(page)).toHaveCount(0);
  } else if ('press' in step) {
    if (step.on !== undefined) await locate(page, step.on).click();
    if (step.focus !== undefined) await locate(page, step.focus).focus();
    await page.keyboard.press(step.press);
  } else if ('click' in step) {
    await locate(page, step.click).click(step.right === true ? { button: 'right' } : {});
  } else if ('type' in step) {
    await page.keyboard.type(step.type);
  } else if ('binder' in step) {
    await showBinder(page);
  } else if ('provoke' in step) {
    await provoke(page, step.provoke);
  } else {
    const target = locate(page, step.see);
    if (step.gone === true) await expect(target).toHaveCount(0);
    else if (step.focused === true) await expect(target).toBeFocused();
    else await expect(target).toBeVisible();
  }
}

/** Walks a route from its setup. */
export async function walk(page: Page, setup: Setup, route: Route): Promise<void> {
  const banner = route.steps.some((step) => 'provoke' in step && step.provoke === 'storage-banner');
  await setUp(page, setup, { banner });
  for (const step of route.steps) await runStep(page, step);
}

// ---- The CSP listener (§11): every Modern spec fails on a securitypolicyviolation event. ----

export async function watchCsp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as Window & { __cspViolations?: string[] }).__cspViolations = seen;
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push(`${event.violatedDirective} ${event.blockedURI} ${event.sourceFile}:${event.lineNumber}`);
    });
  });
}

export function cspViolations(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as Window & { __cspViolations?: string[] }).__cspViolations ?? ['the listener was not installed']);
}
