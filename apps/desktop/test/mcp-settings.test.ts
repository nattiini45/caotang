import { beforeEach, expect, it, vi } from 'vitest';
import { createMockWire, EMPTY_MCP_SETTINGS, type McpSettings } from '@caotang/mcp-client';
import { McpApp, type McpKeyPort, type McpSettingsPort } from '../src/app/mcp.js';
import { activateEnglish } from '../src/i18n/runtime.js';

beforeEach(activateEnglish);

function fixture(close?: () => Promise<void>) {
  let value = EMPTY_MCP_SETTINGS;
  const writes: McpSettings[] = [];
  const save = vi.fn<() => Promise<string | null>>().mockResolvedValue(null);
  const settings: McpSettingsPort = {
    current: () => value,
    update: async ({ mcp }) => {
      writes.push(structuredClone(mcp));
      const refusal = await save();
      if (refusal === null) value = mcp;
      return refusal;
    },
  };
  const tokens = new Map<string, string>();
  const keys: McpKeyPort = {
    put: async (ref, token) => { tokens.set(ref, token); },
    reveal: async (ref) => tokens.get(ref),
    has: async (ref) => tokens.has(ref),
    remove: async (ref) => { tokens.delete(ref); },
  };
  const wire = vi.fn(() => {
    const value = createMockWire({ listTools: [{ name: 'search', description: '', inputSchema: {} }], respond: () => ({ content: [] }) });
    if (close !== undefined) value.close = close;
    return value;
  });
  const app = new McpApp({ settings, keys, wire });
  return { app, save, writes, tokens, keys, settings, wire };
}

async function add(app: McpApp, token?: string) {
  const outcome = await app.addServer({ name: 'Shelf', url: 'https://shelf.example/mcp', ...(token === undefined ? {} : { token }) });
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.server;
}

it('asks the settings store to publish its slice only after saving', async () => {
  const { settings, keys } = fixture();
  const update = vi.spyOn(settings, 'update');
  const app = new McpApp({ settings, keys });
  await add(app);
  expect(update).toHaveBeenCalledWith({ mcp: app.client.settings() }, { publishAfterSave: true });
});

it('returns the settings refusal when adding a server and takes back its token', async () => {
  const { app, save, tokens } = fixture();
  save.mockResolvedValueOnce('Settings storage is full.');
  expect(await app.addServer({ name: 'Shelf', url: 'https://shelf.example/mcp', token: 'fixture-token' })).toEqual({ ok: false, message: 'Settings storage is full.' });
  expect(tokens.size).toBe(0);
  expect(app.client.settings().servers).toEqual([]);
  expect((await app.addServer({ name: 'Shelf', url: 'https://shelf.example/mcp' })).ok).toBe(true);
});

it('awaits one disabled import write and reports each refused save', async () => {
  const { app, save, writes } = fixture();
  let finish!: (refusal: string | null) => void;
  save.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  let settled = false;
  const imported = Promise.resolve(app.importServers(JSON.stringify({ servers: [{ name: 'Off', url: 'https://off.example/mcp', enabled: false }] }), '2026-11-10T00:00:00Z')).then((result) => { settled = true; return result; });
  await vi.waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]?.servers[0]?.enabled).toBe(false);
  expect(settled).toBe(false);
  finish('Settings storage is full.');
  expect(await imported).toEqual({ added: [], refused: [{ entry: '"Off"', reason: 'Settings storage is full.' }] });
  expect(app.client.settings().servers).toEqual([]);
  const retried = await app.importServers(JSON.stringify({ servers: [{ name: 'Off', url: 'https://off.example/mcp', enabled: false }] }), '2026-11-10T00:00:00Z');
  expect(retried.added).toEqual(['Off']);
  expect(writes).toHaveLength(2);
});

it.each([undefined, 'old-fixture-token'])('rolls back a refused token change, including replacement of %s', async (previous) => {
  const { app, save, tokens } = fixture();
  const server = await add(app, previous);
  const before = [...tokens];
  save.mockResolvedValueOnce('Settings storage is full.');
  expect(await app.setToken(server.key, 'new-fixture-token')).toEqual({ ok: false, message: 'Settings storage is full.' });
  expect([...tokens]).toEqual(before);
  expect(app.client.serverFor(server.key)?.auth).toEqual(server.auth);
});

