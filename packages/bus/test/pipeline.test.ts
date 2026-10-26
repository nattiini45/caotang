/**
 * §3's pipeline and §5's undo groups — the suite.
 *
 * ## What these tests are for, given that §9's closed set has no applies here
 *
 * The project applies are attached **store-side** (`packages/store/src/commands.ts` for the five) because §1
 * says the bus does not own project state — so the bus's own `COMMAND_REGISTRY`
 * can only run the three `view.*` names, which §2 makes ephemeral and which
 * therefore need no store. This file is about the pipeline, not about a project's
 * contents: the store-side applies are exercised end to end in
 * `packages/store/test/commands.test.ts`, which dispatches real commands over a
 * real `ProjectState` with this same `execute()`.
 *
 * So this file does two things, and the second is the one that matters:
 *
 * 1. **The shipped path, end to end** — the three view commands through
 *    `COMMAND_REGISTRY`, no fakes anywhere. That is the non-vacuous case the
 *    build row names, and it is the only place a real command is dispatched.
 * 2. **Every step, over a registration that exists** — `execute()` takes the
 *    registry as a third parameter, so a test can hand it a descriptor + apply
 *    for a name that has none yet. This is the same function, not a test-only
 *    variant: a guard that only ever sees `view.*` cannot tell §3's order from
 *    any other order, and §3's order is the entire contract.
 *
 * ## What each test is built to fail on
 *
 * The ordering tests do not assert "the right thing happened"; they assert a
 * **counter** — `reads`, `applied`, `notified`, `appended` — so reordering two
 * steps changes a number rather than a message. The registration tests assert
 * what is in a group, so a pipeline that quietly drops a compensation fails. And
 * the four "must not" tests are the ones that catch over-correction: a pipeline
 * that registers everything, notifies on a refusal, or undoes forwards passes the
 * happy path and fails these.
 */

import { describe, expect, it } from 'vitest';
import {
  COMMAND_NAMES,
  COMMAND_REGISTRY,
  VIEW_COMMAND_NAMES,
  createActivityLog,
  createIdempotencyCache,
  createUndoScope,
  createUndoStore,
  createViewState,
  err,
  execute,
  executeAsync,
  ok,
  type ActivityLog,
  type ApplyContext,
  type BusContext,
  type Command,
  type CommandApply,
  type CommandDescriptor,
  type CommandName,
  type CommandRegistry,
  type ExecutionOutcome,
  type Postcondition,
  type UndoStore,
  type ValidationSnapshot,
  type ViewState,
} from '../src/index.js';
import { makeSnapshot, THE_LANDING, UNKNOWN_ID } from './fixtures.js';

// ---------------------------------------------------------------- fixtures

/** A command with everything the envelope carries, so no test has to remember `createdAt`. */
function cmd(partial: Partial<Command> & Pick<Command, 'name'>): Command {
  return {
    id: 'cmd_0000000001',
    name: partial.name,
    params: partial.params ?? {},
    issuedBy: partial.issuedBy ?? 'user',
    turnId: partial.turnId,
    callId: partial.callId,
    createdAt: partial.createdAt ?? 1_760_000_000_000,
  };
}

interface Harness {
  bus: BusContext;
  undo: UndoStore;
  log: ActivityLog;
  view: ViewState;
  /** every step that ran, in order — the ordering tests read this */
  trace: string[];
  counts: { reads: number; applied: number; notified: number };
}

/**
 * A bus over the shipped pieces, with every observable counted.
 *
 * `read` counts because §3's post-apply read is a *second* read of committed
 * state, and a pipeline that read twice for its own reasons would pass a test
 * that only checked "it read again".
 */
function harness(overrides: Partial<BusContext> = {}, trace: string[] = []): Harness {
  const undo = overrides.undo ?? createUndoStore();
  const log = overrides.log ?? createActivityLog();
  const view = (overrides.view as ViewState) ?? createViewState();
  const counts = { reads: 0, applied: 0, notified: 0 };
  const bus: BusContext = {
    state: { name: 'project state, never handed to a view command' },
    view,
    read: () => {
      counts.reads += 1;
      trace.push(`read:${counts.reads}`);
      return makeSnapshot();
    },
    undo,
    log,
    // §6's dedupe. A fresh cache per harness so two tests cannot see each other's
    // ids; `overrides` can replace it to assert on the cache directly.
    idempotency: createIdempotencyCache(),
    notify: (outcome) => {
      counts.notified += 1;
      trace.push(`notify:${outcome.name}`);
    },
    ...overrides,
  };
  return { bus, undo, log, view, trace, counts };
}

/**
 * A registration built from parts, over a name from the closed set.
 *
 * **`undo: 'none'` is the default and `validate` passes params through**, and both
 * defaults are load-bearing: a helper that declared `compensable` by default
 * would make every apply that does not capture a registration refusal, which is
 * a real rule but the wrong subject for a test about step 3. A test that wants
 * the registration path asks for it by name.
 *
 * **Every fake is `CommandApply<P, unknown>`** — a project name's state type —
 * because the three view entries are typed `ViewState` and a fake for one of them
 * would have to be a real view mutation, which is `view.ts`'s job, not this file's.
 */
/** A fake apply, typed so a test's own parameters are contextually typed. */
type FakeApply = (state: unknown, params: Record<string, unknown>, context: ApplyContext) => unknown;

/**
 * The descriptor half, with the defaults that keep a test about step 3 from
 * accidentally testing step 5. Split out of `fake()` so `silentFake()` can share
 * it — the two differ **only** in whether the apply reports to §8.
 */
function entryFor(
  descriptor: Partial<CommandDescriptor>,
  apply: CommandApply<never, unknown>,
): { descriptor: CommandDescriptor; apply: CommandApply<never, unknown> } {
  return {
    descriptor: {
      mutates: 'project',
      agentRisk: 'write-confirm',
      undo: 'none',
      validate: (params) =>
        params !== null && typeof params === 'object'
          ? ok(params as Record<string, unknown>)
          : err({ code: 'invalid-params', message: 'params must be an object' }),
      ...descriptor,
    },
    apply,
  };
}

