/**
 * The asynchronous dispatch that `mcp.invoke` needs (extensibility §6; command-bus §3, §4, §7, §8).
 *
 * The synchronous `execute()` keeps refusing a promise, which A2 requires. `executeAsync()` runs the same steps
 * and awaits the apply. These tests pin what the awaited path must keep: the gate reads the risk of the call
 * (`agentRiskOf`), the row carries the command's own source (`activitySource`), and a refusal the apply raises
 * comes back as the refusal it is, not as an internal defect.
 */
import { describe, expect, it } from 'vitest';

import {
  ApplyRefusal,
  COMMAND_REGISTRY,
  createActivityLog,
  createIdempotencyCache,
  createUndoStore,
  createViewState,
  err,
  execute,
  executeAsync,
  ok,
  type BusContext,
  type Command,
  type CommandDescriptor,
  type CommandError,
  type CommandRegistry,
  type PermissionContext,
  type ValidationSnapshot,
} from '../src/index.js';

/**
 * A stand-in external call: validates to its effective risk, applies asynchronously, and reports one row. It is declared
 * `asyncApply`, as `mcp.invoke` is, so the synchronous bus refuses it before its apply runs.
 */
const descriptor: CommandDescriptor<unknown> = {
  mutates: 'none',
  agentRisk: 'write-confirm',
  undo: 'none',
  activitySource: 'mcp',
  asyncApply: true,
  agentRiskOf: (normalized) => ((normalized as { readonly risk: string }).risk === 'read-auto' ? 'read' : 'write-confirm'),
  validate: (params) => {
    const given = params as { readonly effectiveRisk: string } & Record<string, unknown>;
    return ok({ toolName: given['toolName'], risk: given.effectiveRisk === 'read-auto' ? 'read-auto' : 'write-confirm' });
  },
};

const apply = async (_state: unknown, params: unknown, context: { report: (report: { affected: []; summary: string }) => void }) => {
  const toolName = (params as { readonly toolName: string }).toolName;
  await Promise.resolve();
  context.report({ affected: [], summary: `called ${toolName} (external)` });
  return { content: [{ type: 'text', text: 'done' }], isError: false };
};

const registry: CommandRegistry = { ...COMMAND_REGISTRY, 'mcp.invoke': { descriptor, apply } } as unknown as CommandRegistry;

function busFor(permission?: PermissionContext) {
  const log = createActivityLog();
  const bus: BusContext<unknown> = {
    state: {},
    view: createViewState(),
    read: () => ({}) as unknown as ValidationSnapshot,
    ...(permission === undefined ? {} : { permission }),
    undo: createUndoStore({ dispatch: (command) => execute(command, bus, registry) }),
    log,
    idempotency: createIdempotencyCache(),
    notify: () => {},
  };
  return { bus, log };
}

function call(params: Record<string, unknown>, callId: string): Command {
  return { id: `cmd_${callId}`, name: 'mcp.invoke', params, issuedBy: 'agent', turnId: 'turn-1', callId, createdAt: 1 };
}

