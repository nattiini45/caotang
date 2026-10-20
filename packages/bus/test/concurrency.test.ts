/**
 * [command-bus.md §6](docs/architecture/command-bus.md) — *"Idempotency &
 * concurrency"* — both of its halves, in one file because they are one section:
 *
 * 1. **Optimistic concurrency.** A document-writing command may carry
 *    `expectedRevision`; a mismatch is refused as `revision-conflict` with §6's own
 *    message. The comparison is in `pipeline.ts`, *between* the gate and `apply`,
 *    and the flag that opts a command in is `descriptor.guardsRevision`.
 * 2. **`callId` dedupe.** A replay within a turn returns the earlier result without
 *    re-executing; the cache is per turn and cleared at turn end.
 *
 * ## Why the split point for the cache is drawn where it is
 *
 * `execute()` records exactly what `dispatch()` returned, and `dispatch()` is
 * exactly the part that ran an apply. So the cache holds the outcomes that must
 * not re-run (success, postcondition failure, throwing subscriber) and holds no
 * refusal that a re-run could legitimately change the answer to (resolution,
 * `validate`, the §4 gate, §6's conflict check).
 *
 * Three tests carry that claim and nothing else does (the postcondition and
 * registration refusals have their own, added and by the header's
 * own enumeration — the registration refusal was named in `idempotency.ts` from
 * the start and reached by no fixture):
 *
 * - *"a gate refusal is not cached"* — the confirm-card flow. Same id, same
 *   params, same turn: first dispatch refused for want of `confirmed`, second
 *   dispatch with it succeeds. A cache that stored refusals would make a confirmed
 *   write permanently unconfirmable, and §6's sentence would be doing something
 *   the app cannot use.
 * - *"a subscriber failure is cached"* — first dispatch committed and a subscriber
 *   threw; the replay returns that same `internal` and the apply ran **once**. The
 *   message the pipeline already shipped for this case says *"Do not retry it — the
 *   effect is already committed"*, and a cache that stored only successes would
 *   contradict its own hint.
 * - *"a registration refusal is cached"* — the same shape for the one post-apply
 *   failure that fires *because* nothing was captured: the effect is in place, no
 *   group can reverse it, and its message says so. Caching it is the only thing
 *   standing between a replay and a second unreversible effect.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMMAND_REGISTRY,
  createActivityLog,
  createIdempotencyCache,
  createUndoStore,
  createViewState,
  execute,
  ok,
  type ActivityLog,
  type BusContext,
  type Command,
  type CommandApply,
  type CommandDescriptor,
  type CommandName,
  type CommandRegistry,
  type IdempotencyCache,
  type PermissionContext,
  type UndoStore,
  type ValidationSnapshot,
} from '../src/index.js';
import { BODY, REVISION, THE_LANDING, makeSnapshot } from './fixtures.js';

const TICK = 1_760_000_000_000;
const TURN = 'turn_01HZX';
const CALL = 'call_abc';
/** §4: an agent's `write-confirm` command is allowed "inside an approved plan". */
const AGENT_PLAN: PermissionContext = { approvedPlan: true };

/** A descriptor that passes params through, so a test controls the whole shape. */
function descriptorWith(overrides: Partial<CommandDescriptor> = {}): CommandDescriptor {
  return {
    mutates: 'project',
    agentRisk: 'write-auto',
    undo: 'none',
    validate: (params) =>
      params !== null && typeof params === 'object'
        ? ok(params as Record<string, unknown>)
        : { ok: false, error: { code: 'invalid-params', message: 'params must be an object' } },
    ...overrides,
  };
}

interface Harness {
  bus: BusContext;
  undo: UndoStore;
  log: ActivityLog;
  idempotency: IdempotencyCache;
  /** what the apply was handed, once per execution */
  applied: unknown[];
  reads: () => number;
  run: (command: Command) => ReturnType<typeof execute>;
  registry: CommandRegistry;
}

