/**
 * The account's project records — hosted.md §5, sync-server.md. One row per project: the project key wrapped under the
 * account's master key and the project's sealed record (its name). Both are opaque to the server, which stores the
 * bytes it was handed and cannot read a project's name or its key. This is what lets a second device list the projects
 * an account has and open one it has never seen.
 *
 * Two routes, and neither can address another account: the account comes from the session only, a mutation must name
 * the account it was signed in as (`X-Caotang-Account`, the same precondition the vault uses, so a cookie change in
 * another tab cannot record a project under the wrong account), and every statement rechecks the active session and
 * its revision on the database primary.
 *
 * The record is a label and a wrapped key, not project content: a later write replaces it, which is what a rename is.
 * A manuscript's edits never travel this way — they go through the blob service, where the index precondition makes
 * an overwrite impossible (hosted.md §5, §7).
 */
import type { DurableAccount } from './accounts.js';

const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The body of a write: `{wrappedKey, record}`, both canonical base64, and nothing else. */
const MAX_BODY_BYTES = 2048;

/** A wrapped project key: one format byte, a 12-byte nonce, 32 key bytes and a 16-byte tag. */
const WRAPPED_KEY_BYTES = 61;

/** The sealed project record: its own format byte plus a name of at most 200 characters. */
const MIN_RECORD_BYTES = 1;
const MAX_RECORD_BYTES = 1024;

const ACTIVE_SESSION = `FROM accounts a JOIN invitations i ON i.account_id = a.account_id
WHERE a.account_id = ? AND a.github_id = ? AND a.session_revision = ?
AND a.status = 'active' AND i.state = 'claimed'`;

function reply(status: number, message: string): Response {
  return Response.json({ message }, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** Canonical base64 of exactly `bytes` bytes. */
function canonical(value: unknown, bytes: number): string | null {
  if (typeof value !== 'string') return null;
  try {
    const decoded = atob(value);
    return decoded.length === bytes && btoa(decoded) === value ? value : null;
  } catch {
    return null;
  }
}

/** Canonical base64 of between `min` and `max` bytes. */
function canonicalBetween(value: unknown, min: number, max: number): string | null {
  if (typeof value !== 'string') return null;
  try {
    const decoded = atob(value);
    return decoded.length >= min && decoded.length <= max && btoa(decoded) === value ? value : null;
  } catch {
    return null;
  }
}

async function readBody(request: Request): Promise<{ wrappedKey: string; record: string } | null> {
  if (request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json' || !request.body) return null;
  const reader = request.body.getReader();
  const bytes = new Uint8Array(MAX_BODY_BYTES);
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.length > bytes.length) return null;
      bytes.set(value, length);
      length += value.length;
    }
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, length)));
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
    const keys = Object.keys(body).sort();
    if (keys.length !== 2 || keys[0] !== 'record' || keys[1] !== 'wrappedKey') return null;
    const wrappedKey = canonical((body as Record<string, unknown>)['wrappedKey'], WRAPPED_KEY_BYTES);
    const record = canonicalBetween((body as Record<string, unknown>)['record'], MIN_RECORD_BYTES, MAX_RECORD_BYTES);
    return wrappedKey === null || record === null ? null : { wrappedKey, record };
  } catch {
    return null;
  } finally {
    void reader.cancel().catch(() => {});
  }
}

interface RecordRow {
  id: string;
  wrappedKey: string;
  record: string;
  createdAt: number;
  updatedAt: number;
}

export async function projectRecordsRoute(request: Request, url: URL, account: DurableAccount, db: D1DatabaseSession): Promise<Response> {
  const { id, githubId, revision } = account;
  if (request.headers.get('X-Caotang-Account') !== id) return reply(412, 'The signed-in account changed. Load the account again.');
  const alive = async (): Promise<boolean> =>
    (await db.prepare(`SELECT a.account_id AS id ${ACTIVE_SESSION}`).bind(id, githubId, revision).first<{ id: string }>()) !== null;
  try {
    if (url.pathname === '/v1/projects') {
      if (request.method !== 'GET') return reply(405, 'Use GET to list projects.');
      const rows = await db.prepare(`SELECT p.project_id AS id, p.wrapped_key AS wrappedKey, p.record AS record,
        p.created_at AS createdAt, p.updated_at AS updatedAt
        FROM project_records p WHERE p.account_id IN (SELECT a.account_id ${ACTIVE_SESSION})
        ORDER BY p.created_at, p.project_id`).bind(id, githubId, revision).all<RecordRow>();
      if (rows.results.length === 0 && !await alive()) return reply(401, 'Sign in to continue.');
      return Response.json({ projects: rows.results }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const projectId = url.pathname.slice('/v1/projects/'.length);
    if (!PROJECT_ID.test(projectId)) return reply(400, 'Use a project id of at most 64 letters, digits, - and _.');
    if (request.method !== 'PUT') return reply(405, 'Use PUT to record a project.');
    const create = request.headers.get('If-None-Match')?.trim() === '*';
    const ifMatch = request.headers.get('If-Match');
    if (ifMatch !== null) return reply(400, 'Use If-None-Match: * to record a new project, or no precondition to replace its record.');
    const body = await readBody(request);
    if (body === null) return reply(400, 'Send {"wrappedKey": "<base64>", "record": "<base64>"} of at most 1024 sealed bytes.');
    const now = Date.now();
    const written = create
      ? await db.prepare(`INSERT INTO project_records (account_id, project_id, wrapped_key, record, created_at, updated_at)
        SELECT a.account_id, ?, ?, ?, ?, ? ${ACTIVE_SESSION}
        ON CONFLICT (account_id, project_id) DO NOTHING`).bind(projectId, body.wrappedKey, body.record, now, now, id, githubId, revision).run()
      : await db.prepare(`INSERT INTO project_records (account_id, project_id, wrapped_key, record, created_at, updated_at)
        SELECT a.account_id, ?, ?, ?, ?, ? ${ACTIVE_SESSION}
        ON CONFLICT (account_id, project_id) DO UPDATE SET wrapped_key = excluded.wrapped_key, record = excluded.record, updated_at = excluded.updated_at`)
        .bind(projectId, body.wrappedKey, body.record, now, now, id, githubId, revision).run();
    if (written.meta.changes === 1) {
      return Response.json({ recorded: true }, { status: create ? 201 : 200, headers: { 'Cache-Control': 'no-store' } });
    }
    if (!await alive()) return reply(401, 'Sign in to continue.');
    return reply(409, 'This project is already recorded. Replace its record instead.');
  } catch {
    return reply(503, 'Project records are unavailable. Try again shortly.');
  }
}
