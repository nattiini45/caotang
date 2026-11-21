import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { Log, LogLevel, Miniflare, Response } from 'miniflare';
import type { Request as RuntimeRequest } from 'miniflare';
import WebSocketClient from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { accountOperatorSql } from '../account-policy.mjs';
import { applyMigrations } from './d1-fixture.js';
import { workerModules } from './worker-modules.js';

const ORIGIN = 'https://studio.example.invalid';
const SECRET = 'test-only-account-secret-not-a-real-credential';
const IDS: Record<string, number> = { 'reader-one': 101, 'reader-two': 202, 'uninvited-reader': 303 };
const hubs = `
export class TestAccountHub extends AccountHub {
  async runAlarm() { await this.alarm(); }
  async nextAlarm() { return this.ctx.storage.getAlarm(); }
  async ageProfile(profile) {
    for (const socket of this.ctx.getWebSockets()) {
      const value = socket.deserializeAttachment();
      if (value?.profile === profile) socket.serializeAttachment({ ...value, connectedAt: Date.now() - 60_001 });
    }
    await this.alarm();
  }
}
`;
const ONE = '00000000-0000-4000-8000-000000000001';
const TWO = '00000000-0000-4000-8000-000000000002';
const open: Miniflare[] = [];
const KEY_RECORD_PATH = '/v1/account/key-record';
const wrappedRecord = (fill: number) => ({
  format: 1,
  kdf: { id: 'argon2id', params: { memoryKiB: 65_536, iterations: 3, parallelism: 1 } },
  salt: Buffer.alloc(16, fill).toString('base64'),
  wrappedMaster: Buffer.concat([Buffer.of(1), Buffer.alloc(60, fill)]).toString('base64'),
});

/** A format-2 record: bound to the account that writes it, with a 32-byte verifier for its master key. */
const boundRecord = (accountId: string, fill: number) => ({
  format: 2,
  accountId,
  kdf: { id: 'argon2id', params: { memoryKiB: 65_536, iterations: 3, parallelism: 1 } },
  salt: Buffer.alloc(16, fill).toString('base64'),
  wrappedMaster: Buffer.concat([Buffer.of(1), Buffer.alloc(60, fill)]).toString('base64'),
  verifier: Buffer.alloc(32, fill).toString('base64'),
});

async function runtime(bindings: Record<string, string> = {}, options: { migrate?: boolean; database?: boolean; log?: Log } = {}) {
  const instance = new Miniflare({
    log: options.log,
    upstream: ORIGIN,
    modules: workerModules(hubs),
    compatibilityDate: '2026-07-30',
    bindings: { PUBLIC_ORIGIN: ORIGIN, GITHUB_CLIENT_ID: 'mock-client', GITHUB_CLIENT_SECRET: 'mock-secret', SESSION_SECRET: SECRET, AUTHENTICATION_MODE: 'accounts', ...bindings },
    ...(options.database === false ? {} : { d1Databases: { ACCOUNT_DB: `accounts-${crypto.randomUUID()}` } }),
    durableObjects: { ACCOUNT_HUBS: { className: 'TestAccountHub', useSQLite: true } },
    serviceBindings: { ASSETS: () => new Response('static shell') },
    outboundService: async (request: RuntimeRequest) => {
      const url = new URL(request.url);
      if (url.href === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: `mock-access-${new URLSearchParams(await request.text()).get('code')}` });
      if (url.href === 'https://api.github.com/user') {
        const login = request.headers.get('Authorization')!.replace('Bearer mock-access-', '');
        return Response.json({ id: IDS[login], login });
      }
      throw new Error('Unexpected outbound request in the local test.');
    },
  });
  open.push(instance);
  const address = String(await instance.ready);
  const db = options.database === false ? undefined : await instance.getD1Database('ACCOUNT_DB');
  if (db && options.migrate !== false) await applyMigrations(db, ['0001_accounts.sql']);
  const invite = (login: string, limitBytes = 1_000) => db!.prepare(accountOperatorSql({ type: 'invite', identity: { id: `github:${IDS[login]}`, login }, limitBytes })).run();
  const revoke = (login: string) => db!.prepare(accountOperatorSql({ type: 'revoke', githubId: `github:${IDS[login]}` })).run();
  const dispatch = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => instance.dispatchFetch(`${ORIGIN}${path}`, { redirect: 'manual', ...init });
  const signIn = async (login: string) => {
    const start = await dispatch('/v1/auth/github');
    const location = new URL(start.headers.get('Location')!);
    const pending = start.headers.getSetCookie()[0]!.split(';')[0]!;
    const finish = await dispatch(`/v1/auth/github/callback?${new URLSearchParams({ code: login, state: location.searchParams.get('state')! })}`, { headers: { Cookie: pending } });
    const session = finish.headers.getSetCookie().find((value) => value.startsWith('__Host-caotang-session='))?.split(';')[0];
    return { finish, session };
  };
  const connect = async (session: string, profile?: string) => {
    const url = new URL('/v1/live', address);
    url.protocol = 'ws:';
    if (profile) url.searchParams.set('presence', profile);
    const options = { headers: { Cookie: session, Origin: ORIGIN }, closeTimeout: 100 };
    const socket = new WebSocketClient(url.href, options);
    const messages: string[] = [];
    let closeCode: number | undefined;
    socket.on('message', (data) => messages.push(String(data)));
    socket.on('close', (code) => { closeCode = code; });
    await once(socket, 'open');
    return { socket, messages, get closeCode() { return closeCode; } };
  };
  return { instance, db, invite, revoke, dispatch, signIn, connect };
}

