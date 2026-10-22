import { describe, expect, it } from 'vitest';

import { SKILL_LIMITS } from '@caotang/skills';

import {
  FolderDriftError,
  MemoryArtifactFs,
  SKILLS_DIR,
  UnsafeZipEntryError,
  addDocument,
  changesInWords,
  cloneProjectState,
  createEmptyManifest,
  createProjectState,
  driftOf,
  exportProjectZip,
  importProjectZip,
  isProjectFile,
  projectFileDigests,
  readProject,
  writeProject,
  ZIP_ENGINE,
  type ProjectState,
} from '../src/index.js';
import { MemoryIndexedDb } from '../src/runtime/memory-idb.js';
import { commitProject, openRuntimeStore, readProjectState, writeProjectSkills, writeProjectState } from '../src/runtime/store.js';

const NOW = new Date('2026-10-01T00:00:00.000Z');
const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const dec = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);
const skillMd = (name: string, body = 'Write in close third person.'): string => `---\r\nname: ${name}\r\ndescription: Style for ${name}\r\nx-vendor: kept\r\n---\r\n${body}\r\n`;

function project(): ProjectState {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', NOW));
  addDocument(state, { parentId: 'manuscript', title: 'Overture', body: 'Cold open.', now: NOW });
  return state;
}

/** A project holding two skills, one with a reference, a script and a binary asset. */
function withSkills(): ProjectState {
  const state = project();
  state.skills.set('close-third', [
    { path: 'SKILL.md', bytes: enc(skillMd('close-third')) },
    { path: 'references/voice.md', bytes: enc('Keep the narrator close.\n') },
    { path: 'scripts/check.sh', bytes: enc('echo hi\n') },
    { path: 'assets/pixel.png', bytes: Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0xfe) },
  ]);
  state.skills.set('slug-lines', [{ path: 'SKILL.md', bytes: enc(skillMd('slug-lines', 'Use INT./EXT.')) }]);
  return state;
}

const bytesOf = (state: ProjectState): Record<string, number[]> =>
  Object.fromEntries([...state.skills].flatMap(([folder, files]) => files.map((file) => [`${folder}/${file.path}`, [...file.bytes]] as const)));

describe('skills in a project folder', () => {
  it('loads what a save wrote, byte for byte, CRLF and binary files included', async () => {
    const fs = new MemoryArtifactFs();
    const state = withSkills();
    await writeProject(fs, state, { now: NOW });
    expect(await fs.exists(`${SKILLS_DIR}/close-third/SKILL.md`)).toBe(true);
    expect(dec(await fs.readBytes(`${SKILLS_DIR}/close-third/SKILL.md`))).toBe(skillMd('close-third'));

    const loaded = await readProject(fs);
    expect(bytesOf(loaded.state)).toEqual(bytesOf(state));
    expect([...loaded.state.skills.keys()]).toEqual(['close-third', 'slug-lines']);
    expect(loaded.notices.filter((n) => n.path.startsWith(SKILLS_DIR))).toEqual([]);
  });

  it('writes a project with no skills exactly as before: no .agents folder', async () => {
    const fs = new MemoryArtifactFs();
    await writeProject(fs, project(), { now: NOW });
    expect(await fs.exists('.agents')).toBe(false);
    expect((await readProject(fs)).state.skills.size).toBe(0);
  });

  it('tolerates an absent skills folder, an empty one, and a folder that is not a skill', async () => {
    const fs = new MemoryArtifactFs();
    await writeProject(fs, project(), { now: NOW });
    await fs.ensureDir(`${SKILLS_DIR}/empty`);
    fs.putFile(`${SKILLS_DIR}/notes/readme.txt`, 'not a skill');
    fs.putFile(`${SKILLS_DIR}/Not A Name/SKILL.md`, skillMd('x'));
    const loaded = await readProject(fs);
    expect(loaded.state.skills.size).toBe(0);
    expect(loaded.notices.filter((n) => n.path.startsWith(SKILLS_DIR))).toEqual([]);
  });

  it('writes only the files whose bytes changed, and removes nothing it does not own', async () => {
    const fs = new MemoryArtifactFs();
    const state = withSkills();
    await writeProject(fs, state, { now: NOW });
    fs.putFile(`${SKILLS_DIR}/close-third/references/mine.md`, 'the writer’s own file, added by another program');

    const again = await writeProject(fs, state, { now: NOW });
    expect(again.written.filter((path) => path.startsWith(SKILLS_DIR))).toEqual([]);
    expect(again.pruned).toEqual([]);
    expect(await fs.read(`${SKILLS_DIR}/close-third/references/mine.md`)).toContain('own file');

    state.skills.get('slug-lines')![0] = { path: 'SKILL.md', bytes: enc(skillMd('slug-lines', 'Changed.')) };
    const changed = await writeProject(fs, state, { now: NOW });
    expect(changed.written.filter((path) => path.startsWith(SKILLS_DIR))).toEqual([`${SKILLS_DIR}/slug-lines/SKILL.md`]);
  });

  it('removes a skill file the writer removed, and only that one', async () => {
    const fs = new MemoryArtifactFs();
    const state = withSkills();
    await writeProject(fs, state, { now: NOW });
    fs.putFile(`${SKILLS_DIR}/slug-lines/extra.md`, 'another program’s file');

    state.skills.delete('slug-lines');
    state.removedSkillFiles.add(`${SKILLS_DIR}/slug-lines/SKILL.md`);
    const report = await writeProject(fs, state, { now: NOW });
    expect(report.pruned).toEqual([`${SKILLS_DIR}/slug-lines/SKILL.md`]);
    expect(await fs.exists(`${SKILLS_DIR}/slug-lines/SKILL.md`)).toBe(false);
    expect(await fs.exists(`${SKILLS_DIR}/slug-lines/extra.md`)).toBe(true);
    expect(state.removedSkillFiles.size).toBe(0);
  });

  it('does not remove a file the skill holds again after an undone delete', async () => {
    const fs = new MemoryArtifactFs();
    const state = withSkills();
    await writeProject(fs, state, { now: NOW });
    state.removedSkillFiles.add(`${SKILLS_DIR}/slug-lines/SKILL.md`);
    const report = await writeProject(fs, state, { now: NOW });
    expect(report.pruned).toEqual([]);
    expect(await fs.exists(`${SKILLS_DIR}/slug-lines/SKILL.md`)).toBe(true);
  });
});