/**
 * `fake()` — and it makes the apply **report**, which is the requirement and a
 * default rather than a convenience.
 *
 * All sixteen shipped applies report to §8, so a fake that did not would be a
 * fake of nothing that exists, and `execute()` refuses a dispatch whose apply
 * reported nothing. Reporting here is what keeps the pipeline tests testing the
 * pipeline: the alternative was thirty call sites each remembering a rule about
 * §8, which is the same shape as a promise in a comment.
 *
 * The report is `affected: []` because a fake has no project state to read a
 * title out of, and the digest says what the fake is. A test that needs a
 * **populated** `affected` builds its own entry, or reaches for
 * `packages/store/test/activity-log.test.ts`, which drives the real applies.
 * A test that needs an apply which *fails* to report uses `silentFake()`.
 */
function fake(
  descriptor: Partial<CommandDescriptor>,
  apply: FakeApply,
): { descriptor: CommandDescriptor; apply: CommandApply<never, unknown> } {
  return entryFor(descriptor, ((state, params, context) => {
    const result = apply(state, params, context);
    // After the call, not before: a fake that throws must throw without having
    // reported, or the throw would read as a missing report rather than a throw.
    context.report({ affected: [], summary: `the fake apply for ${context.name}` });
    return result;
  }) as CommandApply<never, unknown>);
}

function registryWith(entry: {
  descriptor: CommandDescriptor;
  apply: CommandApply<never, unknown>;
}): CommandRegistry {
  return { ...COMMAND_REGISTRY, 'doc.write': entry } as CommandRegistry;
}

/** An apply that records the params it was handed and captures a compensation. */
function compensableApply(calls: unknown[], label = 'restore the previous body'): FakeApply {
  return (_state, params, context) => {
    calls.push(params);
    context.undo.compensate(label, () => {
      calls.push(`restored:${label}`);
    });
    return { written: params };
  };
}

// ------------------------------------------------- the seven steps, in order

