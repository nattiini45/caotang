import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { binderTitle, createProject, firstChapter, waitForSaved } from './support.js';

/**
 * The production build, smoke-tested. This spec runs only in the `production-preview` project (playwright.config.ts), against
 * `vite preview` of a fresh build on its own port. The dev-only checks elsewhere in the suite (the test hook, the MCP fixture)
 * are gated out of the build, so this spec asserts what a writer sees: the first screen opens, the settings open, a project
 * compiles, and nothing the built app does on the way logs an error, fails to load, or is refused by the Content-Security-Policy
 * the build carries in its index.html. It also checks what the first download leaves out: Settings, the media views and the MCP SDK are
 * chunks that load when they are first used (lazy-view.tsx, lazy-wire.ts), from `assets/` under the build's base, with the policy on.
 */

/** The policy apps/desktop/index.html declares. The build must carry it unchanged: no nonce, nothing relaxed. */
const POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; connect-src *; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'";

/** A 1×1 PNG, so the cover goes through the image paths (an object URL for the preview, the bytes into the EPUB). */
const COVER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

declare global {
  interface Window {
    __cspViolations?: string[];
  }
}

/**
 * Errors the page reports on its way: console errors, uncaught exceptions, same-origin responses that failed, and every
 * `securitypolicyviolation` event. The event listener is installed before any of the page's own scripts run, so a refusal
 * during start-up is caught too.
 */
async function watchForProblems(page: Page): Promise<string[]> {
  const problems: string[] = [];
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__cspViolations?.push(`${event.effectiveDirective} refused ${event.blockedURI || '(inline)'} at ${event.sourceFile}:${event.lineNumber}`);
    });
  });
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console error: ${message.text()}`);
  });
  page.on('pageerror', (error) => {
    problems.push(`uncaught: ${error.message}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && response.url().startsWith(new URL(response.url()).origin)) {
      problems.push(`HTTP ${response.status()} for ${new URL(response.url()).pathname}`);
    }
  });
  return problems;
}

/** The names of the JS chunks the page has requested so far, as the build names them (`Settings-<hash>.js` is `Settings`). */
function watchChunks(page: Page): () => string[] {
  const names: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    const file = path.slice(path.lastIndexOf('/') + 1);
    if (path.includes('/assets/') && file.endsWith('.js')) names.push(file.replace(/-[A-Za-z0-9_-]{8}\.js$/, '')); // the content hash is 8 characters and may itself hold a dash
  });
  return () => [...names];
}

/** The `securitypolicyviolation` events the page has seen so far. */
async function violations(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__cspViolations ?? ['the violation listener was not installed']);
}

/** Compiles the manuscript in the given format and returns the downloaded file's name. */
async function compile(page: Page, format: RegExp): Promise<string> {
  await page.getByRole('button', { name: 'Compile…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  await dialog.getByRole('radio', { name: format }).check();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'Compile', exact: true }).click(),
  ]);
  await expect(dialog).toHaveCount(0);
  return download.suggestedFilename();
}

test('the built app opens on the projects screen with no console errors and no failed requests', async ({ page }) => {
  const problems = await watchForProblems(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Caotang', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No projects here yet' })).toBeVisible();
  expect(problems).toEqual([]);
  expect(await violations(page)).toEqual([]);
});

/**
 * The transform witness in the production build, and the pseudo catalogues' absence from it.
 *
 * `Settings` is the one string I3 converts with a Lingui macro (`components/Home.tsx`). It is rendered
 * from the compiled `en` catalogue that the entry imports, so seeing the English text proves the Vite
 * transform ran and the catalogue is present. This build has no URL switch: `?pseudo=1` is a negative
 * probe, and a production build must ignore it, request no pseudo chunk and carry no pseudo text.
 * The asset scan is the output half of that contract; the unit tests prove the loader's half.
 */
