/**
 * The refusals that come before the SDK: the bus's hard-deny, and the read-only server's
 * write refusal. Everything else passes through.
 */

import { describe, expect, it } from 'vitest';

import { RECOVER_APPLY_TOOL, RECOVER_TOOL, guardBatch, guardDegraded, guardMessage, hardDeniedError, openProjectOrOffer } from '../src/index.js';
import { brokenFolder, removeDir } from './support.js';

function call(name: string, id: number | string = 1) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } };
}

describe('guardMessage', () => {
  it('refuses a hard-denied command with the bus message, whatever the policy', () => {
    for (const allowWrites of [false, true]) {
      const refusal = guardMessage(call('project.deleteNode'), { allowWrites });
      expect(refusal).toBeDefined();
      expect(refusal?.result.isError).toBe(true);
      expect(refusal?.result.resultType).toBe('complete');
      expect(refusal?.result.structuredContent.error.code).toBe('hard-denied');
      expect(refusal?.result.structuredContent.error.message).toContain('hard-denied for an agent (deletion)');
    }
  });

  it('refuses a write tool on a read-only server, naming the flag that turns writes on', () => {
    for (const name of ['meta.set', 'doc.import', 'binder.restructure']) {
      const refusal = guardMessage(call(name), { allowWrites: false });
      expect(refusal?.result.structuredContent.error.code).toBe('permission-denied');
      expect(refusal?.result.structuredContent.error.message).toContain('--allow-writes');
    }
  });

  it('lets a write tool through when writes are allowed, and a read tool through always', () => {
    expect(guardMessage(call('meta.set'), { allowWrites: true })).toBeUndefined();
    expect(guardMessage(call('project.overview'), { allowWrites: false })).toBeUndefined();
  });

  it('passes every message that is not a tool call, and an unknown name to the SDK to answer', () => {
    expect(guardMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, { allowWrites: false })).toBeUndefined();
    expect(guardMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, { allowWrites: false })).toBeUndefined();
    expect(guardMessage(call('not.a.tool'), { allowWrites: false })).toBeUndefined();
    expect(guardMessage('not even an object', { allowWrites: false })).toBeUndefined();
  });

  it('answers with the request id, so the response pairs with its request', () => {
    expect(guardMessage(call('project.deleteNode', 'abc'), { allowWrites: true })?.id).toBe('abc');
  });
});

describe('guardBatch', () => {
  it('refuses a batch that carries a refused call, as a whole', () => {
    const refusal = guardBatch([call('project.overview'), call('project.deleteNode', 2)], { allowWrites: true });
    expect(refusal?.result.structuredContent.error.code).toBe('invalid-params');
    expect(refusal?.result.structuredContent.error.message).toContain('the whole batch was not run');
  });

  it('lets a batch of allowed calls through', () => {
    expect(guardBatch([call('project.overview'), call('binder.read_tree', 2)], { allowWrites: false })).toBeUndefined();
  });
});

describe('hardDeniedError', () => {
  it('is defined for the one hard-denied command, and not for an ordinary one', () => {
    expect(hardDeniedError('project.deleteNode')).toBeDefined();
    expect(hardDeniedError('meta.set')).toBeUndefined();
    expect(hardDeniedError('nonsense')).toBeUndefined();
  });
});

describe('guardMessage on a degraded server', () => {
  async function withDegraded(allowWrites: boolean, run: (policy: Parameters<typeof guardMessage>[1]) => void): Promise<void> {
    const root = await brokenFolder('guard-degraded', 'snapshot');
    const session = await openProjectOrOffer({ root, allowWrites });
    try {
      if (!('degraded' in session)) throw new Error('the folder opened as a project');
      run({ allowWrites, degraded: (name) => guardDegraded(session, name) });
    } finally {
      await session.close();
      removeDir(root);
    }
  }

  it('refuses every other tool with the named reason, as a tool result, writes or not', async () => {
    for (const allowWrites of [false, true]) {
      await withDegraded(allowWrites, (policy) => {
        for (const name of ['project.overview', 'doc.read', 'meta.set', 'binder.restructure', 'export.compile', 'not.a.tool']) {
          const refusal = guardMessage(call(name, 7), policy);
          expect(refusal?.id).toBe(7);
          expect(refusal?.result.isError).toBe(true);
          expect(refusal?.result.resultType).toBe('complete');
          expect(refusal?.result.structuredContent.error.message).toContain('this project could not be opened; recover it first');
          expect(refusal?.result.structuredContent.error.correctiveHint).toContain(RECOVER_TOOL);
        }
      });
    }
  });

  it('lets the two recovery tools reach their handlers, and keeps the hard-deny and the read-only refusal in front', async () => {
    await withDegraded(true, (policy) => {
      expect(guardMessage(call(RECOVER_TOOL), policy)).toBeUndefined();
      expect(guardMessage(call(RECOVER_APPLY_TOOL), policy)).toBeUndefined();
      expect(guardMessage(call('project.deleteNode'), policy)?.result.structuredContent.error.code).toBe('hard-denied');
    });
    await withDegraded(false, (policy) => {
      expect(guardMessage(call(RECOVER_TOOL), policy)).toBeUndefined();
      expect(guardMessage(call(RECOVER_APPLY_TOOL), policy)?.result.structuredContent.error.message).toContain('--allow-writes');
    });
  });

  it('refuses a batch that carries a call a degraded server refuses', async () => {
    await withDegraded(true, (policy) => {
      expect(guardBatch([call(RECOVER_TOOL), call('doc.read', 2)], policy)?.result.structuredContent.error.code).toBe('invalid-params');
      expect(guardBatch([call(RECOVER_TOOL)], policy)).toBeUndefined();
    });
  });
});
