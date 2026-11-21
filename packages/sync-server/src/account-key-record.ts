import type { DurableAccount } from './accounts.js';

const MAX_RECORD_BYTES = 1024;
/** The record version's own bound, so a precondition far above it is refused rather than stored. */
const MAX_VERSION = 2147483647;
const ACTIVE_SESSION = `FROM accounts a JOIN invitations i ON i.account_id = a.account_id
WHERE a.account_id = ? AND a.github_id = ? AND a.session_revision = ?
AND a.status = 'active' AND i.state = 'claimed'`;

function reply(status: number, message: string): Response {
  return Response.json({ message }, { status, headers: { 'Cache-Control': 'no-store' } });
}

function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

/** `"3"` or `3` reads as version 3; anything else is not a precondition this route accepts. */
function version(header: string | null, pattern: RegExp): number | null {
  if (header === null) return null;
  const match = pattern.exec(header.trim());
  if (match === null) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_VERSION ? parsed : null;
}

function base64(value: unknown, min: number, max: number): string | null {
  if (typeof value !== 'string') return null;
  const bytes = atob(value);
  return bytes.length >= min && bytes.length <= max && btoa(bytes) === value ? bytes : null;
}

async function readRecord(request: Request, accountId: string, requireBound = false): Promise<string | null> {
  if (request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json' || !request.body) return null;
  const reader = request.body.getReader();
  const bytes = new Uint8Array(MAX_RECORD_BYTES);
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.length > bytes.length) return null;
      bytes.set(value, length);
      length += value.length;
    }
    const record: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, length)));
    const legacy = exactObject(record, ['format', 'kdf', 'salt', 'wrappedMaster']) && record.format === 1;
    // Format 2 binds the record to the account that stored it; a record naming another account is refused rather than stored.
    const bound = exactObject(record, ['format', 'accountId', 'kdf', 'salt', 'wrappedMaster', 'verifier']) && record.format === 2;
    if (!legacy && !bound) return null;
    // A replacement is always bound: the record it replaces belongs to this account, and a legacy shape cannot name it.
    if (requireBound && !bound) return null;
    const body = record as { accountId?: unknown; kdf: unknown; salt: unknown; wrappedMaster: unknown; verifier?: unknown };
    const { accountId: named, kdf, salt, wrappedMaster, verifier } = body;
    if (bound) {
      if (named !== accountId) return null;
      if (base64(verifier, 32, 32) === null) return null;
    }
    if (!exactObject(kdf, ['id', 'params']) || kdf.id !== 'argon2id') return null;
    if (!exactObject(kdf.params, ['memoryKiB', 'iterations', 'parallelism'])) return null;
    const { memoryKiB, iterations, parallelism } = kdf.params;
    if (!integer(parallelism, 1, 4) || !integer(iterations, 1, 10) || !integer(memoryKiB, 8 * parallelism, 262_144)) return null;
    if (base64(salt, 16, 64) === null || base64(wrappedMaster, 61, 61)?.charCodeAt(0) !== 1) return null;
    const canonical = { kdf: { id: 'argon2id', params: { memoryKiB, iterations, parallelism } }, salt, wrappedMaster };
    return bound
      ? JSON.stringify({ format: 2, accountId, ...canonical, verifier })
      : JSON.stringify({ format: 1, ...canonical });
  } catch {
    return null;
  } finally {
    void reader.cancel().catch(() => {});
  }
}

export async function accountKeyRecordRoute(request: Request, account: DurableAccount, db: D1DatabaseSession): Promise<Response> {
  const { id, githubId, revision } = account;
  if (request.method !== 'GET' && request.method !== 'POST' && request.method !== 'PUT') {
    return reply(405, 'Use GET to read the account key record, POST to create it or PUT to replace it.');
  }
  if (request.headers.get('X-Caotang-Account') !== id) return reply(412, 'The signed-in account changed. Load the account again.');
  const current = () => db.prepare(`SELECT (SELECT record_json FROM account_key_records WHERE account_id = a.account_id) AS record_json,
    (SELECT version FROM account_key_records WHERE account_id = a.account_id) AS version
    ${ACTIVE_SESSION}`).bind(id, githubId, revision).first<{ record_json: string | null; version: number | null }>();
  /**
   * Holds the account's record version at or above `version`, so a record replaced twice keeps counting instead of reusing a
   * version. It rides in the same batch as the write it records, so a counter left behind by a failed second statement can
   * never let a stale precondition match again.
   */
  const remember = (version: number) => db.prepare(`INSERT INTO account_key_record_versions (account_id, version)
    SELECT a.account_id, ? ${ACTIVE_SESSION}
    ON CONFLICT (account_id) DO UPDATE SET version = MAX(version, excluded.version)`)
    .bind(version, id, githubId, revision);
  try {
    if (request.method === 'GET') {
      const row = await current();
      if (row === null) return reply(401, 'Sign in to continue.');
      if (row.record_json === null || row.version === null) return reply(404, 'No account key record has been created.');
      return new Response(row.record_json, {
        headers: { 'Content-Type': 'application/json', ETag: `"${row.version}"`, 'Cache-Control': 'no-store' },
      });
    }
    if (request.method === 'PUT') {
      // A replacement is always bound to the account and always lands on the version it was prepared against, so two browsers
      // changing the passphrase at once cannot overwrite each other: the loser reads the record again.
      const record = await readRecord(request, id, true);
      if (record === null) return reply(400, 'Send a valid wrapped account key record bound to this account.');
      const expected = version(request.headers.get('If-Match'), /^"?(\d+)"?$/);
      if (expected === null) return reply(400, 'Send If-Match with the record version to replace it.');
      const loaded = await current();
      if (loaded === null) return reply(401, 'Sign in to continue.');
      if (loaded.version === null) return reply(404, 'No account key record has been created.');
      if (loaded.version !== expected) return reply(412, 'The account key record changed. Read it again and replace it at its version.');
      const next = expected + 1;
      if (next > MAX_VERSION) return reply(412, 'The account key record has reached its last version.');
      const written = await db.batch([
        db.prepare(`UPDATE account_key_records SET record_json = ?, version = version + 1
          WHERE version = ? AND account_id IN (SELECT a.account_id ${ACTIVE_SESSION})`)
          .bind(record, expected, id, githubId, revision),
        remember(next),
      ]);
      if (written[0]?.meta.changes === 1) {
        return Response.json({ version: next }, { status: 200, headers: { ETag: `"${next}"`, 'Cache-Control': 'no-store' } });
      }
      return await current() === null ? reply(401, 'Sign in to continue.') : reply(412, 'The account key record changed. Read it again and replace it at its version.');
    }
    const record = await readRecord(request, id);
    if (record === null) return reply(400, 'Send a valid wrapped account key record.');
    const inserted = await db.batch([
      db.prepare(`INSERT INTO account_key_records (account_id, record_json)
        SELECT a.account_id, ? ${ACTIVE_SESSION}
        ON CONFLICT (account_id) DO NOTHING`).bind(record, id, githubId, revision),
      remember(1),
    ]);
    if (inserted[0]?.meta.changes === 1) return new Response(null, { status: 201, headers: { 'Cache-Control': 'no-store' } });
    return await current() === null ? reply(401, 'Sign in to continue.') : reply(409, 'An account key record already exists.');
  } catch {
    return reply(503, 'The account key record is unavailable. Try again shortly.');
  }
}
