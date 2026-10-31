/**
 * §5's `compensable` text family.
 *
 * The five applies: `notes.set`, `notes.append`, `doc.write`, `editor.insert`,
 * `editor.replaceRange`. Every test here defends a sentence of §5 or §5.1, and
 * most of them exist because of the one property the family has that `inverse`
 * does not: **the command captured a restore artifact at apply time** rather
 * than the descriptor generating a command to dispatch.
 *
 * ## What these tests are actually about
 *
 * A body snapshot that is captured one line too late is a restore that changes
 * nothing, and it is *indistinguishable from a working undo* from the outside —
 * the group registers, the label reads correctly, the pipeline's step 5 is
 * satisfied, and clicking undo leaves the document exactly as wrong as it was.
 * Every green test in a "does the undo work?" suite can therefore pass against a
 * capture that never captured anything. So the assertions below are written
 * against **the text itself**, never against a count or a flag:
 *
 * - `it('restores the exact prior body …')` would pass against `restore: () => {}`
 *   only if the body were already correct, so each one mutates first, undoes,
 *   and reads the string.
 * - The capture-order claim has its own test: a write whose restore is a no-op
 *   fails it, and that is the mutation it is checked with.
 *
 * ## One `before`, two consumers — so a mutation only ever reaches one of them
 *
 * `captureBody` reads the prior body **once** and fans it out twice: into the
 * `sink(...)` call that becomes the §5.1 durable row, and into the
 * `{ before, revision }` it returns, which is what the undo closure restores.
 * Those are independent, and **no single mutation can break both** — both were measured,
 * and the two numbers are the only honest description of what each
 * mutation tests:
 *
 * | mutation | site | fails |
 * |---|---|---|
 * | empty capture | `return { before: '', revision }` | **10 of 27** — every restore assertion, and *not* the store test |
 * | empty durable row | `sink({ …, body: '', … })` | **1 of 27** — `a store binding receives the pre-mutation body`, and none of the ten |
 *
 * So the reported *"an empty capture fails eleven of 27"* was a count of eleven
 * against a mutation that **cannot** reach the eleventh test: the store test reads
 * the row, and the row's body comes from a different expression. Both halves are
 * genuinely guarded — each has its own test and its own mutation, and the control
 * above is what proves the other half is real rather than unasserted. What was
 * wrong is the record, not the suite: *a mutation failing N tests is a statement
 * about the mutant*, and N means nothing without the exact site it was applied to.
 *
 * The same shape holds inside `writeBodySnapshot`, one layer down: `add` and the
 * in-transaction `get` each independently refuse a duplicate capture, so neither
 * is load-bearing alone and no test attributes the guarantee to either. Both
 * measurements are in that function's comment.
 *
 * ## The two halves of the split, both asserted
 *
 * §5.1 rule 7 puts the snapshot in the **IndexedDB runtime store, never the
 * artifact**, so the store gained a `snapshots` object store and a
 * `RUNTIME_DB_VERSION` bump. The applies reach it through a seam rather than
 * calling it, because §3's bus is synchronous (A2) and a transaction is not.
 * Both halves matter and each is asserted here: that a *store* binding receives
 * the pre-mutation body, and that a registry with **no** binding still produces a
 * fully reversible group. A family that only worked with a store attached would
 * be a family whose undo depends on a caller remembering to attach one.
 *
 * ## The registration refusal is not reached
 *
 * The pipeline's step-5 registration refusal is correct behaviour, and it
 * needs one more test: a test that says the refusal is *not
 * reached* because the applies capture correctly. That is the first test in the
 * last describe block, and it asserts the outcome is `ok` for all five — a
 * `registrationRefusal` would be an `internal` error naming the command.
 */

import { describe, expect, it } from 'vitest';
import {
  COMMAND_REGISTRY,
  createActivityLog,
  createIdempotencyCache,
  createUndoStore,
  createViewState,
  execute,
  resolveCommand,
  type BusContext,
  type Command,
  type ExecutionOutcome,
  type UndoEntry,
  type UndoOutcome,
  type UndoStore,
} from '@caotang/bus';

import {
  MemoryIndexedDb,
  SnapshotExistsError,
  addDocument,
  addFolder,
  createEmptyManifest,
  createProjectCommandRegistry,
  createProjectState,
  deleteProject,
  getBody,
  getRevision,
  nodeById,
  openRuntimeStore,
  readBodySnapshots,
  setBody,
  writeBodySnapshot,
  writeProjectState,
  type BodySnapshot,
  type ProjectState,
  type RuntimeStore,
} from '../src/index.js';

