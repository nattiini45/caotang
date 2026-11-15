/**
 * Encrypted object storage on R2 — [hosted.md §6](../../../docs/architecture/hosted.md) and
 * [sync-server.md](../../../docs/architecture/sync-server.md). Opaque bytes under opaque names, one account at a
 * time: write-once version objects, a compare-and-swap live pointer as the commit point, and quota charging
 * through the D1 lease seam. The server never parses a payload.
 */
import type { DurableAccount } from './accounts.js';
import { QuotaStore, reconcileQuota, type QuotaResult, type QuotaSettlementAdapter } from './quota.js';

export const MAX_OBJECT_BYTES = 64 * 1024 * 1024;
export const MIN_CHARGED_BYTES = 285;
const WRITE_LEASE_MS = 60_000;
const SETTLE_GRACE_MS = 60_000;
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

async function fingerprint(projectId: string, name: string, bytes: Uint8Array): Promise<string> {
  const prefix = new TextEncoder().encode(`${projectId}\0${name}\0`);
  const input = new Uint8Array(prefix.byteLength + bytes.byteLength);
  input.set(prefix);
  input.set(bytes, prefix.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
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

async function putBlob(request: Request, bucket: R2Bucket, db: D1Database, account: DurableAccount, projectId: string, name: string): Promise<Response> {
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
    if (bytes === null || stored?.customMetadata?.fingerprint !== await fingerprint(projectId, name, bytes)) {
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
  const print = await fingerprint(projectId, name, bytes);
  const begun = await quota.beginWrite(operationId);
  if (!begun.ok) return quotaFailure(begun.reason);

  const fence = fenceKey(account.id, operationId);
  if (await bucket.head(fence)) {
    await quota.cancel(operationId);
    return reply(409, 'This upload was settled. Retry with a new Idempotency-Key.');
  }
  const writtenVersion = await bucket.put(version, bytes, { customMetadata: { project: projectId, name, fingerprint: print }, onlyIf: { etagDoesNotMatch: '*' } });
  if (!writtenVersion) {
    const stored = await bucket.head(version);
    if (stored?.customMetadata?.fingerprint !== print) {
      await quota.cancel(operationId);
      return reply(409, 'This Idempotency-Key was used for a different upload.');
    }
  }
  if (await bucket.head(fence)) {
    await bucket.delete(version);
    await quota.cancel(operationId);
    return reply(409, 'This upload was settled. Retry with a new Idempotency-Key.');
  }

  const current = await readPointer(bucket, live);
  if (current && !current.deleted && current.operationId === operationId) {
    const committed = await quota.commit(operationId);
    return committed.ok ? objectResponse(200, current.etag) : quotaFailure(committed.reason);
  }
  if (create ? current !== null && !current.deleted : current === null || current.deleted || current.etag !== bare(ifMatch!)) {
    await quota.cancel(operationId);
    return reply(412, 'The object changed since it was read. Nothing was written.');
  }
  if (current && !current.deleted) await retain(bucket, account.id, projectId, name, current, 'replaced');
  if (Date.now() >= reserved.operation.deadline) {
    await quota.cancel(operationId);
    return reply(409, 'The upload lease expired. Read the object and try again.');
  }
  const pointer = pointerBody({ operationId, size: bytes.byteLength, uploaded: Date.now() });
  const condition = create
    ? (current ? { etagMatches: current.etag } : { etagDoesNotMatch: '*' })
    : { etagMatches: bare(ifMatch!) };
  const written = await bucket.put(live, pointer.body, { customMetadata: pointer.customMetadata, onlyIf: condition });
  if (!written) {
    await quota.cancel(operationId);
    return reply(412, 'The object changed since it was read. Nothing was written.');
  }
  if (await bucket.head(fence)) {
    const undo = current && !current.deleted
      ? pointerBody(current)
      : pointerBody({ operationId, size: bytes.byteLength, uploaded: Date.now(), deleted: true });
    await bucket.put(live, undo.body, { customMetadata: undo.customMetadata, onlyIf: { etagMatches: written.etag } });
    await bucket.delete(version);
    await quota.cancel(operationId);
    return reply(409, 'This upload was settled. Retry with a new Idempotency-Key.');
  }
  const committed = await quota.commit(operationId);
  return committed.ok ? objectResponse(create ? 201 : 200, written.etag) : quotaFailure(committed.reason);
}

export async function storageRoute(request: Request, url: URL, account: DurableAccount, bucket: R2Bucket, db: D1Database): Promise<Response> {
  const match = /^\/v1\/projects\/([^/]+)\/blobs(?:\/([^/]+))?$/.exec(url.pathname);
  if (!match) return reply(404, 'This API route does not exist.');
  const projectId = match[1]!;
  const name = match[2];
  if (!PROJECT_ID.test(projectId)) return reply(400, 'Use a project id of at most 64 letters, digits, - and _.');
  try {
    if (name === undefined) return request.method === 'GET' ? await listBlobs(bucket, account.id, projectId) : reply(405, 'Use GET to list objects.');
    if (!BLOB_NAME.test(name)) return reply(400, 'Use an object name of at most 64 lower-case letters, digits and -.');
    if (request.method === 'GET') return await getBlob(bucket, account.id, projectId, name);
    if (request.method === 'PUT') return await putBlob(request, bucket, db, account, projectId, name);
    if (request.method === 'DELETE') return await deleteBlob(bucket, account.id, projectId, name);
    return reply(405, 'Use GET, PUT or DELETE for an object.');
  } catch {
    return reply(503, 'Storage is unavailable. Try again shortly.');
  }
}

export function createR2Settlement(bucket: R2Bucket): QuotaSettlementAdapter {
  return {
    async settle({ accountId, operationId }) {
      const fence = fenceKey(accountId, operationId);
      const marker = await bucket.head(fence);
      const now = Date.now();
      if (!marker) {
        await bucket.put(fence, '1', { customMetadata: { at: String(now) } });
        return false;
      }
      const fencedAt = Number(marker.customMetadata?.at);
      if (!Number.isSafeInteger(fencedAt) || now - fencedAt < SETTLE_GRACE_MS) return false;
      const version = versionKey(accountId, operationId);
      const history = historyKey(accountId, operationId);
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
    },
  };
}

export async function sweepQuota(db: D1Database, bucket: R2Bucket): Promise<void> {
  try {
    await reconcileQuota(db, createR2Settlement(bucket), { now: () => Date.now(), batchSize: SWEEP_BATCH });
  } catch {
    console.warn({ message: 'The quota sweep could not run.' });
  }
}