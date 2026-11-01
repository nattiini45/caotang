import { expect, test, type Locator, type Page } from '@playwright/test';

import { binderRow, binderTitle, createProject, waitForSaved } from './support.js';

/**
 * The German interface as a real-catalogue witness (i18n.md §3.3 "German (I14/L12)", §8.3; D5).
 *
 * `de` is the first production-loadable non-English catalogue: it is listed in the picker without the
 * dev/test pseudo exposure — this spec sets no `caotang.pseudo` flag and no `?pseudo=1` URL, and asserts the
 * pseudo rows are absent — it is fetched lazily over the network when chosen, and its 3049 translations render
 * the writing screen, binder, inspector, settings and export dialog in German. The picker's machine-translation
 * notice is asserted in English before the switch and in German after it, because the notice is a catalogue
 * message itself. Layout is checked at 960 px and 1100 px, the widths the user guide pins, with bounding boxes
 * and a scrollWidth/clientWidth overflow probe, not screenshots. The manuscript keeps the project's language
 * while the interface is German. No provider key and no mock catalogue is involved.
 *
 * The `production-preview` project in playwright.config.ts still matches only prod-smoke.spec.ts, so the built
 * app's de chunk is not witnessed from here; the in-dev evidence that de is not DEV-gated is the picker row
 * without any pseudo flag plus the lazy network fetch asserted below.
 */

/** Opens Settings on the Appearance section; the section is found by its stable id, not its words. */
async function openAppearance(page: Page): Promise<Locator> {
  await page.getByTestId('open-settings').click();
  const settings = page.getByTestId('settings');
  await expect(settings).toBeVisible();
  await settings.locator('[data-section="appearance"]').click();
  return settings;
}

function languageRadio(settings: Locator, value: string): Locator {
  return settings.locator(`input[name="interface-language"][value="${value}"]`);
}

/** The picker row that offers the value: its radio, native name, percentage and notices. */
function languageRow(settings: Locator, value: string): Locator {
  return settings.locator(`[data-testid="interface-language"] label:has(input[name="interface-language"][value="${value}"])`);
}

/** A root-attribute assertion, so a switch is read from the document the browser exposes. */
async function documentLanguage(page: Page): Promise<{ lang: string; dir: string }> {
  return page.evaluate(() => ({ lang: document.documentElement.lang, dir: document.documentElement.dir }));
}

/** Chooses German in the picker and waits for `<html lang dir>`, the way i18n-switch.spec.ts does. */
async function switchToGerman(page: Page, settings: Locator): Promise<void> {
  await languageRadio(settings, 'de').click();
  await expect.poll(() => documentLanguage(page)).toEqual({ lang: 'de', dir: 'ltr' });
}

/** The page does not scroll sideways: the longer German labels fit the window at this width. */
async function fitsWidth(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

/** The chrome areas whose controls the overflow probe scans (i18n.md §8.3: toolbar and button clipping). */
const CHROME = '.toolbar, .rail-tabs, .center-switch, .binder-toolbar, .binder-footer, .settings, .export-dialog';

/** Visible buttons, tabs and radios inside the chrome whose text is clipped (scrollWidth beyond clientWidth). */
async function clippedControls(page: Page): Promise<string[]> {
  return page.evaluate((chrome) => {
    const clipped: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>('button, [role="tab"], [role="radio"]')) {
      if (element.getClientRects().length === 0) continue;
      if (element.closest(chrome) === null) continue;
      if (element.scrollWidth > element.clientWidth + 1) clipped.push((element.textContent ?? '').trim().slice(0, 80));
    }
    return clipped;
  }, CHROME);
}

/** A box that sits inside the window at the given width, asserted the way i18n-surfaces.spec.ts does. */
function expectInsideWindow(box: { x: number; width: number } | null, width: number): void {
  expect(box).not.toBeNull();
  expect((box?.x ?? -1) >= 0).toBe(true);
  expect((box?.x ?? width + 1) + (box?.width ?? 0) <= width + 1).toBe(true);
}

interface CatalogueFetch {
  readonly url: string;
  readonly status: number;
  readonly body: string | null;
}

