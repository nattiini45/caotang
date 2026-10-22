/**
 * §9's word/char counts, and the two spec sentences that named a function
 * nobody had written.
 *
 * ## The gap this slice closes, measured rather than asserted
 *
 * `project-format.md` §2 types `derived.wordCounts` as *"Derived, rebuildable,
 * allowed stale. Never a reason to reject a manifest; **loader recomputes on
 * open if absent**"*, and [editor-engine.md §9](docs/architecture/editor-engine.md)
 * says the counts are *"computed from the PM doc per revision … and written to
 * `derived.wordCounts`"*. Before this slice, `derived.wordCounts` was **typed,
 * initialized, serialized, documented and covered by nine tests, and assigned by
 * nothing**: across every package's `src` tree it appeared four times and none
 * was an assignment (`manifest.ts` the type, `create.ts` `{}`, `manifest-json.ts`
 * the serializer, and a *comment* in `state.ts` calling it "deliberately
 * untouched"). Measured on a real artifact: a document whose body carried six
 * words round-tripped through `writeProject` → `readProject` with
 * `"wordCounts": {}`.
 *
 * **Both ends were missing, and they are the two ends of one function** — §2's
 * rebuild on open, and §9's write per revision.
 *
 * ## What each test is for, because most of them would pass anyway
 *
 * The obvious test — "a write puts a number in the map" — passes against a
 * producer that is merely *called*, so these are built around the ways this
 * could be green and wrong:
 *
 * - **A count that is the body, not the file.** A body count taken from the
 *   serialized document file would include front matter, and `state.ts` holds
 *   bodies with none. Asserted against a body whose *file* has a different word
 *   count than its *body*.
 * - **A stamp that does not move** — the failure that keeps a count's number
 *   honest while the field beside it lies.
 * - **A rebuild that runs on every open**, which would make `computedAt` a
 *   function of how often a project was opened rather than of anything true.
 * - **A rebuild that covers only the manifest's documents**, skipping the orphan
 *   files §2 step 4 imports — which is a rebuild that is silently incomplete and
 *   still passes a fixture with no orphans in it.
 * - **An undo that restores the body but not the count**, which is
 *   `exit-gate.test.ts`'s byte-equality criterion failing on a field nobody was
 *   looking at. That one is measured red by an existing test, and it was.
 */

import { describe, expect, it } from 'vitest';
import { createActivityLog, createIdempotencyCache, createUndoStore, createViewState, execute } from '@caotang/bus';
import {
  MemoryArtifactFs,
  MemoryIndexedDb,
  addDocument,
  countBody,
  createEmptyManifest,
  createProjectState,
  WORD_RULE_VERSION,
  openRuntimeStore,
  readProject,
  readProjectState,
  rebuildDerived,
  serializeManifest,
  setBody,
  validateManifest,
  writeProject,
  writeProjectState,
  type ProjectState,
} from '../src/index.js';
import { createProjectCommandRegistry } from '../src/commands.js';
import type { BusContext, Command, CommandRegistry } from '@caotang/bus';

const OPENED = new Date('2026-10-07T08:00:00.000Z');
const LATER = new Date('2026-10-07T09:00:00.000Z');
const LANDING = 'n_3W8RN2TQ6C';
const STORM = 'n_5H8QK2M9RT';

/** §9's rule, restated here so a change to it has to break this file too. */
const expectedWords = (body: string): number => {
  const trimmed = body.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
};

function project(now = OPENED): ProjectState {
  const state = createProjectState(createEmptyManifest('Keeper', now));
  addDocument(state, {
    parentId: 'manuscript',
    title: 'The Landing',
    body: 'The ferry was late, as always',
    now,
    id: LANDING,
  });
  addDocument(state, { parentId: 'manuscript', title: 'The Storm', now, id: STORM });
  return state;
}

// ---------------------------------------------------------------------------
// 1. §9's rule, and the reading docs/decisions.md pinned
// ---------------------------------------------------------------------------