it('rolls back a token if the vault put mutates and then rejects', async () => {
  const { app, keys, tokens } = fixture();
  const server = await add(app, 'old-fixture-token');
  const before = [...tokens];
  const put = keys.put;
  vi.spyOn(keys, 'put').mockImplementationOnce(async (ref, token) => {
    await put(ref, token);
    throw new Error('Vault write failed.');
  });
  expect(await app.setToken(server.key, 'new-fixture-token')).toEqual({ ok: false, message: 'Vault write failed.' });
  expect([...tokens]).toEqual(before);
});

it('serializes token replacements so a refused replacement cannot undo the next one', async () => {
  const { app, save, tokens } = fixture();
  const server = await add(app, 'old-fixture-token');
  let finish!: (refusal: string | null) => void;
  save.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const first = app.setToken(server.key, 'refused-fixture-token');
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  const second = app.setToken(server.key, 'kept-fixture-token');
  finish('Settings storage is full.');
  expect((await first).ok).toBe(false);
  expect((await second).ok).toBe(true);
  expect([...tokens.values()]).toEqual(['kept-fixture-token']);
});

it('does not revive an old token when the server disappears during the vault write', async () => {
  const { app, keys, tokens } = fixture();
  const server = await add(app, 'old-fixture-token');
  let finish!: () => void;
  const put = keys.put;
  vi.spyOn(keys, 'put').mockImplementationOnce(async (ref, token) => {
    await put(ref, token);
    await new Promise<void>((resolve) => { finish = resolve; });
  });
  const replaced = app.setToken(server.key, 'new-fixture-token');
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  await app.removeServer(server.key);
  finish();
  expect((await replaced).ok).toBe(false);
  expect(tokens.size).toBe(0);
});

it.each([
  { patch: { url: 'https://other.example/mcp' }, queued: false },
  { patch: { url: 'https://other.example/mcp' }, queued: true },
  { patch: { auth: { kind: 'none' as const } }, queued: false },
])('refuses a stale token after configuration changes: %j', async ({ patch, queued }) => {
  const { app, keys, tokens, save, writes } = fixture();
  const server = await add(app, 'old-fixture-token');
  let finishPut!: () => void;
  const put = keys.put;
  vi.spyOn(keys, 'put').mockImplementationOnce(async (ref, token) => {
    await put(ref, token);
    await new Promise<void>((resolve) => { finishPut = resolve; });
  });
  const update = vi.spyOn(app.client, 'updateServer');
  const replaced = app.setToken(server.key, 'new-fixture-token');
  await vi.waitFor(() => expect(finishPut).toBeTypeOf('function'));
  let finishSave!: (refusal: string | null) => void;
  if (queued) save.mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
  const changed = app.client.updateServer(server.key, patch);
  if (queued) await vi.waitFor(() => expect(finishSave).toBeTypeOf('function'));
  else expect((await changed).ok).toBe(true);
  finishPut();
  if (queued) {
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    finishSave(null);
    expect((await changed).ok).toBe(true);
  }
  expect((await replaced).ok).toBe(false);
  expect(app.client.serverFor(server.key)?.auth).toEqual({ kind: 'none' });
  expect(app.client.serverFor(server.key)?.url).toBe(patch.url ?? server.url);
  expect(tokens.size).toBe(0);
  expect(writes).toHaveLength(2);
});

it('keeps a later settings mutation after an earlier refusal and exposes only committed changes', async () => {
  const { app, save } = fixture();
  const server = await add(app);
  let finish!: (refusal: string | null) => void;
  save.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const first = app.client.updateServer(server.key, { name: 'Refused' });
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(app.client.serverFor(server.key)?.name).toBe('Shelf');
  const second = app.client.updateServer(server.key, { name: 'Kept' });
  finish('Settings storage is full.');
  expect((await first).ok).toBe(false);
  expect((await second).ok).toBe(true);
  expect(app.client.serverFor(server.key)?.name).toBe('Kept');
});

