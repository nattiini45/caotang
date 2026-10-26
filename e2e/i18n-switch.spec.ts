import { createRequire } from 'node:module';

import { expect, test, type Page } from '@playwright/test';

import { fakeEndpoint, planThenAnswer, useFakeEndpoint } from './endpoint.js';
import { bodyOf, createProject, idOf, projectTrace, waitForSaved } from './support.js';

const require = createRequire(import.meta.url);

/**
 * Live interface-language switching (i18n.md §3.3, §5.3, §8.3; I4 / #194).
 *
 * The switchable catalogues in this build are System/English plus the two dev/test pseudo catalogues.
 * The pseudo exposure is the `caotang.pseudo` local flag (the `?pseudo=1` URL is proved separately),
 * so every writer gesture reaches the picker the way a developer's build does. Nothing here needs a
 * provider key: the agent test uses the fake endpoint, like the rest of the suite.
 */

/** Selects the pseudo catalogues in the picker, the way `?pseudo=1` does on a fresh address. */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('caotang.pseudo', '1');
  });
});

async function openAppearance(page: Page): Promise<ReturnType<Page['getByTestId']>> {
  // A stable id, because the button's words follow the interface language (the Home one is the witness).
  await page.getByTestId('open-settings').click();
  const settings = page.getByTestId('settings');
  // By section id: after a reload with a saved pseudo preference, the section's name is pseudo text.
  await settings.locator('[data-section="appearance"]').click();
  return settings;
}

function languageRadio(settings: ReturnType<Page['getByTestId']>, value: string) {
  return settings.locator(`input[name="interface-language"][value="${value}"]`);
}

/** A root-attribute assertion, so a switch is read from the document the browser exposes. */
async function documentLanguage(page: Page): Promise<{ lang: string; dir: string }> {
  return page.evaluate(() => ({ lang: document.documentElement.lang, dir: document.documentElement.dir }));
}

/** One chapter and one scene, opened in the editor. */
async function chapterWithScene(page: Page, scene: string): Promise<void> {
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill(scene);
  await page.keyboard.press('Enter');
}

/** The sample project, opened by the first-run card's read-only demo. */
async function openSample(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
}

const WAITING_PLAN = {
  steps: [
    { tool: 'notes.append', params: { doc: 'The Landing', text: 'A first note.' }, expect: 'A note is added to The Landing' },
    {
      tool: 'synopsis.fill',
      params: { docs: ['The Storm'], source: 'text', max_words: 30 },
      expect: 'The Storm has a synopsis',
    },
  ],
};

test.describe('switching while the writer is working', () => {
  test('an unsaved scene keeps its editor instance, its text and its journal, and focus stays on the picker', async ({ page }) => {
    await createProject(page, 'Switch Book');
    await chapterWithScene(page, 'Typed');
    // Freeze the clock only once the shell has settled, so the save delay cannot elapse during the switch.
    await page.clock.install();
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);

    const surface = page.getByRole('textbox', { name: 'Document text' });
    await surface.click();
    await page.keyboard.type('The harbour was quiet.');
    // The save delay has not elapsed: this text exists only in the editor and its journal.
    await expect(page.getByTestId('save-state')).not.toHaveAttribute('data-state', 'saved');

    // A DOM identity marker proves the editor was re-rendered, not remounted and rebuilt from the store.
    await page.locator('.editor-host').evaluate((element) => {
      (element as Element & { __languageSwitchMark?: string }).__languageSwitchMark = 'kept';
    });
    await page.evaluate(() => {
      (window as Window & { __languageSwitchToken?: string }).__languageSwitchToken = 'kept';
    });

    const settings = await openAppearance(page);
    const ltr = languageRadio(settings, 'en-XA');
    await ltr.click();
    await expect.poll(() => documentLanguage(page)).toEqual({ lang: 'en-XA', dir: 'ltr' });
    await expect(ltr).toBeFocused();

    // The same editor element, the same unsaved text, and no page reload.
    expect(await page.locator('.editor-host').evaluate((element) => (element as Element & { __languageSwitchMark?: string }).__languageSwitchMark)).toBe('kept');
    expect(await page.evaluate(() => (window as Window & { __languageSwitchToken?: string }).__languageSwitchToken)).toBe('kept');
    await expect(surface).toHaveText('The harbour was quiet.');

    // Letting the save delay elapse writes the same text the writer typed before the switch.
    await page.clock.runFor(1_500);
    await waitForSaved(page);
    expect(await bodyOf(page, await idOf(page, 'Typed'))).toBe('The harbour was quiet.\n');
  });

  test('a plan card waiting for the writer and the active agent session survive a switch', async ({ page }) => {
    await fakeEndpoint(page, planThenAnswer(WAITING_PLAN, 'Nothing to run yet.'));
    await useFakeEndpoint(page);
    await openSample(page);

    const field = page.getByRole('textbox', { name: 'Intent' });
    await expect(field).toBeEnabled();
    await field.fill('Add a note to The Landing and a synopsis for The Storm.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    const card = page.getByTestId('plan-card');
    await expect(card).toBeVisible();
    await expect(page.getByTestId('agent-step')).toContainText('Waiting for you');
    const before = await projectTrace(page);

    const settings = await openAppearance(page);
    await languageRadio(settings, 'ar-XB').click();
    await expect.poll(() => documentLanguage(page)).toEqual({ lang: 'ar-XB', dir: 'rtl' });

    // Stable ids, not English text: the card and the turn are still the same live objects.
    await expect(card).toBeVisible();
    await expect(page.getByTestId('agent-step')).toBeVisible();
    // A language switch is an app setting, never a project command.
    expect(await projectTrace(page)).toEqual(before);
  });
});