test('the built app renders the transform witness in English, and a `?pseudo=1` URL fetches no pseudo catalogue in the build', async ({ page }) => {
  const problems = await watchForProblems(page);
  const chunks = watchChunks(page);
  await page.goto('/?pseudo=1');
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No projects here yet' })).toBeVisible();
  expect(chunks().filter((name) => name.toLowerCase().includes('pseudo'))).toEqual([]);
  expect(problems).toEqual([]);
  expect(await violations(page)).toEqual([]);

  // The build's output, not just its behaviour: no pseudo catalogue file, and neither pseudo rendering
  // of the witness (the accented padded one, with the RTL override marks) is in any shipped script.
  const assets = resolve(process.cwd(), 'apps/desktop/dist/assets');
  const files = readdirSync(assets);
  expect(files.filter((file) => file.toLowerCase().includes('pseudo'))).toEqual([]);
  const pseudoLtr = '⟦ẍŚēţţĩńĝśẍ⟧';
  const pseudoRtl = '⟦ẍẍ\u202ESǝʇʇıuƃs\u202Cẍẍ⟧';
  const offenders = files
    .filter((file) => file.endsWith('.js'))
    .filter((file) => {
      const text = readFileSync(join(assets, file), 'utf8');
      return text.includes(pseudoLtr) || text.includes(pseudoRtl);
    });
  expect(offenders, 'no shipped script carries a pseudo catalogue entry').toEqual([]);
});

test('the built app carries its Content-Security-Policy, unchanged', async ({ page }) => {
  await page.goto('/');
  const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(policy?.replace(/\s+/g, ' ').trim()).toBe(POLICY);
});

test('the built app opens Settings, and the MCP & tools section is in the build', async ({ page }) => {
  const problems = await watchForProblems(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'MCP & tools' }).click();
  await expect(settings.getByRole('heading', { name: 'MCP & tools' })).toBeVisible();
  expect(problems).toEqual([]);
  expect(await violations(page)).toEqual([]);
});

test('the built app writes a scene, sets a cover, and compiles Word and EPUB with nothing refused by its policy', async ({ page }) => {
  test.setTimeout(90_000);
  const problems = await watchForProblems(page);
  await createProject(page, 'The Lighthouse Keeper');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('The Landing');
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Document text' }).fill('The boat came in with the tide. Nobody was on it.');
  await waitForSaved(page);

  await page.getByRole('button', { name: 'The Lighthouse Keeper' }).click();
  const panel = page.getByRole('dialog', { name: 'Project' });
  await panel.getByLabel('Cover image file').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: COVER_PNG });
  await expect(page.getByRole('status').filter({ hasText: 'The cover is set' })).toBeVisible();
  await panel.getByRole('button', { name: 'Done' }).click();
  await expect(panel).toHaveCount(0);
  await waitForSaved(page);

  expect(await compile(page, /^Word \(\.docx\)/)).toMatch(/\.docx$/);
  expect(await compile(page, /^EPUB \(\.epub\)/)).toMatch(/\.epub$/);

  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await expect(page.getByTestId('agent-provider')).toHaveText('Provider: Demo (no key)');

  expect(problems).toEqual([]);
  expect(await violations(page)).toEqual([]);
});

test('the first load leaves out Settings and the MCP SDK, and a project with no MCP server never fetches the SDK', async ({ page }) => {
  const problems = await watchForProblems(page);
  const chunks = watchChunks(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'No projects here yet' })).toBeVisible();
  expect(chunks()).not.toContain('Settings');
  expect(chunks()).not.toContain('wire');

  // Settings loads when it is opened; the MCP section is in it, and showing it contacts nothing and loads no SDK.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'MCP & tools' }).click();
  await expect(settings.getByRole('heading', { name: 'MCP & tools' })).toBeVisible();
  expect(chunks()).toContain('Settings');
  await settings.getByRole('button', { name: 'Close' }).click();

  // Writing in a project, with no server configured, does not fetch it either.
  await createProject(page, 'No Servers');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await waitForSaved(page);
  expect(chunks()).not.toContain('wire');
  expect(problems).toEqual([]);
  expect(await violations(page)).toEqual([]);
});

test('connecting a server loads the MCP SDK from the build, under the policy', async ({ page }) => {
  await watchForProblems(page);
  const chunks = watchChunks(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'MCP & tools' }).click();
  await settings.getByTestId('mcp-master').check();
  const form = settings.getByRole('form', { name: 'Add a server' });
  await form.getByLabel('Name').fill('Local tools');
  await form.getByLabel('Server address (https://…, or http://localhost…)').fill('http://127.0.0.1:5997/mcp');
  await form.getByRole('button', { name: 'Add server' }).click();
  await expect(settings.getByText('Added “Local tools”')).toBeVisible();
  expect(chunks()).not.toContain('wire');

  // The address is a closed port: the connection is refused, and the card says so. The SDK chunk was fetched to try it.
  const local = settings.locator('[data-server="Local tools"]');
  await local.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(local.getByTestId('mcp-detail')).toContainText('server unreachable', { timeout: 20_000 });
  expect(chunks()).toContain('wire');
  expect(await violations(page)).toEqual([]);
});

