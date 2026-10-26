import { describe, expect, it } from 'vitest';

import {
  FolderDriftError,
  INSTRUCTIONS_FALLBACK,
  INSTRUCTIONS_FILE,
  MEMORY_INDEX,
  MemoryArtifactFs,
  addDocument,
  agentFileTexts,
  changesInWords,
  cloneProjectState,
  createEmptyManifest,
  createProjectState,
  driftOf,
  exportProjectZip,
  hasAgentFiles,
  importProjectZip,
  isMemorySlug,
  isProjectFile,
  memoryIndexOf,
  parseAgentFiles,
  parseMemoryFile,
  projectFileDigests,
  readProject,
  serializeMemoryFile,
  slugOf,
  writeProject,
  ZIP_ENGINE,
  type MemoryFile,
  type ProjectState,
} from '../src/index.js';
import { MemoryIndexedDb } from '../src/runtime/memory-idb.js';
import { commitProject, openRuntimeStore, readProjectState, writeProjectAgentFiles, writeProjectState } from '../src/runtime/store.js';

const NOW = new Date('2026-10-01T00:00:00.000Z');
const dec = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);

const dialogue: MemoryFile = {
  slug: 'style-dialogue',
  type: 'style',
  title: 'Dialogue: no semicolons',
  body: 'No semicolons in dialogue.\nUse "said" for tags.',
  modified: '2026-10-01T10:00:00.000Z',
  origin: 'agent',
  sourceTurn: 'turn_1',
};
const endings: MemoryFile = {
  slug: 'process-endings',
  type: 'process',
  title: 'Scene endings',
  body: 'End on a line of dialogue where possible.',
  modified: '2026-10-02T10:00:00.000Z',
  origin: 'writer',
};

function project(): ProjectState {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', NOW));
  addDocument(state, { parentId: 'manuscript', title: 'Overture', body: 'Cold open.', now: NOW });
  return state;
}

function withAgentFiles(): ProjectState {
  const state = project();
  state.agentFiles = {
    instructions: { path: INSTRUCTIONS_FILE, text: 'British spelling.\nPast tense, close third person on Mara.\n' },
    index: memoryIndexOf([dialogue, endings]),
    memory: [endings, dialogue],
    declined: new Map(),
    unreadable: [],
  };
  return state;
}

describe('the memory file codec', () => {
  it('round-trips a topic file, including a body with colons and blank lines', () => {
    const file: MemoryFile = { ...dialogue, body: 'Line one: a colon.\n\nAfter a blank line.\n' };
    const text = serializeMemoryFile(file);
    expect(text.startsWith('---\ntype: style\ntitle: "Dialogue: no semicolons"\n')).toBe(true);
    const parsed = parseMemoryFile(text);
    expect(parsed).toEqual({ ok: true, file: { type: 'style', title: file.title, body: file.body, modified: file.modified, origin: 'agent', sourceTurn: 'turn_1' } });
  });

  it('reads a hand-written file with CRLF line endings and defaults the origin to the writer', () => {
    const parsed = parseMemoryFile('---\r\ntype: preference\r\ntitle: Tea\r\n---\r\n\r\nShe takes tea.\r\n');
    expect(parsed).toEqual({ ok: true, file: { type: 'preference', title: 'Tea', body: 'She takes tea.', modified: '', origin: 'writer' } });
  });

  it('refuses a file without a fence, a closing fence, a valid type or a title', () => {
    expect(parseMemoryFile('No front matter.')).toMatchObject({ ok: false });
    expect(parseMemoryFile('---\ntype: style\ntitle: X\n')).toMatchObject({ ok: false });
    expect(parseMemoryFile('---\ntype: lore\ntitle: X\n---\nbody')).toMatchObject({ ok: false, reason: expect.stringContaining('type') });
    expect(parseMemoryFile('---\ntype: style\n---\nbody')).toMatchObject({ ok: false, reason: 'it has no title' });
    expect(parseMemoryFile('---\nnot a pair\n---\nbody')).toMatchObject({ ok: false });
  });

  it('builds the index in slug order, with no date in it', () => {
    const index = memoryIndexOf([dialogue, endings]);
    expect(index).toBe(
      '- [Scene endings](process-endings.md) (process): End on a line of dialogue where possible.\n' +
        '- [Dialogue: no semicolons](style-dialogue.md) (style): No semicolons in dialogue.\n',
    );
    expect(memoryIndexOf([])).toBe('');
  });

  it('names slugs by a scan', () => {
    expect(['a', 'a-b-1', 'x'.repeat(64)].every(isMemorySlug)).toBe(true);
    expect(['', 'A', 'a--b', '-a', 'a-', 'a b', 'a_b', 'x'.repeat(65)].some(isMemorySlug)).toBe(false);
    expect(slugOf('  Dialogue: No semicolons!  ')).toBe('dialogue-no-semicolons');
    expect(slugOf('!!!')).toBe('');
  });
});

