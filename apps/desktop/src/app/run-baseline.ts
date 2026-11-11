import { parseCoherenceFile, serializeCoherenceFile, type CoherenceFile } from '@caotang/coherence';
import { t } from '@lingui/core/macro';
import { MemoryArtifactFs, readProject, readRunBaselines, writeProject, type ProjectState, type RunBaseline, type RuntimeStore } from '@caotang/store';

export async function retainedRunBaselineValues(store: RuntimeStore, projectId: string): Promise<readonly unknown[]> {
  return (await readRunBaselines(store, projectId)).map((baseline) => {
    const manifest = baseline.textFiles['caotang.json'];
    if (manifest === undefined) throw new Error(t`An agent run restore point has no project manifest.`);
    return [JSON.parse(manifest) as unknown, baseline.textFiles, baseline.coherence === undefined ? null : JSON.parse(baseline.coherence) as unknown];
  });
}

export async function captureRunBaseline(state: ProjectState): Promise<RunBaseline> {
  const capturedAt = Date.now();
  const copy = structuredClone(state);
  const fs = new MemoryArtifactFs();
  await writeProject(fs, copy, { now: new Date(capturedAt) });
  await fs.remove('.gitignore');
  return {
    version: 1,
    capturedAt,
    textFiles: fs.snapshot(),
    binaryFiles: fs.snapshotBytes(),
    revisions: Object.fromEntries([...copy.documents].map(([id, doc]) => [id, doc.revision])),
    ...(copy.coherence === undefined ? {} : { coherence: serializeCoherenceFile(copy.coherence as CoherenceFile) }),
  };
}

export async function validateRunBaseline(baseline: RunBaseline, projectId: string): Promise<ProjectState> {
  const fs = new MemoryArtifactFs();
  const allowed = (path: string): boolean => /^(?:caotang\.json|(?:docs|codex)\/[^/]+\.(?:md|fountain|ink)|(?:CAOTANG|AGENTS)\.md|memory\/(?:[^/]+\/)*[^/]+\.md|\.agents\/skills\/(?:[^/]+\/)+[^/]+)$/u.test(path)
    && !path.split('/').some((part) => part === '.' || part === '..' || part.includes('\\'));
  for (const [path, text] of Object.entries(baseline.textFiles)) {
    if (!allowed(path)) throw new Error(t`The restore point contains an unsupported project path.`);
    await fs.writeAtomic(path, text);
  }
  for (const [path, bytes] of Object.entries(baseline.binaryFiles)) {
    if (!allowed(path) || !path.startsWith('.agents/skills/')) throw new Error(t`The restore point contains unsupported binary data.`);
    await fs.writeBytesAtomic(path, bytes);
  }
  const loaded = await readProject(fs);
  if (loaded.state.manifest.project.id !== projectId || loaded.orphans.length > 0 || loaded.orphanCodex.length > 0) throw new Error(t`The restore point does not belong to this project.`);
  for (const [id, doc] of loaded.state.documents) {
    const revision = baseline.revisions[id];
    if (revision === undefined) throw new Error(t`The restore point is missing a document revision.`);
    doc.revision = revision;
  }
  if (baseline.coherence !== undefined) {
    const parsed = parseCoherenceFile(baseline.coherence);
    if (parsed.kind !== 'ok') throw new Error(t`The restore point has unreadable findings.`);
    loaded.state.coherence = parsed.file;
  }
  return loaded.state;
}