it('never deletes a named credential when removing or changing its server is refused', async () => {
  const { app, save, tokens } = fixture();
  const server = await add(app, 'fixture-token');
  save.mockResolvedValue('Settings storage is full.');
  expect(await app.client.updateServer(server.key, { url: 'https://other.example/mcp' })).toEqual({ ok: false, error: 'Settings storage is full.' });
  await expect(app.removeServer(server.key)).rejects.toThrow('Settings storage is full.');
  expect(app.client.serverFor(server.key)).toEqual(server);
  expect([...tokens.values()]).toEqual(['fixture-token']);
});

it('returns review, trust, selection and master-switch save refusals without granting unsaved permissions', async () => {
  const { app, save } = fixture();
  const server = await add(app);
  await app.client.setMasterEnabled(true);
  await app.connect(server.key);
  const review = app.client.review(server.key)!;
  save.mockResolvedValueOnce('Review was not saved.');
  expect(await app.client.approveReview(server.key, review.fingerprint)).toEqual({ ok: false, error: 'Review was not saved.' });
  expect(app.client.healthOf(server.key)?.state).not.toBe('healthy');
  expect((await app.client.approveReview(server.key, review.fingerprint)).ok).toBe(true);
  save.mockResolvedValueOnce('Trust was not saved.');
  expect(await app.client.setTrustReads(server.key, true)).toEqual({ ok: false, error: 'Trust was not saved.' });
  expect(app.client.serverFor(server.key)?.trustReads).toBe(false);
  save.mockResolvedValueOnce('Selection was not saved.');
  expect(await app.client.setToolEnabled(server.key, 'search', false)).toEqual({ ok: false, error: 'Selection was not saved.' });
  expect(app.client.listTools(server.key)[0]?.enabled).toBe(true);
  save.mockResolvedValueOnce('Switch was not saved.');
  await expect(app.client.setMasterEnabled(false)).rejects.toThrow('Switch was not saved.');
  expect(app.client.settings().enabled).toBe(true);
});

it.each([null, 'Approval storage refused.'])('serializes a disconnect with its pending review save: %s', async (refusal) => {
  const { app, save, settings, writes } = fixture();
  const server = await add(app);
  await app.client.setMasterEnabled(true);
  await app.connect(server.key);
  let finish!: (refusal: string | null) => void;
  save.mockResolvedValue('Rollback storage refused.');
  save.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const approved = app.client.approveReview(server.key, app.client.review(server.key)!.fingerprint);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  const disconnected = app.client.disconnect(server.key);
  finish(refusal);
  const outcome = await approved;
  await disconnected;
  if (!outcome.ok) expect(settings.current().servers[0]!.pinnedTools).toEqual({});
  expect(app.client.healthOf(server.key)?.state).toBe('configured');
  expect(Object.keys(settings.current().servers[0]!.pinnedTools)).toHaveLength(refusal === null ? 1 : 0);
  expect(writes).toHaveLength(3);
  expect((await app.connect(server.key)).state).toBe(outcome.ok ? 'healthy' : 'connected');
  expect(outcome.ok).toBe(refusal === null);
});

