/**
 * Step-tagged undo entries and `UndoStore.undoFrom` (undo.ts, command-bus §5): an entry carries the `callId` of the agent tool call
 * that made it, and a restore to before one step compensates that step and every later one, newest first, leaving the earlier
 * steps applied and the group in place. The "document" is a list of lines; a step appends lines and its restore truncates back.
 */

import { describe, expect, it } from 'vitest';

import {
  COMMAND_REGISTRY,
  createActivityLog,
  createIdempotencyCache,
  createUndoStore,
  createViewState,
  execute,
  type ApplyContext,
  type BusContext,
  type Command,
  type CommandApply,
  type CommandRegistry,
  type UndoEntry,
  type UndoStore,
} from '../src/index.js';
import { makeSnapshot } from './fixtures.js';

type Lines = string[];

interface Rig {
  readonly lines: Lines;
  readonly undo: UndoStore;
  readonly bus: BusContext<Lines>;
  readonly registry: CommandRegistry;
}

/** A bus over a list of lines. `doc.write` appends `params.lines` and registers a compensation that truncates back. */
function rig(options: { failing?: readonly string[]; dispatchInverses?: boolean } = {}): Rig {
  const lines: Lines = [];
  const inverse = options.dispatchInverses === true;
  const registry = {
    ...COMMAND_REGISTRY,
    'doc.write': {
      descriptor: {
        mutates: 'project',
        agentRisk: 'write-auto',
        undo: inverse ? 'inverse' : 'compensable',
        validate: (params: unknown) => ({ ok: true, value: params as Record<string, unknown> }),
      },
      apply: ((state: Lines, params: { lines: string[]; drop?: number }, context: ApplyContext) => {
        // The inverse of an append is a command that drops what was added.
        if (params.drop !== undefined) {
          state.length -= params.drop;
          // The bus asks every inverse-declared apply for a capture; during a replay it is discarded, not registered.
          context.undo.inverse({ id: 'cmd_INVERSE002', name: 'doc.write', params: { lines: [], drop: 0 }, issuedBy: 'user', createdAt: 1 });
          context.report({ affected: [], summary: `dropped ${params.drop}` });
          return null;
        }
        const before = state.length;
        state.push(...params.lines);
        if (inverse) {
          context.undo.inverse({
            id: 'cmd_INVERSE001',
            name: 'doc.write',
            params: { lines: [], drop: params.lines.length },
            issuedBy: 'user',
            createdAt: 1,
          });
        } else {
          context.undo.compensate(`truncate to ${before}`, () => {
            if (options.failing?.includes(params.lines[0]!) === true) throw new Error(`cannot take back ${params.lines[0]}`);
            state.length = before;
          });
        }
        context.report({ affected: [], summary: `wrote ${params.lines.join(' ')}` });
        return null;
      }) as CommandApply<never, unknown>,
    },
  } as unknown as CommandRegistry;
  const bus: BusContext<Lines> = {
    state: lines,
    view: createViewState(),
    read: () => makeSnapshot(),
    get undo() {
      return undo;
    },
    log: createActivityLog(),
    idempotency: createIdempotencyCache(),
    notify: () => undefined,
  };
  const undo: UndoStore = createUndoStore(inverse ? { dispatch: (command) => execute(command, bus as BusContext, registry) } : {});
  return { lines, undo, bus, registry };
}

let serial = 0;
function write(r: Rig, callId: string | undefined, ...lines: string[]): void {
  serial += 1;
  const command: Command = {
    id: `cmd_${String(serial).padStart(10, '0')}`,
    name: 'doc.write',
    params: { lines },
    issuedBy: callId === undefined ? 'user' : 'agent',
    ...(callId === undefined ? {} : { turnId: 'turn_1', callId }),
    createdAt: 1_760_000_000_000,
  };
  const outcome = execute(command, r.bus as BusContext, r.registry);
  expect(outcome.ok).toBe(true);
}

/** Runs the given steps (`callId` and the line it writes) in a fresh rig. */
function turnOf(...steps: readonly (readonly [string, string])[]): Rig {
  const r = rig();
  for (const [callId, line] of steps) write(r, callId, line);
  return r;
}

const groupOf = (r: Rig) => r.undo.groups()[0]!;

describe('entries carry the callId of the agent call that made them', () => {
  it('tags an agent command and leaves a user gesture without one', () => {
    const r = rig();
    write(r, 'p.1', 'a');
    write(r, undefined, 'b');
    const entries: UndoEntry[] = r.undo.groups().flatMap((group) => [...group.entries]);
    expect(entries.map((entry) => entry.callId)).toEqual(['p.1', undefined]);
  });
});

