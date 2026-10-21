/**
 * The eight `inverse`/`compensable` structure applies, end to end through §3's
 * pipeline, and the pair plus the codex batch on top.
 *
 * ## What is being tested, and what would pass anyway
 *
 * Every test here dispatches a real `Command` through the shipped `execute()`,
 * over the store's own `ProjectState`, with the shipped `undo` store and a
 * dispatcher that routes each inverse back through the same pipeline. So the
 * subject is the guarantee §5 makes in one line — *"the descriptor generates the
 * **exact** inverse command"* — and the assertion that matters is not "a group
 * exists" but **`undo()` returns no failures**, which is the only thing that says
 * an inverse actually dispatched and landed.
 *
 * The tests are built around the cases where "exact" is a claim that can be
 * quietly wrong, because all of them produce an inverse that is *well-formed* and
 * would pass a shape check:
 *
 * - **an idempotent instruction.** Attaching a node that is already attached, or
 *   adding a keyword the node already has, changes nothing — so an inverse
 *   computed from the *request* would detach a pre-existing attachment and delete
 *   a pre-existing tag. The inverse has to come from what the dispatch observed.
 * - **a value the request could not express.** A node with no status is `null`,
 *   and §5's inverse has to be able to say so. That is what widened `MetaPatch`.
 * - **a positional command.** `binder.move`'s `index` is a position, and §2's
 *   gap-encoding means positions and orders are not interchangeable, so the
 *   inverse of a move is a move rather than an order write.
 * - **a command with no inverse at all.** `project.deleteNode` cannot have one:
 *   the exact inverse would be a create carrying the removed subtree, and §9 has
 *   no such command. So it is `compensable`, and what its tests hold is the
 *   artifact — a subtree, its body records and the attachments it tore — coming
 *   back whole in one click.
 * - **a batch that is one group.** `codex.upsert` registers **one** compensation
 *   for the whole batch, because `undo.ts`'s `UndoScope` keeps a single payload and
 *   a second `compensate()` would overwrite the first. The test that matters is a
 *   mixed three-op batch undone completely, because a per-entry `compensate()`
 *   would pass every single-op test and fail exactly there.
 *
 * ## The split this file also pins
 *
 * The bus's own `COMMAND_REGISTRY` still refuses all eight, and *that is the
 * intended state*: the bus does not own project state, so it cannot supply the
 * `state` an apply mutates. The store's `createProjectCommandRegistry()` is what
 * carries them, and `execute()` takes it as its third parameter. Both halves are
 * asserted, because a store registry that quietly stopped implementing a name and
 * a bus registry that quietly started would each be a silent loss.
 *
 * `binder.create` ships together with `project.deleteNode`, because its exact
 * inverse is `project.deleteNode` and a create whose undo is a command the bus
 * refuses is a write-auto command that reports success and cannot be undone. Two
 * tests pin the pair.
 */

import { describe, expect, it } from 'vitest';
import { isIdWithPrefix } from '@caotang/ids';
import {
  createActivityLog,
  createIdempotencyCache,
  createUndoStore,
  createViewState,
  execute,
  lookupCommand,
  resolveCommand,
  type BusContext,
  type Command,
  type CommandRegistry,
  type ExecutionOutcome,
  type UndoOutcome,
  type UndoStore,
} from '@caotang/bus';

import {
  addDocument,
  addFolder,
  createEmptyManifest,
  createProjectCommandRegistry,
  createProjectState,
  nodeById,
  removeNode,
  setBody,
  validateManifest,
  type ProjectState,
} from '../src/index.js';

const OPENED = new Date('2026-10-02T15:00:00.000Z');

const CHAPTER_ONE = 'n_CHAPTERONE0';
const CHAPTER_TWO = 'n_CHAPTERTWO0';
const LANDING = 'n_LANDING00000';
const STORM = 'n_STORM000000';
const OTHER = 'n_OTHER000000';
const ENTRY = 'c_ELENA000000';
const ENTRY_TWO = 'c_KESTREL000';
const UNKNOWN = 'n_NOSUCHNODE';
const INTERLUDE = 'n_INTERLUDE00';
const VIGIL = 'n_THEVIGIL00';

/** A fixed clock, so an inverse's `createdAt` is an assertion and not a number. */
const TICK = 1_760_000_000_000;
const clock = { now: () => TICK };

interface Harness {
  readonly state: ProjectState;
  readonly bus: BusContext<ProjectState>;
  /** The store's registry — the one 
un uses, and the one §6's end-to-end test needs. */
  readonly registry: CommandRegistry;
  readonly undo: UndoStore;
  readonly notified: ExecutionOutcome[];
  /** Dispatch `command` and fail loudly rather than return a refusal. */
  run(command: Command): ExecutionOutcome;
  /** Undo `groupId`, failing loudly if any compensation did not land. */
  undoGroup(groupId: string): UndoOutcome;
}

