/**
 * The two pieces a hosted open needs from outside the app: the encrypted adapter for the project, and the pictures the
 * project carries. They live here rather than in `lifecycle.ts` so the only reference to `@caotang/remote-store` in the
 * app is one dynamic import in one module — `caotang.app` reaches it when a host hands a project over, and not before.
 *
 * The assets directory is the project format's own (`project-assets.ts` names the same one); it is repeated here so this
 * module compiles and its test runs without the app's component graph.
 */
import type { ArtifactFs } from '@caotang/store';
import type { EncryptedRemoteArtifactFs, PendingEdits } from '@caotang/remote-store';
import { HostedTarget, type HostedQueuePort, type HostedReplay } from './hosted-target.js';
import { loadHostedMarks, loadHostedQueue, saveHostedMarks, saveHostedQueue } from './hosted-queue.js';
import type { HostedProjectSource } from './studio-host.js';

/** `assets/` in a project — pictures, the cover among them (project-format §2). */
const ASSETS_DIR = 'assets';

/**
 * The encrypted adapter over one project, opened on the key the host handed over, with the rollback marks this device kept: a
 * server that serves an older version than this device has seen is refused rather than quietly accepted (hosted.md §7).
 */
export async function openRemoteProject(source: HostedProjectSource): Promise<EncryptedRemoteArtifactFs> {
  const { EncryptedRemoteArtifactFs, HighWaterMarks, createHttpBlobStore } = await import('@caotang/remote-store');
  const blob = createHttpBlobStore({ origin: source.origin, projectId: source.projectId, device: source.device });
  const highWater = new HighWaterMarks(loadHostedMarks(source.projectId));
  return await EncryptedRemoteArtifactFs.open({ store: blob, projectId: source.projectId, projectKey: source.key, highWater });
}

/** This device's marks as they stand, written where the next open reads them. */
function keepMarks(source: HostedProjectSource, fs: EncryptedRemoteArtifactFs): void {
  saveHostedMarks(source.projectId, fs.highWater.entries());
}

/**
 * The queue this project keeps on this device: the adapter's own edits and the account version each was written against, kept under
 * the account's scope. It exists whether or not an earlier tab left anything, because the first save the server does not take has to
 * be held somewhere. A text this build cannot read is dropped rather than failing the open, because a project that opens is worth
 * more than a queue nobody can send.
 */
export async function deviceQueue(source: HostedProjectSource, fs: EncryptedRemoteArtifactFs): Promise<HostedQueuePort> {
  const kept = loadHostedQueue(source.projectId);
  const { PendingEdits, replayPending } = await import('@caotang/remote-store');
  let edits: PendingEdits = new PendingEdits();
  /**
   * The version each held path had when this device last read the account: an edit is only the latest one if the file has not
   * moved since. Without it a replay would write an older edit on top of another device's newer one, because the adapter can only
   * tell that a path moved since *this* device read the index, and a reload always reads it fresh.
   */
  const base = new Map<string, number>();
  const load = (text: string | null): void => {
    if (text === null) return;
    try {
      const raw: unknown = JSON.parse(text);
      const keptEdits = typeof raw === 'object' && raw !== null && 'edits' in raw ? raw.edits : undefined;
      if (typeof keptEdits !== 'string') throw new Error('no edits');
      edits = PendingEdits.parse(keptEdits);
      const rows = typeof raw === 'object' && raw !== null && 'base' in raw ? raw.base : undefined;
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (Array.isArray(row) && typeof row[0] === 'string' && Number.isSafeInteger(row[1])) base.set(row[0], row[1] as number);
        }
      }
    } catch {
      edits = new PendingEdits();
      base.clear();
      saveHostedQueue(source.projectId, null);
    }
  };
  load(kept);
  const keep = (): void => {
    saveHostedQueue(source.projectId, edits.isEmpty ? null : JSON.stringify({ format: 1, edits: edits.serialize(), base: [...base] }));
  };
  return {
    hold: (changes) => {
      // The versions are read before the save that failed, so they are the ones this device's edit was written against.
      for (const change of changes) if (!base.has(change.path)) base.set(change.path, fs.versionOf(change.path));
      edits.stageAll(changes);
      keep();
    },
    replay: async (): Promise<HostedReplay> => {
      const moved = edits.paths.filter((path) => base.get(path) !== undefined && base.get(path) !== fs.versionOf(path));
      if (moved.length > 0) return { kind: 'conflict', paths: moved };
      try {
        const count = await replayPending(fs, edits);
        // A path the replay did not settle is one whose edit arrived while the commit was on its way: it keeps the version it was
        // staged against, so the next replay still refuses it if the account moved too.
        const queued = new Set(edits.paths);
        for (const path of [...base.keys()]) if (!queued.has(path)) base.delete(path);
        keep();
        keepMarks(source, fs);
        return { kind: 'sent', count };
      } catch (error) {
        // A refusal leaves the queue as it was; which refusal it was is the writer's next question, not this one's error.
        if (error instanceof Error && 'paths' in error) {
          const paths = (error as { paths?: unknown }).paths;
          if (Array.isArray(paths) && paths.every((path) => typeof path === 'string')) return { kind: 'conflict', paths };
        }
        return { kind: 'unavailable' };
      }
    },
    forget: (paths?: readonly string[]) => {
      if (paths === undefined) {
        edits.clear();
        base.clear();
        keep();
        return;
      }
      // A path is only settled while the account has not moved it since the words were staged: a save that wrote the path leaves the
      // account at a newer version than the one the edit was staged against, and an edit staged after that save — against the version
      // it wrote — is newer than the save and stays queued for the next send.
      const settled = paths.filter((path) => base.get(path) !== undefined && base.get(path) !== fs.versionOf(path));
      edits.clear(settled);
      for (const path of settled) base.delete(path);
      keep();
    },
    held: () => edits.paths,
    // The writer's own answer to the question: the version the refresh just read becomes the one these words were written against,
    // so the replay that follows is measured against the account as it stands rather than against the version that was refused.
    rebase: (paths) => {
      for (const path of paths) base.set(path, fs.versionOf(path));
      keep();
    },
    marks: () => keepMarks(source, fs),
  };
}

/**
 * Every file under `assets/`, read through the project's own filesystem. The pictures travel with the project: the copy this
 * browser keeps is what a later save is measured against, so a picture left behind here would be a picture the next save
 * prunes from the account.
 */
export async function picturesOnProjectFs(fs: ArtifactFs): Promise<Record<string, Uint8Array>> {
  const pictures: Record<string, Uint8Array> = {};
  for (const name of await fs.listFiles(ASSETS_DIR)) pictures[`${ASSETS_DIR}/${name}`] = await fs.readBytes(`${ASSETS_DIR}/${name}`);
  return pictures;
}

/**
 * The project's save target, on the same adapter: the whole project's save goes through `saveProjectToAccount`, which stages
 * the app's write path into one commit. Built here because this is the module that may import the package at all.
 */
export async function openHostedTarget(source: HostedProjectSource): Promise<HostedTarget> {
  const fs = await openRemoteProject(source);
  const { saveProjectToAccount } = await import('@caotang/remote-store');
  const queue = await deviceQueue(source, fs);
  keepMarks(source, fs);
  return new HostedTarget(
    source.projectId,
    fs,
    (state, options) => saveProjectToAccount(fs, state, { removed: options?.removed, assets: options?.assets }),
    queue,
  );
}
