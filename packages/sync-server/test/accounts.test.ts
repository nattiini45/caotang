import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkMachine } from '@caotang/machine/testing';
import { AccountRegistry } from '../src/accounts.js';
import { accountOperatorSql, invitationMachine, isGithubIdentity } from '../account-policy.mjs';
import { applyMigrations } from './d1-fixture.js';

let runtime: Miniflare;

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("A local database fixture."); } };', d1Databases: { DB: 'accounts-tests' } });
  const db = await runtime.getD1Database('DB');
  await applyMigrations(db, ['0001_accounts.sql']);
});

afterAll(async () => { await runtime?.dispose(); });

describe('durable invitation claims', () => {
  it('claims one invited numeric identity and returns its own account and usage', async () => {
    const db = await runtime.getD1Database('DB');
    const identity = { id: 'github:101', login: 'reader-one' };
    await db.prepare(accountOperatorSql({ type: 'invite', identity, limitBytes: 64 })).run();
    const registry = new AccountRegistry(db);
    const account = await registry.claim(identity);
    expect(account).toMatchObject({ githubId: 'github:101', login: 'reader-one', revision: 1, usage: { limitBytes: 64, usedBytes: 0, reservedBytes: 0 } });
    expect(account?.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(await registry.session(account!.id, identity.id, account!.revision)).toEqual(account);
  });

  it('makes concurrent duplicate callbacks idempotent across registry instances', async () => {
    const db = await runtime.getD1Database('DB');
    const identity = { id: 'github:202', login: 'Reader-Two' };
    await db.prepare(accountOperatorSql({ type: 'invite', identity, limitBytes: 128 })).run();
    const claims = await Promise.all(Array.from({ length: 8 }, () => new AccountRegistry(db).claim(identity)));
    expect(claims.every((claim) => claim !== null)).toBe(true);
    expect(new Set(claims.map((claim) => claim!.id)).size).toBe(1);
    expect(await new AccountRegistry(db).session(claims[0]!.id, identity.id, 1)).toEqual(claims[0]);
  });

  it('keeps the account on a login rename and refuses a recycled label with a different id', async () => {
    const db = await runtime.getD1Database('DB');
    const identity = { id: 'github:303', login: 'earlier-reader' };
    await db.prepare(accountOperatorSql({ type: 'invite', identity, limitBytes: 64 })).run();
    const registry = new AccountRegistry(db);
    const first = await registry.claim({ ...identity, login: 'Earlier-Reader' });
    const renamed = await registry.claim({ ...identity, login: 'renamed-reader' });
    expect(renamed).toMatchObject({ id: first!.id, githubId: 'github:303', login: 'renamed-reader' });
    expect(await registry.claim({ id: 'github:304', login: 'earlier-reader' })).toBeNull();
    expect(await registry.session(first!.id, 'github:304', 1)).toBeNull();
  });

  it('revokes every old session and only an explicit regrant restores the same account', async () => {
    const db = await runtime.getD1Database('DB');
    const identity = { id: 'github:404', login: 'returning-reader' };
    await db.prepare(accountOperatorSql({ type: 'invite', identity, limitBytes: 64 })).run();
    const registry = new AccountRegistry(db);
    const first = (await registry.claim(identity))!;
    await db.prepare(accountOperatorSql({ type: 'revoke', githubId: identity.id })).run();
    expect(await registry.session(first.id, identity.id, first.revision)).toBeNull();
    expect(await registry.claim(identity)).toBeNull();
    await db.prepare(accountOperatorSql({ type: 'invite', identity, limitBytes: 1024 })).run();
    const restored = await registry.claim(identity);
    expect(restored).toMatchObject({ id: first.id, revision: 3, usage: { limitBytes: 64 } });
    expect(await registry.session(first.id, identity.id, first.revision)).toBeNull();
  });

  it('rotates only the current account revision when signing out all sessions', async () => {
    const db = await runtime.getD1Database('DB');
    const identity = { id: 'github:505', login: 'signed-reader' };
    await db.prepare(accountOperatorSql({ type: 'invite', identity, limitBytes: 64 })).run();
    const registry = new AccountRegistry(db);
    const first = (await registry.claim(identity))!;
    expect(await registry.revokeSessions(first.id, first.revision)).toBe(true);
    expect(await registry.revokeSessions(first.id, first.revision)).toBe(false);
    expect(await registry.session(first.id, identity.id, first.revision)).toBeNull();
    expect(await registry.current(first.id)).toMatchObject({ revision: 2 });
  });

  it('refuses malformed operator inputs before producing executable SQL', () => {
    const identity = { id: 'github:606', login: 'valid-reader' };
    for (const limitBytes of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => accountOperatorSql({ type: 'invite', identity, limitBytes })).toThrow(/positive whole-byte/);
    }
    expect(() => accountOperatorSql({ type: 'revoke', githubId: "github:606'; DELETE FROM accounts;" })).toThrow(/numeric GitHub/);
    expect(() => accountOperatorSql({ type: 'invite', identity: { ...identity, login: "reader'; DELETE" }, limitBytes: 64 })).toThrow();
    expect(isGithubIdentity({ id: 'github:0', login: 'valid-reader' })).toBe(false);
  });

  it('keeps the invitation lifecycle exhaustive and reusable', () => {
    expect(checkMachine(invitationMachine, {
      states: [{ kind: 'pending' }, { kind: 'claimed' }, { kind: 'revoked' }],
      events: [{ type: 'claim' }, { type: 'revoke' }, { type: 'grant', hasAccount: false }, { type: 'grant', hasAccount: true }],
    })).toEqual([]);
  });
});
