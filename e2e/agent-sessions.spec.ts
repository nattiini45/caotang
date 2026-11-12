import { expect, test, type Page } from '@playwright/test';
import { FAKE_ENDPOINT, fakeEndpoint, useFakeEndpoint as configureFakeEndpoint } from './endpoint.js';
import { createProject, waitForSaved } from './support.js';

async function openAgent(page: Page, shell: string): Promise<void> {
  if (shell === 'modern') await page.keyboard.press('Control+j');
  else await page.getByTestId('agent-panel').locator('.agent-toggle').click();
  await expect(page.getByTestId('agent-sessions')).toHaveAttribute('data-state', 'ready');
}

async function openSettings(page: Page, shell: string, language: string): Promise<void> {
  if (shell === 'modern') {
    await page.getByTestId('agent-close').click();
    await page.getByTestId('modern-top-ornament').getByRole('button', { name: language === 'de' ? 'Mehr' : 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: language === 'de' ? 'Einstellungen' : 'Settings', exact: true }).click();
  } else await page.getByRole('button', { name: language === 'de' ? 'Einstellungen' : 'Settings', exact: true }).click();
}

async function prepareProviderPreferences(page: Page, language: string): Promise<void> {
  await page.goto('/');
  await expect(page.getByLabel('Project name')).toBeVisible();
  await expect.poll(() => page.evaluate(async ({ language, endpoint }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('caotang-app');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const read = <T>(key: string): Promise<T | undefined> => new Promise((resolve, reject) => {
        const request = db.transaction('kv', 'readonly').objectStore('kv').get(key) as IDBRequest<{ value: T } | undefined>;
        request.onsuccess = () => resolve(request.result?.value);
        request.onerror = () => reject(request.error);
      });
      const [profiles, settings] = await Promise.all([
        read<Record<string, unknown>[]>('profiles'),
        read<Record<string, unknown>>('settings'),
      ]);
      const initial = profiles?.find((profile) => profile['kind'] === 'mock' && profile['isActive'] === true);
      const provider = settings?.['provider'] as { activeProfileId?: unknown } | undefined;
      if (profiles === undefined || initial === undefined || provider?.activeProfileId !== initial['id']) return false;
      const id = 'prv_0000000000';
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('kv', 'readwrite');
        const store = transaction.objectStore('kv');
        store.put({ key: 'profiles', value: [
          ...profiles.map((profile) => ({ ...profile, isActive: false })),
          { id, name: 'Fake endpoint', kind: 'endpoint', preset: 'generic', baseUrl: endpoint, defaultModel: 'test-model', hasKey: false, isActive: true,
            responseFormat: { supportsJsonObject: true, probedAt: Date.now() } },
        ] });
        store.put({ key: 'settings', value: { ...settings, interfaceLanguage: language, provider: { activeProfileId: id } } });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      return true;
    } finally {
      db.close();
    }
  }, { language, endpoint: FAKE_ENDPOINT })).toBe(true);
  await page.reload();
}

test('settled sessions survive reload, continue their L6 and fork without a manuscript write', async ({ page }) => {
  const requests: string[] = [];
  await fakeEndpoint(page, (request) => { requests.push(request.user); return 'The ferryman knows about the letter.'; });
  await configureFakeEndpoint(page);
  await createProject(page, 'Session Book');
  await openAgent(page, 'classic');
  const panel = page.getByTestId('agent-panel');
  await panel.getByRole('combobox').fill('Who knows about the letter?');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(panel.locator('.agent-turn')).toHaveCount(1);
  await expect(panel.locator('.agent-turn')).toHaveClass(/is-done/);
  await expect(panel).toHaveAttribute('data-state', 'idle');
  const turnId = await panel.locator('.agent-turn').getAttribute('data-turn');
  await page.reload();
  await page.getByRole('listitem').filter({ hasText: 'Session Book' }).getByRole('button', { name: 'Open', exact: true }).click();
  await openAgent(page, 'classic');
  await expect(panel.getByTestId('stored-turn')).toHaveText('From an earlier visit');
  await expect(panel.locator('.agent-turn')).toHaveAttribute('data-turn', turnId!);
  await panel.getByRole('combobox').fill('Now tell me who does not.');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(panel.locator('.agent-turn')).toHaveCount(2);
  await expect(panel.locator('.agent-turn').last()).toHaveClass(/is-done/);
  await expect(panel).toHaveAttribute('data-state', 'idle');
  expect(requests.at(-1)).toContain('Intent: Who knows about the letter?');
  expect(requests.at(-1)).toContain('The ferryman knows about the letter.');
  await panel.getByTestId('turn-menu').first().getByRole('button', { name: /Turn actions for/ }).click();
  await panel.getByRole('button', { name: /^Fork from here/ }).click();
  await expect(panel.getByTestId('agent-sessions')).toHaveAttribute('data-state', 'ready');
  await expect(panel.locator('.agent-turn')).toHaveCount(1);
  await panel.getByTestId('agent-sessions').locator('.agent-session-trigger').click();
  await expect(panel.locator('.agent-session-list > li')).toHaveCount(2);
  await expect(panel.getByTestId('agent-sessions')).toContainText('Forked from');
});