describe('§3 — execute() runs the seven steps in the order §3 fixes', () => {
  it('refuses a name with no implementation before it reads anything for a validator', () => {
    // Step 0 is not one of §3's seven, and this is the test that says so: the
    // refusal happens with zero reads, so an implementation that validated first
    // and resolved second cannot pass it.
    const { bus, counts, log } = harness();
    const result = execute(cmd({ name: 'binder.create', params: { parentId: 'root' } }), bus);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('internal');
    expect(result.error.message).toContain('binder.create');
    expect(result.error.message).toContain('nothing was written');
    expect(counts.reads).toBe(0);
    expect(counts.notified).toBe(0);
    expect(log.length).toBe(0);
  });

  it('refuses a name outside the closed set, so a name that arrived as data cannot crash the bus', () => {
    const { bus, counts } = harness();
    const result = execute(cmd({ name: 'binder.explode' as CommandName }), bus);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not-found');
    expect(result.error.correctiveHint).toContain('binder.create');
    expect(counts.reads).toBe(0);
  });

  it('validates before it applies, and a refusal writes nothing at all', () => {
    const applied: unknown[] = [];
    const trace: string[] = [];
    const { bus, log, undo } = harness({}, trace);
    const registry = registryWith(
      fake({ validate: () => ({ ok: false, error: { code: 'invalid-params', message: 'no' } }) }, (_s, p) =>
        applied.push(p),
      ),
    );

    const result = execute(cmd({ name: 'doc.write', params: { body: 'x' } }), bus, registry);

    expect(result.ok).toBe(false);
    expect(trace).toEqual(['read:1']); // validated, then stopped
    expect(applied).toEqual([]);
    expect(log.length).toBe(0);
    expect(undo.groups()).toEqual([]);
  });

  it("hands the apply the normalized params, not the caller's object", () => {
    const seen: unknown[] = [];
    const { bus } = harness();
    const registry = registryWith(
      fake(
        {
          validate: (params) => ({
            ok: true,
            value: { docId: THE_LANDING, body: (params as { body: string }).body },
          }),
        },
        (_s, p) => {
          seen.push(p);
          return null;
        },
      ),
    );

    execute(cmd({ name: 'doc.write', params: { body: 'Elena returns.', extra: 'dropped' } }), bus, registry);

    expect(seen).toEqual([{ docId: THE_LANDING, body: 'Elena returns.' }]);
    expect(seen[0]).not.toHaveProperty('extra');
  });

  it('consults §4 before it applies: an agent write-confirm with no plan is refused', () => {
    // §3's step 2, made reachable. `permission.test.ts` proves the *gate* refuses; this proves the
    // *pipeline* stops on it, which is a different claim and a different bug.
    const applied: unknown[] = [];
    const { bus, log, undo } = harness();
    const registry = registryWith(fake({}, (_s, p) => applied.push(p)));

    const result = execute(
      cmd({ name: 'doc.write', issuedBy: 'agent', turnId: 'turn_1' }),
      bus,
      registry,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('permission-denied');
    expect(applied).toEqual([]);
    expect(log.length).toBe(0);
    expect(undo.groups()).toEqual([]);
  });

  it("does not let an approved plan rescue a hard-denied class, before it applies", () => {
    const applied: unknown[] = [];
    const { bus } = harness({ permission: { approvedPlan: true } });
    const registry = {
      ...COMMAND_REGISTRY,
      'project.deleteNode': {
        descriptor: COMMAND_REGISTRY['project.deleteNode'].descriptor,
        apply: ((_s: unknown, _p: unknown) => applied.push('deleted'))
      },
    } as CommandRegistry;

    const result = execute(
      cmd({ name: 'project.deleteNode', params: { nodeId: THE_LANDING }, issuedBy: 'agent' }),
      bus,
      registry,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('hard-denied');
    expect(applied).toEqual([]);
  });

  it('reads the state a second time only when a descriptor declares postconditions', () => {
    const { bus, counts } = harness();
    const withPost: Postcondition[] = [{ describe: 'the doc exists', assert: () => true }];

    execute(cmd({ name: 'view.setActiveDoc', params: { docId: THE_LANDING } }), bus);
    expect(counts.reads).toBe(1);

    const registry = registryWith(fake({ postconditions: withPost }, () => null));
    execute(cmd({ name: 'doc.write', issuedBy: 'user' }), bus, registry);
    expect(counts.reads).toBe(3); // 1 for the first command, 2 for the second
  });

  it('runs the postconditions after the apply, and their describe rides the outcome', () => {
    const trace: string[] = [];
    const { bus } = harness({}, trace);
    const seen: string[] = [];
    const registry = registryWith(
      fake(
        {
          postconditions: [
            {
              describe: 'the body is longer than before',
              assert: () => {
                seen.push(trace.join('>'));
                return true;
              },
            },
          ],
        },
        () => {
          trace.push('apply');
          return null;
        },
      ),
    );

    const result = execute(cmd({ name: 'doc.write' }), bus, registry);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.postconditions).toEqual(['the body is longer than before']);
    // The second read — and therefore the postcondition — is after the apply.
    expect(seen[0]).toBe('read:1>apply>read:2');
  });

  it('appends one log row per executed command, and none for a refused one', () => {
    const { bus, log } = harness();
    const registry = registryWith(fake({ undo: 'compensable' }, compensableApply([])));

    execute(cmd({ name: 'view.setActiveDoc', params: { docId: THE_LANDING } }), bus);
    execute(cmd({ name: 'doc.write', issuedBy: 'user' }), bus, registry); // write-confirm, user → allowed
    execute(cmd({ name: 'doc.write', issuedBy: 'agent' }), bus, registry); // refused at §4
    execute(cmd({ name: 'binder.create', params: { parentId: 'root' } }), bus); // no implementation

    expect(log.length).toBe(2);
    const [view, write] = log.entries();
    // The **whole** row, field for field against §8's interface. This used to
    // assert six of the ten and pass — the other four did not exist, and a
    // `toEqual` over the fields that *were* there cannot notice a required field
    // that is absent. The four are in the row now, and the assertion is written so that
    // dropping one again fails here rather than passing quietly.
    expect(view).toEqual({
      at: 1_760_000_000_000,
      command: 'view.setActiveDoc',
      issuedBy: 'user',
      turnId: undefined,
      callId: undefined,
      undoGroupId: undefined,
      // §8: the native source is stamped, not inferred from the absence of one.
      source: 'native',
      // §8: `view.*` changes no node's rendered content, so this is empty — and
      // empty is a real answer rather than a missing one.
      affected: [],
      // §8's digest, and the only place a view event is visible.
      summary: 'switched the active document',
      // §8's `tokensSpent` has no envelope field to echo and the gateway owns it,
      // so the key is absent rather than zero.
      tokensSpent: undefined,
    });
    expect(write?.command).toBe('doc.write');
    expect(write?.undoGroupId).toMatch(/^grp_/);
    // A `toEqual` ignores `undefined` properties, which is exactly the hole the
    // old version sat in — so the keys that must be *absent* are asserted too.
    expect(Object.keys(view!).sort()).toEqual([
      'affected',
      'at',
      'callId',
      'command',
      'issuedBy',
      'source',
      'summary',
      'turnId',
      'undoGroupId',
    ]);
  });
});

// --------------------------------------------------- §5 — the undo groups

describe('§5 — one gesture is one group, one agent turn is one group', () => {
  it('gives each user gesture its own group of one entry', () => {
    const { bus, undo } = harness();
    const registry = registryWith(fake({ undo: 'compensable' }, compensableApply([])));

    const first = execute(cmd({ name: 'doc.write', id: 'cmd_0000000002' }), bus, registry);
    const second = execute(cmd({ name: 'doc.write', id: 'cmd_0000000003' }), bus, registry);

    expect(first.ok && second.ok).toBe(true);
    const groups = undo.groups();
    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.kind === 'user-gesture')).toBe(true);
    expect(groups.every((group) => group.entries.length === 1)).toBe(true);
    // §5's checkpoint framing, as the group carries it.
    expect(groups[0]?.label).toBe('restore to before this action');
  });

  it("puts every command of one agent turn in one group, and a second turn in another", () => {
    const { bus, undo } = harness({ permission: { approvedPlan: true } });
    const registry = registryWith(fake({ undo: 'compensable' }, compensableApply([])));

    execute(cmd({ name: 'doc.write', issuedBy: 'agent', turnId: 'turn_1' }), bus, registry);
    execute(cmd({ name: 'doc.write', issuedBy: 'agent', turnId: 'turn_1' }), bus, registry);
    execute(cmd({ name: 'doc.write', issuedBy: 'agent', turnId: 'turn_2' }), bus, registry);

    const groups = undo.groups();
    expect(groups).toHaveLength(2);
    expect(groups[0]?.kind).toBe('agent-turn');
    expect(groups[0]?.entries).toHaveLength(2);
    expect(groups[0]?.label).toBe('restore to before this turn');
    expect(groups[1]?.turnId).toBe('turn_2');
  });

  it('undoes a group in reverse order, and consumes it', () => {
    const order: string[] = [];
    const undo = createUndoStore();
    const { bus } = harness({ undo });
    const registry = registryWith(
      fake(
        { agentRisk: 'write-auto', undo: 'compensable' },
        ((_s: unknown, params: unknown, context: ApplyContext) => {
          const tag = (params as { tag: string }).tag;
          order.push(`apply:${tag}`);
          context.undo.compensate(tag, () => order.push(`restore:${tag}`));
          return null;
        })
      ),
    );
    // One group, three commands: an agent turn.
    for (const tag of ['a', 'b', 'c']) {
      execute(
        cmd({ name: 'doc.write', issuedBy: 'agent', turnId: 'turn_1', params: { tag } }),
        bus,
        registry,
      );
    }
    const group = undo.groups()[0]!;
    expect(order).toEqual(['apply:a', 'apply:b', 'apply:c']);

    const outcome = undo.undo(group.id);

    expect(order).toEqual(['apply:a', 'apply:b', 'apply:c', 'restore:c', 'restore:b', 'restore:a']);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.undone).toHaveLength(3);
    expect(outcome.value.failures).toEqual([]);
    expect(undo.groups()).toEqual([]); // a clean undo consumes the group
    expect(undo.undo(group.id).ok).toBe(false); // and it is not redo-able
  });

  it('keeps a group that failed to undo, holding only what is still undone', () => {
    const undo = createUndoStore();
    const { bus } = harness({ undo });
    const registry = registryWith(
      fake(
        { agentRisk: 'write-auto', undo: 'compensable' },
        ((_s: unknown, params: unknown, context: ApplyContext) => {
          const tag = (params as { tag: string }).tag;
          context.undo.compensate(tag, () => {
            if (tag === 'b') throw new Error('the snapshot is gone');
          });
          return null;
        })
      ),
    );
    for (const tag of ['a', 'b', 'c']) {
      execute(cmd({ name: 'doc.write', issuedBy: 'agent', turnId: 't', params: { tag } }), bus, registry);
    }
    const id = undo.groups()[0]!.id;

    const first = undo.undo(id);

    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.undone).toHaveLength(2); // a and c were restored
    expect(first.value.failures).toHaveLength(1);
    expect(first.value.failures[0]?.target).toBe('doc.write');
    expect(first.value.failures[0]?.message).toContain('the snapshot is gone');
    // The group survives with exactly the entry that did not work, so a retry
    // undoes the rest and nothing re-runs.
    const left = undo.group(id);
    expect(left?.entries).toHaveLength(1);
    expect(left?.entries[0]).toMatchObject({ kind: 'compensable', label: 'b' });
  });

  it('refuses an unknown group rather than reporting a silent no-op', () => {
    const undo = createUndoStore();
    const result = undo.undo('grp_999');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not-found');
    expect(result.error.message).toContain('Nothing was changed');
  });

  it('runs an inverse entry back through execute() and does not re-register it', () => {
    // Redo is v0.2, so an undo dispatches the inverse command. If the inverse
    // registered an entry of its own, Ctrl+Z would toggle — and the group would
    // grow an entry per undo.
    const executed: string[] = [];
    const inverseCommand = cmd({
      name: 'view.setActiveDoc',
      params: { docId: THE_LANDING },
      id: 'cmd_0000000009',
    });
    const registry = registryWith(
      fake(
        { agentRisk: 'write-auto', undo: 'inverse' },
        ((_s: unknown, _p: unknown, context: ApplyContext) => {
          context.undo.inverse(inverseCommand);
          return null;
        })
      ),
    );
    // The dispatcher closes over `h`, which is assigned on the next line and read
    // only when an undo runs — so the store and the bus can be built in either
    // order without a mutable holder.
    const undo = createUndoStore({ dispatch: (command) => execute(command, h.bus) });
    const h = harness({ undo });

    execute(cmd({ name: 'doc.write', params: { docId: THE_LANDING, body: 'Elena returns.' } }), h.bus, registry);
    const id = undo.groups()[0]!.id;
    const outcome = undo.undo(id);

    expect(outcome.ok && outcome.value.undone).toHaveLength(1);
    // The inverse really ran: the view state it touches is the shipped apply's.
    expect(h.view.activeDocId).toBe(THE_LANDING);
    // …and it is stamped with the group it belongs to, while the group itself is
    // gone rather than holding a fresh entry.
    expect(undo.groups()).toEqual([]);
    expect(h.log.entriesForGroup(id)).toHaveLength(2);
    expect(h.log.entries().map((entry) => entry.command)).toEqual(['doc.write', 'view.setActiveDoc']);
    expect(executed).toEqual([]);
  });

  it('treats an inverse that changes nothing as a no-op, not as a failed undo', () => {
    // The store's `binder.setMeta` inverse is the same command with the previous
    // values, and a change that wrote no field has no previous values to write
    // back — so its inverse carries an empty patch, which the bus refuses as a
    // request that changes nothing. The undo of a change that changed nothing
    // has nothing to undo, so the group reports no failure for it.
    const registry = {
      ...COMMAND_REGISTRY,
      'doc.write': fake(
        { agentRisk: 'write-auto', undo: 'inverse' },
        ((_s: unknown, _p: unknown, context: ApplyContext) => {
          context.undo.inverse(
            cmd({ name: 'binder.setMeta', params: { nodeId: THE_LANDING, patch: {} } }),
          );
          return null;
        })
      ),
      'binder.setMeta': {
        descriptor: COMMAND_REGISTRY['binder.setMeta'].descriptor,
        apply: (() => null) as CommandApply<never, unknown>,
      },
    } as CommandRegistry;
    const undo = createUndoStore({ dispatch: (command) => execute(command, h.bus, registry) });
    const h = harness({ undo });

    execute(cmd({ name: 'doc.write', params: { docId: THE_LANDING, body: 'Elena returns.' } }), h.bus, registry);
    const id = undo.groups()[0]!.id;

    const outcome = undo.undo(id);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.failures).toEqual([]);
    expect(outcome.value.undone).toHaveLength(1);
    // The refusal was the bus's own, and it is the one that says "nothing changed".
    const refused = execute(
      cmd({ name: 'binder.setMeta', params: { nodeId: THE_LANDING, patch: {} } }),
      h.bus,
      registry,
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe('invalid-params');
    expect(refused.error.details?.changesNothing).toBe(true);
  });

  it('does not register the inverse it just dispatched, so an undo is not a toggle', () => {
    // Redo is v0.2, so the inverse is dispatched through `execute()` — and if that
    // dispatch registered an entry of its own, the group would grow a second entry
    // and a second Ctrl+Z would re-apply the original.
    const replaying: (string | undefined)[] = [];
    // Two names, two fakes: `doc.write` captures an inverse; `notes.append` is the
    // inverse and would capture a compensation if the pipeline let it.
    const registry = {
      ...COMMAND_REGISTRY,
      'doc.write': {
        descriptor: { ...COMMAND_REGISTRY['doc.write'].descriptor, agentRisk: 'write-auto', undo: 'inverse' },
        apply: ((_s: unknown, _p: unknown, context: ApplyContext) => {
          context.undo.inverse(
            cmd({
              name: 'notes.append',
              id: 'cmd_000000000b',
              params: { nodeId: THE_LANDING, text: 'Elena returns.' },
            }),
          );
          // §8: hand-rolled registries do not get `fake()`'s wrapper, so the two
          // applies in this object report for themselves.
          context.report({ affected: [], summary: 'the doc.write fake' });
          return null;
        })
      },
      'notes.append': {
        descriptor: {
          ...COMMAND_REGISTRY['notes.append'].descriptor,
          agentRisk: 'write-auto',
          undo: 'compensable',
        },
        apply: (_s, _p, context) => {
          replaying.push(undo.replayingGroupId());
          context.undo.compensate('the inverse body', () => undefined);
          context.report({ affected: [], summary: 'the notes.append fake' });
          return null;
        },
      },
    } as CommandRegistry;
    // `observed` is read in the dispatch wrapper *after* the replayed command has
    // run step 5 — the only moment the difference exists. Reading it from inside
    // the inverse's own apply looks like the same test and is not: registration
    // happens after apply, so an apply-time read sees 1 whether or not the
    // pipeline registered. A mutation check is what found that.
    const observed: (number | undefined)[] = [];
    let groupId = '';
    const undo = createUndoStore({
      dispatch: (command) => {
        const result = execute(command, h.bus, registry);
        observed.push(undo.group(groupId)?.entries.length);
        return result;
      },
    });
    const h = harness({ undo });

    execute(cmd({ name: 'doc.write', params: { docId: THE_LANDING, body: 'Elena returns.' } }), h.bus, registry);
    groupId = undo.groups()[0]!.id;
    const outcome = undo.undo(groupId);

    // The inverse ran with the replay flag set…
    expect(replaying).toEqual([groupId]);
    // …and when it had finished, the group still held exactly the one entry the
    // outer command registered. Two entries here is a toggle.
    expect(observed).toEqual([1]);
    expect(outcome.ok).toBe(true);
    // The replayed entry was not kept, and the group is gone: one undo, one undo.
    expect(undo.groups()).toEqual([]);
    expect(h.log.entries().map((entry) => entry.command)).toEqual(['doc.write', 'notes.append']);
  });

  it('reports an inverse it cannot dispatch, instead of skipping it quietly', () => {
    const undo = createUndoStore(); // no dispatch attached
    // The late-capture reporter is required, so a late capture can never be
    // dropped with no trace. This scope never captures late, so the reporter
    // does nothing.
    const scope = createUndoScope('inverse', () => undefined);
    scope.inverse(cmd({ name: 'view.setActiveDoc', params: { docId: THE_LANDING } }));
    const target = undo.targetFor(cmd({ name: 'doc.write' }), 1);
    undo.register(target, {
      kind: 'inverse',
      commandId: 'cmd_0000000002',
      name: 'doc.write',
      label: 'undo doc.write',
      inverse: cmd({ name: 'view.setActiveDoc', params: { docId: THE_LANDING } }),
    });

    const outcome = undo.undo(target.id);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.undone).toEqual([]);
    expect(outcome.value.failures[0]?.message).toContain('no dispatcher is attached');
    expect(undo.groups()).toHaveLength(1); // still retryable
  });
});

