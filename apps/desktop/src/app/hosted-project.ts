import { bodyFile, bodyNamesOf, isBodyType, MemoryArtifactFs, MANIFEST_FILE, serializeManifest, writeProject, type ArtifactFs, type ProjectState } from '@caotang/store';
import type { EncryptedRemoteArtifactFs, PendingEdits, RemoteChange } from '@caotang/remote-store';
import { HostedTarget, type HostedQueuePort } from './hosted-target.js';
import { copyState } from './persistence-plan.js';
import { loadHostedMarks, loadHostedQueue, saveHostedMarks, saveHostedQueue } from './hosted-queue.js';
import { storageScope } from './storage-scope.js';
import type { HostedProjectSource } from './studio-host.js';

const ASSETS_DIR = 'assets';

export async function openRemoteProject(source: HostedProjectSource, scope = storageScope()): Promise<EncryptedRemoteArtifactFs> {
  const { EncryptedRemoteArtifactFs, HighWaterMarks, createHttpBlobStore } = await import('@caotang/remote-store');
  const blob = createHttpBlobStore({ origin: source.origin, projectId: source.projectId, device: source.device });
  const highWater = new HighWaterMarks(loadHostedMarks(source.projectId, scope));
  return await EncryptedRemoteArtifactFs.open({ store: blob, projectId: source.projectId, projectKey: source.key, highWater });
}

type BasedChange = RemoteChange & { readonly base: number };

export async function deviceQueue(source: HostedProjectSource, fs: EncryptedRemoteArtifactFs, scope = storageScope()): Promise<HostedQueuePort> {
  const { PendingEdits, RemoteConflictError } = await import('@caotang/remote-store');
  const edits: PendingEdits = new PendingEdits();
  const bases = new Map<string, number>();
  let id: string | null = null;
  let persisted = true;
  const marks = () => saveHostedMarks(source.projectId, fs.highWater.entries(), scope);
  const keep = () => {
    persisted = saveHostedQueue(source.projectId, id === null ? null : JSON.stringify({
      format: 2, id, edits: edits.serialize(), bases: [...bases],
    }), scope);
  };
  const retire = (accepted: string) => {
    if (id !== accepted) return;
    edits.clear();
    bases.clear();
    id = null;
    keep();
  };
  const stored = loadHostedQueue(source.projectId, scope);
  if (stored !== null) {
    try {
      const raw = JSON.parse(stored);
      if (raw?.format !== 2 || typeof raw.id !== 'string' || !/^[0-9a-f]{32}$/.test(raw.id) || typeof raw.edits !== 'string' || !Array.isArray(raw.bases)) throw new Error();
      const pending = PendingEdits.parse(raw.edits);
      for (const row of raw.bases) {
        if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !Number.isSafeInteger(row[1]) || row[1] < 0 || bases.has(row[0])) throw new Error();
        bases.set(row[0], row[1]);
      }
      if (pending.isEmpty || bases.size !== pending.size || pending.paths.some((path) => !bases.has(path))) throw new Error();
      id = raw.id;
      edits.stageAll(pending.changes());
    } catch {
      throw new Error('The saved changes on this device use an unrecognized format. Keep the local copy rather than reopening this project.');
    }
    if (id !== null && fs.hasAcceptedBatch(id)) retire(id);
  }
  return {
    held: () => edits.paths,
    persisted: () => persisted,
    stage: (changes: readonly BasedChange[]) => {
      if (changes.length === 0) return;
      for (const change of changes) if (!bases.has(change.path)) bases.set(change.path, change.base);
      edits.stageAll(changes);
      id = crypto.randomUUID().replaceAll('-', '');
      keep();
    },
    send: async (refresh, answer) => {
      if (id === null) return { kind: 'empty' };
      try {
        if (refresh) await fs.refresh();
        marks();
        if (!fs.hasAcceptedBatch(id) && answer !== undefined) {
          const moved = edits.paths.filter((path) => {
            const version = fs.versionOf(path);
            return version !== bases.get(path) && version !== answer.get(path);
          });
          if (moved.length > 0) return { kind: 'conflict', versions: new Map(moved.map((path) => [path, fs.versionOf(path)])) };
          for (const [path, version] of answer) if (bases.has(path)) bases.set(path, version);
          id = crypto.randomUUID().replaceAll('-', '');
          keep();
        }
        const sent = { id, changes: edits.changes().map((change) => ({ ...change, base: bases.get(change.path)! })) };
        await fs.commitEditBatch(sent.id, sent.changes);
        retire(sent.id);
        marks();
        return { kind: 'accepted', changes: sent.changes };
      } catch (error) {
        return error instanceof RemoteConflictError && error.versions !== undefined
          ? { kind: 'conflict', versions: error.versions }
          : { kind: 'unavailable' };
      }
    },
  };
}

