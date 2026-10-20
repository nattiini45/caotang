/**
 * Write-path contract tests — [project-format.md §1/§4](docs/architecture/project-format.md).
 *
 * §4 is where the interesting promises live: atomic replacement, the rolling
 * `caotang.json.bak.N` ladder, and the rule that `sessions.jsonl` is append-only
 * and never rewritten by an artifact write.
 */

import { describe, expect, it } from 'vitest';
import {
  MANIFEST_FILE,
  ManifestUnreadableError,
  MemoryArtifactFs,
  SESSIONS_FILE,
  SNAPSHOT_COUNT,
  addDocument,
  createEmptyManifest,
  createProjectState,
  parseCodexFile,
  readProject,
  removeNode,
  setBody,
  snapshotFile,
  writeProject,
  type CodexEntry,
  type ProjectState,
} from '../src/index.js';

const T0 = new Date('2026-09-28T01:00:00.000Z');
const T1 = new Date('2026-09-28T01:10:00.000Z');
const T2 = new Date('2026-09-28T01:20:00.000Z');
const T3 = new Date('2026-09-28T01:30:00.000Z');
const T4 = new Date('2026-09-28T01:40:00.000Z');

function project(): ProjectState {
  const state = createProjectState(createEmptyManifest('Keeper', T0));
  addDocument(state, {
    parentId: 'manuscript',
    title: 'The Landing',
    body: 'The ferry was late, as always.',
    now: T0,
    id: 'n_3W8RN2TQ6C',
  });
  return state;
}

function elena(): CodexEntry {
  return {
    id: 'c_5H8QK2M9RT',
    name: 'Elena Voss',
    aliases: ['Lena'],
    type: 'character',
    description: "The lighthouse keeper's daughter.",
    includePolicy: 'detected',
    caseSensitive: false,
    exclude: [],
    attachments: ['n_3W8RN2TQ6C'],
    keywords: ['protagonist'],
    origin: 'manual',
    sources: [],
    createdAt: T0.toISOString(),
    updatedAt: T0.toISOString(),
  };
}

