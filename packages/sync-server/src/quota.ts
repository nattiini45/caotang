import { quotaMachine } from './quota-lifecycle.js';
import type { QuotaEvent, QuotaState } from './quota-lifecycle.js';

export type { QuotaState } from './quota-lifecycle.js';
export type QuotaPrincipal = { accountId: string; revision: number };
export type QuotaUsage = { limitBytes: number; usedBytes: number; reservedBytes: number };
export type QuotaOperation = {
  operationId: string;
  objectKey: string;
  bytes: number;
  revision: number;
  deadline: number;
  state: QuotaState;
};
export type QuotaResult = { ok: true; operation: QuotaOperation } | {
  ok: false;
  reason: 'invalid' | 'unavailable' | 'conflict' | 'capacity' | 'not-found' | 'transition' | 'expired';
};

const columns = 'operation_id AS operationId, object_key AS objectKey, bytes, revision, deadline, state';
const admitted = `EXISTS (SELECT 1 FROM accounts WHERE account_id = ? AND status = 'active' AND session_revision = ?)`;

function identifier(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function integer(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export class QuotaStore {
  private readonly db: D1Database;
  private readonly principal: QuotaPrincipal;
  private readonly leaseMs: number;
  private readonly now: () => number;

  constructor(db: D1Database, principal: QuotaPrincipal, options: { leaseMs: number; now?: () => number }) {
    if (!identifier(principal.accountId) || !integer(principal.revision) || principal.revision === 0
      || !integer(options.leaseMs) || options.leaseMs === 0) throw new RangeError('Invalid quota configuration');
    this.db = db;
    this.principal = { ...principal };
    this.leaseMs = options.leaseMs;
    this.now = options.now ?? Date.now;
  }

  usage(): Promise<QuotaUsage | null> {
    return this.db.withSession('first-primary').prepare(`SELECT quota_limit AS limitBytes, quota_used AS usedBytes, quota_reserved AS reservedBytes
      FROM accounts WHERE account_id = ? AND status = 'active' AND session_revision = ?`)
      .bind(this.principal.accountId, this.principal.revision).first<QuotaUsage>();
  }

  async reserve(operationId: string, objectKey: string, bytes: number): Promise<QuotaResult> {
    const now = this.now();
    const deadline = now + this.leaseMs;
    if (!identifier(operationId) || !identifier(objectKey) || !integer(bytes) || !integer(now) || !integer(deadline)) {
      return { ok: false, reason: 'invalid' };
    }
    const { accountId, revision } = this.principal;
    const inserted = await this.db.withSession('first-primary').prepare(`INSERT INTO quota_operations
      (account_id, operation_id, object_key, bytes, revision, deadline, state)
      SELECT ?, ?, ?, ?, ?, ?, 'reserved' WHERE ${admitted}
      AND ? <= (SELECT quota_limit - quota_used - quota_reserved FROM accounts WHERE account_id = ?)
      AND NOT EXISTS (SELECT 1 FROM quota_operations WHERE account_id = ? AND (operation_id = ? OR object_key = ?))
      RETURNING ${columns}`)
      .bind(accountId, operationId, objectKey, bytes, revision, deadline, accountId, revision,
        bytes, accountId, accountId, operationId, objectKey).first<QuotaOperation>();
    if (inserted) return { ok: true, operation: inserted };
    if (!await this.usage()) return { ok: false, reason: 'unavailable' };
    const existing = await this.find(operationId);
    if (existing) {
      if (existing.objectKey !== objectKey || existing.bytes !== bytes || existing.revision !== revision) {
        return { ok: false, reason: 'conflict' };
      }
      return { ok: true, operation: existing };
    }
    const key = await this.db.withSession('first-primary').prepare('SELECT 1 FROM quota_operations WHERE account_id = ? AND object_key = ?')
      .bind(accountId, objectKey).first();
    return { ok: false, reason: key ? 'conflict' : 'capacity' };
  }

  private find(operationId: string): Promise<QuotaOperation | null> {
    return this.db.withSession('first-primary').prepare(`SELECT ${columns} FROM quota_operations WHERE account_id = ? AND operation_id = ?`)
      .bind(this.principal.accountId, operationId).first<QuotaOperation>();
  }

  beginWrite(operationId: string): Promise<QuotaResult> {
    return this.move(operationId, 'begin');
  }

  commit(operationId: string): Promise<QuotaResult> {
    return this.move(operationId, 'commit');
  }

  cancel(operationId: string): Promise<QuotaResult> {
    return this.move(operationId, 'cancel');
  }

  abort(operationId: string): Promise<QuotaResult> {
    return this.move(operationId, 'abort');
  }

  private async move(operationId: string, event: QuotaEvent['type']): Promise<QuotaResult> {
    if (!identifier(operationId)) return { ok: false, reason: 'invalid' };
    const now = this.now();
    if (!integer(now)) return { ok: false, reason: 'invalid' };
    const { accountId, revision } = this.principal;
    const operation = await this.find(operationId);
    if (!await this.usage()) return { ok: false, reason: 'unavailable' };
    if (!operation) return { ok: false, reason: 'not-found' };
    if (operation.revision !== revision) return { ok: false, reason: 'conflict' };
    if (operation.state === 'committed' || operation.state === 'released') return { ok: true, operation };
    if ((event === 'begin' || event === 'commit') && operation.deadline <= now) return { ok: false, reason: 'expired' };
    if ((event === 'cancel' || event === 'abort') && operation.state === 'aborted') return { ok: true, operation };
    const next = quotaMachine.step({ kind: operation.state }, { type: event });
    if (next.kind === operation.state && !(event === 'begin' && operation.state === 'writing')) {
      return { ok: false, reason: 'transition' };
    }
    const updated = await this.db.withSession('first-primary').prepare(`UPDATE quota_operations SET state = ?
      WHERE account_id = ? AND operation_id = ? AND revision = ? AND state = ? AND ${admitted}
      AND (? = 0 OR deadline > ?) RETURNING ${columns}`)
      .bind(next.kind, accountId, operationId, revision, operation.state, accountId, revision,
        event === 'begin' || event === 'commit' ? 1 : 0, now).first<QuotaOperation>();
    if (updated) return { ok: true, operation: updated };
    if (!await this.usage()) return { ok: false, reason: 'unavailable' };
    const current = await this.find(operationId);
    if (current && (current.state === next.kind || current.state === 'committed' || current.state === 'released')) {
      return { ok: true, operation: current };
    }
    return { ok: false, reason: 'transition' };
  }
}

export type QuotaSettlement = { accountId: string; operationId: string; objectKey: string; bytes: number };
export interface QuotaSettlementAdapter {
  settle(operation: QuotaSettlement): Promise<boolean>;
}
export type QuotaDeferredLog = { accountId: string; objectCount: number };
export type QuotaReconciliation = { examined: number; released: number; deferred: number };

export async function reconcileQuota(
  db: D1Database,
  adapter: QuotaSettlementAdapter,
  options: { now: () => number; batchSize: number; logDeferred?: (entry: QuotaDeferredLog) => void },
): Promise<QuotaReconciliation> {
  const now = options.now();
  if (!integer(now) || !Number.isSafeInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 1_000) {
    throw new RangeError('Invalid quota reconciliation configuration');
  }
  const session = db.withSession('first-primary');
  const due = `(state = 'aborted' OR deadline <= ? OR NOT EXISTS (
    SELECT 1 FROM accounts a WHERE a.account_id = quota_operations.account_id
    AND a.status = 'active' AND a.session_revision = quota_operations.revision))`;
  const pending = await session.prepare(`SELECT account_id AS accountId, ${columns} FROM quota_operations
    WHERE state IN ('reserved', 'writing', 'aborted') AND ${due}
    ORDER BY deadline, account_id, operation_id LIMIT ?`)
    .bind(now, options.batchSize).all<QuotaOperation & { accountId: string }>();
  const result: QuotaReconciliation = { examined: pending.results.length, released: 0, deferred: 0 };
  const deferred = new Map<string, number>();
  for (const operation of pending.results) {
    const next = quotaMachine.step({ kind: operation.state }, { type: 'abort' });
    if (next.kind !== 'aborted') continue;
    const claimed = await session.prepare(`UPDATE quota_operations SET state = ?
      WHERE account_id = ? AND operation_id = ? AND state = ? AND ${due}
      RETURNING operation_id`)
      .bind(next.kind, operation.accountId, operation.operationId, operation.state, now).first();
    if (!claimed) continue;
    let absent = false;
    try {
      absent = await adapter.settle({ accountId: operation.accountId, operationId: operation.operationId,
        objectKey: operation.objectKey, bytes: operation.bytes }) === true;
    } catch {
      absent = false;
    }
    if (!absent) {
      result.deferred++;
      deferred.set(operation.accountId, (deferred.get(operation.accountId) ?? 0) + 1);
      continue;
    }
    const released = quotaMachine.step(next, { type: 'settle' });
    const changed = await session.prepare(`UPDATE quota_operations SET state = ?
      WHERE account_id = ? AND operation_id = ? AND state = ? RETURNING operation_id`)
      .bind(released.kind, operation.accountId, operation.operationId, next.kind).first();
    if (changed) result.released++;
  }
  const log = options.logDeferred ?? ((entry: QuotaDeferredLog) => { console.warn(entry); });
  for (const [accountId, objectCount] of deferred) log({ accountId, objectCount });
  return result;
}