describe('the agent files in a project folder', () => {
  it('loads what a save wrote', async () => {
    const fs = new MemoryArtifactFs();
    const state = withAgentFiles();
    await writeProject(fs, state, { now: NOW });
    expect(await fs.read(INSTRUCTIONS_FILE)).toBe('British spelling.\nPast tense, close third person on Mara.\n');
    expect(await fs.read(MEMORY_INDEX)).toBe(state.agentFiles.index);
    expect(await fs.exists('memory/style-dialogue.md')).toBe(true);

    const loaded = await readProject(fs);
    expect(loaded.state.agentFiles.instructions).toEqual({ path: INSTRUCTIONS_FILE, text: 'British spelling.\nPast tense, close third person on Mara.\n' });
    expect(loaded.state.agentFiles.memory).toEqual([endings, dialogue]);
    expect(loaded.state.agentFiles.index).toBe(state.agentFiles.index);
    expect(loaded.notices.filter((notice) => notice.path === INSTRUCTIONS_FILE || notice.path.startsWith('memory/'))).toEqual([]);
  });

  it('writes a project with none exactly as before: no CAOTANG.md and no memory folder', async () => {
    const fs = new MemoryArtifactFs();
    await writeProject(fs, project(), { now: NOW });
    expect(await fs.exists(INSTRUCTIONS_FILE)).toBe(false);
    expect(await fs.exists('memory')).toBe(false);
    expect(hasAgentFiles((await readProject(fs)).state.agentFiles)).toBe(false);
  });

  it('reads AGENTS.md only when CAOTANG.md is absent, never both', async () => {
    const fs = new MemoryArtifactFs();
    await writeProject(fs, project(), { now: NOW });
    fs.putFile(INSTRUCTIONS_FALLBACK, 'From AGENTS.md.\n');
    const fallback = await readProject(fs);
    expect(fallback.state.agentFiles.instructions).toEqual({ path: INSTRUCTIONS_FALLBACK, text: 'From AGENTS.md.\n' });

    fs.putFile(INSTRUCTIONS_FILE, 'From CAOTANG.md.\n');
    const primary = await readProject(fs);
    expect(primary.state.agentFiles.instructions).toEqual({ path: INSTRUCTIONS_FILE, text: 'From CAOTANG.md.\n' });
  });

  it('never writes over AGENTS.md, and writes it only into a copy that has none', async () => {
    const fs = new MemoryArtifactFs();
    await writeProject(fs, project(), { now: NOW });
    fs.putFile(INSTRUCTIONS_FALLBACK, 'From AGENTS.md.\n');
    const state = (await readProject(fs)).state;
    fs.putFile(INSTRUCTIONS_FALLBACK, 'Edited in another tool.\n');
    const report = await writeProject(fs, state, { now: NOW });
    expect(report.written).not.toContain(INSTRUCTIONS_FALLBACK);
    expect(await fs.read(INSTRUCTIONS_FALLBACK)).toBe('Edited in another tool.\n');

    const copy = new MemoryArtifactFs();
    await writeProject(copy, state, { now: NOW });
    expect(await copy.read(INSTRUCTIONS_FALLBACK)).toBe('From AGENTS.md.\n');
    expect(await copy.exists(INSTRUCTIONS_FILE)).toBe(false);
  });

  it('keeps a malformed topic file as declined: named, carried, never rewritten or deleted', async () => {
    const fs = new MemoryArtifactFs();
    await writeProject(fs, withAgentFiles(), { now: NOW });
    fs.putFile('memory/hand-note.md', 'Just a note, no front matter.\n');
    const loaded = await readProject(fs);
    expect(loaded.state.agentFiles.declined.get('memory/hand-note.md')).toBe('Just a note, no front matter.\n');
    expect(loaded.state.agentFiles.memory.map((file) => file.slug)).toEqual(['process-endings', 'style-dialogue']);
    expect(loaded.notices.find((notice) => notice.path === 'memory/hand-note.md')?.say).toContain('hand-note');

    fs.putFile('memory/hand-note.md', 'Edited by hand since the load.\n');
    const report = await writeProject(fs, loaded.state, { now: NOW });
    expect(report.pruned).toEqual([]);
    expect(await fs.read('memory/hand-note.md')).toBe('Edited by hand since the load.\n');

    const copy = new MemoryArtifactFs();
    await writeProject(copy, loaded.state, { now: NOW });
    expect(await copy.read('memory/hand-note.md')).toBe('Just a note, no front matter.\n');
  });

  it('ignores a file in memory/ that is not a slug, and the index is not a topic', async () => {
    const fs = new MemoryArtifactFs();
    await writeProject(fs, withAgentFiles(), { now: NOW });
    fs.putFile('memory/Notes To Self.md', 'mine');
    fs.putFile('memory/readme.txt', 'mine');
    const loaded = await readProject(fs);
    expect(loaded.state.agentFiles.declined.size).toBe(0);
    expect(loaded.state.agentFiles.memory).toHaveLength(2);
    await writeProject(fs, loaded.state, { now: NOW });
    expect(await fs.read('memory/Notes To Self.md')).toBe('mine');
  });

  it('holds a file that is not UTF-8 back whole, says so, and never writes over it', async () => {
    const fs = new MemoryArtifactFs();
    await writeProject(fs, project(), { now: NOW });
    await fs.writeBytesAtomic(INSTRUCTIONS_FILE, Uint8Array.of(0x42, 0xe9, 0x74, 0xe9, 0x0a));
    const loaded = await readProject(fs);
    expect(loaded.state.agentFiles.instructions).toBeUndefined();
    expect(loaded.state.agentFiles.unreadable).toEqual([INSTRUCTIONS_FILE]);
    expect(loaded.encodingIssues.map((issue) => [issue.path, issue.kind])).toEqual([[INSTRUCTIONS_FILE, 'agent']]);
    expect(loaded.notices.some((notice) => notice.path === INSTRUCTIONS_FILE)).toBe(true);

    loaded.state.agentFiles = { ...loaded.state.agentFiles, instructions: { path: INSTRUCTIONS_FILE, text: 'New text.\n' } };
    await writeProject(fs, loaded.state, { now: NOW });
    expect([...(await fs.readBytes(INSTRUCTIONS_FILE))]).toEqual([0x42, 0xe9, 0x74, 0xe9, 0x0a]);
  });

  it('writes only the files whose text changed', async () => {
    const fs = new MemoryArtifactFs();
    const state = withAgentFiles();
    await writeProject(fs, state, { now: NOW });
    const again = await writeProject(fs, state, { now: NOW });
    expect(again.written.filter((path) => path === INSTRUCTIONS_FILE || path.startsWith('memory/'))).toEqual([]);

    state.agentFiles = { ...state.agentFiles, memory: [endings, { ...dialogue, body: 'Changed.' }] };
    const changed = await writeProject(fs, state, { now: NOW });
    expect(changed.written.filter((path) => path.startsWith('memory/'))).toEqual(['memory/style-dialogue.md']);
  });

  it('removes a forgotten topic and a cleared CAOTANG.md, and only those', async () => {
    const fs = new MemoryArtifactFs();
    const state = withAgentFiles();
    await writeProject(fs, state, { now: NOW });
    fs.putFile('memory/other-tool.md', 'another program’s note, not a Caotang topic');

    state.agentFiles = { memory: [endings], declined: new Map(), unreadable: [] };
    state.removedAgentFiles.add('memory/style-dialogue.md');
    state.removedAgentFiles.add(INSTRUCTIONS_FILE);
    const report = await writeProject(fs, state, { now: NOW });
    expect(report.pruned.sort()).toEqual([INSTRUCTIONS_FILE, 'memory/style-dialogue.md']);
    expect(await fs.exists('memory/other-tool.md')).toBe(true);
    expect(state.removedAgentFiles.size).toBe(0);
  });

  it('does not remove a file the state holds again after an undone forget', async () => {
    const fs = new MemoryArtifactFs();
    const state = withAgentFiles();
    await writeProject(fs, state, { now: NOW });
    state.removedAgentFiles.add('memory/style-dialogue.md');
    const report = await writeProject(fs, state, { now: NOW });
    expect(report.pruned).toEqual([]);
    expect(await fs.exists('memory/style-dialogue.md')).toBe(true);
  });
});