describe('§9 — the counting rule, in one place', () => {
  it('words is block text split on whitespace; chars is the body-projection length', () => {
    // 14 chars of text, a double newline, four more, a trailing newline. The
    // `chars` figure is asserted from the string rather than restated from the
    // implementation: this slice's first draft of this line said 19, and 19 was
    // wrong — the expectation, not the rule.
    const body = 'one two  three\n\nfour\n';
    expect(countBody(body)).toEqual({ words: 4, chars: 21 });
    expect(countBody(body).chars).toBe(body.length);
  });

  it('counts a blockquote marker as a word, because the projection’s block text carries it', () => {
    // docs/decisions.md measured this (`> quoted` → 2) and pinned it rather
    // than quietly fixing it: a count that excluded the marker is a *different*
    // rule, and §9 does not state one. Re-stated here because the rule now has
    // a second caller, and a second caller is how a pinned reading quietly
    // becomes an unexamined one.
    expect(countBody('> quoted\n').words).toBe(2);
  });

  it('an empty or whitespace-only body is zero words, not one', () => {
    // `''.split(/\s+/)` is `['']` — length 1. The empty case has to be named or
    // every empty document in the project counts as a word, and an empty
    // document is the state `binder.create` produces.
    expect(countBody('').words).toBe(0);
    expect(countBody('   \n\n  ').words).toBe(0);
  });

  it('chars counts the body as written, trailing newline included, while words ignores it', () => {
    const withNewline = countBody('one two\n');
    const without = countBody('one two');
    expect(withNewline.words).toBe(without.words);
    expect(withNewline.chars).toBe(without.chars + 1);
  });
});

// ---------------------------------------------------------------------------
// 2. §9's live producer — "per revision"
// ---------------------------------------------------------------------------