describe('executeAsync — the apply is awaited, and every other step is the synchronous one', () => {
  it('shares one in-flight apply and result for concurrent copies of a turn-scoped callId', async () => {
    const { bus, log } = busFor();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    let calls = 0;
    const slowRegistry = { ...registry, 'mcp.invoke': { descriptor, apply: async (...args: Parameters<typeof apply>) => {
      calls += 1;
      await pending;
      return apply(...args);
    } } } as unknown as CommandRegistry;
    const command = call({ toolName: 'search_lore', effectiveRisk: 'read-auto' }, 'same');
    const first = executeAsync(command, bus, slowRegistry);
    const second = executeAsync({ ...command, params: { effectiveRisk: 'read-auto', toolName: 'search_lore' } }, bus, slowRegistry);
    finish();
    const [a, b] = await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(b).toBe(a);
    expect(log.entries()).toHaveLength(1);
  });

  it('refuses a different command and a synchronous replay while the first call is applying', async () => {
    const { bus, log } = busFor();
    const command = call({ toolName: 'search_lore', effectiveRisk: 'read-auto' }, 'pending');
    const first = executeAsync(command, bus, registry);
    const mismatch = await executeAsync({ ...command, params: { toolName: 'other', effectiveRisk: 'read-auto' } }, bus, registry);
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error.message).toContain('different command');
    const sync = execute(command, bus, registry);
    expect(sync.ok).toBe(false);
    if (!sync.ok) expect(sync.error.message).toContain('still applying');
    expect((await first).ok).toBe(true);
    expect(log.entries()).toHaveLength(1);
  });

  it('does not resurrect a turn cache after a pending apply settles', async () => {
    const { bus } = busFor();
    const command = call({ toolName: 'search_lore', effectiveRisk: 'read-auto' }, 'ending');
    const first = executeAsync(command, bus, registry);
    bus.idempotency.endTurn('turn-1');
    expect((await first).ok).toBe(true);
    expect(bus.idempotency.size()).toBe(0);
  });

  it('reserves the promise before the apply can dispatch a reentrant copy', async () => {
    const { bus, log } = busFor();
    const command = call({ toolName: 'search_lore', effectiveRisk: 'read-auto' }, 'reentrant');
    let reentrant!: Promise<Awaited<ReturnType<typeof executeAsync>>>;
    let calls = 0;
    const reentrantRegistry = { ...registry, 'mcp.invoke': { descriptor, apply: async (...args: Parameters<typeof apply>) => {
      calls += 1;
      if (calls === 1) reentrant = executeAsync(command, bus, reentrantRegistry);
      return apply(...args);
    } } } as unknown as CommandRegistry;
    const result = await executeAsync(command, bus, reentrantRegistry);
    expect(await reentrant).toBe(result);
    expect(calls).toBe(1);
    expect(log.entries()).toHaveLength(1);
  });

  it('does not deduplicate calls without both a turnId and a callId', async () => {
    const { bus, log } = busFor();
    const command = call({ toolName: 'search_lore', effectiveRisk: 'read-auto' }, 'unscoped');
    delete command.turnId;
    await Promise.all([executeAsync(command, bus, registry), executeAsync(command, bus, registry)]);
    expect(log.entries()).toHaveLength(2);
    expect(bus.idempotency.size()).toBe(0);
  });

  it('runs an asynchronous apply to its result, and writes its row under the command’s own source', async () => {
    const { bus, log } = busFor();
    const result = await executeAsync(call({ toolName: 'search_lore', effectiveRisk: 'read-auto' }, 'c-read'), bus, registry, 'native');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result).toMatchObject({ isError: false });
    expect(log.entries()).toHaveLength(1);
    // The caller said 'native'. The command is an external call by definition, so its row says 'mcp'.
    expect(log.entries()[0]).toMatchObject({ command: 'mcp.invoke', source: 'mcp', summary: 'called search_lore (external)' });
  });

  it('refuses an asynchronous command through execute() before its apply runs, and names executeAsync (A2, extensibility §6)', async () => {
    // The apply reaches the transport before its first await, the way `mcp.invoke`'s does. Had execute() admitted it,
    // the external call would have gone out with no row, no undo entry and no record.
    let transportCalls = 0;
    const reaching = async (_state: unknown, params: unknown, context: { report: (report: { affected: []; summary: string }) => void }) => {
      transportCalls += 1;
      await Promise.resolve();
      context.report({ affected: [], summary: `reached ${(params as { readonly toolName: string }).toolName} (external)` });
      return { content: [{ type: 'text', text: 'reached the server' }], isError: false };
    };
    const reachingRegistry = { ...registry, 'mcp.invoke': { descriptor, apply: reaching } } as unknown as CommandRegistry;
    const { bus, log } = busFor();
    const result = execute(call({ toolName: 'search_lore', effectiveRisk: 'read-auto' }, 'c-sync'), bus, reachingRegistry);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('internal');
    expect(result.error.message).toContain('executeAsync');
    expect(transportCalls).toBe(0);
    expect(log.entries()).toHaveLength(0);
    // The refusal is not recorded as the call's answer, so the same callId awaited later runs once.
    const later = await executeAsync(call({ toolName: 'search_lore', effectiveRisk: 'read-auto' }, 'c-sync'), bus, reachingRegistry);
    expect(later.ok).toBe(true);
    expect(transportCalls).toBe(1);
  });

  it('drops a promise a synchronous apply returned without leaving its rejection unhandled (A2)', async () => {
    // Not declared asynchronous, so the apply runs, and the bus refuses the promise after the effect (the safety net).
    const undeclared: CommandDescriptor<unknown> = { ...descriptor };
    delete undeclared.asyncApply;
    let applied = 0;
    const rejecting = (): Promise<never> => {
      applied += 1;
      return Promise.reject(new Error('socket reset'));
    };
    const undeclaredRegistry = { ...registry, 'mcp.invoke': { descriptor: undeclared, apply: rejecting } } as unknown as CommandRegistry;
    const { bus } = busFor({ confirmed: true });
    const result = execute(call({ toolName: 'broken', effectiveRisk: 'write-confirm' }, 'c-thenable'), bus, undeclaredRegistry);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('returned a promise');
    expect(applied).toBe(1);
    // Vitest fails the run on an unhandled rejection, so one would surface during this turn of the event loop.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe('the per-call risk (extensibility §4 rule 2, §6)', () => {
  it('lets a read the user has trusted run without an approval', async () => {
    const { bus } = busFor();
    const result = await executeAsync(call({ toolName: 'read_it', effectiveRisk: 'read-auto' }, 'c-trusted'), bus, registry);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.grant).toMatchObject({ risk: 'read', via: 'auto' });
  });

  it('refuses a write-confirm call without an approval, whatever the floor says', async () => {
    const { bus, log } = busFor();
    const result = await executeAsync(call({ toolName: 'write_it', effectiveRisk: 'write-confirm' }, 'c-write'), bus, registry);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('permission-denied');
    // Refused at the gate, before the apply: nothing ran, so no row.
    expect(log.entries()).toHaveLength(0);
  });

  it('lets the same write-confirm call through once the turn carries a one-step confirmation', async () => {
    const { bus } = busFor({ confirmed: true });
    const result = await executeAsync(call({ toolName: 'write_it', effectiveRisk: 'write-confirm' }, 'c-confirmed'), bus, registry);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.grant).toMatchObject({ risk: 'write-confirm', via: 'confirm-card' });
  });
});