test('the Ink compiler is a chunk of its own: a project with no dialogue never fetches it, and one with a dialogue container loads it when it opens', async ({ page }) => {
  const problems = await watchForProblems(page);
  const chunks = watchChunks(page);
  await createProject(page, 'Branching Tale');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await waitForSaved(page);
  expect(chunks()).not.toContain('ink-full');

  // A dialogue container loads it, from the build, under the policy, and the view then compiles the Ink.
  await binderTitle(page, await firstChapter(page)).click({ button: 'right' });
  await page.getByRole('menu', { name: 'Actions for Chapter 1' }).getByRole('menuitem', { name: 'New dialogue here' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'Dialogue: Untitled dialogue' })).toBeVisible();
  expect(chunks()).toContain('ink-full');
  await page.getByRole('textbox', { name: 'Ink source' }).fill('=== start ===\nAlice: Hello.\n* [Leave] -> END\n');
  await expect(page.getByRole('button', { name: /^start:/ })).toBeVisible();
  await waitForSaved(page);

  // Opening the project again fetches it before any container is chosen: the open waits for it.
  const reopened = watchChunks(page);
  await page.reload();
  await page.getByRole('listitem').filter({ hasText: 'Branching Tale' }).getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  expect(reopened()).toContain('ink-full');
  expect(problems).toEqual([]);
  expect(await violations(page)).toEqual([]);
});

test('Settings that cannot be fetched say so with a way out, and the page stays usable', async ({ page }) => {
  await page.route('**/assets/Settings-*.js', (route) => route.abort());
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const failure = page.getByRole('alert').filter({ hasText: 'Settings could not be loaded' });
  await expect(failure).toBeVisible();
  await expect(failure.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(failure.getByRole('button', { name: 'Reload' })).toBeVisible();
  await failure.getByRole('button', { name: 'Close' }).click();
  await expect(failure).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'No projects here yet' })).toBeVisible();

  // With the network back, Reload fetches the page afresh and Settings open.
  await page.unroute('**/assets/Settings-*.js');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Try again' }).click();
  const settings = page.getByTestId('settings');
  const still = page.getByRole('alert').filter({ hasText: 'Settings still could not be loaded' });
  await expect(settings.or(still)).toBeVisible();
  if (await still.isVisible()) {
    await still.getByRole('button', { name: 'Reload' }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
  }
  await expect(settings).toBeVisible();
});

test('the built app compiles a Hindi screenplay PDF: fontkit 2.0.4 and the Devanagari font load under the policy, with no eval and nothing refused', async ({ page }) => {
  test.setTimeout(90_000);
  const problems = await watchForProblems(page);
  const fonts: string[] = [];
  page.on('request', (request) => {
    const name = new URL(request.url()).pathname.split('/').pop() ?? '';
    if (/\.ttf$/i.test(name)) fonts.push(name.replace(/-[\w-]{8}(?=\.ttf)/, ''));
  });
  await createProject(page, 'Hindi Room');
  const parent = await firstChapter(page);
  await binderTitle(page, parent).click({ button: 'right' });
  await page.getByRole('menu', { name: `Actions for ${parent}` }).getByRole('menuitem', { name: 'New screenplay scene here' }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('radio', { name: 'Source', exact: true }).click();
  await page.getByRole('textbox', { name: 'Fountain source' }).fill('INT. घर - NIGHT\n\nराम हिन्दी में क्षत्रिय श्रीमान् की बात करता है।\n\n@राम\nमैं हिन्दी बोलता हूँ।\n');
  await waitForSaved(page);

  await binderTitle(page, 'Untitled scene').click();
  await page.getByRole('button', { name: 'Compile…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  await dialog.getByRole('radio', { name: /^Only “Untitled scene”/ }).check();
  await dialog.getByRole('radio', { name: /^Screenplay PDF \(\.pdf\)/ }).check();
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Compile', exact: true }).click()]);
  const pdf = readFileSync(await download.path(), 'latin1');

  expect(pdf).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSansDevanagari-Regular/);
  expect(pdf).toContain('/ActualText <FEFF0939093F0928094D09260940>');
  expect([...new Set(fonts)]).toEqual(['NotoSansDevanagari-Regular.ttf']);
  expect(problems).toEqual([]);
  expect(await violations(page)).toEqual([]);
});