for (const variant of [
  { shell: 'modern', language: 'en', width: 1280, height: 900, theme: 'dark' },
  { shell: 'modern', language: 'de', width: 390, height: 844, theme: 'light' },
  { shell: 'classic', language: 'en', width: 1280, height: 900, theme: 'light' },
  { shell: 'classic', language: 'de', width: 390, height: 844, theme: 'dark' },
]) {
  const prepareThreeSessions = async (page: Page): Promise<void> => {
    await page.addInitScript(({ shell, theme }) => {
      localStorage.setItem('caotang.interface', shell);
      localStorage.setItem('caotang.theme', theme);
    }, variant);
    await fakeEndpoint(page, () => 'The ferryman knows about the letter.');
    await prepareProviderPreferences(page, variant.language);
    await page.getByLabel(variant.language === 'de' ? 'Projektname' : 'Project name').fill('Session Book');
    await page.getByRole('button', { name: variant.language === 'de' ? 'Projekt erstellen' : 'Create project', exact: true }).click();
    await expect(page.getByRole('tree', { name: 'Binder' }).or(page.getByTestId('modern-binder-bar')).first()).toBeVisible();
    await waitForSaved(page);
    await openAgent(page, variant.shell);
    const panel = page.getByTestId('agent-panel');
    await panel.getByRole('combobox').fill('Keep the lighthouse and the storm in mind.');
    await panel.getByRole('button', { name: variant.language === 'de' ? 'Senden' : 'Send', exact: true }).click();
    await expect(panel.locator('.agent-turn')).toHaveCount(1);
    await expect(panel.locator('.agent-turn')).toHaveClass(/is-done/);
    await expect(panel).toHaveAttribute('data-state', 'idle');
    if (variant.language === 'de') {
      await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    }
    await panel.getByTestId('turn-menu').getByRole('button').click();
    await panel.getByRole('button', { name: variant.language === 'de' ? /^Ab hier abzweigen/ : /^Fork from here/ }).click();
    await expect(panel.getByTestId('agent-sessions')).toHaveAttribute('data-state', 'ready');
    const picker = panel.getByTestId('agent-sessions');
    await picker.locator('.agent-session-trigger').click();
    await picker.getByRole('button', { name: variant.language === 'de' ? 'Neue Sitzung' : 'New session', exact: true }).click();
    await expect(picker).toHaveAttribute('data-state', 'ready');
    await expect(panel.locator('.agent-turn')).toHaveCount(0);
    await panel.getByRole('combobox').fill('Remember the ferryman’s route.');
    await panel.getByRole('button', { name: variant.language === 'de' ? 'Senden' : 'Send', exact: true }).click();
    await expect(panel.locator('.agent-turn')).toHaveClass(/is-done/);
    await expect(panel).toHaveAttribute('data-state', 'idle');
    await picker.locator('.agent-session-trigger').click();
    await picker.locator('li').filter({ hasText: variant.language === 'de' ? '· Abzweigung 1' : '· fork 1' }).getByRole('button', { name: variant.language === 'de' ? /^Sitzung .* öffnen$/ : /^Open session/ }).click();
  };

  test(`${variant.shell} ${variant.language} sessions stay bounded and return focus at ${variant.width}px`, async ({ page }, testInfo) => {
    await prepareThreeSessions(page);
    const panel = page.getByTestId('agent-panel');
    await page.setViewportSize({ width: variant.width, height: variant.height });
    const sessions = panel.getByTestId('agent-sessions');
    await expect(sessions).toHaveAttribute('data-open', 'false');
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`sessions-${variant.shell}-${variant.language}-${variant.width}-default.png`) });
    const toggle = sessions.locator('.agent-session-trigger');
    await toggle.click();
    await expect(sessions).toHaveAttribute('data-open', 'true');
    await expect(sessions.locator('.agent-session-list > li')).toHaveCount(3);
    const content = sessions.locator('.agent-sessions-content');
    await expect(content).toBeVisible();
    expect(await content.evaluate((element) => element.clientHeight)).toBeLessThanOrEqual(variant.height * 0.3);
    expect(await content.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const panel = element.closest('.agent')!.getBoundingClientRect();
      const inPanel = document.documentElement.dataset['shell'] !== 'modern' ||
        (box.top >= panel.top && box.bottom <= panel.bottom && box.left >= panel.left && box.right <= panel.right);
      return box.top >= 0 && box.bottom <= innerHeight && inPanel;
    })).toBe(true);
    if (variant.language === 'de') await expect(sessions.locator('.agent-session-actions > button').filter({ hasText: /^Öffnen$/ })).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(panel.getByRole('combobox')).toBeInViewport();
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`sessions-${variant.shell}-${variant.language}-${variant.width}-opened.png`) });
    const list = sessions.locator('.agent-session-list');
    const fork = list.locator('li[aria-current="true"]');
    await fork.locator('strong').scrollIntoViewIfNeeded();
    await expect(fork.locator('strong')).toBeInViewport({ ratio: 1 });
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`sessions-${variant.shell}-${variant.language}-${variant.width}-opened-fork.png`) });
    await list.hover();
    const beforeWheel = await list.evaluate((element) => element.scrollTop);
    await page.mouse.wheel(0, 1000);
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(beforeWheel);
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    let remaining = await list.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
    for (let wheel = 1; remaining > 1 && wheel < 5; wheel++) {
      const top = await list.evaluate((element) => element.scrollTop);
      await page.mouse.wheel(0, 1000);
      await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(top);
      remaining = await list.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
    }
    if (remaining > 1) throw new Error('the saved-session list did not reach its measured bottom within five native wheels');
    const last = list.locator('li').last();
    const lastOpen = last.locator('.agent-session-actions > button').first();
    await expect(lastOpen).toBeInViewport({ ratio: 1 });
    await content.getByRole('button', { name: variant.language === 'de' ? 'Neue Sitzung' : 'New session', exact: true }).focus();
    for (let index = 0; index < 12 && !(await lastOpen.evaluate((element) => element === document.activeElement)); index++) await page.keyboard.press('Tab');
    await expect(lastOpen).toBeFocused();
    await expect(lastOpen).toBeInViewport({ ratio: 1 });
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`sessions-${variant.shell}-${variant.language}-${variant.width}-opened-last.png`) });
    await toggle.press('Escape');
    await expect(sessions).toHaveAttribute('data-open', 'false');
    await expect(toggle).toBeFocused();
  });

  test(`${variant.shell} ${variant.language} session Data fits at ${variant.width}px`, async ({ page }, testInfo) => {
    await prepareThreeSessions(page);
    await openSettings(page, variant.shell, variant.language);
    const settings = page.getByTestId('settings');
    await settings.locator('[data-section="data"]').click();
    await expect(settings.getByTestId('agent-session-storage')).toBeVisible();
    await page.setViewportSize({ width: variant.width, height: variant.height });
    await settings.locator('#settings-agent-sessions').evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`sessions-${variant.shell}-${variant.language}-${variant.width}-data.png`) });
  });

  test(`${variant.shell} ${variant.language} session turn actions and deletion fit at ${variant.width}px`, async ({ page }, testInfo) => {
    await prepareThreeSessions(page);
    const panel = page.getByTestId('agent-panel');
    await page.setViewportSize({ width: variant.width, height: variant.height });
    const sessions = panel.getByTestId('agent-sessions');
    const toggle = sessions.locator('.agent-session-trigger');
    const menu = panel.getByTestId('turn-menu');
    await menu.getByRole('button').click();
    const actions = menu.getByRole('group');
    await actions.scrollIntoViewIfNeeded();
    expect(await actions.evaluate((element) => Array.from(element.querySelectorAll('button')).every((button) => {
      const [label, hint] = button.children;
      return label !== undefined && hint !== undefined && hint.getBoundingClientRect().top >= label.getBoundingClientRect().bottom;
    }))).toBe(true);
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`sessions-${variant.shell}-${variant.language}-${variant.width}-turn-actions.png`) });
    await menu.locator('.turn-menu-toggle').press('Escape');
    await toggle.click();
    const current = sessions.locator('li[aria-current="true"]');
    await current.locator('.agent-session-actions > details > summary').click();
    await current.getByRole('button', { name: variant.language === 'de' ? /^Sitzung .* löschen$/ : /^Delete session / }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`sessions-${variant.shell}-${variant.language}-${variant.width}-delete.png`) });
  });
}
