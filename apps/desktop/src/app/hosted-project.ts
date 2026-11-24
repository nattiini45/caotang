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
 * The queue an earlier tab left for this project: the adapter's own text, kept on this device under the account's scope. A text
 * this build cannot read is dropped by the caller rather than failing the open, because a project that opens is worth more than a
 * queue nobody can send.
 */
async function heldQueue(
  source: HostedProjectSource,
  fs: EncryptedRemoteArtifactFs,
): Promise<{ edits: PendingEdits; port: HostedQueuePort } | null> {
  const kept = loadHostedQueue(source.projectId);
  if (kept === null) return null;
  const { PendingEdits, replayPending } = await import('@caotang/remote-store');
  let edits: PendingEdits;
  try {
    edits = PendingEdits.parse(kept);
  } catch {
    saveHostedQueue(source.projectId, null);
    return null;
  }
  const keep = (): void => {
    saveHostedQueue(source.projectId, edits.isEmpty ? null : edits.serialize());
  };
  const port: HostedQueuePort = {
    hold: (changes) => {
      edits.stageAll(changes);
      keep();
    },
    replay: async (): Promise<HostedReplay> => {
      try {
        const count = await replayPending(fs, edits);
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
    forget: () => {
      edits.clear();
      keep();
    },
    held: () => edits.paths,
    marks: () => keepMarks(source, fs),
  };
  return { edits, port };
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
  const queue = await heldQueue(source, fs);
  keepMarks(source, fs);
  return new HostedTarget(source.projectId, fs, (state) => saveProjectToAccount(fs, state), queue?.port ?? null);
}