const OPENED = new Date('2026-10-02T15:00:00.000Z');
const CHAPTER_ONE = 'n_CHAPTERONE0';
const LANDING = 'n_LANDING00000';
const STORM = 'n_STORM000000';
const UNKNOWN = 'n_NOSUCHNODE';

/** A fixed clock, so a snapshot's `capturedAt` and the `notes.append` divider are assertions. */
const TICK = 1_760_000_000_000;
const TICK_DATE = '2025-10-09';
const clock = { now: () => TICK };

const LANDING_BODY = 'The ferry was late, as always.';
const STORM_BODY = 'He counted the ships, and the ships counted him.';

interface Harness {
  readonly state: ProjectState;
  readonly bus: BusContext<ProjectState>;
  readonly undo: UndoStore;
  readonly registry: ReturnType<typeof createProjectCommandRegistry>;
  readonly snapshots: BodySnapshot[];
  run(command: Command): ExecutionOutcome;
  undoGroup(groupId: string): UndoOutcome;
  /** The single entry of the group this dispatch opened. */
  entryOf(groupId: string): UndoEntry;
}

function makeState(): ProjectState {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', OPENED));
  state.manifest.project.id = 'p_9XK2M4Q7RZ';
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 1', now: OPENED, id: CHAPTER_ONE });
  addDocument(state, {
    parentId: CHAPTER_ONE,
    title: 'The Landing',
    body: LANDING_BODY,
    now: OPENED,
    id: LANDING,
  });
  addDocument(state, {
    parentId: CHAPTER_ONE,
    title: 'The Storm',
    body: STORM_BODY,
    now: OPENED,
    id: STORM,
  });
  return state;
}

function harness(): Harness {
  const state = makeState();
  const snapshots: BodySnapshot[] = [];
  const registry = createProjectCommandRegistry({
    clock,
    snapshots: (snapshot) => {
      snapshots.push(snapshot);
    },
  });
  const undo = createUndoStore({ dispatch: (command) => execute(command, bus, registry) });
  const bus: BusContext<ProjectState> = {
    state,
    view: createViewState(),
    read: () => state,
    undo,
    log: createActivityLog(),
    idempotency: createIdempotencyCache(),
    notify: () => {},
    // §4: `write-confirm` "is allowed only inside an approved plan", and three
    // of the five are `write-confirm` — so an agent-issued dispatch in a
    // multi-entry turn needs one. A harness without it could only ever test the
    // user path, and the agent turn is the half §5's checkpoint framing is for.
    permission: { approvedPlan: true },
  };
  return {
    state,
    bus,
    undo,
    registry,
    snapshots,
    run(command) {
      const result = execute(command, bus, registry);
      if (!result.ok) throw new Error(`${command.name} was refused: ${result.error.message}`);
      return result.value;
    },
    undoGroup(groupId) {
      const result = undo.undo(groupId);
      if (!result.ok) throw new Error(`undoing ${groupId} failed: ${result.error.message}`);
      return result.value;
    },
    entryOf(groupId) {
      const entries = undo.group(groupId)?.entries ?? [];
      expect(entries, `${groupId} registered nothing`).toHaveLength(1);
      return entries[0]!;
    },
  };
}

let ordinal = 0;
function cmd(partial: Partial<Command> & Pick<Command, 'name' | 'params'>): Command {
  ordinal += 1;
  return {
    id: `cmd_COMP${String(ordinal).padStart(5, '0')}`,
    issuedBy: 'user',
    createdAt: TICK - 1_000,
    ...partial,
  };
}

function node(state: ProjectState, id: string) {
  const found = nodeById(state, id);
  if (!found) throw new Error(`fixture is missing node ${id}`);
  return found;
}

// ---------------------------------------------------------------------------

