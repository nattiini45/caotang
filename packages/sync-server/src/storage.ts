/**
 * Encrypted object storage on R2 — [hosted.md §6](../../../docs/architecture/hosted.md) and
 * [sync-server.md](../../../docs/architecture/sync-server.md). Opaque bytes under opaque names, one account at a
 * time: write-once version objects, a compare-and-swap live pointer as the commit point, and quota charging
 * through the D1 lease seam. A per-account Durable Object serialises every pointer publication and settlement,
 * so no writer can publish after settlement proves absence. The server never parses a payload.
 */
import { DurableObject } from 'cloudflare:workers';
import type { DurableAccount } from './accounts.js';
import { payloadFingerprint } from './fingerprint.js';
import type { SyncServerBindings } from './index.js';
import { QuotaStore, reconcileQuota, type QuotaResult, type QuotaSettlementAdapter } from './quota.js';

export const MAX_OBJECT_BYTES = 64 * 1024 * 1024;
export const MIN_CHARGED_BYTES = 285;
const WRITE_LEASE_MS = 60_000;
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_BATCH = 100;
const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BLOB_NAME = /^[a-z0-9-]{1,64}$/;
const OPERATION_ID = /^[A-Za-z0-9_-]{1,120}$/;
const STRONG_ETAG = /^"[^"]+"$/;

type Pointer = { etag: string; operationId: string; size: number; uploaded: number; deleted: boolean };

const bare = (etag: string): string => etag.replace(/^"|"$/g, '');
const versionKey = (accountId: string, operationId: string): string => `${accountId}/o/${operationId}`;
const liveKey = (accountId: string, projectId: string, name: string): string => `${accountId}/live/${projectId}/${name}`;
const historyKey = (accountId: string, operationId: string): string => `${accountId}/history/${operationId}`;
const fenceKey = (accountId: string, operationId: string): string => `${accountId}/fences/${operationId}`;

function reply(status: number, message: string): Response {
  return Response.json({ message }, { status, headers: { 'Cache-Control': 'no-store' } });
}

function objectResponse(status: number, etag: string): Response {
  return new Response(null, { status, headers: { ETag: `"${bare(etag)}"`, 'Cache-Control': 'no-store' } });
}

function quotaFailure(reason: Exclude<QuotaResult, { ok: true }>['reason']): Response {
  if (reason === 'capacity') return reply(507, 'The account’s storage allowance is exhausted.');
  if (reason === 'unavailable') return reply(503, 'Accounts are unavailable. Try again shortly.');
  if (reason === 'invalid') return reply(400, 'The upload could not be accepted.');
  return reply(409, 'The upload was refused. Read the object and try again.');
}

async function readPointer(bucket: R2Bucket, key: string): Promise<Pointer | null> {
  const head = await bucket.head(key);
  if (!head) return null;
  const operationId = head.customMetadata?.operation;
  const size = Number(head.customMetadata?.size);
  if (typeof operationId !== 'string' || !OPERATION_ID.test(operationId) || !Number.isSafeInteger(size) || size < 0) return null;
  return { etag: bare(head.etag), operationId, size, uploaded: head.uploaded.getTime(), deleted: head.customMetadata?.deleted === '1' };
}

function pointerBody(pointer: { operationId: string; size: number; uploaded: number; deleted?: boolean }): { body: string; customMetadata: Record<string, string> } {
  const customMetadata: Record<string, string> = { operation: pointer.operationId, size: String(pointer.size) };
  if (pointer.deleted) customMetadata.deleted = '1';
  return { body: JSON.stringify({ operationId: pointer.operationId, size: pointer.size, uploaded: pointer.uploaded, deleted: pointer.deleted === true }), customMetadata };
}

async function retain(bucket: R2Bucket, accountId: string, projectId: string, name: string, pointer: Pointer, reason: 'replaced' | 'deleted'): Promise<void> {
  await bucket.put(historyKey(accountId, pointer.operationId), JSON.stringify({
    projectId, name, etag: pointer.etag, size: pointer.size, uploaded: pointer.uploaded, reason,
  }));
}