describe('artifact write path', () => {
  it('writes the §1 shape: manifest, docs/, .gitignore, and the disposable dirs', async () => {
    const fs = new MemoryArtifactFs();
    await writeProject(fs, project(), { now: T0 });

    const files = Object.keys(fs.snapshot());
    expect(files).toContain(MANIFEST_FILE);
    expect(files).toContain('docs/n_3W8RN2TQ6C.md');
    expect(files).toContain('.gitignore');
    expect(fs.snapshot()['.gitignore']).toBe('exports/\n');
    expect(await fs.listDirs('')).toEqual(['codex', 'docs', 'exports']);
  });

  it('leaves no temp files behind — the atomic write is temp-then-rename', async () => {
    const fs = new MemoryArtifactFs();
    await writeProject(fs, project(), { now: T0 });
    await writeProject(fs, project(), { now: T1 });

    const leftovers = Object.keys(fs.snapshot()).filter((p) => p.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('rotates the manifest snapshots one generation down and drops the oldest', async () => {
    const fs = new MemoryArtifactFs();
    const state = project();

    // Four writes ⇒ four manifests, so the ladder is full and the first one
    // must have fallen off the end.
    await writeProject(fs, state, { now: T0 });
    const v0 = await fs.read(MANIFEST_FILE);
    await writeProject(fs, state, { now: T1 });
    await writeProject(fs, state, { now: T2 });
    await writeProject(fs, state, { now: T3 });
    await writeProject(fs, state, { now: T4 });

    expect(await fs.exists(snapshotFile(1))).toBe(true);
    expect(await fs.exists(snapshotFile(2))).toBe(true);
    expect(await fs.exists(snapshotFile(3))).toBe(true);
    expect(Object.keys(fs.snapshot()).filter((p) => p.includes('.bak.'))).toHaveLength(
      SNAPSHOT_COUNT,
    );

    // Each generation holds a genuinely older manifest, in ladder order.
    const ladder = await Promise.all([1, 2, 3].map((n) => fs.read(snapshotFile(n))));
    expect(ladder[0]).toContain('2026-09-28T01:30:00.000Z'); // T3 — the one just replaced
    expect(ladder[2]).toContain('2026-09-28T01:10:00.000Z'); // T1
    expect(v0).toContain('2026-09-28T01:00:00.000Z'); // T0 fell off
  });

  it('reports rotation so a caller can tell a recovery point from a first write', async () => {
    const fs = new MemoryArtifactFs();
    const first = await writeProject(fs, project(), { now: T0 });
    expect(first.rotated).toEqual([]);

    const second = await writeProject(fs, project(), { now: T1 });
    expect(second.rotated).toEqual([snapshotFile(1)]);
  });

  it('never rewrites sessions.jsonl — it is append-only stats, not artifact state', async () => {
    const fs = new MemoryArtifactFs();
    fs.putFile(SESSIONS_FILE, '{"startedAt":"2026-09-27T20:00:00.000Z","wordsWritten":431}\n');
    const before = await fs.read(SESSIONS_FILE);

    await writeProject(fs, project(), { now: T0 });
    await writeProject(fs, project(), { now: T1 });

    expect(await fs.read(SESSIONS_FILE)).toBe(before);
  });

  it("leaves an author's .gitignore alone instead of replacing it", async () => {
    const fs = new MemoryArtifactFs();
    fs.putFile('.gitignore', 'exports/\n*.bak\n');
    await writeProject(fs, project(), { now: T0 });
    expect(await fs.read('.gitignore')).toBe('exports/\n*.bak\n');
  });

  it('stamps project.modifiedAt on the state it writes', async () => {
    const fs = new MemoryArtifactFs();
    const state = project();
    await writeProject(fs, state, { now: T1 });
    expect(state.manifest.project.modifiedAt).toBe(T1.toISOString());
    expect(state.manifest.project.createdAt).toBe(T0.toISOString());
  });

  it('refuses to write a document node with no body rather than writing an empty file', async () => {
    const fs = new MemoryArtifactFs();
    const state = project();
    state.documents.delete('n_3W8RN2TQ6C');
    await expect(writeProject(fs, state, { now: T0 })).rejects.toThrow(/no body record/);
    expect(await fs.exists(MANIFEST_FILE)).toBe(false);
  });

  it('writes a document body edit without disturbing the rest of the project', async () => {
    const fs = new MemoryArtifactFs();
    const state = project();
    await writeProject(fs, state, { now: T0 });

    setBody(state, 'n_3W8RN2TQ6C', 'The ferry was early, which was worse.');
    const report = await writeProject(fs, state, { now: T1 });

    expect(report.written).toContain('docs/n_3W8RN2TQ6C.md');
    expect((await readProject(fs)).state.documents.get('n_3W8RN2TQ6C')?.body).toBe(
      'The ferry was early, which was worse.',
    );
  });

  // The snapshot ladder's own first step. A manifest that cannot be *read* is not
  // the same fact as a manifest that is not there: reading it that way overwrote
  // `caotang.json` with no snapshot of it, which is the one loss §5's recovery
  // ladder exists to prevent, caused by the ladder itself.
  it('refuses the save when the manifest cannot be read, rather than treating the failure as a first write', async () => {
    const fs = new (class extends MemoryArtifactFs {
      override async read(path: string): Promise<string> {
        if (path === MANIFEST_FILE) throw new Error('the disk is on fire');
        return super.read(path);
      }
    })();

    await expect(writeProject(fs, project(), { now: T0 })).rejects.toThrow('the disk is on fire');

    // Nothing was written over the manifest it could not read, and no snapshot
    // of a manifest that was never read was invented.
    expect(await fs.exists(MANIFEST_FILE)).toBe(false);
    expect(await fs.exists(snapshotFile(1))).toBe(false);
  });
});

/**
 * codex.md §3: "Written on every entry save via the same atomic write path as
 * documents" — the file is the entry's copy of itself outside the manifest, and
 * §5.4's rebuild scans for it. A write path that skips it produces a recovery
 * pass looking for files nothing ever creates.
 */
describe('codex redundancy files (codex.md §3)', () => {
  it('writes one redundancy file per entry, before the manifest', async () => {
    // `report.written` is sorted, so the order of the writes themselves is recorded here.
    const order: string[] = [];
    const fs = new (class extends MemoryArtifactFs {
      override async writeAtomic(path: string, contents: string): Promise<void> {
        order.push(path);
        await super.writeAtomic(path, contents);
      }
    })();
    const state = project();
    state.manifest.codex = [elena()];

    const report = await writeProject(fs, state, { now: T0 });

    expect(report.written).toContain('codex/c_5H8QK2M9RT.md');
    const parsed = parseCodexFile(await fs.read('codex/c_5H8QK2M9RT.md'));
    expect(parsed.frontMatter.name).toBe('Elena Voss');
    expect(parsed.frontMatter.attachments).toEqual(['n_3W8RN2TQ6C']);
    expect(parsed.description).toBe("The lighthouse keeper's daughter.");
    // Same ordering rule as documents: a crash leaves an importable orphan, not
    // a manifest entry pointing at nothing.
    expect(order).toContain(MANIFEST_FILE);
    expect(order.indexOf('codex/c_5H8QK2M9RT.md')).toBeLessThan(order.indexOf(MANIFEST_FILE));
  });

  it('leaves no temp file behind for a codex entry either', async () => {
    const fs = new MemoryArtifactFs();
    const state = project();
    state.manifest.codex = [elena()];
    await writeProject(fs, state, { now: T0 });
    expect(Object.keys(fs.snapshot()).filter((p) => p.includes('.tmp-'))).toEqual([]);
  });

  it('removes a redundancy file whose entry was deleted, so a rebuild cannot resurrect it', async () => {
    const fs = new MemoryArtifactFs();
    const state = project();
    state.manifest.codex = [elena()];
    await writeProject(fs, state, { now: T0 });
    expect(await fs.exists('codex/c_5H8QK2M9RT.md')).toBe(true);

    state.manifest.codex = [];
    const report = await writeProject(fs, state, { now: T1 });

    expect(report.pruned).toEqual(['codex/c_5H8QK2M9RT.md']);
    expect(await fs.exists('codex/c_5H8QK2M9RT.md')).toBe(false);
  });

  it('never touches a file in codex/ that is not an entry file (§1 unknown files)', async () => {
    const fs = new MemoryArtifactFs();
    const state = project();
    state.manifest.codex = [];
    await writeProject(fs, state, { now: T0 });
    fs.putFile('codex/notes.md', 'a person\'s scratch file\n');
    fs.putFile('codex/README.txt', 'not markdown\n');

    const report = await writeProject(fs, state, { now: T1 });

    expect(report.pruned).toEqual([]);
    expect(await fs.exists('codex/notes.md')).toBe(true);
    expect(await fs.exists('codex/README.txt')).toBe(true);
  });

  it('does not prune at all when the manifest carries no codex array', async () => {
    // An absent array means the codex was never loaded into this state — which
    // is not evidence that the folder is empty, and deleting on that evidence
    // would be data loss.
    const fs = new MemoryArtifactFs();
    const state = project();
    delete state.manifest.codex;
    fs.putFile('codex/c_5H8QK2M9RT.md', '---\nid: c_5H8QK2M9RT\nname: Elena\n---\n\nbody\n');

    const report = await writeProject(fs, state, { now: T0 });

    expect(report.pruned).toEqual([]);
    expect(await fs.exists('codex/c_5H8QK2M9RT.md')).toBe(true);
  });
});

/**
 * A redundancy file the loader **declined** to import survives the write.
 *
 * Every test here runs `readProject` and then `writeProject` on the state it
 * returned. That span is the slice: the finding was that the test named for
 * this property stopped at the load boundary, where the file is on disk under
 * any implementation, so it was green while the very next save deleted it. A
 * load-only test cannot see a prune, and a prune-only test cannot see a decline.
 */
describe('codex/ — a file the loader declined is not a file the writer owns', () => {
  const STRAY = 'codex/c_VANSHED002.md';
  /** A hand edit gone wrong: the file is there, its front matter is not. */
  const BROKEN = 'Elena keeps the light. She never lets anyone else near it.\n';

  async function folderWithStrayFile(): Promise<MemoryArtifactFs> {
    const fs = new MemoryArtifactFs();
    const state = project();
    state.manifest.codex = [elena()];
    await writeProject(fs, state, { now: T0 });
    fs.putFile(STRAY, BROKEN);
    return fs;
  }

  it('keeps it across the next save — load, then write, with no gap between them', async () => {
    const fs = await folderWithStrayFile();

    const loaded = await readProject(fs, { now: T1 });
    const report = await writeProject(fs, loaded.state, { now: T2 });

    expect(await fs.read(STRAY)).toBe(BROKEN);
    expect(report.pruned).toEqual([]);
  });

  it('decides at load, so the decline is a fact on the state rather than a re-read', async () => {
    const fs = await folderWithStrayFile();

    const loaded = await readProject(fs, { now: T1 });

    // Not `orphanCodex` (that is what got *imported*) and not `notices` (that is
    // what got said): the set is the machine-readable half of the same decision.
    expect(loaded.orphanCodex).toEqual([]);
    expect([...loaded.state.declinedCodexFiles]).toEqual(['c_VANSHED002.md']);
  });

  it('keeps it through every save, not only the first', async () => {
    const fs = await folderWithStrayFile();
    let state = (await readProject(fs, { now: T1 })).state;

    for (const [i, at] of [T2, T3, T4].entries()) {
      setBody(state, 'n_3W8RN2TQ6C', `Revision ${i + 1}.`);
      const report = await writeProject(fs, state, { now: at });
      expect(report.pruned).toEqual([]);
      expect(await fs.read(STRAY)).toBe(BROKEN);
      state = (await readProject(fs, { now: at })).state;
    }
  });

  it('still prunes a deleted entry — the protection is per-file, not a blanket', async () => {
    // A guard that protects everything passes the three tests above. This is the
    // one that says the prune is still a prune: same folder, same load, one
    // unreadable file and one file whose entry the author deleted.
    const fs = await folderWithStrayFile();
    const loaded = await readProject(fs, { now: T1 });
    loaded.state.manifest.codex = [];

    const report = await writeProject(fs, loaded.state, { now: T2 });

    expect(report.pruned).toEqual(['codex/c_5H8QK2M9RT.md']);
    expect(await fs.exists('codex/c_5H8QK2M9RT.md')).toBe(false);
    expect(await fs.read(STRAY)).toBe(BROKEN);
  });

  it('prunes a file whose front matter names another id, and says so at load', async () => {
    // The other un-owned file a review listed. Deliberately still pruned: the text is
    // imported under the id the front matter carries and written back at that
    // id, so nothing is lost, and leaving the stray file would make a §5.4
    // rebuild import it a second time as a duplicate.
    const fs = new MemoryArtifactFs();
    const state = project();
    state.manifest.codex = [];
    await writeProject(fs, state, { now: T0 });
    fs.putFile(
      'codex/c_VANSHED002.md',
      '---\nid: c_5H8QK2M9RT\nname: Elena Voss\n---\n\nThe lighthouse keeper\'s daughter.\n',
    );

    const loaded = await readProject(fs, { now: T1 });

    expect(loaded.orphanCodex).toEqual(['c_VANSHED002.md']);
    expect(loaded.state.manifest.codex?.[0]?.id).toBe('c_5H8QK2M9RT');
    expect(
      loaded.notices.some((n) => n.message.includes('removed on the next save')),
    ).toBe(true);
    // Not a decline: this file *was* read, so nothing about it is unreadable.
    expect([...loaded.state.declinedCodexFiles]).toEqual([]);

    const report = await writeProject(fs, loaded.state, { now: T2 });

    expect(report.pruned).toEqual(['codex/c_VANSHED002.md']);
    expect(await fs.exists('codex/c_VANSHED002.md')).toBe(false);
    // And the text survived, under the id it carries.
    expect(parseCodexFile(await fs.read('codex/c_5H8QK2M9RT.md')).description).toBe(
      "The lighthouse keeper's daughter.",
    );
  });

  it('leaves a codex/ file that is not an entry file alone, across load and write', async () => {
    // `codex/notes.md` is not an entry file (§1 unknown file) and the prune has
    // never touched it — asserted in the suite above as well, because that is
    // the other half of "the load said no and the writer listened".
    const fs = await folderWithStrayFile();
    fs.putFile('codex/notes.md', "a person's scratch file\n");

    const loaded = await readProject(fs, { now: T1 });
    const report = await writeProject(fs, loaded.state, { now: T2 });

    expect(await fs.read('codex/notes.md')).toBe("a person's scratch file\n");
    expect(report.pruned).toEqual([]);
  });
});

/**
 * `docs/` — the same prune, and the reason it exists.
 *
 * `codex/` got a prune and `docs/` did not, and the asymmetry was harmless
 * until `project.deleteNode` landed: §2 step 4 *imports* an orphan `docs/*.md` as a
 * Recovered document, so a deletion whose file stayed behind came back on the next
 * open — detached from its parent, stripped of the status and labels that lived in
 * the manifest the deletion removed. These tests are about the load-then-save span,
 * because that is the only span in which the defect is visible: a write-only test
 * would pass with no prune at all.
 */
describe('docs/ — a deleted document takes its file with it', () => {
  const AUTHORED = 'docs/chapter-one.md';
  const AUTHORED_BODY = "a file the author dropped in\n";

  async function folderWithTwoDocuments(): Promise<{ fs: MemoryArtifactFs; state: ProjectState }> {
    const fs = new MemoryArtifactFs();
    const state = project();
    addDocument(state, {
      parentId: 'manuscript',
      title: 'The Storm',
      body: 'It was a dark and stormy night.',
      now: T0,
      id: 'n_STRM000000',
    });
    await writeProject(fs, state, { now: T0 });
    return { fs, state };
  }

  it('prunes the file of a node that is gone, and reports it', async () => {
    const { fs, state } = await folderWithTwoDocuments();
    removeNode(state, 'n_STRM000000');

    const report = await writeProject(fs, state, { now: T1 });

    expect(report.pruned).toEqual(['docs/n_STRM000000.md']);
    expect(await fs.exists('docs/n_STRM000000.md')).toBe(false);
    // The document that stayed is not written again, because its text is already in its file (write.ts rule 3), so the
    // prune is not a `docs/` wipe with one file in it: the file is still there, and `written` names only what changed.
    expect(report.written).not.toContain('docs/n_3W8RN2TQ6C.md');
    expect(await fs.exists('docs/n_3W8RN2TQ6C.md')).toBe(true);
  });

  it('does not resurrect the deletion on the next open', async () => {
    // THE property. Without the prune this is a Recovered document with the title
    // from its front matter and none of the tree's structure, which is a
    // half-restored state rather than an error anything reports.
    const { fs, state } = await folderWithTwoDocuments();
    removeNode(state, 'n_STRM000000');
    await writeProject(fs, state, { now: T1 });

    const reloaded = await readProject(fs, { now: T2 });

    expect(reloaded.orphans).toEqual([]);
    expect(reloaded.state.manifest.tree.some((n) => n.id === 'n_STRM000000')).toBe(false);
    expect(reloaded.state.documents.has('n_STRM000000')).toBe(false);
    expect(reloaded.state.manifest.tree.some((n) => n.title === 'Recovered')).toBe(false);
  });

  it('leaves a file that is not <node-id>.md alone — that folder is the author\'s', async () => {
    const { fs, state } = await folderWithTwoDocuments();
    fs.putFile(AUTHORED, AUTHORED_BODY);
    removeNode(state, 'n_STRM000000');

    const report = await writeProject(fs, state, { now: T1 });

    // §1's unknown-files rule, applied inside the same loop: the prune only claims
    // a name that could have been a document.
    expect(await fs.read(AUTHORED)).toBe(AUTHORED_BODY);
    expect(report.pruned).toEqual(['docs/n_STRM000000.md']);
  });

  it('still adopts a hand-added document on load, so the prune cannot destroy one', async () => {
    // The safety argument for having no "declined" set here, the way `codex/` needs
    // one: §2 step 4 imports *every* orphan `docs/*.md`, so by the time anything is
    // written the author's file is a document in the manifest and the prune sees it
    // as owned. Two saves, because the first one is what adopts it.
    const { fs } = await folderWithTwoDocuments();
    fs.putFile('docs/n_HANDADD001.md', [
      '---',
      'id: n_HANDADD001',
      'title: Hand Added',
      'status: null',
      'label: null',
      '---',
      '',
      'The author wrote this straight into the folder.',
      '',
    ].join('\n'));

    const first = await readProject(fs, { now: T1 });
    expect(first.orphans).toEqual(['n_HANDADD001.md']);
    const report = await writeProject(fs, first.state, { now: T2 });

    expect(report.pruned).toEqual([]);
    expect(await fs.read('docs/n_HANDADD001.md')).toContain('The author wrote this straight into the folder.');
  });
});

describe('artifact read path', () => {
  it('raises a typed error rather than guessing when the manifest is unparseable', async () => {
    const fs = new MemoryArtifactFs();
    fs.putFile(MANIFEST_FILE, '{"app": "caotang", "formatVersion": 1,');
    await expect(readProject(fs)).rejects.toThrow(/not parseable JSON/);
  });

  it('raises a typed recovery-ready error when there is no manifest at all', async () => {
    const fs = new MemoryArtifactFs();
    // A missing manifest is the §5 ladder's first case, so it surfaces as the
    // same typed error as a corrupt one — with the path the ladder will walk.
    await expect(readProject(fs)).rejects.toBeInstanceOf(ManifestUnreadableError);
    await expect(readProject(fs)).rejects.toThrow(/no caotang\.json/);
  });

  it('refuses a manifest that fails validation and names the first violation', async () => {
    const fs = new MemoryArtifactFs();
    await writeProject(fs, project(), { now: T0 });
    const raw = JSON.parse(await fs.read(MANIFEST_FILE)) as Record<string, unknown>;
    (raw.project as { name: string }).name = '';
    fs.putFile(MANIFEST_FILE, JSON.stringify(raw));

    await expect(readProject(fs)).rejects.toThrow(/project\.name/);
  });

  it('notices unknown fields and drops them on the next save (§6)', async () => {
    const fs = new MemoryArtifactFs();
    await writeProject(fs, project(), { now: T0 });
    const raw = JSON.parse(await fs.read(MANIFEST_FILE)) as Record<string, unknown>;
    raw.someThirdPartyExtension = { enabled: true };
    // `kind` is a field this build knows (media-track), so the unknown-field example is a field it does not.
    (raw.tree as Record<string, unknown>[])[3]!.wordGoalOfTheDay = 500;
    fs.putFile(MANIFEST_FILE, JSON.stringify(raw));

    const loaded = await readProject(fs);
    expect(loaded.notices.map((n) => n.path)).toContain('top-level.someThirdPartyExtension');
    expect(loaded.notices.map((n) => n.path)).toContain('tree[3].wordGoalOfTheDay');

    await writeProject(fs, loaded.state, { now: T1 });
    const rewritten = await fs.read(MANIFEST_FILE);
    expect(rewritten).not.toContain('someThirdPartyExtension');
    expect(rewritten).not.toContain('"wordGoalOfTheDay"');
  });

  it('keeps the body when front matter is unreadable — the manifest still governs', async () => {
    const fs = new MemoryArtifactFs();
    await writeProject(fs, project(), { now: T0 });
    // Plain Markdown pasted into `docs/` — no fence at all. The body is still
    // the author's words, so it is kept and the manifest keeps the structure.
    fs.putFile('docs/n_3W8RN2TQ6C.md', 'just markdown, no front matter at all\n');

    const loaded = await readProject(fs);
    expect(loaded.state.documents.get('n_3W8RN2TQ6C')?.body).toContain('just markdown');
    expect(loaded.state.manifest.tree.find((n) => n.id === 'n_3W8RN2TQ6C')?.title).toBe(
      'The Landing',
    );
    expect(loaded.notices.map((n) => n.path)).toContain('docs/n_3W8RN2TQ6C.md');
  });

  it('reports a hand-edited title as a notice and keeps the manifest as truth', async () => {
    const fs = new MemoryArtifactFs();
    await writeProject(fs, project(), { now: T0 });
    const raw = (await fs.read('docs/n_3W8RN2TQ6C.md')).replace(
      'title: The Landing',
      'title: The Landing (edited by hand)',
    );
    fs.putFile('docs/n_3W8RN2TQ6C.md', raw);

    const loaded = await readProject(fs);
    expect(loaded.state.manifest.tree.find((n) => n.id === 'n_3W8RN2TQ6C')?.title).toBe(
      'The Landing',
    );
    expect(loaded.notices.some((n) => n.message.includes('title'))).toBe(true);
  });
});
