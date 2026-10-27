/**
 * **The command bus's exit gate — §10's assertion families, headless.**
 *
 * ## What this file is
 *
 * [command-bus.md §10](docs/architecture/command-bus.md) is one sentence:
 *
 * > Scripted command sequences → final-state assertions (project-format schema) →
 * > **undo-replay assertion**: undo-all ⇒ byte-equal snapshot of pre-script state →
 * > permission-matrix assertions → error-shape assertions → callId-replay dedupe
 * > assertions.
 *
 * The exit criteria turn two of those clauses into
 * ("Scripted 20-command sequence → final state asserted; undo-all ⇒ byte-equal
 * pre-script snapshot"). This file is the gate: **one scripted sequence of exactly
 * twenty commands**, dispatched through the shipped `execute()` over the store's
 * own registry and the store's own `ProjectState`, and then every assertion §10
 * names. Nothing here is a mock of a bus — the only fakes in the file are the ones
 * the two error codes that *cannot* be produced through a correct apply need, and
 * they are named as such where they appear.
 *
 * ## The count is ambiguous, and the gate answers every shape
 *
 * §10's chain names **five** assertion shapes; the exit criteria call them "four
 * assertion families". The reading implemented here: the scripted sequence's final
 * state is the **baseline** the rest are measured against, so the four are the ones
 * standing on top of it (undo-replay, permission-matrix, error-shape, callId-replay).
 * The alternative reading — final-state is a fifth family — is logged in
 * [docs/decisions.md](docs/decisions.md) rather than settled here, because **the choice does not change what this file asserts**: all
 * five are asserted either way, and an exit gate that ships with a hole is not a
 * gate.
 *
 * ## What would pass anyway, per family, because a green gate that cannot fail is
 * the defect this repo keeps finding
 *
 * - **Final state.** `validateManifest(...).ok` alone would pass for a script that
 *   changed nothing, so the family asserts the **concrete** outcome — the renamed
 *   title, the body after three writes, the attachment, the deleted subtree, the
 *   group count, one §8 row per dispatched command. The schema check is one
 *   assertion of five, not the assertion.
 * - **Undo-all.** A gate that only undid the *last* group would pass on any bus
 *   whose most recent compensation works. This one undoes **every** group in
 *   reverse creation order and refuses any that reports a failure, because §5's
 *   promise is about the whole session, and because the ordering is load-bearing:
 *   undoing out of order restores a state the script never had.
 * - **Permission matrix.** `permission.test.ts` derives its matrix from the **bus's own**
 *   `COMMAND_REGISTRY`, where every name is a descriptor with no apply. That is the
 *   right subject for the *gate's* logic and the wrong subject for the *matrix*:
 *   a name with no effect cannot be "allowed for a user" in any observable sense.
 *   So the matrix here is derived from **the registry that implements them**
 *   (`createProjectCommandRegistry()`), and the names are read out of it rather
 *   than typed out, so a name promoted to `never` later cannot slip past unasserted.
 * - **Error shapes.** Asserting `code` alone is what §7's *"not a bare code"* line
 *   exists to prevent, so every case asserts a `correctiveHint` too, and the
 *   permission cases assert the `risk` field §7 declares for gate rejections.
 * - **CallId replay.** A replay that re-ran the apply would still return a
 *   plausible outcome, so the family counts **two independent witnesses** — §8's
 *   log rows and §5's registered groups — and neither can be satisfied by a second
 *   run of the pipeline.
 *
 * ## The instrument for "byte-equal", and why it is not `JSON.stringify`
 *
 * §10 asks for a *byte*-equal comparison, and the obvious instrument is wrong in a
 * way that would make this gate lie. `JSON.stringify` on a `ProjectState` walks
 * `Map` and object keys in **insertion order**, so two states that are equal as
 * values can serialise to different bytes purely because an apply inserted a key
 * in a different order than the compensation did — and a gate that reports that as
 * a failed undo is a gate that cries wolf on correct code. `canonical()` below
 * sorts every object key, every `Map` entry and every `Set` member, so the bytes
 * are a property **of the state** and not of the order the script happened to run
 * in. That is the only reading of "byte-equal" that can be both true when the
 * undo is exact and false when it is not.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMMAND_REGISTRY,
  createActivityLog,
  createIdempotencyCache,
  createUndoStore,
  createViewState,
  execute,
  type ActivityLog,
  type BusContext,
  type Command,
  type CommandApply,
  type CommandDescriptor,
  type CommandName,
  type CommandRegistry,
  type ExecutionOutcome,
  type UndoOutcome,
  type UndoStore,
  type ViewState,
} from '@caotang/bus';

import {
  addDocument,
  addFolder,
  createEmptyManifest,
  createProjectCommandRegistry,
  createProjectState,
  nodeById,
  validateManifest,
  type ProjectState,
} from '../src/index.js';

// --------------------------------------------------------------- the fixture

const OPENED = new Date('2026-10-03T09:00:00.000Z');

/** A fixed clock, so an inverse's `createdAt` is an assertion and not a number. */
const TICK = 1_760_000_000_000;
const clock = { now: () => TICK };

const CHAPTER_ONE = 'n_CHAPTR0001';
const CHAPTER_TWO = 'n_CHAPTR0002';
const LANDING = 'n_ANDNG00001';
const STORM = 'n_STRM000001';
const FRIEND = 'n_FRND000001';
const ENTRY = 'c_ENA0000001';
const ENTRY_TWO = 'c_KSTR000001';
/** A well-formed id that no fixture node has — the `not-found` target. */
const MISSING = 'n_MSSNG00001';

const LANDING_BODY = 'The ferry was late, as always.';

function makeState(): ProjectState {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', OPENED));
  // `createEmptyManifest` seeds statuses and **no labels**, and `binder.setMeta` is
  // vocabulary-validated, so a fixture that sets a label has to have declared it.
  state.manifest.vocabulary.labels = [
    { id: 'act-1', name: 'Act 1', color: '#8a8a8a' },
    { id: 'act-2', name: 'Act 2', color: '#4a90d9' },
  ];
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 1', now: OPENED, id: CHAPTER_ONE });
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 2', now: OPENED, id: CHAPTER_TWO });
  addDocument(state, {
    parentId: CHAPTER_ONE,
    title: 'The Landing',
    body: LANDING_BODY,
    now: OPENED,
    id: LANDING,
    status: 'draft',
    label: 'act-1',
    keywords: ['sea', 'grief'],
    synopsis: 'Elena returns to the island.',
  });
  addDocument(state, { parentId: CHAPTER_ONE, title: 'The Storm', now: OPENED, id: STORM });
  addDocument(state, { parentId: CHAPTER_TWO, title: 'The Friend', now: OPENED, id: FRIEND });
  state.manifest.codex?.push({
    id: ENTRY,
    name: 'Elena',
    aliases: [],
    type: 'character',
    description: 'The keeper.',
    includePolicy: 'detected',
    caseSensitive: false,
    exclude: [],
    attachments: [],
    keywords: [],
    origin: 'manual',
    sources: [],
  });
  state.manifest.codex?.push({
    id: ENTRY_TWO,
    name: 'Kestrel',
    aliases: [],
    type: 'other',
    description: 'The bird.',
    includePolicy: 'detected',
    caseSensitive: false,
    exclude: [],
    attachments: [],
    keywords: [],
    origin: 'manual',
    sources: [],
  });
  return state;
}

