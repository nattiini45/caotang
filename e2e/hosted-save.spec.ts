import { expect, test } from '@playwright/test';
import { generateProjectKey } from '../packages/crypto/src/index.js';
import { EncryptedRemoteArtifactFs, BlobPreconditionFailedError, saveProjectToAccount } from '../packages/remote-store/src/index.js';
import { FakeBlobServer } from '../packages/remote-store/test/fake-blob-server.js';
import { addDocument, createEmptyManifest, createProjectState } from '../packages/store/src/index.js';
import type * as Crypto from '../packages/crypto/src/index.js';
import type * as StudioHost from '../apps/desktop/src/app/studio-host.js';

test('the studio keeps an offline edit across reopen and reads the account only after the writer asks', async ({ page }, info) => {
  const origin = 'https://account.example';
  const server = new FakeBlobServer();
  const blobStore = server.client();
  const key = generateProjectKey();
  const scene = 'n_3W8RN2TQ6C';
  const original = 'The harbour was quiet.';
  const revised = 'The lamps were still burning.';
  const now = new Date(0);
  const project = createProjectState(createEmptyManifest('The Lighthouse', now));
  const projectId = project.manifest.project.id;
  addDocument(project, { id: scene, parentId: 'manuscript', title: 'The Landing', body: original, now });
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
  const open = async () => {
    await page.evaluate(async ({ origin, projectId, bytes }) => {
      const hostPath = '/src/app/studio-host.ts';
      const fixturePath = '/test/hosted-project-key-fixture.ts';
      const { setHostedProject } = await import(/* @vite-ignore */ hostPath) as typeof StudioHost;
      const { projectKey } = await import(/* @vite-ignore */ fixturePath) as { projectKey(bytes: Uint8Array): ReturnType<typeof Crypto.importProjectKey> };
      setHostedProject({ origin, projectId, device: 'device-one', key: await projectKey(Uint8Array.from(bytes)) });
    }, { origin, projectId, bytes: [...key.export()] });
    await page.getByRole('treeitem', { name: /^The Landing/ }).click();
  };
  await page.goto('/');
  await open();

  const editor = page.getByRole('textbox', { name: 'Document text' });
  const send = page.getByRole('button', { name: 'Send them to your account' });
  offline = true;
  await editor.fill(revised);
  await expect(send).toBeVisible();
  offline = false;

  await page.reload();
  await open();
  await expect(editor).toHaveText(original);
  await expect(send).toBeVisible();
  await send.click();
  await expect(page.getByRole('button', { name: 'Read them' })).toBeVisible();
  await expect(editor).toHaveText(original);
  const screenshot = info.outputPath('hosted-send.png');
  await page.screenshot({ path: screenshot });
  await info.attach('Hosted send acknowledged', { path: screenshot, contentType: 'image/png' });
  await page.getByRole('button', { name: 'Read them' }).click();
  await page.getByRole('treeitem', { name: /^The Landing/ }).click();
  await expect(editor).toHaveText(revised);
  await expect(page.getByRole('treeitem', { name: /The Landing.*5 words/ })).toBeVisible();
  await fs.refresh();
  expect(JSON.parse(await fs.read('caotang.json'))).toEqual(originalManifest);
});
