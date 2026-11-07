import { test as base, expect, type BrowserContextOptions, type Locator, type Page } from '@playwright/test';

import { NO_PIN, classicPin } from './classic-pin.js';
import { DEMO_INTENTS } from '../packages/gateway/src/mock/index.js';

import { SCENE, type Route, type Setup, type Step, type Target } from './modern-homes.js';
import { binderTitle, createProject, idOf, projectIdOf, waitForSaved } from './support.js';

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

/**
 * Builds the project a setup starts from, in Classic, the way a writer would: a new project, and for 'scene' Chapter 1 with one scene.
 * 'findings' adds a second scene, FINDINGS_SCENE, declared on day one and after SCENE, which is declared on day five, and runs the scan,
 * so the manuscript has open findings that quote both (as findings.spec.ts does).
 */
async function buildProject(page: Page, setup: Exclude<Setup, 'home'>): Promise<void> {
  await createProject(page, PROJECT);
  if (setup === 'draft') {
    // The demo agent's edits are marked for review (Settings › Writing); the choice applies to a document opened after it.
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByTestId('settings');
    await settings.getByRole('button', { name: 'Writing' }).click();
    await settings.getByRole('combobox', { name: 'When you apply an agent edit' }).selectOption('suggestions');
    await settings.getByRole('button', { name: 'Save writing settings' }).click();
    await expect(settings.getByText(/Saved\./)).toBeVisible();
    await settings.getByRole('button', { name: 'Close' }).click();
  }
  if (setup === 'scene' || setup === 'findings' || setup === 'draft') {
    await page.getByRole('button', { name: 'Create Chapter 1' }).click();
    await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
    await page.getByRole('textbox', { name: 'Rename Untitled' }).fill(SCENE);
    await page.keyboard.press('Enter');
    await page.getByRole('textbox', { name: 'Document text' }).fill(SCENE_TEXT);
    await waitForSaved(page);
  }
  if (setup === 'draft') {
    // The scene the demo agent drafts into, left empty (packages/gateway/src/mock: DEMO_INTENTS.draftScene names it).
    await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
    await page.getByRole('textbox', { name: 'Rename Untitled' }).fill(DRAFT_SCENE);
    await page.keyboard.press('Enter');
    await waitForSaved(page);
  }
  if (setup === 'findings') {
    await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
    await page.getByRole('textbox', { name: 'Rename Untitled' }).fill(FINDINGS_SCENE);
    await page.keyboard.press('Enter');
    await page.getByRole('textbox', { name: 'Document text' }).fill('The lamp went out before the boat came in.');
    await waitForSaved(page);
    const declare = async (title: string, day: string): Promise<void> => {
      await binderTitle(page, title).click();
      const meta = page.getByTestId('scene-meta');
      if ((await meta.getAttribute('open')) === null) await meta.locator('summary').click();
      await page.getByRole('spinbutton', { name: 'Day offset' }).fill(day);
      await page.getByRole('spinbutton', { name: 'Day offset' }).press('Enter');
    };
    await declare(SCENE, '5');
    await declare(FINDINGS_SCENE, '1');
    await page.getByRole('combobox', { name: 'Add a scene this follows' }).selectOption({ label: SCENE });
    await expect(page.getByRole('list', { name: 'Follows these scenes' })).toContainText(SCENE);
    await waitForSaved(page);
    await page.getByRole('tab', { name: /^Findings/ }).click();
    await page.getByRole('button', { name: 'Scan the manuscript' }).click();
    await expect(page.getByTestId('findings-open')).toHaveText(/^[1-9]\d* open$/);
    await page.getByRole('tab', { name: 'Binder', exact: true }).click();
    await waitForSaved(page);
  }
}

/** The 'findings' setup's second scene, open in the editor when a route starts from it. */
const FINDINGS_SCENE = 'The landing';

/** The 'draft' setup's empty scene, the one the demo agent drafts into, open when a route starts from it. */
const DRAFT_SCENE = 'The Friend';

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
        // Built in Classic, chosen once (a fresh profile starts in Modern since #313), as a writer who used Caotang before has it.
        const pin = classicPin(baseURL === undefined ? [] : [new URL(baseURL).origin]);
        const context = await browser.newContext({ baseURL, locale, storageState: pin, viewport: { width: 1440, height: 900 } });
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
  if (setup === 'findings') await binderTitle(page, FINDINGS_SCENE).click();
  if (setup === 'draft') await binderTitle(page, DRAFT_SCENE).click();
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
  if ((await nav.getAttribute('data-state')) !== 'open') await page.getByRole('navigation', { name: 'Binder' }).getByRole('button', { name: 'Binder', exact: true }).click();
  await expect(nav).toHaveAttribute('data-state', 'open');
  await expect(tree).toBeVisible();
}

