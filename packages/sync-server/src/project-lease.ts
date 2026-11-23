/**
 * The per-device lease — hosted.md §7, sync-server.md. One device at a time edits a project; the others read it. The
 * lease is soft by design: a heartbeat renews it, it expires on its own when the device stops sending one, and any
 * device may take it over once the writer says so. What it buys is that the second device is read-only *while* the
 * first is working, rather than that a mistake is impossible.
 *
 * The server keeps one row per project (`0009_project_leases.sql`) naming the device and when its lease ends, and it
 * refuses a blob mutation that arrives from another device while a lease is live. A device that never takes a lease is
 * unaffected, so a script or another client keeps working; the lease only binds devices that use it.
 *
 * The device names itself with an opaque label it chooses and keeps for the session (`X-Caotang-Device`). It is not an
 * identity and authorizes nothing: the account still comes from the session, and a device label is only ever compared
 * with the one this account's row holds.
 */
import type { DurableAccount } from './accounts.js';

export const LEASE_TTL_MS = 60_000;

const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DEVICE = /^[A-Za-z0-9_-]{1,64}$/;

const ACTIVE_SESSION = `FROM accounts a JOIN invitations i ON i.account_id = a.account_id
WHERE a.account_id = ? AND a.github_id = ? AND a.session_revision = ?
AND a.status = 'active' AND i.state = 'claimed'`;

function reply(status: number, message: string): Response {
  return Response.json({ message }, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** The device this request says it is, or `null` when the header is missing or malformed. */
export function deviceOf(request: Request): string | null {
  const value = request.headers.get('X-Caotang-Device');
  return value !== null && DEVICE.test(value) ? value : null;
}

interface LeaseRow {
  device: string;
  until: number;
}

/**
 * What a mutation must know before it writes: whether the project is free, whether this device holds it, whether another
 * device does, or whether a live lease exists and the request named no device at all.
 */
export type LeaseCheck = { readonly kind: 'free' } | { readonly kind: 'mine' } | { readonly kind: 'other' } | { readonly kind: 'unnamed' };

export async function checkLease(db: D1DatabaseSession, account: DurableAccount, projectId: string, device: string | null): Promise<LeaseCheck> {
  const row = await db.prepare(`SELECT l.device AS device FROM project_leases l
    WHERE l.account_id IN (SELECT a.account_id ${ACTIVE_SESSION})
    AND l.project_id = ? AND l.expires_at > ?`).bind(account.id, account.githubId, account.revision, projectId, Date.now()).first<{ device: string }>();
  if (row === null) return { kind: 'free' };
  if (device !== null && row.device === device) return { kind: 'mine' };
  return device === null ? { kind: 'unnamed' } : { kind: 'other' };
}

export async function projectLeaseRoute(request: Request, projectId: string, account: DurableAccount, db: D1DatabaseSession): Promise<Response> {
  const { id, githubId, revision } = account;
  if (!PROJECT_ID.test(projectId)) return reply(400, 'Use a project id of at most 64 letters, digits, - and _.');
  if (request.headers.get('X-Caotang-Account') !== id) return reply(412, 'The signed-in account changed. Load the account again.');
  const device = deviceOf(request);
  if (device === null) return reply(400, 'Send X-Caotang-Device with the device label you keep for this session.');
  const takeover = request.headers.get('X-Caotang-Takeover');
  if (takeover !== null && takeover !== '1') return reply(400, 'Send X-Caotang-Takeover: 1 to take the lease over, or nothing at all.');
  const alive = async (): Promise<boolean> =>
    (await db.prepare(`SELECT a.account_id AS id ${ACTIVE_SESSION}`).bind(id, githubId, revision).first<{ id: string }>()) !== null;
  try {
    if (request.method === 'DELETE') {
      const released = await db.prepare(`DELETE FROM project_leases
        WHERE project_id = ? AND device = ? AND account_id IN (SELECT a.account_id ${ACTIVE_SESSION})`)
        .bind(projectId, device, id, githubId, revision).run();
      if (released.meta.changes === 1) return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
      if (!await alive()) return reply(401, 'Sign in to continue.');
      // Another device holds it: nothing was released, and saying which one would tell this device about that one.
      return reply(409, 'Another device is editing this project.');
    }
    if (request.method !== 'POST') return reply(405, 'Use POST to take or renew the lease, or DELETE to release it.');
    const now = Date.now();
    const [, taken] = await db.batch([
      db.prepare(`INSERT INTO project_leases (account_id, project_id, device, expires_at)
        SELECT a.account_id, ?, ?, ? ${ACTIVE_SESSION}
        ON CONFLICT (account_id, project_id) DO UPDATE SET device = excluded.device, expires_at = excluded.expires_at
        WHERE project_leases.expires_at <= ? OR project_leases.device = excluded.device OR ? = 1`)
        .bind(projectId, device, now + LEASE_TTL_MS, id, githubId, revision, now, takeover === '1' ? 1 : 0),
      db.prepare(`SELECT l.device AS device, l.expires_at AS until FROM project_leases l
        WHERE l.account_id IN (SELECT a.account_id ${ACTIVE_SESSION}) AND l.project_id = ?`)
        .bind(id, githubId, revision, projectId),
    ]);
    if (taken === undefined) {
      if (await alive()) return reply(503, 'The project lease is unavailable. Try again shortly.');
      return reply(401, 'Sign in to continue.');
    }
    const row = (taken.results as LeaseRow[])[0];
    if (row === undefined) {
      if (await alive()) return reply(503, 'The project lease is unavailable. Try again shortly.');
      return reply(401, 'Sign in to continue.');
    }
    // The row this account holds after the attempt. A device that lost the race learns when the lease ends, and not
    // which device holds it: a lease is not a device directory.
    return Response.json({ leased: row.device === device && row.until > now, until: row.until }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return reply(503, 'The project lease is unavailable. Try again shortly.');
  }
}