describe('§5 — a body snapshot is the restore artifact, and it is captured before the write', () => {
  it('doc.write restores the exact prior body, and the prior revision with it', () => {
    const h = harness();
    const revisionBefore = getRevision(h.state, LANDING);
    h.run(cmd({ name: 'doc.write', params: { docId: LANDING, body: 'The ferry came early.' } }));
    expect(getBody(h.state, LANDING)).toBe('The ferry came early.');

    h.undoGroup(h.undo.groups()[0]!.id);
    // The body is the claim. The revision is the undo's own write: it bumps like the
    // write it reverses, so it ends two above where the document started, not back at
    // the captured number (project-format §4: every mutation bumps the counter).
    expect(getBody(h.state, LANDING)).toBe(LANDING_BODY);
    expect(getRevision(h.state, LANDING)).toBe(revisionBefore + 2);
  });

  it('an undo moves the revision up, so a plan made against the undone text cannot overwrite newer text', () => {
    // Regression for the ABA case: write A (rev 1), write B (rev 2), undo B (rev 3, body A),
    // type C at rev 3, then a plan drafted against B at rev 2 must be refused rather than
    // overwriting C. With the undo re-asserting rev 1, rev 2 came back and the stale write matched.
    const h = harness();
    const start = getRevision(h.state, LANDING);
    h.run(cmd({ name: 'doc.write', params: { docId: LANDING, body: 'First: the ferry was early.', expectedRevision: start } }));
    h.run(cmd({ name: 'doc.write', params: { docId: LANDING, body: 'Second: the ferry was late again.', expectedRevision: start + 1 } }));
    const groupB2 = h.undo.groups()[h.undo.groups().length - 1]!.id;
    h.undoGroup(groupB2);
    expect(getBody(h.state, LANDING)).toBe('First: the ferry was early.');
    expect(getRevision(h.state, LANDING)).toBe(start + 3);

    h.run(cmd({ name: 'doc.write', params: { docId: LANDING, body: 'C: typed after the undo.', expectedRevision: start + 3 } }));
    const stale = execute(
      cmd({ name: 'doc.write', params: { docId: LANDING, body: 'D: written from a plan made against the second write.', expectedRevision: start + 2 } }),
      h.bus,
      h.registry,
    );
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error('unreachable');
    expect(stale.error.code).toBe('revision-conflict');
    expect(getBody(h.state, LANDING)).toBe('C: typed after the undo.');
    expect(getRevision(h.state, LANDING)).toBe(start + 4);
  });

  it('the snapshot is the PRE-mutation body — captured one line later and this fails', () => {
    // This is the test the family exists to have. A `restore` that writes the new
    // body (or nothing) satisfies §5's registration, the label, and the group —
    // and undoes to the wrong text. Only the string itself distinguishes them.
    const h = harness();
    h.run(cmd({ name: 'doc.write', params: { docId: LANDING, body: 'REWRITTEN' } }));
    const entry = h.entryOf(h.undo.groups()[0]!.id);
    expect(entry.kind).toBe('compensable');
    if (entry.kind !== 'compensable') throw new Error('unreachable');
    entry.restore();
    expect(getBody(h.state, LANDING)).toBe(LANDING_BODY);
    expect(getBody(h.state, LANDING)).not.toBe('REWRITTEN');
  });

  it('an undo of two writes in one group leaves the first body, not the second', () => {
    // §5: "one user gesture = one undo group", and compensations run in reverse
    // order. Two *agent* commands in one turn share a group; two user gestures
    // would each open their own, so the turn id is what makes this one group.
    // Each entry captured its own prior body, so undoing restores the state
    // before the *first* — the "restore to before this turn" promise.
    const h = harness();
    const first = h.run(
      cmd({
        name: 'doc.write',
        params: { docId: LANDING, body: 'FIRST' },
        issuedBy: 'agent',
        turnId: 'turn-1',
      }),
    );
    h.run(
      cmd({
        name: 'doc.write',
        params: { docId: LANDING, body: 'SECOND' },
        issuedBy: 'agent',
        turnId: 'turn-1',
      }),
    );
    expect(h.undo.groups()).toHaveLength(1);
    expect(h.undo.group(first.undoGroupId!)!.entries).toHaveLength(2);

    h.undoGroup(first.undoGroupId!);
    expect(getBody(h.state, LANDING)).toBe(LANDING_BODY);
  });

  it('captures the body each apply observed, not the one it was handed', () => {
    // `editor.insert`'s offsets are validated against the loaded body, so the
    // splice and the artifact are both computed from what was there. A capture
    // derived from `params` alone could not exist; disagreeing with the splice
    // is the failure.
    const h = harness();
    // Offset 3 in 'He counted…' is the space before 'counted'.
    h.run(cmd({ name: 'editor.insert', params: { docId: STORM, offset: 3, text: 'X' } }));
    expect(getBody(h.state, STORM)).toBe('He Xcounted the ships, and the ships counted him.');
    h.undoGroup(h.undo.groups()[0]!.id);
    expect(getBody(h.state, STORM)).toBe(STORM_BODY);
  });
});