describe('a skill changed by another program during a folder save', () => {
  it('is part of the folder digests, and a change names the skill', async () => {
    const fs = new MemoryArtifactFs();
    const state = withSkills();
    await writeProject(fs, state, { now: NOW });
    const held = await projectFileDigests(fs);
    expect([...held.keys()].filter((path) => path.startsWith(SKILLS_DIR))).toHaveLength(5);

    fs.putFile(`${SKILLS_DIR}/close-third/references/voice.md`, 'edited elsewhere');
    fs.putFile(`${SKILLS_DIR}/close-third/SKILL.md`, 'edited elsewhere too');
    fs.putFile(`${SKILLS_DIR}/new-one/SKILL.md`, skillMd('new-one'));
    const drift = driftOf(held, await projectFileDigests(fs));
    expect(drift.changed).toEqual([`${SKILLS_DIR}/close-third/SKILL.md`, `${SKILLS_DIR}/close-third/references/voice.md`]);
    expect(drift.added).toEqual([`${SKILLS_DIR}/new-one/SKILL.md`]);
    expect(changesInWords(drift, state, new Map(), 'this copy')).toBe('changed the skill “close-third” and added the skill “new-one”');
  });

  it('stops the write before it overwrites the file', async () => {
    const fs = new MemoryArtifactFs();
    const state = withSkills();
    await writeProject(fs, state, { now: NOW });
    const held = await projectFileDigests(fs);
    fs.putFile(`${SKILLS_DIR}/slug-lines/SKILL.md`, 'edited elsewhere');
    state.skills.get('slug-lines')![0] = { path: 'SKILL.md', bytes: enc(skillMd('slug-lines', 'Mine.')) };
    await expect(writeProject(fs, state, { now: NOW, expectedDigests: held })).rejects.toBeInstanceOf(FolderDriftError);
    expect(await fs.read(`${SKILLS_DIR}/slug-lines/SKILL.md`)).toBe('edited elsewhere');
  });

  it('counts a skill file as a project file, and nothing else under .agents', () => {
    expect(isProjectFile(`${SKILLS_DIR}/close-third/SKILL.md`)).toBe(true);
    expect(isProjectFile(`${SKILLS_DIR}/close-third/references/a.md`)).toBe(true);
    expect(isProjectFile(`${SKILLS_DIR}/SKILL.md`)).toBe(false);
    expect(isProjectFile(`${SKILLS_DIR}/Bad Name/SKILL.md`)).toBe(false);
    expect(isProjectFile(`${SKILLS_DIR}/a/../b`)).toBe(false);
    expect(isProjectFile('.agents/other/SKILL.md')).toBe(false);
  });
});

