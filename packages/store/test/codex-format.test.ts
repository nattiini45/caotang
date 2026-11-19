import { describe, expect, it } from 'vitest';
import {
  MANIFEST_FILE,
  MemoryArtifactFs,
  ProjectRefusedError,
  commitRecovery,
  createEmptyManifest,
  createProjectState,
  exportProjectZip,
  importProjectZip,
  migrateToCurrent,
  readProject,
  recoverProject,
  serializeManifest,
  writeProject,
  type CodexEntry,
} from '../src/index.js';

const NOW = new Date('2026-11-19T10:00:00.000Z');
const v1Reader = { current: 1, registry: [] };
const entry: CodexEntry = {
  id: 'c_0000000001',
  name: 'Kestrel',
  aliases: [],
  type: 'character',
  description: 'A keeper.',
  includePolicy: 'detected',
  caseSensitive: false,
  exclude: [],
  attachments: [],
  keywords: [],
  origin: 'manual',
  sources: [],
};

describe('the codex artifact format boundary', () => {
  it('opens and saves legacy v1 with the same bytes and no migration', async () => {
    const manifest = createEmptyManifest('The Lantern', NOW);
    manifest.codex = [entry];
    expect(manifest.formatVersion).toBe(1);
    expect(migrateToCurrent(manifest)).toEqual({ manifest, applied: [] });
    const legacyText = serializeManifest(manifest, v1Reader);
    const fs = new MemoryArtifactFs();
    fs.putFile(MANIFEST_FILE, legacyText);
    const loaded = await readProject(fs, { now: NOW });
    expect(loaded.report.migrations).toEqual([]);
    expect(loaded.notices).toEqual([]);
    await writeProject(fs, loaded.state, { now: NOW });
    expect(await fs.read(MANIFEST_FILE)).toBe(legacyText);
    expect((await readProject(fs, { format: v1Reader })).state.manifest.formatVersion).toBe(1);
  });

  it('protects field definitions even before the first value is set', () => {
    const manifest = createEmptyManifest('The Lantern', NOW);
    manifest.codexDetailFields = [{ type: 'character', key: 'age', label: 'Age', kind: 'number' }];
    expect(JSON.parse(serializeManifest(manifest))).toMatchObject({
      formatVersion: 2,
      codexDetailFields: manifest.codexDetailFields,
    });
    expect(manifest.formatVersion).toBe(1);
  });

  it('refuses protected folders and bundles at the v1 gate and reopens them intact in production', async () => {
    const manifest = createEmptyManifest('The Lantern', NOW);
    const details = { age: 0, unused: { keep: [false, null] } };
    manifest.codex = [{ ...entry, details }];
    manifest.codexDetailFields = [{ type: 'character', key: 'age', label: 'Age', kind: 'number' }];
    const state = createProjectState(manifest);
    const fs = new MemoryArtifactFs();
    await writeProject(fs, state, { now: NOW });
    const zip = await exportProjectZip(state, { now: NOW });
    const bundle = await importProjectZip(zip.bytes);
    for (const artifact of [fs, bundle.fs]) {
      const before = artifact.snapshot();
      await expect(readProject(artifact, { format: v1Reader })).rejects.toThrow(ProjectRefusedError);
      await expect(recoverProject(artifact, { format: v1Reader })).rejects.toThrow(ProjectRefusedError);
      expect(artifact.snapshot()).toEqual(before);

      const opened = await readProject(artifact, { now: NOW });
      expect(opened.report.migrations).toEqual([]);
      expect(opened.state.manifest).toMatchObject({
        formatVersion: 2,
        codexDetailFields: manifest.codexDetailFields,
        codex: [{ details }],
      });
      delete opened.state.manifest.codexDetailFields;
      delete opened.state.manifest.codex?.[0]?.details;
      expect(JSON.parse(serializeManifest(opened.state.manifest))).toMatchObject({ formatVersion: 2 });
    }
  });

  it('accepts an unstamped v1 manifest with detail values and protects them on the next write', async () => {
    const manifest = createEmptyManifest('The Lantern', NOW);
    const details = { unknown: false };
    manifest.codex = [{ ...entry, details }];
    const fs = new MemoryArtifactFs();
    fs.putFile(MANIFEST_FILE, JSON.stringify(manifest));
    const loaded = await readProject(fs, { now: NOW });
    expect(loaded.report.migrations).toEqual([]);
    await writeProject(fs, loaded.state, { now: NOW });
    expect(JSON.parse(await fs.read(MANIFEST_FILE))).toMatchObject({ formatVersion: 2, codex: [{ details }] });
  });

  it('protects values recovered from front matter even without definitions', async () => {
    const manifest = createEmptyManifest('The Lantern', NOW);
    const details = { unknown: true };
    manifest.codex = [{ ...entry, details }];
    const fs = new MemoryArtifactFs();
    await writeProject(fs, createProjectState(manifest), { now: NOW });
    fs.putFile(MANIFEST_FILE, '{');
    const recovered = await recoverProject(fs, { now: NOW });
    expect(recovered.status).toBe('needs-consent');
    if (recovered.status !== 'needs-consent') throw new Error('Expected a rebuild offer');
    await commitRecovery(fs, recovered.offer, { now: NOW });
    expect(JSON.parse(await fs.read(MANIFEST_FILE))).toMatchObject({ formatVersion: 2, codex: [{ details }] });
  });
});