describe('§9 — the two editor primitives splice, and their range arithmetic is theirs', () => {
  it('editor.insert at offset 0 and at the end both restore', () => {
    const h = harness();
    h.run(cmd({ name: 'editor.insert', params: { docId: STORM, offset: 0, text: 'Before. ' } }));
    expect(getBody(h.state, STORM)).toBe(`Before. ${STORM_BODY}`);
    h.undoGroup(h.undo.groups()[0]!.id);
    expect(getBody(h.state, STORM)).toBe(STORM_BODY);

    h.undo.endTurn('turn-2');
    const at = h.run(
      cmd({
        name: 'editor.insert',
        params: { docId: STORM, offset: STORM_BODY.length, text: ' After.' },
        turnId: 'turn-2',
      }),
    );
    expect(getBody(h.state, STORM)).toBe(`${STORM_BODY} After.`);
    h.undoGroup(at.undoGroupId!);
    expect(getBody(h.state, STORM)).toBe(STORM_BODY);
  });

  it('editor.replaceRange replaces exactly the range and restores the whole body', () => {
    const h = harness();
    // 'counted' occupies [3, 10) in 'He counted the ships…'.
    h.run(
      cmd({
        name: 'editor.replaceRange',
        params: { docId: STORM, range: { from: 3, to: 10 }, text: 'watched' },
      }),
    );
    expect(getBody(h.state, STORM)).toBe('He watched the ships, and the ships counted him.');
    h.undoGroup(h.undo.groups()[0]!.id);
    expect(getBody(h.state, STORM)).toBe(STORM_BODY);
  });

  it('an empty range is an insertion, and an empty replacement is a deletion', () => {
    // Both are the degenerate ends of `from ≤ to`, and both are the cases a
    // hand-written splice gets wrong by one index.
    const h = harness();
    h.run(
      cmd({
        name: 'editor.replaceRange',
        params: { docId: STORM, range: { from: 0, to: 0 }, text: 'A ' },
      }),
    );
    expect(getBody(h.state, STORM)).toBe(`A ${STORM_BODY}`);
    h.undoGroup(h.undo.groups()[0]!.id);

    h.undo.endTurn('turn-3');
    const del = h.run(
      cmd({
        name: 'editor.replaceRange',
        params: { docId: STORM, range: { from: 0, to: 3 }, text: '' },
        turnId: 'turn-3',
      }),
    );
    expect(getBody(h.state, STORM)).toBe(STORM_BODY.slice(3));
    h.undoGroup(del.undoGroupId!);
    expect(getBody(h.state, STORM)).toBe(STORM_BODY);
  });

  it('a write that changes nothing still registers a compensation', () => {
    // §5's registration is unconditional, and a "nothing changed, nothing to
    // register" optimisation would produce a dispatch the pipeline refuses at
    // step 5 with `registrationRefusal` — a command reporting a failure for work
    // it correctly declined to do. This is the interaction the decision makes
    // load-bearing, so it is asserted rather than assumed.
    const h = harness();
    const outcome = h.run(
      cmd({ name: 'doc.write', params: { docId: LANDING, body: LANDING_BODY } }),
    );
    expect(outcome.undoGroupId).toBeDefined();
    expect(h.entryOf(outcome.undoGroupId!).kind).toBe('compensable');
  });
});

describe('§5 + agent-harness §3 — notes are a captured string, and the divider is literal', () => {
  it('notes.set restores the prior notes, and an empty prior is restored as empty', () => {
    const h = harness();
    h.run(cmd({ name: 'notes.set', params: { nodeId: LANDING, notes: 'Second thoughts.' } }));
    expect(node(h.state, LANDING).notes).toBe('Second thoughts.');
    h.undoGroup(h.undo.groups()[0]!.id);
    // Empty is not the same as absent, and a restore that wrote `undefined`
    // would typecheck here and fail every reader downstream.
    expect(node(h.state, LANDING).notes).toBe('');
  });

  it('notes.append appends with the agent divider, and the undo removes the whole append', () => {
    const h = harness();
    node(h.state, LANDING).notes = 'First note.';
    h.run(cmd({ name: 'notes.append', params: { nodeId: LANDING, text: 'Second note.' } }));

    const appended = node(h.state, LANDING).notes;
    expect(appended).toContain(`— agent, ${TICK_DATE}`);
    expect(appended).toContain('Second note.');
    // A blank line, so the divider is its own Markdown block (ui-modules §2
    // renders it as a separator) rather than running into the previous paragraph.
    expect(appended).toBe(`First note.\n\n— agent, ${TICK_DATE}\nSecond note.`);

    h.undoGroup(h.undo.groups()[0]!.id);
    // The artifact is the whole prior string, so the restore is exact — it does
    // not have to know how much was appended.
    expect(node(h.state, LANDING).notes).toBe('First note.');
  });

  it('notes.append with divider: false appends bare, and empty notes get no leading blank', () => {
    const h = harness();
    h.run(
      cmd({ name: 'notes.append', params: { nodeId: LANDING, text: 'Bare.', divider: false } }),
    );
    expect(node(h.state, LANDING).notes).toBe('Bare.');
    h.undoGroup(h.undo.groups()[0]!.id);
    expect(node(h.state, LANDING).notes).toBe('');
  });

  it('a notes undo restores text, not a truncated body — the two are separate artifacts', () => {
    // notes and body are different fields on different objects, and a family
    // that captured one for the other would restore a document's text into the
    // inspector (or the reverse). One turn, two entries, both undone together.
    const h = harness();
    node(h.state, LANDING).notes = 'Keep me.';
    const first = h.run(
      cmd({
        name: 'notes.set',
        params: { nodeId: LANDING, notes: 'Changed.' },
        issuedBy: 'agent',
        turnId: 'turn-4',
      }),
    );
    h.run(
      cmd({
        name: 'doc.write',
        params: { docId: LANDING, body: 'New body.' },
        issuedBy: 'agent',
        turnId: 'turn-4',
      }),
    );
    expect(h.undo.group(first.undoGroupId!)!.entries).toHaveLength(2);

    h.undoGroup(first.undoGroupId!);
    expect(node(h.state, LANDING).notes).toBe('Keep me.');
    expect(getBody(h.state, LANDING)).toBe(LANDING_BODY);
  });
});

