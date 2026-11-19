/**
 * §6's migration path, exercised with a synthetic registry.
 *
 * [project-format.md §6](docs/architecture/project-format.md) is a contract about
 * a project that arrives at an *older* `formatVersion` than the build reading it:
 * the manifest is upgraded in memory before anything is validated, steps 3–4 judge
 * what the migration produced, the state is built from the manifest that was
 * judged, and a writer refuses objects that still need that migration. The
 * production registry is empty: v1 and v2 use the same schema. To exercise an
 * actual transformation, the tests use the substitution of
 * {@link FormatContext} — a registry and the version it targets — defaulted
 * everywhere in the package to the frozen production value.
 *
 * **Each test names one mechanism and carries a control that holds still while
 * the mechanism moves.** The controls are not decoration: without the
 * "nothing migrated" control, the vocabulary test would pass on a manifest whose
 * vocabulary happened to lack `draft` for an unrelated reason, and without the
 * "no step" control the loader test would pass on a `read.ts` that ignored the
 * report entirely. Reverting each of the three fixes fails exactly the test
 * written for it.
 */

import { describe, expect, it } from 'vitest';
import {
  FORMAT_VERSION,
  MIGRATIONS,
  MANIFEST_FILE,
  MemoryArtifactFs,
  MigrationError,
  PRODUCTION_FORMAT,
  addDocument,
  createEmptyManifest,
  createProjectState,
  readProject,
  runMigrations,
  serializeManifest,
  snapshotFile,
  validateManifest,
  writeProject,
  type FormatContext,
  type Manifest,
  type Migration,
  type MigrationRegistry,
} from '../src/index.js';

const T = new Date('2026-10-04T00:00:00.000Z');
const DOC_ID = 'n_3W8RN2TQ6C';

/**
 * v1 → v2, renaming the `draft` status term to `wip` **in the vocabulary only**.
 *
 * That is the counterfactual worth testing, and the shape of the defect is what makes
 * it a real one rather than a contrivance: a term rename is exactly the migration
 * a format bump contains, and the nodes keep pointing at the old id afterwards.
 * §2's tolerance ("unknown value on load → keep string, surface as chip, never
 * drop data") is the contract that the *user* gets told, so the load has to
 * notice. Reading the pre-migration vocabulary is what silences it.
 */
const renameStatusTerm: Migration = {
  from: 1,
  to: 2,
  describe: 'rename the "draft" status term to "wip"',
  run(input) {
    const vocabulary = input.vocabulary as { statuses: Record<string, unknown>[]; labels: unknown[] };
    return {
      ...input,
      vocabulary: {
        ...vocabulary,
        statuses: vocabulary.statuses.map((term) =>
          term.id === 'draft' ? { ...term, id: 'wip' } : term,
        ),
      },
    };
  },
};

/**
 * v1 → v2, rewriting content only: every node title gains a suffix.
 *
 * A second step, in its own registry, so the loader test below cannot pass
 * because of the vocabulary rename — the two findings must be separable or a
 * fix for one can hide a regression in the other.
 */
const retitleNodes: Migration = {
  from: 1,
  to: 2,
  describe: 'append " (migrated)" to every node title',
  run(input) {
    const tree = input.tree as Record<string, unknown>[];
    return { ...input, tree: tree.map((n) => ({ ...n, title: `${String(n.title)} (migrated)` })) };
  },
};

/** A build that knows one step and is at v2. */
const atV2 = (registry: MigrationRegistry): FormatContext => ({ registry, current: 2 });

/** `createEmptyManifest` with one document node, held at `formatVersion: 1`. */
function v1WithStatus(status: string): Record<string, unknown> {
  const base = createEmptyManifest('K', T) as unknown as Record<string, unknown>;
  return {
    ...base,
    formatVersion: 1,
    tree: [
      ...(base.tree as Record<string, unknown>[]),
      {
        id: DOC_ID,
        parentId: 'manuscript',
        type: 'document',
        title: 'The Landing',
        order: 30,
        status,
        label: null,
        keywords: [],
        synopsis: '',
        notes: '',
      },
    ],
  };
}

/** The `docs/*.md` §2 step 4 requires, matching the manifest node exactly. */
const docMarkdown = [
  '---',
  `id: ${DOC_ID}`,
  'title: The Landing',
  'status: draft',
  '---',
  '',
  'The ferry was late, as always.',
  '',
].join('\n');