function harness(
  options: {
    name?: CommandName;
    descriptor?: CommandDescriptor;
    snapshot?: () => ValidationSnapshot;
    permission?: PermissionContext;
    notify?: (outcome: { name: CommandName }) => void;
    undo?: UndoStore;
    idempotency?: IdempotencyCache;
    /** replaces the shared fake apply, which always captures and always reports */
    apply?: CommandApply<never, unknown>;
  } = {},
): Harness {
  const name = options.name ?? 'doc.write';
  const applied: unknown[] = [];
  let reads = 0;
  const undo = options.undo ?? createUndoStore();
  const log = createActivityLog();
  const idempotency = options.idempotency ?? createIdempotencyCache();
  const snapshot = options.snapshot ?? makeSnapshot;
  const bus: BusContext = {
    state: { label: 'project state' },
    view: createViewState(),
    read: () => {
      reads += 1;
      return snapshot();
    },
    permission: options.permission,
    undo,
    log,
    idempotency,
    notify: options.notify ?? (() => {}),
  };
  /**
   * The shared fake, and the reason it is shaped this way: the shipped descriptors
   * declare undo: 'compensable', and §5 refuses a registration with no capture, so
   * a fake that did not capture would make every test below measure that refusal
   * instead of §6. The same reason for the report.
   */
  const fake: CommandApply<never, unknown> = (_state, _params, context) => {
    context.undo.compensate('restore the previous body', () => {});
    context.report({ affected: [], summary: 'the concurrency fake' });
    return { written: true };
  };
  const run = options.apply ?? fake;
  const apply: CommandApply<never, unknown> = (state, params, context) => {
    applied.push(params);
    return run(state, params, context);
  };
  const registry: CommandRegistry = {
    ...COMMAND_REGISTRY,
    [name]: { descriptor: options.descriptor ?? descriptorWith({ guardsRevision: true }), apply },
  } as CommandRegistry;
  return {
    bus,
    undo,
    log,
    idempotency,
    applied,
    reads: () => reads,
    registry,
    run: (command) => execute(command, bus, registry),
  };
}

let ordinal = 0;
function cmd(partial: Partial<Command> & Pick<Command, 'name' | 'params'>): Command {
  ordinal += 1;
  return {
    id: `cmd_C6${String(ordinal).padStart(6, '0')}`,
    issuedBy: 'agent',
    turnId: TURN,
    callId: CALL,
    createdAt: TICK,
    ...partial,
  };
}

/** §6's own sentence, with the numbers filled in. */
const conflictMessage = (expected: number, actual: number) => `doc was modified since plan (rev ${expected} → ${actual})`;

const specPath = resolve(__dirname, '../../../docs/architecture/command-bus.md');

/**
 * §9's rows whose Params cell carries `expectedRevision?`, read out of the spec.
 *
 * Cells are split on **unescaped** pipes for the reason `registry.test.ts` gives:
 * §9's params cell contains `type: 'folder'\|'document'`, and a naive split shifts
 * every later column by one. Only the Params cell is read, and only a name whose
 * params cell actually mentions `expectedRevision` counts — which is what makes the
 * expectation a fact about §9 rather than a second copy of it.
 */
function specExpectedRevisionRows(): string[] {
  const spec = readFileSync(specPath, 'utf8');
  const section = spec.slice(spec.indexOf('## 9. v0.1 command registry'));
  expect(section.length, '§9 not found in command-bus.md').toBeGreaterThan(0);
  const names: string[] = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split(/(?<!\\)\|/).map((c) => c.trim());
    if (!(cells[2] ?? '').includes('expectedRevision')) continue;
    for (const name of (cells[1] ?? '').matchAll(/`([a-z][a-zA-Z]*\.[a-zA-Z]+)`/g)) {
      names.push(name[1] ?? '');
    }
  }
  return names.sort();
}

// -------------------------------------------------- §6 optimistic concurrency

