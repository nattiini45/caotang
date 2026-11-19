import type { DurableAccount } from './accounts.js';

const MAX_RECORD_BYTES = 1024;
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

function base64(value: unknown, min: number, max: number): string | null {
  if (typeof value !== 'string') return null;
  const bytes = atob(value);
  return bytes.length >= min && bytes.length <= max && btoa(bytes) === value ? bytes : null;
}

async function readRecord(request: Request): Promise<string | null> {
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
    if (!exactObject(record, ['format', 'kdf', 'salt', 'wrappedMaster']) || record.format !== 1) return null;
    const { kdf, salt, wrappedMaster } = record;
    if (!exactObject(kdf, ['id', 'params']) || kdf.id !== 'argon2id') return null;
    if (!exactObject(kdf.params, ['memoryKiB', 'iterations', 'parallelism'])) return null;
    const { memoryKiB, iterations, parallelism } = kdf.params;
    if (!integer(parallelism, 1, 4) || !integer(iterations, 1, 10) || !integer(memoryKiB, 8 * parallelism, 262_144)) return null;
    if (base64(salt, 16, 64) === null || base64(wrappedMaster, 61, 61)?.charCodeAt(0) !== 1) return null;
    return JSON.stringify({ format: 1, kdf: { id: 'argon2id', params: { memoryKiB, iterations, parallelism } }, salt, wrappedMaster });
  } catch {
    return null;
  } finally {
    void reader.cancel().catch(() => {});
  }
}

export async function accountKeyRecordRoute(request: Request, account: DurableAccount, db: D1DatabaseSession): Promise<Response> {
  const { id, githubId, revision } = account;
  if (request.method !== 'GET' && request.method !== 'POST') return reply(405, 'Use GET to read or POST to create the account key record.');
  if (request.headers.get('X-Caotang-Account') !== id) return reply(412, 'The signed-in account changed. Load the account again.');
  const current = () => db.prepare(`SELECT (SELECT record_json FROM account_key_records WHERE account_id = a.account_id) AS record_json
    ${ACTIVE_SESSION}`).bind(id, githubId, revision).first<{ record_json: string | null }>();
  try {
    if (request.method === 'GET') {
      const row = await current();
      if (row === null) return reply(401, 'Sign in to continue.');
      return row.record_json === null ? reply(404, 'No account key record has been created.') : new Response(row.record_json, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }
    const record = await readRecord(request);
    if (record === null) return reply(400, 'Send a valid wrapped account key record.');
    const inserted = await db.prepare(`INSERT INTO account_key_records (account_id, record_json)
      SELECT a.account_id, ? ${ACTIVE_SESSION}
      ON CONFLICT (account_id) DO NOTHING`).bind(record, id, githubId, revision).run();
    if (inserted.meta.changes === 1) return new Response(null, { status: 201, headers: { 'Cache-Control': 'no-store' } });
    return await current() === null ? reply(401, 'Sign in to continue.') : reply(409, 'An account key record already exists.');
  } catch {
    return reply(503, 'The account key record is unavailable. Try again shortly.');
  }
}