describe('skills in a bundle', () => {
  it('round-trips byte for byte through the dot-folder', async () => {
    const state = withSkills();
    const exported = await exportProjectZip(state, { now: NOW });
    expect(exported.entries).toContain(`${SKILLS_DIR}/close-third/SKILL.md`);
    expect(exported.entries).toContain(`${SKILLS_DIR}/close-third/assets/pixel.png`);

    const { unzipSync } = await ZIP_ENGINE.load();
    const archived = unzipSync(exported.bytes);
    expect([...archived[`${SKILLS_DIR}/close-third/assets/pixel.png`]!]).toEqual([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0xfe]);
    expect(dec(archived[`${SKILLS_DIR}/close-third/SKILL.md`])).toBe(skillMd('close-third'));

    const imported = await importProjectZip(exported.bytes);
    const loaded = await readProject(imported.fs);
    expect(bytesOf(loaded.state)).toEqual(bytesOf(state));
  });

  it('is the same bytes when exported twice', async () => {
    const state = withSkills();
    const one = await exportProjectZip(state, { now: NOW });
    const two = await exportProjectZip(state, { now: NOW });
    expect([...one.bytes]).toEqual([...two.bytes]);
  });

  it('leaves the open state untouched', async () => {
    const state = withSkills();
    state.removedSkillFiles.add(`${SKILLS_DIR}/gone/SKILL.md`);
    await exportProjectZip(state, { now: NOW });
    expect(state.removedSkillFiles.size).toBe(1);
    const copy = cloneProjectState(state);
    copy.skills.get('slug-lines')![0]!.bytes[0] = 0;
    expect(state.skills.get('slug-lines')![0]!.bytes[0]).toBe('-'.charCodeAt(0));
  });

  it('refuses an entry that escapes the skill folder or the project, with the same zip-slip guard as the rest', async () => {
    const { zipSync } = await ZIP_ENGINE.load();
    const base = await exportProjectZip(project(), { now: NOW });
    const { unzipSync } = await ZIP_ENGINE.load();
    const files = unzipSync(base.bytes);
    for (const bad of [`${SKILLS_DIR}/x/../../../caotang.json`, `${SKILLS_DIR}/x/..\\..\\evil`, `${SKILLS_DIR}/x//y.md`, `${SKILLS_DIR}/x/a\u0000b`, `/${SKILLS_DIR}/x/SKILL.md`]) {
      const archive = zipSync({ ...files, [bad]: enc('x') }, { mtime: NOW });
      await expect(importProjectZip(archive), JSON.stringify(bad)).rejects.toBeInstanceOf(UnsafeZipEntryError);
    }
  });
});

