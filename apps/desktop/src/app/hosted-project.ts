import { assertContained, bodyFile, bodyNamesOf, isBodyType, MemoryArtifactFs, MANIFEST_FILE, serializeManifest, writeProject, type ArtifactFs, type ProjectState } from '@caotang/store';
import type { EncryptedRemoteArtifactFs, PendingEdits, RemoteChange } from '@caotang/remote-store';
import { HostedTarget, type BasedChange, type HostedQueuePort } from './hosted-target.js';
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

export async function deviceQueue(source: HostedProjectSource, fs: EncryptedRemoteArtifactFs, scope = storageScope()): Promise<HostedQueuePort> {
  const { PendingEdits, RemoteConflictError } = await import('@caotang/remote-store');
  const edits: PendingEdits = new PendingEdits();
  const bases = new Map<string, number>();
  const deferred = new Set<string>();
  const shown = new Set<string>();
  type Attempt = { id: string; edits: PendingEdits; bases: Map<string, number>; shown: ReadonlySet<string> };
  let attempt: Attempt | null = null;
  let persisted = true;
  const ready = () => edits.paths.filter((path) => !deferred.has(path));
  const based = (files: PendingEdits, versions: ReadonlyMap<string, number>) =>
    files.changes().map((change) => ({ ...change, base: versions.get(change.path)! }));
  const marks = () => saveHostedMarks(source.projectId, fs.highWater.entries(), scope);
  const keep = () => {
    persisted = saveHostedQueue(source.projectId, edits.isEmpty && !attempt ? null : JSON.stringify({
      format: 3, edits: edits.serialize(), bases: [...bases], deferred: [...deferred],
      attempt: attempt && { id: attempt.id, edits: attempt.edits.serialize(), bases: [...attempt.bases] },
    }), scope);
  };
  const settle = async (sent: Attempt, opening: boolean) => {
    const accepted = await Promise.all(based(sent.edits, sent.bases).map(async (change) => {
      const { path, base, bytes } = change;
      const advanced = bytes !== null || (fs.versionOf(path) === base + 1 && !await fs.exists(path));
      return { ...change, version: advanced ? base + 1 : base, represented: sent.shown.has(path) };
    }));
    const previouslyWaiting = deferred.size;
    for (const { path, version, represented } of accepted) {
      const base = bases.get(path);
      if (base === undefined) continue;
      bases.set(path, Math.max(base, version));
      if (!opening && !represented) deferred.add(path);
    }
    if (deferred.size !== previouslyWaiting && bases.has(MANIFEST_FILE)) {
      for (const path of edits.paths) deferred.add(path);
    }
    attempt = null;
    keep();
    return accepted;
  };
  const readChanges = (data: { edits?: unknown; bases?: unknown }) => {
    if (typeof data.edits !== 'string' || !Array.isArray(data.bases)) throw new Error();
    const files = PendingEdits.parse(data.edits);
    const versions = new Map<string, number>();
    for (const row of data.bases) {
      if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !Number.isSafeInteger(row[1]) || row[1] < 0 || versions.has(row[0])) throw new Error();
      versions.set(row[0], row[1]);
    }
    if (versions.size !== files.size || files.paths.some((path) => !versions.has(path))) throw new Error();
    return { edits: files, bases: versions };
  };
  const readPaths = (value: unknown, allowed: ReadonlyMap<string, number>, set: Set<string>) => {
    if (!Array.isArray(value)) throw new Error();
    for (const path of value) {
      if (typeof path !== 'string' || !allowed.has(path) || set.has(path)) throw new Error();
      set.add(path);
    }
  };
  const isId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
  const stored = loadHostedQueue(source.projectId, scope);
  if (stored !== null) {
    try {
      const raw = JSON.parse(stored);
      if (raw?.format !== 2 && raw?.format !== 3) throw new Error();
      const pending = readChanges(raw);
      readPaths(raw.deferred ?? [], pending.bases, deferred);
      if (raw.format === 2) {
        const files = based(pending.edits, pending.bases).filter(({ path }) => !deferred.has(path));
        if (files.length > 0) {
          if (!isId(raw.id)) throw new Error();
          const sent = new PendingEdits();
          sent.stageAll(files);
          attempt = { id: raw.id, edits: sent, bases: new Map(files.map(({ path, base }) => [path, base])), shown: new Set() };
          pending.edits.clear(sent.paths);
          for (const path of sent.paths) pending.bases.delete(path);
        } else if (raw.id !== null) {
          throw new Error();
        }
      } else if (raw.attempt !== null) {
        if (!isId(raw.attempt?.id)) throw new Error();
        const sent = readChanges(raw.attempt);
        if (sent.edits.isEmpty) throw new Error();
        attempt = { id: raw.attempt.id, ...sent, shown: new Set() };
      }
      if (!attempt && pending.edits.isEmpty) throw new Error();
      edits.stageAll(pending.edits.changes());
      for (const [path, base] of pending.bases) bases.set(path, base);
    } catch {
      throw new Error('The saved changes on this device use an unrecognized format. Keep the local copy rather than reopening this project.');
    }
    if (attempt && fs.hasAcceptedBatch(attempt.id)) await settle(attempt, true);
  }
  return {
    held: () => [...new Set([...(attempt?.edits.paths ?? []), ...ready()])],
    deferred: () => [...deferred],
    opened: () => {
      if (deferred.size === 0) return;
      deferred.clear();
      keep();
    },
    persisted: () => persisted,
    stage: (changes, unread = new Map<string, number>()) => {
      if (changes.length === 0) return;
      for (const { path } of changes) {
        assertContained(path);
        if (path === '') throw new Error('a project file needs a path');
      }
      const wait = new Set(changes.filter(({ path }) => unread.has(path) || deferred.has(path)).map(({ path }) => path));
      if (wait.size > 0 && changes.some(({ path }) => path === MANIFEST_FILE)) {
        for (const { path } of changes) wait.add(path);
      }
      const queued = ready();
      if (queued.includes(MANIFEST_FILE) && queued.some((path) => wait.has(path))) {
        for (const path of queued) wait.add(path);
      }
      for (const { path, base } of changes) {
        if (!bases.has(path)) bases.set(path, unread.get(path) ?? attempt?.bases.get(path) ?? base);
        shown.add(path);
      }
      for (const path of wait) deferred.add(path);
      edits.stageAll(changes);
      keep();
    },
    send: async (refresh, answer) => {
      if (!attempt) {
        const files = based(edits, bases).filter(({ path }) => !deferred.has(path));
        if (files.length === 0) return { kind: 'empty' };
        const sending = new PendingEdits();
        sending.stageAll(files);
        attempt = {
          id: crypto.randomUUID().replaceAll('-', ''),
          edits: sending,
          bases: new Map(files.map(({ path, base }) => [path, answer?.get(path) ?? base])),
          shown: new Set(sending.paths.filter((path) => shown.has(path))),
        };
        edits.clear(sending.paths);
        for (const path of sending.paths) {
          bases.delete(path);
          shown.delete(path);
        }
        keep();
      }
      const sent = attempt;
      try {
        if (refresh) await fs.refresh();
        marks();
        await fs.commitEditBatch(sent.id, based(sent.edits, sent.bases));
        const changes = await settle(sent, false);
        marks();
        return { kind: 'accepted', changes };
      } catch (error) {
        if (!(error instanceof RemoteConflictError) || error.versions === undefined) return { kind: 'unavailable' };
        for (const change of based(sent.edits, sent.bases)) {
          if (!bases.has(change.path)) {
            edits.stageAll([change]);
            if (sent.shown.has(change.path)) shown.add(change.path);
          }
          bases.set(change.path, change.base);
        }
        attempt = null;
        keep();
        return { kind: 'conflict', versions: error.versions };
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
    async prepare(state: ProjectState, assets: Readonly<Record<string, Uint8Array>>) {
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
      const replaced: string[] = [];
      for (const { path } of [...changes]) {
        const old = legacy.get(path);
        if (old === undefined) continue;
        if (!current.has(old)) changes.push({ path: old, bytes: null, base: versions.get(old) ?? 0 });
        replaced.push(path);
      }
      return {
        changes,
        staged: () => {
          previous = current;
          for (const path of replaced) legacy.delete(path);
        },
      };
    },
    accepted(changes: readonly (RemoteChange & { readonly version: number })[]): void {
      for (const { path, version } of changes) versions.set(path, Math.max(versions.get(path) ?? 0, version));
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