test.describe('a switch that cannot complete', () => {
  test('a failed catalogue download activates nothing, keeps the preference, and says so', async ({ page }) => {
    await page.goto('/');
    const settings = await openAppearance(page);
    await expect(languageRadio(settings, 'system')).toBeChecked();

    await page.route('**/pseudo-RTL/**', (route) => route.abort());
    await languageRadio(settings, 'ar-XB').click();

    await expect(settings.getByRole('alert')).toContainText('could not be loaded');
    await expect.poll(() => documentLanguage(page)).toEqual({ lang: 'en', dir: 'ltr' });
    await expect(languageRadio(settings, 'system')).toBeChecked();

    // A different catalogue still loads: the failure left the picker and the runtime usable.
    await languageRadio(settings, 'en-XA').click();
    await expect.poll(() => documentLanguage(page)).toEqual({ lang: 'en-XA', dir: 'ltr' });
  });

  test('the latest of two racing downloads wins, and the slower one activates nothing', async ({ page }) => {
    await page.goto('/');
    const settings = await openAppearance(page);

    // Hold the RTL catalogue long enough for the LTR choice to overtake it.
    await page.route('**/pseudo-RTL/**', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      await route.continue();
    });

    await languageRadio(settings, 'ar-XB').click();
    await languageRadio(settings, 'en-XA').click();

    await expect.poll(() => documentLanguage(page)).toEqual({ lang: 'en-XA', dir: 'ltr' });
    // Past the point where the first download resolves: the superseded result must not activate.
    await page.waitForTimeout(1_200);
    await expect.poll(() => documentLanguage(page)).toEqual({ lang: 'en-XA', dir: 'ltr' });
    await expect(languageRadio(settings, 'en-XA')).toBeChecked();
  });
});

test.describe('the saved preference', () => {
  test('survives a reload, and the switch itself never reloads the page', async ({ page }) => {
    await page.goto('/?pseudo=1');
    const settings = await openAppearance(page);
    await languageRadio(settings, 'en-XA').click();
    await expect.poll(() => documentLanguage(page)).toEqual({ lang: 'en-XA', dir: 'ltr' });

    // The switch happened in the running page; only the explicit reload below rebuilds it.
    await page.evaluate(() => {
      (window as Window & { __languageSwitchToken?: string }).__languageSwitchToken = 'kept';
    });

    await page.reload();
    await expect.poll(() => documentLanguage(page)).toEqual({ lang: 'en-XA', dir: 'ltr' });
    const again = await openAppearance(page);
    await expect(languageRadio(again, 'en-XA')).toBeChecked();
  });
});

test.describe('the switched document', () => {
  test('raises no Content-Security-Policy violation while a catalogue loads and renders', async ({ page }) => {
    await page.addInitScript(() => {
      (window as Window & { __cspViolations?: string[] }).__cspViolations = [];
      document.addEventListener('securitypolicyviolation', (event) => {
        (window as Window & { __cspViolations?: string[] }).__cspViolations?.push(`${event.violatedDirective} ${event.blockedURI}`);
      });
    });
    await page.goto('/?pseudo=1');
    const settings = await openAppearance(page);
    await languageRadio(settings, 'ar-XB').click();
    await expect.poll(() => documentLanguage(page)).toEqual({ lang: 'ar-XB', dir: 'rtl' });

    expect(await page.evaluate(() => (window as Window & { __cspViolations?: string[] }).__cspViolations)).toEqual([]);
  });
});

test.describe('the switched document and accessibility', () => {
  // axe is injected as an inline script, which the app's own policy refuses; the scanner is test tooling.
  test.use({ bypassCSP: true });

  test('has a valid lang, no lang mismatch, and content surfaces carry the project language', async ({ page }) => {
    await createProject(page, 'Direction Book');
    const settings = await openAppearance(page);
    await languageRadio(settings, 'ar-XB').click();
    await expect.poll(() => documentLanguage(page)).toEqual({ lang: 'ar-XB', dir: 'rtl' });
    // By structure: after the switch the button's words are pseudo text.
    await settings.locator('.settings-head button').click();

    // Writer content keeps the project's language and automatic direction while the UI mirrors.
    const title = page.locator('.row-title').first();
    await expect(title).toHaveAttribute('lang', 'en');
    await expect(title).toHaveAttribute('dir', 'auto');

    await page.addScriptTag({ path: require.resolve('axe-core') });
    const violations = await page.evaluate(async () => {
      const axe = (globalThis as unknown as {
        axe: { run: (context: Element, options: unknown) => Promise<{ violations: { id: string; nodes: unknown[] }[] }> };
      }).axe;
      const result = await axe.run(document.documentElement, {
        runOnly: { type: 'rule', values: ['html-has-lang', 'valid-lang', 'html-xml-lang-mismatch'] },
      });
      return result.violations.map((entry) => `${entry.id}: ${entry.nodes.length}`);
    });
    expect(violations).toEqual([]);
  });
});