function signed(payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `__Host-caotang-session=${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`;
}

afterEach(async () => { await Promise.all(open.splice(0).map((instance) => instance.dispose())); });

describe('wrapped account key records', () => {
  it('applies the additive migration to existing accounts, elects one creator, and reads the winning record only for that account', async () => {
    const h = await runtime();
    await h.invite('reader-one');
    await h.invite('reader-two');
    const { session: first } = await h.signIn('reader-one');
    const { session: second } = await h.signIn('reader-two');
    const accountId = async (session: string) => {
      const account = await (await h.dispatch('/v1/account', { headers: { Cookie: session } })).json() as { id: string };
      return account.id;
    };
    const firstId = await accountId(first!);
    const secondId = await accountId(second!);
    const read = (session?: string, id = firstId) => h.dispatch(KEY_RECORD_PATH, {
      headers: session ? { Cookie: session, 'X-Caotang-Account': id } : {},
    });
    expect((await read(first)).status).toBe(503);
    await applyMigrations(h.db!, ['0004_account_key_records.sql', '0007_account_key_record_versions.sql']);
    expect((await read()).status).toBe(401);
    expect((await read(first)).status).toBe(404);
    const create = (record: object, origin = ORIGIN, method = 'POST', session = first!) => h.dispatch(KEY_RECORD_PATH, {
      method, headers: { Cookie: session, Origin: origin, 'Content-Type': 'application/json', 'X-Caotang-Account': firstId }, body: JSON.stringify(record),
    });
    const records = [wrappedRecord(1), wrappedRecord(2)];
    expect((await create(records[0]!, 'https://unrelated.example.invalid')).status).toBe(403);
    expect((await create(records[0]!, ORIGIN, 'POST', second!)).status).toBe(412);
    const attempts = await Promise.all(records.map((record) => create(record)));
    expect(attempts.map((response) => response.status).sort((a, b) => a - b)).toEqual([201, 409]);
    // A replacement needs a record and a precondition, and this account has only just created one.
    expect((await create(wrappedRecord(3), ORIGIN, 'DELETE')).status).toBe(405);
    expect((await create(wrappedRecord(3))).status).toBe(409);
    const winner = records[attempts.findIndex((response) => response.status === 201)]!;
    const { session: anotherDevice } = await h.signIn('reader-one');
    const loaded = await read(anotherDevice);
    expect(loaded.status).toBe(200);
    expect(loaded.headers.get('Cache-Control')).toBe('no-store');
    expect(await loaded.json()).toEqual(winner);
    expect((await read(second)).status).toBe(412);
    expect((await read(second, secondId)).status).toBe(404);
    expect(await h.db!.prepare('SELECT * FROM account_key_records').all()).toMatchObject({
      results: [{ account_id: firstId, record_json: JSON.stringify(winner) }],
    });
    await h.revoke('reader-one');
    expect((await read(anotherDevice)).status).toBe(401);
    expect((await create(wrappedRecord(3))).status).toBe(401);
  });

  it('refuses secret fields and invalid records without storing, logging or echoing their values', async () => {
    const messages: string[] = [];
    const h = await runtime({}, { log: new class extends Log {
      protected override log(message: string): void { messages.push(message); }
    }(LogLevel.VERBOSE) });
    await applyMigrations(h.db!, ['0004_account_key_records.sql', '0007_account_key_record_versions.sql']);
    await h.invite('reader-one');
    const { session } = await h.signIn('reader-one');
    const account = await (await h.dispatch('/v1/account', { headers: { Cookie: session! } })).json() as { id: string };
    const record = wrappedRecord(1);
    const passphrase = 'fictional-passphrase-that-must-not-be-echoed';
    const recoveryKey = 'fictional-recovery-key-that-must-not-be-echoed';
    for (const body of [
      JSON.stringify({ ...record, passphrase, recoveryKey }),
      JSON.stringify({ ...record, salt: recoveryKey }),
      JSON.stringify({ ...record, kdf: { ...record.kdf, params: { ...record.kdf.params, recoveryKey } } }),
      JSON.stringify({ ...record, kdf: { ...record.kdf, params: { ...record.kdf.params, memoryKiB: 262_145 } } }),
      JSON.stringify({ ...record, wrappedMaster: Buffer.alloc(61).toString('base64') }),
      JSON.stringify(record) + ' '.repeat(1024),
      '{"passphrase":"' + passphrase,
    ]) {
      const response = await h.dispatch(KEY_RECORD_PATH, {
        method: 'POST', headers: { Cookie: session!, Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Caotang-Account': account.id }, body,
      });
      expect(response.status).toBe(400);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toEqual({ message: 'Send a valid wrapped account key record.' });
    }
    expect(await h.db!.prepare('SELECT count(*) AS count FROM account_key_records').first('count')).toBe(0);
    expect(messages.join('\n')).not.toContain(passphrase);
    expect(messages.join('\n')).not.toContain(recoveryKey);
  });

  it('stores a record bound to the account that wrote it, and refuses one naming another account', async () => {
    const h = await runtime();
    await applyMigrations(h.db!, ['0004_account_key_records.sql', '0007_account_key_record_versions.sql']);
    await h.invite('reader-one');
    const { session } = await h.signIn('reader-one');
    const account = await (await h.dispatch('/v1/account', { headers: { Cookie: session! } })).json() as { id: string };
    const create = (body: string) => h.dispatch(KEY_RECORD_PATH, {
      method: 'POST', headers: { Cookie: session!, Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Caotang-Account': account.id }, body,
    });

    // A record naming another account is refused: the wrap is bound to an account, so storing it here would be a record this
    // account could never open.
    expect((await create(JSON.stringify(boundRecord(TWO, 5)))).status).toBe(400);
    // So is one whose verifier is missing or the wrong length.
    const { verifier: _omitted, ...withoutVerifier } = boundRecord(account.id, 6);
    expect((await create(JSON.stringify(withoutVerifier))).status).toBe(400);
    expect((await create(JSON.stringify({ ...boundRecord(account.id, 6), verifier: Buffer.alloc(16, 1).toString('base64') }))).status).toBe(400);
    expect(await h.db!.prepare('SELECT count(*) AS count FROM account_key_records').first('count')).toBe(0);

    const record = boundRecord(account.id, 7);
    expect((await create(JSON.stringify(record))).status).toBe(201);
    // It reads back exactly as it was written, bound record and all.
    const read = await h.dispatch(KEY_RECORD_PATH, { headers: { Cookie: session!, 'X-Caotang-Account': account.id } });
    expect(await read.json()).toEqual(record);
  });

  it('replaces the record only at the version it was read at, so two browsers changing a passphrase cannot overwrite each other', async () => {
    const h = await runtime();
    await applyMigrations(h.db!, ['0004_account_key_records.sql', '0007_account_key_record_versions.sql']);
    await h.invite('reader-one');
    const { session } = await h.signIn('reader-one');
    const account = await (await h.dispatch('/v1/account', { headers: { Cookie: session! } })).json() as { id: string };
    const headers = { Cookie: session!, 'X-Caotang-Account': account.id };
    const create = (body: string) => h.dispatch(KEY_RECORD_PATH, {
      method: 'POST', headers: { ...headers, Origin: ORIGIN, 'Content-Type': 'application/json' }, body,
    });
    const replace = (body: string, precondition?: string) => h.dispatch(KEY_RECORD_PATH, {
      method: 'PUT',
      headers: { ...headers, Origin: ORIGIN, 'Content-Type': 'application/json', ...(precondition === undefined ? {} : { 'If-Match': precondition }) },
      body,
    });

    // Nothing to replace yet, and a record that is not bound to this account is never a replacement.
    const first = boundRecord(account.id, 11);
    expect((await replace(JSON.stringify(first), '"1"')).status).toBe(404);
    expect((await create(JSON.stringify(first))).status).toBe(201);
    expect((await replace(JSON.stringify(wrappedRecord(12)), '"1"')).status).toBe(400);
    expect((await replace(JSON.stringify(boundRecord(TWO, 12)), '"1"')).status).toBe(400);
    expect((await replace(JSON.stringify(first))).status).toBe(400);

    const read = await h.dispatch(KEY_RECORD_PATH, { headers });
    expect(read.headers.get('ETag')).toBe('"1"');
    const second = boundRecord(account.id, 21);
    // A precondition this account has moved past is refused and writes nothing.
    expect((await replace(JSON.stringify(second), '"9"')).status).toBe(412);
    expect(await h.db!.prepare('SELECT record_json FROM account_key_records').first('record_json')).toBe(JSON.stringify(first));

    const replaced = await replace(JSON.stringify(second), '"1"');
    expect(replaced.status).toBe(200);
    expect(replaced.headers.get('ETag')).toBe('"2"');
    expect(await replaced.json()).toEqual({ version: 2 });
    expect(await h.db!.prepare('SELECT record_json FROM account_key_records').first('record_json')).toBe(JSON.stringify(second));
    expect((await h.dispatch(KEY_RECORD_PATH, { headers })).headers.get('ETag')).toBe('"2"');
    // The version the record just left is spent: replaying it cannot overwrite what replaced it.
    expect((await replace(JSON.stringify(boundRecord(account.id, 31)), '"1"')).status).toBe(412);
    expect(await h.db!.prepare('SELECT record_json FROM account_key_records').first('record_json')).toBe(JSON.stringify(second));
    expect((await replace(JSON.stringify(boundRecord(account.id, 41)), '"2"')).status).toBe(200);

    // A revoked session cannot replace anything.
    await h.revoke('reader-one');
    expect((await replace(JSON.stringify(boundRecord(account.id, 51)), '"3"')).status).toBe(401);
  });

  it('refuses a wrapped record no browser could unlock, leaving the account’s single slot free', async () => {
    const h = await runtime();
    await applyMigrations(h.db!, ['0004_account_key_records.sql', '0007_account_key_record_versions.sql']);
    await h.invite('reader-one');
    const { session } = await h.signIn('reader-one');
    const account = await (await h.dispatch('/v1/account', { headers: { Cookie: session! } })).json() as { id: string };
    const create = (body: string) => h.dispatch(KEY_RECORD_PATH, {
      method: 'POST', headers: { Cookie: session!, Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Caotang-Account': account.id }, body,
    });
    const record = wrappedRecord(2);
    for (const body of [
      JSON.stringify({ ...record, salt: '' }),
      JSON.stringify({ ...record, salt: Buffer.alloc(8, 3).toString('base64') }),
      JSON.stringify({ ...record, salt: Buffer.alloc(65, 3).toString('base64') }),
      JSON.stringify({ ...record, wrappedMaster: '' }),
      JSON.stringify({ ...record, wrappedMaster: Buffer.concat([Buffer.of(1), Buffer.alloc(59, 3)]).toString('base64') }),
      JSON.stringify({ ...record, wrappedMaster: Buffer.concat([Buffer.of(2), Buffer.alloc(60, 3)]).toString('base64') }),
    ]) {
      const response = await create(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ message: 'Send a valid wrapped account key record.' });
    }
    expect(await h.db!.prepare('SELECT count(*) AS count FROM account_key_records').first('count')).toBe(0);
    expect((await create(JSON.stringify(record))).status).toBe(201);
    expect((await create(JSON.stringify(wrappedRecord(4)))).status).toBe(409);
    expect(await h.db!.prepare('SELECT record_json FROM account_key_records').first('record_json')).toBe(JSON.stringify(record));
  });
});

describe('the sealed provider-key vault', () => {
  const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

  it('commits once, replaces under a version precondition, and never parses what it stores', async () => {
    const h = await runtime();
    await applyMigrations(h.db!, ['0004_account_key_records.sql', '0005_account_vaults.sql', '0006_account_vault_versions.sql']);
    await h.invite('reader-one');
    const { session } = await h.signIn('reader-one');
    const account = await (await h.dispatch('/v1/account', { headers: { Cookie: session! } })).json() as { id: string };
    const headers = (extra: Record<string, string> = {}) => ({ Cookie: session!, Origin: ORIGIN, 'X-Caotang-Account': account.id, ...extra });
    const put = (vault: string, extra: Record<string, string>) => h.dispatch('/v1/account/vault', {
      method: 'PUT', headers: headers({ 'Content-Type': 'application/json', ...extra }), body: JSON.stringify({ vault }),
    });

    const empty = await h.dispatch('/v1/account/vault', { headers: headers() });
    expect(empty.status).toBe(404);
    expect(await empty.json()).toEqual({ version: 1 });
    const first = base64(new Uint8Array(1 + 12 + 40 + 16).fill(2));
    expect((await put(first, { 'If-None-Match': '*' })).status).toBe(400);
    expect((await put(first, { 'If-None-Match': '*', 'X-Caotang-Vault-Version': '2' })).status).toBe(412);
    expect(await h.db!.prepare('SELECT count(*) AS count FROM account_vaults').first('count')).toBe(0);
    const created = await put(first, { 'If-None-Match': '*', 'X-Caotang-Vault-Version': '1' });
    expect(created.status).toBe(201);
    expect(created.headers.get('ETag')).toBe('"1"');
    expect(await created.json()).toEqual({ version: 1 });

    const loaded = await h.dispatch('/v1/account/vault', { headers: headers() });
    expect(loaded.status).toBe(200);
    expect(loaded.headers.get('ETag')).toBe('"1"');
    expect(loaded.headers.get('Cache-Control')).toBe('no-store');
    expect(await loaded.json()).toEqual({ version: 1, vault: first });

    expect((await put(first, { 'If-Match': '"7"' })).status).toBe(412);
    expect((await put(first, { 'If-Match': '"2147483646"' })).status).toBe(412);
    expect(await h.db!.prepare('SELECT version FROM account_vault_versions').first('version')).toBe(1);
    const second = base64(new Uint8Array(1 + 12 + 48 + 16).fill(3));
    const replaced = await put(second, { 'If-Match': '"1"' });
    expect(replaced.status).toBe(200);
    expect(replaced.headers.get('ETag')).toBe('"2"');
    expect(await h.dispatch('/v1/account/vault', { headers: headers() }).then((r) => r.json())).toEqual({ version: 2, vault: second });

    expect((await put(base64(new Uint8Array(4)), {})).status).toBe(400);
    expect((await put('not base64', { 'If-Match': '"2"' })).status).toBe(400);
    expect((await put(base64(new Uint8Array(4)), { 'If-Match': '"2"' })).status).toBe(200);
    expect((await h.dispatch('/v1/account/vault', { headers: headers({ 'X-Caotang-Account': 'some-other-account' }) })).status).toBe(412);
    expect((await h.dispatch('/v1/account/vault', { method: 'POST', headers: headers() })).status).toBe(405);
  });

  it('removes the vault under its version, and refuses an oversized body without storing anything', async () => {
    const h = await runtime();
    await applyMigrations(h.db!, ['0004_account_key_records.sql', '0005_account_vaults.sql', '0006_account_vault_versions.sql']);
    await h.invite('reader-one');
    const { session } = await h.signIn('reader-one');
    const account = await (await h.dispatch('/v1/account', { headers: { Cookie: session! } })).json() as { id: string };
    const headers = (extra: Record<string, string> = {}) => ({ Cookie: session!, Origin: ORIGIN, 'X-Caotang-Account': account.id, ...extra });
    const oversized = base64(new Uint8Array(64 * 1024 + 1));
    const refused = await h.dispatch('/v1/account/vault', {
      method: 'PUT', headers: headers({ 'Content-Type': 'application/json', 'If-None-Match': '*', 'X-Caotang-Vault-Version': '1' }), body: JSON.stringify({ vault: oversized }),
    });
    expect(refused.status).toBe(400);
    expect(await h.db!.prepare('SELECT count(*) AS count FROM account_vaults').first('count')).toBe(0);

    const vault = base64(new Uint8Array(80).fill(4));
    expect((await h.dispatch('/v1/account/vault', { method: 'PUT', headers: headers({ 'Content-Type': 'application/json', 'If-None-Match': '*', 'X-Caotang-Vault-Version': '1' }), body: JSON.stringify({ vault }) })).status).toBe(201);
    expect((await h.dispatch('/v1/account/vault', { method: 'DELETE', headers: headers() })).status).toBe(400);
    expect((await h.dispatch('/v1/account/vault', { method: 'DELETE', headers: headers({ 'If-Match': '"9"' }) })).status).toBe(412);
    expect((await h.dispatch('/v1/account/vault', { method: 'DELETE', headers: headers({ 'If-Match': '"1"' }) })).status).toBe(204);
    expect((await h.dispatch('/v1/account/vault', { headers: headers() })).status).toBe(404);
    expect((await h.dispatch('/v1/account/vault', { method: 'DELETE', headers: headers({ 'If-Match': '"1"' }) })).status).toBe(412);
  });

  it('never reuses a version after removal, so a stale precondition cannot overwrite the replacement', async () => {
    const h = await runtime();
    await applyMigrations(h.db!, ['0004_account_key_records.sql', '0005_account_vaults.sql', '0006_account_vault_versions.sql']);
    await h.invite('reader-one');
    const { session } = await h.signIn('reader-one');
    const account = await (await h.dispatch('/v1/account', { headers: { Cookie: session! } })).json() as { id: string };
    const headers = (extra: Record<string, string> = {}) => ({ Cookie: session!, Origin: ORIGIN, 'X-Caotang-Account': account.id, ...extra });
    const put = (vault: string, extra: Record<string, string>) => h.dispatch('/v1/account/vault', {
      method: 'PUT', headers: headers({ 'Content-Type': 'application/json', ...extra }), body: JSON.stringify({ vault }),
    });

    const first = base64(new Uint8Array(80).fill(5));
    const second = base64(new Uint8Array(80).fill(6));
    expect((await put(first, { 'If-None-Match': '*', 'X-Caotang-Vault-Version': '1' })).status).toBe(201);
    const replaced = await put(second, { 'If-Match': '"1"' });
    expect(replaced.status).toBe(200);
    expect(replaced.headers.get('ETag')).toBe('"2"');

    expect((await h.dispatch('/v1/account/vault', { method: 'DELETE', headers: headers({ 'If-Match': '"2"' }) })).status).toBe(204);
    const empty = await h.dispatch('/v1/account/vault', { headers: headers() });
    expect(empty.status).toBe(404);
    expect(await empty.json()).toEqual({ version: 3 });

    const third = base64(new Uint8Array(80).fill(7));
    expect((await put(third, { 'If-None-Match': '*', 'X-Caotang-Vault-Version': '1' })).status).toBe(412);
    const recreated = await put(third, { 'If-None-Match': '*', 'X-Caotang-Vault-Version': '3' });
    expect(recreated.status).toBe(201);
    expect(recreated.headers.get('ETag')).toBe('"3"');
    expect(await recreated.json()).toEqual({ version: 3 });

    expect((await put(first, { 'If-Match': '"1"' })).status).toBe(412);
    expect((await h.dispatch('/v1/account/vault', { method: 'DELETE', headers: headers({ 'If-Match': '"2"' }) })).status).toBe(412);
    expect(await h.dispatch('/v1/account/vault', { headers: headers() }).then((r) => r.json())).toEqual({ version: 3, vault: third });
  });

  it('keeps the version of a vault committed before the counter existed', async () => {
    const h = await runtime();
    await applyMigrations(h.db!, ['0004_account_key_records.sql', '0005_account_vaults.sql']);
    await h.invite('reader-one');
    const { session } = await h.signIn('reader-one');
    const account = await (await h.dispatch('/v1/account', { headers: { Cookie: session! } })).json() as { id: string };
    const headers = (extra: Record<string, string> = {}) => ({ Cookie: session!, Origin: ORIGIN, 'X-Caotang-Account': account.id, ...extra });
    const put = (vault: string, extra: Record<string, string>) => h.dispatch('/v1/account/vault', {
      method: 'PUT', headers: headers({ 'Content-Type': 'application/json', ...extra }), body: JSON.stringify({ vault }),
    });

    const first = base64(new Uint8Array(80).fill(8));
    await h.db!.prepare('INSERT INTO account_vaults (account_id, vault, version, updated_at) VALUES (?, ?, 1, ?)')
      .bind(account.id, first, new Date().toISOString()).run();
    await applyMigrations(h.db!, ['0006_account_vault_versions.sql']);

    expect((await h.dispatch('/v1/account/vault', { method: 'DELETE', headers: headers({ 'If-Match': '"1"' }) })).status).toBe(204);
    const recreated = await put(base64(new Uint8Array(80).fill(9)), { 'If-None-Match': '*', 'X-Caotang-Vault-Version': '2' });
    expect(recreated.status).toBe(201);
    expect(recreated.headers.get('ETag')).toBe('"2"');
    expect((await put(first, { 'If-Match': '"1"' })).status).toBe(412);
  });
});

describe('the Worker in account mode', () => {
  it('claims an invited numeric identity at sign-in and serves its own account and usage', async () => {
    const h = await runtime();
    await h.invite('reader-one', 64);
    const { finish, session } = await h.signIn('reader-one');
    expect(finish.status).toBe(302);
    expect(session).toBeDefined();
    const identity = await (await h.dispatch('/v1/session', { headers: { Cookie: session! } })).json();
    expect(identity).toEqual({ id: 'github:101', login: 'reader-one' });
    const account = await (await h.dispatch('/v1/account', { headers: { Cookie: session! } })).json() as { id: string; usage: unknown };
    expect(account.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(account.usage).toEqual({ limitBytes: 64, usedBytes: 0, reservedBytes: 0 });
    expect(account.id).not.toBe('101');
    const record = JSON.stringify(account);
    expect(record).not.toContain('github:101');
    expect(record).not.toContain('reader-one');
    expect((await h.dispatch('/v1/account')).status).toBe(401);
    expect((await h.signIn('reader-one')).session).toBeDefined();
  });

  it('never falls back to the allowlist for an uninvited, missing or misconfigured account store', async () => {
    const h = await runtime({ ALLOWED_GITHUB_LOGINS: 'uninvited-reader' });
    const refused = await h.signIn('uninvited-reader');
    expect(refused.finish.status).toBe(403);
    expect(refused.session).toBeUndefined();
    const withoutDatabase = await runtime({ ALLOWED_GITHUB_LOGINS: 'reader-one' }, { database: false });
    expect((await withoutDatabase.dispatch('/v1/auth/github')).status).toBe(503);
    expect(await (await withoutDatabase.dispatch('/')).text()).toBe('static shell');
    expect((await withoutDatabase.dispatch('/healthz')).status).toBe(200);
    const unknown = await runtime({ AUTHENTICATION_MODE: 'accounts-only' });
    expect((await unknown.dispatch('/v1/auth/github')).status).toBe(503);
    const cookie = signed({ purpose: 'session', origin: ORIGIN, expires: Date.now() + 60_000, mode: 'accounts', identity: { id: 'github:101', login: 'reader-one' }, account: { id: 'any', revision: 1 } });
    const cleared = await withoutDatabase.dispatch('/v1/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: ORIGIN } });
    expect(cleared.status).toBe(204);
    expect(cleared.headers.getSetCookie()[0]).toContain('Max-Age=0');
    expect((await withoutDatabase.dispatch('/v1/auth/logout', { method: 'POST', headers: { Cookie: cookie } })).status).toBe(503);
    expect((await withoutDatabase.dispatch('/v1/auth/logout', { method: 'POST', headers: { Cookie: `${cookie}x`, Origin: ORIGIN } })).status).toBe(503);
    expect((await withoutDatabase.dispatch('/v1/session', { headers: { Cookie: cookie } })).status).toBe(503);
  });

  it('returns a sanitized 503 when the account database fails and issues no session', async () => {
    const h = await runtime({}, { migrate: false });
    const { finish, session } = await h.signIn('reader-one');
    expect(finish.status).toBe(503);
    expect(session).toBeUndefined();
    const text = await finish.text();
    expect(text).not.toMatch(/no such table|SQL|D1_ERROR/i);
    const protectedCall = await h.dispatch('/v1/session', { headers: { Cookie: signed({ purpose: 'session', origin: ORIGIN, expires: Date.now() + 60_000, mode: 'accounts', identity: { id: 'github:101', login: 'reader-one' }, account: { id: 'any', revision: 1 } }) } });
    expect(protectedCall.status).toBe(503);
    expect(await protectedCall.text()).not.toMatch(/no such table|SQL|D1_ERROR/i);
    const cookie = signed({ purpose: 'session', origin: ORIGIN, expires: Date.now() + 60_000, mode: 'accounts', identity: { id: 'github:101', login: 'reader-one' }, account: { id: 'any', revision: 1 } });
    const signOut = await h.dispatch('/v1/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: ORIGIN } });
    expect(signOut.status).toBe(204);
    expect(signOut.headers.getSetCookie()[0]).toContain('Max-Age=0');
    expect((await h.dispatch('/v1/auth/logout', { headers: { Cookie: cookie } })).status).toBe(405);
    expect((await h.dispatch('/v1/auth/logout', { method: 'POST', headers: { Cookie: cookie } })).status).toBe(403);
  });

  it('revalidates on every call, so revocation stops old sessions and regranting never revives them', async () => {
    const h = await runtime();
    await h.invite('reader-one');
    const first = (await h.signIn('reader-one')).session!;
    const before = await (await h.dispatch('/v1/account', { headers: { Cookie: first } })).json() as { id: string };
    await h.revoke('reader-one');
    expect((await h.dispatch('/v1/session', { headers: { Cookie: first } })).status).toBe(401);
    expect((await h.signIn('reader-one')).finish.status).toBe(403);
    await h.invite('reader-one');
    expect((await h.dispatch('/v1/session', { headers: { Cookie: first } })).status).toBe(401);
    const second = (await h.signIn('reader-one')).session!;
    const after = await (await h.dispatch('/v1/account', { headers: { Cookie: second } })).json() as { id: string };
    expect(after.id).toBe(before.id);
  });

  it('keeps the two cookie families apart', async () => {
    const h = await runtime();
    await h.invite('reader-one');
    const legacy = signed({ purpose: 'session', origin: ORIGIN, expires: Date.now() + 60_000, identity: { id: 'github:101', login: 'reader-one' } });
    expect((await h.dispatch('/v1/session', { headers: { Cookie: legacy } })).status).toBe(401);
    const account = (await h.signIn('reader-one')).session!;
    const allowlist = await runtime({ AUTHENTICATION_MODE: 'allowlist', ALLOWED_GITHUB_LOGINS: 'reader-one' });
    expect((await allowlist.dispatch('/v1/session', { headers: { Cookie: account } })).status).toBe(401);
    expect((await allowlist.dispatch('/v1/account', { headers: { Cookie: legacy } })).status).toBe(404);
    for (const [runtimeUnderTest, cookie] of [[allowlist, account], [h, legacy]] as const) {
      const cleared = await runtimeUnderTest.dispatch('/v1/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: ORIGIN } });
      expect(cleared.status).toBe(204);
      expect(cleared.headers.getSetCookie()[0]).toContain('Max-Age=0');
    }
  });

  it('signs out everywhere with a same-origin POST that advances the revision', async () => {
    const h = await runtime();
    await h.invite('reader-one');
    const one = (await h.signIn('reader-one')).session!;
    const two = (await h.signIn('reader-one')).session!;
    expect((await h.dispatch('/v1/auth/logout-all', { method: 'POST', headers: { Cookie: one } })).status).toBe(403);
    expect((await h.dispatch('/v1/auth/logout-all', { headers: { Cookie: one } })).status).toBe(405);
    const result = await h.dispatch('/v1/auth/logout-all', { method: 'POST', headers: { Cookie: one, Origin: ORIGIN } });
    expect(result.status).toBe(204);
    expect(result.headers.getSetCookie()[0]).toContain('Max-Age=0');
    for (const session of [one, two]) expect((await h.dispatch('/v1/session', { headers: { Cookie: session } })).status).toBe(401);
    expect((await h.signIn('reader-one')).session).toBeDefined();
  });

  it('names the hub from the account, checks every heartbeat and closes revoked sockets', async () => {
    const h = await runtime();
    await h.invite('reader-one');
    await h.invite('reader-two');
    const session = (await h.signIn('reader-one')).session!;
    const other = (await h.signIn('reader-two')).session!;
    const accountId = (await (await h.dispatch('/v1/account', { headers: { Cookie: session } })).json() as { id: string }).id;
    const namespace = await h.instance.getDurableObjectNamespace('ACCOUNT_HUBS');
    const hub = namespace.get(namespace.idFromName(accountId)) as unknown as { nextAlarm(): Promise<number | null>; runAlarm(): Promise<void> };
    expect(await hub.nextAlarm()).toBeNull();
    const first = await h.connect(session);
    const second = await h.connect(session);
    const stranger = await h.connect(other);
    expect(await hub.nextAlarm()).not.toBeNull();
    first.socket.send('ping');
    await expect.poll(() => first.messages).toEqual(['pong']);
    expect((await h.dispatch('/v1/live/ping', { method: 'POST', headers: { Cookie: session, Origin: ORIGIN } })).status).toBe(204);
    await expect.poll(() => second.messages).toEqual(['{"type":"ping"}']);
    expect(stranger.messages).toEqual([]);
    await h.revoke('reader-one');
    first.socket.send('ping');
    await expect.poll(() => first.closeCode).toBe(1008);
    expect(first.messages).toEqual(['pong', '{"type":"ping"}']);
    await hub.runAlarm();
    await expect.poll(() => second.closeCode).toBe(1008);
    expect(await hub.nextAlarm()).toBeNull();
    expect(stranger.closeCode).toBeUndefined();
    stranger.socket.terminate();
  });

  it('refuses a socket handshake for a revoked account and cancels the alarm after the last socket closes', async () => {
    const h = await runtime();
    await h.invite('reader-one');
    const session = (await h.signIn('reader-one')).session!;
    const accountId = (await (await h.dispatch('/v1/account', { headers: { Cookie: session } })).json() as { id: string }).id;
    const namespace = await h.instance.getDurableObjectNamespace('ACCOUNT_HUBS');
    const hub = namespace.get(namespace.idFromName(accountId)) as unknown as { nextAlarm(): Promise<number | null> };
    const live = await h.connect(session);
    expect(await hub.nextAlarm()).not.toBeNull();
    live.socket.close();
    await expect.poll(() => hub.nextAlarm()).toBeNull();
    await h.revoke('reader-one');
    const refused = await h.dispatch('/v1/live', { headers: { Cookie: session, Origin: ORIGIN, Upgrade: 'websocket' } });
    expect(refused.status).toBe(401);
  });
  it('keeps presence and its heartbeat lease working in account mode without auto-responses',  async () => {
    const h = await runtime();
    await h.invite('reader-one');
    const session = (await h.signIn('reader-one')).session!;
    const accountId = (await (await h.dispatch('/v1/account', { headers: { Cookie: session } })).json() as { id: string }).id;
    const namespace = await h.instance.getDurableObjectNamespace('ACCOUNT_HUBS');
    const hub = namespace.get(namespace.idFromName(accountId)) as unknown as { ageProfile(profile: string): Promise<void> };
    const laptop = await h.connect(session, ONE);
    const phone = await h.connect(session, TWO);
    const events = (client: { messages: string[] }) => client.messages.filter((text) => text.startsWith('{"type":"presence"')).map((text) => JSON.parse(text) as { peers: number; change: string });
    await expect.poll(() => events(laptop).at(-1)).toEqual({ type: 'presence', peers: 1, change: 'joined' });
    phone.socket.send('ping');
    await expect.poll(() => phone.messages).toContain('pong');
    await hub.ageProfile(TWO);
    expect(phone.closeCode).toBeUndefined();
    await hub.ageProfile(ONE);
    await expect.poll(() => laptop.closeCode).toBe(1008);
    await expect.poll(() => events(phone).at(-1)).toEqual({ type: 'presence', peers: 0, change: 'left' });
    phone.socket.terminate();
  });
  it('validates every socket revision before a broadcast, a sweep or a presence update', async () => {
    const h = await runtime();
    await h.invite('reader-one');
    const first = (await h.signIn('reader-one')).session!;
    const accountId = (await (await h.dispatch('/v1/account', { headers: { Cookie: first } })).json() as { id: string }).id;
    const namespace = await h.instance.getDurableObjectNamespace('ACCOUNT_HUBS');
    const hub = namespace.get(namespace.idFromName(accountId)) as unknown as { runAlarm(): Promise<void> };
    const stale = await h.connect(first);
    await h.dispatch('/v1/auth/logout-all', { method: 'POST', headers: { Cookie: first, Origin: ORIGIN } });
    const second = (await h.signIn('reader-one')).session!;
    expect((await h.dispatch('/v1/live/ping', { method: 'POST', headers: { Cookie: second, Origin: ORIGIN } })).status).toBe(204);
    await expect.poll(() => stale.closeCode).toBe(1008);
    expect(stale.messages).toEqual([]);
    const current = await h.connect(second);
    await hub.runAlarm();
    expect(current.closeCode).toBeUndefined();
    current.socket.send('ping');
    await expect.poll(() => current.messages).toEqual(['pong']);
    current.socket.terminate();
  });

  it('closes a stale-revision socket on the next sweep without disturbing the current one', async () => {
    const h = await runtime();
    await h.invite('reader-one');
    const first = (await h.signIn('reader-one')).session!;
    const accountId = (await (await h.dispatch('/v1/account', { headers: { Cookie: first } })).json() as { id: string }).id;
    const namespace = await h.instance.getDurableObjectNamespace('ACCOUNT_HUBS');
    const hub = namespace.get(namespace.idFromName(accountId)) as unknown as { runAlarm(): Promise<void> };
    const stale = await h.connect(first);
    await h.dispatch('/v1/auth/logout-all', { method: 'POST', headers: { Cookie: first, Origin: ORIGIN } });
    await hub.runAlarm();
    await expect.poll(() => stale.closeCode).toBe(1008);
    const second = (await h.signIn('reader-one')).session!;
    const current = await h.connect(second);
    await hub.runAlarm();
    expect(current.closeCode).toBeUndefined();
    current.socket.terminate();
  });
  it('reports to the Worker when the hub cannot confirm the caller, instead of acknowledging the notification', async () => {
    const h = await runtime();
    await h.invite('reader-one');
    const session = (await h.signIn('reader-one')).session!;
    const account = await (await h.dispatch('/v1/account', { headers: { Cookie: session } })).json() as { id: string };
    const namespace = await h.instance.getDurableObjectNamespace('ACCOUNT_HUBS');
    const hub = namespace.get(namespace.idFromName(account.id)) as unknown as { ping(profile?: string, account?: { id: string; githubId: string; revision: number }): Promise<string> };
    expect(await hub.ping(undefined, { id: account.id, githubId: 'github:101', revision: 1 })).toBe('ok');
    expect(await hub.ping(undefined, { id: account.id, githubId: 'github:101', revision: 99 })).toBe('revoked');
    expect(await hub.ping(undefined, undefined)).toBe('revoked');
    const broken = await runtime({}, { migrate: false });
    const brokenNamespace = await broken.instance.getDurableObjectNamespace('ACCOUNT_HUBS');
    const brokenHub = brokenNamespace.get(brokenNamespace.idFromName('any')) as unknown as { ping(profile?: string, account?: { id: string; githubId: string; revision: number }): Promise<string> };
    expect(await brokenHub.ping(undefined, { id: 'any', githubId: 'github:101', revision: 1 })).toBe('unavailable');
  });
});