describe('§5.1 rule 7 — the snapshot lives in the runtime store, never the artifact', () => {
  it('a store binding receives the pre-mutation body, at the revision it was captured', async () => {
    const { store, close } = await openStore();
    try {
      const h = harness();
      // The sink is fire-and-forget by necessity (A2), so the test has to hold
      // the promise it returns — awaiting nothing would assert against a store
      // the write has not reached yet, and pass for the wrong reason.
      const writes: Promise<void>[] = [];
      const registry = createProjectCommandRegistry({
        clock,
        snapshots: (snapshot) => {
          const pending = writeBodySnapshot(store, snapshot);
          writes.push(pending);
          return pending;
        },
      });
      const undo = createUndoStore({ dispatch: (c) => execute(c, h.bus, registry) });
      const bus: BusContext<ProjectState> = {
        state: h.state,
        view: h.bus.view,
        read: () => h.state,
        undo,
        log: createActivityLog(),
        idempotency: createIdempotencyCache(),
        notify: () => {},
      };
      await writeProjectState(store, h.state, { now: OPENED });
      const revisionBefore = getRevision(h.state, LANDING);

      const outcome = execute(
        cmd({ name: 'doc.write', params: { docId: LANDING, body: 'Stored body.' } }),
        bus,
        registry,
      );
      expect(outcome.ok).toBe(true);
      expect(writes).toHaveLength(1);
      await Promise.all(writes);

      const rows = await readBodySnapshots(store, 'p_9XK2M4Q7RZ');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.body).toBe(LANDING_BODY);
      expect(rows[0]!.revision).toBe(revisionBefore);
      expect(rows[0]!.docId).toBe(LANDING);
      expect(rows[0]!.capturedAt).toBe(TICK);
      expect(rows[0]!.command).toBe('doc.write');
    } finally {
      close();
    }
  });

  it('the same body cannot be captured twice at the same revision — rule 4 as a key', async () => {
    const { store, close } = await openStore();
    try {
      const h = harness();
      await writeProjectState(store, h.state, { now: OPENED });
      const row = {
        projectId: 'p_9XK2M4Q7RZ',
        docId: LANDING,
        revision: 0,
        body: LANDING_BODY,
        capturedAt: TICK,
        command: 'doc.write',
      };
      await writeBodySnapshot(store, row);
      // §5.1 rule 4: a body unchanged since the last snapshot is not re-stored.
      // Here that is a constraint the store enforces rather than a check a
      // caller might forget, and the refusal names the document.
      await expect(writeBodySnapshot(store, { ...row, capturedAt: TICK + 1 })).rejects.toBeInstanceOf(
        SnapshotExistsError,
      );
      const rows = await readBodySnapshots(store, 'p_9XK2M4Q7RZ');
      expect(rows).toHaveLength(1);
      // The original capture is intact. This line is weaker than
      // it reads: `add` -> `put` leaves all 27 of these tests green, because the
      // in-transaction `get` in `writeBodySnapshot` refuses first — and
      // neutralising that `get` leaves exactly this one failing, because `add`
      // alone also refuses. Each mechanism hides the other, so this test pins
      // rule 4's *guarantee* and cannot attribute it to either.
      expect(rows[0]!.capturedAt).toBe(TICK);
    } finally {
      close();
    }
  });

  it('a capture for a document with NO row is accepted and persisted — a measured gap', async () => {
    // `writeBodySnapshot`'s doc comment claimed it *"refuses a capture for a
    // document with no row"*, and the opposite is true; this pins the measurement so the gap is a fact the suite carries
    // rather than a sentence a reader has to trust.
    //
    // **This is not a blessing.** The transaction spans `[SNAPSHOT_STORE]` alone,
    // so nothing here consults the documents store, and the function is exported
    // from the package. The bus path cannot reach it — `requireDocument` in
    // commands.ts throws first — so a retention or recovery caller is the only
    // one that can. Whether a snapshot naming no document deserves a refusal is
    // a separate decision; this test exists so that decision is made
    // deliberately, and it will fail loudly the day the check is added.
    const { store, close } = await openStore();
    try {
      const h = harness();
      await writeProjectState(store, h.state, { now: OPENED });
      // The fixture has no document with this id, and never had one.
      expect(nodeById(h.state, UNKNOWN)).toBeUndefined();

      await writeBodySnapshot(store, {
        projectId: 'p_9XK2M4Q7RZ',
        docId: UNKNOWN,
        revision: 0,
        body: 'a body for a document that does not exist',
        capturedAt: TICK,
        command: 'doc.write',
      });

      const rows = await readBodySnapshots(store, 'p_9XK2M4Q7RZ');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.docId).toBe(UNKNOWN);
    } finally {
      close();
    }
  });

  it('snapshots read back ordered by document then revision — the count passes nine', async () => {
    // The lesson applied to this key: a whole-key string comparison puts
    // revision 10 before revision 2, and the retention sweep reads this order
    // directly rather than sorting. Two documents, twelve revisions each, so the
    // test fails if the ordering is wrong at all past the ninth revision.
    const { store, close } = await openStore();
    try {
      const h = harness();
      await writeProjectState(store, h.state, { now: OPENED });
      for (const docId of [LANDING, STORM]) {
        for (let revision = 0; revision < 12; revision += 1) {
          await writeBodySnapshot(store, {
            projectId: 'p_9XK2M4Q7RZ',
            docId,
            revision,
            body: `body ${revision}`,
            capturedAt: TICK + revision,
            command: 'doc.write',
          });
        }
      }
      const rows = await readBodySnapshots(store, 'p_9XK2M4Q7RZ');
      expect(rows).toHaveLength(24);
      expect(rows.map((row) => row.revision)).toEqual(
        [...Array(12).keys(), ...Array(12).keys()],
      );
      expect(rows.map((row) => row.docId)).toEqual(
        [...Array(12).keys()].map(() => LANDING).concat([...Array(12).keys()].map(() => STORM)),
      );
    } finally {
      close();
    }
  });

  it('deleting a project takes its snapshots with it, in the same transaction', async () => {
    const { store, close } = await openStore();
    try {
      const h = harness();
      await writeProjectState(store, h.state, { now: OPENED });
      for (const docId of [LANDING, STORM]) {
        await writeBodySnapshot(store, {
          projectId: 'p_9XK2M4Q7RZ',
          docId,
          revision: 0,
          body: getBody(h.state, docId),
          capturedAt: TICK,
          command: 'doc.write',
        });
      }
      expect(await readBodySnapshots(store, 'p_9XK2M4Q7RZ')).toHaveLength(2);

      await deleteProject(store, 'p_9XK2M4Q7RZ');
      // §5.1 rule 6 by the other road: a surviving snapshot is a full copy of a
      // body the author deleted, which is the unbounded growth the rule exists
      // to prevent.
      expect(await readBodySnapshots(store, 'p_9XK2M4Q7RZ')).toEqual([]);
    } finally {
      close();
    }
  });

  it('a registry with NO binding is still fully reversible — the seam is not load-bearing', () => {
    // A family whose undo only worked with a store attached would be a family
    // whose correctness depends on a caller remembering to attach one. The
    // default binding is `synchronousSnapshotSink`, and this asserts the
    // consequence rather than the default.
    const h = harness();
    const registry = createProjectCommandRegistry({ clock });
    const undo = createUndoStore({ dispatch: (c) => execute(c, bus, registry) });
    const bus: BusContext<ProjectState> = {
      state: h.state,
      view: h.bus.view,
      read: () => h.state,
      undo,
      log: createActivityLog(),
      idempotency: createIdempotencyCache(),
      notify: () => {},
    };
    const result = execute(
      cmd({ name: 'doc.write', params: { docId: LANDING, body: 'Untracked.' } }),
      bus,
      registry,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const undone = undo.undo(result.value.undoGroupId!);
    expect(undone.ok).toBe(true);
    expect(getBody(h.state, LANDING)).toBe(LANDING_BODY);
  });

  it('a sink that throws does not fail the dispatch — the artifact is already captured', () => {
    // A2 means the sink is fire-and-forget, so a rejection cannot be reported to
    // the caller without also abandoning a write that already landed. The
    // in-memory artifact is what §5 requires; the durable row is retention.
    const h = harness();
    const registry = createProjectCommandRegistry({
      clock,
      snapshots: () => {
        throw new Error('the runtime store is gone');
      },
    });
    const bus: BusContext<ProjectState> = { ...h.bus, undo: createUndoStore() };
    const result = execute(
      cmd({ name: 'doc.write', params: { docId: LANDING, body: 'Still applied.' } }),
      bus,
      registry,
    );
    expect(result.ok).toBe(true);
    expect(getBody(h.state, LANDING)).toBe('Still applied.');
  });

  it('a sink that rejects is swallowed rather than surfacing as an unhandled rejection', async () => {
    const rejection = Promise.reject(new Error('transaction aborted'));
    const h = harness();
    const registry = createProjectCommandRegistry({
      clock,
      snapshots: () => rejection,
    });
    const bus: BusContext<ProjectState> = { ...h.bus, undo: createUndoStore() };
    const result = execute(
      cmd({ name: 'doc.write', params: { docId: LANDING, body: 'Applied.' } }),
      bus,
      registry,
    );
    expect(result.ok).toBe(true);
    // Attaching a handler is the behaviour under test: an unhandled rejection
    // would fail the run rather than a test.
    await expect(rejection).rejects.toThrow('transaction aborted');
  });
});