/** Watches the lazy catalogue request: a real fetch of the de catalogue, not a mock and not the entry chunk. */
function watchCatalogueFetches(page: Page): CatalogueFetch[] {
  const fetches: CatalogueFetch[] = [];
  page.on('response', (response) => {
    const url = response.url();
    if (!/messages\.po|locales\/de\//.test(url)) return;
    void response
      .body()
      .then((body) => fetches.push({ url, status: response.status(), body: body.toString('utf8') }))
      .catch(() => fetches.push({ url, status: response.status(), body: null }));
  });
  return fetches;
}

/** One chapter and one scene, opened in the editor — created in English, before the switch. */
async function chapterWithScene(page: Page, scene: string): Promise<void> {
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill(scene);
  await page.keyboard.press('Enter');
}

for (const width of [960, 1100]) {
  test.describe(`${width} px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('the real German catalogue switches the writing screen, binder, inspector, settings and export dialog, and fits the window', async ({ page }) => {
      // The CSP listener is installed before the app's own scripts run, like i18n-switch.spec.ts's CSP test.
      await page.addInitScript(() => {
        (window as Window & { __cspViolations?: string[] }).__cspViolations = [];
        document.addEventListener('securitypolicyviolation', (event) => {
          (window as Window & { __cspViolations?: string[] }).__cspViolations?.push(`${event.violatedDirective} ${event.blockedURI}`);
        });
      });

      await createProject(page, 'Deutsches Buch');
      await chapterWithScene(page, 'The Landing');
      await page.getByRole('textbox', { name: 'Document text' }).fill('The harbour was quiet.');
      await waitForSaved(page);
      await binderTitle(page, 'The Landing').click();

      // The English source before any switch: the catalogue change is what turns these German.
      await expect(page.locator('.toolbar-start button').first()).toHaveText('Projects');
      await expect(page.getByTestId('save-state')).toHaveText('All changes saved in this browser');
      await expect(page.getByRole('textbox', { name: 'Document text' })).toBeVisible();
      await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();

      const fetches = watchCatalogueFetches(page);
      const settings = await openAppearance(page);

      // German is listed with no developer exposure: this spec sets no pseudo flag, and the pseudo rows are
      // absent, so the row comes from the shipped catalogue table and the D5 gate (100 % ≥ 95 %).
      await expect(languageRadio(settings, 'en-XA')).toHaveCount(0);
      await expect(languageRadio(settings, 'ar-XB')).toHaveCount(0);
      await expect(languageRadio(settings, 'de')).toBeVisible();
      // The picker's machine-translation notice, in English while the interface is English…
      await expect(languageRow(settings, 'de')).toContainText('Machine-assisted translation; not reviewed by a native speaker');

      await switchToGerman(page, settings);

      // …and in German once the interface is German: the notice is a catalogue message itself.
      await expect(languageRadio(settings, 'de')).toBeChecked();
      const row = languageRow(settings, 'de');
      await expect(row).toContainText('Deutsch');
      await expect(row).toContainText('100');
      await expect(row).toContainText('Maschinell erstellte Übersetzung; nicht muttersprachlich geprüft');
      await expect(row).not.toContainText('Machine-assisted translation');

      // The catalogue was fetched lazily, over the network, and the fetched file is the German one.
      await expect.poll(() => fetches.some((fetch) => fetch.status < 400 && /messages\.po|locales\/de\//.test(fetch.url))).toBe(true);
      await expect.poll(() => fetches.some((fetch) => fetch.body?.includes('Maschinell erstellte'))).toBe(true);

      // Settings in German, and the dialog fits this width with no clipped control inside it.
      await expect(settings.locator('h2')).toHaveText('Einstellungen');
      await expect(settings.locator('[data-section="appearance"]')).toHaveText('Darstellung');
      await expect(settings.locator('[data-testid="interface-language"] legend')).toHaveText('Oberflächensprache');
      const guide = settings.getByRole('link', { name: 'Benutzerhandbuch lesen', exact: true });
      await expect(guide).toHaveAttribute('href', 'https://github.com/nattiini45/caotang/blob/main/docs/i18n/de/USER-GUIDE.md#einstellungen');
      await expect(guide).toHaveAttribute('target', '_blank');
      await expect(guide).toHaveAttribute('rel', 'noopener noreferrer');
      expectInsideWindow(await settings.boundingBox(), width);
      expect(await clippedControls(page)).toEqual([]);
      expect(await fitsWidth(page)).toBe(true);

      // Close by structure: the head button's words are German now.
      await settings.locator('.settings-head button').click();

      // The writing screen in German: the toolbar, the save line and the mounted editor's own accessible name.
      await expect(page.locator('html')).toHaveAttribute('lang', 'de');
      await expect(page.locator('.toolbar-start button').first()).toHaveText('Projekte');
      await expect(page.getByTestId('save-state')).toHaveText('Alle Änderungen in diesem Browser gespeichert');
      await expect(page.getByRole('textbox', { name: 'Dokumenttext' })).toContainText('The harbour was quiet.');
      const editorTools = page.getByRole('toolbar', { name: 'In die Szene einfügen' });
      await expect(editorTools.getByRole('button', { name: 'Bild einfügen', exact: true })).toBeVisible();
      const editorStatus = page.locator('.editor-status');
      await expect(editorStatus).toHaveAttribute('aria-label', 'Dokumentstatus');
      await expect(editorStatus).toContainText('4 Wörtern');
      // The manuscript itself keeps the project's language and direction, and the writer's text.
      const host = page.locator('.editor-host');
      await expect(host).toContainText('The harbour was quiet.');
      await expect(host).toHaveAttribute('lang', 'en');
      await expect(host).toHaveAttribute('dir', 'auto');

      // The binder: the tree, its actions toolbar, the new-document button, the totals and the rail tabs.
      await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
      const binderActions = page.getByRole('toolbar', { name: 'Binder-Aktionen' });
      await expect(binderActions.getByRole('button', { name: 'Neues Dokument', exact: true })).toBeVisible();
      await expect(page.getByTestId('binder-totals')).toContainText('im Projekt');
      const tabs = page.locator('.rail-tabs [role="tab"]');
      await expect(tabs.nth(0)).toHaveText('Binder');
      await expect(tabs.nth(1)).toHaveText('Kodex');
      await expect(tabs.nth(2)).toHaveText('Aktivität');
      // The manuscript keeps the project's language and direction, not the interface's.
      const title = binderRow(page, 'The Landing').locator('.row-title');
      await expect(title).toHaveAttribute('lang', 'en');
      await expect(title).toHaveAttribute('dir', 'auto');

      // The inspector in German, on the selected scene.
      const inspector = page.getByRole('complementary', { name: 'Inspektor' });
      await expect(inspector.getByRole('heading', { name: 'The Landing' })).toBeVisible();
      await expect(inspector.getByRole('textbox', { name: 'Synopsis' })).toBeVisible();
      await expect(inspector.getByRole('textbox', { name: 'Notizen' })).toBeVisible();
      await expect(inspector.getByLabel('Stichwort hinzufügen')).toBeVisible();

      // The export dialog in German, and it fits this width too.
      await page.getByRole('button', { name: 'Kompilieren…', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Export' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('Prosa');
      // The radio's accessible name comes from its wrapping label, which also carries the format's help sentence.
      const wordOption = dialog.locator('label:has(input[name="export-format"][value="docx"])');
      await expect(dialog.getByRole('radio', { name: /^Word \(\.docx\)/ })).toBeVisible();
      await expect(wordOption).toContainText('Word (.docx)');
      await expect(wordOption).toContainText('Formatierte Überschriften und ein Inhaltsfeld, das Word aktualisieren kann.');
      await expect(dialog.getByRole('button', { name: 'Kompilieren', exact: true })).toBeVisible();
      expectInsideWindow(await dialog.boundingBox(), width);
      expect(await clippedControls(page)).toEqual([]);
      expect(await fitsWidth(page)).toBe(true);
      await dialog.getByRole('button', { name: 'Abbrechen', exact: true }).click();
      await expect(dialog).toHaveCount(0);

      // Back on the shell: still inside the window, nothing clipped, and no CSP violation happened.
      expectInsideWindow(await page.getByTestId('save-state').boundingBox(), width);
      expect(await clippedControls(page)).toEqual([]);
      expect(await fitsWidth(page)).toBe(true);
      expect(await page.evaluate(() => (window as Window & { __cspViolations?: string[] }).__cspViolations)).toEqual([]);
    });
  });
}

test('the German choice survives a reload, and the switch itself never reloads the page', async ({ page }) => {
  await createProject(page, 'Deutsches Buch');
  const settings = await openAppearance(page);
  await page.evaluate(() => {
    (window as Window & { __germanWitnessToken?: string }).__germanWitnessToken = 'kept';
  });

  await switchToGerman(page, settings);
  // The switch happened in the running page: only the explicit reload below rebuilds it.
  expect(await page.evaluate(() => (window as Window & { __germanWitnessToken?: string }).__germanWitnessToken)).toBe('kept');

  await page.reload();
  // The stored preference loads German at start-up, before anything is clicked.
  await expect.poll(() => documentLanguage(page)).toEqual({ lang: 'de', dir: 'ltr' });
  await expect(page.getByTestId('open-settings')).toHaveText('Einstellungen');
  const again = await openAppearance(page);
  await expect(languageRadio(again, 'de')).toBeChecked();
  await expect(languageRow(again, 'de')).toContainText('Maschinell erstellte Übersetzung; nicht muttersprachlich geprüft');
});