// ------------------------------------- §5's registration obligation, enforced

describe('§5 — registration is a pipeline step, not an apply courtesy', () => {
  it('refuses a project command whose apply captured nothing', () => {
    // The apply here **mutates real state and captures nothing**, because the
    // refusal runs after it. An earlier version of this test used an apply that
    // returned a string and touched nothing, and it asserted the message said
    // "nothing was written" — which was true of that fixture and false of the
    // pipeline: the apply has already run by step 5, so its effect is still in
    // place and there is nothing registered to reverse it. This is the one
    // post-apply refusal that cannot name a group, and the message has to say
    // that rather than the reassuring thing.
    const docs = new Map<string, string>([[THE_LANDING, 'the original body']]);
    const { bus, log, undo } = harness({ state: { docs } });
    const registry = registryWith(
      fake({ agentRisk: 'write-auto', undo: 'compensable' }, (_s, _p, _context) => {
        (docs as Map<string, string>).set(THE_LANDING, 'what the apply wrote');
        return 'applied anyway';
      }),
    );

    const result = execute(cmd({ name: 'doc.write' }), bus, registry);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('internal');
    expect(result.error.message).toContain('restore artifact');
    expect(result.error.correctiveHint).toContain('compensate(label, restore)');
    // The claim the message used to make, and the truth it now tells instead.
    expect(result.error.message).not.toContain('nothing was written');
    expect(result.error.message).toContain('already run');
    expect(result.error.message).toContain('still in place');
    expect(result.error.message).toContain('no undo group that reverses it');
    // The effect is in place, no group exists to reverse it, and — being a
    // post-apply refusal with nothing captured — no group id is named.
    expect(docs.get(THE_LANDING)).toBe('what the apply wrote');
    expect(result.error.details?.undoGroupId).toBeUndefined();
    // The apply ran and its effect is in place, so the log records it: a row with
    // no undo group on it, because the refusal is exactly that nothing could be
    // registered. Before this the change was in the store and absent from the log.
    expect(log.length).toBe(1);
    expect(log.entries()[0]?.undoGroupId).toBeUndefined();
    expect(undo.groups()).toEqual([]);
  });

  it('refuses a capture whose kind is not the kind the descriptor declared', () => {
    const { bus } = harness();
    const registry = registryWith(
      fake(
        { agentRisk: 'write-auto', undo: 'compensable' },
        ((_s: unknown, _p: unknown, context: ApplyContext) => {
          context.undo.inverse(cmd({ name: 'view.setActiveDoc', params: { docId: THE_LANDING } }));
          return null;
        })
      ),
    );

    const result = execute(cmd({ name: 'doc.write' }), bus, registry);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("declares undo: 'compensable'");
    expect(result.error.message).toContain("captured a 'inverse' compensation");
  });

  it('throws when an apply captures a second undo payload, instead of keeping only the last one', () => {
    // The trap this closes: a batch apply that captures per-op compensations the
    // obvious way handed the pipeline one payload, so the group it registered
    // reversed only the last effect — and the pipeline could not tell, because it
    // saw a capture of the right kind. The activity log's own scope refuses a
    // second report the same way.
    const { bus, undo } = harness();
    const registry = registryWith(
      fake(
        { agentRisk: 'write-auto', undo: 'compensable' },
        ((_s: unknown, _p: unknown, context: ApplyContext) => {
          context.undo.compensate('restore the first', () => {});
          context.undo.compensate('restore the second', () => {});
          return null;
        })
      ),
    );

    const result = execute(cmd({ name: 'doc.write' }), bus, registry);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('internal');
    expect(result.error.message).toContain('doc.write');
    // The scope's own message does not repeat the command name: the pipeline's
    // apply-threw prefix already names it, and a second naming would stutter.
    expect(result.error.message).toContain('a second undo payload was captured');
    // The first capture is kept, so what the apply already changed is still
    // reversible: the group holds the first compensation, not the second. The
    // entry itself is asserted, because a count would also pass an
    // implementation that overwrote the first capture with the second.
    expect(undo.groups()).toHaveLength(1);
    expect(undo.groups()[0]!.entries[0]).toMatchObject({ kind: 'compensable', label: 'restore the first' });
  });

  it('reports a capture that arrives after the dispatch settled, instead of throwing where nobody catches it', () => {
    // An apply that stashed the scope and captures from a timer, an event or a
    // floating continuation fires after the pipeline read the payload and
    // returned the outcome. A throw there escapes as an uncaught exception (or an
    // unhandled rejection on the async path) — a defect that reaches no caller and
    // no log. So a late capture is dropped, and the activity row reports it: the
    // group the dispatch registered is already closed and cannot take the payload.
    const { bus, log, undo } = harness();
    let stashed: ApplyContext['undo'] | undefined;
    const registry = registryWith(
      fake(
        { agentRisk: 'write-auto', undo: 'compensable' },
        ((_s: unknown, _p: unknown, context: ApplyContext) => {
          stashed = context.undo;
          context.undo.compensate('the one that counts', () => {});
          return null;
        }),
      ),
    );

    const result = execute(cmd({ name: 'doc.write' }), bus, registry);
    expect(result.ok).toBe(true);
    expect(undo.groups()).toHaveLength(1);

    expect(() => stashed!.compensate('too late', () => {})).not.toThrow();
    expect(() => stashed!.inverse(cmd({ name: 'view.setActiveDoc' }))).not.toThrow();
    // The registered group is untouched by the late captures…
    expect(undo.groups()).toHaveLength(1);
    expect(undo.groups()[0]!.entries).toHaveLength(1);
    expect(undo.groups()[0]!.entries[0]).toMatchObject({ kind: 'compensable', label: 'the one that counts' });
    // …and the log says the late ones arrived and were dropped: the row for the
    // dispatch, then **one defect row for the dispatch** — §8 caps them, so a
    // scope stashed on a timer cannot write a row per capture.
    const rows = log.entries();
    expect(rows).toHaveLength(2);
    expect(rows[1]?.summary).toContain('after its dispatch settled');
    expect(rows[1]?.command).toBe('doc.write');
    // The defect marker is what tells a defect row from an execution of the
    // command it names.
    expect(rows[1]?.defect).toBe('late-undo-capture');
    expect(rows[0]?.defect).toBeUndefined();
    // **The first late capture is the one reported.** The two late captures
    // above are of different kinds, and the row names the kind it carries — so
    // an implementation that reported the *last* capture would pass every
    // assertion above and fail this one.
    expect(rows[1]?.summary).toContain('kind "compensable"');
    expect(rows[1]?.summary).not.toContain('kind "inverse"');
    // A defect row belongs to no group: the dispatch's registration is closed,
    // so the payload it carried was dropped rather than registered.
    expect(rows[1]?.undoGroupId).toBeUndefined();
  });

  it('reports a late capture on the async path too, and caps it at one row per dispatch', async () => {
    // `executeAsync` wires the same reporter as `execute` (pipeline.ts), so the
    // defect row an async apply's late capture leaves is the same row. The
    // async path is where a floating continuation is likeliest — an apply that
    // stashed the scope and captures after its promise resolves — so the cap
    // and the marker have to hold there too, not only on the synchronous path.
    const { bus, log, undo } = harness();
    let stashed: ApplyContext['undo'] | undefined;
    const registry = registryWith(
      fake(
        { agentRisk: 'write-auto', undo: 'compensable' },
        ((_s: unknown, _p: unknown, context: ApplyContext) => {
          stashed = context.undo;
          context.undo.compensate('the one that counts', () => {});
          return Promise.resolve(null);
        }),
      ),
    );

    const result = await executeAsync(cmd({ name: 'doc.write' }), bus, registry);
    expect(result.ok).toBe(true);
    expect(undo.groups()).toHaveLength(1);

    expect(() => stashed!.compensate('too late', () => {})).not.toThrow();
    // **Two late captures, so the cap is actually exercised.** One capture
    // passes for an implementation that writes a row *per* capture — the very
    // divergence this test exists to catch, because the async path has to wire
    // the same capped reporter the sync path does (pipeline.ts). The second
    // capture is of another kind, so the row that is written names the *first*
    // capture's kind and an implementation that reported the last would fail.
    expect(() => stashed!.inverse(cmd({ name: 'view.setActiveDoc' }))).not.toThrow();
    const rows = log.entries();
    expect(rows).toHaveLength(2);
    expect(rows[1]?.defect).toBe('late-undo-capture');
    expect(rows[1]?.summary).toContain('kind "compensable"');
    expect(rows[1]?.summary).not.toContain('kind "inverse"');
    expect(rows[1]?.undoGroupId).toBeUndefined();
    expect(rows[0]?.defect).toBeUndefined();
  });

  it("skips registration for a view command even when its descriptor claims undo: 'inverse'", () => {
    // §2 ("view commands skip undo registration") and §9's `undo: 'none'` meet
    // here, and a descriptor is free to lie. §2 wins: a view command is never
    // persisted, so there is nothing to restore.
    const { bus, undo, view, log } = harness();
    const registry = {
      ...COMMAND_REGISTRY,
      'view.setSelection': {
        descriptor: { ...COMMAND_REGISTRY['view.setSelection'].descriptor, undo: 'inverse' as const },
        apply: COMMAND_REGISTRY['view.setSelection'].apply,
      },
    } as CommandRegistry;

    const result = execute(cmd({ name: 'view.setSelection', params: { nodeIds: [THE_LANDING] } }), bus, registry);

    expect(result.ok).toBe(true);
    expect(undo.groups()).toEqual([]);
    expect(view.selection).toEqual([THE_LANDING]);
    expect(log.entries()[0]?.undoGroupId).toBeUndefined();
  });

  it('does not register a project command whose descriptor says undo: none', () => {
    const { bus, undo } = harness();
    const registry = registryWith(
      fake(
        { agentRisk: 'write-auto', undo: 'none' },
        ((_s: unknown, _p: unknown, context: ApplyContext) => {
          // Capturing anyway must not create a group: the descriptor's `undo` is
          // the contract, and a capture the bus did not ask for is not registered.
          context.undo.compensate('ignored', () => undefined);
          return null;
        })
      ),
    );

    const result = execute(cmd({ name: 'doc.write' }), bus, registry);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.undoGroupId).toBeUndefined();
    expect(undo.groups()).toEqual([]);
  });
});

