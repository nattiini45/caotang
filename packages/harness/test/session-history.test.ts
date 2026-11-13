import { describe, expect, it } from 'vitest';

import { estimateTokens, type TurnContext } from '../src/index.js';
import type { RecentTurn } from '@caotang/context';
import { FRIEND, makeHarness } from './fixtures.js';
import { modelResult, turnNonce } from '../src/agent/untrusted.js';

describe('session.history reads only its role-local readable history', () => {
  it.each([false, true])('fits the complete external envelope after invisible-character expansion with scoped read rules %s', (restricted) => {
    const harness = makeHarness({ rules: () => ({ rules: restricted ? [{ source: 'app', tool: 'doc.read', effect: 'deny', access: 'read', scope: { subtree: FRIEND } }] : [] }) });
    const turnId = 'role.turn-101';
    const result = harness.call({ name: 'session.history', callId: 'enveloped', params: { limit: 50 } }, {
      turnId,
      sessionHistory: Array.from({ length: 100 }, (_, index) => ({ turnId: `role.turn-${index + 1}`, intent: '\u200b'.repeat(800), outcome: '\u200b'.repeat(800), external: true })),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const wire = modelResult({ tool: 'session.history', ok: true, body: result.value.data }, turnNonce(turnId));
    expect(estimateTokens(wire)).toBeLessThanOrEqual(4_000);
    expect(wire).toContain('mcp-history:session-history');
    expect(wire.includes('outcomeWithheld')).toBe(restricted);
    expect(result.value.data['truncated']).toBe(true);
    expect(result.value.data['nextBefore']).not.toBeNull();
  });

  it('pages newest first without hidden or rewound turns', () => {
    const harness = makeHarness();
    const result = harness.call({ name: 'session.history', callId: 'history-1', params: { limit: 2 } }, {
      turnId: 'role.turn-6', sessionId: 'saved-session',
      sessionHistory: [
        { turnId: 'role.turn-1', intent: 'Find the letter.', outcome: 'The ferryman has it.' },
        { turnId: 'role.turn-2', intent: 'Hidden macro.', outcome: 'Private.', hidden: true },
        { turnId: 'role.turn-3', intent: 'Read the storm.', outcome: 'The storm closes the route.', undoGroupId: 'undo-3' },
        { turnId: 'role.turn-4', intent: 'Old draft.', outcome: 'Rewound.', rewound: true },
        { turnId: 'role.turn-5', intent: 'Read the final scene.', outcome: 'The lighthouse stays lit.' },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data).toEqual({
      turns: [
        { turnId: 'role.turn-5', intent: 'Read the final scene.', outcome: 'The lighthouse stays lit.' },
        { turnId: 'role.turn-3', intent: 'Read the storm.', outcome: 'The storm closes the route.', undoGroupId: 'undo-3' },
      ],
      total: 3, nextBefore: 'role.turn-3', truncated: true,
    });
  });

  it('continues exclusively before the previous page’s cursor and returns null at the end', () => {
    const harness = makeHarness();
    const sessionHistory: RecentTurn[] = [1, 2, 3].map((n) => ({ turnId: `role.turn-${n}`, intent: `Request ${n}`, outcome: `Answer ${n}` }));
    const turn = { turnId: 'role.turn-4', sessionHistory };
    const result = harness.call({ name: 'session.history', callId: 'page-2', params: { before: 'role.turn-2' } }, turn);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data).toEqual({ turns: [{ turnId: 'role.turn-1', intent: 'Request 1', outcome: 'Answer 1' }], total: 3, nextBefore: null, truncated: false });
    expect(sessionHistory.map((entry) => entry.turnId)).toEqual(['role.turn-1', 'role.turn-2', 'role.turn-3']);
  });

  it('defaults to ten turns and returns no unrelated role data', () => {
    const harness = makeHarness();
    const sessionHistory = Array.from({ length: 12 }, (_, n) => ({ turnId: `role.turn-${n + 1}`, intent: `Request ${n + 1}` }));
    const result = harness.call({ name: 'session.history', callId: 'default-page', params: {} }, { turnId: 'role.turn-13', sessionHistory });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data['turns']).toHaveLength(10);
    expect(result.value.data['nextBefore']).toBe('role.turn-3');
    expect(result.value.data['total']).toBe(12);
    expect(result.value.data['truncated']).toBe(true);
  });

  it('refuses a missing or hidden cursor instead of searching another role or exposing a hidden turn', () => {
    const harness = makeHarness();
    for (const before of ['other-role.turn-1', 'hidden.turn-2']) {
      const result = harness.call({ name: 'session.history', callId: before, params: { before } }, {
        turnId: 'role.turn-3', sessionHistory: [
          { turnId: 'role.turn-1', intent: 'Visible.' },
          { turnId: 'hidden.turn-2', intent: 'Hidden.', hidden: true },
        ],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('not in this role’s readable history');
    }
  });

  it('keeps restore metadata without presenting restored work as a fresh change', () => {
    const harness = makeHarness();
    const result = harness.call({ name: 'session.history', callId: 'restored', params: {} }, {
      turnId: 'role.turn-2', sessionHistory: [{ turnId: 'role.turn-1', intent: 'Draft the storm.', outcome: 'Drafted the storm.', undoGroupId: 'undo-1', restoredAt: 100, restoredFromStep: 2 }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data['turns']).toEqual([{ turnId: 'role.turn-1', intent: 'Draft the storm.', outcome: 'Drafted the storm.', undoGroupId: 'undo-1', restoredAt: 100, restoredFromStep: 2 }]);
  });

  it('bounds large lines and whole pages under the four-thousand-token response cap', () => {
    const harness = makeHarness();
    const result = harness.call({ name: 'session.history', callId: 'bounded', params: { limit: 50 } }, {
      turnId: 'role.turn-101', sessionHistory: Array.from({ length: 100 }, (_, n) => ({ turnId: `role.turn-${n + 1}`, intent: 'i'.repeat(2_000), outcome: 'o'.repeat(2_000) })),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(estimateTokens(JSON.stringify(result.value))).toBeLessThanOrEqual(4_000);
    expect(result.value.data['truncated']).toBe(true);
    expect(result.value.data['total']).toBe(100);
    const turns = result.value.data['turns'] as readonly { readonly turnId: string; readonly intent: string; readonly outcome: string }[];
    expect(turns.length).toBeGreaterThan(0);
    expect(turns.length).toBeLessThan(50);
    expect(turns[0]?.intent).toBe(`${'i'.repeat(1_199)}…`);
    expect(result.value.data['nextBefore']).toBe(turns.at(-1)?.turnId);
  });

  it('refuses calls without a bound current history, including delegated and external callers', () => {
    const harness = makeHarness();
    const base: TurnContext = { turnId: 'role.turn-2', sessionHistory: [{ turnId: 'role.turn-1', intent: 'Private role words.' }] };
    for (const turn of [{ turnId: base.turnId }, { ...base, agentPath: 'role.turn-2/reader#1' }, { ...base, source: 'mcp' as const }]) {
      const result = harness.call({ name: 'session.history', callId: 'isolated', params: {} }, turn);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain('Private role words.');
    }
    expect(harness.external.tools().some((tool) => tool.name === 'session.history')).toBe(false);
  });

  it('refuses a history payload supplied as tool parameters and invalid page sizes', () => {
    const harness = makeHarness();
    const turn = { turnId: 'role.turn-2', sessionHistory: [] };
    for (const params of [{ sessionHistory: [{ turnId: 'foreign', intent: 'Injected.' }] }, { limit: 0 }, { limit: 51 }, { limit: 1.5 }]) {
      const result = harness.call({ name: 'session.history', callId: 'invalid', params }, turn);
      expect(result.ok).toBe(false);
    }
  });
});