describe('§9 — a body write records the count', () => {
  it('setBody puts §9’s number in the map and moves computedAt', () => {
    const state = project();
    const body = 'The ferry was late, as always';
    expect(state.manifest.derived.wordCounts[LANDING]).toBe(expectedWords(body));

    setBody(state, LANDING, 'one two three four five six seven', { now: LATER });

    expect(state.manifest.derived.wordCounts[LANDING]).toBe(7);
    // The stamp is the half a count-only assertion cannot see, and it is the
    // half §2's `computedAt` exists for: a count recomputed now beside a stamp
    // naming the load is a field reporting a different number from the one it
    // counted.
    expect(state.manifest.derived.computedAt).toBe(LATER.toISOString());
  });

  it('counts the body, not the document file — front matter is not words', () => {
    // The body below is four words; the file the writer emits carries a title,
    // a status and three keywords in front matter. A count taken from the file
    // would be a different number, and this is the discriminator: the fixture
    // is written so the two answers cannot coincide.
    const state = project();
    const fs = new MemoryArtifactFs();
    const body = 'one two three four';
    setBody(state, LANDING, body, { now: LATER });
    return writeProject(fs, state).then(() =>
      fs.read(`docs/${LANDING}.md`).then((file) => {
        const fileWords = expectedWords(file);
        expect(state.manifest.derived.wordCounts[LANDING]).toBe(expectedWords(body));
        expect(fileWords).toBeGreaterThan(expectedWords(body));
      }),
    );
  });

  it('an unchanged body records nothing and stamps nothing', () => {
    // §4's no-op write burns no revision. A cache whose stamp advances on a
    // write that did not happen describes a revision that never existed.
    const state = project();
    const before = { ...state.manifest.derived };
    setBody(state, LANDING, 'The ferry was late, as always', { now: LATER });

    expect(state.manifest.derived).toEqual(before);
  });

  it('a new document is counted from the body it is born with, and an empty one is zero', () => {
    const state = project();
    // STORM was created with no body.
    expect(state.manifest.derived.wordCounts[STORM]).toBe(0);
    // Every document the tree holds appears in the map — otherwise the loader's
    // rebuild would add the missing ones on the next open, and the two
    // producers of one field would disagree about a document that never moved.
    for (const node of state.manifest.tree) {
      if (node.type !== 'document') continue;
      expect(Object.hasOwn(state.manifest.derived.wordCounts, node.id)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. §2's loader end — "recomputes on open if absent"
// ---------------------------------------------------------------------------

describe('§2 — the loader rebuilds when the field is absent', () => {
  it('an artifact written with real counts round-trips with them intact', async () => {
    const fs = new MemoryArtifactFs();
    await writeProject(fs, project());
    const loaded = await readProject(fs);

    const body = loaded.state.documents.get(LANDING)!.body;
    expect(loaded.state.manifest.derived.wordCounts).toEqual({
      [LANDING]: expectedWords(body),
      [STORM]: 0,
    });
  });

  it('a manifest carrying no derived block loads, and its next save does not throw', async () => {
    // **The measured defect this slice found.** Before it: `validateManifest`
    // accepts the manifest (`ok: true`, `errors: []`), `readProject`
    // **resolves**, and the failure lands on the *next save* —
    // `serializeManifest` throws
    // `Cannot read properties of undefined (reading 'wordCounts')`. §2 says
    // absence is never a reason to reject a manifest and that the loader
    // recomputes; before this slice the validator even warned "will be
    // recomputed on open", describing a function that did not exist.
    const fs = new MemoryArtifactFs();
    await writeProject(fs, project());
    const raw = JSON.parse(await fs.read('caotang.json')) as Record<string, unknown>;
    delete raw.derived;

    expect(validateManifest(raw, { docFiles: [`${LANDING}.md`, `${STORM}.md`] }).ok).toBe(true);

    await fs.writeAtomic('caotang.json', JSON.stringify(raw, null, 2));
    const loaded = await readProject(fs, { now: LATER });

    // The type says `derived: Derived`; this is where that becomes true.
    expect(loaded.state.manifest.derived.wordCounts).toEqual({ [LANDING]: 6, [STORM]: 0 });
    // And the save that used to throw now writes the rebuilt block.
    expect(() => serializeManifest(loaded.state.manifest)).not.toThrow();
    expect(serializeManifest(loaded.state.manifest)).toContain(`"${LANDING}": 6`);
  });

  it('rebuilds an empty map, which is what every pre-slice manifest serializes', async () => {
    // "Absent" is not a rare shape: with no producer, **every** manifest the
    // writer emitted carried `"wordCounts": {}`. An absent-only test would be
    // green against a field no project ever populated.
    const fs = new MemoryArtifactFs();
    const state = project();
    state.manifest.derived.wordCounts = {};
    await writeProject(fs, state);
    expect(await fs.read('caotang.json')).toContain('"wordCounts": {}');

    const loaded = await readProject(fs, { now: LATER });
    expect(loaded.state.manifest.derived.wordCounts).toEqual({ [LANDING]: 6, [STORM]: 0 });
    expect(loaded.state.manifest.derived.computedAt).toBe(LATER.toISOString());
  });

  it('leaves a populated map exactly as it is — §2 says allowed stale, not rebuilt', async () => {
    // The other half of §2's sentence. A rebuild on every open would make this
    // field a second source of truth and would make `computedAt` a function of
    // how often a project had been opened.
    const fs = new MemoryArtifactFs();
    const state = project();
    state.manifest.derived.wordCounts = { [LANDING]: 999, [STORM]: 999 };
    await writeProject(fs, state);
    await fs.writeAtomic(
      'caotang.json',
      await fs.read('caotang.json').then((text) =>
        text.replace(/"computedAt": "[^"]*"/, '"computedAt": "2001-01-01T00:00:00.000Z"'),
      ),
    );

    const loaded = await readProject(fs, { now: LATER });
    expect(loaded.state.manifest.derived.wordCounts).toEqual({ [LANDING]: 999, [STORM]: 999 });
    expect(loaded.state.manifest.derived.computedAt).toBe('2001-01-01T00:00:00.000Z');
  });

  it('covers an orphan document the manifest never mentioned', async () => {
    // §2 step 4 imports an un-owned `docs/*.md` into a `Recovered` folder. The
    // rebuild runs *after* that import for a reason: run earlier, it would
    // cover the manifest's documents and silently skip every file just adopted,
    // and a fixture with no orphans in it cannot tell the two apart.
    const fs = new MemoryArtifactFs();
    const state = project();
    await writeProject(fs, state);
    // The file on disk has to be the one carrying an empty map — clearing it on
    // the in-memory state after the write leaves the artifact populated, and
    // §2's "allowed stale" then correctly declines to rebuild. (Measured: that
    // version of this test asserted a number the loader had no instruction to
    // produce, and failed with `undefined`.)
    await fs.writeAtomic(
      'caotang.json',
      (await fs.read('caotang.json')).replace(/"wordCounts": \{[^}]*\}/, '"wordCounts": {}'),
    );
    await fs.writeAtomic(
      'docs/n_ZZPHAN0001.md',
      [
        '---',
        'id: n_ZZPHAN0001',
        'title: An orphan',
        'status: draft',
        'label: null',
        'keywords: []',
        'synopsis: ""',
        'notes: ""',
        '---',
        '',
        'five six seven eight nine',
        '',
      ].join('\n'),
    );

    const loaded = await readProject(fs, { now: LATER });
    expect(loaded.orphans).toEqual(['n_ZZPHAN0001.md']);
    // The whole point: the orphan is in `state.documents`, so the rebuild sees
    // it. A rebuild placed before `importOrphanDocuments` would not.
    expect(loaded.state.documents.has('n_ZZPHAN0001')).toBe(true);
    expect(loaded.state.manifest.derived.wordCounts['n_ZZPHAN0001']).toBe(5);
    expect(loaded.state.manifest.derived.wordCounts[LANDING]).toBe(6);
  });

  it('rebuildDerived is the loader’s rule and is safe to call on a live state', () => {
    const state = project();
    state.manifest.derived.wordCounts = {};
    rebuildDerived(state, { now: LATER });
    expect(state.manifest.derived.wordCounts).toEqual({ [LANDING]: 6, [STORM]: 0 });

    // Idempotent by construction: a second call sees a populated map and leaves
    // it, so a caller cannot re-stamp `computedAt` by asking twice.
    const first = state.manifest.derived.computedAt;
    rebuildDerived(state, { now: new Date('2027-01-01T00:00:00.000Z') });
    expect(state.manifest.derived.computedAt).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// 4. Undo — the manifest is part of what a body write must be undoable to
// ---------------------------------------------------------------------------

describe('§5.1 — an undo restores the count, not only the body', () => {
  it('the byte family holds the whole manifest, so a count-only restore is measured red', () => {
    // The evidence for this slice's second defect is `exit-gate.test.ts`'s
    // "snapshotOf(state) === before", which was red while this file was being
    // written and whose sole differing field was `computedAt`. That test is the
    // instrument; what is asserted here is the property it was standing on.
    const state = project();
    const before = JSON.stringify(state.manifest.derived);
    setBody(state, LANDING, 'a completely different body', { now: LATER });
    expect(JSON.stringify(state.manifest.derived)).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 5. The two branches the mutation harness measured as load-bearing
// ---------------------------------------------------------------------------

describe('the runtime-store loader is the second loader', () => {
  it('rehydrating a project whose row predates the producer rebuilds its counts', async () => {
    // **Found by the mutation harness, not by reading.** `readProjectState` is
    // app-open from IndexedDB, and it had no rebuild — so a row written before
    // this slice reappeared with `"wordCounts": {}` and no filesystem anywhere
    // in the picture. §2's "loader recomputes on open if absent" names both.
    const db = new MemoryIndexedDb();
    const store = await openRuntimeStore(db);
    const state = project();
    // The pre-slice shape: a valid manifest, an empty cache.
    state.manifest.derived = { wordCounts: {}, computedAt: OPENED.toISOString() };
    await writeProjectState(store, state, { now: OPENED });

    const rehydrated = await readProjectState(store, state.manifest.project.id);
    expect(rehydrated.manifest.derived.wordCounts).toEqual({ [LANDING]: 6, [STORM]: 0 });
    // And a second open leaves them alone: §2's "allowed stale", not a rebuild
    // that runs on every open.
    const again = await readProjectState(store, state.manifest.project.id);
    expect(again.manifest.derived.wordCounts).toEqual({ [LANDING]: 6, [STORM]: 0 });
  });

  it('a write to a document with no entry, undone, leaves it with no entry', async () => {
    // The `had` branch in `compensateBody`, asserted directly because no test in
    // the package reaches it otherwise: every loader rebuilds and every
    // `addDocument` records, so this state is reachable only by construction.
    // Without the branch the undo would *add* an entry — the defect class,
    // where a restore cannot remove a field the state never had.
    const { state, run, undoGroup } = harness(project());
    delete state.manifest.derived.wordCounts[LANDING];
    const outcome = run({
      id: 'cmd_b80_had',
      name: 'doc.write',
      params: { docId: LANDING, body: 'one two three four five' },
      issuedBy: 'user',
      createdAt: LATER.getTime(),
    });
    expect(state.manifest.derived.wordCounts[LANDING]).toBe(5);

    undoGroup(outcome.undoGroupId!);
    expect(Object.hasOwn(state.manifest.derived.wordCounts, LANDING)).toBe(false);
  });
});

/** The shipped pipeline, so the two tests above exercise the real applies. */
function harness(state: ProjectState) {
  const registry: CommandRegistry = createProjectCommandRegistry({ clock: { now: () => LATER.getTime() } });
  const undo = createUndoStore({ dispatch: (command) => execute(command, bus, registry) });
  const bus: BusContext<ProjectState> = {
    state,
    view: createViewState(),
    read: () => state,
    undo,
    log: createActivityLog(),
    idempotency: createIdempotencyCache(),
    notify: () => {},
  };
  return {
    state,
    run(command: Command) {
      const result = execute(command, bus, registry);
      if (!result.ok) throw new Error(`${command.name} was refused: ${result.error.message}`);
      return result.value;
    },
    undoGroup(groupId: string) {
      const result = undo.undo(groupId);
      if (!result.ok) throw new Error(`undoing ${groupId} failed: ${result.error.message}`);
      expect(result.value.failures.map((f) => `${f.target}: ${f.message}`)).toEqual([]);
      return result.value;
    },
  };
}

// ---------------------------------------------------------------------------
// 6. The words rule version — an older cache is rebuilt once, a newer one never
// ---------------------------------------------------------------------------

describe('derived.ruleVersion', () => {
  const CJK = '我喜欢在海边的灯塔里写作';

  /** A saved project holding a CJK document whose cache was counted by the whitespace rule. */
  async function stale(ruleVersion?: number): Promise<MemoryArtifactFs> {
    const fs = new MemoryArtifactFs();
    const state = project();
    setBody(state, LANDING, CJK, { now: OPENED });
    await writeProject(fs, state, { now: OPENED });
    const raw = JSON.parse(await fs.read('caotang.json')) as { derived: Record<string, unknown> };
    raw.derived.wordCounts = { [LANDING]: 1, [STORM]: 0 };
    if (ruleVersion === undefined) delete raw.derived.ruleVersion;
    else raw.derived.ruleVersion = ruleVersion;
    await fs.writeAtomic('caotang.json', JSON.stringify(raw, null, 2));
    return fs;
  }

  it('a new project is stamped with the rule in use', () => {
    expect(project().manifest.derived.ruleVersion).toBe(WORD_RULE_VERSION);
  });

  it('recomputes a cache with no ruleVersion, stamps it, and leaves modifiedAt alone', async () => {
    const fs = await stale();
    const loaded = await readProject(fs, { now: LATER });
    expect(loaded.state.manifest.derived.wordCounts[LANDING]).toBe(countBody(CJK).words);
    expect(loaded.state.manifest.derived.wordCounts[LANDING]).toBeGreaterThan(1);
    expect(loaded.state.manifest.derived.ruleVersion).toBe(WORD_RULE_VERSION);
    expect(loaded.state.manifest.derived.computedAt).toBe(LATER.toISOString());
    expect(loaded.state.manifest.project.modifiedAt).toBe(OPENED.toISOString());
  });

  it('recomputes a cache stamped with an older version', async () => {
    const loaded = await readProject(await stale(1), { now: LATER });
    expect(loaded.state.manifest.derived.wordCounts[LANDING]).toBe(countBody(CJK).words);
  });

  it('leaves a current cache alone, so a second open does not restamp it', async () => {
    const fs = await stale(WORD_RULE_VERSION);
    const loaded = await readProject(fs, { now: LATER });
    expect(loaded.state.manifest.derived.wordCounts[LANDING]).toBe(1);
    expect(loaded.state.manifest.derived.computedAt).toBe(OPENED.toISOString());
  });

  it('does not downgrade a cache counted with a newer rule', () => {
    const state = project();
    state.manifest.derived.ruleVersion = 3;
    state.manifest.derived.wordCounts[LANDING] = 99;
    rebuildDerived(state, { now: LATER });
    expect(state.manifest.derived.ruleVersion).toBe(3);
    expect(state.manifest.derived.wordCounts[LANDING]).toBe(99);
  });

  it('without a segmenter an empty cache is rebuilt by the whitespace rule and not stamped as the newer one', () => {
    const real = Intl.Segmenter;
    (Intl as { Segmenter: unknown }).Segmenter = undefined;
    try {
      const state = project();
      state.manifest.derived.wordCounts = {};
      rebuildDerived(state, { now: LATER });
      expect(state.manifest.derived.ruleVersion).toBeUndefined();
      expect(state.manifest.derived.wordCounts[LANDING]).toBe(6);
    } finally {
      (Intl as { Segmenter: unknown }).Segmenter = real;
    }
  });

  it('is written only when above 1, and survives a round trip', () => {
    const state = project();
    expect(serializeManifest(state.manifest)).toContain(`"ruleVersion": ${WORD_RULE_VERSION}`);
    delete state.manifest.derived.ruleVersion;
    expect(serializeManifest(state.manifest)).not.toContain('ruleVersion');
    state.manifest.derived.ruleVersion = 1;
    expect(serializeManifest(state.manifest)).not.toContain('ruleVersion');
  });

  it.each([['2'], [0], [1.5], [-1], [null]])('treats %j as absent with a warning, never a rejection', async (bad) => {
    const fs = new MemoryArtifactFs();
    await writeProject(fs, project());
    const raw = JSON.parse(await fs.read('caotang.json')) as { derived: Record<string, unknown> };
    raw.derived.ruleVersion = bad;
    const report = validateManifest(raw, { docFiles: [`${LANDING}.md`, `${STORM}.md`] });
    expect(report.ok).toBe(true);
    expect(report.warnings.some((w) => w.path === 'derived.ruleVersion')).toBe(true);
    expect((report.manifest?.derived as { ruleVersion?: number }).ruleVersion).toBeUndefined();
  });

  it('is restored by an undo of a body write', () => {
    const { state, run, undoGroup } = harness(project());
    state.manifest.derived.ruleVersion = 3;
    const outcome = run({ id: 'cmd_rv_1', name: 'doc.write', params: { docId: LANDING, body: 'one two' }, issuedBy: 'user', createdAt: LATER.getTime() });
    undoGroup(outcome.undoGroupId!);
    expect(state.manifest.derived.ruleVersion).toBe(3);

    delete state.manifest.derived.ruleVersion;
    const second = run({ id: 'cmd_rv_2', name: 'doc.write', params: { docId: LANDING, body: 'one two three' }, issuedBy: 'user', createdAt: LATER.getTime() });
    undoGroup(second.undoGroupId!);
    expect(state.manifest.derived.ruleVersion).toBeUndefined();
  });
});