describe('§2 + §9 — refusals happen before any capture, and a refusal registers nothing', () => {
  it('an unknown docId is refused in validate, so no snapshot is taken and no group opens', () => {
    const h = harness();
    const result = execute(
      cmd({ name: 'doc.write', params: { docId: UNKNOWN, body: 'Nowhere.' } }),
      h.bus,
      h.registry,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('not-found');
    expect(h.snapshots).toEqual([]);
    expect(h.undo.groups()).toEqual([]);
  });

  it('a folder has no body, and the refusal names the type', () => {
    const h = harness();
    const result = execute(
      cmd({ name: 'doc.write', params: { docId: CHAPTER_ONE, body: 'x' } }),
      h.bus,
      h.registry,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.message).toContain('not a document');
    expect(h.snapshots).toEqual([]);
  });

  it('an out-of-range offset is refused before the splice — §2 validate-first', () => {
    const h = harness();
    const result = execute(
      cmd({ name: 'editor.insert', params: { docId: STORM, offset: 9_999, text: 'x' } }),
      h.bus,
      h.registry,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(getBody(h.state, STORM)).toBe(STORM_BODY);
    expect(h.snapshots).toEqual([]);
    expect(h.undo.groups()).toEqual([]);
  });

  it('a backwards range is refused, and the body is untouched', () => {
    const h = harness();
    const result = execute(
      cmd({
        name: 'editor.replaceRange',
        params: { docId: STORM, range: { from: 9, to: 2 }, text: 'x' },
      }),
      h.bus,
      h.registry,
    );
    expect(result.ok).toBe(false);
    expect(getBody(h.state, STORM)).toBe(STORM_BODY);
    expect(h.snapshots).toEqual([]);
  });
});

describe('the registration refusal is never reached, because the captures are correct', () => {
  const FIVE = [
    { name: 'notes.set', params: { nodeId: LANDING, notes: 'n' } },
    { name: 'notes.append', params: { nodeId: LANDING, text: 'n' } },
    { name: 'doc.write', params: { docId: LANDING, body: 'b' } },
    { name: 'editor.insert', params: { docId: LANDING, offset: 0, text: 'b' } },
    { name: 'editor.replaceRange', params: { docId: LANDING, range: { from: 0, to: 1 }, text: 'b' } },
  ] as const;

  it('all five succeed through execute() and register a compensable entry', () => {
    // The assertion is `ok`, because a `registrationRefusal` IS an `internal`
    // error: if any of these five handed the bus nothing, or the wrong kind,
    // this fails with the refusal's own message naming the command.
    for (const partial of FIVE) {
      const h = harness();
      const result = execute(cmd(partial), h.bus, h.registry);
      expect(result.ok, partial.name).toBe(true);
      if (!result.ok) continue;
      const entry = h.entryOf(result.value.undoGroupId!);
      expect(entry.kind, partial.name).toBe('compensable');
      expect(entry.name, partial.name).toBe(partial.name);
    }
  });

  it('a restore that captured the NEW body instead of the old one is distinguishable', () => {
    // The teeth of the whole suite, made explicit. §5 says the artifact is the
    // body *"before any text mutation"*, and capturing after produces a restore
    // that changes nothing — indistinguishable from a working undo unless the
    // assertions read the text. So this builds the wrong capture deliberately
    // and asserts the real one does not produce it.
    const h = harness();
    h.run(cmd({ name: 'doc.write', params: { docId: LANDING, body: 'AFTER' } }));
    const entry = h.entryOf(h.undo.groups()[0]!.id);
    if (entry.kind !== 'compensable') throw new Error('unreachable');

    const wrong: UndoEntry = { ...entry, restore: () => setBody(h.state, LANDING, 'AFTER') };
    wrong.restore();
    // What a capture-one-line-too-late undo would leave behind.
    expect(getBody(h.state, LANDING)).toBe('AFTER');

    // The real artifact, on the same document, lands the prior body. If this
    // ever equalled 'AFTER', every restore in this file would be cosmetic.
    entry.restore();
    expect(getBody(h.state, LANDING)).toBe(LANDING_BODY);
    expect(getBody(h.state, LANDING)).not.toBe('AFTER');
  });

  it('the bus registry still refuses the five, and without an exporter the store registry implements eighteen of the twenty', () => {
    // Both halves of the bus/store registry split, extended to these applies. A bus registry
    // that quietly started implementing a name, and a store registry that quietly
    // stopped, each fail here.
    for (const partial of FIVE) {
      const refused = resolveCommand(partial.name);
      expect(refused.ok, partial.name).toBe(false);
      if (!refused.ok) {
        expect(refused.error.message, partial.name).toContain('has no implementation in this build');
      }
      expect(COMMAND_REGISTRY[partial.name].apply, partial.name).toBeUndefined();
    }
    const registry = createProjectCommandRegistry({ clock });
    const implemented = Object.values(registry).filter((entry) => entry.apply !== undefined);
    // 5 `view.*` (the three + `view.setExpanded` and `view.setCorkboardScope`)
    // + 6 `inverse` (including `binder.create`) + 5 `compensable` +
    // `codex.upsert` and `project.deleteNode`, and the two coherence applies (inverse
    // undo, coherence.md §7.1). What is left of the twenty-two is the two export names,
    // which register only with an injected exporter — and `commands.test.ts` pins the same
    // count from the other side, so a slice that implemented the wrong name cannot pass by
    // adjusting one of them.
    // Project export adds six applies that need no injected port (project.rename, project.setMetadata, vocabulary.upsert,
    // vocabulary.remove, recipe.save, recipe.delete): 20 + 6 = 26. project.importAsset needs the asset port.
    // Saved filters and goals add four implemented names (binder.saveFilter, binder.deleteFilter, project.saveGoal,
    // project.deleteGoal): 26 + 4 = 30. The run history adds the run discard (compensable undo, coherence.md §7.1): 30 + 1 = 31.
    // The script imports add the two imports and the container settings, all compensable and needing no port: 31 + 3 = 34.
    // The skill commands add `skill.write`, `skill.delete` and `skill.setEnabled` (`skill.import` needs the host's staging): 34 + 3 = 37.
    // The three knowledge commands are compensable and need no port: 37 + 3 = 40.
    // The agent's files add `project.setInstructions`, `memory.write` and `memory.forget`: 40 + 3 = 43.
    // The macros add `macro.save` and `macro.delete`: 43 + 2 = 45.
    // The hooks add `hook.save` and `hook.delete`: 45 + 2 = 47.
    // The picture registry adds `asset.setMeta` (the two imports need the asset port): 47 + 1 + 2 (`script.setShowMeta`, `script.setEpisodeMeta`) = 50.
    // The writer's codex batch import adds `codex.importBatch`: 50 + 1 = 51.
    expect(implemented).toHaveLength(51);
  });

  it('the sink is not consulted for notes, and a notes undo needs no store', () => {
    // Notes live in the manifest, which `commitProject` already persists whole.
    // §5.1's ladder is a *body* snapshot ladder (rule 1: "full body snapshots"),
    // so a notes write must not be writing rows into it — a claim about the
    // shape of what the applies touch, asserted rather than assumed.
    const h = harness();
    h.run(cmd({ name: 'notes.set', params: { nodeId: LANDING, notes: 'x' } }));
    h.run(cmd({ name: 'notes.append', params: { nodeId: LANDING, text: 'y' } }));
    expect(h.snapshots).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

async function openStore(): Promise<{ store: RuntimeStore; close: () => void }> {
  const factory = new MemoryIndexedDb();
  const store = await openRuntimeStore(factory, 'caotang-compensable-test');
  return { store, close: () => store.close() };
}
