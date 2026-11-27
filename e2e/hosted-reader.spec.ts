import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type Axe from 'axe-core';
import { expect, test, type Page, type Route } from '@playwright/test';
import { generateProjectKey } from '../packages/crypto/src/index.js';
import { EncryptedRemoteArtifactFs, saveProjectToAccount } from '../packages/remote-store/src/index.js';
import { FakeBlobServer } from '../packages/remote-store/test/fake-blob-server.js';
import { addDocument, createEmptyManifest, createProjectState } from '../packages/store/src/index.js';

declare global {
  interface Window {
    testHostedReceiver: {
      receive(account: unknown, value: unknown): Promise<void>;
      lock(): void;
      projectKey(bytes: number[]): Promise<CryptoKey>;
      editorState(): unknown;
    };
    axe: typeof Axe;
    readerStorageReads: { queue: number; indexedDb: number };
  }
}

const origin = 'https://account.example';
const fixture = '/test/hosted-receiver.html';
const account = 'account-one';
const title = 'The Lantern Archive';
const scene = 'n_3W8RN2TQ6C';
const script = 'n_5HQ9ZK2V7B';

function latch() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

async function accountProject(mismatch = false) {
  const store = new FakeBlobServer().client();
  const key = generateProjectKey();
  const now = new Date(0);
  const state = createProjectState(createEmptyManifest(title, now));
  const projectId = mismatch ? createEmptyManifest('Other project', now).project.id : state.manifest.project.id;
  addDocument(state, { id: scene, parentId: 'manuscript', title: 'The Landing',
    body: 'The harbour lay **quiet**. Still, the keeper lifted the lantern and watched the tide carry its reflection past the breakwater.\n\n> Leave one light burning.\n\n[Logbook](https://manuscript.example/log) ![A small lantern](https://manuscript.example/picture.png)', now });
  addDocument(state, { id: script, parentId: 'research', title: 'The Signal', body: 'INT. LANTERN ROOM - NIGHT', now });
  state.manifest.tree.find((node) => node.id === script)!.kind = 'screenplay';
  const fs = await EncryptedRemoteArtifactFs.open({ store, projectId, projectKey: key });
  if (mismatch) await fs.writeAtomic('caotang.json', JSON.stringify(state.manifest));
  else expect((await saveProjectToAccount(fs, state)).kind).toBe('written');
  return { store, projectId, bytes: [...key.export()] };
}

async function serveProject(page: Page, project: Awaited<ReturnType<typeof accountProject>>, before?: (name: string, route: Route) => Promise<void>) {
  const calls: string[] = [];
  await page.route('https://manuscript.example/**', (route) => {
    calls.push(route.request().url());
    return route.abort();
  });
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request();
    calls.push(request.method());
    expect(request.method()).toBe('GET');
    const path = new URL(request.url()).pathname;
    expect(path).toMatch(new RegExp(`^/v1/projects/${project.projectId}/blobs/[a-z0-9-]+$`));
    expect(request.headers()['x-caotang-device']).toBeUndefined();
    const name = path.split('/').at(-1)!;
    await before?.(name, route);
    const blob = await project.store.get(name);
    const headers = {
      'Access-Control-Allow-Origin': new URL(page.url()).origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Expose-Headers': 'ETag',
    };
    await route.fulfill(blob === null ? { status: 404, headers } :
      { status: 200, headers: { ...headers, ETag: blob.etag }, body: Buffer.from(blob.bytes) });
  });
  return calls;
}

async function read(page: Page, { projectId, bytes }: Awaited<ReturnType<typeof accountProject>>) {
  await page.evaluate(async ({ projectId, bytes, account }) => {
    const frame = window.testHostedReceiver;
    await frame.receive(account, { mode: 'read', projectId, key: await frame.projectKey(bytes) });
  }, { projectId, bytes, account });
}

test('the read-only frame browses the encrypted account copy without starting studio storage or writing', async ({ page }, info) => {
  const project = await accountProject();
  const calls = await serveProject(page, project);
  await page.goto(fixture);
  const queue = `caotang.hosted-queue.${project.projectId}--${account}`;
  await page.evaluate((queue) => {
    localStorage.setItem(queue, 'Unsaved words only on this device');
    const reads = { queue: 0, indexedDb: 0 };
    window.readerStorageReads = reads;
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key: string) {
      if (key === queue) reads.queue += 1;
      return getItem.call(this, key);
    };
    const db = window.indexedDB;
    Object.defineProperty(window, 'indexedDB', { get() { reads.indexedDb += 1; return db; } });
  }, queue);
  const before = await page.evaluate(() => Object.entries(localStorage));
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await read(page, project);

  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.getByText('Read only', { exact: true })).toBeVisible();
  const binder = page.getByRole('navigation', { name: 'Binder' });
  const landing = binder.getByRole('button', { name: 'The Landing' });
  await expect(landing).toHaveAttribute('aria-current', 'true');
  const main = page.getByRole('main');
  await expect(main.locator('strong')).toHaveText('quiet');
  await expect(main.getByText('Leave one light burning.')).toBeVisible();
  await expect(main.getByText('A small lantern')).toBeVisible();
  await expect(main.getByRole('link')).toHaveCount(0);
  await expect(page.locator('[contenteditable], textarea')).toHaveCount(0);
  expect(calls).toEqual(['GET', 'GET', 'GET']);
  const screenshot = info.outputPath('reader-wide.png');
  await page.screenshot({ path: screenshot });
  await info.attach('Read-only manuscript', { path: screenshot, contentType: 'image/png' });

  await page.evaluate(readFileSync(createRequire(import.meta.url).resolve('axe-core'), 'utf8'));
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    const violations = await page.evaluate(async () => {
      const report = await window.axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
      });
      return report.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(({ target }) => target) }));
    });
    expect(violations, colorScheme).toEqual([]);
  }

  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to the page' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(main).toBeFocused();
  const signal = binder.getByRole('button', { name: 'The Signal' });
  await signal.focus();
  await page.keyboard.press('Enter');
  await expect(signal).toHaveAttribute('aria-current', 'true');
  await expect(main.getByText('INT. LANTERN ROOM - NIGHT')).toBeVisible();
  expect(calls).toEqual(['GET', 'GET', 'GET', 'GET']);
  expect(await page.evaluate(() => Object.entries(localStorage))).toEqual(before);
  expect(await page.evaluate(() => window.readerStorageReads)).toEqual({ queue: 0, indexedDb: 0 });
  expect(await page.evaluate(() => window.testHostedReceiver.editorState())).toEqual({ boots: 0, scope: null, project: null });
  expect(errors).toEqual([]);

  await page.evaluate(() => window.testHostedReceiver.lock());
  await expect(main).toHaveCount(0);
  await expect(page.getByText('INT. LANTERN ROOM - NIGHT')).toHaveCount(0);
});