describe('the caps, named', () => {
  async function loadWith(files: Record<string, Uint8Array | string>): Promise<Awaited<ReturnType<typeof readProject>>> {
    const fs = new MemoryArtifactFs();
    await writeProject(fs, project(), { now: NOW });
    for (const [path, content] of Object.entries(files)) {
      if (typeof content === 'string') fs.putFile(`${SKILLS_DIR}/${path}`, content);
      else await fs.writeBytesAtomic(`${SKILLS_DIR}/${path}`, content);
    }
    return readProject(fs);
  }
  const skillNotices = (loaded: Awaited<ReturnType<typeof readProject>>): string[] =>
    loaded.notices.filter((n) => n.path.startsWith(SKILLS_DIR)).map((n) => n.say ?? n.message);

  it('does not take a skill with a file over 256 KB, and says so', async () => {
    const loaded = await loadWith({ 'big/SKILL.md': skillMd('big'), 'big/huge.md': new Uint8Array(SKILL_LIMITS.maxFileBytes + 1), 'ok/SKILL.md': skillMd('ok') });
    expect([...loaded.state.skills.keys()]).toEqual(['ok']);
    expect(skillNotices(loaded)).toEqual([expect.stringMatching(/huge\.md.*skill “big”.*256\.1 KB.*at most 256 KB/u)]);
  });

  it('does not take a skill over 64 files', async () => {
    const files: Record<string, string> = { 'many/SKILL.md': skillMd('many') };
    for (let i = 0; i < SKILL_LIMITS.maxFilesPerSkill; i += 1) files[`many/references/f${i}.md`] = 'x';
    const loaded = await loadWith(files);
    expect(loaded.state.skills.size).toBe(0);
    expect(skillNotices(loaded)).toEqual([expect.stringMatching(/65 files.*at most 64/u)]);
  });

  it('does not take a skill over 2 MB in all', async () => {
    const files: Record<string, Uint8Array | string> = { 'heavy/SKILL.md': skillMd('heavy') };
    for (let i = 0; i < 9; i += 1) files[`heavy/f${i}.bin`] = new Uint8Array(SKILL_LIMITS.maxFileBytes);
    const loaded = await loadWith(files);
    expect(loaded.state.skills.size).toBe(0);
    expect(skillNotices(loaded)).toEqual([expect.stringMatching(/at most 2 MB/u)]);
  });

  it('takes at most 50 skills and names the rest', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 52; i += 1) {
      const name = `skill-${String(i).padStart(2, '0')}`;
      files[`${name}/SKILL.md`] = skillMd(name);
    }
    const loaded = await loadWith(files);
    expect(loaded.state.skills.size).toBe(50);
    expect(skillNotices(loaded)).toHaveLength(2);
    expect(skillNotices(loaded)[0]).toMatch(/at most 50 skills.*skill-50/u);
  });

  it('leaves a skill it did not take on disk through a save', async () => {
    const fs = new MemoryArtifactFs();
    await writeProject(fs, project(), { now: NOW });
    fs.putFile(`${SKILLS_DIR}/big/SKILL.md`, skillMd('big'));
    await fs.writeBytesAtomic(`${SKILLS_DIR}/big/huge.md`, new Uint8Array(SKILL_LIMITS.maxFileBytes + 1));
    const loaded = await readProject(fs);
    await writeProject(fs, loaded.state, { now: NOW });
    expect(await fs.exists(`${SKILLS_DIR}/big/SKILL.md`)).toBe(true);
    expect((await fs.readBytes(`${SKILLS_DIR}/big/huge.md`)).length).toBe(SKILL_LIMITS.maxFileBytes + 1);
  });

  it('refuses a path with a backslash', async () => {
    const loaded = await loadWith({ 'odd/SKILL.md': skillMd('odd'), 'odd/a\\b.md': 'x' });
    expect(loaded.state.skills.size).toBe(0);
    expect(skillNotices(loaded)).toEqual([expect.stringMatching(/backslash/u)]);
  });
});

describe('skills in the browser store', () => {
  it('are kept on the project row and come back with the state', async () => {
    const store = await openRuntimeStore(new MemoryIndexedDb(), 'skills-test');
    try {
      const state = withSkills();
      await writeProjectState(store, state, { now: NOW });
      const back = await readProjectState(store, state.manifest.project.id);
      expect(bytesOf(back)).toEqual(bytesOf(state));

      // A structural commit carries the skills across, as it does everything that is not the manifest.
      await commitProject(store, { projectId: state.manifest.project.id, manifest: state.manifest, now: NOW });
      expect(bytesOf(await readProjectState(store, state.manifest.project.id))).toEqual(bytesOf(state));

      state.skills.delete('slug-lines');
      await writeProjectState(store, state, { now: NOW });
      expect([...(await readProjectState(store, state.manifest.project.id)).skills.keys()]).toEqual(['close-third']);
    } finally {
      store.close();
    }
  });

  it('are replaced alone by writeProjectSkills, which leaves the manuscript as it is', async () => {
    const store = await openRuntimeStore(new MemoryIndexedDb(), 'skills-test-alone');
    try {
      const state = withSkills();
      await writeProjectState(store, state, { now: NOW });
      const id = state.manifest.project.id;
      await writeProjectSkills(store, id, new Map([['only-one', [{ path: 'SKILL.md', bytes: enc(skillMd('only-one')) }]]]));
      const back = await readProjectState(store, id);
      expect([...back.skills.keys()]).toEqual(['only-one']);
      expect([...back.documents.values()].map((record) => record.body)).toEqual(['Cold open.']);
      await writeProjectSkills(store, id, new Map());
      expect((await readProjectState(store, id)).skills.size).toBe(0);
    } finally {
      store.close();
    }
  });
});