async function readDeclaredBody(request: Request, declared: number): Promise<Uint8Array | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < declared) {
      const { value, done } = await reader.read();
      if (done) return null;
      if (total + value.byteLength > declared) return null;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function getBlob(bucket: R2Bucket, accountId: string, projectId: string, name: string): Promise<Response> {
  const pointer = await readPointer(bucket, liveKey(accountId, projectId, name));
  if (!pointer || pointer.deleted) return reply(404, 'This object does not exist.');
  const object = await bucket.get(versionKey(accountId, pointer.operationId));
  if (!object) return reply(500, 'The object could not be read. Try again.');
  return new Response(object.body, {
    status: 200,
    headers: {
      ETag: `"${pointer.etag}"`, 'Content-Type': 'application/octet-stream',
      'Content-Length': String(pointer.size), 'Cache-Control': 'no-store',
    },
  });
}

async function listBlobs(bucket: R2Bucket, accountId: string, projectId: string): Promise<Response> {
  const prefix = `${accountId}/live/${projectId}/`;
  const objects: { name: string; etag: string; size: number }[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, include: ['customMetadata'] });
    for (const object of page.objects) {
      const name = object.key.slice(prefix.length);
      if (!BLOB_NAME.test(name) || object.customMetadata?.deleted === '1') continue;
      objects.push({ name, etag: `"${bare(object.etag)}"`, size: Number(object.customMetadata?.size ?? 0) });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return Response.json(objects, { headers: { 'Cache-Control': 'no-store' } });
}

async function deleteBlob(bucket: R2Bucket, accountId: string, projectId: string, name: string): Promise<Response> {
  const key = liveKey(accountId, projectId, name);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const pointer = await readPointer(bucket, key);
    if (!pointer || pointer.deleted) return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
    await retain(bucket, accountId, projectId, name, pointer, 'deleted');
    const tombstone = pointerBody({ ...pointer, deleted: true });
    const written = await bucket.put(key, tombstone.body, { customMetadata: tombstone.customMetadata, onlyIf: { etagMatches: pointer.etag } });
    if (written) return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  }
  return reply(409, 'The object kept changing. Try again.');
}

type PublishMeta = { accountId: string; revision: number; operationId: string; projectId: string; name: string; create: boolean; ifMatch: string; deadline: number; fingerprint: string };
type PublishResult = { status: number; etag?: string; message?: string };

async function putBlob(request: Request, env: SyncServerBindings, account: DurableAccount, projectId: string, name: string): Promise<Response> {
  const ifNoneMatch = request.headers.get('If-None-Match');
  const ifMatch = request.headers.get('If-Match');
  const create = ifNoneMatch === '*';
  if (create === (ifMatch !== null) || (ifNoneMatch !== null && !create) || (ifMatch !== null && !STRONG_ETAG.test(ifMatch))) {
    return reply(400, 'Use If-None-Match: * to create an object, or If-Match with its ETag to replace it.');
  }
  if (request.headers.get('Content-Type') !== 'application/octet-stream') return reply(400, 'Upload the object as application/octet-stream.');
  const declaredHeader = request.headers.get('Content-Length');
  if (declaredHeader === null || !/^\d{1,16}$/.test(declaredHeader)) return reply(411, 'Send the object with a Content-Length.');
  const declared = Number(declaredHeader);
  if (declared === 0) return reply(400, 'Upload a non-empty object.');
  if (declared > MAX_OBJECT_BYTES) return reply(413, 'The object is larger than the 64 MiB upload limit.');
  const operationId = request.headers.get('Idempotency-Key') ?? crypto.randomUUID();
  if (!OPERATION_ID.test(operationId)) return reply(400, 'Use an Idempotency-Key of at most 120 letters, digits, - and _.');

  const db = env.ACCOUNT_DB!;
  const bucket = env.PROJECT_STORE!;
  const quota = new QuotaStore(db, { accountId: account.id, revision: account.revision }, { leaseMs: WRITE_LEASE_MS });
  const charged = Math.max(declared, MIN_CHARGED_BYTES);
  const reserved = await quota.reserve(operationId, operationId, charged);
  if (!reserved.ok) return quotaFailure(reserved.reason);
  const live = liveKey(account.id, projectId, name);
  const version = versionKey(account.id, operationId);
  if (reserved.operation.state === 'committed') {
    const pointer = await readPointer(bucket, live);
    if (!pointer || pointer.deleted || pointer.operationId !== operationId) {
      return reply(409, 'This upload was superseded by a later write. Read the object again.');
    }
    const stored = await bucket.head(version);
    const bytes = await readDeclaredBody(request, declared);
    if (bytes === null || stored?.customMetadata?.fingerprint !== await payloadFingerprint(projectId, name, bytes)) {
      return reply(409, 'This Idempotency-Key was used for a different upload.');
    }
    return objectResponse(200, pointer.etag);
  }
  if (reserved.operation.state !== 'reserved' && reserved.operation.state !== 'writing') {
    return reply(409, 'This upload was settled. Retry with a new Idempotency-Key.');
  }

  const bytes = await readDeclaredBody(request, declared);
  if (bytes === null) {
    await quota.cancel(operationId);
    return reply(400, 'The upload did not match its Content-Length.');
  }
  const print = await payloadFingerprint(projectId, name, bytes);
  const begun = await quota.beginWrite(operationId);
  if (!begun.ok) return quotaFailure(begun.reason);

  const meta: PublishMeta = {
    accountId: account.id, revision: account.revision, operationId, projectId, name, create,
    ifMatch: create ? '' : bare(ifMatch!), deadline: reserved.operation.deadline, fingerprint: print,
  };
  const response = await env.STORAGE_COORDINATOR!.getByName(account.id).fetch('https://storage-coordinator/publish', {
    method: 'POST',
    headers: { 'X-Publish-Meta': JSON.stringify(meta) },
    body: bytes,
  });
  if (!response.ok) return reply(503, 'Storage is unavailable. Try again shortly.');
  const result = await response.json() as PublishResult;
  if (result.etag !== undefined) return objectResponse(result.status, result.etag);
  return reply(result.status, result.message ?? 'The upload was refused. Read the object and try again.');
}

