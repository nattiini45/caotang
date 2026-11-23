/**
 * The writer's consent for a recurring task to start by itself (agent-harness.md §12), kept on this machine.
 *
 * A consent names one task of one project by the hash of what it does (`bodyHash` in `@caotang/tasks`): its body, schedule, permission
 * and call cap. Editing any of those voids it, because the writer allowed the task as it was, not as it became. The record lives in the
 * app database (`caotang-app`, the `task-consents` store), keyed by project and task, and **never in the project, a bundle or an export**:
 * a shared project cannot ship permission to spend a writer's key, and an imported copy is offered its tasks afresh.
 *
 * A consent is kept only when the database took it. With no database, or one that will not write, granting is refused in words and the
 * task stays offered: failing to remember is never a reason to run something unasked.
 */

import type { TaskConsent } from '@caotang/tasks';
import { t } from '@lingui/core/macro';
import { isIdWithPrefix } from '@caotang/ids';

import { activeAppDb, type TaskConsentDb } from './app-db.js';

const keyOf = (projectId: string, taskId: string): string => `${projectId}:${taskId}`;

export class TaskConsents {
  private readonly granted = new Map<string, { readonly hash: string; readonly grantedAt: string }>();
  private readonly pendingGrants = new Set<string>();
  private readonly revoking = new Set<string>();

  private constructor(
    readonly projectId: string,
    private readonly db: TaskConsentDb | null,
  ) {}

  /** The consents kept for a project. A database that cannot be read gives none, so every model task is offered. */
  static async open(projectId: string, db: { readonly taskConsents?: TaskConsentDb } | null = activeAppDb()): Promise<TaskConsents> {
    const consents = new TaskConsents(projectId, db?.taskConsents ?? null);
    if (consents.db === null) return consents;
    try {
      for (const row of await consents.db.list(projectId)) {
        if (row.projectId !== projectId || row.key !== keyOf(projectId, row.taskId) || !isIdWithPrefix('t', row.taskId)) continue;
        if (!/^[a-f0-9]{64}$/.test(row.hash) || !Number.isFinite(Date.parse(row.grantedAt))) continue;
        consents.granted.set(row.taskId, { hash: row.hash, grantedAt: row.grantedAt });
      }
    } catch {
      consents.granted.clear();
    }
    return consents;
  }

  /** A project's consents with nowhere to keep them: none are held, and none can be granted. */
  static none(projectId: string): TaskConsents {
    return new TaskConsents(projectId, null);
  }

  /** The consent held for a task, or `undefined`. `effectiveWhenDue` tests its hash against the task as it is now. */
  get(taskId: string): TaskConsent | undefined {
    if (this.revoking.has(taskId)) return undefined;
    const held = this.granted.get(taskId);
    return held === undefined ? undefined : { hash: held.hash };
  }

  /** When the writer allowed the task to start by itself, or `undefined`. */
  grantedAt(taskId: string): string | undefined {
    return this.granted.get(taskId)?.grantedAt;
  }

  /** Keeps the writer's consent for the task as its hash is now. Resolves with why it was not kept, or `null`. */
  async grant(taskId: string, hash: string, at: string): Promise<string | null> {
    if (this.db === null) return t`This browser will not keep the allowance on this machine, so the task stays offered when it is due.`;
    this.pendingGrants.add(taskId);
    try {
      await this.db.put({ key: keyOf(this.projectId, taskId), projectId: this.projectId, taskId, hash, grantedAt: at });
    } catch {
      return t`The allowance could not be saved on this machine, so the task stays offered when it is due. Try again.`;
    } finally {
      this.pendingGrants.delete(taskId);
    }
    this.granted.set(taskId, { hash, grantedAt: at });
    return null;
  }

  /** Takes the allowance back. Resolves with why it was not taken back, or `null`; a failed write keeps the consent, so nothing starts by itself that the writer believes is off. */
  async revoke(taskId: string): Promise<string | null> {
    if (!this.granted.has(taskId) && !this.pendingGrants.has(taskId)) return null;
    if (this.db === null) return null;
    this.revoking.add(taskId);
    try {
      await this.db.delete([keyOf(this.projectId, taskId)]);
      this.granted.delete(taskId);
    } catch {
      return t`The allowance could not be taken back on this machine. Try again.`;
    } finally {
      this.revoking.delete(taskId);
    }
    return null;
  }

  /** Forgets a task's consent when the task is deleted. A failed sweep costs a few bytes: the id names no task that exists. */
  async forget(taskId: string): Promise<void> {
    this.granted.delete(taskId);
    if (this.db === null) return;
    try {
      await this.db.delete([keyOf(this.projectId, taskId)]);
    } catch {
      // A consent of a task that is gone is never read.
    }
  }
}

/** Removes every consent kept for a project, when the project is removed. */
export async function dropTaskConsentsOf(projectId: string, db: { readonly taskConsents?: TaskConsentDb } | null = activeAppDb()): Promise<void> {
  const consents = db?.taskConsents;
  if (consents === undefined) return;
  try {
    const kept = await consents.list(projectId);
    await consents.delete(kept.map((row) => row.key));
  } catch {
    // A consent of a project that is gone is never read, so a failed sweep costs a few bytes and nothing else.
  }
}
