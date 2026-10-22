/**
 * `mcp.readResource`, the bus's own floor (extensibility §6, §4 rule 8). The MCP client's descriptor replaces this one at composition, and
 * checks the URI against the live listing. What no replacement may lose is here: the closed key set, the literal `pickedBy: 'writer'`, and
 * `agentRisk: 'never'`, so an agent is refused at the gate and a command without the literal is refused at validate.
 */
import { describe, expect, it } from 'vitest';

import {
  COMMAND_REGISTRY,
  checkPermission,
  createActivityLog,
  createIdempotencyCache,
  createUndoStore,
  createViewState,
  execute,
  executeAsync,
  ok,
  type BusContext,
  type Command,
  type CommandRegistry,
  type ValidationSnapshot,
} from '../src/index.js';

const descriptor = COMMAND_REGISTRY['mcp.readResource'].descriptor;

const PICK = { serverKey: 's_AAAAAAAAAA', uri: 'wiki://bible/mara', pickedBy: 'writer' };

function command(params: Record<string, unknown>, issuedBy: 'user' | 'agent'): Command {
  return { id: 'cmd_READ000001', name: 'mcp.readResource', params, issuedBy, turnId: 'turn-1', callId: 'call-1', createdAt: 0 };
}

describe('the descriptor', () => {
  it('is an external, awaited, non-undoable read that no agent may issue', () => {
    expect(descriptor).toMatchObject({ mutates: 'none', agentRisk: 'never', undo: 'none', activitySource: 'mcp', asyncApply: true });
    expect(descriptor.agentRiskOf).toBeUndefined();
  });

  it('keeps the writer\'s call whole, and drops nothing it was given', () => {
    const snapshot = {} as ValidationSnapshot;
    expect(descriptor.validate(PICK, snapshot)).toEqual(ok(PICK));
    expect(descriptor.validate({ ...PICK, viaTemplate: 'wiki://bible/{page}' }, snapshot)).toEqual(ok({ ...PICK, viaTemplate: 'wiki://bible/{page}' }));
  });

  it('refuses a call without the literal, whatever the value', () => {
    const snapshot = {} as ValidationSnapshot;
    for (const given of [{ serverKey: PICK.serverKey, uri: PICK.uri }, { ...PICK, pickedBy: 'agent' }, { ...PICK, pickedBy: true }, { ...PICK, pickedBy: 'Writer' }]) {
      const result = descriptor.validate(given, snapshot);
      if (result.ok) throw new Error('expected a refusal');
      expect(result.error.code).toBe('permission-denied');
      expect(result.error.target).toBe('pickedBy');
      expect(result.error.correctiveHint).toContain('ask the writer');
    }
  });

  it('refuses a key it does not list, and a blank server or URI', () => {
    const snapshot = {} as ValidationSnapshot;
    expect(descriptor.validate({ ...PICK, args: {} }, snapshot)).toMatchObject({ ok: false, error: { code: 'invalid-params' } });
    expect(descriptor.validate({ ...PICK, serverKey: ' ' }, snapshot)).toMatchObject({ ok: false, error: { code: 'invalid-params', target: 'serverKey' } });
    expect(descriptor.validate({ ...PICK, uri: '' }, snapshot)).toMatchObject({ ok: false, error: { code: 'invalid-params', target: 'uri' } });
    expect(descriptor.validate({ ...PICK, viaTemplate: '' }, snapshot)).toMatchObject({ ok: false, error: { code: 'invalid-params', target: 'viaTemplate' } });
  });
});

describe('the gate', () => {
  it('refuses an agent whatever it sends, and lets the writer\'s own gesture through', () => {
    const agent = checkPermission(descriptor, command(PICK, 'agent'), {});
    expect(agent.ok).toBe(false);
    if (!agent.ok) expect(agent.error).toMatchObject({ code: 'permission-denied', risk: 'never' });
    expect(checkPermission(descriptor, command(PICK, 'user'), {}).ok).toBe(true);
  });

  it('refuses an agent even inside an approved plan or with a confirmation', () => {
    expect(checkPermission(descriptor, command(PICK, 'agent'), { approvedPlan: true }).ok).toBe(false);
    expect(checkPermission(descriptor, command(PICK, 'agent'), { confirmed: true }).ok).toBe(false);
  });
});

describe('through the pipeline, with a stand-in apply', () => {
  function busFor() {
    let reached = 0;
    const registry = {
      ...COMMAND_REGISTRY,
      'mcp.readResource': {
        descriptor,
        apply: async (_state: unknown, _params: unknown, context: { report: (report: { affected: []; summary: string }) => void }) => {
          reached += 1;
          context.report({ affected: [], summary: 'read a resource (external resource)' });
          return { untrusted: true };
        },
      },
    } as unknown as CommandRegistry;
    const bus: BusContext<unknown> = {
      state: {},
      view: createViewState(),
      read: () => ({}) as ValidationSnapshot,
      undo: createUndoStore(),
      log: createActivityLog(),
      idempotency: createIdempotencyCache(),
      notify: () => undefined,
    };
    return { registry, bus, reached: () => reached };
  }

  it('does not reach the apply for an agent, or for a command without the literal', async () => {
    const { registry, bus, reached } = busFor();
    expect((await executeAsync(command(PICK, 'agent'), bus, registry)).ok).toBe(false);
    expect((await executeAsync(command({ serverKey: PICK.serverKey, uri: PICK.uri }, 'user'), bus, registry)).ok).toBe(false);
    expect(reached()).toBe(0);
  });

  it('reaches the apply for the writer, through executeAsync only', async () => {
    const { registry, bus, reached } = busFor();
    const sync = execute(command(PICK, 'user'), bus, registry);
    if (sync.ok) throw new Error('expected a refusal');
    expect(sync.error.message).toContain('executeAsync');
    expect(reached()).toBe(0);
    const done = await executeAsync(command(PICK, 'user'), bus, registry);
    expect(done.ok).toBe(true);
    expect(reached()).toBe(1);
  });
});
