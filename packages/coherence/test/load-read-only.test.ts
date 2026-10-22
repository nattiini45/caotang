import { MemoryArtifactFs } from '@caotang/store';
import { describe, expect, it } from 'vitest';

import { COHERENCE_FILE, coherenceSnapshotFile, emptyCoherenceFile, loadCoherence, saveCoherence, serializeCoherenceFile } from '../src/index.js';

import { LATER, NOW } from './fixtures.js';

/** A readable file with one manual rule, so a restored copy can be told from an empty one. */
function withRule(text: string): string {
  return serializeCoherenceFile({
    ...emptyCoherenceFile(),
    worldRules: [{ id: 'w_AAAAAAAAAA', text, origin: 'manual', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }],
  });
}

describe('a read-only load of coherence.json writes nothing', () => {
  it('leaves a corrupt file, and the folder around it, exactly as it was', async () => {
    const fs = new MemoryArtifactFs();
    fs.putFile(COHERENCE_FILE, '{"formatVersion": 1, "findings": [');
    const before = fs.snapshot();

    const load = await loadCoherence(fs, { readOnly: true, now: LATER });

    expect(fs.snapshot()).toEqual(before);
    expect(load.status).toBe('recovered');
    expect(load.file).toEqual(emptyCoherenceFile());
    expect(load.preservedAs).toBeUndefined();
    expect(load.notices.map((notice) => notice.code)).toEqual(['corrupt-file']);
    expect(load.notices[0]?.message).toContain('It is not changed');
    // A save over it still keeps the unreadable copy, through the rotation.
    expect(load.writable).toBe(true);
  });

  it('uses the newest readable snapshot for a corrupt file, and still writes nothing', async () => {
    const fs = new MemoryArtifactFs();
    fs.putFile(COHERENCE_FILE, '{broken');
    fs.putFile(coherenceSnapshotFile(1), '{broken too');
    fs.putFile(coherenceSnapshotFile(2), withRule('The tide turns twice a day.'));
    const before = fs.snapshot();

    const load = await loadCoherence(fs, { readOnly: true, now: LATER });

    expect(fs.snapshot()).toEqual(before);
    expect(load.status).toBe('recovered');
    expect(load.file.worldRules.map((rule) => rule.text)).toEqual(['The tide turns twice a day.']);
    expect(load.notices.find((notice) => notice.code === 'restored-from-snapshot')?.message).toContain(coherenceSnapshotFile(2));
  });

  it('keeps a corrupt file under its corrupt name when a later save replaces it', async () => {
    const fs = new MemoryArtifactFs();
    fs.putFile(COHERENCE_FILE, '{broken');
    const load = await loadCoherence(fs, { readOnly: true });

    await saveCoherence(fs, load, load.file, { now: LATER });

    const names = Object.keys(fs.snapshot()).filter((name) => name.startsWith(`${COHERENCE_FILE}.corrupt-`));
    expect(names).toHaveLength(1);
    expect(fs.snapshot()[names[0] as string]).toBe('{broken');
  });

  it('reads a good file and an absent one as the writing load does', async () => {
    const fs = new MemoryArtifactFs();
    expect((await loadCoherence(fs, { readOnly: true })).status).toBe('absent');
    fs.putFile(COHERENCE_FILE, withRule('Fog never lifts.'));
    const load = await loadCoherence(fs, { readOnly: true });
    expect(load.status).toBe('loaded');
    expect(load.file.worldRules).toHaveLength(1);
  });

  it('does not touch a file written by a newer Caotang, and it stays unwritable', async () => {
    const fs = new MemoryArtifactFs();
    const newer = JSON.stringify({ formatVersion: 99, findings: [] });
    fs.putFile(COHERENCE_FILE, newer);
    const before = fs.snapshot();

    const load = await loadCoherence(fs, { readOnly: true });

    expect(fs.snapshot()).toEqual(before);
    expect(load.status).toBe('read-only');
    expect(load.writable).toBe(false);
  });
});