export async function storageRoute(request: Request, url: URL, account: DurableAccount, env: SyncServerBindings): Promise<Response> {
  const match = /^\/v1\/projects\/([^/]+)\/blobs(?:\/([^/]+))?$/.exec(url.pathname);
  if (!match) return reply(404, 'This API route does not exist.');
  const projectId = match[1]!;
  const name = match[2];
  if (!PROJECT_ID.test(projectId)) return reply(400, 'Use a project id of at most 64 letters, digits, - and _.');
  try {
    if (name === undefined) return request.method === 'GET' ? await listBlobs(env.PROJECT_STORE!, account.id, projectId) : reply(405, 'Use GET to list objects.');
    if (!BLOB_NAME.test(name)) return reply(400, 'Use an object name of at most 64 lower-case letters, digits and -.');
    if (request.method === 'GET') return await getBlob(env.PROJECT_STORE!, account.id, projectId, name);
    if (request.method === 'PUT') return await putBlob(request, env, account, projectId, name);
    if (request.method === 'DELETE') return await deleteBlob(env.PROJECT_STORE!, account.id, projectId, name);
    return reply(405, 'Use GET, PUT or DELETE for an object.');
  } catch {
    return reply(503, 'Storage is unavailable. Try again shortly.');
  }
}

export function createR2Settlement(coordinator: DurableObjectNamespace<StorageCoordinator>): QuotaSettlementAdapter {
  return {
    async settle({ accountId, operationId }) {
      const response = await coordinator.getByName(accountId).fetch('https://storage-coordinator/settle', {
        method: 'POST',
        headers: { 'X-Account-Id': accountId, 'X-Operation-Id': operationId },
      });
      if (!response.ok) return false;
      const result = await response.json() as { absent?: boolean };
      return result.absent === true;
    },
  };
}

export async function sweepQuota(env: SyncServerBindings): Promise<void> {
  try {
    const db = env.ACCOUNT_DB!;
    await reconcileQuota(db, createR2Settlement(env.STORAGE_COORDINATOR!), { now: () => Date.now(), batchSize: SWEEP_BATCH });
    const cutoff = Date.now() - PRUNE_AFTER_MS;
    const candidates = await db.prepare('SELECT account_id AS accountId, operation_id AS operationId FROM quota_operations WHERE state = ? AND swept_at <= ?')
      .bind('released', cutoff).all<{ accountId: string; operationId: string }>();
    const byAccount = new Map<string, string[]>();
    for (const row of candidates.results) {
      const ids = byAccount.get(row.accountId) ?? [];
      ids.push(row.operationId);
      byAccount.set(row.accountId, ids);
    }
    for (const [accountId, operationIds] of byAccount) {
      const response = await env.STORAGE_COORDINATOR!.getByName(accountId).fetch('https://storage-coordinator/reclaim', {
        method: 'POST',
        body: JSON.stringify({ accountId, operationIds }),
      });
      if (!response.ok) throw new Error('Fence reclaim refused');
    }
    await db.prepare('DELETE FROM quota_operations WHERE state = ? AND swept_at <= ?').bind('released', cutoff).run();
  } catch {
    console.warn({ message: 'The quota sweep could not run.' });
  }
}

