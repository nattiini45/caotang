import { beforeEach, describe, expect, it } from 'vitest';
import { i18n } from '@lingui/core';
import { seededId } from '@caotang/ids';
import { bodyHash, type AgentTask } from '@caotang/tasks';
import type { TaskConsentDb, TaskConsentRow } from '../src/app/app-db.js';
import { dropTaskConsentsOf, TaskConsents } from '../src/app/task-consents.js';
import { asTaskRecord, type TaskRecord } from '../src/app/task-store.js';
import { messages } from '../src/i18n/locales/en/messages.po';

beforeEach(() => {
  i18n.load('en', messages);
  i18n.activate('en');
});

const projectId = seededId('p', 1);
const taskId = seededId('t', 1);
const at = '2026-11-16T09:00:00.000Z';
const task: AgentTask = {
  id: taskId, name: 'Summaries', enabled: true, schedule: { kind: 'daily', at: '09:00' }, whenDue: 'run',
  permission: 'ask', maxModelCalls: 2,
  body: { kind: 'plan', steps: [{ tool: 'synopsis.fill', params: { docs: ['The lamp'] }, expect: 'A synopsis' }] },
};

function database() {
  const rows = new Map<string, TaskConsentRow>();
  const db: TaskConsentDb = {
    async list(project) { return [...rows.values()].filter((row) => row.projectId === project); },
    async put(row) { rows.set(row.key, structuredClone(row)); },
    async delete(keys) { for (const key of keys) rows.delete(key); },
  };
  return { rows, db: { taskConsents: db } };
}

describe('task allowances kept on this machine', () => {
  it('rejects a recovered queue timestamp that cannot be reconciled into an occurrence instant', () => {
    const record: TaskRecord = {
      id: seededId('task', 1), projectId, intent: 'Summaries', steps: [], items: [], status: 'ready', cap: 2, used: 0,
      promptTokens: 0, completionTokens: 0, runs: 1, createdAt: Date.parse(at), updatedAt: Date.parse(at),
      recurringTaskId: taskId, recurringHash: bodyHash(task), recurringPermission: 'ask',
    };
    expect(asTaskRecord(record, projectId)).toBeDefined();
    expect(asTaskRecord({ ...record, createdAt: 8640000000000001 }, projectId)).toBeUndefined();
    expect(asTaskRecord({ ...record, updatedAt: 8640000000000001 }, projectId)).toBeUndefined();
  });
  it('persists one exact-task hash and timestamp, never grants an imported project its allowance', async () => {
    const { db } = database();
    const store = await TaskConsents.open(projectId, db);
    expect(await store.grant(taskId, bodyHash(task), at)).toBeNull();
    const reopened = await TaskConsents.open(projectId, db);
    expect(reopened.get(taskId)).toEqual({ hash: bodyHash(task) });
    expect(reopened.grantedAt(taskId)).toBe(at);
    expect((await TaskConsents.open(seededId('p', 2), db)).get(taskId)).toBeUndefined();
  });

  it('does not grant anything when storage is absent, unreadable or refuses a write', async () => {
    expect(await TaskConsents.none(projectId).grant(taskId, bodyHash(task), at)).toContain('stays offered');
    const failing: TaskConsentDb = {
      async list() { throw Error('read'); }, async put() { throw Error('write'); }, async delete() { throw Error('delete'); },
    };
    const store = await TaskConsents.open(projectId, { taskConsents: failing });
    expect(store.get(taskId)).toBeUndefined();
    expect(await store.grant(taskId, bodyHash(task), at)).toContain('stays offered');
    expect(store.get(taskId)).toBeUndefined();
  });

  it('rejects foreign, malformed and mismatched rows rather than treating them as permission', async () => {
    const valid = { key: `${projectId}:${taskId}`, projectId, taskId, hash: bodyHash(task), grantedAt: at };
    for (const patch of [{ projectId: 'other' }, { key: 'other' }, { taskId: '../../bad' }, { hash: 'bad' }, { grantedAt: 'bad' }]) {
      const store = await TaskConsents.open(projectId, { taskConsents: { async list() { return [{ ...valid, ...patch }]; }, async put() {}, async delete() {} } });
      expect(store.get(taskId)).toBeUndefined();
    }
  });

  it('revokes durably and reports failed revocations without claiming success', async () => {
    const { db } = database();
    const store = await TaskConsents.open(projectId, db);
    await store.grant(taskId, bodyHash(task), at);
    const remove = db.taskConsents.delete;
    db.taskConsents.delete = async () => { throw Error('blocked'); };
    expect(await store.revoke(taskId)).toContain('could not be taken back');
    expect(store.get(taskId)).toBeDefined();
    db.taskConsents.delete = remove;
    expect(await store.revoke(taskId)).toBeNull();
    expect((await TaskConsents.open(projectId, db)).get(taskId)).toBeUndefined();
  });

  it('forgets deleted tasks and sweeps only the removed project', async () => {
    const { db } = database();
    const store = await TaskConsents.open(projectId, db);
    await store.grant(taskId, bodyHash(task), at);
    await store.forget(taskId);
    expect((await TaskConsents.open(projectId, db)).get(taskId)).toBeUndefined();
    await store.grant(taskId, bodyHash(task), at);
    const other = await TaskConsents.open(seededId('p', 2), db);
    await other.grant(taskId, bodyHash(task), at);
    await dropTaskConsentsOf(projectId, db);
    expect((await TaskConsents.open(projectId, db)).get(taskId)).toBeUndefined();
    expect((await TaskConsents.open(seededId('p', 2), db)).get(taskId)).toBeDefined();
  });

  it('offers the task while its durable revocation is pending', async () => {
    const { db } = database();
    const store = await TaskConsents.open(projectId, db);
    await store.grant(taskId, bodyHash(task), at);
    const remove = db.taskConsents.delete;
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    db.taskConsents.delete = async (keys) => { await gate; await remove(keys); };
    const revoking = store.revoke(taskId);
    expect(store.get(taskId)).toBeUndefined();
    release();
    expect(await revoking).toBeNull();
    expect((await TaskConsents.open(projectId, db)).get(taskId)).toBeUndefined();
  });
});