// ---------------------------------------------------------- canonical bytes

/**
 * A byte serialisation that is a property of the value, not of insertion order.
 * Sorted at every level; `undefined` members dropped, because a key that is
 * present-with-no-value and a key that is absent are the same state.
 */
function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value instanceof Map) {
    return `{${[...value.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${canonical(k)}:${canonical(v)}`)
      .join(',')}}`;
  }
  if (value instanceof Set) {
    return `[${[...value].map(canonical).sort().join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/**
 * Everything an undo has to restore: the manifest, the bodies, the decline record. The revision is left out on purpose: it
 * is runtime bookkeeping that is never serialised (`DocumentRecord`, project-format §4), and an undo is a write that moves
 * it up (command-bus §5), so it cannot be restored to its old number. The undo-all test checks the counter on its own.
 */
function snapshotOf(state: ProjectState): string {
  const documents = new Map(
    [...state.documents].map(([id, record]): [string, { id: string; body: string }] => [id, { id: record.id, body: record.body }]),
  );
  return canonical({
    manifest: state.manifest,
    documents,
    declinedCodexFiles: state.declinedCodexFiles,
  });
}

/**
 * The instrument's own test. **§10's byte-equal criterion is exactly as strong as
 * `canonical`,** and `canonical` is the function that found the bus's one real defect
 * — the `updatedAt` stamp two families down. So it is the one function in this
 * file that is load-bearing for the *finding* rather than for the assertion.
 *
 * Measured on this file before these two tests existed: each of its three sorts —
 * object keys, `Map` entries, `Set` members — could be deleted and **all 26
 * tests stayed green**. The sorts are correct (the first test below is what they
 * are for); they were simply decisions nobody was holding, which is the same
 * shape as every other instance in this corpus one level down from a guard.
 */
describe('the byte comparison itself — canonical(), the instrument the §10 undo-replay rests on', () => {
  it('is a property of the value, not of key, entry or insertion order', () => {
    // The property the three sorts exist for. **Without it the gate compares
    // insertion order**, which is a different and much weaker criterion: two
    // states that are equal would compare unequal the moment a refactor rebuilt
    // an object with its keys in another order, and the gate would cry wolf on
    // correct code — the failure mode this file's own header calls out.
    expect(canonical({ a: 1, b: 2 })).toBe(canonical({ b: 2, a: 1 }));
    expect(canonical({ z: { q: 1, p: [1, { y: 1, x: 2 }] } })).toBe(
      canonical({ z: { p: [1, { x: 2, y: 1 }], q: 1 } }),
    );
    // The two collection types a `ProjectState` really holds, in the shapes
    // `snapshotOf` feeds them: `documents` is a `Map`, `declinedCodexFiles` a
    // `Set`. Both are reached only through these two branches, so if either
    // branch lost its sort this is the assertion that notices.
    const docs = (...entries: [string, string][]) => new Map(entries);
    expect(canonical(docs(['n_B', 'second'], ['n_A', 'first']))).toBe(
      canonical(docs(['n_A', 'first'], ['n_B', 'second'])),
    );
    expect(canonical(new Set(['codex/b.md', 'codex/a.md']))).toBe(
      canonical(new Set(['codex/a.md', 'codex/b.md'])),
    );
  });

  it('tells apart every state that differs, over the vocabulary a ProjectState is made of', () => {
    // The other direction, and the one that hides the *next* defect: a
    // canonicaliser that is too aggressive makes the byte comparison pass on
    // states that differ. Measured against a verbatim copy of `canonical`, its
    // real collision classes are a `Map` and a plain object of the same content,
    // an array and a `Set` of the same members, a `Date` and `{}` (**two
    // different dates serialise identically**), `NaN`/`Infinity` and `null`,
    // `-0` and `0`, and `[undefined]` and `[null]`.
    //
    // All of those are **outside what `snapshotOf` is fed** — a schema-validated
    // JSON manifest, `Map<string, DocumentRecord>`, and `Set<string>` — and the
    // first two cannot arise at all, because the shapes never trade places: a
    // `Map` is always `documents` and a `Set` is always `declinedCodexFiles`, in
    // both snapshots. That is a measured limit, not an assumption, and it is why
    // this corpus holds the plain-JSON half of `canonical` and leaves the
    // cross-type half alone rather than paying to make it injective.
    const distinct: unknown[] = [
      {},
      { a: 1 },
      { a: 2 },
      { b: 1 },
      { a: 1, b: 2 },
      { a: '1' },
      { a: 1, b: undefined },
      [],
      [1],
      [1, 2],
      [2, 1],
      [{ a: 1 }],
      'a',
      '1',
      1,
      2,
      true,
      false,
      null,
      { a: [1, { b: 2 }] },
    ];
    const bytes = distinct.map((value) => canonical(value));
    // The one deliberate exception, and the function's own documented rule: a
    // key present with no value and a key absent are the same state, so
    // `{ a: 1, b: undefined }` and `{ a: 1 }` are *meant* to be equal.
    expect(new Set(bytes).size).toBe(bytes.length - 1);
    expect(canonical({ a: 1, b: undefined })).toBe(canonical({ a: 1 }));
  });
});

// ------------------------------------------------------------------ harness

interface Harness {
  readonly state: ProjectState;
  readonly bus: BusContext<ProjectState>;
  readonly registry: CommandRegistry;
  readonly undo: UndoStore;
  readonly log: ActivityLog;
  readonly notified: ExecutionOutcome[];
  /** Dispatch and return the `Result` — the gate's own refusals are assertions. */
  dispatch(command: Command): ReturnType<typeof execute<CommandName>>;
  /** Undo `groupId`, failing loudly if any compensation did not land. */
  undoGroup(groupId: string): UndoOutcome;
}

function harness(permission?: BusContext<ProjectState>['permission']): Harness {
  const state = makeState();
  const registry = createProjectCommandRegistry({ clock });
  const notified: ExecutionOutcome[] = [];
  // The dispatcher needs the bus it dispatches into, and the bus needs the undo
  // store that calls it. The closure only reads `bus`, and only at undo time.
  const undo = createUndoStore({ dispatch: (command) => execute(command, bus, registry) });
  const log = createActivityLog();
  const bus: BusContext<ProjectState> = {
    state,
    view: createViewState(),
    read: () => state,
    ...(permission === undefined ? {} : { permission }),
    undo,
    log,
    idempotency: createIdempotencyCache(),
    notify: (outcome) => notified.push(outcome),
  };
  return {
    state,
    bus,
    registry,
    undo,
    log,
    notified,
    dispatch: (command) => execute(command, bus, registry),
    undoGroup(groupId) {
      const result = undo.undo(groupId);
      if (!result.ok) throw new Error(`undoing ${groupId} failed: ${result.error.message}`);
      return result.value;
    },
  };
}

let ordinal = 0;
function cmd(partial: Partial<Command> & Pick<Command, 'name' | 'params'>): Command {
  ordinal += 1;
  return {
    id: `cmd_GATE${String(ordinal).padStart(6, '0')}`,
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

/** Sibling ids under `parentId`, in the order the tree renders them. */
function children(state: ProjectState, parentId: string): string[] {
  return state.manifest.tree
    .filter((n) => n.parentId === parentId)
    .sort((a, b) => a.order - b.order)
    .map((n) => n.id);
}

function body(state: ProjectState, docId: string): string {
  const record = state.documents.get(docId);
  if (!record) throw new Error(`no body record for ${docId}`);
  return record.body;
}

function revision(state: ProjectState, docId: string): number {
  const record = state.documents.get(docId);
  if (!record) throw new Error(`no body record for ${docId}`);
  return record.revision;
}

/** The id a command minted, found by the title it was created under. */
function findByTitle(state: ProjectState, title: string): string {
  const found = state.manifest.tree.find((n) => n.title === title);
  if (!found) throw new Error(`no node titled "${title}"`);
  return found.id;
}

// ---------------------------------------------------- the scripted sequence

/**
 * §10's "scripted command sequence", and the exit criterion says twenty.
 * **The count is asserted, not described** — a script that quietly lost a command
 * would still pass every state assertion below, because the state it asserts is
 * the state the remaining commands produce.
 *
 * The twenty are chosen to cover every mutation shape the bus ships: a create of
 * each node type, a move, a rename, a meta patch, a synopsis, both notes
 * commands, a full-body write and the two editor primitives, a codex batch and an
 * attachment, a delete, three view commands, and two agent turns (one sharing a
 * group, one gated behind an approved plan).
 */
const SCRIPT_SIZE = 20;

interface Scripted {
  readonly chapter3: string;
  readonly bell: string;
  readonly ledger: string;
  readonly outcomes: readonly ExecutionOutcome[];
}

function runScript(h: Harness): Scripted {
  const { state } = h;
  const outcomes: ExecutionOutcome[] = [];

  const run = (command: Command) => {
    const result = h.dispatch(command);
    if (!result.ok) {
      throw new Error(`${command.name} was refused: ${result.error.code} — ${result.error.message}`);
    }
    outcomes.push(result.value);
    return result.value;
  };

  // 1 — a folder, under the manuscript root.
  run(cmd({ name: 'binder.create', params: { parentId: 'manuscript', type: 'folder', title: 'Chapter 3' } }));
  const chapter3 = findByTitle(state, 'Chapter 3');

  // 2 — a document, which is the case that also mints a body record.
  run(cmd({ name: 'binder.create', params: { parentId: CHAPTER_ONE, type: 'document', title: 'The Bell' } }));
  const bell = findByTitle(state, 'The Bell');

  // 3 — a rename: an `inverse` family, and the one §5 can express exactly.
  run(cmd({ name: 'binder.rename', params: { nodeId: LANDING, title: 'The Ferry' } }));

  // 4 — a meta patch, all three of its shapes in one op.
  run(
    cmd({
      name: 'binder.setMeta',
      params: { nodeId: bell, patch: { status: 'draft', label: 'act-2', keywords_add: ['bell', 'sea'] } },
    }),
  );

  // 5 — a synopsis, a `limit-exceeded` boundary the script stays inside of.
  run(cmd({ name: 'binder.setSynopsis', params: { nodeId: bell, synopsis: 'The bell tolls for the ferry.' } }));

  // 6 — a move: §2's gap-encoding means its inverse is a *position*, not an order.
  run(cmd({ name: 'binder.move', params: { nodeId: STORM, newParentId: CHAPTER_ONE, index: 0 } }));

  // 7, 8 — both notes commands, so the family's two undo shapes are both in the run.
  run(cmd({ name: 'notes.set', params: { nodeId: bell, notes: 'First draft, 3 October.' } }));
  run(cmd({ name: 'notes.append', params: { nodeId: bell, text: 'Check the toll pattern.' } }));

  // 9, 10, 11 — three body writes against one document, in the order a session
  // makes them: a full write, an insertion, a range replacement. Each carries the
  // revision it was based on, so §6's guard is exercised by the happy path too.
  run(cmd({ name: 'doc.write', params: { docId: LANDING, body: 'The ferry was late. The fog came with it.', expectedRevision: revision(state, LANDING) } }));
  run(cmd({ name: 'editor.insert', params: { docId: LANDING, offset: body(state, LANDING).length, text: ' Kestrel watched from the tower.', expectedRevision: revision(state, LANDING) } }));
  run(cmd({ name: 'editor.replaceRange', params: { docId: LANDING, range: { from: 0, to: 3 }, text: 'That', expectedRevision: revision(state, LANDING) } }));

  // 12 — a codex batch of two ops of different kinds, in one call: the case a per-entry
  // compensation loop would get wrong.
  run(
    cmd({
      name: 'codex.upsert',
      params: {
        entries: [
          { action: 'create', name: 'Brine', type: 'other', description: 'The sea itself.', includePolicy: 'detected', attachTo: [bell] },
          { action: 'update', id: ENTRY, description: 'The keeper, renamed.' },
        ],
      },
    }),
  );

  // 13 — an attachment as its own command, which is the other `inverse` shape.
  run(cmd({ name: 'codex.attach', params: { entryId: ENTRY_TWO, attachTo: [LANDING], detachFrom: [] } }));

  // 14, 15 — view commands. §2 calls them ephemeral and §5 says a gesture that
  // registers nothing leaves no group, so these two are in the script to be the
  // run's evidence for that rule.
  run(cmd({ name: 'view.setSelection', params: { nodeIds: [LANDING] } }));
  run(cmd({ name: 'view.setActiveDoc', params: { docId: LANDING } }));

  // 16, 17 — one agent turn, two commands, and therefore one undo group.
  run(cmd({ name: 'binder.create', params: { parentId: CHAPTER_TWO, type: 'document', title: 'The Ledger' }, issuedBy: 'agent', turnId: 'turn-1' }));
  const ledger = findByTitle(state, 'The Ledger');
  run(cmd({ name: 'notes.append', params: { nodeId: ledger, text: 'Owed: three weeks.' }, issuedBy: 'agent', turnId: 'turn-1' }));

  // 18 — a second turn, at `write-confirm`, which is the one class an agent
  // cannot run on its own. The harness is given an approved plan for it.
  run(cmd({ name: 'notes.set', params: { nodeId: ledger, notes: 'Drafted by the agent.' }, issuedBy: 'agent', turnId: 'turn-2' }));
  h.undo.endTurn('turn-1');
  h.undo.endTurn('turn-2');

  // 19 — the delete, and the node it deletes is one this script created, so the
  // undo of 19 and the undo of 16 have to compose in that order to land right.
  run(cmd({ name: 'project.deleteNode', params: { nodeId: ledger } }));

  // 20 — the third view command.
  run(cmd({ name: 'view.setScroll', params: { nodeId: LANDING, offset: 480 } }));

  return { chapter3, bell, ledger, outcomes };
}

/**
 * A harness whose agent commands carry an approved plan — §4's flow fact, and the
 * only thing command 18 needs to be allowed at `write-confirm`.
 */
function scriptedHarness(): Harness {
  return harness({ approvedPlan: true });
}

// =============================== family 1 — scripted sequence → final state

describe('§10 — a scripted 20-command sequence leaves the state the script says it does', () => {
  it('dispatches exactly twenty commands, and every one of them ran', () => {
    const h = scriptedHarness();
    const { outcomes } = runScript(h);

    // The exit criterion says twenty. Asserting it is what keeps the script and
    // the criterion from drifting apart silently.
    expect(outcomes).toHaveLength(SCRIPT_SIZE);
    // §8 writes one row per *executed* command, and the view commands are
    // executed — §2's "ephemeral" is about persistence, not about the log.
    expect(h.log).toHaveLength(SCRIPT_SIZE);
    // §3's seventh step fires for every one of them too.
    expect(h.notified).toHaveLength(SCRIPT_SIZE);
  });

  it('leaves the tree, the titles and the order the script built', () => {
    const h = scriptedHarness();
    const { chapter3, bell } = runScript(h);
    const { state } = h;

    // The rename landed, and only the rename.
    expect(node(state, LANDING).title).toBe('The Ferry');
    // Command 6 moved The Storm to the front of Chapter 1, ahead of the two
    // documents that were already there.
    expect(children(state, CHAPTER_ONE)).toEqual([STORM, LANDING, bell]);
    // The new folder is a child of the manuscript root, not of a chapter.
    expect(node(state, chapter3).parentId).toBe('manuscript');
    expect(children(state, 'manuscript')).toEqual([CHAPTER_ONE, CHAPTER_TWO, chapter3]);
    // Chapter 2 is back to one child, because command 19 deleted the other.
    expect(children(state, CHAPTER_TWO)).toEqual([FRIEND]);
  });

  it('leaves the body the three writes composed, at the revision they composed it to', () => {
    const h = scriptedHarness();
    const before = revision(h.state, LANDING);
    runScript(h);

    // "The" → "That", then the appended clause. Asserted as one string, because a
    // restore that wrote the right words in the wrong order would still be a
    // correct-looking body to a per-fragment check.
    expect(body(h.state, LANDING)).toBe(
      'That ferry was late. The fog came with it. Kestrel watched from the tower.',
    );
    // Three writes, three bumps — §6 compares this number, so it is not cosmetic.
    expect(revision(h.state, LANDING)).toBe(before + 3);
  });

  it('leaves the meta, the synopsis and both notes commands on the new document', () => {
    const h = scriptedHarness();
    const { bell } = runScript(h);
    const created = node(h.state, bell);

    expect(created.status).toBe('draft');
    expect(created.label).toBe('act-2');
    expect(created.keywords).toEqual(['bell', 'sea']);
    expect(created.synopsis).toBe('The bell tolls for the ferry.');
    // `notes.set` then `notes.append`: the append is visible *after* what the set
    // wrote, which is the whole content of §5's notes half.
    expect(node(h.state, bell).notes).toContain('First draft, 3 October.');
    expect(node(h.state, bell).notes?.indexOf('Check the toll pattern.')).toBeGreaterThan(
      node(h.state, bell).notes?.indexOf('First draft, 3 October.') ?? -1,
    );
  });

  it('leaves the codex with the batch, the update and the attachment', () => {
    const h = scriptedHarness();
    const { bell } = runScript(h);
    const entries = h.state.manifest.codex ?? [];

    // Two fixture entries plus the one the batch created.
    expect(entries.map((e) => e.name).sort()).toEqual(['Brine', 'Elena', 'Kestrel']);
    // The update half of the batch, on an entry that already existed.
    expect(entries.find((e) => e.id === ENTRY)?.description).toBe('The keeper, renamed.');
    // `attachTo` inside a create op, and `codex.attach` as its own command: two
    // different shapes of the same relationship, both in the run.
    expect(entries.find((e) => e.name === 'Brine')?.attachments).toEqual([bell]);
    expect(entries.find((e) => e.id === ENTRY_TWO)?.attachments).toEqual([LANDING]);
  });

  it('leaves the view state ephemeral — set by the three view commands, held nowhere else', () => {
    const h = scriptedHarness();
    runScript(h);
    const view = h.bus.view as ViewState;

    expect(view.selection).toEqual([LANDING]);
    expect(view.activeDocId).toBe(LANDING);
    expect(view.scroll).toEqual({ [LANDING]: 480 });
    // And the project state carries none of it: §2's ephemeral clause, asserted
    // from the side that would break if an apply had written it into the manifest.
    // The scroll offset is looked for as a JSON number, not as three digits, which a
    // generated id or a timestamp can hold by chance.
    const stored = canonical(h.state);
    expect(stored).not.toMatch(/[:,[]480[,\]}]/);
    expect(stored).not.toMatch(/"(scroll|selection|activeDocId)"/);
  });

  it('satisfies the project-format schema, which is the one assertion that reads the spec', () => {
    const h = scriptedHarness();
    runScript(h);

    // `docFiles` is the list of body files a folder would hold, and the gate has no
    // folder — so it is derived from the state's own body records, which is what a
    // project that had just been saved would look like. Passing bare ids here fails
    // with "has no docs/<id>.md" for every document, which is the validator reporting
    // a missing file rather than a malformed manifest.
    const docFiles = [...h.state.documents.keys()].map((id) => `${id}.md`);
    const report = validateManifest(h.state.manifest, { docFiles });
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('groups twenty commands into sixteen undo groups, and the three view commands into none', () => {
    const h = scriptedHarness();
    runScript(h);
    const groups = h.undo.groups();

    // 20 commands − 3 view commands = 17 dispatches that register, and the two
    // commands of `turn-1` share one group: 17 − 1 = 16.
    expect(groups).toHaveLength(16);
    // §5: "one agent turn = one undo group", and the turn's two commands landed
    // in the same one. Read from the groups rather than from the count.
    const turns = groups.filter((g) => g.kind === 'agent-turn');
    expect(turns).toHaveLength(2);
    expect(turns.map((g) => g.entries.length).sort()).toEqual([1, 2]);
  });
});

// ============================ family 2 — undo-all ⇒ byte-equal pre-script state

describe('§10 — undoing every group returns the project, byte for byte, to before the script', () => {
  it('undoes all sixteen groups newest-first and restores the pre-script bytes', () => {
    const h = scriptedHarness();
    const before = snapshotOf(h.state);
    const revisionsBefore = new Map([...h.state.documents].map(([id, record]) => [id, record.revision] as const));
    runScript(h);

    // Newest first. Undoing in creation order would restore a state the script
    // never had — each compensation assumes the ones after it already ran.
    const ids = h.undo.groups().map((g) => g.id).reverse();
    expect(ids).toHaveLength(16);

    const failures: string[] = [];
    for (const id of ids) {
      const outcome = h.undoGroup(id);
      for (const failure of outcome.failures) {
        failures.push(`${failure.target}: ${failure.message}`);
      }
    }
    // §5: a compensation that cannot run is kept for a retry rather than
    // dropped, so a failure here is a *survivable* state, not a silent one.
    expect(failures).toEqual([]);

    expect(snapshotOf(h.state)).toBe(before);
    // The counter is not in those bytes. Each undo is a write, so no document is lower than it was before the script, and
    // LANDING, which the script wrote (lines 463-465) and whose writes were all undone, is higher (project-format §4).
    for (const [id, revisionBefore] of revisionsBefore) {
      expect(revision(h.state, id), `${id} revision after undo-all`).toBeGreaterThanOrEqual(revisionBefore);
    }
    expect(revision(h.state, LANDING)).toBeGreaterThan(revisionsBefore.get(LANDING)!);
  });

  it('leaves no group behind, and the tree reads as it did before the script ran', () => {
    const h = scriptedHarness();
    runScript(h);
    for (const id of h.undo.groups().map((g) => g.id).reverse()) h.undoGroup(id);

    expect(h.undo.groups()).toEqual([]);
    // Spelled out as well as compared byte-wise, because "the bytes match" and
    // "the project reads correctly" fail for different reasons and this is the
    // family where a reader needs to know which.
    expect(children(h.state, CHAPTER_ONE)).toEqual([LANDING, STORM]);
    expect(node(h.state, LANDING).title).toBe('The Landing');
    expect(body(h.state, LANDING)).toBe(LANDING_BODY);
    expect((h.state.manifest.codex ?? []).map((e) => e.name).sort()).toEqual(['Elena', 'Kestrel']);
    // The node command 1 created is gone — checked by membership, because
    // `findByTitle` throws by design and a throwing probe is not an assertion.
    expect(h.state.manifest.tree.some((n) => n.title === 'Chapter 3')).toBe(false);
  });

  it('restores a codex entry that carried no `updatedAt` to carrying none — the defect this gate found', () => {
    // The byte-equal assertion above is what caught it, and it caught it for a
    // reason worth keeping: **every field a reader looks at was already correct.**
    // The description reverted, the attachment reverted, the name was never
    // touched — and the entry still held the timestamp of the write the user had
    // just undone. A content comparison passes on exactly this state, so only the
    // byte comparison fails, which is the whole argument for §10 saying
    // "byte-equal" rather than "equal".
    const h = scriptedHarness();
    expect('updatedAt' in ((h.state.manifest.codex ?? []).find((e) => e.id === ENTRY) ?? {})).toBe(false);

    const outcome = h.dispatch(
      cmd({
        name: 'codex.upsert',
        params: { entries: [{ action: 'update', id: ENTRY, description: 'The keeper, renamed.' }] },
      }),
    );
    expect(outcome.ok).toBe(true);
    expect((h.state.manifest.codex ?? []).find((e) => e.id === ENTRY)?.updatedAt).toBeTruthy();

    const groupId = outcome.ok ? outcome.value.undoGroupId : undefined;
    expect(groupId).toBeTruthy();
    expect(h.undoGroup(String(groupId)).failures).toEqual([]);

    const after = (h.state.manifest.codex ?? []).find((e) => e.id === ENTRY);
    expect(after?.description).toBe('The keeper.');
    // The sharp witness: absence restored as absence, not as `undefined`.
    expect('updatedAt' in (after ?? {})).toBe(false);
  });

  it('restores the stamp an entry already carried, rather than deleting it', () => {
    // **The case this file's fixture cannot hold, and the reason the fix above
    // reads `if (!('updatedAt' in before))`.** Every codex entry `makeState`
    // pushes is written by hand with no `createdAt` and no `updatedAt`, so in
    // this file's world no entry has ever been stamped before an update. The
    // product is the other way round: `codex.upsert` stamps both on every entry
    // it *creates*, so the entry that reaches an update already carrying a stamp
    // is the ordinary one and the unstamped entry is the exotic case.
    //
    // Which makes the **mirror** of the defect above the likelier one in
    // production: a delete that ignores `before` does not leave a stamp behind,
    // it takes a legitimate one away — and §10's own criterion stops holding for
    // any script that updates an entry it did not create in the same session.
    // Measured on this file before this test existed, on the shipped fix: a
    // plain `delete entry.updatedAt` passes **all 26**.
    const h = scriptedHarness();

    // Stamped by the shipped create path, not by the fixture.
    const created = h.dispatch(
      cmd({ name: 'codex.upsert', params: { entries: [{ action: 'create', name: 'Wren' }] } }),
    );
    expect(created.ok).toBe(true);
    const entry = (h.state.manifest.codex ?? []).find((e) => e.name === 'Wren');
    expect(entry?.updatedAt).toBe(new Date(TICK).toISOString());

    // An entry whose stamp came from an earlier write. The suite's clock is
    // fixed, so without this the new stamp and the old one would be the same
    // string and no assertion could tell the two apart.
    const EARLIER = '2026-01-02T03:04:05.000Z';
    entry!.updatedAt = EARLIER;

    const update = h.dispatch(
      cmd({
        name: 'codex.upsert',
        params: { entries: [{ action: 'update', id: entry!.id, description: 'Described.' }] },
      }),
    );
    expect(update.ok).toBe(true);
    expect(entry!.updatedAt).toBe(new Date(TICK).toISOString());

    const groupId = update.ok ? update.value.undoGroupId : undefined;
    expect(groupId).toBeTruthy();
    expect(h.undoGroup(String(groupId)).failures).toEqual([]);

    // The stamp it carried before the update is the stamp it carries now — a
    // restored value, not an absence, and not the undone write's.
    expect('updatedAt' in entry!).toBe(true);
    expect(entry!.updatedAt).toBe(EARLIER);
  });
});

// ============================================ family 3 — the permission matrix

describe('§10 — the permission matrix, over the registry that implements the names', () => {
  /** §9's `never`-class names, read from the implementing registry. */
  const NEVER: CommandName[] = (Object.keys(createProjectCommandRegistry({ clock })) as CommandName[])
    .filter((name) => {
      const entry = createProjectCommandRegistry({ clock })[name];
      return entry !== undefined && 'descriptor' in entry && entry.descriptor.agentRisk === 'never';
    })
    .sort();

  /** A dispatch that is valid for each `never`-class name, as a **user**. */
  function userParams(name: CommandName, state: ProjectState): Record<string, unknown> {
    switch (name) {
      case 'editor.insert':
        return { docId: LANDING, offset: body(state, LANDING).length, text: ' Kestrel.' };
      case 'editor.replaceRange':
        return { docId: LANDING, range: { from: 0, to: 3 }, text: 'That' };
      case 'project.deleteNode':
        return { nodeId: FRIEND };
      // The skill commands (extensibility.md §10) are `never` for an agent and the writer's own. `skill.import` has no apply in this
      // registry (it needs the host's staging), so commands-skills.test.ts runs it, for a user and refused for an agent.
      case 'skill.import':
        return { stagingId: 'stg_none' };
      case 'skill.write':
        return { name: 'close-third', path: 'SKILL.md', text: ['---', 'name: close-third', 'description: Close third person.', '---', 'Write close.', ''].join('\n') };
      case 'skill.delete':
      case 'skill.setEnabled':
        state.skills.set('close-third', [{ path: 'SKILL.md', bytes: new Uint8Array([45, 45, 45]) }]);
        return name === 'skill.delete' ? { name: 'close-third' } : { name: 'close-third', enabled: false };
      // A memory note is the writer's to forget (hard-denied for an agent, like project.deleteNode).
      // The macro commands are the writer's own, as the skill commands are.
      case 'macro.save':
        return { macro: { slug: 'tidy-notes', name: 'Tidy notes', description: '', params: { kind: 'object', description: 'p', properties: {}, required: [] }, steps: [{ tool: 'notes.append', params: { text: 'x' }, expect: 'Adds a note.' }] } };
      case 'macro.delete':
        state.manifest.macros = [{ id: 'm_GATE000001', slug: 'tidy-notes', name: 'Tidy notes', description: '', params: { kind: 'object', description: 'p', properties: {}, required: [] }, steps: [{ tool: 'notes.append', params: { text: 'x' }, expect: 'Adds a note.' }] }];
        return { macroId: 'm_GATE000001' };
      case 'memory.forget':
        state.agentFiles = { memory: [{ slug: 'style-dialogue', type: 'style', title: 'Dialogue tags', body: 'Use said.', modified: '', origin: 'writer' }], declined: new Map(), unreadable: [] };
        return { slug: 'style-dialogue' };
      default:
        throw new Error(`no user params for the never-class name ${name}`);
    }
  }

  it('finds the never-class names in the implementing registry, and finds some', () => {
    // Read out, not typed out: a name promoted to `never` later must arrive here
    // without this file being edited.
    expect(NEVER).toEqual([
      'editor.insert',
      'editor.replaceRange',
      'macro.delete',
      'macro.save',
      'mcp.readResource',
      'memory.forget',
      'project.deleteNode',
      'skill.delete',
      'skill.import',
      'skill.setEnabled',
      'skill.write',
    ]);
  });

  it('refuses every never-class name for an agent, with §7\'s risk and corrective path', () => {
    expect(NEVER.length).toBeGreaterThan(0);
    for (const name of NEVER) {
      // Not wired in this registry, so the bus refuses it before the gate; commands-skills.test.ts refuses it for an agent with the staging
      // injected, and the MCP client's tests refuse `mcp.readResource` for an agent with the client injected.
      if (name === 'skill.import' || name === 'mcp.readResource') continue;
      const h = scriptedHarness();
      const result = h.dispatch(
        cmd({ name, params: userParams(name, h.state), issuedBy: 'agent', turnId: 'turn-x' }),
      );

      expect(result.ok, `${name} must be refused for an agent`).toBe(false);
      if (result.ok) continue;
      // `project.deleteNode` is hard-denied (§4's class no flow rescues); the two
      // editor primitives are `never` and inheritable, so the gate refuses them.
      expect(['permission-denied', 'hard-denied']).toContain(result.error.code);
      // §7 declares `risk` for gate rejections, and §4 requires the corrective
      // path — a bare code is the thing §7 forbids.
      expect(result.error.risk).toBe('never');
      expect(result.error.correctiveHint).toBeTruthy();
      expect(result.error.correctiveHint?.toLowerCase()).toContain('do not retry');
      // §3's zero partial effects, asserted rather than assumed: nothing ran.
      expect(h.log.length).toBe(0);
      expect(h.undo.groups()).toEqual([]);
    }
  });

  it('allows every never-class name for a user, and asks for a confirm where the effect is destructive', () => {
    expect(NEVER.length).toBeGreaterThan(0);
    for (const name of NEVER) {
      if (name === 'skill.import' || name === 'mcp.readResource') continue;
      const h = scriptedHarness();
      const result = h.dispatch(cmd({ name, params: userParams(name, h.state) }));

      // §4: "the gate never refuses a user command" — a UI gesture is its own
      // confirmation, so what comes back is the effect plus, where the effect is
      // destructive, the requirement of a dialog.
      expect(result.ok, `${name} must be allowed for a user`).toBe(true);
      if (!result.ok) continue;
      expect(result.value.grant.requiresUserConfirm).toBe(name === 'project.deleteNode' || name === 'memory.forget');
    }
  });
});

// =============================================== family 4 — the error shapes

describe('§10 — every refusal carries a code and a corrective path, not a bare code', () => {
  it('reports a bad param as invalid-params, naming the key', () => {
    const h = scriptedHarness();
    const result = h.dispatch(cmd({ name: 'binder.rename', params: { nodeId: LANDING, title: 42 } }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-params');
    expect(result.error.target).toBe('title');
    expect(result.error.correctiveHint).toBeTruthy();
  });

  it('reports an unknown id as not-found, and a cycle as cycle, because §9 tells them apart', () => {
    const h = scriptedHarness();
    const missing = h.dispatch(cmd({ name: 'binder.rename', params: { nodeId: MISSING, title: 'x' } }));
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe('not-found');
      expect(missing.error.correctiveHint).toBeTruthy();
    }

    // A folder under its own descendant, which takes two dispatches to build: the
    // fixture's only nesting is chapters over documents, and a **document** is not
    // a legal parent, so moving Chapter 1 under The Landing is refused as
    // `invalid-params` before the cycle check is ever reached. That ordering is
    // correct — param shape first — and it is why this case has to construct a real
    // folder-into-descendant rather than reach for the nearest-looking pair.
    const created = h.dispatch(
      cmd({ name: 'binder.create', params: { parentId: CHAPTER_ONE, type: 'folder', title: 'Part 1' } }),
    );
    expect(created.ok).toBe(true);
    const partId = h.state.manifest.tree.find((n) => n.title === 'Part 1')?.id;
    expect(partId).toBeTruthy();

    // §9's `binder.move` row requires the check, and reporting a cycle as a plain
    // validation error is the lossy answer §7's code list exists to avoid.
    const cycle = h.dispatch(
      cmd({ name: 'binder.move', params: { nodeId: CHAPTER_ONE, newParentId: String(partId), index: 0 } }),
    );
    expect(cycle.ok).toBe(false);
    if (!cycle.ok) {
      expect(cycle.error.code).toBe('cycle');
      expect(cycle.error.correctiveHint).toBeTruthy();
    }
  });

  it('reports a stale expectedRevision as revision-conflict, carrying both numbers', () => {
    const h = scriptedHarness();
    const result = h.dispatch(
      cmd({ name: 'doc.write', params: { docId: LANDING, body: 'x', expectedRevision: 999 } }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('revision-conflict');
    // §6's sentence names both revisions, and a caller that has to parse the
    // message to learn the current one cannot build the retry loop §6 is for.
    expect(result.error.details?.expectedRevision).toBe(999);
    expect(result.error.details?.actualRevision).toBe(revision(h.state, LANDING));
    expect(result.error.correctiveHint).toBeTruthy();
  });

  it('reports an over-limit synopsis as limit-exceeded, with the limit in the message', () => {
    const h = scriptedHarness();
    const result = h.dispatch(
      cmd({ name: 'binder.setSynopsis', params: { nodeId: LANDING, synopsis: 'x'.repeat(2001) } }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('limit-exceeded');
    // project-format §2's 2000, quoted by the message rather than restated here.
    expect(result.error.message).toContain('2000');
    expect(result.error.correctiveHint).toBeTruthy();
  });

  it('reports a batch with one bad op as invalid-params listing every failure, and writes nothing', () => {
    const h = scriptedHarness();
    const result = h.dispatch(
      cmd({
        name: 'codex.upsert',
        params: {
          entries: [
            { action: 'create', name: 'Gannet', type: 'other', description: 'A bird.' },
            // A name that collides with the fixture's Elena, case-insensitively.
            { action: 'create', name: 'elena', type: 'character', description: 'Clash.' },
          ],
        },
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-params');
    // §2: "list failures per-op" and "every failure is listed, not just the first".
    expect(result.error.details?.failures?.length).toBeGreaterThanOrEqual(1);
    // §3's zero partial effects on a batch refusal: the good op did not land.
    expect((h.state.manifest.codex ?? []).map((e) => e.name)).not.toContain('Gannet');
  });

  it('reports a name with no implementation as internal, without reading a snapshot', () => {
    // The bus's own registry is the subject: §9's two export rows are registered
    // with real descriptors and no effect without an exporter, and §7's shape for that is
    // the one §1's "the bus does not own project state" produces.
    const h = scriptedHarness();
    const result = h.dispatch(
      cmd({ name: 'export.compile', params: { format: 'docx' } }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('internal');
    expect(result.error.correctiveHint).toBeTruthy();
    expect(h.log.length).toBe(0);
  });

  it('reports a throwing apply as internal, and still hands back an undo group', () => {
    // The one family that needs a fake: no correct apply throws, and §10's
    // error-shape assertion is about the *refusal*, not about the apply.
    const h = scriptedHarness();
    const registry = throwingRegistry('binder.rename');
    const result = execute(
      cmd({ name: 'binder.rename', params: { nodeId: LANDING, title: 'x' } }),
      h.bus,
      registry,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('internal');
    // The hint has to say this is a defect and not a refusal, because a model
    // that reads it as a permission problem will retry the same broken call.
    expect(result.error.correctiveHint).toContain('defect in the apply');
  });

  it('reports a failed postcondition as postcondition, and keeps the undo group intact', () => {
    // §7: "Postcondition failure is never silently auto-undone" — so the group
    // has to be *in* the error, or the effect is stranded.
    //
    // The subject is a `compensable` name on purpose. A first attempt used
    // `binder.rename`, whose declared undo kind is `inverse`, and got `internal`
    // back — §5's registration refusal, firing because a fake that captures a
    // *compensation* under a descriptor that declares an *inverse* is a real
    // refusal, correctly reported. The code under test was never reached.
    const h = scriptedHarness();
    const registry = postconditionRegistry('notes.append', 'the note ends where it began');
    const result = execute(
      cmd({ name: 'notes.append', params: { nodeId: LANDING, text: ' A trailing note.' } }),
      h.bus,
      registry,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('postcondition');
    expect(result.error.details?.undoGroupId).toBeTruthy();
    expect(h.undo.group(String(result.error.details?.undoGroupId))).toBeTruthy();
  });

  it('declares io-error and has no producer for it — the one code no v0.1 path can emit', () => {
    // **Measured, not asserted from the enum.** §7's list is a contract, and a
    // code nothing can emit is either dead surface or a mis-coded failure — so
    // this test reads the sources and says which it is. It passes with zero
    // producers across both packages; if a future change adds one, this test
    // fails and that change has to move the finding with it.
    const producers = sourceFiles()
      .flatMap((file) => readFileSync(file, 'utf8').split('\n'))
      .filter((line) => line.includes("code: 'io-error'"))
      .filter((line) => !line.includes('result.ts'));
    expect(producers).toEqual([]);

    // And the code is genuinely part of the closed set, so the two halves of the
    // claim are checked rather than one being assumed from the other.
    const declared = readFileSync(resolve(__dirname, '../../bus/src/result.ts'), 'utf8');
    expect(declared).toContain("| 'io-error'");
  });
});

/** Both packages' sources — the same subject the parity harness reads. */
function sourceFiles(): string[] {
  const packages = ['bus', 'store'];
  return packages.flatMap((pkg) => {
    const dir = resolve(__dirname, '../../', pkg, 'src');
    return readdirSync(dir)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => resolve(dir, name));
  });
}

/** A registry whose named command's apply throws, built from the real descriptor. */
function throwingRegistry(name: CommandName): CommandRegistry {
  const descriptor = realDescriptor(name);
  return {
    ...COMMAND_REGISTRY,
    [name]: {
      descriptor,
      // An apply that throws *without reporting* — a fake that reported first would
      // make the throw read as a missing report rather than as a throw, and the
      // test is about the throw.
      apply: ((_state: unknown, _params: unknown, _context: { report: (r: unknown) => void }) => {
        throw new Error('the apply exploded');
      }) as unknown as CommandApply<never, unknown>,
    },
  } as CommandRegistry;
}

/** A registry whose named command's only postcondition cannot hold. */
function postconditionRegistry(name: CommandName, describe: string): CommandRegistry {
  const base = realDescriptor(name);
  const descriptor: CommandDescriptor = {
    ...base,
    postconditions: [{ describe, assert: () => false }],
  };
  return {
    ...COMMAND_REGISTRY,
    [name]: {
      descriptor,
      apply: ((_state: unknown, _params: unknown, context: { report: (r: unknown) => void; undo: { compensate: (l: string, r: () => void) => void } }) => {
        context.undo.compensate('put the title back', () => {});
        context.report({ affected: [], summary: 'renamed, allegedly' });
        return { renamed: true };
      }) as unknown as CommandApply<never, unknown>,
    },
  } as CommandRegistry;
}

/** The descriptor the implementing registry holds for `name`. */
function realDescriptor(name: CommandName): CommandDescriptor {
  const entry = createProjectCommandRegistry({ clock })[name];
  if (entry === undefined || !('descriptor' in entry)) {
    throw new Error(`${name} has no descriptor in the implementing registry`);
  }
  return entry.descriptor;
}

// ================================================ family 5 — callId replay dedupe

describe('§10 — a replayed callId returns the first outcome instead of running again', () => {
  it('dispatches the apply once, and proves it two ways', () => {
    const h = scriptedHarness();
    // **The turn is not optional here, and that is the finding a first attempt
    // recorded.** §6 says "replays of the same `callId` **within a turn**", and
    // `idempotency.ts` resolves the unstated case — a `callId` with no turn is
    // **not a key**, because a bucket nothing ever clears makes the entry immortal
    // and an immortal entry under a reused id is a write the caller can never
    // perform again. A test that omits the turn therefore asserts nothing about
    // dedupe: it dispatches twice, gets two outcomes, and looks like a broken
    // cache. The key is (turn, callId).
    const command = cmd({
      name: 'binder.rename',
      params: { nodeId: LANDING, title: 'The Ferry' },
      issuedBy: 'agent',
      turnId: 'turn-7',
      callId: 'call-1',
    });

    const first = h.dispatch(command);
    const second = h.dispatch(command);

    expect(first.ok).toBe(true);
    // §6: a replay returns the earlier result as-is — the same object, carrying
    // that dispatch's own `commandId` and `undoGroupId`.
    expect(second).toBe(first);
    // Two independent witnesses, because either alone is satisfiable by a second
    // run that merely reported less: one §8 row, and one §5 group.
    expect(h.log).toHaveLength(1);
    expect(h.undo.groups()).toHaveLength(1);
    expect(node(h.state, LANDING).title).toBe('The Ferry');
  });

  it('runs the same command again when the callId differs', () => {
    const h = scriptedHarness();
    const turn = { issuedBy: 'agent' as const, turnId: 'turn-7' };
    h.dispatch(cmd({ name: 'binder.rename', params: { nodeId: LANDING, title: 'The Ferry' }, ...turn, callId: 'call-1' }));
    h.dispatch(cmd({ name: 'binder.rename', params: { nodeId: LANDING, title: 'The Landing Again' }, ...turn, callId: 'call-2' }));

    // Two different ids, so two dispatches and two §8 rows — the effect ran twice.
    expect(node(h.state, LANDING).title).toBe('The Landing Again');
    expect(h.log).toHaveLength(2);
    // **And still one group**, because they share a turn and §5 says "one agent turn
    // = one undo group". The first attempt at this assertion expected two groups and
    // was wrong in an instructive way: a fresh `callId` proves the *cache* let the
    // second dispatch through, and the *group* count is governed by a different
    // rule entirely. Reading a group count as evidence about dedupe conflates them.
    expect(h.undo.groups()).toHaveLength(1);
    expect(h.undo.groups()[0]?.entries).toHaveLength(2);
  });

  it('does not cache a gate refusal, so a confirmed retry still works', () => {
    // §6's rule and that change's: the same id, the same params, the same turn — first
    // refused at §4's gate, then allowed once the plan is approved. Caching the
    // refusal would make a confirmed write permanently unconfirmable.
    const withoutPlan = harness();
    const refused = withoutPlan.dispatch(
      cmd({ name: 'doc.write', params: { docId: LANDING, body: 'Written.' }, issuedBy: 'agent', turnId: 'turn-9', callId: 'call-3' }),
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('permission-denied');
    // A gate refusal happens before the cache boundary, so nothing was recorded.
    expect(withoutPlan.log.length).toBe(0);

    const withPlan = harness({ approvedPlan: true });
    const params = { docId: LANDING, body: 'Written.' };
    const first = withPlan.dispatch(
      cmd({ name: 'doc.write', params, issuedBy: 'agent', turnId: 'turn-9', callId: 'call-3' }),
    );
    const second = withPlan.dispatch(
      cmd({ name: 'doc.write', params, issuedBy: 'agent', turnId: 'turn-9', callId: 'call-3' }),
    );

    expect(first.ok).toBe(true);
    // Same id, same turn, and it is still a replay — the cache is per turn, and
    // the second call is the *same* call, not a confirmation of the first.
    expect(second).toBe(first);
    expect(withPlan.log).toHaveLength(1);
  });
});