async function projectFiles(state: ProjectState, assets: Readonly<Record<string, Uint8Array>>): Promise<Map<string, Uint8Array>> {
  const fs = new MemoryArtifactFs();
  for (const name of state.declinedDocFiles) await fs.writeAtomic(`docs/${name}`, '');
  for (const name of state.declinedCodexFiles) await fs.writeAtomic(`codex/${name}`, '');
  const sketch = copyState(state);
  for (const node of sketch.manifest.tree) delete node.updatedAt;
  sketch.manifest.derived = { wordCounts: {}, computedAt: new Date(0).toISOString() };
  const report = await writeProject(fs, sketch, { now: new Date(0) });
  const files = new Map<string, Uint8Array>();
  for (const path of report.written) files.set(path, await fs.readBytes(path));
  for (const [path, bytes] of Object.entries(assets)) files.set(path, bytes.slice());
  return files;
}

export async function hostedBaseline(
  fs: EncryptedRemoteArtifactFs,
  opened: ProjectState,
  pictures: Readonly<Record<string, Uint8Array>>,
) {
  const versions = new Map(fs.versionSnapshot());
  let previous = await projectFiles(opened, pictures);
  const legacy = new Map<string, string>();
  for (const node of opened.manifest.tree) {
    if (!isBodyType(node.type)) continue;
    const canonical = bodyFile(node);
    for (const name of bodyNamesOf(node)) {
      const path = `docs/${name}`;
      if (path !== canonical && !opened.declinedDocFiles.has(name) && await fs.exists(path)) legacy.set(canonical, path);
    }
  }
  const encoder = new TextEncoder();
  return {
    async changes(state: ProjectState, assets: Readonly<Record<string, Uint8Array>>): Promise<BasedChange[]> {
      const current = await projectFiles(state, assets);
      const changes: BasedChange[] = [];
      for (const [path, bytes] of current) {
        const before = previous.get(path);
        if (before?.length === bytes.length && before.every((byte, i) => byte === bytes[i])) continue;
        const payload = path === MANIFEST_FILE
          ? encoder.encode(serializeManifest({
            ...state.manifest,
            project: { ...state.manifest.project, modifiedAt: new Date().toISOString() },
            derived: { wordCounts: {}, computedAt: new Date(0).toISOString() },
          }))
          : bytes;
        changes.push({ path, bytes: payload, base: versions.get(path) ?? 0 });
      }
      for (const path of previous.keys()) {
        if (current.has(path) || state.declinedText.has(path) || [...state.declinedDocFiles].some((name) => path === `docs/${name}`) ||
          [...state.declinedCodexFiles].some((name) => path === `codex/${name}`)) continue;
        changes.push({ path, bytes: null, base: versions.get(path) ?? 0 });
      }
      for (const { path } of [...changes]) {
        const old = legacy.get(path);
        if (old === undefined) continue;
        if (!current.has(old)) changes.push({ path: old, bytes: null, base: versions.get(old) ?? 0 });
        legacy.delete(path);
      }
      previous = current;
      return changes;
    },
    accepted(changes: readonly BasedChange[]): void {
      for (const { path, bytes, base } of changes) versions.set(path, bytes === null && base === 0 ? 0 : base + 1);
    },
  };
}

export async function picturesOnProjectFs(fs: ArtifactFs): Promise<Record<string, Uint8Array>> {
  const pictures: Record<string, Uint8Array> = {};
  for (const name of await fs.listFiles(ASSETS_DIR)) pictures[`${ASSETS_DIR}/${name}`] = await fs.readBytes(`${ASSETS_DIR}/${name}`);
  return pictures;
}

export async function openHostedTarget(source: HostedProjectSource): Promise<HostedTarget> {
  const scope = storageScope();
  const fs = await openRemoteProject(source, scope);
  const queue = await deviceQueue(source, fs, scope);
  saveHostedMarks(source.projectId, fs.highWater.entries(), scope);
  return new HostedTarget(source.projectId, fs, queue, (state, pictures) => hostedBaseline(fs, state, pictures));
}