describe('undoFrom', () => {
  it('on step 3 of 5 leaves steps 1 and 2 applied, equal to a run of only those steps, and keeps the group', () => {
    const five = turnOf(['s.1', 'one'], ['s.2', 'two'], ['s.3', 'three'], ['s.4', 'four'], ['s.5', 'five']);
    const twoOnly = turnOf(['s.1', 'one'], ['s.2', 'two']);
    const id = groupOf(five).id;

    const outcome = five.undo.undoFrom(id, 's.3');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.undone.map((entry) => entry.callId)).toEqual(['s.5', 's.4', 's.3']);
    expect(outcome.value.failures).toEqual([]);
    expect(five.lines).toEqual(twoOnly.lines);
    expect(five.undo.group(id)?.entries.map((entry) => entry.callId)).toEqual(['s.1', 's.2']);
    // What is left is still one undoable group.
    expect(five.undo.undo(id).ok).toBe(true);
    expect(five.lines).toEqual([]);
    expect(five.undo.groups()).toEqual([]);
  });

  it('on the first step is the whole group, and the group goes', () => {
    const r = turnOf(['s.1', 'one'], ['s.2', 'two']);
    const id = groupOf(r).id;
    expect(r.undo.undoFrom(id, 's.1').ok).toBe(true);
    expect(r.lines).toEqual([]);
    expect(r.undo.group(id)).toBeUndefined();
  });

  it('takes a step’s sub-commands and port retries with it, and not a longer id that only shares its digits', () => {
    const r = turnOf(['p.1', 'a'], ['p.10', 'b'], ['p.2:0', 'c'], ['p.2:1', 'd'], ['p.3:port:2', 'e']);
    const id = groupOf(r).id;

    const start = r.undo.undoFrom(id, 'p.2');
    expect(start.ok && start.value.undone.map((entry) => entry.callId)).toEqual(['p.3:port:2', 'p.2:1', 'p.2:0']);
    expect(r.lines).toEqual(['a', 'b']);

    // `p.1` is a prefix of `p.10`: it selects its own entry, not the longer id's, and takes the later one with it.
    const tail = r.undo.undoFrom(id, 'p.1');
    expect(tail.ok && tail.value.undone.map((entry) => entry.callId)).toEqual(['p.10', 'p.1']);
    expect(r.lines).toEqual([]);
  });

  it('does not take a step whose id only begins with the digits of another', () => {
    const r = turnOf(['p.1', 'a'], ['p.10', 'b'], ['p.11', 'c']);
    const outcome = r.undo.undoFrom(groupOf(r).id, 'p.10');
    expect(outcome.ok && outcome.value.undone.map((entry) => entry.callId)).toEqual(['p.11', 'p.10']);
    expect(r.lines).toEqual(['a']);
  });

  it('is not-found for a call id no entry carries, and for a group that is gone, and changes nothing', () => {
    const r = turnOf(['s.1', 'one'], ['s.2', 'two']);
    const id = groupOf(r).id;

    const missingStep = r.undo.undoFrom(id, 's.9');
    expect(missingStep.ok).toBe(false);
    if (!missingStep.ok) expect(missingStep.error.code).toBe('not-found');
    // An id that merely begins with a step's text is not that step.
    expect(r.undo.undoFrom(id, 's').ok).toBe(false);
    expect(r.lines).toEqual(['one', 'two']);

    const missingGroup = r.undo.undoFrom('grp_none', 's.1');
    expect(missingGroup.ok).toBe(false);
    if (!missingGroup.ok) expect(missingGroup.error.code).toBe('not-found');
    expect(r.undo.group(id)?.entries).toHaveLength(2);
  });

  it('never selects an untagged entry, so a user gesture cannot be named as a step', () => {
    const r = rig();
    write(r, 's.1', 'one');
    write(r, undefined, 'typed');
    // A user gesture is its own group; the turn's group holds only the tagged entry.
    expect(r.undo.groups()).toHaveLength(2);
    expect(r.undo.undoFrom(r.undo.groups()[1]!.id, 's.1').ok).toBe(false);
  });

  it('keeps an entry that fails, in order, with the group, and a retry takes only what is still applied', () => {
    const r = rig({ failing: ['three'] });
    for (const [callId, line] of [['s.1', 'one'], ['s.2', 'two'], ['s.3', 'three'], ['s.4', 'four']] as const) write(r, callId, line);
    const id = groupOf(r).id;

    const outcome = r.undo.undoFrom(id, 's.2');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.undone.map((entry) => entry.callId)).toEqual(['s.4', 's.2']);
    expect(outcome.value.failures.map((failure) => failure.message)).toEqual([expect.stringContaining('cannot take back three')]);
    // The step before the start stays applied, and the entry that failed stays, in registration order.
    expect(r.undo.group(id)?.entries.map((entry) => entry.callId)).toEqual(['s.1', 's.3']);
  });

  it('replays an inverse through the dispatcher without registering an entry of its own', () => {
    const r = rig({ dispatchInverses: true });
    for (const [callId, line] of [['s.1', 'one'], ['s.2', 'two'], ['s.3', 'three']] as const) write(r, callId, line);
    const id = groupOf(r).id;

    const outcome = r.undo.undoFrom(id, 's.2');

    expect(outcome.ok && outcome.value.failures).toEqual([]);
    expect(r.lines).toEqual(['one']);
    // The inverses were replays: the group holds only the step that is still applied, and no group appeared.
    expect(r.undo.groups().map((group) => group.entries.map((entry) => entry.callId))).toEqual([['s.1']]);
    expect(r.undo.replayingGroupId()).toBeUndefined();
  });
});