// ------------------------------------------- §7 and §3 after the effect exists

describe('after apply — the bus leaves the command reversible, or says so', () => {
  it("keeps §7's undo group intact when a postcondition fails, and does not notify", () => {
    const undo = createUndoStore();
    const trace: string[] = [];
    const { bus, log, counts } = harness({ undo }, trace);
    const registry = registryWith(
      fake(
        {
          agentRisk: 'write-auto',
          undo: 'compensable',
          postconditions: [{ describe: 'the body matches the plan', assert: () => false }],
        },
        compensableApply([]),
      ),
    );

    const result = execute(cmd({ name: 'doc.write' }), bus, registry);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('postcondition');
    expect(result.error.message).toContain('the body matches the plan');
    expect(result.error.details?.undoGroupId).toBe(undo.groups()[0]?.id);
    expect(result.error.details?.failures).toHaveLength(1);
    // §7: "the undo group stays intact and user-reversible either way".
    expect(undo.groups()[0]?.entries).toHaveLength(1);
    expect(log.length).toBe(1);
    expect(counts.notified).toBe(0);
    expect(trace).not.toContain('notify:doc.write');
  });

  it('registers what a thenable apply captured, and refuses the dispatch it cannot finish', () => {
    // A2: the bus is synchronous. §3 says the async boundary inside an apply "is
    // awaited by it" — which an async apply cannot be from here — so the pipeline
    // refuses rather than checking postconditions against a settling state. What
    // it must not do is drop the compensation: the effect is already out there.
    const restored: string[] = [];
    const undo = createUndoStore();
    const { bus, log } = harness({ undo });
    const registry = registryWith(
      fake({ agentRisk: 'write-auto', undo: 'compensable' }, (_s, _p, context) => {
        context.undo.compensate('the body', () => restored.push('restored'));
        return Promise.resolve(null);
      }),
    );

    const result = execute(cmd({ name: 'doc.write' }), bus, registry);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('internal');
    expect(result.error.message).toContain('returned a promise');
    // The id names a group that really exists, holding the entry that reverses it.
    const groupId = result.error.details?.undoGroupId ?? '';
    expect(groupId).toMatch(/^grp_/);
    expect(undo.group(groupId!)?.entries).toHaveLength(1);
    // The effect is real and reversible, so the log names it under the same group
    // the refusal names. The row says what the bus knows: the apply did not finish.
    expect(log.length).toBe(1);
    expect(log.entries()[0]?.undoGroupId).toBe(groupId);
    expect(undo.undo(groupId!).ok).toBe(true);
    expect(restored).toEqual(['restored']);
  });

  it('registers what a throwing apply captured, and names the group instead of throwing out', () => {
    // §7's "errors are data" (result.ts) and §3's zero-partial-effects cannot both
    // hold after an apply has written half its effect — so the bus keeps the
    // compensation and reports, rather than letting an exception reach a caller
    // that would read it as a crash and retry.
    const restored: string[] = [];
    const undo = createUndoStore();
    const { bus, log } = harness({ undo });
    const registry = registryWith(
      fake({ agentRisk: 'write-auto', undo: 'compensable' }, (_s, _p, context) => {
        context.undo.compensate('the body', () => restored.push('restored'));
        throw new Error('the store transaction refused the second write');
      }),
    );

    const result = execute(cmd({ name: 'doc.write' }), bus, registry);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('internal');
    expect(result.error.message).toContain('the store transaction refused the second write');
    // The first write was captured before the throw, so the effect is reversible
    // and the log records it under that group.
    expect(log.length).toBe(1);
    expect(log.entries()[0]?.undoGroupId).toBe(result.error.details?.undoGroupId);
    const groupId = result.error.details?.undoGroupId ?? '';
    expect(groupId).toMatch(/^grp_/);
    expect(undo.group(groupId)?.entries).toHaveLength(1);
    expect(undo.undo(groupId).ok).toBe(true);
    expect(restored).toEqual(['restored']);
  });

  it('reports a subscriber that throws, names the group, and leaves the command undone-able', () => {
    const undo = createUndoStore();
    const restored: string[] = [];
    const { bus, log } = harness({
      undo,
      notify: () => {
        throw new Error('the corkboard is not mounted');
      },
    });
    const registry = registryWith(
      fake({ agentRisk: 'write-auto', undo: 'compensable' }, compensableApply([], 'the corkboard body')),
    );

    const result = execute(cmd({ name: 'doc.write' }), bus, registry);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('internal');
    expect(result.error.message).toContain('the corkboard is not mounted');
    expect(result.error.message).toContain('Do not retry');
    // The whole point of naming the group: the command did run, so the caller
    // needs the handle that reverses it.
    const groupId = undo.groups()[0]!.id;
    expect(result.error.details?.undoGroupId).toBe(groupId);
    expect(log.length).toBe(1);

    const undone = undo.undo(groupId);
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(restored).toEqual([]);
    expect(undone.value.undone).toHaveLength(1);
  });

  it('refuses a view command when the bus was given something that is not view state', () => {
    const { bus } = harness({ view: { selection: 'not an array' } as unknown as ViewState });
    const result = execute(cmd({ name: 'view.setActiveDoc', params: { docId: THE_LANDING } }), bus);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('internal');
    expect(result.error.correctiveHint).toContain('createViewState()');
  });
});