function folderWith(manifest: Record<string, unknown>): MemoryArtifactFs {
  const fs = new MemoryArtifactFs();
  fs.putFile(MANIFEST_FILE, JSON.stringify(manifest));
  fs.putFile(`docs/${DOC_ID}.md`, docMarkdown);
  return fs;
}

/** A writable state carrying one document, at `formatVersion: 1`. */
function staleState(body: string): ReturnType<typeof createProjectState> {
  const state = createProjectState(createEmptyManifest('K', T));
  addDocument(state, { parentId: 'manuscript', title: 'The Landing', body, now: T, id: DOC_ID });
  (state.manifest as unknown as Record<string, unknown>).formatVersion = 1;
  return state;
}

describe('the seam is production by default, and stays that way', () => {
  it('defaults to the shipped registry at the shipped version', () => {
    // The hazard a seam creates is not that a test can substitute a registry; it
    // is that something might *seed* one to make a test pass — a fake v0 → v1 in
    // `MIGRATIONS` would make the whole branch live in production and hand every
    // artifact a version that never shipped. Asserted here, next to the seam it
    // would have been smuggled through.
    expect(PRODUCTION_FORMAT.registry).toBe(MIGRATIONS);
    expect(PRODUCTION_FORMAT.current).toBe(FORMAT_VERSION);
    expect(MIGRATIONS).toEqual([]);
  });

  it('the production build still validates a v1 manifest without migration', () => {
    const report = validateManifest(v1WithStatus('draft'), { docFiles: [`${DOC_ID}.md`] });
    expect(report.migrations).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('a substituted context runs the step the production one cannot', () => {
    const report = validateManifest(v1WithStatus('draft'), {
      format: atV2([renameStatusTerm]),
      docFiles: [`${DOC_ID}.md`],
    });
    expect(report.migrations.map((m) => `${m.from}→${m.to}`)).toEqual(['1→2']);
  });
});

describe('step 3 judges the vocabulary the migration produced', () => {
  it('raises the unknown-vocabulary warning the renamed term causes', () => {
    // The node still says `draft`; the step renamed the term to `wip`; so the
    // node now points at an id the manifest no longer defines, and §2's rule
    // ("kept and shown as an unknown chip") only works if the load says so.
    const report = validateManifest(v1WithStatus('draft'), {
      format: atV2([renameStatusTerm]),
      docFiles: [`${DOC_ID}.md`],
    });

    const warning = report.warnings.find((w) => w.path === 'tree[3].status');
    expect(warning).toBeDefined();
    expect(warning?.message).toContain('unknown vocabulary id "draft"');
    // §2's tolerance: a warning, never a refusal. The manifest still opens.
    expect(report.ok).toBe(true);
  });

  it('control: the same manifest raises no such warning when nothing migrated', () => {
    // `draft` is a real term in the shipped vocabulary, so the warning above is
    // caused by the step and by nothing else. Without this the first test would
    // also pass against a `draft` that was simply never defined.
    const report = validateManifest(v1WithStatus('draft'), { docFiles: [`${DOC_ID}.md`] });
    expect(report.warnings).toEqual([]);
  });
});

describe('the state is built from the manifest that was validated', () => {
  it('carries the migrated titles, not the ones on disk', async () => {
    const loaded = await readProject(folderWith(v1WithStatus('draft')), {
      format: atV2([retitleNodes]),
    });

    expect(loaded.report.migrations).toHaveLength(1);
    expect(loaded.state.manifest.formatVersion).toBe(2);
    expect(loaded.state.manifest.tree[0]?.title).toBe('K (migrated)');
  });

  it('control: with nothing to migrate the state carries the titles on disk', async () => {
    // The same assertion, one context lower, is what makes the first one a
    // statement about the migration rather than about `read.ts` in general.
    const loaded = await readProject(folderWith(v1WithStatus('draft')));
    expect(loaded.report.migrations).toEqual([]);
    expect(loaded.state.manifest.tree[0]?.title).toBe('K');
  });
});

describe('§6 writer version boundaries', () => {
  it('refuses to stamp the current version over a manifest that has not been migrated', () => {
    const stale = { ...createEmptyManifest('K', T), formatVersion: 1 } as Manifest;
    expect(() => serializeManifest(stale, atV2([renameStatusTerm]))).toThrow(MigrationError);
    expect(() => serializeManifest(stale, atV2([renameStatusTerm]))).toThrow(
      /has not\s+been migrated/,
    );
  });

  it('refuses a manifest that is already newer than this build', () => {
    const ahead = { ...createEmptyManifest('K', T), formatVersion: FORMAT_VERSION + 1 };
    expect(() => serializeManifest(ahead, PRODUCTION_FORMAT)).toThrow(/newer than this build/);
  });

  it('control: the migrated manifest writes at the version it actually reached', () => {
    const stale = { ...createEmptyManifest('K', T), formatVersion: 1 } as unknown as Record<
      string,
      unknown
    >;
    const { manifest } = runMigrations([renameStatusTerm], stale, 2);
    const text = serializeManifest(manifest as unknown as Manifest, atV2([renameStatusTerm]));

    expect(text).toContain('\n  "formatVersion": 2,');
    expect(text).toContain('"id": "wip"');
  });

  it('control: a manifest at the highest supported version still writes it', () => {
    const manifest = { ...createEmptyManifest('K', T), formatVersion: FORMAT_VERSION };
    expect(serializeManifest(manifest)).toContain(
      `\n  "formatVersion": ${FORMAT_VERSION},`,
    );
  });

  it('a refused artifact write creates no manifest and shifts no snapshot', async () => {
    // The ordering this pins: `writeProject` serializes *before* it rotates, so a
    // refusal costs the folder nothing. Serializing after the rotation would move
    // `caotang.json` into `bak.1` and then decline to write — a write that changed
    // the recovery ladder (§4's whole purpose) and produced no manifest.
    //
    // **The folder is seeded first, and that is the load-bearing detail.** Written
    // into an empty fs, asserting `bak.1` does not exist would pass with the
    // rotation moved back in front of the serialization, because a folder with no
    // `caotang.json` has nothing to rotate. A test whose name claims the ladder was
    // not disturbed has to check a folder where the ladder exists.
    const fs = new MemoryArtifactFs();
    const seeded = createProjectState(createEmptyManifest('K', T));
    await writeProject(fs, seeded, { snapshotCount: 3 });

    // A second, *stale* state — same project, never migrated — refused at v2.
    const stale = createProjectState({
      ...createEmptyManifest('K', T),
      formatVersion: 1,
    } as Manifest);
    const before = await fs.read(MANIFEST_FILE);

    await expect(writeProject(fs, stale, { format: atV2([renameStatusTerm]) })).rejects.toThrow(
      MigrationError,
    );
    expect(await fs.exists(MANIFEST_FILE)).toBe(true);
    expect(await fs.read(MANIFEST_FILE)).toBe(before);
    expect(await fs.exists(snapshotFile(1))).toBe(false);
  });

  it('and a refused write is not free: the documents and the prunes have already run', async () => {
    // **The measurement, and the reason the test above is narrower than it looks.**
    // `serializeManifest` is step 4 of a write that has already created three
    // directories, written every document body whose text changed, rewritten
    // codex files and **pruned** codex files, and created `.gitignore`. Deleted
    // documents' files are not among those: they are pruned after the manifest
    // (step 5), so a refusal never reaches them.
    // The refusal is not the first thing that can fail, and it does not cost
    // nothing: in one call, below, a body reaches disk and a file is
    // deleted, and only then does the manifest go unwritten.
    //
    // The rotation half of the ordering fix is real and is pinned above; this is
    // the rest of the same function. A **characterisation, not an endorsement**:
    // a v1 manifest does not require migration in production. It is pinned so the page says what
    // the code does — and so the day the check is hoisted above the writes (the
    // change planned for it), **this** is the test that fails,
    // which is the right direction for a change that widens the guarantee.
    const fs = new MemoryArtifactFs();
    await writeProject(fs, staleState('The ferry was late, as always.'), { snapshotCount: 3 });
    // A codex file the writer has no entry for — the shape the loader recovers
    // rather than drops, and the shape a prune removes.
    fs.putFile('codex/c_VANSHED002.md', 'front matter gone wrong\n');

    const stale = staleState('The ferry was late, and the light was late with it.');
    await expect(writeProject(fs, stale, { format: atV2([renameStatusTerm]) })).rejects.toThrow(
      MigrationError,
    );

    // The body reached disk; the un-owned codex file is gone. The manifest and
    // the ladder are untouched, which is all the test above promised.
    expect(await fs.read(`docs/${DOC_ID}.md`)).toContain('the light was late with it');
    expect(await fs.exists('codex/c_VANSHED002.md')).toBe(false);
  });
});
