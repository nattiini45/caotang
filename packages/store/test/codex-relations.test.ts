import { describe, expect, it } from 'vitest';
import {
  MANIFEST_FILE,
  MemoryArtifactFs,
  ProjectRefusedError,
  addDocument,
  commitRecovery,
  createEmptyManifest,
  createProjectState,
  exportProjectZip,
  importProjectZip,
  readProject,
  recoverProject,
  serializeManifest,
  validateManifest,
  writeProject,
  type CodexEntry,
} from '../src/index.js';

const NOW = new Date('2026-11-19T12:00:00.000Z');
const v3Reader = { current: 3, registry: [] };
const DOC = 'n_3W8RN2TQ6C';
const FENN = 'c_0000000001';
const MARA = 'c_0000000002';

function entry(id: string, name: string, over: Partial<CodexEntry> = {}): CodexEntry {
  return {
    id,
    name,
    aliases: [],
    type: 'character',
    description: `${name} keeps the harbour log.`,
    includePolicy: 'detected',
    caseSensitive: false,
    exclude: [],
    attachments: [],
    keywords: [],
    origin: 'manual',
    sources: [],
    ...over,
  };
}

function linked(): ReturnType<typeof createEmptyManifest> {
  const manifest = createEmptyManifest('The Lantern', NOW);
  manifest.codex = [
    entry(FENN, 'Fenn', { relations: [{ id: 'rel_7K3M2Q8XZC', targetId: MARA, label: 'ally' }] }),
    entry(MARA, 'Mara'),
  ];
  return manifest;
}

describe('entry relations in the artifact', () => {
  it('writes the list in the entry, and an entry without one keeps its bytes', () => {
    const manifest = linked();
    const text = serializeManifest(manifest);
    expect(JSON.parse(text).codex[0].relations).toEqual([{ id: 'rel_7K3M2Q8XZC', targetId: MARA, label: 'ally' }]);
    expect(text).toContain('"relations"');
    const plain = createEmptyManifest('The Lantern', NOW);
    plain.codex = [entry(FENN, 'Fenn')];
    expect(serializeManifest(plain)).not.toContain('"relations"');
  });

  it('raises the artifact to v4 so a typed-details-and-references build refuses it', async () => {
    const manifest = linked();
    expect(JSON.parse(serializeManifest(manifest)).formatVersion).toBe(4);
    const fs = new MemoryArtifactFs();
    await writeProject(fs, createProjectState(manifest), { now: NOW });
    const before = fs.snapshot();
    await expect(readProject(fs, { format: v3Reader })).rejects.toBeInstanceOf(ProjectRefusedError);
    expect(fs.snapshot()).toEqual(before);
  });

  it('survives a folder save and a bundle round trip, and both directions of a relation survive', async () => {
    const fs = new MemoryArtifactFs();
    await writeProject(fs, createProjectState(linked()), { now: NOW });
    const loaded = await readProject(fs, { now: NOW });
    const [fenn, mara] = loaded.state.manifest.codex ?? [];
    expect(fenn?.relations).toEqual([{ id: 'rel_7K3M2Q8XZC', targetId: MARA, label: 'ally' }]);
    expect(mara?.relations).toBeUndefined();

    const bundle = await importProjectZip((await exportProjectZip(loaded.state, { now: NOW })).bytes);
    const reopened = await readProject(bundle.fs, { now: NOW });
    expect(reopened.state.manifest.codex?.[0]?.relations).toEqual(loaded.state.manifest.codex?.[0]?.relations);
  });

  it('keeps an unknown key inside a relation record on save', async () => {
    const manifest = createEmptyManifest('The Lantern', NOW);
    manifest.codex = [entry(FENN, 'Fenn', { relations: [{ id: 'rel_7K3M2Q8XZC', targetId: MARA, colour: 'teal' }] })];
    const fs = new MemoryArtifactFs();
    await writeProject(fs, createProjectState(manifest), { now: NOW });
    const loaded = await readProject(fs, { now: NOW });
    expect(loaded.state.manifest.codex?.[0]?.relations).toEqual([{ id: 'rel_7K3M2Q8XZC', targetId: MARA, colour: 'teal' }]);
    await writeProject(fs, loaded.state, { now: NOW });
    const text = await fs.read(MANIFEST_FILE);
    expect(JSON.parse(text).codex[0].relations[0].colour).toBe('teal');
  });

  it('rebuilds a relation from the entry file when the manifest is gone', async () => {
    const fs = new MemoryArtifactFs();
    const state = createProjectState(linked());
    addDocument(state, { parentId: 'manuscript', title: 'Landing', body: 'The ferry was late.', now: NOW, id: DOC });
    await writeProject(fs, state, { now: NOW });
    fs.putFile(MANIFEST_FILE, '{');
    const recovered = await recoverProject(fs, { now: NOW });
    expect(recovered.status).toBe('needs-consent');
    if (recovered.status !== 'needs-consent') return;
    await commitRecovery(fs, recovered.offer, { now: NOW });
    const text = JSON.parse(await fs.read(MANIFEST_FILE));
    expect(text.formatVersion).toBe(4);
    expect(text.codex.flatMap((record: { relations?: unknown[] }) => record.relations ?? []))
      .toEqual([{ id: 'rel_7K3M2Q8XZC', targetId: MARA, label: 'ally' }]);
  });

  it('drops a malformed relation list with a notice rather than refusing the project', () => {
    const manifest = linked() as unknown as Record<string, unknown>;
    const codex = manifest['codex'] as Record<string, unknown>[];
    codex[0]!['relations'] = 'not a list';
    const report = validateManifest(manifest);
    expect(report.ok).toBe(true);
    expect(report.warnings.some((warning) => warning.path === 'codex[0].relations')).toBe(true);
  });
});