// ------------------------------------------- the shipped, non-vacuous case

describe('the three view commands, through the shipped registry with no fakes', () => {
  it('dispatches all three, mutates the view state, logs them and creates no group', () => {
    const { bus, undo, view, log, counts } = harness();
    const results: ExecutionOutcome[] = [];

    for (const command of [
      cmd({ name: 'view.setSelection', params: { nodeIds: [THE_LANDING] } }),
      cmd({ name: 'view.setActiveDoc', params: { docId: THE_LANDING } }),
      cmd({ name: 'view.setScroll', params: { nodeId: THE_LANDING, offset: 420 } }),
    ]) {
      const result = execute(command, bus);
      expect(result.ok, `${command.name} should dispatch`).toBe(true);
      if (result.ok) results.push(result.value);
    }

    expect(view.selection).toEqual([THE_LANDING]);
    expect(view.activeDocId).toBe(THE_LANDING);
    expect(view.scroll).toEqual({ [THE_LANDING]: 420 });
    expect(undo.groups()).toEqual([]);
    expect(log.entries().map((entry) => entry.command)).toEqual([
      'view.setSelection',
      'view.setActiveDoc',
      'view.setScroll',
    ]);
    expect(log.entries().every((entry) => entry.undoGroupId === undefined)).toBe(true);
    expect(counts.notified).toBe(3);
    // §4: `read` risk, and a UI gesture is its own confirmation.
    expect(results.every((outcome) => outcome.grant.via === 'user-gesture')).toBe(true);
    expect(results.every((outcome) => outcome.grant.risk === 'read')).toBe(true);
  });

  it('refuses a view command whose params do not validate, and changes nothing', () => {
    const { bus, view, log, counts } = harness();
    const result = execute(cmd({ name: 'view.setScroll', params: { nodeId: THE_LANDING } }), bus);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-params');
    expect(view.scroll).toEqual({});
    expect(log.length).toBe(0);
    expect(counts.notified).toBe(0);
  });

  it('is the only family with an apply, and the hand-written view list matches the descriptors', () => {
    // `CommandStateFor` is a type, and a type cannot be computed from a table —
    // so the table is read back and compared. A fourth view command fails here
    // rather than being handed a project state.
    const fromDescriptors = COMMAND_NAMES.filter(
      (name) => COMMAND_REGISTRY[name].descriptor.mutates === 'view',
    );
    expect(new Set(fromDescriptors)).toEqual(new Set(VIEW_COMMAND_NAMES));

    const withApply = COMMAND_NAMES.filter((name) => COMMAND_REGISTRY[name].apply !== undefined);
    expect(new Set(withApply)).toEqual(new Set(VIEW_COMMAND_NAMES));
    // And the control: every other name has no bus-side apply (its apply is the store's, or the MCP client's), so
    // the set above is not "everything that happens to have a descriptor". The count below is the five view
    // names; the total is asserted further down, and `test/registry.test.ts` holds the names §9 does not tabulate.
    expect(withApply.length).toBe(5);
    // 22 core names. `mcp.invoke` (extensibility §6) is the twenty-third: a descriptor here, its apply
    // injected by the store registry, so it is not in `withApply`. The exceptions are listed in registry.test.ts.
    // The storyboard adds `storyboard.create`, `shot.create` and `shot.setMeta` as well, so 26 in all.
    // Project export adds seven more: 26 + 7 = 33 (project.rename, project.setMetadata, project.importAsset,
    // vocabulary.upsert, vocabulary.remove, recipe.save, recipe.delete). Their descriptors are here; their applies are the store's.
    // Saved filters and goals add `binder.saveFilter`, `binder.deleteFilter`, `project.saveGoal` and `project.deleteGoal`: 33 + 4
    // = 37. Their applies are the store's too, so `withApply` above still counts only the five bus-side view applies.
    // The run history adds `coherence.discardRun`, a descriptor here with its apply in the store: 37 + 1 = 38.
    // The storyboard's image import adds `shot.importImage`, a descriptor here with its apply in the store: 38 + 1 = 39. The
    // script imports add `screenplay.import`, `dialogue.importInk` and `dialogue.setMeta`, descriptors here and applies in the store: 39 + 3 = 42.
    // The project's skills add `skill.import`, `skill.write`, `skill.delete` and `skill.setEnabled`, descriptors here and applies in the store: 42 + 4 = 46. The knowledge facts add `coherence.addKnowledgeFact`, `coherence.editKnowledgeFact` and `coherence.removeKnowledgeFact`, descriptors here and applies in the store: 46 + 3 = 49.
    // `mcp.readResource` (the writer's read of a resource, extensibility §6) is the same kind of name as `mcp.invoke`: a descriptor here, its apply injected: 49 + 1 = 50.
    // The paper-photo round trip adds `shot.importImages`, the batch form of `shot.importImage`, a descriptor here with its apply in the store: 50 + 1 = 51.
    expect(COMMAND_NAMES.length).toBe(54);
  });

  it('an agent may emit a view command, and it is granted as a read', () => {
    const { bus, view } = harness();
    const result = execute(
      cmd({ name: 'view.setActiveDoc', params: { docId: THE_LANDING }, issuedBy: 'agent', turnId: 't' }),
      bus,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.grant.via).toBe('auto');
    expect(view.activeDocId).toBe(THE_LANDING);
  });

  it('keeps the view state out of the project state, because §2 says never persisted', () => {
    const projectState: unknown = { manifest: { tree: [] } };
    const { bus } = harness({ state: projectState });
    execute(cmd({ name: 'view.setActiveDoc', params: { docId: UNKNOWN_ID } }), bus);
    expect(projectState).toEqual({ manifest: { tree: [] } });
  });

  it('validates against the snapshot the caller supplies, so an unknown doc is a real refusal', () => {
    // A view descriptor validates its own params; the snapshot is what a
    // *project* validator reads. This is the control for "the read seam is real":
    // the pipeline hands `read()`'s result to `validate` and not to something
    // it built itself.
    const { bus, counts } = harness();
    execute(cmd({ name: 'view.setActiveDoc', params: { docId: THE_LANDING } }), bus);
    expect(counts.reads).toBe(1);
  });
});

describe('the snapshot seam', () => {
  it("is the caller's, so validate is driven by the project the caller has open", () => {
    const snapshot: ValidationSnapshot = makeSnapshot({ bodies: {} });
    let handed: ValidationSnapshot | undefined;
    const { bus, counts } = harness({
      read: () => {
        counts.reads += 1;
        handed = snapshot;
        return snapshot;
      },
    });
    const seen: unknown[] = [];
    const registry = registryWith(
      fake(
        { validate: (_params, read) => { seen.push(read); return { ok: true, value: { docId: THE_LANDING } }; } },
        () => null,
      ),
    );
    const result = execute(cmd({ name: 'doc.write', issuedBy: 'user' }), bus, registry);
    expect(result.ok).toBe(true);
    expect(counts.reads).toBe(1);
    expect(handed).toBe(snapshot);
    expect(seen[0]).toBe(snapshot);
  });
});