it.each([
  { refusal: null, catalog: false },
  { refusal: 'Approval storage refused.', catalog: false },
  { refusal: null, catalog: true },
  { refusal: 'Approval storage refused.', catalog: true },
])('keeps persisted review pins consistent when a fingerprint changes during its save: %j', async ({ refusal, catalog }) => {
  const { app, save, settings, writes, wire } = fixture();
  if (catalog) wire.mockImplementation(() => createMockWire({
    listTools: [{ name: 'search', description: '', inputSchema: {} }],
    prompts: [{ name: 'recap', description: 'Original prompt.' }],
    respond: () => ({ content: [] }),
  }));
  const server = await add(app);
  await app.client.setMasterEnabled(true);
  await app.connect(server.key);
  const review = app.client.review(server.key)!;
  let finish!: (refusal: string | null) => void;
  save.mockResolvedValue('Rollback storage refused.');
  save.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const approved = app.client.approveReview(server.key, review.fingerprint);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  const listed = catalog
    ? vi.spyOn(wire.mock.results[0]!.value, 'listPrompts').mockResolvedValue([{ name: 'recap', description: 'Changed prompt.' }])
    : vi.spyOn(wire.mock.results[0]!.value, 'listTools').mockResolvedValue([{ name: 'search', description: 'Changed definition.', inputSchema: {} }]);
  const capabilities = vi.spyOn(wire.mock.results[0]!.value, 'capabilities');
  const refreshed = catalog ? app.client.refreshCatalog(server.key) : app.refresh(server.key);
  await vi.waitFor(() => expect(listed).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(capabilities).toHaveBeenCalledOnce());
  expect(app.client.review(server.key)?.fingerprint).toBe(review.fingerprint);
  finish(refusal);
  const outcome = await approved;
  if (!outcome.ok) expect(settings.current().servers[0]!.pinnedTools).toEqual({});
  expect(outcome.ok).toBe(refusal === null);
  await refreshed;
  expect(app.client.review(server.key)?.fingerprint).not.toBe(review.fingerprint);
  expect(catalog ? app.client.listPrompts(server.key)[0]?.pinState : app.client.listTools(server.key)[0]?.pinState).toBe(refusal === null ? 'changed' : 'new');
  expect(Object.keys(settings.current().servers[0]!.pinnedTools)).toHaveLength(refusal === null ? 1 : 0);
  if (refusal === null) expect(settings.current().servers[0]!.pinnedTools[review.tools[0]!.qualifiedName]?.hash).toBe(review.tools[0]!.candidateHash);
  if (catalog) expect(Object.keys(settings.current().servers[0]!.pinnedPrompts ?? {})).toHaveLength(refusal === null ? 1 : 0);
  const kept = settings.current();
  expect((await app.client.approveReview(server.key, review.fingerprint)).ok).toBe(false);
  expect(settings.current()).toEqual(kept);
  expect(writes).toHaveLength(3);
  await app.client.disconnect(server.key);
  expect((await app.connect(server.key)).state).toBe(refusal === null ? 'healthy' : 'connected');
});

it('keeps the live connection when a disruptive settings change is refused', async () => {
  const { app, save } = fixture();
  const server = await add(app);
  await app.client.setMasterEnabled(true);
  await app.connect(server.key);
  await app.client.approveReview(server.key, app.client.review(server.key)!.fingerprint);
  const before = app.client.settings();
  save.mockResolvedValue('Settings storage is full.');
  expect((await app.client.updateServer(server.key, { url: 'https://other.example/mcp' })).ok).toBe(false);
  await expect(app.client.setMasterEnabled(false)).rejects.toThrow('Settings storage is full.');
  await expect(app.removeServer(server.key)).rejects.toThrow('Settings storage is full.');
  expect(app.client.settings()).toEqual(before);
  expect(app.client.healthOf(server.key)?.state).toBe('healthy');
  expect(app.client.listTools(server.key)).toHaveLength(1);
});

it.each(['master-off', 'remove', 'disable'])('publishes the committed %s before waiting for the old connection to close', async (action) => {
  let finishClose!: () => void;
  const gate = new Promise<void>((resolve) => { finishClose = resolve; });
  const close = vi.fn(() => gate);
  const { app, wire, settings } = fixture(close);
  const server = await add(app);
  await app.client.setMasterEnabled(true);
  await app.connect(server.key);
  const changed = action === 'master-off'
    ? app.client.setMasterEnabled(false)
    : action === 'remove'
      ? app.removeServer(server.key)
      : app.client.updateServer(server.key, { enabled: false });
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  try {
    await app.connect(server.key);
    expect(wire).toHaveBeenCalledOnce();
    expect(app.client.settings()).toEqual(settings.current());
  } finally {
    finishClose();
    await changed;
  }
  expect(app.client.listTools(server.key)).toEqual([]);
});