describe('an agent file changed by another program during a folder save', () => {
  it('is part of the folder digests, and a change names the file', async () => {
    const fs = new MemoryArtifactFs();
    const state = withAgentFiles();
    await writeProject(fs, state, { now: NOW });
    const held = await projectFileDigests(fs);
    expect([...held.keys()].filter((path) => path === INSTRUCTIONS_FILE || path.startsWith('memory/')).sort()).toEqual([
      INSTRUCTIONS_FILE,
      MEMORY_INDEX,
      'memory/process-endings.md',
      'memory/style-dialogue.md',
    ]);

    fs.putFile(INSTRUCTIONS_FILE, 'Edited elsewhere.\n');
    fs.putFile('memory/new-note.md', serializeMemoryFile({ ...endings, slug: 'new-note' }));
    const drift = driftOf(held, await projectFileDigests(fs));
    expect(drift.changed).toEqual([INSTRUCTIONS_FILE]);
    expect(drift.added).toEqual(['memory/new-note.md']);
    expect(changesInWords(drift, state, new Map(), 'this copy')).toBe('changed the file CAOTANG.md and added the memory note “new-note”');
  });

  it('refuses a folder save when CAOTANG.md changed on disk since the last load, and leaves the file as it is', async () => {
    const fs = new MemoryArtifactFs();
    const state = withAgentFiles();
    await writeProject(fs, state, { now: NOW });
    const held = await projectFileDigests(fs);
    fs.putFile(INSTRUCTIONS_FILE, 'Edited elsewhere.\n');
    state.agentFiles = { ...state.agentFiles, instructions: { path: INSTRUCTIONS_FILE, text: 'Mine.\n' } };
    await expect(writeProject(fs, state, { now: NOW, expectedDigests: held })).rejects.toBeInstanceOf(FolderDriftError);
    expect(await fs.read(INSTRUCTIONS_FILE)).toBe('Edited elsewhere.\n');
  });

  it('counts AGENTS.md as a project file only while CAOTANG.md is absent', async () => {
    const fs = new MemoryArtifactFs();
    await writeProject(fs, project(), { now: NOW });
    fs.putFile(INSTRUCTIONS_FALLBACK, 'x');
    expect([...(await projectFileDigests(fs)).keys()]).toContain(INSTRUCTIONS_FALLBACK);
    fs.putFile(INSTRUCTIONS_FILE, 'y');
    const paths = [...(await projectFileDigests(fs)).keys()];
    expect(paths).toContain(INSTRUCTIONS_FILE);
    expect(paths).not.toContain(INSTRUCTIONS_FALLBACK);
  });

  it('counts the agent files as project files, and nothing else under memory/', () => {
    for (const path of [INSTRUCTIONS_FILE, INSTRUCTIONS_FALLBACK, MEMORY_INDEX, 'memory/style-dialogue.md']) expect(isProjectFile(path), path).toBe(true);
    for (const path of ['memory/Bad Name.md', 'memory/a.txt', 'memory/sub/a.md', 'caotang.md', 'docs/CAOTANG.md']) expect(isProjectFile(path), path).toBe(false);
  });
});

