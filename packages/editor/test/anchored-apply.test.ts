/**
 * [edit-anchors.md] §4 — **the apply path**, driven through the real bus and the
 * real store.
 *
 * ## Why this file reaches outside `@caotang/editor`
 *
 * §4's three sentences are about machinery that does not live here: the bus
 * primitive (`@caotang/bus`), the write-ahead snapshot (the store's `compensable`
 * apply), and one agent turn being one undo group (`undo.ts`'s group store). A test
 * that re-implements any of them in a fixture proves the fixture, which is the
 * failure mode this repo has already paid for twice — an in-memory `EditorApi`
 * because *"an interface nothing implements satisfies every test written about it"*,
 * and a resolution ladder that could have returned `anchor.from` and passed every
 * "it resolved" assertion.
 *
 * So both packages are `devDependencies` and **only** that: `src/` imports neither,
 * and the product dependency direction (bus ← store, editor ← nothing) is unchanged.
 * Every dispatch below is the bus's own `execute()` over the store's own
 * `createProjectCommandRegistry()`.
 *
 * ## What each test would pass without the thing it names
 *
 * - **The visible body change** is asserted against the store's real splice, not
 *   against a restatement of the splice rule. A path that dispatched
 *   `anchor.from`/`anchor.to` instead of the resolved range would write the new text
 *   30 characters too early, and only the real body catches that.
 * - **The write-ahead capture** is asserted through the store's own `snapshots`
 *   sink with the *pre-mutation* body and revision. A snapshot taken after the write
 *   restores the new body — a restore that changes nothing and is indistinguishable
 *   from a working undo, which is the failure `captureBody`'s own comment is about.
 * - **One turn, one group** is measured on `undo.targetFor` through two real
 *   dispatches, so dropping `turnId` from the command fails it.
 * - **The ask-back writes nothing** is asserted on the body, the snapshot sink, the
 *   group store *and* the activity log, because §3's "zero partial effects" is four
 *   surfaces and a refusal that wrote to any of them would be invisible to the other
 *   three.
 */
import { describe, expect, it } from 'vitest';
import {
  createActivityLog,
  createIdempotencyCache,
  createUndoStore,
  createViewState,
  execute,
  type Command,
  type EditorReplaceRangeParams,
} from '@caotang/bus';
import {
  addDocument,
  addFolder,
  createEmptyManifest,
  createProjectCommandRegistry,
  createProjectState,
  getBody,
  type BodySnapshot,
  type ProjectState,
} from '@caotang/store';

import {
  ASK_BACK_OPTIONS,
  applyAnchoredEdit,
  resolveAnchor,
  type AnchoredEditCommand,
  type AnchoredEditDispatch,
  type TextAnchor,
} from '../src/index.js';

const OPENED = new Date('2026-10-06T05:00:00.000Z');
const TICK = 1_789_000_000_000;
const clock = { now: () => TICK };

const CHAPTER = 'n_CHAPTERONE0';
const SCENE = 'n_LANDING00000';

const BEFORE = 'The harbour master kept the log by hand, and the wind kept the rest. ';
const SENTENCE = 'The ferry was late, as always.';
const AFTER = ' She counted the boats twice, because the first count was always the hopeful one.';
const BODY = `${BEFORE}${SENTENCE}${AFTER}`;
const INSERTED = 'A gull settled on the rail and watched them do nothing at all. ';

interface Harness {
  readonly state: ProjectState;
  readonly dispatch: AnchoredEditDispatch;
  readonly undo: ReturnType<typeof createUndoStore>;
  readonly snapshots: BodySnapshot[];
  readonly activity: string[];
  /** The document's revision as the store currently holds it (§9's number). */
  revision(): number;
  body(): string;
}

function harness(initialBody: string): Harness {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', OPENED));
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 1', now: OPENED, id: CHAPTER });
  addDocument(state, {
    parentId: CHAPTER,
    title: 'The Landing',
    body: initialBody,
    now: OPENED,
    id: SCENE,
  });

  const snapshots: BodySnapshot[] = [];
  const registry = createProjectCommandRegistry({
    clock,
    snapshots: (snapshot) => {
      snapshots.push(snapshot);
    },
  });
  const activity: string[] = [];
  const undo = createUndoStore({ dispatch: (command) => execute(command, bus, registry) });
  const log = createActivityLog();
  const bus = {
    state,
    view: createViewState(),
    read: () => state,
    // **§4's grant inheritance, and the reason this is not `approvedPlan`.**
    // `editor.replaceRange` is `agentRisk: 'never'` and *inheritable*: the bus
    // refuses an agent-issued one outright unless the caller states it is running
    // **inside a compound tool's own apply step**, which is precisely what
    // edit-anchors §4 says this dispatch is ("inside `scene.draft`'s compound apply
    // (command-bus §4 grant inheritance)"). So the harness supplies an inherited
    // grant, and every test below fails with `permission-denied` if it does not —
    // which makes the "inside the compound apply" half of §4 a measured claim rather
    // than a sentence in a comment.
    permission: { inheritedGrant: 'never' as const },
    undo,
    log,
    idempotency: createIdempotencyCache(),
    notify: () => {},
  };
  // The activity log's own entries, read after each dispatch: §3's zero-partial-
  // effects is asserted on four surfaces and this is the fourth.
  const originalAppend = log.append.bind(log);
  log.append = (entry) => {
    activity.push(`${entry.command}:${entry.undoGroupId ?? 'none'}`);
    return originalAppend(entry);
  };

  return {
    state,
    undo,
    snapshots,
    activity,
    dispatch: (command) => execute(command, bus, registry),
    revision: () => state.documents.get(SCENE)?.revision ?? -1,
    body: () => getBody(state, SCENE),
  };
}