test('the frame rejects invalid edit handoffs, and valid edit boots with the account source already set', async ({ page }) => {
  await page.goto(fixture);
  const result = await page.evaluate(async ({ account, projectId, bytes }) => {
    const frame = window.testHostedReceiver;
    const key = await frame.projectKey(bytes);
    const wrongKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, false, ['encrypt']);
    const failures = [];
    for (const handoff of [
      { mode: 'edit', projectId, key },
      { mode: 'read', projectId, key, device: 'writer-one' },
      { mode: 'write', projectId, key, device: 'writer-one' },
      { mode: 'edit', projectId, key: wrongKey, device: 'writer-one' },
    ]) {
      failures.push(await frame.receive(account, handoff).then(() => false, () => true));
    }
    const before = frame.editorState();
    await frame.receive(account, { mode: 'edit', projectId, key, device: 'writer-one', origin: 'https://elsewhere.example' });
    const during = frame.editorState();
    const refusedSwap = await frame.receive(account, { mode: 'read', projectId, key }).then(() => false, () => true);
    frame.lock();
    const refusedAfterLock = await frame.receive(account, { mode: 'edit', projectId, key, device: 'writer-one' }).then(() => false, () => true);
    return { failures, before, during, refusedSwap, refusedAfterLock, after: frame.editorState() };
  }, { account, projectId: 'p_example', bytes: [...generateProjectKey().export()] });
  expect(result).toEqual({
    failures: [true, true, true, true],
    before: { boots: 0, scope: null, project: null },
    during: { boots: 1, scope: account, project: { id: 'p_example', origin, device: 'writer-one', extractable: false } },
    refusedSwap: true,
    refusedAfterLock: true,
    after: { boots: 1, scope: account, project: null },
  });
});

test('locking a loading frame cancels the fetch without showing the project', async ({ page }) => {
  const project = await accountProject();
  const requestArrived = latch();
  const response = latch();
  await serveProject(page, project, async () => {
    requestArrived.release();
    await response.wait;
  });
  await page.goto(fixture);
  const failedRead = page.waitForEvent('requestfailed', (request) => new URL(request.url()).origin === origin);
  try {
    await read(page, project);
    await requestArrived.wait;
    await expect(page.getByRole('status')).toHaveText('Reading the project');
    await page.evaluate(() => window.testHostedReceiver.lock());
    await failedRead;
    await expect(page.getByRole('main')).toHaveCount(0);
  } finally {
    response.release();
  }
});

test('a mismatched manifest is refused in the reader’s language', async ({ page }) => {
  const project = await accountProject(true);
  await serveProject(page, project);
  await page.goto(`${fixture}?language=de`);
  await read(page, project);
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(page.getByRole('alert')).toHaveText('Dieses Projekt konnte nicht gelesen werden.');
  await expect(page.getByRole('heading', { name: title })).toHaveCount(0);
});

test('the reader observes the selected account’s rollback floor and retries without changing either account’s marks', async ({ page }) => {
  const project = await accountProject();
  const calls = await serveProject(page, project);
  await page.goto(fixture);
  const marks = `caotang.hosted-marks.${project.projectId}--`;
  await page.evaluate(({ marks, account }) => {
    localStorage.setItem(marks + account, '[["manifest",999]]');
    localStorage.setItem(marks + 'other-account', '[["manifest",999]]');
  }, { marks, account });
  await read(page, project);
  await expect(page.getByRole('alert')).toHaveText('This project could not be read.');
  expect(calls).toEqual(['GET']);

  await page.evaluate((key) => localStorage.removeItem(key), marks + account);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('main').locator('strong')).toHaveText('quiet');
  expect(await page.evaluate(({ marks, account }) => [
    localStorage.getItem(marks + account), localStorage.getItem(marks + 'other-account'),
  ], { marks, account })).toEqual([null, '[["manifest",999]]']);
});

test('the German reader fits a narrow viewport without horizontal scrolling', async ({ page }, info) => {
  const project = await accountProject();
  await serveProject(page, project);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${fixture}?language=de`);
  await read(page, project);
  await expect(page.getByText('Nur lesen', { exact: true })).toBeVisible();
  await expect(page.getByRole('main').locator('strong')).toHaveText('quiet');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  const screenshot = info.outputPath('reader-narrow.png');
  await page.screenshot({ path: screenshot });
  await info.attach('Read-only manuscript at 390 pixels', { path: screenshot, contentType: 'image/png' });
});