describe('the agent files in a bundle', () => {
  it('round-trips both through the zip root', async () => {
    const state = withAgentFiles();
    const exported = await exportProjectZip(state, { now: NOW });
    expect(exported.entries).toContain(INSTRUCTIONS_FILE);
    expect(exported.entries).toContain(MEMORY_INDEX);
    expect(exported.entries).toContain('memory/style-dialogue.md');

    const { unzipSync } = await ZIP_ENGINE.load();
    const archived = unzipSync(exported.bytes);
    expect(dec(archived[INSTRUCTIONS_FILE])).toBe('British spelling.\nPast tense, close third person on Mara.\n');

    const loaded = await readProject((await importProjectZip(exported.bytes)).fs);
    expect(loaded.state.agentFiles.instructions?.text).toBe(state.agentFiles.instructions?.text);
    expect(loaded.state.agentFiles.memory).toEqual([endings, dialogue]);
    expect(agentFileTexts(loaded.state.agentFiles)).toEqual(agentFileTexts(state.agentFiles));
  });

  it('is the same bytes when exported twice, and leaves the open state untouched', async () => {
    const state = withAgentFiles();
    state.removedAgentFiles.add('memory/gone.md');
    const one = await exportProjectZip(state, { now: NOW });
    const two = await exportProjectZip(state, { now: NOW });
    expect([...one.bytes]).toEqual([...two.bytes]);
    expect(state.removedAgentFiles.size).toBe(1);
    const copy = cloneProjectState(state);
    (copy.agentFiles.memory as MemoryFile[])[0] = { ...endings, body: 'changed' };
    expect(state.agentFiles.memory[0]?.body).toBe(endings.body);
  });
});