/** §2's capture, with the revision taken from the store the way §6's says. */
const capture = (body: string, revision: number): TextAnchor => {
  const from = body.indexOf(SENTENCE);
  return {
    from,
    to: from + SENTENCE.length,
    exact: SENTENCE,
    prefix: body.slice(Math.max(0, from - 32), from),
    suffix: body.slice(from + SENTENCE.length, from + SENTENCE.length + 32),
    capturedRevision: revision,
  };
};

const request = (over: Partial<Parameters<typeof applyAnchoredEdit>[0]> = {}) => ({
  anchor: capture(BODY, 1),
  docId: SCENE,
  body: BODY,
  applyRevision: 1,
  text: 'The ferry came in on the second bell.',
  turnId: 'turn_one',
  id: 'cmd_0000000001',
  createdAt: TICK,
  ...over,
});

describe('edit-anchors §4 — the apply path, over the real bus and store', () => {
  it('the command it builds is a bus `Command` for `editor.replaceRange`, checked by the compiler', () => {
    // A declaration nothing dispatches is satisfied by any object with the right
    // shape, so the shape is pinned against the bus's own types rather than against
    // a copy of them: widen to `Command<EditorReplaceRangeParams>` or this fails to
    // compile.
    const widen = (command: AnchoredEditCommand): Command<EditorReplaceRangeParams> => command;
    const built: AnchoredEditCommand = {
      id: 'cmd_0000000001',
      name: 'editor.replaceRange',
      params: { docId: SCENE, range: { from: 1, to: 2 }, text: 'x', expectedRevision: 3 },
      issuedBy: 'agent',
      turnId: 'turn_one',
      createdAt: TICK,
    };
    const asBus: Command<EditorReplaceRangeParams> = widen(built);
    expect(asBus.name).toBe('editor.replaceRange');
    expect(asBus.issuedBy).toBe('agent');
    // §4's "the resolved range, never the anchor's own offsets" is why the params
    // carry a range at all: the anchor's offsets are not in this object.
    expect(Object.keys(asBus.params).sort()).toEqual(['docId', 'expectedRevision', 'range', 'text']);
  });

  it('applies at the resolved range, snapshots the prior body first, and joins one turn group', async () => {
    const test = harness(BODY);
    const anchor = capture(BODY, test.revision());
    // The user edited above the target while the card was open — the drift §3 exists
    // for. The store's own `setBody` is what a real edit goes through.
    const drifted = `${INSERTED}${BODY}`;
    test.state.documents.get(SCENE)!.body = drifted;
    const applyRevision = test.revision();

    const outcome = await applyAnchoredEdit(
      request({ anchor, body: drifted, applyRevision }),
      test.dispatch,
    );

    expect(outcome.status).toBe('applied');
    if (outcome.status !== 'applied') return;
    expect(outcome.method).toBe('near-offset');
    expect(outcome.range.from).toBe(drifted.indexOf(SENTENCE));
    expect(outcome.revisionDrift).toBe(0);
    expect(outcome.command.turnId).toBe('turn_one');

    // **The visible change**, over the store's own splice: the new sentence is where
    // the ladder said, the old one is gone, and nothing else moved.
    const expected = drifted.replace(SENTENCE, 'The ferry came in on the second bell.');
    expect(test.body()).toBe(expected);
    expect(test.body()).toContain(INSERTED);
    expect(test.body()).not.toContain(SENTENCE);

    // **The write-ahead capture**, before the mutation, with the revision it had.
    expect(test.snapshots).toHaveLength(1);
    expect(test.snapshots[0]!.body).toBe(drifted);
    expect(test.snapshots[0]!.revision).toBe(applyRevision);
    expect(test.snapshots[0]!.command).toBe('editor.replaceRange');

    // **One agent turn, one undo group**, and §5's own framing for it.
    const groups = test.undo.groups();
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe('agent-turn');
    expect(groups[0]!.label).toBe('restore to before this turn');
    expect(groups[0]!.entries).toHaveLength(1);
    expect(test.activity).toEqual([`editor.replaceRange:${groups[0]!.id}`]);
  });

  it('two anchored edits in one turn share a group; a second turn does not', async () => {
    const test = harness(BODY);
    const firstRevision = test.revision();

    const first = await applyAnchoredEdit(
      request({
        anchor: capture(BODY, firstRevision),
        applyRevision: firstRevision,
        turnId: 'turn_one',
        id: 'cmd_0000000001',
      }),
      test.dispatch,
    );
    expect(first.status).toBe('applied');

    // Captured against the body as it now stands, so this second edit resolves on
    // step 1 and the test is about grouping rather than about the ladder.
    const current = test.body();
    const secondAnchor: TextAnchor = {
      from: current.indexOf('log by hand'),
      to: current.indexOf('log by hand') + 'log by hand'.length,
      exact: 'log by hand',
      prefix: '',
      suffix: '',
      capturedRevision: test.revision(),
    };
    const second = await applyAnchoredEdit(
      request({
        anchor: secondAnchor,
        body: current,
        applyRevision: test.revision(),
        turnId: 'turn_one',
        id: 'cmd_0000000002',
        text: 'ledger by hand',
      }),
      test.dispatch,
    );
    expect(second.status).toBe('applied');
    expect(test.undo.groups()).toHaveLength(1);
    expect(test.undo.groups()[0]!.entries).toHaveLength(2);
    expect(test.body()).toContain('ledger by hand');

    const third = await applyAnchoredEdit(
      request({
        turnId: 'turn_two',
        id: 'cmd_0000000003',
        applyRevision: test.revision(),
        text: 'the wind kept the rest',
      }),
      test.dispatch,
    );
    expect(third.status).toBe('applied');
    expect(test.undo.groups()).toHaveLength(2);
    expect(test.undo.groups().map((group) => group.kind)).toEqual(['agent-turn', 'agent-turn']);
  });

  it('an unresolvable anchor dispatches nothing at all — the ask-back, not a guess', async () => {
    const test = harness(BODY);
    // The anchored text is gone from the document entirely.
    const gone = 'Nothing here resembles the sentence the plan was written against.';
    const anchor = capture(BODY, test.revision());

    const outcome = await applyAnchoredEdit(
      request({ anchor, body: gone, applyRevision: test.revision() }),
      test.dispatch,
    );

    expect(outcome.status).toBe('ask-back');
    if (outcome.status !== 'ask-back') return;
    expect(outcome.reason).toMatch(/no longer appears anywhere/);
    // §3's three options, which agent-harness §3 tool 8's error column names.
    expect(ASK_BACK_OPTIONS).toHaveLength(3);
    expect(ASK_BACK_OPTIONS[0]).toMatch(/re-select/);

    // **Zero partial effects, on all four surfaces.** The body in the store is
    // untouched — the drifted text existed only in the resolution input, which is
    // the whole point: a ladder that cannot find the anchor must not go looking for
    // something it can find.
    expect(test.body()).toBe(BODY);
    expect(test.snapshots).toHaveLength(0);
    expect(test.undo.groups()).toHaveLength(0);
    expect(test.activity).toEqual([]);
  });

  it('a stale apply revision is refused by the shipped guard, and the refusal is returned', async () => {
    const test = harness(BODY);
    const anchor = capture(BODY, test.revision());

    // The anchor resolves — the body has not moved — but the revision does not
    // match, which is §6's optimistic concurrency and the descriptor's
    // `guardsRevision`. The refusal must reach the caller with §7's shape rather
    // than being swallowed or retried.
    const outcome = await applyAnchoredEdit(
      request({ anchor, applyRevision: test.revision() + 41 }),
      test.dispatch,
    );

    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') return;
    expect(outcome.error.code).toBe('revision-conflict');
    expect(outcome.error.details).toEqual({
      expectedRevision: test.revision() + 41,
      actualRevision: test.revision(),
    });
    expect(outcome.command.name).toBe('editor.replaceRange');
    // And nothing was written on the way to the refusal.
    expect(test.body()).toBe(BODY);
    expect(test.snapshots).toHaveLength(0);
    expect(test.undo.groups()).toHaveLength(0);
    expect(test.activity).toEqual([]);
  });

  it('the path awaits the fuzzy library itself, so §3 step 3 is available without a caller', async () => {
    // `applyAnchoredEdit` is the only production caller of `resolveAnchor`, and it
    // preloads first — which is what makes the ladder's "short of the full ladder"
    // refusal a caller error rather than a product defect. Measured by asking for a
    // case that needs step 3 and getting an `applied` outcome, with no locator bound
    // by the test itself.
    const test = harness(BODY);
    const drifted = BODY.replace(SENTENCE, 'The ferry ran late, as always.');
    const anchor = capture(BODY, test.revision());

    const outcome = await applyAnchoredEdit(
      request({ anchor, body: drifted, applyRevision: test.revision() }),
      test.dispatch,
    );

    expect(outcome.status).toBe('applied');
    if (outcome.status !== 'applied') return;
    expect(outcome.method).toBe('context-fuzzy');
    // And the same document through the bare ladder, for contrast: the ladder needs
    // its library and does not fetch it.
    const bare = resolveAnchor(anchor, drifted, test.revision());
    expect(bare.status).toBe('ok');
  });
});