describe('an apply’s own refusal (command-bus §7)', () => {
  it('returns the refusal the apply carries, and writes the row for the attempt the apply reported', async () => {
    const refusal: CommandError = { code: 'not-found', message: 'no server with key s_x is configured', correctiveHint: 'call tool.search first' };
    const refusing = async (_state: unknown, _params: unknown, context: { report: (report: { affected: []; summary: string }) => void }) => {
      await Promise.resolve();
      context.report({ affected: [], summary: 'refused s_x › gone (external): no server' });
      throw new ApplyRefusal(refusal);
    };
    const refusingRegistry = { ...registry, 'mcp.invoke': { descriptor, apply: refusing } } as unknown as CommandRegistry;
    const { bus, log } = busFor({ confirmed: true });
    const result = await executeAsync(call({ toolName: 'gone', effectiveRisk: 'write-confirm' }, 'c-refused'), bus, refusingRegistry);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: 'not-found', message: refusal.message, correctiveHint: refusal.correctiveHint });
    expect(log.entries()).toHaveLength(1);
    expect(log.entries()[0]).toMatchObject({ source: 'mcp', summary: 'refused s_x › gone (external): no server' });
  });

  it('treats any other rejection as a defect in the apply, as a throw is', async () => {
    const broken = async () => {
      await Promise.resolve();
      throw new Error('socket reset');
    };
    const brokenRegistry = { ...registry, 'mcp.invoke': { descriptor, apply: broken } } as unknown as CommandRegistry;
    const { bus } = busFor({ confirmed: true });
    const result = await executeAsync(call({ toolName: 'broken', effectiveRisk: 'write-confirm' }, 'c-broken'), bus, brokenRegistry);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('internal');
    expect(result.error.message).toContain('socket reset');
  });

  it('keeps a validation refusal ahead of the apply, so nothing is awaited for a call that was never valid', async () => {
    let applied = false;
    const counting = async () => {
      applied = true;
      return undefined;
    };
    const countingRegistry = {
      ...registry,
      'mcp.invoke': {
        descriptor: { ...descriptor, validate: () => err({ code: 'invalid-params', message: 'no', correctiveHint: 'x' }) },
        apply: counting,
      },
    } as unknown as CommandRegistry;
    const { bus } = busFor({ confirmed: true });
    const result = await executeAsync(call({ toolName: 'x', effectiveRisk: 'read-auto' }, 'c-invalid'), bus, countingRegistry);
    expect(result.ok).toBe(false);
    expect(applied).toBe(false);
  });
});
