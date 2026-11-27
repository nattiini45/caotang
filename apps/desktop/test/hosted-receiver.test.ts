// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createHostedProjectReceiver } from '../src/app/hosted-receiver.js';
import { hostedProject } from '../src/app/studio-host.js';
import { setStorageScope } from '../src/app/storage-scope.js';

const origin = 'https://account.example';

it.each(['account.example', 'https://', 'http://account.example', 'https://account.example/projects'])(
  'refuses the invalid account origin %s with a protocol code',
  (badOrigin) => {
    expect(() => createHostedProjectReceiver({ origin: badOrigin, root: document.body, bootEditor: vi.fn() }))
      .toThrow(expect.objectContaining({ name: 'HostedHandoffError', code: 'invalid-origin' }));
  },
);

it('classifies a malformed account, project label, key or mode without booting the editor', async () => {
  const bootEditor = vi.fn();
  const frame = createHostedProjectReceiver({ origin, root: document.body, bootEditor });
  const bytes = new Uint8Array(32);
  const key = await webcrypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveBits']);
  const wrongUsage = await webcrypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveKey']);
  const extractableKey = await webcrypto.subtle.importKey('raw', bytes, 'AES-GCM', true, ['encrypt']);
  const project = { projectId: 'p_example', key, mode: 'edit', device: 'own-device' };
  for (const [account, handoff, code] of [
    ['invalid/account', project, 'invalid-account'],
    ['account-one', { ...project, projectId: '' }, 'invalid-project'],
    ['account-one', { ...project, key: wrongUsage }, 'invalid-project'],
    ['account-one', { ...project, key: extractableKey }, 'invalid-project'],
    ['account-one', { ...project, device: 'wrong/device' }, 'invalid-mode-or-device'],
    ['account-one', { ...project, mode: 'read' }, 'invalid-mode-or-device'],
  ] as const) {
    await expect(frame.receive(account, handoff)).rejects.toMatchObject({ code });
  }
  expect(bootEditor).not.toHaveBeenCalled();
});

it('lets only the trusted entry supply the account transport and clears it on lock', async () => {
  const entryFetch = vi.fn<typeof fetch>();
  const handedFetch = vi.fn<typeof fetch>();
  const bootEditor = vi.fn();
  const frame = createHostedProjectReceiver({ origin, root: document.body, bootEditor, fetch: entryFetch });
  const key = await webcrypto.subtle.importKey('raw', new Uint8Array(32), 'HKDF', false, ['deriveBits']);
  try {
    await frame.receive('account-one', { projectId: 'p_example', key, mode: 'edit', device: 'own-device', fetch: handedFetch });
    expect(hostedProject()).toEqual({ origin, projectId: 'p_example', device: 'own-device', key, fetch: entryFetch });
    expect(bootEditor).toHaveBeenCalledTimes(1);
  } finally {
    frame.lock();
    setStorageScope(null);
  }
  expect(hostedProject()).toBeNull();
});