export class StorageCoordinator extends DurableObject<SyncServerBindings> {
  private tail: Promise<unknown> = Promise.resolve();

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/publish') {
        const meta = JSON.parse(request.headers.get('X-Publish-Meta') ?? 'null') as PublishMeta | null;
        if (!meta || typeof meta.accountId !== 'string' || typeof meta.operationId !== 'string') return Response.json({ status: 400 }, { status: 400 });
        const bytes = new Uint8Array(await request.arrayBuffer());
        const result = await this.serialize(() => this.publish(meta, bytes));
        return Response.json(result);
      }
      if (url.pathname === '/reclaim') {
        const body = await request.json() as { accountId?: unknown; operationIds?: unknown };
        if (typeof body.accountId !== 'string' || !Array.isArray(body.operationIds)) return Response.json({ status: 400 }, { status: 400 });
        const accountId = body.accountId;
        const ids = body.operationIds.filter((id): id is string => typeof id === 'string' && OPERATION_ID.test(id));
        await this.serialize(async () => {
          for (const id of ids) await this.env.PROJECT_STORE!.delete(fenceKey(accountId, id));
        });
        return Response.json({ ok: true });
      }
      if (url.pathname === '/settle') {
        const accountId = request.headers.get('X-Account-Id') ?? '';
        const operationId = request.headers.get('X-Operation-Id') ?? '';
        const absent = await this.serialize(() => this.settle(accountId, operationId));
        return Response.json({ absent });
      }
      return Response.json({ status: 404 }, { status: 404 });
    } catch {
      return Response.json({ status: 503 }, { status: 503 });
    }
  }

  private async publish(meta: PublishMeta, bytes: Uint8Array): Promise<PublishResult> {
    const bucket = this.env.PROJECT_STORE!;
    const quota = new QuotaStore(this.env.ACCOUNT_DB!, { accountId: meta.accountId, revision: meta.revision }, { leaseMs: WRITE_LEASE_MS });
    const { accountId, operationId, projectId, name } = meta;
    const live = liveKey(accountId, projectId, name);
    const version = versionKey(accountId, operationId);
    if (await bucket.head(fenceKey(accountId, operationId))) {
      return { status: 409, message: 'This upload was settled. Retry with a new Idempotency-Key.' };
    }
    const writtenVersion = await bucket.put(version, bytes, { customMetadata: { project: projectId, name, fingerprint: meta.fingerprint }, onlyIf: { etagDoesNotMatch: '*' } });
    if (!writtenVersion) {
      const stored = await bucket.head(version);
      if (stored?.customMetadata?.fingerprint !== meta.fingerprint) {
        return { status: 409, message: 'This Idempotency-Key was used for a different upload.' };
      }
    }
    const current = await readPointer(bucket, live);
    if (current && !current.deleted && current.operationId === operationId) {
      const committed = await quota.commit(operationId);
      return committed.ok ? { status: 200, etag: current.etag } : { status: 409, message: 'The upload was refused. Read the object and try again.' };
    }
    if (meta.create ? current !== null && !current.deleted : current === null || current.deleted || current.etag !== meta.ifMatch) {
      await quota.cancel(operationId);
      return { status: 412, message: 'The object changed since it was read. Nothing was written.' };
    }
    if (current && !current.deleted) await retain(bucket, accountId, projectId, name, current, 'replaced');
    if (Date.now() >= meta.deadline) {
      await quota.cancel(operationId);
      return { status: 409, message: 'The upload lease expired. Read the object and try again.' };
    }
    const pointer = pointerBody({ operationId, size: bytes.byteLength, uploaded: Date.now() });
    const condition = meta.create
      ? (current ? { etagMatches: current.etag } : { etagDoesNotMatch: '*' })
      : { etagMatches: meta.ifMatch };
    const written = await bucket.put(live, pointer.body, { customMetadata: pointer.customMetadata, onlyIf: condition });
    if (!written) {
      const again = await readPointer(bucket, live);
      if (again && !again.deleted && again.operationId === operationId) {
        const committed = await quota.commit(operationId);
        return committed.ok ? { status: 200, etag: again.etag } : { status: 409, message: 'The upload was refused. Read the object and try again.' };
      }
      await quota.cancel(operationId);
      return { status: 412, message: 'The object changed since it was read. Nothing was written.' };
    }
    const committed = await quota.commit(operationId);
    if (!committed.ok) return { status: committed.reason === 'unavailable' ? 503 : 409, message: 'The upload was refused. Read the object and try again.' };
    return { status: meta.create ? 201 : 200, etag: written.etag };
  }

  private async settle(accountId: string, operationId: string): Promise<boolean> {
    const bucket = this.env.PROJECT_STORE!;
    const fence = fenceKey(accountId, operationId);
    if (!await bucket.head(fence)) await bucket.put(fence, '1', { customMetadata: { at: String(Date.now()) } });
    const history = historyKey(accountId, operationId);
    if (await bucket.head(history)) return false;
    const version = versionKey(accountId, operationId);
    const object = await bucket.head(version);
    if (object) {
      const projectId = object.customMetadata?.project;
      const name = object.customMetadata?.name;
      if (typeof projectId !== 'string' || typeof name !== 'string') return false;
      const pointer = await bucket.head(liveKey(accountId, projectId, name));
      if (pointer && pointer.customMetadata?.deleted !== '1' && pointer.customMetadata?.operation === operationId) return false;
      await bucket.delete(version);
    }
    await bucket.delete(history);
    return await bucket.head(version) === null && await bucket.head(history) === null;
  }
}