/**
 * Closes the sidebar with Manuscript, as a writer does who opened it so. A sidebar the hover opened (a menu that vanished under the
 * pointer leaves it over the tab bar, and WebKit then fires the bar's pointerenter) takes the first press as "open it for real", as
 * #307 has it, so a writer presses Manuscript again: the walk does the same, up to three times.
 */
export async function closeBinder(page: Page): Promise<void> {
  const nav = page.getByTestId('modern-binder');
  const manuscript = page.getByRole('navigation', { name: 'Binder' }).getByRole('button', { name: 'Binder', exact: true });
  await expect(async () => {
    if ((await nav.getAttribute('data-state')) === 'open') await manuscript.click();
    await expect(nav).toHaveAttribute('data-state', 'closed', { timeout: 1_000 });
  }).toPass({ intervals: [100, 250, 500], timeout: 6_000 });
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

/**
 * Another tab stores newer text for SCENE at the revision this tab holds (the store's own write, as a second writer would make
 * it), and this tab types on until its save is refused, so its stale-tab notice opens (as polish-stale-copy.spec.ts does in Classic).
 */
async function staleTab(page: Page): Promise<void> {
  const projectId = (await projectIdOf(page)) ?? '';
  const sceneId = await idOf(page, SCENE);
  const other = await page.context().newPage();
  await other.goto('/');
  await other.evaluate(
    async ([pid, docId]) => {
      const idb = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = idb.open('caotang');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const tx = db.transaction('documents', 'readwrite');
      const documents = tx.objectStore('documents');
      const row = await new Promise<{ revision: number }>((resolve, reject) => {
        const request = documents.get([pid, docId]);
        request.onsuccess = () => resolve(request.result as { revision: number });
        request.onerror = () => reject(request.error);
      });
      documents.put({ ...row, body: 'Written in another tab.\n', revision: row.revision + 1 });
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      db.close();
    },
    [projectId, sceneId] as const,
  );
  await other.close();
  const text = page.locator('#modern-page').getByRole('textbox', { name: 'Document text' });
  await text.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' More from here.');
  await expect(page.getByTestId('stale-tab-notice')).toBeVisible();
}

/** Asks the demo agent (no key: the built-in demo provider) for its draft from the agent window: the draft waits in the ghost bar. */
async function demoDraft(page: Page): Promise<Locator> {
  await page.getByRole('navigation', { name: 'Views and tools' }).getByRole('button', { name: 'Ask', exact: true }).click();
  const agent = page.getByRole('complementary', { name: 'Agent' });
  const field = agent.getByRole('combobox', { name: 'Intent' });
  await expect(field).toBeEnabled();
  await field.fill(DEMO_INTENTS.draftScene);
  await agent.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('ghost-bar')).toContainText(DRAFT_SCENE);
  return agent;
}

async function provoke(page: Page, what: Extract<Step, { provoke: unknown }>['provoke']): Promise<void> {
  switch (what) {
    case 'stale-tab':
      await staleTab(page);
      return;
    case 'draft':
      await demoDraft(page);
      return;
    case 'marked-change': {
      // Approving the plan writes the draft into the scene, marked for review (the 'draft' setup's Writing choice).
      const agent = await demoDraft(page);
      const approve = agent.getByTestId('plan-card').getByRole('button', { name: 'Approve', exact: true });
      await expect(approve).toBeEnabled();
      await approve.click();
      await expect(page.getByTestId('review-bar')).toBeVisible();
      return;
    }
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
  } else if ('viewport' in step) {
    await page.setViewportSize(step.viewport);
    // Below 960 px the stage takes the narrow layout and loads its panels' chunk (#312): the walk goes on once its button is there.
    if (step.viewport.width < 960) await expect(page.getByTestId('modern-narrow-binder')).toBeVisible();
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
  await setUp(page, route.setup ?? setup, { banner });
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
