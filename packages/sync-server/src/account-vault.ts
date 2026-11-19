import type { DurableAccount } from './accounts.js';

/**
 * The sealed provider-key vault — hosted.md §2.5, sync-server.md. One opaque object per account, replaced under a
 * version precondition. The server never parses it, never logs it and cannot tell which provider profiles exist: it
 * keeps base64 bytes and a counter.
 */

const MAX_VAULT_BYTES = 64 * 1024;

const ACTIVE_SESSION = `FROM accounts a JOIN invitations i ON i.account_id = a.account_id
WHERE a.account_id = ? AND a.github_id = ? AND a.session_revision = ?
AND a.status = 'active' AND i.state = 'claimed'`;

function reply(status: number, message: string): Response {
  return Response.json({ message }, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** Canonical base64 of between 1 and `MAX_VAULT_BYTES` bytes, or null. */
function vaultBytes(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const bytes = atob(value);
    return bytes.length >= 1 && bytes.length <= MAX_VAULT_BYTES && btoa(bytes) === value ? value : null;
  } catch {
    return null;
  }
}

/** `"3"` or `3` reads as version 3; anything else is not a precondition this route accepts. */
function version(header: string | null, pattern: RegExp): number | null {
  if (header === null) return null;
  const match = pattern.exec(header.trim());
  if (match === null) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

async function readVault(request: Request): Promise<string | null> {
  if (request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json' || !request.body) return null;
  // The read itself bounds the body: an oversized one overflows the buffer and is refused, never truncated.
  const reader = request.body.getReader();
  const bytes = new Uint8Array(MAX_VAULT_BYTES * 2);
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
    const entries = Object.keys(body);
    if (entries.length !== 1 || entries[0] !== 'vault') return null;
    return vaultBytes((body as Record<string, unknown>)['vault']);
  } catch {
    return null;
  } finally {
    void reader.cancel().catch(() => {});
  }
}

export async function accountVaultRoute(request: Request, account: DurableAccount, db: D1DatabaseSession): Promise<Response> {
  const { id, githubId, revision } = account;
  if (request.method !== 'GET' && request.method !== 'PUT' && request.method !== 'DELETE') {
    return reply(405, 'Use GET to read the vault, PUT to commit it or DELETE to remove it.');
  }
  if (request.headers.get('X-Caotang-Account') !== id) return reply(412, 'The signed-in account changed. Load the account again.');
  const current = () => db.prepare(`SELECT (SELECT version FROM account_vaults WHERE account_id = a.account_id) AS version
    ${ACTIVE_SESSION}`).bind(id, githubId, revision).first<{ version: number | null }>();
  /**
   * Holds the account's version at or above `version`, so a removed vault is never replaced under a version already used.
   * It rides in the same batch as the write it records: a counter left behind by a failed second statement would let a
   * removed version come back.
   */
  const remember = (version: number) => db.prepare(`INSERT INTO account_vault_versions (account_id, version)
    SELECT a.account_id, ? ${ACTIVE_SESSION}
    ON CONFLICT (account_id) DO UPDATE SET version = MAX(version, excluded.version)`)
    .bind(version, id, githubId, revision);
  try {
    if (request.method === 'GET') {
      const row = await db.prepare(`SELECT (SELECT version FROM account_vaults WHERE account_id = a.account_id) AS version,
        (SELECT vault FROM account_vaults WHERE account_id = a.account_id) AS vault
        ${ACTIVE_SESSION}`).bind(id, githubId, revision).first<{ version: number | null; vault: string | null }>();
      if (row === null) return reply(401, 'Sign in to continue.');
      if (row.version === null || row.vault === null) return reply(404, 'No account vault has been committed.');
      return Response.json({ version: row.version, vault: row.vault }, {
        headers: { ETag: `"${row.version}"`, 'Cache-Control': 'no-store' },
      });
    }
    if (request.method === 'DELETE') {
      const expected = version(request.headers.get('If-Match'), /^"?(\d+)"?$/);
      if (expected === null) return reply(400, 'Send If-Match with the vault version to remove.');
      const removed = await db.prepare(`DELETE FROM account_vaults
        WHERE version = ? AND account_id IN (SELECT a.account_id ${ACTIVE_SESSION})`).bind(expected, id, githubId, revision).run();
      if (removed.meta.changes === 1) return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
      return await current() === null ? reply(401, 'Sign in to continue.') : reply(412, 'The vault changed. Read it again before removing it.');
    }
    const create = request.headers.get('If-None-Match')?.trim() === '*';
    const expected = create ? null : version(request.headers.get('If-Match'), /^"?(\d+)"?$/);
    if (!create && expected === null) return reply(400, 'Use If-None-Match: * to create the vault, or If-Match with its version to replace it.');
    const body = await readVault(request);
    if (body === null) return reply(400, `Send {"vault": "<base64>"} of at most ${MAX_VAULT_BYTES} sealed bytes.`);
    if (create) {
      const claim = await db.prepare(`SELECT (COALESCE((SELECT version FROM account_vault_versions WHERE account_id = a.account_id), 0) + 1) AS version
        ${ACTIVE_SESSION}`).bind(id, githubId, revision).first<{ version: number }>();
      if (claim === null) return reply(401, 'Sign in to continue.');
      const [inserted] = await db.batch([
        db.prepare(`INSERT INTO account_vaults (account_id, vault, version, updated_at)
          SELECT a.account_id, ?, ?, ? ${ACTIVE_SESSION}
          ON CONFLICT (account_id) DO NOTHING`).bind(body, claim.version, new Date().toISOString(), id, githubId, revision),
        remember(claim.version),
      ]);
      if (inserted.meta.changes === 1) {
        return Response.json({ version: claim.version }, { status: 201, headers: { ETag: `"${claim.version}"`, 'Cache-Control': 'no-store' } });
      }
      return await current() === null ? reply(401, 'Sign in to continue.') : reply(412, 'A vault already exists. Read it and commit onto its version.');
    }
    const next = (expected ?? 0) + 1;
    const [replaced] = await db.batch([
      db.prepare(`UPDATE account_vaults SET vault = ?, version = version + 1, updated_at = ?
        WHERE version = ? AND account_id IN (SELECT a.account_id ${ACTIVE_SESSION})`)
        .bind(body, new Date().toISOString(), expected, id, githubId, revision),
      remember(next),
    ]);
    if (replaced.meta.changes === 1) {
      return Response.json({ version: next }, { status: 200, headers: { ETag: `"${next}"`, 'Cache-Control': 'no-store' } });
    }
    return await current() === null ? reply(401, 'Sign in to continue.') : reply(412, 'The vault changed. Read it again and commit onto its version.');
  } catch {
    return reply(503, 'The account vault is unavailable. Try again shortly.');
  }
}

