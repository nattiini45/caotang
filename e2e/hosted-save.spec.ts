import { expect, test } from '@playwright/test';
import { generateProjectKey } from '../packages/crypto/src/index.js';
import { EncryptedRemoteArtifactFs, BlobPreconditionFailedError, saveProjectToAccount } from '../packages/remote-store/src/index.js';
import { FakeBlobServer } from '../packages/remote-store/test/fake-blob-server.js';
import { addDocument, createEmptyManifest, createProjectState } from '../packages/store/src/index.js';
import type * as Crypto from '../packages/crypto/src/index.js';
import type * as StudioHost from '../apps/desktop/src/app/studio-host.js';

for (const shell of ['classic', 'modern'] as const) test(`the ${shell} studio reports account saves and keeps an offline edit across a reopen`, async ({ page }, info) => {
  test.setTimeout(60_000);
  await page.addInitScript((shell) => {
    localStorage.setItem('caotang.interface', shell);
    const storage = Object.getPrototypeOf(navigator.storage) as Record<string, unknown>;
    storage['persisted'] = async () => false;
    storage['persist'] = async () => false;
  }, shell);
  const origin = 'https://account.example';
  const server = new FakeBlobServer();
  const blobStore = server.client();
  const key = generateProjectKey();
  const scene = 'n_3W8RN2TQ6C';
  const other = 'n_5HQ9ZK2V7B';
  const original = 'The harbour was quiet.';
  const revised = 'The lamps were still burning.';
  const beforeRead = 'The keeper set another lamp outside.';
  const now = new Date(0);
  const project = createProjectState(createEmptyManifest('The Lighthouse', now));
  const projectId = project.manifest.project.id;
  addDocument(project, { id: scene, parentId: 'manuscript', title: 'The Landing', body: original, now });
  addDocument(project, { id: other, parentId: 'manuscript', title: 'The Watch', body: 'The bell rang.', now });
  const fs = await EncryptedRemoteArtifactFs.open({ store: blobStore, projectId, projectKey: key });
  expect((await saveProjectToAccount(fs, project)).kind).toBe('written');
  const originalManifest = JSON.parse(await fs.read('caotang.json'));

  let offline = false;
  await page.route(`${origin}/v1/projects/${projectId}/blobs/**`, async (route) => {
    const request = route.request();
    const headers = {
      'Access-Control-Allow-Origin': request.headers().origin ?? new URL(page.url()).origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, If-Match, If-None-Match, Idempotency-Key, X-Caotang-Device',
      'Access-Control-Expose-Headers': 'ETag',
    };
    const method = request.method();
    if (method === 'OPTIONS') return await route.fulfill({ status: 204, headers });
    if (offline) return await route.fulfill({ status: 503, headers });
    const name = new URL(request.url()).pathname.split('/').at(-1)!;
    if (method === 'GET') {
      const file = await blobStore.get(name);
      return await route.fulfill(file === null
        ? { status: 404, headers }
        : { status: 200, headers: { ...headers, ETag: file.etag }, body: Buffer.from(file.bytes) });
    }
    if (method === 'DELETE') {
      await blobStore.delete(name);
      return await route.fulfill({ status: 204, headers });
    }
    expect(method).toBe('PUT');
    const match = request.headers()['if-match'];
    try {
      const file = await blobStore.put(name, request.postDataBuffer()!, match === undefined ? { ifNoneMatch: '*' } : { ifMatch: match });
      await route.fulfill({ status: 201, headers: { ...headers, ETag: file.etag } });
    } catch (error) {
      if (!(error instanceof BlobPreconditionFailedError)) throw error;
      await route.fulfill({ status: 412, headers });
    }
  });
  const chooseScene = async (title: RegExp) => {
    const item = page.getByRole('treeitem', { name: title });
    if (shell === 'modern') {
      const binder = page.getByRole('navigation', { name: 'Binder' }).getByRole('button', { name: 'Binder', exact: true });
      await expect(binder).toBeVisible();
      if (!(await item.isVisible())) await binder.click();
    }
    await item.click();
  };
  const open = async () => {
    await page.evaluate(async ({ origin, projectId, bytes }) => {
      const hostPath = '/src/app/studio-host.ts';
      const fixturePath = '/test/hosted-project-key-fixture.ts';
      const { setHostedProject } = await import(/* @vite-ignore */ hostPath) as typeof StudioHost;
      const { projectKey } = await import(/* @vite-ignore */ fixturePath) as { projectKey(bytes: Uint8Array): ReturnType<typeof Crypto.importProjectKey> };
      setHostedProject({ origin, projectId, device: 'device-one', key: await projectKey(Uint8Array.from(bytes)) });
    }, { origin, projectId, bytes: [...key.export()] });
    await chooseScene(/^The Landing/);
  };
  await page.goto('/');
  await open();

  const editor = page.getByRole('textbox', { name: 'Document text' });
  const status = page.getByTestId('save-state');
  const send = page.getByRole('button', { name: 'Send them to your account' });
  await expect(status).toHaveText('Your account has the changes.');
  await expect(page.getByTestId('storage-banner')).toHaveCount(0);
  await expect(page.getByText('All changes saved in this browser', { exact: true })).toHaveCount(0);
  offline = true;
  await editor.fill(revised);
  await expect(send).toBeVisible();
  await expect(status).toHaveText('Saved here, not to your account.');
  await expect(page.getByTestId('document-save-state')).toHaveCount(0);
  offline = false;

  await page.reload();
  await open();
  await expect(editor).toHaveText(original);
  await expect(send).toBeVisible();
  await expect(status).toHaveText('Saved here, not to your account.');
  await send.click();
  await expect(page.getByRole('button', { name: 'Read them' })).toBeVisible();
  await expect(editor).toHaveText(original);
  await expect(page.getByText('Your account has the changes.', { exact: true })).toHaveCount(1);
  await expect(status).toHaveCount(0);
  const screenshot = info.outputPath('hosted-send.png');
  await page.screenshot({ path: screenshot });
  await info.attach('Hosted send acknowledged', { path: screenshot, contentType: 'image/png' });
  await editor.fill(beforeRead);
  await expect(page.getByRole('status').filter({ hasText: /Read before sending these files: .*The Landing/ })).toBeVisible();
  await expect(send).not.toBeVisible();
  const waiting = info.outputPath('hosted-read-before-send.png');
  await page.screenshot({ path: waiting });
  await info.attach('A further edit waits for an account read', { path: waiting, contentType: 'image/png' });
  await fs.refresh();
  await fs.writeAtomic(`docs/${other}.md`, 'Another device heard the bell.');
  await chooseScene(/^The Watch/);
  await editor.fill('The keeper put down the bell.');
  await send.click();
  const conflict = page.getByRole('dialog', { name: 'Another device saved these first' });
  await expect(status).toHaveText('Another device saved these first');
  await expect(conflict).toContainText(/Read before sending these files: .*The Landing/);
  const question = info.outputPath('hosted-conflict-with-waiting-file.png');
  await page.screenshot({ path: question });
  await info.attach('The conflict includes the waiting file and a read action', { path: question, contentType: 'image/png' });
  await conflict.getByRole('button', { name: 'Read them' }).click();
  await chooseScene(/^The Landing/);
  await expect(editor).toHaveText(revised);
  await expect(page.getByRole('treeitem', { name: /The Landing.*5 words/ })).toBeVisible();
  await expect(send).toBeVisible();
  await send.click();
  await conflict.getByRole('button', { name: 'Keep this device’s text' }).click();
  await page.getByRole('button', { name: 'Read them' }).click();
  await chooseScene(/^The Landing/);
  await expect(editor).toHaveText(beforeRead);
  await fs.refresh();
  expect(JSON.parse(await fs.read('caotang.json'))).toEqual(originalManifest);
  if (shell === 'modern') {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId('modern-title-capsule').click();
    await expect(page.getByTestId('scene-info-save-state')).toHaveText('Your account has the changes.');
    await expect(page.getByTestId('storage-banner')).toHaveCount(0);
  }
});
