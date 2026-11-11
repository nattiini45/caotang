import { t } from '@lingui/core/macro';
import type { CommandRegistry } from '@caotang/bus';
import { serializeCoherenceFile, type CoherenceFile } from '@caotang/coherence';
import { readRunBaseline, runRestoreRegistrations, runRestoreSignature, undoGroupRetention, writeRunBaseline, type StagedRunRestore, type UndoRetentionLedger } from '@caotang/store';
import type { ProjectSession, RestoreResult } from './session.js';
import type { Persistence } from './persistence.js';
import { captureRunBaseline, validateRunBaseline } from './run-baseline.js';

export class RunRecovery {
  private readonly staged = new Map<string, StagedRunRestore>();
  private readonly beforeGroups = new Map<string, ReadonlySet<string>>();

  constructor(private readonly session: ProjectSession, private readonly persistence: Persistence, private readonly ledger: UndoRetentionLedger, private readonly rollback: (id: string) => void, registry: CommandRegistry) {
    Object.assign(registry, runRestoreRegistrations({
      read: (runId) => this.staged.get(runId),
      beforeReplace: (before) => {
        persistence.stageAtomicRestore(before, session.runRestoreCoherenceText(before.coherence === undefined ? null : serializeCoherenceFile(before.coherence as CoherenceFile)), (coherence) => session.acknowledgeRunRestore(coherence));
      },
    }, ledger));
  }

  async capture(runId: string): Promise<void> {
    const session = this.session;
    if (await readRunBaseline(session.runtimeStore(), session.projectId, runId) !== undefined) return;
    await session.saved();
    if (this.persistence.isStopped()) throw new Error(t`This tab no longer owns the project. Copy unsaved text before reloading.`);
    const expected = runRestoreSignature(session.state);
    const groups = new Set(session.undo.groups().map((group) => group.id));
    const baseline = await captureRunBaseline(session.state);
    if (runRestoreSignature(session.state) !== expected) throw new Error(t`The project changed while its restore point was being saved. Try the request again.`);
    if (await writeRunBaseline(session.runtimeStore(), session.projectId, runId, baseline)) this.beforeGroups.set(runId, groups);
  }

  async prepare(runId: string): Promise<string> {
    const session = this.session;
    await session.saved();
    if (this.persistence.isStopped()) throw new Error(t`This tab no longer owns the project. Copy unsaved text before reloading.`);
    const expected = runRestoreSignature(session.state);
    const baseline = await readRunBaseline(session.runtimeStore(), session.projectId, runId);
    if (baseline === undefined) throw new Error(t`This run has no restore point.`);
    const state = await validateRunBaseline(baseline, session.projectId);
    if (runRestoreSignature(session.state) !== expected) throw new Error(t`The project changed. Review the restore again.`);
    this.staged.set(runId, { state, expected });
    return expected;
  }

  async restore(runId: string, expected: string, onRestored?: (groups: readonly string[]) => () => void): Promise<RestoreResult> {
    const session = this.session;
    await session.saved();
    const staged = this.staged.get(runId);
    if (this.persistence.isStopped() || staged?.expected !== expected || runRestoreSignature(session.state) !== expected) {
      return { ok: false, message: t`The project changed after you opened the confirmation. Nothing was restored. Review the restore again.`, undone: [] };
    }
    const groups = session.undo.groups().filter((group) => !this.beforeGroups.get(runId)?.has(group.id));
    const retired = groups.map((group) => group.id);
    let undoMarkers: () => void = () => undefined;
    this.staged.set(runId, { ...staged, retainedAssets: [...undoGroupRetention(groups, this.ledger).ids.keys()], onUndo: () => {
      for (const group of groups) for (const entry of group.entries) session.undo.register({ id: group.id, kind: group.kind, at: group.at, ...(group.turnId === undefined ? {} : { turnId: group.turnId }), replay: false }, entry);
      undoMarkers();
    } });
    const result = session.dispatch('project.restoreRun', { runId });
    this.staged.delete(runId);
    if (!result.ok) return { ok: false, message: result.error.message, undone: [] };
    for (const id of retired) session.undo.forget(id);
    try { await session.saved(); }
    catch {
      if (this.persistence.isStopped()) {
        const restoreGroup = session.newestUndoGroupId();
        if (restoreGroup !== null) this.rollback(restoreGroup);
        return { ok: false, message: t`A newer stored project refused the restore. No restore files were written. This tab’s previous content is kept; copy unsaved text before reloading.`, undone: [] };
      }
      undoMarkers = onRestored?.(retired) ?? undoMarkers;
      return { ok: false, message: t`The project was restored in this tab, but it could not be saved. Keep this tab open and retry the failed save.`, undone: retired };
    }
    undoMarkers = onRestored?.(retired) ?? undoMarkers;
    return { ok: true, later: retired.length, undone: retired };
  }
}