function makeState(): ProjectState {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', OPENED));
  // `createEmptyManifest` seeds statuses and **no labels**, and §9's
  // `binder.setMeta` is vocabulary-validated — so a project that has labels has
  // to have declared them, and a fixture that quietly relied on the node's own
  // `label` field would be testing a refusal instead of an apply.
  state.manifest.vocabulary.labels = [
    { id: 'act-1', name: 'Act 1', color: '#8a8a8a' },
    { id: 'act-2', name: 'Act 2', color: '#4a90d9' },
  ];
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 1', now: OPENED, id: CHAPTER_ONE });
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 2', now: OPENED, id: CHAPTER_TWO });
  addDocument(state, {
    parentId: CHAPTER_ONE,
    title: 'The Landing',
    body: 'The ferry was late, as always.',
    now: OPENED,
    id: LANDING,
    status: 'draft',
    label: 'act-1',
    keywords: ['sea', 'grief'],
    synopsis: 'Elena returns to the island.',
  });
  addDocument(state, { parentId: CHAPTER_ONE, title: 'The Storm', now: OPENED, id: STORM });
  addDocument(state, { parentId: CHAPTER_TWO, title: 'The Letter', now: OPENED, id: OTHER });
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

/**
 * `harness(permission?)` — `permission` is §4's flow facts, and the only commands
 * that need them are the ones an *agent* issues at `write-confirm` or above. A user
 * gesture is its own confirmation, which is why most tests here pass nothing: a
 * `write-confirm` command issued by the user must not need a plan to run, or §4's
 * "the gate never refuses a user command" would be untested.
 */
function harness(permission?: BusContext<ProjectState>['permission']): Harness {
  const state = makeState();
  const registry = createProjectCommandRegistry({ clock });
  const notified: ExecutionOutcome[] = [];
  // The dispatcher needs the bus it dispatches into, and the bus needs the undo
  // store that calls it. The closure only *reads* `bus`, and only at undo time,
  // long after the declaration below has initialised — the same shape an app has.
  const undo = createUndoStore({
    dispatch: (command) => execute(command, bus, registry),
  });
  const bus: BusContext<ProjectState> = {
    state,
    view: createViewState(),
    read: () => state,
    ...(permission === undefined ? {} : { permission }),
    undo,
    log: createActivityLog(),
    idempotency: createIdempotencyCache(),
    notify: (outcome) => notified.push(outcome),
  };
  return {
    state,
    bus,
    registry,
    undo,
    notified,
    run(command) {
      const result = execute(command, bus, registry);
      if (!result.ok) throw new Error(`${command.name} was refused: ${result.error.message}`);
      return result.value;
    },
    undoGroup(groupId) {
      const result = undo.undo(groupId);
      if (!result.ok) throw new Error(`undoing ${groupId} failed: ${result.error.message}`);
      // An inverse that could not be dispatched comes back as a failure, and the
      // group is kept. Every test below wants the first outcome, not the retry.
      expect(result.value.failures.map((f) => `${f.target}: ${f.message}`)).toEqual([]);
      return result.value;
    },
  };
}

let ordinal = 0;
function cmd(partial: Partial<Command> & Pick<Command, 'name' | 'params'>): Command {
  ordinal += 1;
  return {
    id: `cmd_TEST${String(ordinal).padStart(6, '0')}`,
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

/**
 * Every node as `id | parent | order`, sorted — the whole of what project-format §2's
 * tree means, and nothing about array position. A restore appends the block it put
 * back, so a test that compared the array would be asserting a property no reader of
 * the format depends on.
 */
function shapeOf(state: ProjectState): string[] {
  return state.manifest.tree.map((n) => `${n.id}|${n.parentId}|${n.order}`).sort();
}

function attachments(state: ProjectState, entryId: string): string[] {
  const entry = (state.manifest.codex ?? []).find((e) => e.id === entryId);
  if (!entry) throw new Error(`fixture is missing codex entry ${entryId}`);
  return [...entry.attachments];
}

function refusalOf(result: { ok: boolean; error?: { code: string; message: string; correctiveHint?: string } }) {
  if (result.ok) throw new Error('expected a refusal');
  if (!result.error) throw new Error('a refusal must carry an error');
  return result.error;
}

/** The single inverse entry a dispatch registered, read from the group. */
function inverseOf(h: Harness, groupId: string | undefined): Command {
  if (groupId === undefined) throw new Error('the dispatch registered no undo group');
  const group = h.undo.group(groupId);
  if (!group) throw new Error(`no group ${groupId}`);
  expect(group.entries).toHaveLength(1);
  const entry = group.entries[0]!;
  if (entry.kind !== 'inverse') throw new Error(`expected an inverse entry, got ${entry.kind}`);
  return entry.inverse;
}

/**
 * Every `compensable` entry a dispatch registered, labels included.
 *
 * The count is the assertion, not an accident of reading: a `compensable` command
 * that captures once per *thing it changed* would look identical to one that
 * captures once unless the number is pinned, and `undo.ts`'s single-payload scope
 * means the difference is a group that restores one entry out of a batch.
 */
function compensationsOf(h: Harness, groupId: string | undefined): string[] {
  if (groupId === undefined) throw new Error('the dispatch registered no undo group');
  const group = h.undo.group(groupId);
  if (!group) throw new Error(`no group ${groupId}`);
  for (const entry of group.entries) {
    if (entry.kind !== 'compensable') throw new Error(`expected a compensable entry, got ${entry.kind}`);
  }
  return group.entries.map((entry) =>
    entry.kind === 'compensable' ? entry.label : 'unreachable',
  );
}

// ---------------------------------------------------------------------------

/**
 * §6's optimistic concurrency, end to end.
 *
 * The bus's own registry has no `doc.write` apply, so `packages/bus/test/concurrency.test.ts`
 * proves §6 against a fake apply and a real descriptor. **That combination cannot
 * see the one thing this file is here for: whether the check reaches a document
 * that has actually moved.** Here the snapshot is a live `ProjectState`, the apply
 * is the shipped one, and the revision counter is the one project-format §4
 * bumps — so a guard that compared against the wrong field, or ran after the
 * apply, would show up as a changed body rather than as a passing assertion.
 */
describe('doc.write — §6: "Mismatch → conflict"', () => {
  it('refuses a stale expectedRevision and leaves the document exactly as it was', () => {
    const h = harness();
    const before = { ...h.state.documents.get(LANDING) };

    const error = refusalOf(execute(
      cmd({ name: 'doc.write', params: { docId: LANDING, body: 'A rewritten opening.', expectedRevision: 999 } }),
      h.bus,
      h.registry,
    ));

    expect(error.code).toBe('revision-conflict');
    expect(error.message).toContain('doc was modified since plan (rev 999 → ');
    // The body AND the revision: a write that bumped the counter without landing
    // the text would pass the first assertion and leave the document claiming a
    // revision its content never reached.
    expect(h.state.documents.get(LANDING)).toEqual(before);
    expect(h.notified).toEqual([]);
    expect(h.undo.groups().length).toBe(0);
  });

  it('writes when the caller sends the revision the document actually holds', () => {
    const h = harness();
    const revision = h.state.documents.get(LANDING)!.revision;

    const outcome = h.run(cmd({ name: 'doc.write', params: { docId: LANDING, body: 'A rewritten opening.', expectedRevision: revision } }));

    expect(h.state.documents.get(LANDING)!.body).toBe('A rewritten opening.');
    expect(h.state.documents.get(LANDING)!.revision).toBe(revision + 1);
    expect(outcome.undoGroupId).toBeDefined();
  });

  it('refuses the second of two writes planned against the same revision', () => {
    // The case §6 exists for: a model plans two edits, the first lands, and the
    // second was written against text that no longer exists.
    const h = harness();
    const planned = h.state.documents.get(LANDING)!.revision;
    h.run(cmd({ name: 'doc.write', params: { docId: LANDING, body: 'First.', expectedRevision: planned } }));

    const second = refusalOf(execute(
      cmd({ name: 'doc.write', params: { docId: LANDING, body: 'Second.', expectedRevision: planned } }),
      h.bus,
      h.registry,
    ));

    expect(second.code).toBe('revision-conflict');
    expect(h.state.documents.get(LANDING)!.body).toBe('First.');
  });
});

describe('binder.rename — §5: "the exact inverse command"', () => {
  it('renames the node and its inverse carries the title that was there before', () => {
    const h = harness();
    const outcome = h.run(cmd({ name: 'binder.rename', params: { nodeId: LANDING, title: 'The Landing (revised)' } }));

    expect(node(h.state, LANDING).title).toBe('The Landing (revised)');
    const inverse = inverseOf(h, outcome.undoGroupId);
    expect(inverse.name).toBe('binder.rename');
    expect(inverse.params).toEqual({ nodeId: LANDING, title: 'The Landing' });
  });

  it('undoes the rename through the pipeline, not by restoring a field', () => {
    const h = harness();
    const outcome = h.run(cmd({ name: 'binder.rename', params: { nodeId: LANDING, title: 'Arrival' } }));
    h.undoGroup(outcome.undoGroupId!);

    expect(node(h.state, LANDING).title).toBe('The Landing');
    // The reversal is a real dispatch: it was logged and it notified.
    expect(h.notified.map((o) => o.name)).toEqual(['binder.rename', 'binder.rename']);
  });

  it('renames a chapter and restores it: the section roots are refused by the bus, so this uses a chapter', () => {
    // The manuscript and research roots cannot be renamed (ui-modules §2.3, bus validate.test.ts), so the round trip
    // is run on a chapter, which the binder does let a writer rename.
    const h = harness();
    const outcome = h.run(cmd({ name: 'binder.rename', params: { nodeId: CHAPTER_ONE, title: 'Part One' } }));
    expect(node(h.state, CHAPTER_ONE).title).toBe('Part One');
    h.undoGroup(outcome.undoGroupId!);
    expect(node(h.state, CHAPTER_ONE).title).not.toBe('Part One');
  });
});

describe('binder.setSynopsis', () => {
  it('round-trips a synopsis and its inverse', () => {
    const h = harness();
    const outcome = h.run(cmd({ name: 'binder.setSynopsis', params: { nodeId: LANDING, synopsis: 'A short card.' } }));
    expect(node(h.state, LANDING).synopsis).toBe('A short card.');
    expect(inverseOf(h, outcome.undoGroupId).params).toEqual({
      nodeId: LANDING,
      synopsis: 'Elena returns to the island.',
    });
    h.undoGroup(outcome.undoGroupId!);
    expect(node(h.state, LANDING).synopsis).toBe('Elena returns to the island.');
  });
});

describe('binder.setMeta — the inverse of a field the request could not express', () => {
  it('restores a prior status, and a prior null status as null', () => {
    const h = harness();
    // LANDING starts at 'draft'; OTHER starts at null, which is the case §5's
    // exact inverse could not express until MetaPatch carried `null`.
    const fromDraft = h.run(cmd({ name: 'binder.setMeta', params: { nodeId: LANDING, patch: { status: 'final' } } }));
    const fromNull = h.run(cmd({ name: 'binder.setMeta', params: { nodeId: OTHER, patch: { status: 'revised' } } }));

    expect(node(h.state, LANDING).status).toBe('final');
    expect(node(h.state, OTHER).status).toBe('revised');
    expect(inverseOf(h, fromDraft.undoGroupId).params).toEqual({
      nodeId: LANDING,
      patch: { status: 'draft' },
    });
    expect(inverseOf(h, fromNull.undoGroupId).params).toEqual({
      nodeId: OTHER,
      patch: { status: null },
    });

    h.undoGroup(fromNull.undoGroupId!);
    h.undoGroup(fromDraft.undoGroupId!);
    expect(node(h.state, LANDING).status).toBe('draft');
    expect(node(h.state, OTHER).status).toBeNull();
  });

  it('restores status and label together, and touches nothing else in the inverse', () => {
    const h = harness();
    const outcome = h.run(cmd({
      name: 'binder.setMeta',
      params: { nodeId: LANDING, patch: { status: 'revised', label: 'act-2' } },
    }));
    expect(inverseOf(h, outcome.undoGroupId).params).toEqual({
      nodeId: LANDING,
      patch: { status: 'draft', label: 'act-1' },
    });
    h.undoGroup(outcome.undoGroupId!);
    expect(node(h.state, LANDING).status).toBe('draft');
    expect(node(h.state, LANDING).label).toBe('act-1');
  });

  it('leaves an untouched field alone: undoing a label never clears a status', () => {
    // The failure this guards is a validator or an apply that folds "absent" into
    // "null", which would make one undo wipe the field the patch never named.
    const h = harness();
    const outcome = h.run(cmd({ name: 'binder.setMeta', params: { nodeId: LANDING, patch: { label: 'act-2' } } }));
    h.undoGroup(outcome.undoGroupId!);
    expect(node(h.state, LANDING).label).toBe('act-1');
    expect(node(h.state, LANDING).status).toBe('draft');
  });

  it('inverts adding a keyword the node already has into a remove that skips it', () => {
    const h = harness();
    // 'sea' is already on the node (project-format §2, case-insensitive dedupe),
    // so the add is a no-op and the inverse must not delete the existing tag.
    const outcome = h.run(cmd({ name: 'binder.setMeta', params: { nodeId: LANDING, patch: { keywords_add: ['SEA'] } } }));
    expect(node(h.state, LANDING).keywords).toEqual(['sea', 'grief']);
    expect(inverseOf(h, outcome.undoGroupId).params).toEqual({
      nodeId: LANDING,
      patch: {},
    });
    h.undoGroup(outcome.undoGroupId!);
    expect(node(h.state, LANDING).keywords).toEqual(['sea', 'grief']);
  });

  it('stamps nothing on a dispatch that wrote no field, so its undo has nothing left unrestored', () => {
    // project-format §2: "content-touching mutations bump `updatedAt`". Re-adding
    // a keyword the node already holds writes no value, so the node keeps the
    // stamp it had. The forward apply used to stamp unconditionally and mint a
    // restore entry for its empty inverse, and the undo — which rightly treats a
    // changes-nothing inverse as a no-op — then reported full success while
    // leaving that stamp unrestored and the entry unreclaimed.
    const h = harness();
    const before = node(h.state, LANDING).updatedAt;
    const outcome = h.run(cmd({ name: 'binder.setMeta', params: { nodeId: LANDING, patch: { keywords_add: ['SEA'] } } }));
    expect(node(h.state, LANDING).updatedAt).toBe(before);
    // The inverse itself is asserted, not only the stamp: an inverse that
    // carried the field it did not write would be a restore entry waiting to
    // leak, and the stamp assertion above cannot see one.
    expect(inverseOf(h, outcome.undoGroupId).params).toEqual({
      nodeId: LANDING,
      patch: {},
    });
    const undone = h.undoGroup(outcome.undoGroupId!);
    expect(undone.failures).toEqual([]);
    expect(node(h.state, LANDING).updatedAt).toBe(before);
  });

  it('stamps nothing on a status the node already holds, and registers a field-less inverse for it', () => {
    // The other no-write dispatch: the patch names a field, and the field holds
    // the value the patch asks for. Nothing is written, so nothing is stamped
    // and nothing is restored — and the inverse says so by naming no field,
    // which is what lets the bus refuse it as a changes-nothing request
    // instead of dispatching a redundant write that appends a second row.
    const h = harness();
    const before = node(h.state, LANDING).updatedAt;
    const outcome = h.run(cmd({ name: 'binder.setMeta', params: { nodeId: LANDING, patch: { status: 'draft' } } }));
    expect(node(h.state, LANDING).status).toBe('draft');
    expect(node(h.state, LANDING).updatedAt).toBe(before);
    expect(inverseOf(h, outcome.undoGroupId).params).toEqual({
      nodeId: LANDING,
      patch: {},
    });
    const undone = h.undoGroup(outcome.undoGroupId!);
    expect(undone.failures).toEqual([]);
    expect(node(h.state, LANDING).updatedAt).toBe(before);
  });

  it('stamps nothing when a keyword is removed and re-added in the same patch', () => {
    // The net-zero patch: 'grief' is on the node, the patch removes it and adds
    // it back, and the list it leaves is the list it found. Counting the two
    // halves would stamp the node and report a change that did not happen.
    const h = harness();
    const before = node(h.state, LANDING).updatedAt;
    const outcome = h.run(cmd({
      name: 'binder.setMeta',
      params: { nodeId: LANDING, patch: { keywords_remove: ['grief'], keywords_add: ['grief'] } },
    }));
    expect(node(h.state, LANDING).keywords).toEqual(['sea', 'grief']);
    expect(node(h.state, LANDING).updatedAt).toBe(before);
    expect(inverseOf(h, outcome.undoGroupId).params).toEqual({
      nodeId: LANDING,
      patch: {},
    });
    const undone = h.undoGroup(outcome.undoGroupId!);
    expect(undone.failures).toEqual([]);
    expect(node(h.state, LANDING).keywords).toEqual(['sea', 'grief']);
  });

  it('adds a new keyword and removes exactly that one on undo', () => {
    const h = harness();
    const outcome = h.run(cmd({ name: 'binder.setMeta', params: { nodeId: LANDING, patch: { keywords_add: ['salt'] } } }));
    expect(node(h.state, LANDING).keywords).toEqual(['sea', 'grief', 'salt']);
    expect(inverseOf(h, outcome.undoGroupId).params).toEqual({
      nodeId: LANDING,
      patch: { keywords_remove: ['salt'] },
    });
    h.undoGroup(outcome.undoGroupId!);
    expect(node(h.state, LANDING).keywords).toEqual(['sea', 'grief']);
  });

  it('removes a keyword and re-adds exactly the ones it took, in their original spelling', () => {
    const h = harness();
    const outcome = h.run(cmd({
      name: 'binder.setMeta',
      params: { nodeId: LANDING, patch: { keywords_remove: ['SEA', 'grief'] } },
    }));
    expect(node(h.state, LANDING).keywords).toEqual([]);
    expect(inverseOf(h, outcome.undoGroupId).params).toEqual({
      nodeId: LANDING,
      patch: { keywords_add: ['sea', 'grief'] },
    });
    h.undoGroup(outcome.undoGroupId!);
    expect(node(h.state, LANDING).keywords).toEqual(['sea', 'grief']);
  });

  it('refuses a vocabulary id the project does not define, and writes nothing', () => {
    const h = harness();
    const refused = refusalOf(execute(
      cmd({ name: 'binder.setMeta', params: { nodeId: LANDING, patch: { status: 'polished' } } }),
      h.bus,
      createProjectCommandRegistry({ clock }),
    ));
    expect(refused.code).toBe('invalid-params');
    expect(node(h.state, LANDING).status).toBe('draft');
    expect(h.undo.groups()).toHaveLength(0);
  });
});

describe('binder.move — §2 gap-encoding, and an inverse that is itself a move', () => {
  it('lands the node at the requested index among the new siblings', () => {
    const h = harness();
    h.run(cmd({ name: 'binder.move', params: { nodeId: STORM, newParentId: CHAPTER_TWO, index: 0 } }));
    expect(children(h.state, CHAPTER_TWO)).toEqual([STORM, OTHER]);
    expect(node(h.state, STORM).parentId).toBe(CHAPTER_TWO);
    expect(children(h.state, CHAPTER_ONE)).toEqual([LANDING]);
  });

  it('places a node first among siblings that already exist, without renumbering them', () => {
    const h = harness();
    const before = children(h.state, CHAPTER_ONE).map((id) => node(h.state, id).order);
    h.run(cmd({ name: 'binder.move', params: { nodeId: OTHER, newParentId: CHAPTER_ONE, index: 0 } }));

    expect(children(h.state, CHAPTER_ONE)).toEqual([OTHER, LANDING, STORM]);
    // §2: "move = set one node's order" — the siblings it moved between keep theirs.
    const after = children(h.state, CHAPTER_ONE)
      .filter((id) => id !== OTHER)
      .map((id) => node(h.state, id).order);
    expect(after).toEqual(before);
  });

  it('appends past the end of a sibling set at max + 10', () => {
    const h = harness();
    // OTHER is the only child of Chapter 2, so it sits at 10 and an append lands
    // at 20 — the gap §2's "created at maxSiblingOrder + 10" leaves behind.
    expect(node(h.state, OTHER).order).toBe(10);
    h.run(cmd({ name: 'binder.move', params: { nodeId: STORM, newParentId: CHAPTER_TWO, index: 9 } }));
    expect(node(h.state, OTHER).order).toBe(10);
    expect(node(h.state, STORM).order).toBe(20);
    expect(children(h.state, CHAPTER_TWO)).toEqual([OTHER, STORM]);
  });

  it('undoes the move back into the old parent at the old position', () => {
    const h = harness();
    const outcome = h.run(cmd({ name: 'binder.move', params: { nodeId: OTHER, newParentId: CHAPTER_ONE, index: 0 } }));
    expect(inverseOf(h, outcome.undoGroupId).params).toEqual({
      nodeId: OTHER,
      newParentId: CHAPTER_TWO,
      index: 0,
    });

    h.undoGroup(outcome.undoGroupId!);
    expect(node(h.state, OTHER).parentId).toBe(CHAPTER_TWO);
    expect(children(h.state, CHAPTER_TWO)).toEqual([OTHER]);
    expect(children(h.state, CHAPTER_ONE)).toEqual([LANDING, STORM]);
  });

  it('reorders within the same parent — the moving node is not one of its own target siblings', () => {
    // `siblingOrderAt`'s `movingId` excludes the node being
    // moved from the sibling set it computes an order against, and its own doc
    // gives the reason: *"counting it would shift every index the caller meant."*
    // That exclusion is only observable when the node stays **inside** the parent
    // it is moving within — every other test here crosses a parent, where the
    // moving node is not in the target set and the argument changes nothing. The
    // claim was unpinned: dropping `movingId` leaves all 35 tests green, because
    // moving the middle of three siblings to the end then silently does nothing
    // (index 2 of a 3-element set that already holds the node there).
    const h = harness();
    addDocument(h.state, { parentId: CHAPTER_ONE, title: 'The Vigil', body: '', now: OPENED, id: VIGIL });
    expect(children(h.state, CHAPTER_ONE)).toEqual([LANDING, STORM, VIGIL]);

    h.run(cmd({ name: 'binder.move', params: { nodeId: STORM, newParentId: CHAPTER_ONE, index: 2 } }));

    expect(children(h.state, CHAPTER_ONE)).toEqual([LANDING, VIGIL, STORM]);
    // §2's gap-encoding, and the sibling that moved around it keeps its own order.
    expect(children(h.state, CHAPTER_ONE).map((id) => node(h.state, id).order)).toEqual([10, 30, 40]);
  });

  it('undoes a same-parent reorder to the exact position it held, gaps included', () => {
    const h = harness();
    addDocument(h.state, { parentId: CHAPTER_ONE, title: 'The Vigil', body: '', now: OPENED, id: VIGIL });
    const before = children(h.state, CHAPTER_ONE).map((id) => node(h.state, id).order);
    const outcome = h.run(cmd({ name: 'binder.move', params: { nodeId: STORM, newParentId: CHAPTER_ONE, index: 2 } }));

    h.undoGroup(outcome.undoGroupId!);

    expect(children(h.state, CHAPTER_ONE)).toEqual([LANDING, STORM, VIGIL]);
    // The orders too, not just the rendered order: a restore that lands the node
    // between the right pair at a different offset renders identically and is a
    // different tree, which is the property `state.ts` says the exclusion buys.
    expect(children(h.state, CHAPTER_ONE).map((id) => node(h.state, id).order)).toEqual(before);
  });

  it('renormalizes a sibling set first when the gap has no integer left (project-format §2)', () => {
    const h = harness();
    // Squeeze two siblings to consecutive orders, then insert between them.
    node(h.state, LANDING).order = 10;
    node(h.state, STORM).order = 11;
    h.run(cmd({ name: 'binder.move', params: { nodeId: OTHER, newParentId: CHAPTER_ONE, index: 1 } }));

    expect(children(h.state, CHAPTER_ONE)).toEqual([LANDING, OTHER, STORM]);
    // §2's own clause: compact to 10, 20, 30 …, then take the midpoint.
    expect(children(h.state, CHAPTER_ONE).map((id) => node(h.state, id).order)).toEqual([10, 15, 20]);
  });

  it('refuses a move into its own descendant and registers nothing', () => {
    const h = harness();
    // A *folder* descendant, because a document parent is refused earlier and more
    // specifically ("cannot hold children") — a cycle check that only ever sees
    // documents would pass without ever reaching the cycle branch.
    addFolder(h.state, { parentId: CHAPTER_ONE, title: 'Interlude', now: OPENED, id: INTERLUDE });
    const refused = refusalOf(execute(
      cmd({ name: 'binder.move', params: { nodeId: CHAPTER_ONE, newParentId: INTERLUDE, index: 0 } }),
      h.bus,
      createProjectCommandRegistry({ clock }),
    ));
    expect(refused.code).toBe('cycle');
    expect(node(h.state, CHAPTER_ONE).parentId).toBe('manuscript');
    expect(children(h.state, INTERLUDE)).toEqual([]);
    expect(h.undo.groups()).toHaveLength(0);
    expect(h.notified).toHaveLength(0);
  });

  it('refuses a move of a node into itself', () => {
    const h = harness();
    const refused = refusalOf(execute(
      cmd({ name: 'binder.move', params: { nodeId: CHAPTER_ONE, newParentId: CHAPTER_ONE, index: 0 } }),
      h.bus,
      createProjectCommandRegistry({ clock }),
    ));
    expect(refused.code).toBe('cycle');
    expect(h.undo.groups()).toHaveLength(0);
  });

  it('refuses to move a fixed root — §9: the manuscript-root invariant', () => {
    const h = harness();
    const refused = refusalOf(execute(
      cmd({ name: 'binder.move', params: { nodeId: 'manuscript', newParentId: CHAPTER_ONE, index: 0 } }),
      h.bus,
      createProjectCommandRegistry({ clock }),
    ));
    expect(refused.message).toContain('fixed root and cannot be moved');
    expect(node(h.state, 'manuscript').parentId).toBe('root');
    expect(h.undo.groups()).toHaveLength(0);
  });

  it('refuses a move of a node that is not in the tree, before any effect', () => {
    const h = harness();
    const refused = refusalOf(execute(
      cmd({ name: 'binder.move', params: { nodeId: UNKNOWN, newParentId: CHAPTER_ONE, index: 0 } }),
      h.bus,
      createProjectCommandRegistry({ clock }),
    ));
    expect(refused.code).toBe('not-found');
    expect(refused.correctiveHint).toBe('use binder.read_tree to list valid ids');
    expect(h.undo.groups()).toHaveLength(0);
  });
});

describe('codex.attach — codex.md §2 `attachments`, and an inverse of only what changed', () => {
  it('attaches, and the inverse detaches exactly what was attached', () => {
    const h = harness();
    const outcome = h.run(cmd({
      name: 'codex.attach',
      params: { entryId: ENTRY, attachTo: [LANDING, STORM], detachFrom: [] },
    }));
    expect(attachments(h.state, ENTRY)).toEqual([LANDING, STORM]);
    expect(inverseOf(h, outcome.undoGroupId).params).toEqual({
      entryId: ENTRY,
      attachTo: [],
      detachFrom: [LANDING, STORM],
    });

    h.undoGroup(outcome.undoGroupId!);
    expect(attachments(h.state, ENTRY)).toEqual([]);
  });

  it('detaches, and the inverse re-attaches exactly what was detached', () => {
    const h = harness();
    h.run(cmd({ name: 'codex.attach', params: { entryId: ENTRY, attachTo: [LANDING, STORM], detachFrom: [] } }));
    const outcome = h.run(cmd({
      name: 'codex.attach',
      params: { entryId: ENTRY, attachTo: [], detachFrom: [STORM] },
    }));
    expect(attachments(h.state, ENTRY)).toEqual([LANDING]);

    h.undoGroup(outcome.undoGroupId!);
    expect(attachments(h.state, ENTRY)).toEqual([LANDING, STORM]);
  });

  it('attaching an attached node is inert, and its inverse does not detach it', () => {
    const h = harness();
    h.run(cmd({ name: 'codex.attach', params: { entryId: ENTRY, attachTo: [LANDING], detachFrom: [] } }));
    const outcome = h.run(cmd({
      name: 'codex.attach',
      params: { entryId: ENTRY, attachTo: [LANDING], detachFrom: [] },
    }));
    // The inverse of a no-op has to be a no-op. An inverse computed from the
    // request would detach a pre-existing attachment, which is silent data loss
    // on a *reversible* command — the worst place for it.
    expect(inverseOf(h, outcome.undoGroupId).params).toEqual({
      entryId: ENTRY,
      attachTo: [],
      detachFrom: [],
    });

    h.undoGroup(outcome.undoGroupId!);
    expect(attachments(h.state, ENTRY)).toEqual([LANDING]);
  });

  it('keeps the order of existing attachments and appends the new ones in the order given', () => {
    const h = harness();
    h.run(cmd({ name: 'codex.attach', params: { entryId: ENTRY, attachTo: [STORM, LANDING], detachFrom: [] } }));
    h.run(cmd({ name: 'codex.attach', params: { entryId: ENTRY, attachTo: [OTHER], detachFrom: [] } }));
    expect(attachments(h.state, ENTRY)).toEqual([STORM, LANDING, OTHER]);
  });

  it('deduplicates a repeated id rather than writing the node twice', () => {
    const h = harness();
    h.run(cmd({ name: 'codex.attach', params: { entryId: ENTRY, attachTo: [LANDING, LANDING], detachFrom: [] } }));
    expect(attachments(h.state, ENTRY)).toEqual([LANDING]);
  });

  it('refuses a node in both lists, in pure and total validate, before any effect', () => {
    const h = harness();
    h.run(cmd({ name: 'codex.attach', params: { entryId: ENTRY, attachTo: [LANDING], detachFrom: [] } }));
    const refused = refusalOf(execute(
      cmd({
        name: 'codex.attach',
        params: { entryId: ENTRY, attachTo: [STORM, LANDING], detachFrom: [LANDING] },
      }),
      h.bus,
      createProjectCommandRegistry({ clock }),
    ));
    expect(refused.code).toBe('invalid-params');
    expect(refused.message).toContain('is in both attachTo and detachFrom');
    // The pre-existing attachment survived, and nothing was appended.
    expect(attachments(h.state, ENTRY)).toEqual([LANDING]);
    expect(h.undo.groups()).toHaveLength(1);
  });

  it('refuses an entry that is not in the manifest', () => {
    const h = harness();
    const refused = refusalOf(execute(
      cmd({ name: 'codex.attach', params: { entryId: 'c_MISSING0000', attachTo: [LANDING], detachFrom: [] } }),
      h.bus,
      createProjectCommandRegistry({ clock }),
    ));
    expect(refused.code).toBe('not-found');
    expect(attachments(h.state, ENTRY)).toEqual([]);
  });
});

describe('what every inverse command is, whatever it inverts', () => {
  it('is a user gesture, a well-formed §2 id, and stamped with the clock seam', () => {
    const h = harness();
    const cases: { name: Command['name']; params: Record<string, unknown> }[] = [
      { name: 'binder.rename', params: { nodeId: LANDING, title: 'Arrival' } },
      { name: 'binder.setSynopsis', params: { nodeId: LANDING, synopsis: 'x' } },
      { name: 'binder.setMeta', params: { nodeId: LANDING, patch: { status: 'final' } } },
      { name: 'binder.move', params: { nodeId: STORM, newParentId: CHAPTER_TWO, index: 0 } },
      { name: 'codex.attach', params: { entryId: ENTRY, attachTo: [LANDING], detachFrom: [] } },
      { name: 'binder.create', params: { parentId: CHAPTER_ONE, type: 'document', title: 'A New Scene' } },
    ];

    for (const { name, params } of cases) {
      const outcome = h.run(cmd({ name, params, issuedBy: 'agent' }));
      const inverse = inverseOf(h, outcome.undoGroupId);
      // §4 gates on `issuedBy`, and §5 makes the undo a click: an inverse carried
      // the agent's own `issuedBy` would be refusable — and for a `never`-class
      // inverse, un-approvable by any flow, which is what a create's delete is.
      expect(inverse.issuedBy, name).toBe('user');
      expect(isIdWithPrefix('cmd', inverse.id), `${name} id ${inverse.id}`).toBe(true);
      expect(inverse.createdAt, name).toBe(TICK);
      expect(inverse.turnId, name).toBeUndefined();
      expect(inverse.callId, name).toBeUndefined();
    }
  });

  it('names itself, and is a command the registry can resolve', () => {
    const h = harness();
    const outcome = h.run(cmd({ name: 'binder.rename', params: { nodeId: LANDING, title: 'Arrival' } }));
    const inverse = inverseOf(h, outcome.undoGroupId);
    // An inverse that is not a resolvable name would capture cleanly and then
    // fail at undo time — the failure the registration check cannot see.
    const registry = createProjectCommandRegistry({ clock });
    expect(registry[inverse.name].apply).toBeTypeOf('function');
    expect(lookupCommand(inverse.name).ok).toBe(true);
  });

  it('does not re-register while replaying, so an undo cannot toggle', () => {
    const h = harness();
    const outcome = h.run(cmd({ name: 'binder.rename', params: { nodeId: LANDING, title: 'Arrival' } }));
    h.undoGroup(outcome.undoGroupId!);
    expect(h.undo.groups()).toHaveLength(0);
  });

  it('keeps the group when one compensation of several fails, and undoes the rest', () => {
    // §5: "One agent turn = one undo group", so two agent commands sharing a
    // turnId land in one group with two entries — which is the only way to get a
    // *partly* failing group. §7: a failure "is never silently auto-undone … the
    // undo group stays intact and user-reversible either way".
    const h = harness();
    const turn = { issuedBy: 'agent', turnId: 'turn-1' } as const;
    const first = h.run(cmd({ name: 'binder.rename', params: { nodeId: LANDING, title: 'First' }, ...turn }));
    h.run(cmd({ name: 'binder.rename', params: { nodeId: STORM, title: 'Second' }, ...turn }));
    const group = h.undo.groups();
    expect(group).toHaveLength(1);
    expect(group[0]!.entries).toHaveLength(2);
    expect(first.undoGroupId).toBe(group[0]!.id);

    // Break one inverse by taking the node it names out of the tree, with the same
    // primitive `project.deleteNode` dispatches — so this is a real state a
    // real deletion can produce, not a stand-in for one.
    removeNode(h.state, LANDING);

    const result = h.undo.undo(group[0]!.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.failures).toHaveLength(1);
    expect(result.value.failures[0]!.code).toBe('not-found');
    // The other compensation still ran, and the group keeps only what is still
    // undone — so a retry reverses exactly the remaining entry.
    expect(node(h.state, STORM).title).toBe('The Storm');
    const kept = h.undo.group(group[0]!.id);
    expect(kept?.entries).toHaveLength(1);
    expect(kept?.entries[0]?.commandId).toBe(first.commandId);
  });
});

describe('binder.create and its exact inverse, project.deleteNode', () => {
  it('creates the node the params describe and inverts to the delete of that node', () => {
    const h = harness();
    const before = h.state.manifest.tree.map((n) => n.id);

    const outcome = h.run(
      cmd({ name: 'binder.create', params: { parentId: CHAPTER_ONE, type: 'document', title: 'A New Scene' } }),
    );
    const created = (outcome.result as { nodeId: string }).nodeId;

    expect(isIdWithPrefix('n', created)).toBe(true);
    expect(node(h.state, created).title).toBe('A New Scene');
    expect(node(h.state, created).parentId).toBe(CHAPTER_ONE);
    expect(children(h.state, CHAPTER_ONE)).toEqual([LANDING, STORM, created]);
    // A document gets a body record and a folder does not — which is the whole of
    // what makes the delete the *exact* inverse of each.
    expect(h.state.documents.get(created)?.body).toBe('');

    // The inverse names the node this dispatch created, not a shape that would fit.
    const inverse = inverseOf(h, outcome.undoGroupId);
    expect(inverse.name).toBe('project.deleteNode');
    expect(inverse.params).toEqual({ nodeId: created });

    h.undoGroup(outcome.undoGroupId!);
    expect(h.state.manifest.tree.map((n) => n.id)).toEqual(before);
    expect(h.state.documents.has(created)).toBe(false);
  });

  it('creates a folder with no body record, and the same click takes it back', () => {
    const h = harness();
    const outcome = h.run(
      cmd({ name: 'binder.create', params: { parentId: CHAPTER_TWO, type: 'folder', title: 'Chapter 3' } }),
    );
    const created = (outcome.result as { nodeId: string }).nodeId;

    expect(node(h.state, created).type).toBe('folder');
    // A folder with a record would fail `writeProject`'s counterpart check and is
    // not something §2's `docs/` layout can represent.
    expect(h.state.documents.has(created)).toBe(false);

    h.undoGroup(outcome.undoGroupId!);
    expect(nodeById(h.state, created)).toBeUndefined();
  });

  it('undoes a child before its parent when both are in the same turn', () => {
    // The header's claim about `binder.create`'s inverse: it names only the node it
    // created, so a child added by another command in the same group has to be
    // removed by *its own* entry, which means the group's entries must run in
    // reverse. Same turnId ⇒ one group (§5), so this is one click.
    const h = harness();
    const turn = { issuedBy: 'agent', turnId: 'turn-1' } as const;
    const folder = h.run(
      cmd({ name: 'binder.create', params: { parentId: CHAPTER_TWO, type: 'folder', title: 'Act Three' }, ...turn }),
    );
    const child = h.run(
      cmd({
        name: 'binder.create',
        params: { parentId: (folder.result as { nodeId: string }).nodeId, type: 'document', title: 'The Reckoning' },
        ...turn,
      }),
    );
    const parentId = (folder.result as { nodeId: string }).nodeId;
    const childId = (child.result as { nodeId: string }).nodeId;
    expect(h.undo.groups()).toHaveLength(1);
    expect(h.undo.group(h.undo.groups()[0]!.id)!.entries).toHaveLength(2);

    h.undoGroup(folder.undoGroupId!);

    expect(nodeById(h.state, childId)).toBeUndefined();
    expect(nodeById(h.state, parentId)).toBeUndefined();
    // Nothing left pointing at a node that is gone — §2 step 4 rejects a manifest
    // with a parent that does not resolve, and a forward-order undo would produce
    // exactly that.
    const gone = new Set([parentId, childId]);
    expect(h.state.manifest.tree.some((n) => n.parentId !== null && gone.has(n.parentId))).toBe(false);
  });

  it('refuses a document parent, because only a container holds children', () => {
    const h = harness();
    const refused = refusalOf(
      execute(
        cmd({ name: 'binder.create', params: { parentId: LANDING, type: 'document', title: 'Nested' } }),
        h.bus,
        createProjectCommandRegistry({ clock }),
      ),
    );
    expect(refused.message).toContain('cannot hold children');
    expect(h.state.manifest.tree.map((n) => n.id)).not.toContain('n_NESTED0000');
  });
});

describe('project.deleteNode — a subtree, its bodies, and the one artifact', () => {
  /** CHAPTER_ONE > LANDING > GRANDCHILD, so the closure has a second level to miss. */
  function withGrandchild(h: Harness): string {
    const id = addDocument(h.state, {
      parentId: LANDING,
      title: 'The Return',
      body: 'She came back.',
      now: OPENED,
      id: 'n_GRANDCHILD',
    }).id;
    return id;
  }

  it('removes the whole subtree, not the direct children', () => {
    const h = harness();
    const grandchild = withGrandchild(h);
    expect(nodeById(h.state, grandchild)?.parentId).toBe(LANDING);

    const outcome = h.run(cmd({ name: 'project.deleteNode', params: { nodeId: CHAPTER_ONE } }));

    // The grandchild is the control: a single pass over the tree finds only the
    // direct children, and a survivor here is a node whose parent does not resolve.
    expect(nodeById(h.state, CHAPTER_ONE)).toBeUndefined();
    expect(nodeById(h.state, LANDING)).toBeUndefined();
    expect(nodeById(h.state, STORM)).toBeUndefined();
    expect(nodeById(h.state, grandchild)).toBeUndefined();
    // The folder, its two documents and the document *under* one of them.
    expect((outcome.result as { removedCount: number }).removedCount).toBe(4);
    expect((outcome.result as { removedNodeIds: string[] }).removedNodeIds).toEqual([
      CHAPTER_ONE,
      LANDING,
      STORM,
      grandchild,
    ]);
  });

  it('removes the whole subtree when the array does not list parents first', () => {
    // The closure's actual subject. Every other fixture here was built by
    // `addDocument`, which appends, so a child always lands *after* its parent and
    // a single pass over the array happens to be enough — the guarantee was
    // untestable rather than held. The next test is what makes the reordered shape
    // a legal manifest rather than a contrivance.
    const h = harness();
    const grandchild = withGrandchild(h);
    const tree = h.state.manifest.tree;
    const at = (id: string) => tree.findIndex((n) => n.id === id);
    const grandchildNode = tree.splice(at(grandchild), 1)[0]!;
    tree.splice(at(LANDING), 0, grandchildNode);
    expect(at(grandchild)).toBeLessThan(at(LANDING));

    h.run(cmd({ name: 'project.deleteNode', params: { nodeId: CHAPTER_ONE } }));

    expect(nodeById(h.state, grandchild)).toBeUndefined();
    expect(nodeById(h.state, STORM)).toBeUndefined();
    expect(nodeById(h.state, OTHER)).toBeDefined();
  });

  it('has a legal manifest to take that shape from — §2 constrains parents, not array order', () => {
    // Built on its own ids rather than on the fixture's, because this is the one
    // assertion in the file that runs the *format's* validator, and the fixture ids
    // are test labels that would fail it for an unrelated reason. `validate.ts`
    // checks duplicate ids, that every parent resolves, and cycles — so a child may
    // precede its parent, and a removal that assumed otherwise would be a rule this
    // repository does not have.
    const state = createProjectState(createEmptyManifest('Keeper', OPENED));
    const folder = addFolder(state, { parentId: 'manuscript', title: 'One', now: OPENED, id: 'n_3W8RN2TQ6C' });
    const scene = addDocument(state, { parentId: folder.id, title: 'Two', now: OPENED, id: 'n_4X9TPW3R7M' });
    const beat = addDocument(state, { parentId: scene.id, title: 'Three', now: OPENED, id: 'n_5YRVQW8K2D' });
    const tree = state.manifest.tree;
    const beatNode = tree.splice(
      tree.findIndex((n) => n.id === beat.id),
      1,
    )[0]!;
    tree.splice(
      tree.findIndex((n) => n.id === scene.id),
      0,
      beatNode,
    );

    const report = validateManifest(state.manifest, {
      docFiles: [`${scene.id}.md`, `${beat.id}.md`],
    });
    expect(report.errors, JSON.stringify(report.errors)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('removes the body records of the documents it took, and leaves every other node', () => {
    const h = harness();
    h.run(cmd({ name: 'project.deleteNode', params: { nodeId: CHAPTER_ONE } }));

    // A record with no node is a lie `writeProjectState` would store, and a node
    // with no record fails `writeProject` on the way out. Both are this command's.
    expect(h.state.documents.has(LANDING)).toBe(false);
    expect(h.state.documents.has(STORM)).toBe(false);
    expect(h.state.documents.has(OTHER)).toBe(true);
    expect(children(h.state, CHAPTER_TWO)).toEqual([OTHER]);
    expect(children(h.state, 'manuscript')).toEqual([CHAPTER_TWO]);
  });

  it('drops an attachment that named a removed node and keeps the ones that did not', () => {
    const h = harness();
    h.state.manifest.codex![0]!.attachments = [LANDING, STORM, OTHER];
    h.state.manifest.codex![1]!.attachments = [LANDING];

    const outcome = h.run(cmd({ name: 'project.deleteNode', params: { nodeId: CHAPTER_ONE } }));

    // `read.ts` drops dangling attachment ids at load and says why — an id that
    // does not resolve must not be carried forward. This command knows it is gone.
    expect(attachments(h.state, ENTRY)).toEqual([OTHER]);
    expect(attachments(h.state, ENTRY_TWO)).toEqual([]);
    expect((outcome.result as { detachedCodexEntryIds: string[] }).detachedCodexEntryIds).toEqual([
      ENTRY,
      ENTRY_TWO,
    ]);
  });

  it('restores the subtree, the bodies and the attachments in one click', () => {
    const h = harness();
    const grandchild = withGrandchild(h);
    setBody(h.state, LANDING, 'A later draft.');
    const revisionBefore = h.state.documents.get(LANDING)!.revision;
    h.state.manifest.codex![0]!.attachments = [LANDING, OTHER];
    const treeBefore = h.state.manifest.tree.map((n) => n.id);
    const childrenBefore = children(h.state, CHAPTER_ONE);
    // Identity, parent and sibling order — the three things the format reads.
    // Deliberately *not* the position in the array: the restore appends the removed
    // block, so where it lands in the file changes, and this is the assertion that
    // is evidence for that being cosmetic rather than a claim in a comment.
    const shapeBefore = shapeOf(h.state);

    const outcome = h.run(cmd({ name: 'project.deleteNode', params: { nodeId: CHAPTER_ONE } }));
    expect(compensationsOf(h, outcome.undoGroupId)).toEqual(['restore "Chapter 1" and the 3 nodes under it']);
    h.undoGroup(outcome.undoGroupId!);

    expect(shapeOf(h.state)).toEqual(shapeBefore);
    expect([...h.state.manifest.tree].map((n) => n.id).sort()).toEqual([...treeBefore].sort());
    expect(children(h.state, CHAPTER_ONE)).toEqual(childrenBefore);
    expect(nodeById(h.state, grandchild)?.parentId).toBe(LANDING);
    // The body and the revision both come back: a restore that wrote only the text
    // would leave the document claiming a revision its content never reached, and
    // §6 compares that counter.
    expect(h.state.documents.get(LANDING)?.body).toBe('A later draft.');
    expect(h.state.documents.get(LANDING)?.revision).toBe(revisionBefore);
    expect(h.state.documents.get(grandchild)?.body).toBe('She came back.');
    expect(attachments(h.state, ENTRY)).toEqual([LANDING, OTHER]);
  });

  it('is refused for a fixed root, and removeNode refuses it again on its own', () => {
    const h = harness();
    const refused = refusalOf(
      execute(
        cmd({ name: 'project.deleteNode', params: { nodeId: 'manuscript' } }),
        h.bus,
        createProjectCommandRegistry({ clock }),
      ),
    );
    expect(refused.message).toContain('fixed root');
    expect(nodeById(h.state, CHAPTER_ONE)).toBeDefined();

    // The primitive is the layer that mutates the tree, so the rule cannot live
    // only in the caller that validated: this is the bypass a second caller has.
    expect(() => removeNode(h.state, 'manuscript')).toThrow(/fixed root/);
    expect(() => removeNode(h.state, 'root')).toThrow(/fixed root/);
    expect(() => removeNode(h.state, 'research')).toThrow(/fixed root/);
    expect(children(h.state, 'manuscript')).toEqual([CHAPTER_ONE, CHAPTER_TWO]);
  });

  it('drops the removed ids’ counts and keeps every surviving one — and the undo puts them back', () => {
    // Keeping the removed ids' counts would only be defensible for a field with
    // no producer that nothing reads; `wordCounts` has the writer §9 requires.
    // The second half below pins what does hold: a survivor's stale count is
    // left exactly as it was.
    const h = harness();
    h.state.manifest.derived.wordCounts = { [LANDING]: 812, [STORM]: 7, [OTHER]: 40 };
    const group = h.run(cmd({ name: 'project.deleteNode', params: { nodeId: CHAPTER_ONE } }))
      .undoGroupId!;

    // LANDING and STORM went with the subtree; OTHER did not, and its count is
    // still the stale number it was — §2's "allowed stale" is untouched.
    expect(h.state.manifest.derived.wordCounts).toEqual({ [OTHER]: 40 });

    // And the command that drops them is reversible. Before that change this was not
    // merely untested: `exit-gate.test.ts`'s "snapshotOf(state) === before" is
    // measured red without it, which is what named the gap.
    expect(h.undoGroup(group).failures).toEqual([]);
    expect(h.state.manifest.derived.wordCounts).toEqual({ [LANDING]: 812, [STORM]: 7, [OTHER]: 40 });
  });
});

describe('codex.upsert — one group, every entry compensated inside it', () => {
  it('creates an entry with the defaults codex.md §2 states by name', () => {
    const h = harness();
    const outcome = h.run(
      cmd({
        name: 'codex.upsert',
        params: { entries: [{ action: 'create', name: 'The Lighthouse', type: 'location', description: 'Where it all happens.' }] },
      }),
    );
    const entry = (h.state.manifest.codex ?? []).find((e) => e.id === (outcome.result as { created: string[] }).created[0])!;

    expect(entry.name).toBe('The Lighthouse');
    expect(entry.type).toBe('location');
    expect(entry.description).toBe('Where it all happens.');
    expect(entry.includePolicy).toBe('detected');
    expect(entry.caseSensitive).toBe(false);
    expect(entry.aliases).toEqual([]);
    expect(entry.exclude).toEqual([]);
    expect(entry.keywords).toEqual([]);
    expect(entry.attachments).toEqual([]);
    // A user gesture, so a hand-authored entry — which is what codex.md's canon
    // rule ranks first, so the rule has to be able to tell.
    expect(entry.origin).toBe('manual');
  });

  it('takes origin from issuedBy, and refuses the op that tries to name its own', () => {
    // An agent's `codex.upsert` is §4 `write-confirm`, so it needs a flow fact —
    // here an approved plan, which is also the shape the harness uses. The user
    // path needs nothing, and every other test here relies on that.
    const h = harness({ approvedPlan: true });
    const outcome = h.run(
      cmd({
        name: 'codex.upsert',
        params: { entries: [{ action: 'create', name: 'Elena, second' }] },
        issuedBy: 'agent',
      }),
    );
    const id = (outcome.result as { created: string[] }).created[0]!;
    const entry = (h.state.manifest.codex ?? []).find((e) => e.id === id)!;

    // codex.md §2: the harness owns provenance, so `origin` comes from who issued the
    // command — the context carries it, not the op.
    expect(entry.origin).toBe('agent');

    // **And the op cannot even name it** (silently dropping it would prove the
    // same thing about the *result* while telling the caller `ok`).
    // The stronger half is the second assertion below: a command that tries is
    // refused outright, so no entry exists carrying a provenance nobody chose.
    const h2 = harness({ approvedPlan: true });
    const result = execute(
      cmd({
        name: 'codex.upsert',
        params: { entries: [{ action: 'create', name: 'Elena, second', origin: 'agent' }] },
        issuedBy: 'agent',
      }),
      h2.bus,
      h2.registry,
    );
    expect(result.ok, 'an op naming its own origin must be refused').toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('"origin"');
    // Zero partial effects: the refusal happened in `validate`, before any
    // apply, so the fixture's two seeded entries are untouched — nothing added,
    // nothing renamed, and no compensation owed.
    expect(h2.state.manifest.codex ?? []).toHaveLength(2);
    expect(h2.state.manifest.codex!.map((e) => e.name)).toEqual(['Elena', 'Kestrel']);
    expect(h2.notified, 'a refused command must not notify an outcome').toHaveLength(0);
    // codex.md also requires sources on an agent entry; the op carries no citations, so
    // the list is present and empty rather than absent.
    expect(entry.sources).toEqual([]);
  });

  it('undoes a mixed three-op batch completely, in one click', () => {
    // THE test for this apply. `undo.ts`'s scope holds a single payload, so a
    // per-entry `compensate()` would keep only the last one and a five-op batch
    // would restore one entry. Every single-op test would still pass.
    const h = harness();
    const outcome = h.run(
      cmd({
        name: 'codex.upsert',
        params: {
          entries: [
            { action: 'create', name: 'A New Character', type: 'character' },
            { action: 'update', id: ENTRY, description: 'The keeper, rewritten.', includePolicy: 'always' },
            { action: 'create', name: 'A New Place', type: 'location', attachTo: [LANDING] },
          ],
        },
      }),
    );
    // One group, one compensation — and the label says what the batch did.
    expect(compensationsOf(h, outcome.undoGroupId)).toEqual([
      'undo the 2 created and 1 updated codex entries',
    ]);
    expect(h.state.manifest.codex).toHaveLength(4);
    expect((h.state.manifest.codex ?? []).find((e) => e.id === ENTRY)?.description).toBe('The keeper, rewritten.');

    h.undoGroup(outcome.undoGroupId!);

    // Not "the first op is back": *nothing* this batch wrote is left.
    expect(h.state.manifest.codex).toHaveLength(2);
    expect(h.state.manifest.codex?.map((e) => e.id)).toEqual([ENTRY, ENTRY_TWO]);
    expect(h.state.manifest.codex?.find((e) => e.id === ENTRY)?.description).toBe('The keeper.');
    expect(h.state.manifest.codex?.find((e) => e.id === ENTRY)?.includePolicy).toBe('detected');
  });

  it('unwinds two updates to the same entry to where it started', () => {
    // Reverse order inside the one restore is what makes this work: op 2's copy is
    // the state op 1 left behind, so replaying them backwards lands on the original
    // rather than on op 1's intermediate.
    const h = harness();
    const outcome = h.run(
      cmd({
        name: 'codex.upsert',
        params: {
          entries: [
            { action: 'update', id: ENTRY, description: 'First' },
            { action: 'update', id: ENTRY, type: 'lore' },
            { action: 'update', id: ENTRY, includePolicy: 'never' },
          ],
        },
      }),
    );
    expect((h.state.manifest.codex ?? []).find((e) => e.id === ENTRY)?.type).toBe('lore');

    h.undoGroup(outcome.undoGroupId!);

    const entry = (h.state.manifest.codex ?? []).find((e) => e.id === ENTRY)!;
    expect(entry.description).toBe('The keeper.');
    expect(entry.type).toBe('character');
    expect(entry.includePolicy).toBe('detected');
  });

  it('writes only the fields an update carries, and never flips an origin', () => {
    const h = harness({ approvedPlan: true });
    h.state.manifest.codex![0]!.aliases = ['Lena'];
    h.state.manifest.codex![0]!.keywords = ['protagonist'];
    h.state.manifest.codex![0]!.attachments = [OTHER];

    h.run(
      cmd({
        name: 'codex.upsert',
        // An agent touching a hand-authored entry: codex.md says it appends a source and
        // never flips the origin, and an append it cannot express is a gap, not a
        // licence to rewrite what it did not change.
        params: { entries: [{ action: 'update', id: ENTRY, description: 'The keeper, revised.' }] },
        issuedBy: 'agent',
      }),
    );
    const entry = (h.state.manifest.codex ?? []).find((e) => e.id === ENTRY)!;

    expect(entry.description).toBe('The keeper, revised.');
    expect(entry.aliases).toEqual(['Lena']);
    expect(entry.keywords).toEqual(['protagonist']);
    expect(entry.attachments).toEqual([OTHER]);
    expect(entry.includePolicy).toBe('detected');
    expect(entry.type).toBe('character');
    expect(entry.origin).toBe('manual');
    expect(entry.sources).toEqual([]);
  });

  it('treats detachFrom on a create as inert rather than as an error', () => {
    const h = harness();
    const outcome = h.run(
      cmd({
        name: 'codex.upsert',
        params: {
          entries: [{ action: 'create', name: 'Unattached', attachTo: [LANDING, LANDING], detachFrom: [OTHER] }],
        },
      }),
    );
    const id = (outcome.result as { created: string[] }).created[0]!;
    // §2 types `attachments` as a set, so `[x, x]` is one id — and a list of ids
    // nothing is attached to, on a brand-new entry, is inert rather than a fault.
    expect(attachments(h.state, id)).toEqual([LANDING]);

    h.undoGroup(outcome.undoGroupId!);
    expect((h.state.manifest.codex ?? []).map((e) => e.id)).toEqual([ENTRY, ENTRY_TWO]);
  });

  it('refuses a bare create before the apply, so no nameless entry is written', () => {
    // The apply is total: a nameless, typeless create would write `name: ''`,
    // which the next load would refuse. codex.md §2 makes the name required, so the
    // bus now refuses the op in `validate` (bus validate, "refuses a create with no
    // name"). Nothing reaches the apply, so the apply's `''` default is unreachable
    // from here; the `type` default below is what this test still pins.
    const h = harness();
    const before = (h.state.manifest.codex ?? []).length;
    const refused = refusalOf(
      execute(
        cmd({ name: 'codex.upsert', params: { entries: [{ action: 'create' }] } }),
        h.bus,
        createProjectCommandRegistry({ clock }),
      ),
    );
    expect(refused.message).toContain('name is required on create');
    expect(h.state.manifest.codex ?? []).toHaveLength(before);
  });

  it('defaults an unspecified type to the enum\'s "none of the above" member, for a named create', () => {
    // codex.md §2's `type` enum has no default, but `CodexEntry.type` is required,
    // and `'other'` is the member that means "unclassified". This is the surviving
    // half — the type default — now asserted on a create that names itself.
    const h = harness();
    const outcome = h.run(cmd({ name: 'codex.upsert', params: { entries: [{ action: 'create', name: 'Unfiled' }] } }));
    const id = (outcome.result as { created: string[] }).created[0]!;
    const entry = (h.state.manifest.codex ?? []).find((e) => e.id === id)!;

    expect(entry.name).toBe('Unfiled');
    expect(entry.type).toBe('other');
    expect(entry.origin).toBe('manual');
    expect(entry.description).toBe('');
  });

  // The apply used to write `sources: []` on every create, so the
  // citations the extraction recorded were checked by nothing and stored nowhere.
  // A create keeps the ones it carries; an update adds to the entry's own.
  it('stores the citations a create carries, and an update appends to them', () => {
    const h = harness();
    // Verbatim slices of the landing body, "The ferry was late, as always.", at the
    // offsets they name (codex.md §2; the bus checks each quote against the body).
    const citation = { docId: LANDING, quote: 'The ferry was late,', from: 0, to: 19, extractedAt: '2026-10-01T00:00:00.000Z' };
    const later = { docId: LANDING, quote: 'as always', from: 20, to: 29, extractedAt: '2026-10-01T00:00:00.000Z' };
    const created = h.run(cmd({ name: 'codex.upsert', params: { entries: [{ action: 'create', name: 'Wren', sources: [citation] }] } }));
    const id = (created.result as { created: string[] }).created[0]!;
    expect((h.state.manifest.codex ?? []).find((e) => e.id === id)?.sources).toEqual([citation]);

    h.run(cmd({ name: 'codex.upsert', params: { entries: [{ action: 'update', id, sources: [later] }] } }));
    const entry = (h.state.manifest.codex ?? []).find((e) => e.id === id)!;
    expect(entry.sources).toEqual([citation, later]);
    expect(entry.origin).toBe('manual');
  });

  it('refuses the whole batch when one op is bad, and writes nothing', () => {
    const h = harness();
    const refused = refusalOf(
      execute(
        cmd({
          name: 'codex.upsert',
          params: {
            entries: [
              { action: 'create', name: 'Fine' },
              { action: 'update', id: 'c_MISSING0000', description: 'nope' },
            ],
          },
        }),
        h.bus,
        createProjectCommandRegistry({ clock }),
      ),
    );
    expect(refused.message).toContain('batch refused');
    expect(refused.correctiveHint).toContain('nothing was written');
    expect(h.state.manifest.codex).toHaveLength(2);
  });
});

describe('the bus/store split these applies depend on', () => {
  const IMPLEMENTED = [
    'binder.create',
    'binder.move',
    'binder.rename',
    'binder.setMeta',
    'binder.setSynopsis',
    'codex.attach',
    'codex.upsert',
    'project.deleteNode',
  ] as const;

  it('resolves all eight structure names in the store registry', () => {
    const registry = createProjectCommandRegistry({ clock });
    for (const name of IMPLEMENTED) {
      expect(registry[name].apply, name).toBeTypeOf('function');
    }
  });

  it('leaves the bus registry refusing them — the bus has no project state to apply them to', () => {
    for (const name of IMPLEMENTED) {
      const refused = refusalOf(resolveCommand(name));
      expect(refused.code, name).toBe('internal');
      expect(refused.message, name).toContain('has no implementation in this build');
    }
  });

  it('keeps §9\'s closed set at twenty names, and without an exporter only the two export names are left', () => {
    const registry = createProjectCommandRegistry({ clock });
    const implemented = Object.values(registry).filter((entry) => entry.apply !== undefined);
    // Five `view.*` (three, `view.setExpanded` and
    // `view.setCorkboardScope`), the six `inverse` names (including
    // `binder.create`), the five `compensable` text names, and
    // `codex.upsert` and `project.deleteNode`. What remains is `export.compile`
    // and `export.compileSelection`: the exporter ships their applies, but they register
    // only when an exporter is injected (export-commands.test.ts), and none is
    // here. The count is the thing that would move if a slice quietly implemented
    // the wrong names.
    //
    // The coherence module adds two names (coherence.md §7.1): `coherence.setSceneMeta` and
    // `coherence.setFindingStatus`. Their applies live here with the rest of the project's, so they
    // are implemented without an exporter. Twenty-two names in all, twenty of them implemented.
    // `mcp.invoke` (extensibility §6) and the storyboard module's three shot commands come next. Each is
    // descriptor-only until its injected half is supplied (`mcpInvoke`, `shots`), so the implemented count is the same.
    // Project export adds seven names: 26 + 7 = 33 keys. Six of them have applies that need no injected port
    // (project.rename, project.setMetadata, vocabulary.upsert, vocabulary.remove, recipe.save, recipe.delete), so the
    // implemented count is 20 + 6 = 26. project.importAsset is implemented only once the asset port is injected.
    // Saved filters and goals add four names (binder.saveFilter, binder.deleteFilter, project.saveGoal,
    // project.deleteGoal), whose store applies are always injected here: 33 + 4 = 37 keys, and 26 + 4 = 30 implemented.
    // The run history adds `coherence.discardRun` (coherence.md §7.1), implemented without an exporter: 38 names, 31 implemented.
    // The storyboard's image import adds `shot.importImage`, descriptor-only until both its ports are injected: 38 + 1 = 39
    // keys, and the implemented count stays 31, because the registry here is built with neither. The script imports add
    // `screenplay.import`,
    // `dialogue.importInk` and `dialogue.setMeta`, whose applies are the store's own: 39 + 3 = 42 names, 31 + 3 = 34 implemented.
    expect(Object.keys(registry)).toHaveLength(42);
    expect(implemented).toHaveLength(34);
  });
});