describe('the agent files in the browser store', () => {
  it('are kept on the project row and come back with the state', async () => {
    const store = await openRuntimeStore(new MemoryIndexedDb(), 'agent-files-test');
    try {
      const state = withAgentFiles();
      state.agentFiles = { ...state.agentFiles, declined: new Map([['memory/hand-note.md', 'plain note\n']]) };
      await writeProjectState(store, state, { now: NOW });
      const id = state.manifest.project.id;
      const back = await readProjectState(store, id);
      expect(agentFileTexts(back.agentFiles)).toEqual(agentFileTexts(state.agentFiles));
      expect(back.agentFiles.declined.get('memory/hand-note.md')).toBe('plain note\n');

      // A structural commit carries the files across, as it does everything that is not the manifest.
      await commitProject(store, { projectId: id, manifest: state.manifest, now: NOW });
      expect(agentFileTexts((await readProjectState(store, id)).agentFiles)).toEqual(agentFileTexts(state.agentFiles));

      await writeProjectAgentFiles(store, id, { ...parseAgentFiles({ [INSTRUCTIONS_FILE]: 'Only this.\n' }).files });
      const alone = await readProjectState(store, id);
      expect(alone.agentFiles.instructions?.text).toBe('Only this.\n');
      expect(alone.agentFiles.memory).toEqual([]);
      expect([...alone.documents.values()].map((record) => record.body)).toEqual(['Cold open.']);

      await writeProjectAgentFiles(store, id, parseAgentFiles({}).files);
      expect(hasAgentFiles((await readProjectState(store, id)).agentFiles)).toBe(false);
    } finally {
      store.close();
    }
  });

  it('keeps the paths held back for their bytes', async () => {
    const store = await openRuntimeStore(new MemoryIndexedDb(), 'agent-files-held');
    try {
      const state = project();
      state.agentFiles = { memory: [], declined: new Map(), unreadable: [INSTRUCTIONS_FILE] };
      await writeProjectState(store, state, { now: NOW });
      expect((await readProjectState(store, state.manifest.project.id)).agentFiles.unreadable).toEqual([INSTRUCTIONS_FILE]);
    } finally {
      store.close();
    }
  });
});
