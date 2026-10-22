import { describe, expect, it } from 'vitest';

import type { PendingCard, PlanCardView, TurnReport } from '@caotang/harness';

import { allowsAutoWrites, askBackFor, decisionFor, withAskBack, withoutAutoWrites } from '../src/approval.js';

const card = (over: Partial<PlanCardView> = {}): PendingCard => ({
  kind: 'confirm',
  turnId: 'turn-1',
  card: {
    id: 'c1',
    turnId: 'turn-1',
    kind: 'confirm',
    revision: 0,
    previewRevision: 0,
    from: 0,
    steps: [{ index: 0, origin: 0, tool: 'scene.draft', expect: 'a draft', risk: 'write-confirm', params: {}, status: 'ready', badges: [], stale: false, cut: false }],
    approvable: true,
    canAcceptCut: false,
    cut: false,
    ...over,
  },
});

describe('the built-in policies', () => {
  it('read-only and auto cancel every card', () => {
    expect(decisionFor('read-only', card())).toEqual({ action: 'cancel' });
    expect(decisionFor('auto', card())).toEqual({ action: 'cancel' });
  });

  it('approve-all approves a card that can be approved as shown', () => {
    expect(decisionFor('approve-all', card())).toEqual({ action: 'approve' });
  });

  it('approve-all never keeps a cut draft: it cancels, and does not send acceptTruncated', () => {
    const cut = card({ approvable: false, canAcceptCut: true, cut: true });
    const decision = decisionFor('approve-all', cut);
    expect(decision).toEqual({ action: 'cancel' });
    expect(decision).not.toHaveProperty('acceptTruncated');
  });

  it('approve-all cancels a card the preflight refused rather than being asked the same question again', () => {
    expect(decisionFor('approve-all', card({ approvable: false }))).toEqual({ action: 'cancel' });
  });

  it('only read-only refuses a write-auto call', () => {
    expect(allowsAutoWrites('read-only')).toBe(false);
    expect(allowsAutoWrites('auto')).toBe(true);
    expect(allowsAutoWrites('approve-all')).toBe(true);
    expect(allowsAutoWrites(() => ({ action: 'cancel' }))).toBe(true);
  });
});

describe('what a cancelled card reports', () => {
  it('names the step and the policy, as input the turn needs', () => {
    const askBack = askBackFor('read-only', [card()]);
    expect(askBack.code).toBe('needs_input');
    expect(askBack.reason).toContain('scene.draft');
    expect(askBack.reason).toContain('"read-only"');
    expect(askBack.options.length).toBeGreaterThan(0);
  });

  it('says a draft was cut when that is why', () => {
    const askBack = askBackFor('approve-all', [card({ approvable: false, canAcceptCut: true, cut: true })]);
    expect(askBack.reason).toContain('cut off');
  });

  it('adds the ask-back to a report that has none and leaves one that has', () => {
    const report = { turnId: 't', status: 'cancelled' } as TurnReport;
    const askBack = askBackFor('auto', [card()]);
    expect(withAskBack(report, askBack)).toMatchObject({ askBack });
    const had = { turnId: 't', status: 'failed', askBack: { code: 'conflict', reason: 'r', options: [] } } as unknown as TurnReport;
    expect(withAskBack(had, askBack)).toBe(had);
  });
});

describe('a read-only harness', () => {
  const harness = {
    call: (call: { name: string }) => ({ ok: true, value: { data: call.name } }),
    state: 'the state',
    tools() {
      return this === harness ? 'bound' : 'unbound';
    },
  };
  const guarded = withoutAutoWrites(harness as never);
  const turn = { turnId: 't' };

  it('refuses a write-auto call, and passes a read and a write-confirm call through to the harness gate', () => {
    expect(guarded.call({ name: 'notes.append', callId: 'a', params: {} }, turn)).toMatchObject({ ok: false, error: { code: 'permission-denied', target: 'notes.append' } });
    expect(guarded.call({ name: 'project.overview', callId: 'b', params: {} }, turn)).toMatchObject({ ok: true });
    expect(guarded.call({ name: 'scene.draft', callId: 'c', params: {} }, turn)).toMatchObject({ ok: true });
  });

  it('is the harness otherwise: its members, with their own receiver', () => {
    expect((guarded as unknown as typeof harness).state).toBe('the state');
    expect((guarded as unknown as typeof harness).tools()).toBe('bound');
  });
});