describe('§6 — a stale expectedRevision is refused before any effect', () => {
  it("reports §6's message, names the document, and puts both revisions in details", () => {
    const h = harness({ descriptor: COMMAND_REGISTRY['doc.write'].descriptor, permission: AGENT_PLAN });
    const result = h.run(
      cmd({ name: 'doc.write', params: { docId: THE_LANDING, body: 'A new opening.', expectedRevision: 4 } }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // §6 writes the code as 'conflict'; the bus's ten-code supersession refined
    // that category to 'revision-conflict' and nothing had used it until now.
    expect(result.error.code).toBe('revision-conflict');
    expect(result.error.message).toBe(conflictMessage(4, REVISION));
    expect(result.error.target).toBe(THE_LANDING);
    expect(result.error.details?.expectedRevision).toBe(4);
    expect(result.error.details?.actualRevision).toBe(REVISION);
    expect(result.error.correctiveHint).toContain('edit-anchors.md §3');
  });

  it('writes nothing at all — not the body, not a revision, not a group, not a log row', () => {
    const state = { body: BODY, revision: REVISION };
    const h = harness({
      descriptor: COMMAND_REGISTRY['doc.write'].descriptor,
      permission: AGENT_PLAN,
      snapshot: () => makeSnapshot({ bodies: { [THE_LANDING]: state.body } }),
    });

    const result = h.run(
      cmd({ name: 'doc.write', params: { docId: THE_LANDING, body: 'Overwritten.', expectedRevision: 4 } }),
    );

    expect(result.ok).toBe(false);
    // The four observables a write could have left. A guard that refused *after*
    // the apply would satisfy the result check and fail this one.
    expect(h.applied).toEqual([]);
    expect(h.log.length).toBe(0);
    expect(state).toEqual({ body: BODY, revision: REVISION });
    expect(h.undo.groups().length).toBe(0);
  });

  it('reads once: the conflict check reuses the snapshot validate was given', () => {
    const h = harness({ descriptor: COMMAND_REGISTRY['doc.write'].descriptor, permission: AGENT_PLAN });
    h.run(cmd({ name: 'doc.write', params: { docId: THE_LANDING, body: 'x', expectedRevision: 4 } }));

    // A second read would be indistinguishable from §3's post-apply read to a
    // caller counting them, and the pipeline has no reason to take one.
    expect(h.reads()).toBe(1);
  });

  it('applies when the revision matches, so the guard has teeth in both directions', () => {
    const h = harness({ descriptor: COMMAND_REGISTRY['doc.write'].descriptor, permission: AGENT_PLAN });
    const result = h.run(
      cmd({ name: 'doc.write', params: { docId: THE_LANDING, body: 'A new opening.', expectedRevision: REVISION } }),
    );

    expect(result.ok).toBe(true);
    expect(h.applied).toHaveLength(1);
  });

  it('applies when no revision was sent — omitted is no opinion, not a match against zero', () => {
    const h = harness({ descriptor: COMMAND_REGISTRY['doc.write'].descriptor, permission: AGENT_PLAN });
    const result = h.run(cmd({ name: 'doc.write', params: { docId: THE_LANDING, body: 'A new opening.' } }));

    expect(result.ok).toBe(true);
    expect(h.applied).toHaveLength(1);
  });

  it('guards all three of §9\'s expectedRevision rows, not just doc.write', () => {
    // A guard scoped to one command would leave the two editor primitives — the
    // ones an agent actually calls — completely unprotected.
    for (const [name, params] of [
      ['doc.write', { docId: THE_LANDING, body: 'x', expectedRevision: 1 }],
      ['editor.insert', { docId: THE_LANDING, offset: 0, text: 'x', expectedRevision: 1 }],
      [
        'editor.replaceRange',
        {
          docId: THE_LANDING,
          range: { from: 0, to: 2 },
          text: 'x',
          expectedRevision: 1,
        },
      ],
    ] as const) {
      const h = harness({ name, descriptor: COMMAND_REGISTRY[name].descriptor });
      const result = h.run(cmd({ name, issuedBy: 'user', params: { ...params } }));
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe('revision-conflict');
      expect(h.applied).toEqual([]);
    }
  });

  it('declares the guard on exactly §9\'s expectedRevision rows — read out of the spec', () => {
    // The list of three names used to be written out here, and that is a guard over
    // a constant defined in the test file that asserts it: only this file could ever
    // change it, so it could not see §9 gain or lose an `expectedRevision?` row —
    // the one drift that would leave a document-writing command unguarded. §9 is the
    // subject of the claim, so §9 is the source of the expectation.
    const guarded = Object.entries(COMMAND_REGISTRY)
      .filter(([, entry]) => entry.descriptor.guardsRevision !== undefined)
      .map(([name]) => name)
      .sort();

    const specGuarded = specExpectedRevisionRows();
    // A broken parse must fail on its own count, not hand an empty expectation to
    // the equality below — the failure mode registry.test.ts:78 names for §9.
    expect(specGuarded).toHaveLength(3);
    expect(guarded).toEqual(specGuarded);
  });

  it('runs after the gate, so a never-class command still asks for permission first', () => {
    // Both orders are zero-partial-effects, so only the *code* can tell them
    // apart — and the code is the thing a caller recovers from.
    const h = harness({ name: 'editor.insert', descriptor: COMMAND_REGISTRY['editor.insert'].descriptor });
    const result = h.run(
      cmd({
        name: 'editor.insert',
        params: { docId: THE_LANDING, offset: 0, text: 'x', expectedRevision: 1 },
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('permission-denied');
    expect(result.error.code).not.toBe('revision-conflict');
    expect(h.applied).toEqual([]);
  });

  it('refuses loudly when the snapshot holds no revision to compare, rather than passing', () => {
    // Comparing against `undefined` would pass every time and turn the backstop
    // into a no-op that looks like a working guard.
    //
    // The descriptor is a custom one rather than `doc.write`'s: a guarded command
    // whose validate reads the document refuses a document the snapshot does not
    // carry before the guard ever runs — `doc.write` refuses it as not-found
    // (the check its editor siblings make), and the editor commands always have.
    // So the guard's own backstop is reached through a descriptor that hands the
    // guard a document the snapshot does not carry.
    const h = harness({
      descriptor: descriptorWith({
        guardsRevision: true,
        validate: (params) => ok(params as Record<string, unknown>),
      }),
      permission: AGENT_PLAN,
      snapshot: () => makeSnapshot({ bodies: {} }),
    });
    const result = h.run(
      cmd({ name: 'doc.write', params: { docId: THE_LANDING, body: 'x', expectedRevision: REVISION } }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('internal');
    expect(result.error.message).toContain('no revision for');
    expect(h.applied).toEqual([]);
  });

  it('refuses a guard it cannot judge rather than treating the revision as matching', () => {
    const h = harness({
      descriptor: descriptorWith({
        guardsRevision: true,
        // The shape the guard cannot honestly judge: a revision and no document.
        validate: (params) => ok(params as Record<string, unknown>),
      }),
    });
    const result = h.run(cmd({ name: 'doc.write', params: { expectedRevision: 4 } }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('internal');
    expect(result.error.message).toContain('no document to compare');
    expect(h.applied).toEqual([]);
  });
});

// ---------------------------------------------------- §6 callId dedupe

describe('§6 — a replayed callId returns the cached result without re-executing', () => {
  it('runs the apply once, and the replay carries the first dispatch\'s ids', () => {
    const h = harness();
    const first = h.run(cmd({ name: 'doc.write', params: { docId: THE_LANDING, body: 'one' } }));
    const second = h.run(cmd({ name: 'doc.write', id: 'cmd_SECOND', params: { docId: THE_LANDING, body: 'one' } }));

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(h.applied).toHaveLength(1);
    // A replay is not a second command: naming a fresh commandId would send a
    // caller after an id that has no row anywhere.
    expect(second.value.commandId).toBe(first.value.commandId);
    expect(second.value.undoGroupId).toBe(first.value.undoGroupId);
    expect(h.log.length).toBe(1);
  });

  it('returns the cached result even when the second envelope has a different command id', () => {
    const h = harness();
    h.run(cmd({ name: 'doc.write', params: { docId: THE_LANDING, body: 'one' } }));
    const replay = h.run(cmd({ name: 'doc.write', id: 'cmd_OTHER', createdAt: TICK + 500, params: { docId: THE_LANDING, body: 'one' } }));

    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.commandId).not.toBe('cmd_OTHER');
    expect(h.applied).toHaveLength(1);
  });

  it('treats the same call as the same call when its JSON keys arrive shuffled', () => {
    // A model round trip does not promise a key order, and a mismatch refusal on
    // a genuine replay would fail loudly on the correct path.
    const h = harness();
    h.run(cmd({ name: 'doc.write', params: { docId: THE_LANDING, body: 'one' } }));
    const replay = h.run(cmd({ name: 'doc.write', params: { body: 'one', docId: THE_LANDING } }));

    expect(replay.ok).toBe(true);
    expect(h.applied).toHaveLength(1);
  });

  it('scopes the id to its turn, so the same id in another turn runs again', () => {
    const h = harness();
    h.run(cmd({ name: 'doc.write', params: { docId: THE_LANDING, body: 'one' } }));
    h.run(cmd({ name: 'doc.write', turnId: 'turn_01HZY', params: { docId: THE_LANDING, body: 'one' } }));

    expect(h.applied).toHaveLength(2);
    expect(h.log.length).toBe(2);
  });

  it('does not dedupe a command with no callId, and none with a callId but no turn', () => {
    const h = harness();
    h.run(cmd({ name: 'doc.write', callId: undefined, params: { docId: THE_LANDING, body: 'one' } }));
    h.run(cmd({ name: 'doc.write', callId: undefined, params: { docId: THE_LANDING, body: 'one' } }));
    h.run(cmd({ name: 'doc.write', turnId: undefined, params: { docId: THE_LANDING, body: 'one' } }));
    h.run(cmd({ name: 'doc.write', turnId: undefined, params: { docId: THE_LANDING, body: 'one' } }));

    // A turnless id would otherwise be an entry no `endTurn` can ever clear.
    expect(h.applied).toHaveLength(4);
    expect(h.idempotency.size()).toBe(0);
  });

  it('keys on the id, not the issuer, so the field that matters is the one §6 names', () => {
    // A *well-formed* user gesture carries neither field — §2 calls turnId
    // "agent turn this command belongs to" and callId a "tool-call id" — and the
    // test above covers that. What is asserted here is the deliberate absence of a
    // second rule: §6's key is (turn, callId), and inventing an `issuedBy === 'agent'`
    // precondition would mean an envelope carrying two ids is deduped or not by
    // which field the caller got right rather than by the id it used.
    const h = harness();
    h.run(cmd({ name: 'doc.write', issuedBy: 'user', params: { docId: THE_LANDING, body: 'one' } }));
    const replay = h.run(cmd({ name: 'doc.write', issuedBy: 'user', params: { docId: THE_LANDING, body: 'one' } }));

    expect(replay.ok).toBe(true);
    expect(h.applied).toHaveLength(1);
  });

  it('forgets the turn at endTurn, so the same id is free in the next one', () => {
    const h = harness();
    h.run(cmd({ name: 'doc.write', params: { docId: THE_LANDING, body: 'one' } }));
    expect(h.idempotency.size(TURN)).toBe(1);

    h.idempotency.endTurn(TURN);
    expect(h.idempotency.size(TURN)).toBe(0);

    h.run(cmd({ name: 'doc.write', turnId: TURN, params: { docId: THE_LANDING, body: 'one' } }));
    expect(h.applied).toHaveLength(2);
  });

  it('refuses a second, different command under one callId instead of dropping its write', () => {
    const h = harness();
    h.run(cmd({ name: 'doc.write', params: { docId: THE_LANDING, body: 'one' } }));
    const second = h.run(cmd({ name: 'doc.write', params: { docId: THE_LANDING, body: 'two' } }));

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('internal');
    // The actionable half is the second command, so the message names both.
    expect(second.error.message).toContain('"one"');
    expect(second.error.message).toContain('"two"');
    expect(second.error.correctiveHint).toContain('own callId');
    expect(h.applied).toHaveLength(1);
  });

  it('refuses a different command name under one callId too', () => {
    const h = harness({ name: 'doc.write' });
    h.run(cmd({ name: 'doc.write', params: { docId: THE_LANDING, body: 'one' } }));
    const second = h.run(cmd({ name: 'notes.append', params: { body: 'one' } }));

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('internal');
    expect(h.applied).toHaveLength(1);
  });
});

describe('§6 — the cache boundary is the effect boundary', () => {
  it('does not cache a gate refusal, so a confirmed retry of the same call succeeds', () => {
    // §4: `write-confirm` "is allowed only inside an approved plan or a one-step
    // confirm card". agent-harness §2 shows the card *before* the dispatch, so the
    // same id is dispatched twice with different flow facts — and a cache that
    // stored the refusal would make the write permanently unconfirmable.
    const descriptor = { ...descriptorWith({ agentRisk: 'write-confirm' }), mutates: 'project' as const };
    const refused = harness({ descriptor });
    const first = refused.run(cmd({ name: 'doc.write', params: { docId: THE_LANDING, body: 'one' } }));

    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.error.code).toBe('permission-denied');
    expect(refused.idempotency.size(TURN)).toBe(0);

    // Same cache, same id, same params, same turn — now with the card answered.
    const confirmed = harness({ descriptor, idempotency: refused.idempotency, permission: { confirmed: true } });
    const second = confirmed.run(cmd({ name: 'doc.write', params: { docId: THE_LANDING, body: 'one' } }));

    expect(second.ok).toBe(true);
    expect(confirmed.applied).toHaveLength(1);
  });

  it('leaves no entry for a conflict refusal, so the same call re-checks instead of replaying it', () => {
    // The gate test above is the decisive one — a context change can turn a
    // refusal into a success. For §6's own check there is no such honest story
    // (re-planning against a moved document means *different* params, which is a
    // fresh call, not a replay), so what is pinned is the mechanism: the refusal
    // is not stored, so the second dispatch re-runs the comparison against the
    // world as it is now rather than answering from the cache.
    const idempotency = createIdempotencyCache();
    let revision = 4;
    const snapshot = () => makeSnapshot({ bodies: { [THE_LANDING]: BODY } });
    const at = () => ({
      ...snapshot(),
      documents: new Map([[THE_LANDING, { body: BODY, revision }]]),
    });

    const h = harness({
      descriptor: COMMAND_REGISTRY['doc.write'].descriptor,
      permission: AGENT_PLAN,
      idempotency,
      snapshot: at,
    });
    const params = { docId: THE_LANDING, body: 'one', expectedRevision: 7 };
    const first = h.run(cmd({ name: 'doc.write', params }));
    expect(first.ok).toBe(false);
    expect(idempotency.size(TURN)).toBe(0);

    // Same callId, same params, same turn. The document is now at the revision
    // this command planned against; a cache holding the first refusal could not
    // possibly return success here.
    revision = 7;
    const second = h.run(cmd({ name: 'doc.write', params }));

    expect(second.ok).toBe(true);
    expect(h.applied).toHaveLength(1);
    expect(h.log.length).toBe(1);
  });

  it('caches a subscriber failure, because that command is already committed', () => {
    // The pipeline's own message for this case says "Do not retry it — the effect
    // is already committed". A cache that stored only successes would apply it twice.
    const idempotency = createIdempotencyCache();
    const h = harness({
      idempotency,
      notify: () => {
        throw new Error('the render layer fell over');
      },
    });

    const first = h.run(cmd({ name: 'doc.write', params: { docId: THE_LANDING, body: 'one' } }));
    const second = h.run(cmd({ name: 'doc.write', params: { docId: THE_LANDING, body: 'one' } }));

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    if (first.ok || second.ok) return;
    expect(first.error.code).toBe('internal');
    expect(second.error.message).toBe(first.error.message);
    expect(h.applied).toHaveLength(1);
    expect(h.log.length).toBe(1);
  });

  it('caches a postcondition failure, whose effect also stays in place', () => {
    const idempotency = createIdempotencyCache();
    const h = harness({
      idempotency,
      descriptor: descriptorWith({
        undo: 'none',
        postconditions: [{ describe: 'the body is what was sent', assert: () => false }],
      }),
    });

    const first = h.run(cmd({ name: 'doc.write', params: { docId: THE_LANDING, body: 'one' } }));
    const second = h.run(cmd({ name: 'doc.write', params: { docId: THE_LANDING, body: 'one' } }));

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    if (first.ok || second.ok) return;
    expect(first.error.code).toBe('postcondition');
    expect(second.error.code).toBe('postcondition');
    expect(h.applied).toHaveLength(1);
  });

  it('caches a registration refusal — the post-apply failure with nothing to name', () => {
    // `idempotency.ts`'s header enumerates five recorded outcomes and this is the
    // one no fixture reached. It is the sharpest of the five, because the refusal
    // fires *because* the apply captured nothing: the effect is in place, nothing
    // can reverse it, and a re-run would produce a second one.
    const idempotency = createIdempotencyCache();
    const h = harness({
      idempotency,
      descriptor: descriptorWith({ undo: 'compensable' }),
      // The one thing the shared fake never does, because every other test here
      // wants §6 rather than §5's refusal: hand over no capture at all.
      apply: (_state, _params, context) => {
        context.report({ affected: [], summary: 'the concurrency fake' });
        return { written: true };
      },
    });

    const first = h.run(cmd({ name: 'doc.write', params: { docId: THE_LANDING, body: 'one' } }));
    const second = h.run(cmd({ name: 'doc.write', params: { docId: THE_LANDING, body: 'one' } }));

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    if (first.ok || second.ok) return;
    expect(first.error.code).toBe('internal');
    expect(first.error.message).toContain("declares undo: 'compensable'");
    // The apply ran once. That is the whole claim: a cache that held no entry here
    // would apply the same unreversible effect twice under one callId.
    expect(h.applied).toHaveLength(1);
    // And the replay answers with the identical text, which is *not* a
    // contradiction of it. The refusal says "whatever it changed is still in
    // place … there is no undo group that reverses it"; a replay changes nothing
    // in the world, so both halves are still true of it. Were the second dispatch
    // to re-run the apply, this equality would be the only thing still asserting
    // the first dispatch's story over a second effect.
    expect(second.error.message).toBe(first.error.message);
    // One row, from the first dispatch: its apply ran and left the effect, so the
    // log records it (command-bus §8). The replay wrote nothing, because it did
    // nothing — which is the only thing the cache exists to guarantee.
    expect(h.log.length).toBe(1);
  });

  it('does not cache an unresolvable name, so a later registration of it still runs', () => {
    const h = harness();
    const missing = h.run(cmd({ name: 'binder.create', params: { parentId: 'root' } }));
    expect(missing.ok).toBe(false);
    expect(h.idempotency.size(TURN)).toBe(0);
  });
});

describe('§6 — the cache itself', () => {
  it('answers undefined for an id it has never seen', () => {
    const cache = createIdempotencyCache();
    expect(cache.lookup(cmd({ name: 'doc.write', params: {} }))).toBeUndefined();
  });

  it('isolates turns, and size() reports across them or for one', () => {
    const cache = createIdempotencyCache();
    const outcome = ok({ commandId: 'x' } as never);
    cache.record(cmd({ name: 'doc.write', params: { a: 1 } }), outcome);
    cache.record(cmd({ name: 'doc.write', callId: 'call_two', params: { a: 1 } }), outcome);
    cache.record(cmd({ name: 'doc.write', turnId: 'turn_other', params: { a: 1 } }), outcome);

    expect(cache.size(TURN)).toBe(2);
    expect(cache.size('turn_other')).toBe(1);
    expect(cache.size()).toBe(3);

    cache.endTurn(TURN);
    expect(cache.size(TURN)).toBe(0);
    expect(cache.size()).toBe(1);
  });

  it('records nothing for a command without both a turn and a callId', () => {
    const cache = createIdempotencyCache();
    const outcome = ok({ commandId: 'x' } as never);
    cache.record(cmd({ name: 'doc.write', callId: undefined, params: {} }), outcome);
    cache.record(cmd({ name: 'doc.write', turnId: undefined, params: {} }), outcome);
    cache.record(cmd({ name: 'doc.write', turnId: undefined, callId: undefined, params: {} }), outcome);

    expect(cache.size()).toBe(0);
  });

  it('tells two params apart by value, so an unchanged call is not a mismatch', () => {
    const cache = createIdempotencyCache();
    const outcome = ok({ commandId: 'x' } as never);
    cache.record(cmd({ name: 'doc.write', params: { docId: THE_LANDING, body: 'one' } }), outcome);

    expect(cache.lookup(cmd({ name: 'doc.write', params: { body: 'one', docId: THE_LANDING } }))).toBe(outcome);
  });

  // The fingerprint is JSON, and JSON throws on a BigInt and on a cycle. `record`
  // runs after the apply, so that throw would arrive with an effect already
  // written. A value with no JSON form is fingerprinted to something no other call
  // can equal: recording it does not throw, and a replay is a refused mismatch,
  // never a silent answer for a different command.
  it('records a command whose params have no JSON form without throwing, and refuses its replay', () => {
    const cache = createIdempotencyCache();
    const outcome = ok({ commandId: 'x' } as never);
    const loop: Record<string, unknown> = {};
    loop['self'] = loop;

    expect(() => cache.record(cmd({ name: 'doc.write', params: { body: 1n } }), outcome)).not.toThrow();
    expect(() => cache.record(cmd({ name: 'doc.write', callId: 'call_loop', params: { loop } }), outcome)).not.toThrow();
    const replay = cache.lookup(cmd({ name: 'doc.write', callId: 'call_loop', params: { loop } }));
    expect(replay?.ok).toBe(false);
  });

  it('keeps array order significant, because attachTo order is data', () => {
    const cache = createIdempotencyCache();
    const outcome = ok({ commandId: 'x' } as never);
    cache.record(cmd({ name: 'doc.write', params: { ids: ['a', 'b'] } }), outcome);

    const other = cache.lookup(cmd({ name: 'doc.write', params: { ids: ['b', 'a'] } }));
    expect(other?.ok).toBe(false);
  });
});
